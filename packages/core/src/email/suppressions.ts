/**
 * Who not to email: the suppression list (by keyed hash, never the address) and unsubscribe links.
 *
 * An unsubscribe link carries a signed token naming the workspace, the recipient's hash and the
 * message: no address, nothing to guess, and it keeps working (RFC 8058 one-click included) for as
 * long as the workspace exists. Unsubscribing stops marketing email; bounces, complaints and manual
 * entries stop everything.
 */
import { createHmac } from "node:crypto";
import { systemDb } from "@app/db";
import { maskEmail, normalizeEmail, type SuppressionReason, type SuppressionScope } from "@app/shared/email";
import { safeEqual } from "@app/shared";
import { env } from "../env.js";
import { emailAudit, EmailError, isUniqueViolation, recipientHash } from "./common.js";

/** Whether an address is suppressed for this category of mail. */
export async function isSuppressed(workspaceId: string, hash: string, category: string): Promise<{ suppressed: boolean; reason?: string }> {
  const rows = await systemDb.emailSuppression.findMany({
    where: { workspaceId, emailHash: hash, scope: category === "marketing" ? { in: ["marketing", "all"] } : "all" },
    select: { reason: true },
    take: 1,
  });
  return rows[0] ? { suppressed: true, reason: rows[0].reason } : { suppressed: false };
}

export async function addSuppression(input: {
  workspaceId: string;
  email?: string;
  hash?: string;
  masked?: string;
  reason: SuppressionReason;
  scope: SuppressionScope;
  source: string;
  userId?: string | null;
  messageId?: string | null;
}): Promise<{ created: boolean }> {
  const email = input.email ? normalizeEmail(input.email) : null;
  if (input.email && !email) throw new EmailError("Enter a valid email address", 400, "invalid_email");
  const hash = email ? recipientHash(input.workspaceId, email) : input.hash;
  if (!hash) throw new Error("addSuppression needs an email or a hash");
  try {
    await systemDb.emailSuppression.create({
      data: {
        workspaceId: input.workspaceId,
        emailHash: hash,
        emailMasked: email ? maskEmail(email) : (input.masked ?? "***"),
        reason: input.reason,
        scope: input.scope,
        source: input.source,
        createdByUserId: input.userId ?? null,
        messageId: input.messageId ?? null,
      },
    });
  } catch (err) {
    if (isUniqueViolation(err)) return { created: false };
    throw err;
  }
  // Anything still waiting for this address in that category doesn't go out.
  await systemDb.emailMessage.updateMany({
    where: {
      workspaceId: input.workspaceId,
      recipientHash: hash,
      status: { in: ["queued", "deferred"] },
      ...(input.scope === "marketing" ? { category: "marketing" } : {}),
    },
    data: { status: "suppressed", lastErrorCode: "suppressed", cancelledAt: new Date() },
  });
  return { created: true };
}

const unsubscribeKey = () => createHmac("sha256", env().SESSION_SECRET).update("email-unsubscribe-v1").digest();

export interface UnsubscribeClaims {
  /** Workspace. */
  w: string;
  /** Recipient hash. */
  h: string;
  /** Masked address, for the confirmation page. */
  e: string;
  /** Message. */
  m: string;
}

export function unsubscribeToken(c: UnsubscribeClaims): string {
  const payload = Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
  const sig = createHmac("sha256", unsubscribeKey()).update(payload).digest("base64url").slice(0, 32);
  return `${payload}.${sig}`;
}

export function readUnsubscribeToken(token: string): UnsubscribeClaims | null {
  const [payload, sig] = token.split(".");
  if (!payload || !sig || payload.length > 1000) return null;
  const expected = createHmac("sha256", unsubscribeKey()).update(payload).digest("base64url").slice(0, 32);
  if (!safeEqual(sig, expected)) return null;
  try {
    const c = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as UnsubscribeClaims;
    return typeof c.w === "string" && typeof c.h === "string" && typeof c.m === "string" ? c : null;
  } catch {
    return null;
  }
}

/** The page a person lands on from the link in the footer. */
export const unsubscribePageUrl = (token: string) => `${env().APP_URL}/unsubscribe?t=${encodeURIComponent(token)}`;
/** The one-click endpoint mail providers POST to (List-Unsubscribe-Post). */
export const unsubscribeOneClickUrl = (token: string) => `${env().API_URL.replace(/\/$/, "")}/email/unsubscribe/${encodeURIComponent(token)}`;

/** Apply an unsubscribe link. Idempotent: the second click finds it already done. */
export async function applyUnsubscribe(token: string, source: "unsubscribe_link" | "one_click"): Promise<{ ok: true; already: boolean; email: string; business: string }> {
  const c = readUnsubscribeToken(token);
  if (!c) throw new EmailError("This unsubscribe link isn't valid.", 404, "invalid_link");
  const ws = await systemDb.workspace.findUnique({ where: { id: c.w }, select: { id: true, name: true } });
  if (!ws) throw new EmailError("This unsubscribe link isn't valid any more.", 404, "invalid_link");
  const settings = await systemDb.emailSettings.findUnique({ where: { workspaceId: ws.id }, select: { businessName: true } });
  const { created } = await addSuppression({ workspaceId: ws.id, hash: c.h, masked: c.e, reason: "unsubscribed", scope: "marketing", source, messageId: c.m });
  if (created) await emailAudit({ workspaceId: ws.id, action: "email.recipient.unsubscribed", targetType: "email_message", targetId: c.m, metadata: { source } });
  return { ok: true, already: !created, email: c.e, business: settings?.businessName || ws.name };
}

/** What the unsubscribe page shows before confirming. */
export async function describeUnsubscribe(token: string) {
  const c = readUnsubscribeToken(token);
  if (!c) throw new EmailError("This unsubscribe link isn't valid.", 404, "invalid_link");
  const ws = await systemDb.workspace.findUnique({ where: { id: c.w }, select: { id: true, name: true } });
  if (!ws) throw new EmailError("This unsubscribe link isn't valid any more.", 404, "invalid_link");
  const settings = await systemDb.emailSettings.findUnique({ where: { workspaceId: ws.id }, select: { businessName: true } });
  const done = await systemDb.emailSuppression.findFirst({ where: { workspaceId: ws.id, emailHash: c.h, scope: { in: ["marketing", "all"] } }, select: { id: true } });
  return { email: c.e, business: settings?.businessName || ws.name, unsubscribed: !!done };
}

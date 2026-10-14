/**
 * Workspace-level email settings (business details, daily limit, pause) and the keys for the event
 * API. An event key can only post events to its own workspace: it reads nothing.
 */
import { systemDb, withTenant } from "@app/db";
import { randomToken, sha256Hex } from "@app/shared";
import { env } from "../env.js";
import { emailAudit, EmailError, notFound, type EmailDeps } from "./common.js";
import { enqueueEmailSend } from "./delivery.js";

export async function getEmailSettings(workspaceId: string) {
  const s = await withTenant(workspaceId, (tx) => tx.emailSettings.findUnique({ where: { workspaceId } }));
  const e = env();
  return {
    businessName: s?.businessName ?? null,
    businessAddress: s?.businessAddress ?? null,
    dailyLimit: s?.dailyLimit ?? null,
    effectiveDailyLimit: Math.min(s?.dailyLimit ?? e.EMAIL_DEFAULT_DAILY_LIMIT, e.EMAIL_MAX_DAILY_LIMIT),
    maxDailyLimit: e.EMAIL_MAX_DAILY_LIMIT,
    perMinuteLimit: e.EMAIL_WORKSPACE_PER_MINUTE,
    sendingPaused: s?.sendingPaused ?? false,
    suspended: s?.suspendedAt ? { at: s.suspendedAt, reason: s.suspendedReason } : null,
  };
}

export async function updateEmailSettings(
  workspaceId: string,
  userId: string,
  patch: { businessName?: string | null; businessAddress?: string | null; dailyLimit?: number | null; sendingPaused?: boolean },
  deps: Pick<EmailDeps, "queues">,
) {
  if (patch.dailyLimit && patch.dailyLimit > env().EMAIL_MAX_DAILY_LIMIT) throw new EmailError(`The most a workspace can send is ${env().EMAIL_MAX_DAILY_LIMIT} a day.`, 400, "limit_too_high");
  const before = await systemDb.emailSettings.findUnique({ where: { workspaceId } });
  const data = {
    ...(patch.businessName !== undefined ? { businessName: patch.businessName || null } : {}),
    ...(patch.businessAddress !== undefined ? { businessAddress: patch.businessAddress || null } : {}),
    ...(patch.dailyLimit !== undefined ? { dailyLimit: patch.dailyLimit } : {}),
    ...(patch.sendingPaused !== undefined ? { sendingPaused: patch.sendingPaused } : {}),
    updatedByUserId: userId,
  };
  await systemDb.emailSettings.upsert({ where: { workspaceId }, create: { workspaceId, ...data }, update: data });
  if (before?.sendingPaused && patch.sendingPaused === false) await releaseHeld({ workspaceId }, ["workspace_paused"], deps);
  await emailAudit({
    workspaceId,
    actorUserId: userId,
    action: patch.sendingPaused === true ? "email.sending.paused" : patch.sendingPaused === false && before?.sendingPaused ? "email.sending.resumed" : "email.settings.updated",
    metadata: { fields: Object.keys(patch) },
  });
  return getEmailSettings(workspaceId);
}

/** Mail that was held for a reason that just went away goes out now instead of within the hour. */
export async function releaseHeld(where: { workspaceId: string; emailAccountId?: string }, codes: string[], deps: Pick<EmailDeps, "queues">): Promise<number> {
  const held = await systemDb.emailMessage.findMany({ where: { ...where, status: { in: ["queued", "deferred"] }, lastErrorCode: { in: codes } }, select: { id: true }, take: 500 });
  if (!held.length) return 0;
  const now = new Date();
  await systemDb.emailMessage.updateMany({ where: { id: { in: held.map((h) => h.id) } }, data: { scheduledAt: now, enqueuedAt: null } });
  for (const h of held) await enqueueEmailSend({ id: h.id, scheduledAt: now }, deps);
  return held.length;
}

// ---------------------------------------------------------------------------
// Event API keys
// ---------------------------------------------------------------------------

export const INGEST_KEY_PREFIX = "ek_live_";

export async function listIngestKeys(workspaceId: string) {
  const keys = await withTenant(workspaceId, (tx) => tx.emailIngestKey.findMany({ where: { workspaceId }, orderBy: { createdAt: "desc" } }));
  return keys.map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt, revokedAt: k.revokedAt }));
}

/** The secret is returned once; only its hash is stored. */
export async function createIngestKey(workspaceId: string, userId: string, name: string) {
  if ((await systemDb.emailIngestKey.count({ where: { workspaceId, revokedAt: null } })) >= 20) throw new EmailError("A workspace can have at most 20 event API keys.", 409, "too_many_keys");
  const secret = `${INGEST_KEY_PREFIX}${randomToken(30)}`;
  const key = await systemDb.emailIngestKey.create({ data: { workspaceId, name, prefix: secret.slice(0, 14), keyHash: sha256Hex(secret), createdByUserId: userId } });
  await emailAudit({ workspaceId, actorUserId: userId, action: "email.ingest_key.created", targetType: "email_ingest_key", targetId: key.id, metadata: { name } });
  return { key: { id: key.id, name: key.name, prefix: key.prefix, createdAt: key.createdAt }, secret };
}

export async function revokeIngestKey(workspaceId: string, id: string, userId: string) {
  const { count } = await systemDb.emailIngestKey.updateMany({ where: { id, workspaceId, revokedAt: null }, data: { revokedAt: new Date() } });
  if (!count) throw notFound();
  await emailAudit({ workspaceId, actorUserId: userId, action: "email.ingest_key.revoked", targetType: "email_ingest_key", targetId: id });
}

/** The workspace a bearer key posts events to, or null. Constant-time by hash lookup. */
export async function authenticateIngestKey(secret: string): Promise<{ workspaceId: string; keyId: string } | null> {
  if (!secret.startsWith(INGEST_KEY_PREFIX) || secret.length > 200) return null;
  const key = await systemDb.emailIngestKey.findUnique({ where: { keyHash: sha256Hex(secret) } });
  if (!key || key.revokedAt) return null;
  await systemDb.emailIngestKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
  return { workspaceId: key.workspaceId, keyId: key.id };
}

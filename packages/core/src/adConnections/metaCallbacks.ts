/**
 * Meta's server-to-server callbacks for bizinsights' ads app: someone removed bizinsights in their
 * Facebook settings (deauthorize), or asked Facebook for what bizinsights holds about them to be deleted
 * (data deletion). Both arrive as a `signed_request`: base64url(signature) "." base64url(JSON payload),
 * the signature being the HMAC-SHA256 of the still-encoded payload, keyed with the app secret
 * (https://developers.facebook.com/docs/development/create-an-app/app-dashboard/data-deletion-callback).
 *
 * The payload's user_id is the person's app-scoped id, which ad connections keep as externalUserId.
 * A connection that never learned who granted it can't be matched: its next sync finds the access gone.
 */
import { createHmac, randomBytes } from "node:crypto";
import { systemDb } from "@app/db";
import { safeEqual } from "@app/shared";
import { logger } from "../logger.js";
import { audit } from "../notify.js";
import { resolveAdAlerts } from "./alerts.js";

/** How old a signed request may be (its issued_at), and how far ahead of this server's clock. */
export const META_SIGNED_REQUEST_MAX_AGE_S = 24 * 3600;
const CLOCK_SKEW_S = 300;

const base64url = /^[A-Za-z0-9_-]+={0,2}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The person a signed request is about, or null when it isn't Meta's for this app: a signature that
 * doesn't match (compared in constant time), an algorithm other than HMAC-SHA256, an issued_at older
 * than META_SIGNED_REQUEST_MAX_AGE_S (or from the future), or no app-scoped user id.
 */
export function verifyMetaSignedRequest(signedRequest: unknown, appSecret: string, now = Date.now()): { userId: string; issuedAt: number } | null {
  if (typeof signedRequest !== "string" || !appSecret || signedRequest.length > 8192) return null;
  const dot = signedRequest.indexOf(".");
  if (dot <= 0) return null;
  const signature = signedRequest.slice(0, dot).replace(/=+$/, "");
  const payload = signedRequest.slice(dot + 1);
  if (!base64url.test(signature) || !base64url.test(payload)) return null;
  const expected = createHmac("sha256", appSecret).update(payload).digest("base64url");
  if (!safeEqual(expected, signature)) return null;
  let data: unknown;
  try {
    data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!isObj(data) || data.algorithm !== "HMAC-SHA256") return null;
  const issuedAt = Number(data.issued_at);
  const nowS = now / 1000;
  if (!Number.isFinite(issuedAt) || issuedAt < nowS - META_SIGNED_REQUEST_MAX_AGE_S || issuedAt > nowS + CLOCK_SKEW_S) return null;
  const userId = typeof data.user_id === "string" || typeof data.user_id === "number" ? String(data.user_id) : "";
  return /^\d{1,30}$/.test(userId) ? { userId, issuedAt } : null;
}

/** One audit entry per store whose accounts a callback changed. */
async function auditByStore(rows: Array<{ workspaceId: string; storeId: string; accountId: string }>, action: string, via: string) {
  const byStore = new Map<string, { workspaceId: string; accountIds: string[] }>();
  for (const r of rows) {
    const s = byStore.get(r.storeId) ?? { workspaceId: r.workspaceId, accountIds: [] };
    s.accountIds.push(r.accountId);
    byStore.set(r.storeId, s);
  }
  for (const [storeId, s] of byStore) {
    await audit({ workspaceId: s.workspaceId, actorUserId: null, action, targetType: "store", targetId: storeId, metadata: { provider: "meta", accountIds: s.accountIds.slice(0, 50), accounts: s.accountIds.length, via } });
  }
}

/**
 * The person removed bizinsights in their Facebook settings, so their Meta grant is gone. Every Meta ad
 * connection on it waits for a reconnect now (hidden ones too), not at its next sync, with its token
 * deleted, as a sync that met ended access leaves it (auth_expired); the days already stored stay. Its
 * alert comes from the next sweep, as a sync's does. Returns how many connections were marked.
 */
export async function metaDeauthorized(userId: string): Promise<number> {
  const rows = await systemDb.adConnection.findMany({ where: { provider: "meta", externalUserId: userId, accessTokenEnc: { not: "" } }, select: { id: true, workspaceId: true, storeId: true, accountId: true } });
  if (!rows.length) return 0;
  const { count } = await systemDb.adConnection.updateMany({
    where: { id: { in: rows.map((r) => r.id) } },
    // externalUserId stays: a data deletion request for the same person, which Meta may send next, finds the rows by it.
    data: { status: "reconnect", errorCode: "auth_expired", lastError: null, accessTokenEnc: "", refreshTokenEnc: null, accessTokenExpiresAt: null, syncRequestedAt: null },
  });
  await auditByStore(rows, "ads.access_removed", "meta_deauthorize");
  logger.info({ connections: count }, "meta: bizinsights removed on Facebook; its ad connections wait for a reconnect");
  return count;
}

/** The auth_events type a data deletion request is kept under (no person: only its code, when, and how much went). */
export const META_DELETION_EVENT = "meta_data_deletion";

/**
 * The person asked Facebook for what bizinsights holds about them to be deleted: their Meta ad
 * connections go, and with them every figure fetched for them (ad_campaign_daily goes with its
 * connection) and their alerts. The request is kept under a random confirmation code (alphanumeric, as
 * Meta asks) for its status page; the record holds the code, when, and how many connections went.
 */
export async function metaDataDeletion(userId: string): Promise<{ confirmationCode: string; deleted: number }> {
  const rows = await systemDb.adConnection.findMany({ where: { provider: "meta", externalUserId: userId } });
  const { count } = rows.length ? await systemDb.adConnection.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } }) : { count: 0 };
  for (const r of rows) await resolveAdAlerts(r).catch((err: unknown) => logger.warn({ err, connectionId: r.id }, "ad alerts not resolved"));
  await auditByStore(rows, "ads.disconnected", "meta_data_deletion");
  const confirmationCode = randomBytes(10).toString("hex");
  await systemDb.authEvent.create({ data: { type: META_DELETION_EVENT, userId: null, ip: null, metadata: { code: confirmationCode, deleted: count } } });
  logger.info({ connections: count }, "meta: data deletion request; the person's ad connections and figures deleted");
  return { confirmationCode, deleted: count };
}

/** Where a data deletion request stands, by its confirmation code: done (and when), or not one bizinsights knows. */
export async function metaDataDeletionStatus(code: string): Promise<{ status: "done"; at: string } | { status: "unknown" }> {
  if (!/^[a-f0-9]{20}$/.test(code)) return { status: "unknown" };
  const row = await systemDb.authEvent.findFirst({ where: { type: META_DELETION_EVENT, metadata: { path: ["code"], equals: code } }, select: { createdAt: true } });
  return row ? { status: "done", at: row.createdAt.toISOString() } : { status: "unknown" };
}

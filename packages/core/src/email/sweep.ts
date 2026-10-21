/**
 * The email sweep, on the worker's 15-minute tick. Each part has its own Coordinator lease or works
 * on rows it claims, so a tick that dies half way leaves nothing for the next to duplicate.
 *
 *  - messages cut off mid-send (processing too long) → unknown, never re-sent on our own
 *  - messages due soon that aren't on the queue (lost, or later than the queue can delay) → queued
 *  - events still "received" a while after arriving (their job was lost) → queued again
 *  - abandoned checkouts whose deadline passed → events
 *  - domains due a check → checked; challenges past their time → expired
 *  - OAuth accounts not refreshed for a week → refreshed (keeps Microsoft's 90-day sliding refresh
 *    tokens alive and finds revoked grants before a customer's email does)
 *  - retention
 */
import { systemDb } from "@app/db";
import { logger } from "../logger.js";
import type { EmailDeps } from "./common.js";
import { enqueueEmailSend } from "./delivery.js";
import { checkDomain } from "./domains.js";
import { enqueueEvent, promoteAbandonedCheckouts } from "./events.js";
import { refreshEmailAccessToken } from "./tokens.js";

const STUCK_PROCESSING_MS = 10 * 60_000;
const DOMAINS_PER_TICK = 20;
const REFRESH_EVERY_MS = 7 * 86_400_000;
const REFRESHES_PER_TICK = 20;
const RETENTION_LEASE_MS = 22 * 3600_000;

/** How long things are kept (docs/email.md, "Data and retention"). */
export const EMAIL_RETENTION = {
  /** An event's encrypted data (what a delayed send renders from); the longest delay is 30 days. */
  eventPayloadDays: 35,
  /** Event and execution rows. */
  eventDays: 90,
  /** Message history and its delivery events. */
  messageDays: 180,
};

export async function sweepEmail(deps: EmailDeps) {
  const out = { interrupted: 0, queued: 0, events: 0, checkouts: 0, domains: 0, expired: 0, refreshed: 0, purged: 0 };
  const now = new Date();

  // 1. Cut off mid-send: the provider may or may not have it. Unknown, not retried (no duplicates).
  const stuck = await systemDb.emailMessage.findMany({ where: { status: "processing", processingStartedAt: { lt: new Date(now.getTime() - STUCK_PROCESSING_MS) } }, select: { id: true, workspaceId: true }, take: 500 });
  for (const m of stuck) {
    const { count } = await systemDb.emailMessage.updateMany({ where: { id: m.id, status: "processing" }, data: { status: "unknown", lastErrorCode: "send_interrupted" } });
    if (count) {
      await systemDb.emailMessageEvent.create({ data: { workspaceId: m.workspaceId, messageId: m.id, eventType: "unknown", metadata: { code: "send_interrupted" } } });
      out.interrupted++;
    }
  }

  // 2. Due within the next tick and not on the queue (or queued long ago and still waiting).
  const due = await systemDb.emailMessage.findMany({
    where: {
      status: { in: ["queued", "deferred"] },
      scheduledAt: { lte: new Date(now.getTime() + 15 * 60_000) },
      OR: [{ enqueuedAt: null }, { enqueuedAt: { lt: new Date(now.getTime() - 20 * 60_000) } }],
    },
    select: { id: true, scheduledAt: true },
    orderBy: { scheduledAt: "asc" },
    take: 500,
  });
  for (const m of due) await enqueueEmailSend(m, deps);
  out.queued = due.length;

  // 3. Events whose job went missing.
  const stale = await systemDb.emailBusinessEvent.findMany({ where: { status: "received", updatedAt: { lt: new Date(now.getTime() - 5 * 60_000) } }, select: { id: true }, take: 200 });
  for (const e of stale) {
    await systemDb.emailBusinessEvent.updateMany({ where: { id: e.id, status: "received" }, data: { updatedAt: now } });
    await enqueueEvent(e.id, deps);
  }
  out.events = stale.length;

  out.checkouts = await promoteAbandonedCheckouts(deps, now);

  // 4. Domains.
  out.expired = (
    await systemDb.emailDomain.updateMany({ where: { verificationStatus: { in: ["unverified", "pending", "failed"] }, ownershipVerifiedAt: null, verificationExpiresAt: { lt: now } }, data: { verificationStatus: "expired", nextCheckAt: null } })
  ).count;
  const domains = await systemDb.emailDomain.findMany({
    where: { verificationStatus: { not: "expired" }, nextCheckAt: { lte: now } },
    orderBy: { nextCheckAt: "asc" },
    take: DOMAINS_PER_TICK,
  });
  for (const d of domains) {
    if (!(await deps.coord.acquire(`email-domain-check:${d.id}`, 10 * 60_000))) continue;
    try {
      await checkDomain(d, deps);
      out.domains++;
    } catch (err) {
      logger.warn({ err, domainId: d.id }, "email domain check failed; the next tick tries again");
    }
  }

  // 5. OAuth maintenance.
  const stalest = await systemDb.emailOAuthCredential.findMany({
    where: { OR: [{ lastRefreshedAt: null }, { lastRefreshedAt: { lt: new Date(now.getTime() - REFRESH_EVERY_MS) } }], account: { deletedAt: null, status: { in: ["connected", "degraded", "pending"] } } },
    include: { account: true },
    orderBy: { lastRefreshedAt: { sort: "asc", nulls: "first" } },
    take: REFRESHES_PER_TICK,
  });
  for (const c of stalest) {
    if (!(await deps.coord.acquire(`email-oauth-maintenance:${c.emailAccountId}`, 6 * 3600_000))) continue;
    try {
      await refreshEmailAccessToken(c.account, deps);
      out.refreshed++;
    } catch (err) {
      // A dead grant has already been marked for reconnecting; anything else waits for the next turn.
      logger.warn({ err, accountId: c.emailAccountId }, "email token maintenance refresh failed");
    }
  }

  // 6. Retention, once a day.
  if (await deps.coord.acquire("email-retention", RETENTION_LEASE_MS)) out.purged = await purgeEmailRetention(now);
  return out;
}

export async function purgeEmailRetention(now = new Date()): Promise<number> {
  const days = (n: number) => new Date(now.getTime() - n * 86_400_000);
  let n = 0;
  n += (
    await systemDb.emailBusinessEvent.updateMany({
      where: { payloadEnc: { not: null }, status: { not: "pending_detection" }, createdAt: { lt: days(EMAIL_RETENTION.eventPayloadDays) } },
      data: { payloadEnc: null },
    })
  ).count;
  // Messages first (executions and events cascade from events; message events from messages).
  for (;;) {
    const old = await systemDb.emailMessage.findMany({ where: { createdAt: { lt: days(EMAIL_RETENTION.messageDays) }, status: { notIn: ["queued", "deferred", "processing"] } }, select: { id: true }, take: 2000 });
    if (!old.length) break;
    n += (await systemDb.emailMessage.deleteMany({ where: { id: { in: old.map((m) => m.id) } } })).count;
  }
  for (;;) {
    const old = await systemDb.emailBusinessEvent.findMany({ where: { createdAt: { lt: days(EMAIL_RETENTION.eventDays) }, status: { not: "pending_detection" } }, select: { id: true }, take: 2000 });
    if (!old.length) break;
    // Not while a message it scheduled still waits to render from it.
    const waiting = await systemDb.emailMessage.findMany({ where: { eventId: { in: old.map((e) => e.id) }, status: { in: ["queued", "deferred", "processing"] } }, select: { eventId: true } });
    const keep = new Set(waiting.map((w) => w.eventId));
    const ids = old.map((e) => e.id).filter((id) => !keep.has(id));
    if (!ids.length) break;
    n += (await systemDb.emailBusinessEvent.deleteMany({ where: { id: { in: ids } } })).count;
    if (ids.length < old.length) break;
  }
  if (n) logger.info({ rows: n }, "email retention applied");
  return n;
}

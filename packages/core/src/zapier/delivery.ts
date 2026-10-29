/**
 * Delivering the outbox to Zapier (the worker's `kind: "zapier"` jobs on the sync queue, and the cron
 * sweep). One delivery is one event for one Zap's trigger:
 *
 * - At most ZAPIER_STORE_CONCURRENCY deliveries per store at a time (a busy store can't hold up the
 *   rest); a job that finds them all taken comes back a few seconds later, spending no attempt.
 * - Claimed with a conditional update (pending/retrying → delivering), so a message SQS delivers
 *   twice sends once; a delivered one is never sent again.
 * - The member behind the connection is checked again first: access lost since the event was written
 *   means it isn't sent (failed, "no longer has access").
 * - POSTed to the trigger's address, which must still be Zapier's own; redirects are not followed.
 * - 2xx: delivered. 410: Zapier says the Zap is gone, so the trigger is deleted (Zapier's REST hook
 *   convention). 408, 429, 5xx, a timeout or no answer: tried again with exponential backoff and
 *   jitter, up to ZAPIER_MAX_ATTEMPTS, then failed. Any other answer: failed at once (a retry would
 *   meet the same answer). Every outcome stays on the row, which Settings → Integrations shows.
 * - Failed for good: the store's owners and admins get the alert `zapier_delivery_failed` (once while
 *   it is open), resolved once none of the store's triggers has a failed delivery left (sent again
 *   with Retry, or its Zap gone).
 */
import { systemDb } from "@app/db";
import { isZapierHookUrl, ZAPIER_MAX_ATTEMPTS, ZAPIER_SCHEMA_VERSION, zapierBackoffSeconds, type ZapierDeliveryError, type ZapierEvent } from "@app/shared/zapier";
import type { Coord } from "../coord.js";
import { logger } from "../logger.js";
import { audit, raiseAlert, resolveAlerts, type Mailer } from "../notify.js";
import type { Queues } from "../queues.js";
import type { FetchLike } from "../shopify.js";
import { authorizerAccess, eventDataAllowed, redactFor } from "./access.js";
import { sweepAdsDailySummaries } from "./ads.js";
import { zapierQueue, type ZapierEnvelope, type ZapierJob } from "./common.js";

export interface ZapierDeliveryDeps {
  fetchImpl: FetchLike;
  coord: Coord;
  queues: Pick<Queues, "sync">;
  /** For the alert a delivery that failed for good raises. */
  mailer: Mailer;
}

/** The alert an event Zapier never took raises (describeAlert words it). */
export const ZAPIER_FAILED_ALERT = "zapier_delivery_failed";

/** Raise the store's "Some events didn't reach Zapier" alert. Never throws: the delivery's outcome is recorded already. */
async function alertFailed(d: { id: string; workspaceId: string; storeId: string }, errorCode: ZapierDeliveryError | null, deps: ZapierDeliveryDeps) {
  try {
    await raiseAlert({ workspaceId: d.workspaceId, storeId: d.storeId, severity: "warning", code: ZAPIER_FAILED_ALERT, message: `zapier delivery ${d.id} failed: ${errorCode ?? "unknown"}` }, deps.mailer, deps.fetchImpl, deps.queues);
  } catch (err) {
    logger.error({ err, deliveryId: d.id }, "zapier delivery failed; its alert could not be raised");
  }
}

/**
 * Resolve the store's "Some events didn't reach Zapier" once none of its triggers has a failed
 * delivery left: each was sent again, or its trigger is gone (the Zap turned off, Zapier
 * disconnected). Returns whether it was resolved.
 */
export async function settleZapierFailedAlert(storeId: string): Promise<boolean> {
  const left = await systemDb.zapierDelivery.count({ where: { storeId, status: "failed", hookId: { not: null } } });
  return left === 0 && (await resolveAlerts(storeId, [ZAPIER_FAILED_ALERT])) > 0;
}

/** Deliveries one store may have in flight at once. */
export const ZAPIER_STORE_CONCURRENCY = 3;
/** How long one attempt may take before it counts as no answer. */
export const ZAPIER_DELIVERY_TIMEOUT_MS = 10_000;
/** The longest delay a queue message can carry (SQS's): a later retry is sent by the sweep instead. */
const MAX_QUEUE_DELAY_S = 900;
/** An attempt still "delivering" after this was cut short (the function stopped): it is tried again. */
const STUCK_MS = 5 * 60_000;
/** A delivery queued this long ago and still due is queued again (a lost message). */
const REQUEUE_AFTER_MS = 10 * 60_000;
/** How long the outbox keeps events (and their deliveries' records). */
export const ZAPIER_EVENTS_KEPT_DAYS = 30;

export type DeliveryOutcome = "delivered" | "retrying" | "failed" | "cancelled" | "deferred" | "skipped";

async function takeSlot(coord: Coord, storeId: string): Promise<string | null> {
  for (let i = 0; i < ZAPIER_STORE_CONCURRENCY; i++) {
    const key = `zapier:slot:${storeId}:${i}`;
    if (await coord.acquire(key, ZAPIER_DELIVERY_TIMEOUT_MS * 3)) return key;
  }
  return null;
}

/** Send one delivery (a `kind: "zapier"` job). Never throws for Zapier's answer: the row records it. */
export async function deliverZapier(deliveryId: string, deps: ZapierDeliveryDeps, now = new Date()): Promise<DeliveryOutcome> {
  const d = await systemDb.zapierDelivery.findUnique({ where: { id: deliveryId }, select: { id: true, storeId: true, status: true, nextAttemptAt: true } });
  if (!d || !["pending", "retrying"].includes(d.status)) return "skipped";
  // Not due yet (a copy of the message, or the sweep's): the job that is due will come.
  if (d.nextAttemptAt.getTime() > now.getTime() + 5_000) return "skipped";
  const slot = await takeSlot(deps.coord, d.storeId);
  if (!slot) {
    await zapierQueue(deps.queues).send({ kind: "zapier", deliveryId }, { delaySeconds: 5 + Math.floor(Math.random() * 10) });
    return "deferred";
  }
  try {
    return await attempt(deliveryId, deps, now);
  } finally {
    await deps.coord.release(slot).catch(() => {});
  }
}

async function attempt(deliveryId: string, deps: ZapierDeliveryDeps, now: Date): Promise<DeliveryOutcome> {
  const claimed = await systemDb.zapierDelivery.updateMany({
    where: { id: deliveryId, status: { in: ["pending", "retrying"] } },
    data: { status: "delivering", attempts: { increment: 1 }, lastAttemptAt: now },
  });
  if (!claimed.count) return "skipped";
  const d = await systemDb.zapierDelivery.findUniqueOrThrow({ where: { id: deliveryId }, include: { zapierEvent: true, hook: { include: { grant: true } } } });
  const finish = async (status: "delivered" | "failed" | "cancelled", errorCode: ZapierDeliveryError | null, responseStatus: number | null = null) => {
    await systemDb.zapierDelivery.update({ where: { id: d.id }, data: { status, errorCode, responseStatus, ...(status === "delivered" ? { deliveredAt: now } : {}) } });
    if (status === "failed") await alertFailed(d, errorCode, deps);
    return status;
  };
  const hook = d.hook;
  if (!hook) return finish("cancelled", "hook_removed");
  if (hook.grant.revokedAt) return finish("cancelled", "grant_revoked");
  const event = d.event as ZapierEvent;
  const payload = d.zapierEvent.payload as unknown as ZapierEnvelope;
  const who = await authorizerAccess(hook.grant, now);
  if (!who || !eventDataAllowed(event, payload.data, who)) return finish("failed", "authorizer_no_access");
  if (!isZapierHookUrl(hook.targetUrl)) return finish("failed", "invalid_target");
  // Events written before the envelope had a version are version 1 too.
  const body: ZapierEnvelope = { ...payload, schema_version: payload.schema_version ?? ZAPIER_SCHEMA_VERSION, data: redactFor(event, payload.data, who) };

  let res: Response | null = null;
  let failure: ZapierDeliveryError | null = null;
  try {
    res = await deps.fetchImpl(hook.targetUrl, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json", "user-agent": "bizinsights-zapier/1", "x-bizinsights-event": event, "x-bizinsights-delivery": d.id },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ZAPIER_DELIVERY_TIMEOUT_MS),
    });
    // The body isn't needed; reading it frees the connection.
    await res.text().catch(() => "");
  } catch (err) {
    failure = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError") ? "timeout" : "network";
  }
  const status = res?.status ?? null;
  if (status !== null && status >= 200 && status < 300) {
    await systemDb.zapierHook.updateMany({ where: { id: hook.id }, data: { lastDeliveredAt: now } });
    const delivered = await finish("delivered", null, status);
    // A failed one sent again with Retry: the store's alert may have nothing left to say.
    await settleZapierFailedAlert(d.storeId).catch((err: unknown) => logger.warn({ err, storeId: d.storeId }, "zapier failed-delivery alert not settled"));
    return delivered;
  }
  if (status === 410) {
    // Zapier's word for "this Zap's trigger is gone": stop sending to it for good.
    await systemDb.zapierDelivery.updateMany({ where: { hookId: hook.id, status: { in: ["pending", "retrying"] } }, data: { status: "cancelled", errorCode: "hook_gone" } });
    await systemDb.zapierHook.deleteMany({ where: { id: hook.id } });
    logger.info({ hookId: hook.id, deliveryId: d.id }, "zapier answered 410: the trigger was deleted");
    await audit({
      workspaceId: hook.workspaceId,
      action: "zapier.trigger_unsubscribed",
      targetType: "zapier_hook",
      targetId: hook.id,
      metadata: { grantId: hook.grantId, storeId: hook.storeId, event: hook.event, zapId: hook.zapId, reason: "zapier_answered_410" },
    });
    return finish("cancelled", "hook_gone", 410);
  }
  if (status !== null && status >= 300 && status < 400) return finish("failed", "redirect_refused", status);
  const retryable = status === null || status === 408 || status === 429 || status >= 500;
  if (status !== null) failure = status === 429 ? "rate_limited" : status >= 500 || status === 408 ? "server_error" : "rejected";
  if (!retryable || d.attempts >= ZAPIER_MAX_ATTEMPTS) {
    if (retryable) logger.warn({ deliveryId: d.id, hookId: hook.id, attempts: d.attempts, status }, "zapier delivery gave up");
    return finish("failed", failure, status);
  }
  const retryAfter = status === 429 ? Number(res?.headers.get("retry-after")) : NaN;
  const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(3600, Math.ceil(retryAfter)) : zapierBackoffSeconds(d.attempts);
  const queued = delay <= MAX_QUEUE_DELAY_S;
  await systemDb.zapierDelivery.update({
    where: { id: d.id },
    data: { status: "retrying", errorCode: failure, responseStatus: status, nextAttemptAt: new Date(now.getTime() + delay * 1000), enqueuedAt: queued ? now : null },
  });
  if (queued) {
    await zapierQueue(deps.queues)
      .send({ kind: "zapier", deliveryId: d.id } satisfies ZapierJob, { delaySeconds: delay })
      .catch((err: unknown) => logger.warn({ err, deliveryId: d.id }, "zapier retry not queued; the sweep will send it"));
  }
  return "retrying";
}

/**
 * The cron's part (every 15 minutes, last in the tick so alerts raised by the sweeps before it go out
 * at once): attempts cut short, deliveries due that no message carries (retries later than a queue
 * message can wait, events written without a queue at hand), yesterday's advertising summaries, and
 * once a day the outbox's retention.
 */
export async function sweepZapier(deps: ZapierDeliveryDeps, now = new Date()) {
  const cutShort = { status: "delivering", lastAttemptAt: { lt: new Date(now.getTime() - STUCK_MS) } };
  // One cut short on its last attempt has had them all.
  await systemDb.zapierDelivery.updateMany({ where: { ...cutShort, attempts: { gte: ZAPIER_MAX_ATTEMPTS } }, data: { status: "failed", errorCode: "timeout" } });
  const stuck = await systemDb.zapierDelivery.updateMany({ where: cutShort, data: { status: "retrying", errorCode: "timeout", nextAttemptAt: now, enqueuedAt: null } });
  const summaries = await sweepAdsDailySummaries(deps.queues, now).catch((err: unknown) => {
    logger.error({ err }, "zapier daily summaries failed; the next tick tries again");
    return 0;
  });
  // Alerts whose failed deliveries are all gone another way (a trigger removed, Zapier disconnected, the outbox's retention).
  const settled = await settleOpenFailedAlerts().catch((err: unknown) => {
    logger.error({ err }, "zapier failed-delivery alerts not settled; the next tick tries again");
    return 0;
  });
  const due = await systemDb.zapierDelivery.findMany({
    where: {
      status: { in: ["pending", "retrying"] },
      nextAttemptAt: { lte: now },
      OR: [{ enqueuedAt: null }, { enqueuedAt: { lt: new Date(now.getTime() - REQUEUE_AFTER_MS) } }],
    },
    orderBy: { nextAttemptAt: "asc" },
    take: 500,
    select: { id: true },
  });
  let queued = 0;
  for (const d of due) {
    try {
      await zapierQueue(deps.queues).send({ kind: "zapier", deliveryId: d.id }, { delaySeconds: Math.floor(Math.random() * 30) });
      await systemDb.zapierDelivery.update({ where: { id: d.id }, data: { enqueuedAt: now } });
      queued++;
    } catch (err) {
      logger.warn({ err, deliveryId: d.id }, "zapier delivery not queued; the next tick tries again");
    }
  }
  const pruned = await pruneZapierDaily(deps.coord, now).catch((err: unknown) => {
    logger.error({ err }, "zapier retention failed; the next tick tries again");
    return null;
  });
  return { unstuck: stuck.count, queued, summaries, settled, pruned };
}

async function settleOpenFailedAlerts(): Promise<number> {
  const open = await systemDb.alert.findMany({ where: { code: ZAPIER_FAILED_ALERT, resolvedAt: null, storeId: { not: null } }, select: { storeId: true }, distinct: ["storeId"] });
  let settled = 0;
  for (const a of open) if (await settleZapierFailedAlert(a.storeId!)) settled++;
  return settled;
}

/** Once a day: events past their keeping (their deliveries go with them), tokens past expiry, grants revoked 90 days ago. */
async function pruneZapierDaily(coord: Coord, now: Date) {
  if (!(await coord.acquire("sweep:zapier-retention", 23 * 3_600_000))) return null;
  try {
    const events = await systemDb.zapierEvent.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - ZAPIER_EVENTS_KEPT_DAYS * 86_400_000) } } });
    const tokens = await systemDb.zapierToken.deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - 86_400_000) } } });
    const grants = await systemDb.zapierGrant.deleteMany({ where: { revokedAt: { lt: new Date(now.getTime() - 90 * 86_400_000) } } });
    return { events: events.count, tokens: tokens.count, grants: grants.count };
  } catch (err) {
    await coord.release("sweep:zapier-retention").catch(() => {});
    throw err;
  }
}

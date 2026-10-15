/**
 * The WhatsApp sweeper, on the worker's 15-minute tick: starts and ends campaigns, hands every
 * store with due messages to the dispatcher (anything the queue lost or that was due later than
 * the queue can delay), asks Shopify where parcels are, and enforces retention. Each part has its
 * own lease in the Coordinator, so a tick that can't reach the database leaves nothing half done
 * for the next one to duplicate.
 */
import { systemDb } from "@app/db";
import { logger } from "../logger.js";
import { advanceCampaigns } from "./campaigns.js";
import { ensurePlatformWebhook } from "./connect.js";
import { refreshConnection } from "./store.js";
import { pollShipments } from "./events.js";
import { enqueueSend, waQueue, type WaDeps } from "./messages.js";

/** Messages stuck in "sending" this long were cut off mid-send (the Worker was killed). */
const STUCK_SENDING_MS = 10 * 60_000;
const DISPATCH_LEASE_MS = 10 * 60_000;
const SHIPMENT_POLL_LEASE_MS = 2 * 3600_000;
const RETENTION_LEASE_MS = 22 * 3600_000;
const PLATFORM_WEBHOOK_LEASE_MS = 6 * 3600_000;
/** How often each connected number is checked with Meta, and how many per tick (Meta's rate limits). */
const HEALTH_EVERY_MS = 6 * 3600_000;
const HEALTH_PER_TICK = 20;

/** How long things are kept (docs/whatsapp.md, "Data and retention"). */
export const RETENTION = {
  /** Message history (and its delivery events). */
  messagesDays: 180,
  /** A failed message's encrypted send details, kept so it can be retried by hand. */
  failedParamsDays: 7,
  /** Abandoned checkouts: the recovery link and name go first, the row later. */
  checkoutLinkDays: 30,
  checkoutRowDays: 90,
  /** Order timelines (tracking links stop working long before, see TRACKING_LINK_DAYS). */
  trackingDays: 365,
  /** Automation run log. */
  runsDays: 90,
};

export async function sweepWhatsapp(deps: WaDeps) {
  const out: {
    campaigns: { started: number; finished: number };
    dispatched: number;
    queued: number;
    interrupted: number;
    polled: number;
    purged: number;
    checked: number;
    platformWebhook?: string;
  } = {
    campaigns: { started: 0, finished: 0 },
    dispatched: 0,
    queued: 0,
    interrupted: 0,
    polled: 0,
    purged: 0,
    checked: 0,
  };
  out.campaigns = await advanceCampaigns(deps);

  // Cut off mid-send: Meta may or may not have it. Failing it (never re-sending on our own) avoids
  // a customer getting the same message twice; the merchant can retry it from the history.
  const stuck = await systemDb.whatsappMessage.updateMany({
    where: { status: "sending", updatedAt: { lt: new Date(Date.now() - STUCK_SENDING_MS) } },
    data: { status: "failed", failedAt: new Date(), reason: "send_interrupted", errorTitle: "Sending was interrupted; it may or may not have been delivered." },
  });
  out.interrupted = stuck.count;

  const now = new Date();
  const soon = new Date(now.getTime() + 15 * 60_000);
  // Due within the next tick and not on the queue: queue them with their delay.
  const upcoming = await systemDb.whatsappMessage.findMany({
    where: { status: "scheduled", scheduledFor: { gt: now, lte: soon }, OR: [{ enqueuedAt: null }, { enqueuedAt: { lt: new Date(now.getTime() - 20 * 60_000) } }] },
    select: { id: true, scheduledFor: true },
    take: 300,
  });
  for (const m of upcoming) await enqueueSend(m, deps);
  out.queued = upcoming.length;

  // Overdue: one dispatch chain per store.
  const stores = await systemDb.whatsappMessage.groupBy({ by: ["storeId"], where: { status: "scheduled", scheduledFor: { lte: now } } });
  for (const { storeId } of stores) {
    if (!(await deps.coord.acquire(`wa-dispatch:${storeId}`, DISPATCH_LEASE_MS))) continue;
    try {
      await waQueue(deps.queues).send({ kind: "whatsapp_dispatch", storeId });
      out.dispatched++;
    } catch (err) {
      await deps.coord.release(`wa-dispatch:${storeId}`).catch(() => {});
      throw err;
    }
  }

  // Parcels on their way, for stores with WhatsApp on.
  const withWhatsapp = await systemDb.whatsappSettings.findMany({ select: { storeId: true } });
  for (const { storeId } of withWhatsapp) {
    if (!(await deps.coord.acquire(`wa-shipments:${storeId}`, SHIPMENT_POLL_LEASE_MS))) continue;
    const store = await systemDb.store.findUnique({ where: { id: storeId } });
    if (!store || store.status === "uninstalled") continue;
    out.polled += await pollShipments(store, deps).catch((err: unknown) => {
      logger.warn({ err, storeId }, "shipment poll failed; the next one tries again");
      return 0;
    });
  }

  if (await deps.coord.acquire("wa-retention", RETENTION_LEASE_MS)) out.purged = await purgeWhatsappRetention();

  out.checked = await checkConnections(deps);

  // bizinsights' own Meta app: its webhook points here (checked a few times a day; a failure retries next tick).
  if (await deps.coord.acquire("wa-platform-webhook", PLATFORM_WEBHOOK_LEASE_MS)) {
    out.platformWebhook = await ensurePlatformWebhook(deps.fetchImpl).catch(async (err: unknown) => {
      logger.warn({ err }, "couldn't check bizinsights' WhatsApp webhook with Meta; the next tick tries again");
      await deps.coord.release("wa-platform-webhook").catch(() => {});
      return "failed" as const;
    });
  }
  return out;
}

/**
 * Health check: ask Meta about each connected number every few hours, so a token the business
 * revoked, a number Meta disabled or a quality drop shows on the dashboard even when nothing is
 * being sent. A few per tick, oldest first; a rejected token turns the connection "reconnect"
 * (refreshConnection), while a rate limit or outage just waits for the next turn.
 */
export async function checkConnections(deps: WaDeps, now = Date.now()): Promise<number> {
  const due = await systemDb.whatsappConnection.findMany({
    where: { status: { not: "reconnect" }, OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lt: new Date(now - HEALTH_EVERY_MS) } }] },
    orderBy: { lastSyncedAt: { sort: "asc", nulls: "first" } },
    take: HEALTH_PER_TICK,
  });
  let checked = 0;
  for (const conn of due) {
    if (!(await deps.coord.acquire(`wa-health:${conn.id}`, HEALTH_EVERY_MS))) continue;
    try {
      await refreshConnection(conn, deps.fetchImpl);
      checked++;
    } catch (err) {
      logger.warn({ err, connectionId: conn.id }, "whatsapp health check couldn't reach Meta; it tries again later");
    }
  }
  return checked;
}

/** Delete or blank what is past its retention. Returns rows touched. */
export async function purgeWhatsappRetention(now = Date.now()): Promise<number> {
  const days = (n: number) => new Date(now - n * 86_400_000);
  let n = 0;
  const oldMessages = await systemDb.whatsappMessage.findMany({ where: { createdAt: { lt: days(RETENTION.messagesDays) } }, select: { id: true }, take: 5000 });
  if (oldMessages.length) {
    const ids = oldMessages.map((m) => m.id);
    await systemDb.whatsappMessageEvent.deleteMany({ where: { messageId: { in: ids } } });
    n += (await systemDb.whatsappMessage.deleteMany({ where: { id: { in: ids } } })).count;
  }
  n += (
    await systemDb.whatsappMessage.updateMany({
      where: { paramsEnc: { not: null }, status: { in: ["failed", "skipped", "cancelled"] }, updatedAt: { lt: days(RETENTION.failedParamsDays) } },
      data: { paramsEnc: null },
    })
  ).count;
  n += (await systemDb.whatsappMessage.updateMany({ where: { clickUrlEnc: { not: null }, createdAt: { lt: days(RETENTION.checkoutLinkDays) } }, data: { clickUrlEnc: null } })).count;
  n += (
    await systemDb.abandonedCheckout.updateMany({
      where: { OR: [{ recoveryUrlEnc: { not: null } }, { customerNameEnc: { not: null } }], lastActivityAt: { lt: days(RETENTION.checkoutLinkDays) } },
      data: { recoveryUrlEnc: null, customerNameEnc: null },
    })
  ).count;
  // Never finished and never will be: Shopify's own recovery links expire too.
  n += (await systemDb.abandonedCheckout.updateMany({ where: { status: { in: ["open", "reminded", "ineligible"] }, lastActivityAt: { lt: days(RETENTION.checkoutLinkDays) } }, data: { status: "expired" } })).count;
  n += (await systemDb.abandonedCheckout.deleteMany({ where: { lastActivityAt: { lt: days(RETENTION.checkoutRowDays) } } })).count;
  const oldTrackings = await systemDb.orderTracking.findMany({ where: { orderCreatedAt: { lt: days(RETENTION.trackingDays) } }, select: { id: true }, take: 5000 });
  if (oldTrackings.length) {
    const ids = oldTrackings.map((t) => t.id);
    await systemDb.orderTrackingEvent.deleteMany({ where: { trackingId: { in: ids } } });
    n += (await systemDb.orderTracking.deleteMany({ where: { id: { in: ids } } })).count;
  }
  n += (await systemDb.whatsappAutomationRun.deleteMany({ where: { createdAt: { lt: days(RETENTION.runsDays) } } })).count;
  if (n) logger.info({ rows: n }, "whatsapp retention applied");
  return n;
}

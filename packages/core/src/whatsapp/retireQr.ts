/**
 * What is left of QR linking once Evolution API is gone (docs/whatsapp.md, "Removing Evolution",
 * release 2). Release 1's cleanup retired every QR-linked phone and deleted its instance; the
 * service, its database and its webhook are removed now. This keeps release 1's promise for any row
 * it didn't reach, without the service:
 *  - retireQrLinking (each cron tick, under its own lock, idempotent): a QR-linked connection still
 *    not disconnected is retired as release 1 did it (reason WA_QR_RETIRED, its queued messages
 *    cancelled with that reason, automations paused, campaigns cancelled, the alert, an audit row);
 *    the instance fields left on any row are forgotten (the instances went with the service).
 *  - Evolution's stored webhook events still pending can't be applied any more: they are set aside
 *    with that reason (processWebhookEvent, the queue's wapp_event job, the sweep).
 * Release 3 removes this module once the cron has nothing left to do here.
 */
import { systemDb, type WappConnection } from "@app/db";
import { WA_QR_RETIRED, WA_RETIRED_PROVIDER } from "@app/shared";
import { logger } from "../logger.js";
import { audit, raiseAlert, resolveAlerts } from "../notify.js";
import { WA_ALERTS, type WaDeps } from "./common.js";

const LOCK = "whatsapp:retire-qr";
const LOCK_MS = 14 * 60_000;
const EVENT_GONE = "Evolution API was removed: a QR-linked phone's events are no longer applied";

/** Forgets the Evolution instance a row still names (the instance went with the service); a Cloud API row keeps its token. */
async function forgetInstance(conn: Pick<WappConnection, "id" | "provider" | "instanceName">): Promise<boolean> {
  if (!conn.instanceName) return false;
  const n = await systemDb.wappConnection.updateMany({
    where: { id: conn.id, instanceName: conn.instanceName },
    data: { instanceName: null, instanceId: null, webhookKeyEnc: null, ...(conn.provider === WA_RETIRED_PROVIDER ? { instanceTokenEnc: null } : {}) },
  });
  return n.count > 0;
}

/**
 * Retires one QR-linked connection (above). The store's records change once, for whichever caller
 * gets there first (a concurrent tick, or the store connecting Meta meanwhile, finds it done).
 */
export async function retireQrConnection(deps: Pick<WaDeps, "fetchImpl" | "mailer">, conn: WappConnection): Promise<{ connection: WappConnection; retired: boolean; cancelled: number }> {
  if (conn.provider !== WA_RETIRED_PROVIDER) throw new Error("only a QR-linked connection is retired");
  const now = new Date();
  const changed = await systemDb.wappConnection.updateMany({
    where: { id: conn.id, provider: WA_RETIRED_PROVIDER, status: { not: "disconnected" } },
    data: { status: "disconnected", statusReason: WA_QR_RETIRED, disconnectedAt: now, downSince: null, phoneNumberId: null },
  });
  let cancelled = 0;
  if (changed.count) {
    cancelled = (await systemDb.wappMessage.updateMany({ where: { storeId: conn.storeId, direction: "out", status: "queued", provider: WA_RETIRED_PROVIDER }, data: { status: "cancelled", reason: WA_QR_RETIRED, finalAt: now, payloadEnc: null } })).count;
    const paused = (await systemDb.wappAutomation.updateMany({ where: { storeId: conn.storeId, status: "active" }, data: { status: "paused" } })).count;
    const campaigns = (await systemDb.wappCampaign.updateMany({ where: { storeId: conn.storeId, status: { in: ["scheduled", "sending"] } }, data: { status: "cancelled", cancelledAt: now, cancelReason: WA_QR_RETIRED } })).count;
    await resolveAlerts(conn.storeId, [WA_ALERTS.loggedOut, WA_ALERTS.down, WA_ALERTS.provider]);
    await raiseAlert(
      { workspaceId: conn.workspaceId, storeId: conn.storeId, severity: "warning", code: WA_ALERTS.qrRetired, message: `QR linking retired: the linked phone was disconnected; ${cancelled} waiting message(s) cancelled, ${paused} automation(s) paused, ${campaigns} campaign(s) cancelled.` },
      deps.mailer,
      deps.fetchImpl,
    );
    await audit({ workspaceId: conn.workspaceId, action: "whatsapp.qr_linking_retired", targetType: "store", targetId: conn.storeId, metadata: { cancelledMessages: cancelled, pausedAutomations: paused, cancelledCampaigns: campaigns } });
    logger.info({ connectionId: conn.id, storeId: conn.storeId, cancelled, paused, campaigns }, "whatsapp qr link retired");
  }
  await forgetInstance(conn);
  return { connection: await systemDb.wappConnection.findUniqueOrThrow({ where: { id: conn.id } }), retired: changed.count > 0, cancelled };
}

/** The cron's step (above). Null when another tick holds the lock. */
export async function retireQrLinking(deps: Pick<WaDeps, "fetchImpl" | "mailer" | "coord">): Promise<{ retired: number; forgotten: number; eventsSetAside: number } | null> {
  if (!(await deps.coord.acquire(LOCK, LOCK_MS))) return null;
  try {
    const out = { retired: 0, forgotten: 0, eventsSetAside: 0 };
    const rows = await systemDb.wappConnection.findMany({ where: { OR: [{ provider: WA_RETIRED_PROVIDER, status: { not: "disconnected" } }, { instanceName: { not: null } }] }, orderBy: { createdAt: "asc" }, take: 500 });
    for (const c of rows) {
      try {
        if (c.provider === WA_RETIRED_PROVIDER) {
          if ((await retireQrConnection(deps, c)).retired) out.retired++;
          if (c.instanceName) out.forgotten++;
        } else if (await forgetInstance(c)) out.forgotten++;
      } catch (err) {
        logger.error({ err, connectionId: c.id }, "whatsapp qr link not retired; the next tick tries again");
      }
    }
    out.eventsSetAside = (await systemDb.wappWebhookEvent.updateMany({ where: { status: "pending" }, data: { status: "ignored", bodyEnc: null, processedAt: new Date(), lastError: EVENT_GONE } })).count;
    if (out.retired || out.forgotten || out.eventsSetAside) logger.info(out, "whatsapp qr linking: what was left of it retired");
    return out;
  } finally {
    await deps.coord.release(LOCK);
  }
}

/** A stored Evolution webhook event (the queue's wapp_event job): set aside, it can't be applied any more. */
export async function processWebhookEvent(_deps: unknown, eventId: string): Promise<string> {
  const n = await systemDb.wappWebhookEvent.updateMany({ where: { id: eventId, status: "pending" }, data: { status: "ignored", bodyEnc: null, processedAt: new Date(), lastError: EVENT_GONE } });
  return n.count ? "set_aside" : "not_pending";
}

/** A stored event whose job kept failing: set aside (its body goes), so it stops costing tries. */
export async function setWebhookEventAside(eventId: string, error: string): Promise<void> {
  await systemDb.wappWebhookEvent.updateMany({ where: { id: eventId, status: "pending" }, data: { status: "dead", lastError: error.slice(0, 300), bodyEnc: null, processedAt: new Date() } });
}

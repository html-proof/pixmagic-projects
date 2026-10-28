/**
 * Retiring QR linking (docs/whatsapp.md, "Removing Evolution"), release 1 of 2. Since 2026-10-28 a
 * store connects WhatsApp through Meta's WhatsApp Business Platform only: nothing creates, pairs or
 * sends through bizinsights' Evolution API service any more, which still runs for this cleanup alone.
 *
 * retireQrLinking (every cron tick, under its own lock, until nothing is left) ends what is left of
 * it, each part once and nothing silently:
 *  - a phone linked with a QR code: its connection becomes disconnected with WA_QR_RETIRED as the
 *    reason; the messages waiting to go through it are cancelled with that reason (never sent), its
 *    automations paused and its campaigns cancelled; the store gets an alert that says to connect the
 *    WhatsApp Business Platform, and an audit row; then its Evolution instance is logged out (the
 *    phone loses the linked device) and deleted;
 *  - an instance that held a Cloud API number's token (connected before 2026-10-28): deleted. The
 *    number keeps working: bizinsights calls Meta itself now, with the same token, kept on the row;
 *  - an instance bizinsights made that no connection holds: deleted.
 * A step Evolution can't take (the service is down) is taken on a later tick; the connection is
 * retired in bizinsights at once all the same. A customer's reply to a retired phone (a STOP) that
 * reaches bizinsights before its instance is gone is still applied (webhook.ts).
 *
 * Release 2 removes the Evolution service itself, this module and the client (evolution.ts).
 */
import { systemDb, type WappConnection } from "@app/db";
import { WA_QR_RETIRED, WA_RETIRED_PROVIDER } from "@app/shared";
import { logger } from "../logger.js";
import { audit, raiseAlert, resolveAlerts } from "../notify.js";
import { WA_ALERTS, type WaDeps } from "./common.js";
import { defaultShard, evolutionClient, evolutionConfigured, evolutionServer } from "./evolution.js";

const LOCK = "whatsapp:retire-qr";
const LOCK_MS = 14 * 60_000;
/** Set once nothing of Evolution is left (no instance to delete), so ticks stop listing its instances for a week. */
const DONE = "whatsapp:retire-qr:done";

type InstanceRow = Pick<WappConnection, "id" | "storeId" | "provider" | "shard" | "instanceName">;

/**
 * Logs out (a QR-linked phone) and deletes a connection's Evolution instance, then forgets it on the
 * row; a Cloud API row keeps its token. True when no instance is left. Never throws.
 */
export async function dropEvolutionInstance(conn: InstanceRow, deps: Pick<WaDeps, "fetchImpl">): Promise<boolean> {
  if (!conn.instanceName) return true;
  if (!evolutionConfigured()) return false;
  try {
    const client = evolutionClient(conn.shard, deps.fetchImpl);
    // The global key opens every instance on its server.
    const key = evolutionServer(conn.shard).apiKey;
    if (conn.provider === WA_RETIRED_PROVIDER) await client.logout(conn.instanceName, key);
    await client.deleteInstance(conn.instanceName, key);
  } catch (err) {
    logger.warn({ err, connectionId: conn.id, storeId: conn.storeId }, "evolution instance not deleted; the next tick tries again");
    return false;
  }
  await systemDb.wappConnection.updateMany({
    where: { id: conn.id, instanceName: conn.instanceName },
    data: { instanceName: null, instanceId: null, webhookKeyEnc: null, ...(conn.provider === WA_RETIRED_PROVIDER ? { instanceTokenEnc: null } : {}) },
  });
  logger.info({ connectionId: conn.id, storeId: conn.storeId, provider: conn.provider }, "evolution instance deleted");
  return true;
}

/**
 * Retires one QR-linked connection (above). The store's records change once, for whichever caller
 * gets there first (a concurrent tick, or the store connecting Meta meanwhile, finds it done).
 */
export async function retireQrConnection(
  deps: Pick<WaDeps, "fetchImpl" | "mailer">,
  conn: WappConnection,
): Promise<{ connection: WappConnection; retired: boolean; cancelled: number; instanceDeleted: boolean }> {
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
  const instanceDeleted = await dropEvolutionInstance(conn, deps);
  return { connection: await systemDb.wappConnection.findUniqueOrThrow({ where: { id: conn.id } }), retired: changed.count > 0, cancelled, instanceDeleted };
}

/** The cron's step (above). Null when another tick holds the lock; `left`: what a later tick still has to do. */
export async function retireQrLinking(deps: Pick<WaDeps, "fetchImpl" | "mailer" | "coord">): Promise<{ retired: number; instancesDeleted: number; orphansDeleted: number; left: number } | null> {
  if (!(await deps.coord.acquire(LOCK, LOCK_MS))) return null;
  try {
    const out = { retired: 0, instancesDeleted: 0, orphansDeleted: 0, left: 0 };
    const rows = await systemDb.wappConnection.findMany({ where: { OR: [{ provider: WA_RETIRED_PROVIDER, status: { not: "disconnected" } }, { instanceName: { not: null } }] }, orderBy: { createdAt: "asc" }, take: 500 });
    for (const c of rows) {
      try {
        let deleted: boolean;
        if (c.provider === WA_RETIRED_PROVIDER) {
          const r = await retireQrConnection(deps, c);
          if (r.retired) out.retired++;
          deleted = r.instanceDeleted;
        } else {
          deleted = await dropEvolutionInstance(c, deps);
        }
        if (c.instanceName && deleted) out.instancesDeleted++;
        if (!deleted) out.left++;
      } catch (err) {
        logger.error({ err, connectionId: c.id }, "whatsapp qr link not retired; the next tick tries again");
        out.left++;
      }
    }
    // Nothing is sent from Evolution's service any more, so "it isn't answering" no longer means anything.
    const stale = await systemDb.alert.findMany({ where: { code: WA_ALERTS.provider, resolvedAt: null, storeId: { not: null } }, select: { storeId: true }, distinct: ["storeId"] });
    for (const a of stale) await resolveAlerts(a.storeId!, [WA_ALERTS.provider]);

    if (!out.left && evolutionConfigured() && !(await deps.coord.peek(DONE))) {
      // Instances bizinsights made (bi_ names) that no connection holds: a pairing that crashed before
      // its row was saved, or a store erased while the service was down.
      let orphansLeft = 0;
      try {
        const shard = defaultShard();
        const client = evolutionClient(shard, deps.fetchImpl);
        for (const i of await client.fetchInstances()) {
          if (!i.name.startsWith("bi_")) continue;
          if (await systemDb.wappConnection.findUnique({ where: { instanceName: i.name }, select: { id: true } })) {
            orphansLeft++;
            continue;
          }
          try {
            await client.deleteInstance(i.name, evolutionServer(shard).apiKey);
            out.orphansDeleted++;
          } catch (err) {
            logger.warn({ err, instance: i.name }, "orphaned evolution instance not deleted; the next tick tries again");
            orphansLeft++;
          }
        }
      } catch (err) {
        logger.warn({ err }, "evolution unreachable: its instances can't be listed; the next tick tries again");
        orphansLeft++;
      }
      if (!orphansLeft) await deps.coord.put(DONE, "1", 7 * 86_400);
      out.left += orphansLeft;
    }
    if (out.retired || out.instancesDeleted || out.orphansDeleted || out.left) logger.info(out, "whatsapp qr linking: what was left of it retired");
    return out;
  } finally {
    await deps.coord.release(LOCK);
  }
}

/**
 * The connection's access, and what happens when it ends: the token comes from Nango right before
 * each call; Meta refusing it (or Nango no longer holding it) puts the connection on "reconnect",
 * raises an alert for the store's owners, and holds every waiting message (cancelled 48 hours
 * later, by the sweep). A connection that works again clears both.
 */
import { systemDb, type WaConnection } from "@app/db";
import { logger } from "../logger.js";
import { raiseAlert, resolveAlerts } from "../notify.js";
import { WhatsappError, type WaDeps } from "./common.js";
import { forgetWaToken, NangoTokenGoneError, NangoUnavailableError, waTokenFor } from "./nango.js";

/** Alert codes (worded by describeAlert in @app/shared/alerts). */
export const WA_ALERT = { reconnect: "wa_reconnect", account: "wa_account", webhook: "wa_webhook_failed" } as const;

/** The connection's token. Throws WhatsappError for the merchant when it can't be had. */
export async function connectionToken(conn: Pick<WaConnection, "id" | "storeId" | "workspaceId" | "nangoConnectionId" | "status">, deps: Pick<WaDeps, "fetchImpl" | "mailer">): Promise<string> {
  if (!conn.nangoConnectionId || conn.status === "disconnected") throw new WhatsappError("Connect WhatsApp first.", 409, "not_connected");
  try {
    return await waTokenFor(conn.nangoConnectionId, deps.fetchImpl);
  } catch (err) {
    if (err instanceof NangoTokenGoneError) {
      await markReconnect(conn, "bizinsights' access to your WhatsApp was removed", deps);
      throw new WhatsappError("bizinsights' access to your WhatsApp has ended. Reconnect WhatsApp.", 409, "reconnect_needed");
    }
    if (err instanceof NangoUnavailableError) throw new WhatsappError("WhatsApp is busy just now. Try again in a minute.", 503, "unavailable");
    throw err;
  }
}

/** Meta or Nango no longer accept bizinsights' access: the merchant reconnects. Idempotent. */
export async function markReconnect(conn: Pick<WaConnection, "id" | "storeId" | "workspaceId" | "nangoConnectionId">, detail: string, deps: Pick<WaDeps, "fetchImpl" | "mailer">): Promise<void> {
  if (conn.nangoConnectionId) forgetWaToken(conn.nangoConnectionId);
  const r = await systemDb.waConnection.updateMany({
    where: { id: conn.id, status: { notIn: ["reconnect", "disconnected"] } },
    data: { status: "reconnect", statusDetail: detail.slice(0, 300), reconnectSince: new Date(), step: null },
  });
  if (!r.count) return;
  logger.warn({ storeId: conn.storeId, detail }, "whatsapp connection needs reconnecting");
  await raiseAlert({ workspaceId: conn.workspaceId, storeId: conn.storeId, severity: "warning", code: WA_ALERT.reconnect, message: `WhatsApp needs reconnecting: ${detail}` }, deps.mailer, deps.fetchImpl).catch((err: unknown) =>
    logger.error({ err, storeId: conn.storeId }, "whatsapp reconnect alert failed"),
  );
}

/** Meta restricted, disabled or banned the account, or it needs a payment method. */
export async function markAccountProblem(conn: Pick<WaConnection, "id" | "storeId" | "workspaceId">, detail: string, deps: Pick<WaDeps, "fetchImpl" | "mailer">, opts: { holdSending: boolean }): Promise<void> {
  if (opts.holdSending) {
    await systemDb.waConnection.updateMany({ where: { id: conn.id, status: { notIn: ["disconnected"] } }, data: { status: "error", statusDetail: detail.slice(0, 300), reconnectSince: new Date() } });
  } else {
    await systemDb.waConnection.updateMany({ where: { id: conn.id }, data: { statusDetail: detail.slice(0, 300) } });
  }
  await raiseAlert({ workspaceId: conn.workspaceId, storeId: conn.storeId, severity: "warning", code: WA_ALERT.account, message: `WhatsApp account problem: ${detail}` }, deps.mailer, deps.fetchImpl).catch((err: unknown) =>
    logger.error({ err, storeId: conn.storeId }, "whatsapp account alert failed"),
  );
}

/** The connection works again: back to active, its alerts closed. */
export async function markWorking(conn: Pick<WaConnection, "id" | "storeId" | "status">): Promise<void> {
  if (conn.status === "reconnect" || conn.status === "error") {
    await systemDb.waConnection.updateMany({ where: { id: conn.id, status: { in: ["reconnect", "error"] } }, data: { status: "active", statusDetail: null, reconnectSince: null } });
  }
  await resolveAlerts(conn.storeId, [WA_ALERT.reconnect, WA_ALERT.account]).catch(() => 0);
}

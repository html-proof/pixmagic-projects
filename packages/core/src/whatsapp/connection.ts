/**
 * A store's WhatsApp connection: one number on Meta's WhatsApp Business Platform (docs/whatsapp.md,
 * "Connecting"). Connecting is Meta's Embedded Signup (cloud.ts); this keeps the connection true to
 * Meta's word afterwards:
 *  - checkConnection: asks Meta for the number with the business's token ("Check again", the
 *    sweep). Meta answering means connected; Meta refusing the token means it must be connected again.
 *  - markReconnect: Meta's access for bizinsights ended (it expired, or was removed in Meta's business
 *    settings): the connection waits for the merchant, with an alert, and messages wait 48 hours.
 *  - disconnect: bizinsights forgets the token and lets the number go (and stops the account's
 *    webhooks when no other store on bizinsights uses that account); the history stays.
 * A phone linked with a QR code (until 2026-10-28) is only ever retired (retireQr.ts).
 */
import { crossTenant, systemDb, type WappConnection } from "@app/db";
import { maskPhone, normalizePhone, WA_QR_RETIRED, WA_RETIRED_PROVIDER } from "@app/shared";
import { logger } from "../logger.js";
import { audit, raiseAlert, resolveAlerts } from "../notify.js";
import { connectionOf, WA_ALERTS, waEncrypt, WhatsappError, type WaDeps } from "./common.js";
import { CloudApiError, cloudNumberInfo, unsubscribeCloudAccount } from "./cloudApi.js";
import { dropEvolutionInstance, retireQrConnection } from "./retireQr.js";

/** A failure talking to Meta, as the merchant reads it (CloudApiError's detail is already in their words). */
export function providerProblem(e: unknown): WhatsappError {
  if (e instanceof WhatsappError) return e;
  if (e instanceof CloudApiError) {
    if (e.kind === "not_configured") return new WhatsappError("Connecting WhatsApp isn't set up on bizinsights yet. Nothing was changed.", 503, "provider_not_configured");
    if (e.kind === "unreachable" || e.kind === "timeout" || e.kind === "server") return new WhatsappError("Meta's WhatsApp service didn't answer. Nothing was changed; try again in a minute.", 503, "provider_unavailable");
    if (e.kind === "rate_limited" || e.kind === "pair_rate_limited") return new WhatsappError("Meta asked bizinsights to slow down. Try again in a few minutes.", 429, "rate_limited");
    if (e.kind === "auth") return new WhatsappError(e.detail, 409, "reconnect_needed");
    return new WhatsappError(`Meta refused that: ${e.detail}`, 502, "provider_refused");
  }
  return new WhatsappError("Something went wrong talking to Meta's WhatsApp service. Nothing was changed.", 502, "provider_error");
}

/** Why Meta's access ended: its code 190 (the token expired or was invalidated), or a permission it took back. */
export type ReconnectReason = "token_expired" | "access_removed";
export const reconnectReasonOf = (e: CloudApiError): ReconnectReason => (e.metaCode === 190 || e.metaCode === null ? "token_expired" : "access_removed");

/**
 * Meta no longer accepts bizinsights' access for the number: nothing can send until the merchant
 * connects again. The alert goes once; messages wait (cancelled after DOWN_GRACE_MS).
 */
export async function markReconnect(deps: Pick<WaDeps, "mailer" | "fetchImpl">, conn: WappConnection, reason: ReconnectReason, metaCode: number | null = null): Promise<WappConnection> {
  const updated = await systemDb.wappConnection.update({ where: { id: conn.id }, data: { status: "logged_out", statusReason: reason, downSince: conn.downSince ?? new Date(), lastCheckedAt: new Date() } });
  if (conn.status !== "logged_out") {
    logger.warn({ connectionId: conn.id, storeId: conn.storeId, reason, metaCode }, "whatsapp needs reconnecting: Meta refused bizinsights' access");
    await raiseAlert(
      { workspaceId: conn.workspaceId, storeId: conn.storeId, severity: "warning", code: WA_ALERTS.reconnect, message: `Meta refused bizinsights' access for the number (${reason}${metaCode !== null ? `, Meta #${metaCode}` : ""}); messages wait until WhatsApp is connected again.` },
      deps.mailer,
      deps.fetchImpl,
    );
  }
  return updated;
}

/**
 * Asks Meta for the number now and records what it says ("Check again", the sweep). Returns the
 * connection as it stands afterwards. A retired QR link, or a connection without a token, is as it is.
 */
export async function checkConnection(deps: Pick<WaDeps, "fetchImpl" | "mailer">, conn: WappConnection): Promise<WappConnection> {
  if (conn.provider !== "cloud_api" || conn.status === "disconnected" || !conn.instanceTokenEnc || !conn.phoneNumberId) return conn;
  let info: Awaited<ReturnType<typeof cloudNumberInfo>>;
  try {
    info = await cloudNumberInfo(deps, conn);
  } catch (e) {
    if (e instanceof CloudApiError && e.kind === "auth") return markReconnect(deps, conn, reconnectReasonOf(e), e.metaCode);
    throw providerProblem(e);
  }
  const e164 = normalizePhone(info.display_phone_number ?? null, null)?.e164 ?? null;
  const updated = await systemDb.wappConnection.update({
    where: { id: conn.id },
    data: {
      status: "connected",
      statusReason: null,
      downSince: null,
      lastCheckedAt: new Date(),
      ...(info.verified_name ? { profileName: info.verified_name.slice(0, 100) } : {}),
      ...(e164 ? { phoneEnc: waEncrypt(conn.storeId, "linked_phone", e164), phoneMasked: maskPhone(e164) } : {}),
    },
  });
  if (conn.status !== "connected") {
    logger.info({ connectionId: conn.id, storeId: conn.storeId, from: conn.status }, "whatsapp connected again: Meta accepted bizinsights' access");
    await resolveAlerts(conn.storeId, [WA_ALERTS.reconnect, WA_ALERTS.down]);
  }
  return updated;
}

/**
 * "Disconnect": bizinsights forgets the business's token and lets the number go, messages still
 * waiting are cancelled, automations paused and campaigns stopped. The history stays; connecting
 * again starts afresh.
 */
export async function disconnectWhatsapp(deps: Pick<WaDeps, "fetchImpl" | "mailer">, conn: WappConnection, actor: { userId: string; ip?: string }): Promise<WappConnection> {
  const { updated, cancelled } = await endConnection(deps, conn, "merchant");
  await audit({ workspaceId: conn.workspaceId, actorUserId: actor.userId, action: "whatsapp.disconnected", targetType: "store", targetId: conn.storeId, metadata: { cancelledMessages: cancelled }, ip: actor.ip });
  return updated;
}

/** The store's app was uninstalled: its WhatsApp is disconnected with it. */
export async function disconnectStore(storeId: string, deps: Pick<WaDeps, "fetchImpl" | "mailer">, reason: "uninstalled"): Promise<void> {
  const conn = await connectionOf(storeId);
  if (!conn || conn.status === "disconnected") return;
  await endConnection(deps, conn, reason);
}

async function endConnection(deps: Pick<WaDeps, "fetchImpl" | "mailer">, conn: WappConnection, reason: string) {
  // A QR-linked phone left from before 2026-10-28 is retired, its waiting messages cancelled with that reason.
  if (conn.provider === WA_RETIRED_PROVIDER) {
    const r = await retireQrConnection(deps, conn);
    return { updated: r.connection, cancelled: r.cancelled };
  }
  await releaseNumber(deps, conn);
  const updated = await systemDb.wappConnection.update({
    where: { id: conn.id },
    // The number is let go: it may be connected again here or to another store.
    data: { status: "disconnected", statusReason: reason, instanceTokenEnc: null, tokenExpiresAt: null, phoneNumberId: null, disconnectedAt: new Date(), downSince: null },
  });
  const cancelled = await systemDb.wappMessage.updateMany({ where: { storeId: conn.storeId, direction: "out", status: { in: ["queued", "sending"] } }, data:{ status: "cancelled", reason: "not_connected", finalAt: new Date(), payloadEnc: null } });
  await systemDb.wappAutomation.updateMany({ where: { storeId: conn.storeId, status: "active" }, data: { status: "paused" } });
  await systemDb.wappCampaign.updateMany({ where: { storeId: conn.storeId, status: { in: ["scheduled", "sending"] } }, data: { status: "cancelled", cancelledAt: new Date(), cancelReason: "disconnected" } });
  await resolveAlerts(conn.storeId, [WA_ALERTS.reconnect, WA_ALERTS.down, WA_ALERTS.loggedOut]);
  logger.info({ connectionId: conn.id, storeId: conn.storeId, cancelled: cancelled.count, reason }, "whatsapp disconnected");
  return { updated, cancelled: cancelled.count };
}

/**
 * What bizinsights set up for the number, undone (best effort, never throws): Meta stops sending the
 * account's webhooks to bizinsights' app once no other store here uses that account, and an Evolution
 * API instance left from before 2026-10-28 is deleted.
 */
async function releaseNumber(deps: Pick<WaDeps, "fetchImpl">, conn: WappConnection) {
  if (conn.provider === "cloud_api" && conn.instanceTokenEnc && conn.wabaId) {
    // Stores of any workspace: Meta's subscription is the app's, not one store's.
    const others = await crossTenant("already_connected", () =>
      systemDb.wappConnection.count({ where: { wabaId: conn.wabaId, id: { not: conn.id }, provider: "cloud_api", status: { not: "disconnected" } } }),
    );
    if (!others && !(await unsubscribeCloudAccount(deps, conn))) logger.warn({ connectionId: conn.id, storeId: conn.storeId }, "whatsapp business account's webhooks not unsubscribed at Meta");
  }
  if (conn.instanceName) await dropEvolutionInstance(conn, deps);
}

/** A store's data being erased: what bizinsights set up at Meta (or Evolution) for its number goes first (best effort). */
export async function dropStoreInstance(storeId: string, deps: Pick<WaDeps, "fetchImpl">): Promise<void> {
  const conn = await connectionOf(storeId);
  if (conn) await releaseNumber(deps, conn);
}

/** Why a connection is in its state, in words for the page. */
export function statusReasonLabel(reason: string | null | undefined): string | null {
  if (!reason) return null;
  switch (reason) {
    case WA_QR_RETIRED:
      return "bizinsights no longer links a WhatsApp phone with a QR code, so this link was disconnected and the messages waiting to go through it were cancelled (none was sent). Connect your number through Meta's WhatsApp Business Platform to send again.";
    case "token_expired":
      return "Meta's access for bizinsights expired. Connect WhatsApp again (the same account and number).";
    case "access_removed":
      return "Meta no longer lets bizinsights send for this number (its access was removed in Meta's business settings). Connect WhatsApp again.";
    case "create_failed":
      return "Setting the number up with Meta didn't finish. Connect again.";
    case "merchant":
      return "Disconnected by your team.";
    case "uninstalled":
      return "Disconnected when the bizinsights app was uninstalled from Shopify.";
    default:
      // A QR-linked phone's own reasons (close_401, qr_limit, pairing_timeout, logout...) on old rows.
      return /^close_\d+$|^qr_limit$|^pairing_|^instance_removed$|^logout$/.test(reason) ? "The phone that was linked with a QR code was disconnected." : null;
  }
}

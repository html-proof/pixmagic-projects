/**
 * A store's WhatsApp connection: one Evolution API instance (docs/whatsapp.md, "Connecting").
 *
 *  - startPairing: a new instance with a random name and keys of its own, its webhook pointed at
 *    bizinsights (each event signed with a JWT from a key only this connection knows), then
 *    Evolution's connect, which asks WhatsApp for a QR code (or a pairing code for a number).
 *  - pairingState: what the page polls while the merchant scans. Read from Evolution each time:
 *    the QR code shown is the one WhatsApp issued, never one bizinsights made.
 *  - applyConnectionEvent: CONNECTION_UPDATE, QRCODE_UPDATED, LOGOUT_INSTANCE, REMOVE_INSTANCE from
 *    the webhook. "Connected" is set only when the provider says the connection is open.
 *  - checkConnection / reconcileConnections: ask Evolution for the state (the page's "Check again",
 *    the sweep), for when a webhook was missed.
 *  - disconnect: logs the phone out and deletes the instance; the history stays.
 */
import { randomBytes } from "node:crypto";
import { systemDb, type Store, type WappConnection } from "@app/db";
import {
  closeReasonLabel,
  connectionStatusFromProvider,
  isTerminalCloseReason,
  maskPhone,
  normalizePhone,
  type WaConnectionStatus,
} from "@app/shared";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { audit, raiseAlert, resolveAlerts } from "../notify.js";
import { connectionOf, DOWN_GRACE_MS, waDecrypt, waEncrypt, WhatsappError, type WaDeps } from "./common.js";
import { defaultShard, evolutionClient, EvolutionError, evolutionConfigured, evolutionServer, jidNumber, type EvolutionClient } from "./evolution.js";

/** Pairing gives up after this long without the phone (Evolution's own QR limit usually comes first). */
export const PAIRING_TIMEOUT_MS = 10 * 60_000;
/** How often the merchant may start pairing (per store and hour): each one makes an instance. */
const PAIRING_STARTS_PER_HOUR = 10;

/** Alerts this module raises and resolves (worded in @app/shared/alerts). */
/** qrRetired: raised once on 2026-10-28 while QR linking was switched off (release 128); only resolved now. */
export const WA_ALERTS = { loggedOut: "whatsapp_logged_out", down: "whatsapp_disconnected", provider: "whatsapp_provider_down", qrRetired: "whatsapp_qr_retired" } as const;

/** Where Evolution posts an instance's events. */
export function webhookUrlFor(instanceName: string): string {
  const base = (env().EVOLUTION_WEBHOOK_URL || env().API_URL).replace(/\/+$/, "");
  return `${base}/webhooks/whatsapp/evolution/${encodeURIComponent(instanceName)}`;
}

/** The connection's instance key, decrypted (server side only). */
export const instanceToken = (c: Pick<WappConnection, "storeId" | "instanceTokenEnc">): string => {
  if (!c.instanceTokenEnc) throw new WhatsappError("This WhatsApp connection has no instance any more. Connect again.", 409, "no_instance");
  return waDecrypt(c.storeId, "instance_token", c.instanceTokenEnc);
};

export const clientFor = (c: Pick<WappConnection, "shard">, deps: Pick<WaDeps, "fetchImpl">): EvolutionClient => evolutionClient(c.shard, deps.fetchImpl);

/** An Evolution failure as the merchant reads it. */
export function providerProblem(e: unknown): WhatsappError {
  if (e instanceof WhatsappError) return e;
  if (e instanceof EvolutionError) {
    if (e.kind === "not_configured") return new WhatsappError("WhatsApp connections aren't set up on bizinsights yet. Nothing was changed.", 503, "provider_not_configured");
    if (e.kind === "unreachable" || e.kind === "timeout" || e.kind === "server")
      return new WhatsappError("bizinsights' WhatsApp service didn't answer. Nothing was changed; try again in a minute.", 503, "provider_unavailable");
    if (e.kind === "not_found") return new WhatsappError("The WhatsApp service no longer has this connection. Connect again.", 409, "provider_instance_missing");
    if (e.kind === "unauthorized") return new WhatsappError("The WhatsApp service refused bizinsights' key for this connection. Connect again.", 409, "provider_refused");
    return new WhatsappError(`The WhatsApp service refused that: ${e.detail || "no reason given"}`, 502, "provider_refused");
  }
  return new WhatsappError("Something went wrong talking to bizinsights' WhatsApp service. Nothing was changed.", 502, "provider_error");
}

const newInstanceName = () => `bi_${randomBytes(12).toString("hex")}`;
const newKey = () => randomBytes(32).toString("base64url");

export interface PairingView {
  status: WaConnectionStatus;
  /** A PNG data URL of the QR code WhatsApp issued (only while pairing by QR). */
  qr: string | null;
  /** The 8-character code to type on the phone (only while pairing by code). */
  pairingCode: string | null;
  /** QR codes issued so far in this attempt. */
  qrCount: number;
  reason: string | null;
  phone: string | null;
  profileName: string | null;
}

const view = (c: WappConnection, qr: string | null = null, pairingCode: string | null = null): PairingView => ({
  status: c.status as WaConnectionStatus,
  qr,
  pairingCode,
  qrCount: c.qrCount,
  reason: c.statusReason,
  phone: c.phoneMasked,
  profileName: c.profileName,
});

/** Deletes an instance at the provider, best effort (it is logged when it can't). */
async function dropInstance(c: Pick<WappConnection, "id" | "storeId" | "shard" | "instanceName" | "instanceTokenEnc">, deps: Pick<WaDeps, "fetchImpl">) {
  if (!c.instanceName || !c.instanceTokenEnc) return;
  try {
    const client = clientFor(c, deps);
    const token = instanceToken(c);
    await client.logout(c.instanceName, token).catch(() => {});
    await client.deleteInstance(c.instanceName, token);
  } catch (err) {
    logger.warn({ err, connectionId: c.id, storeId: c.storeId }, "whatsapp instance not deleted at the provider (the sweep removes leftovers)");
  }
}

/**
 * Step 1 and 2 for a phone: a fresh instance and its first QR code (or, with `phone`, a pairing
 * code to type on that phone). A store already connected is refused; one still pairing gets its
 * current code. Anything left from an earlier attempt is deleted first.
 */
export async function startPairing(
  deps: Pick<WaDeps, "fetchImpl" | "coord">,
  input: { store: Pick<Store, "id" | "workspaceId">; userId: string; method: "qr" | "code"; phone?: string | null; country?: string | null; ip?: string },
): Promise<PairingView> {
  if (!evolutionConfigured()) throw providerProblem(new EvolutionError("not_configured", 0, ""));
  const number = input.method === "code" ? normalizePhone(input.phone ?? null, input.country ?? null) : null;
  if (input.method === "code" && !number) throw new WhatsappError("Enter the WhatsApp number on the phone, with its country code (for example +61 412 345 678).", 400, "invalid_phone");
  const existing = await connectionOf(input.store.id);
  if (existing && existing.provider === "qr" && existing.instanceName && (existing.status === "connected" || existing.status === "reconnecting")) {
    throw new WhatsappError("WhatsApp is already connected for this store. Disconnect it first to link another phone.", 409, "already_connected");
  }
  if (existing?.provider === "cloud_api" && existing.instanceName && existing.status !== "disconnected") {
    throw new WhatsappError("This store is connected through Meta's Cloud API. Disconnect it first to link a phone instead.", 409, "already_connected");
  }
  if (existing?.status === "pairing" && existing.instanceName && existing.pairingMethod === input.method && Date.now() - (existing.pairingStartedAt?.getTime() ?? 0) < PAIRING_TIMEOUT_MS) {
    return pairingState(deps, existing);
  }
  if ((await deps.coord.hit(`wapp:pair:${input.store.id}`, 3600)) > PAIRING_STARTS_PER_HOUR) {
    throw new WhatsappError("Too many connection attempts for this store in the last hour. Try again later.", 429, "rate_limited");
  }
  if (existing) await dropInstance(existing, deps);

  const shard = defaultShard();
  const instanceName = newInstanceName();
  const token = newKey();
  const webhookKey = newKey();
  const now = new Date();
  const fields = {
    provider: "qr",
    status: "pairing",
    statusReason: null,
    shard,
    instanceName,
    instanceId: null,
    instanceTokenEnc: waEncrypt(input.store.id, "instance_token", token),
    webhookKeyEnc: waEncrypt(input.store.id, "webhook_key", webhookKey),
    pairingMethod: input.method,
    phoneEnc: null,
    phoneMasked: null,
    profileName: null,
    wabaId: null,
    phoneNumberId: null,
    businessId: null,
    qrCount: 0,
    pairingStartedAt: now,
    connectedAt: null,
    disconnectedAt: null,
    lastEventAt: null,
    lastCheckedAt: now,
    downSince: null,
    createdByUserId: input.userId,
  };
  // The row first: the instance's first webhook can arrive before create answers.
  const conn = await systemDb.wappConnection.upsert({ where: { storeId: input.store.id }, create: { workspaceId: input.store.workspaceId, storeId: input.store.id, ...fields }, update: fields });
  const client = evolutionClient(shard, deps.fetchImpl);
  try {
    const created = await client.createInstance({ instanceName, token, integration: "WHATSAPP-BAILEYS" });
    await systemDb.wappConnection.update({ where: { id: conn.id }, data: { instanceId: created.instanceId } });
    await client.setWebhook(instanceName, token, { url: webhookUrlFor(instanceName), jwtKey: webhookKey });
    const r = await client.connect(instanceName, token, number?.waId ?? null);
    await audit({ workspaceId: input.store.workspaceId, actorUserId: input.userId, action: "whatsapp.pairing_started", targetType: "store", targetId: input.store.id, metadata: { method: input.method }, ip: input.ip });
    const fresh = await systemDb.wappConnection.findUniqueOrThrow({ where: { id: conn.id } });
    return view(fresh, r.qr?.base64 ?? null, r.qr?.pairingCode ?? null);
  } catch (e) {
    logger.warn({ err: e, storeId: input.store.id, connectionId: conn.id }, "whatsapp pairing could not start");
    await systemDb.wappConnection.update({ where: { id: conn.id }, data: { status: "failed", statusReason: "create_failed" } });
    await dropInstance({ ...conn, instanceName, instanceTokenEnc: fields.instanceTokenEnc }, deps);
    await systemDb.wappConnection.update({ where: { id: conn.id }, data: { instanceName: null, instanceTokenEnc: null, webhookKeyEnc: null } });
    throw providerProblem(e);
  }
}

/**
 * What the page shows while the merchant pairs: the provider's current QR code (or pairing code),
 * or the state it reached. Asks Evolution each time; changes the row only on what Evolution says.
 */
export async function pairingState(deps: Pick<WaDeps, "fetchImpl">, conn: WappConnection): Promise<PairingView> {
  if (conn.status !== "pairing" || !conn.instanceName) return view(conn);
  if (Date.now() - (conn.pairingStartedAt?.getTime() ?? 0) > PAIRING_TIMEOUT_MS) {
    const failed = await systemDb.wappConnection.update({ where: { id: conn.id }, data: { status: "failed", statusReason: "pairing_timeout" } });
    return view(failed);
  }
  const client = clientFor(conn, deps);
  const token = instanceToken(conn);
  let state: string | null;
  try {
    state = await client.connectionState(conn.instanceName, token);
  } catch (e) {
    throw providerProblem(e);
  }
  if (state === "open") {
    const updated = await markConnected(deps, conn, null);
    return view(updated);
  }
  if (state === "connecting") {
    try {
      const r = await client.connect(conn.instanceName, token, null);
      if (r.state === "open") return view(await markConnected(deps, conn, null));
      return view(conn, r.qr?.base64 ?? null, r.qr?.pairingCode ?? null);
    } catch (e) {
      throw providerProblem(e);
    }
  }
  // Closed while pairing: Evolution ran out of QR codes (or WhatsApp refused). The page offers a new code.
  const failed = await systemDb.wappConnection.update({ where: { id: conn.id }, data: { status: "failed", statusReason: conn.statusReason ?? "pairing_closed" } });
  return view(failed);
}

/** Asks Evolution for the instance's details (the linked number, the profile name) and records the connection as open. */
async function markConnected(deps: Pick<WaDeps, "fetchImpl">, conn: WappConnection, at: Date | null, known?: { ownerJid?: string | null; profileName?: string | null }) {
  let ownerJid = known?.ownerJid ?? null;
  let profileName = known?.profileName ?? null;
  if ((!ownerJid || !profileName) && conn.instanceName) {
    try {
      const [info] = await clientFor(conn, deps).fetchInstances(conn.instanceName);
      ownerJid ??= info?.ownerJid ?? null;
      profileName ??= info?.profileName ?? null;
    } catch (err) {
      logger.warn({ err, connectionId: conn.id }, "whatsapp instance details not read; the next event or check fills them");
    }
  }
  const digits = jidNumber(ownerJid);
  const now = new Date();
  const updated = await systemDb.wappConnection.update({
    where: { id: conn.id },
    data: {
      status: "connected",
      statusReason: null,
      downSince: null,
      connectedAt: conn.status === "connected" ? conn.connectedAt : now,
      lastCheckedAt: now,
      ...(at ? { lastEventAt: at } : {}),
      ...(digits ? { phoneEnc: waEncrypt(conn.storeId, "linked_phone", `+${digits}`), phoneMasked: maskPhone(`+${digits}`) } : {}),
      ...(profileName ? { profileName: profileName.slice(0, 100) } : {}),
    },
  });
  if (conn.status !== "connected") {
    logger.info({ connectionId: conn.id, storeId: conn.storeId, provider: conn.provider }, "whatsapp connected");
    await audit({ workspaceId: conn.workspaceId, action: "whatsapp.connected", targetType: "store", targetId: conn.storeId, metadata: { provider: conn.provider } });
    await resolveAlerts(conn.storeId, [WA_ALERTS.loggedOut, WA_ALERTS.down, WA_ALERTS.qrRetired]);
  }
  return updated;
}

/** A connection that can't send any more: the time it went down is kept (waiting messages are cancelled after DOWN_GRACE_MS). */
async function markDown(conn: WappConnection, status: WaConnectionStatus, reason: string | null, at: Date | null, deps: Pick<WaDeps, "mailer" | "fetchImpl">) {
  const updated = await systemDb.wappConnection.update({
    where: { id: conn.id },
    data: { status, statusReason: reason, downSince: conn.downSince ?? new Date(), ...(at ? { lastEventAt: at } : {}), lastCheckedAt: new Date() },
  });
  if (conn.status !== status) logger.warn({ connectionId: conn.id, storeId: conn.storeId, from: conn.status, to: status, reason }, "whatsapp connection down");
  if (status === "logged_out" && conn.status === "connected") {
    await raiseAlert(
      { workspaceId: conn.workspaceId, storeId: conn.storeId, severity: "warning", code: WA_ALERTS.loggedOut, message: `WhatsApp logged out the linked phone (${reason ?? "no reason"}); messages wait until it is linked again.` },
      deps.mailer,
      deps.fetchImpl,
    );
  }
  return updated;
}

/** Evolution's connection events, as the webhook delivers them (already authenticated and parsed). */
export interface ConnectionEvent {
  event: "CONNECTION_UPDATE" | "QRCODE_UPDATED" | "LOGOUT_INSTANCE" | "REMOVE_INSTANCE";
  at: Date | null;
  state?: string | null;
  statusReason?: number | null;
  wuid?: string | null;
  profileName?: string | null;
  /** QRCODE_UPDATED: Evolution's "QR code limit reached" message (it then closes the connection). */
  qrLimit?: boolean;
}

/** Applies one connection event. An event older than the last applied one changes nothing. */
export async function applyConnectionEvent(deps: Pick<WaDeps, "fetchImpl" | "mailer">, conn: WappConnection, e: ConnectionEvent): Promise<WappConnection> {
  if (conn.status === "disconnected") return conn;
  if (e.at && conn.lastEventAt && e.at < conn.lastEventAt) return conn;
  const at = e.at ?? new Date();
  switch (e.event) {
    case "QRCODE_UPDATED":
      if (e.qrLimit) return systemDb.wappConnection.update({ where: { id: conn.id }, data: { status: "failed", statusReason: "qr_limit", lastEventAt: at } });
      if (conn.status !== "pairing") return conn;
      return systemDb.wappConnection.update({ where: { id: conn.id }, data: { qrCount: { increment: 1 }, lastEventAt: at } });
    case "LOGOUT_INSTANCE":
      return markDown(conn, "logged_out", "logout", at, deps);
    case "REMOVE_INSTANCE":
      return systemDb.wappConnection.update({ where: { id: conn.id }, data: { status: "failed", statusReason: "instance_removed", downSince: conn.downSince ?? new Date(), lastEventAt: at } });
    case "CONNECTION_UPDATE": {
      if (e.state === "open") return markConnected(deps, conn, at, { ownerJid: e.wuid, profileName: e.profileName });
      if (e.state === "close" && isTerminalCloseReason(e.statusReason)) return markDown(conn, "logged_out", `close_${e.statusReason}`, at, deps);
      const next = connectionStatusFromProvider(e.state, conn.status as WaConnectionStatus);
      if (!next || next === conn.status) return systemDb.wappConnection.update({ where: { id: conn.id }, data: { lastEventAt: at } });
      if (next === "reconnecting" || next === "failed") return markDown(conn, next, e.statusReason ? `close_${e.statusReason}` : null, at, deps);
      return systemDb.wappConnection.update({ where: { id: conn.id }, data: { status: next, lastEventAt: at } });
    }
  }
}

/**
 * Asks Evolution for the connection's state now and records it ("Check again", and after a
 * restart). Returns the connection as it stands afterwards.
 */
export async function checkConnection(deps: Pick<WaDeps, "fetchImpl" | "mailer">, conn: WappConnection): Promise<WappConnection> {
  if (!conn.instanceName || conn.status === "disconnected") return conn;
  let state: string | null;
  try {
    state = await clientFor(conn, deps).connectionState(conn.instanceName, instanceToken(conn));
  } catch (e) {
    if (e instanceof EvolutionError && e.kind === "not_found") {
      return systemDb.wappConnection.update({ where: { id: conn.id }, data: { status: "failed", statusReason: "instance_removed", downSince: conn.downSince ?? new Date(), lastCheckedAt: new Date() } });
    }
    throw providerProblem(e);
  }
  if (state === "open") return markConnected(deps, conn, null);
  if (conn.status === "pairing") return systemDb.wappConnection.update({ where: { id: conn.id }, data: { lastCheckedAt: new Date() } });
  const next = connectionStatusFromProvider(state, conn.status as WaConnectionStatus);
  if (next && next !== conn.status && next !== "connected") return markDown(conn, next, conn.statusReason, null, deps);
  return systemDb.wappConnection.update({ where: { id: conn.id }, data: { lastCheckedAt: new Date() } });
}

/** "Reconnect": Evolution closes the socket and reconnects with the saved session (no new QR code needed). */
export async function restartConnection(deps: Pick<WaDeps, "fetchImpl" | "mailer">, conn: WappConnection, actor: { userId: string; ip?: string }): Promise<WappConnection> {
  if (!conn.instanceName || conn.status === "disconnected" || conn.status === "pairing") throw new WhatsappError("There is no linked phone to reconnect. Connect WhatsApp first.", 409, "nothing_to_reconnect");
  if (conn.status === "logged_out") throw new WhatsappError("The phone logged this link out. Link it again with a new QR code.", 409, "needs_pairing");
  try {
    await clientFor(conn, deps).restart(conn.instanceName, instanceToken(conn));
  } catch (e) {
    throw providerProblem(e);
  }
  await audit({ workspaceId: conn.workspaceId, actorUserId: actor.userId, action: "whatsapp.reconnected", targetType: "store", targetId: conn.storeId, ip: actor.ip });
  return checkConnection(deps, conn);
}

/**
 * "Disconnect": the phone is logged out (WhatsApp removes the linked device), the instance and its
 * saved session are deleted at the provider, and messages still waiting are cancelled. The history
 * stays; connecting again starts a new instance.
 */
export async function disconnectWhatsapp(deps: Pick<WaDeps, "fetchImpl">, conn: WappConnection, actor: { userId: string; ip?: string }): Promise<WappConnection> {
  const { updated, cancelled } = await endConnection(deps, conn, "merchant");
  await audit({ workspaceId: conn.workspaceId, actorUserId: actor.userId, action: "whatsapp.disconnected", targetType: "store", targetId: conn.storeId, metadata: { cancelledMessages: cancelled }, ip: actor.ip });
  return updated;
}

/** The store's app was uninstalled: its WhatsApp is disconnected with it (the phone's linked device goes). */
export async function disconnectStore(storeId: string, deps: Pick<WaDeps, "fetchImpl">, reason: "uninstalled"): Promise<void> {
  const conn = await connectionOf(storeId);
  if (!conn || conn.status === "disconnected") return;
  await endConnection(deps, conn, reason);
}

async function endConnection(deps: Pick<WaDeps, "fetchImpl">, conn: WappConnection, reason: string) {
  await dropInstance(conn, deps);
  const updated = await systemDb.wappConnection.update({
    where: { id: conn.id },
    // A Cloud API number is let go too: it may be connected again here or to another store.
    data: { status: "disconnected", statusReason: reason, instanceName: null, instanceTokenEnc: null, webhookKeyEnc: null, phoneNumberId: null, disconnectedAt: new Date(), downSince: null },
  });
  const cancelled = await systemDb.wappMessage.updateMany({ where: { storeId: conn.storeId, direction: "out", status: { in: ["queued", "sending"] } }, data: { status: "cancelled", reason: "not_connected", finalAt: new Date(), payloadEnc: null } });
  await systemDb.wappAutomation.updateMany({ where: { storeId: conn.storeId, status: "active" }, data: { status: "paused" } });
  await systemDb.wappCampaign.updateMany({ where: { storeId: conn.storeId, status: { in: ["scheduled", "sending"] } }, data: { status: "cancelled", cancelledAt: new Date(), cancelReason: "disconnected" } });
  await resolveAlerts(conn.storeId, [WA_ALERTS.loggedOut, WA_ALERTS.down, WA_ALERTS.qrRetired]);
  logger.info({ connectionId: conn.id, storeId: conn.storeId, cancelled: cancelled.count, reason }, "whatsapp disconnected");
  return { updated, cancelled: cancelled.count };
}

/** A store's data being erased: its instance goes at the provider first (best effort). */
export async function dropStoreInstance(storeId: string, deps: Pick<WaDeps, "fetchImpl">): Promise<void> {
  const conn = await connectionOf(storeId);
  if (conn) await dropInstance(conn, deps);
}

/**
 * The sweep's check of every connection on a shard against Evolution's own list: states that
 * changed without a webhook reaching bizinsights, pairings left behind, instances nobody owns.
 */
export async function reconcileConnections(deps: Pick<WaDeps, "fetchImpl" | "mailer">, shard: string): Promise<{ checked: number; changed: number; removed: number; unreachable: boolean }> {
  const client = evolutionClient(shard, deps.fetchImpl);
  let instances;
  try {
    instances = await client.fetchInstances();
  } catch (err) {
    logger.error({ err, shard }, "evolution unreachable: whatsapp connections can't be checked");
    return { checked: 0, changed: 0, removed: 0, unreachable: true };
  }
  const byName = new Map(instances.map((i) => [i.name, i]));
  const conns = await systemDb.wappConnection.findMany({ where: { shard, instanceName: { not: null }, status: { not: "disconnected" } } });
  let changed = 0;
  for (const c of conns) {
    const info = byName.get(c.instanceName!);
    byName.delete(c.instanceName!);
    try {
      if (c.status === "pairing" && Date.now() - (c.pairingStartedAt?.getTime() ?? 0) > PAIRING_TIMEOUT_MS) {
        await dropInstance(c, deps);
        await systemDb.wappConnection.update({ where: { id: c.id }, data: { status: "failed", statusReason: "pairing_timeout", instanceName: null, instanceTokenEnc: null, webhookKeyEnc: null } });
        changed++;
        continue;
      }
      if (c.status === "failed" && c.statusReason !== "instance_removed" && Date.now() - (c.downSince?.getTime() ?? c.updatedAt.getTime()) > DOWN_GRACE_MS) {
        // A pairing that failed two days ago: its instance only takes room.
        await dropInstance(c, deps);
        await systemDb.wappConnection.update({ where: { id: c.id }, data: { instanceName: null, instanceTokenEnc: null, webhookKeyEnc: null } });
        changed++;
        continue;
      }
      if (!info) {
        if (c.status !== "failed") {
          await systemDb.wappConnection.update({ where: { id: c.id }, data: { status: "failed", statusReason: "instance_removed", downSince: c.downSince ?? new Date(), lastCheckedAt: new Date() } });
          changed++;
        }
        continue;
      }
      // Evolution's saved state can lag its live one: ask the instance itself when they disagree.
      const saved = info.connectionStatus ?? null;
      const expectOpen = c.status === "connected";
      if ((saved === "open") !== expectOpen || c.status === "reconnecting") {
        const after = await checkConnection(deps, c);
        if (after.status !== c.status) changed++;
      } else {
        await systemDb.wappConnection.update({ where: { id: c.id }, data: { lastCheckedAt: new Date() } });
      }
    } catch (err) {
      logger.warn({ err, connectionId: c.id }, "whatsapp connection check failed; the next sweep tries again");
    }
  }
  // Instances bizinsights made (bi_ names) that no connection holds: a pairing that crashed between
  // creating the instance and saving its name, or a store erased while the service was down.
  let removed = 0;
  for (const [name, info] of byName) {
    if (!name.startsWith("bi_")) continue;
    const owned = await systemDb.wappConnection.findUnique({ where: { instanceName: name }, select: { id: true } });
    if (owned) continue;
    try {
      // The global key may delete any instance (its own token is not needed for that).
      await client.deleteInstance(name, evolutionServer(shard).apiKey);
      removed++;
      logger.info({ shard, instance: name, state: info.connectionStatus }, "orphaned whatsapp instance deleted");
    } catch (err) {
      logger.warn({ err, shard, instance: name }, "orphaned whatsapp instance not deleted");
    }
  }
  return { checked: conns.length, changed, removed, unreachable: false };
}

/** A close reason for the page, in words. */
export function statusReasonLabel(reason: string | null | undefined): string | null {
  if (!reason) return null;
  const m = /^close_(\d+)$/.exec(reason);
  if (m) return closeReasonLabel(Number(m[1])) ?? `WhatsApp closed the connection (code ${m[1]}).`;
  switch (reason) {
    case "qr_limit":
      return "The QR codes ran out before the phone scanned one. Get a new code.";
    case "pairing_timeout":
      return "Nobody scanned the code in time. Get a new code.";
    case "pairing_closed":
      return "WhatsApp closed the pairing. Get a new code.";
    case "create_failed":
      return "bizinsights' WhatsApp service couldn't start the connection. Try again.";
    case "instance_removed":
      return "The WhatsApp service no longer has this connection. Connect again.";
    case "logout":
      return "The phone logged this link out (or removed it under Linked devices).";
    case "merchant":
      return "Disconnected by your team.";
    case "uninstalled":
      return "Disconnected when the bizinsights app was uninstalled from Shopify.";
    case "qr_linking_retired":
      return "Disconnected on 28 October, while QR-code linking was switched off. Link the phone again.";
    default:
      return null;
  }
}

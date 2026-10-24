/**
 * Connecting a store's WhatsApp Business number with Meta's Embedded Signup, keeping it healthy and
 * disconnecting it.
 *
 *  1. The page asks to start (`startSignup`): a single-use nonce bound to the person and store, and
 *     the public ids Meta's SDK needs.
 *  2. The merchant signs in to Meta, picks or creates their business, WhatsApp Business account and
 *     number in Meta's own window. The browser gets a 30-second code and (from Meta's window message)
 *     the account and number ids.
 *  3. `finishSignup` exchanges the code for the business's token, asks Meta's token inspector whose it
 *     is (bizinsights' app, both WhatsApp permissions, the account granted), checks the number belongs
 *     to that account and isn't another store's, hands the token to Nango, subscribes bizinsights to the
 *     account's webhooks, registers a new number with a PIN it keeps encrypted, reads the number and
 *     the templates, and saves the connection. Anything still to do is a `step` the page explains.
 *
 * One row per store, upserted: repeating a sign-up that failed part-way is always safe.
 */
import { randomInt, randomUUID } from "node:crypto";
import { Prisma, systemDb, type Store, type WaConnection } from "@app/db";
import { CONNECTION_STEPS, type ConnectionStep } from "@app/shared";
import { logger } from "../logger.js";
import { audit, resolveAlerts } from "../notify.js";
import { providerDetail } from "../errors.js";
import { waEncrypt, waDecrypt, waPlatform, WhatsappError, type WaDeps, type WaPlatform } from "./common.js";
import {
  appSubscribed,
  exchangeSignupCode,
  getPhone,
  getWaba,
  inspectToken,
  listPhones,
  PIN_MISMATCH_CODES,
  registerPhone,
  REQUIRED_SCOPES,
  subscribeApp,
  unsubscribeApp,
  WhatsappApiError,
  type PhoneInfo,
} from "./graph.js";
import { deleteNangoToken, forgetWaToken, NangoUnavailableError, storeTokenInNango } from "./nango.js";
import { syncTemplates } from "./templates.js";
import { connectionToken, markAccountProblem, markReconnect, markWorking, WA_ALERT } from "./tokens.js";

/** How long a started sign-up may take before its nonce is no good (Meta's window can take a while). */
export const SIGNUP_TTL_S = 20 * 60;
const signupKey = (nonce: string) => `wa:signup:${nonce}`;

export interface SignupStart {
  nonce: string;
  appId: string;
  configId: string;
  version: string;
}

/** Start a sign-up: the ids Meta's SDK needs, and a nonce the finish must bring back. */
export async function startSignup(deps: Pick<WaDeps, "coord">, input: { store: Store; userId: string }): Promise<SignupStart> {
  const p = waPlatform();
  if (!p) throw new WhatsappError("Connecting WhatsApp isn't switched on yet. bizinsights is finishing its setup with Meta; please check back soon.", 503, "not_configured");
  const nonce = randomUUID();
  await deps.coord.put(signupKey(nonce), JSON.stringify({ userId: input.userId, storeId: input.store.id }), SIGNUP_TTL_S);
  return { nonce, appId: p.appId, configId: p.configId, version: p.version };
}

/** What the browser heard from Meta's window when it finished. */
export interface SignupFinish {
  nonce: string;
  code: string;
  flow: "cloud_api" | "only_waba" | "business_app" | "other" | null;
  wabaId: string | null;
  phoneNumberId: string | null;
  businessId: string | null;
}

const refuse = (message: string, code: string, status: 400 | 409 | 502 | 503 = 400) => new WhatsappError(message, status, code);

/** A Meta failure during a connect step, in the merchant's words. */
function metaRefusal(err: unknown, what: string): never {
  if (err instanceof WhatsappApiError) {
    if (err.action === "network" || err.action === "retry") throw refuse(`WhatsApp didn't answer while ${what}. Press Connect WhatsApp again in a minute.`, "meta_unavailable", 503);
    if (err.action === "reconnect") throw refuse(`Meta didn't give bizinsights the access it needs while ${what}. Press Connect WhatsApp again and leave both WhatsApp permissions ticked.`, "permission_missing");
    throw refuse(`Meta refused while ${what}: ${providerDetail(err.details ?? err.title) || "no reason given"}.`, "meta_refused", 502);
  }
  throw err;
}

/** A 6-digit PIN for a number bizinsights registers (Meta refuses some weak ones, like 000000). */
const newPin = () => String(randomInt(100000, 1000000));

interface Registration {
  registered: boolean;
  step: ConnectionStep | null;
  pinEnc: string | null;
}

/**
 * Get the number onto the Cloud API. A number already there needs nothing. A WhatsApp Business app
 * number (coexistence) is never registered by bizinsights: registering would take it off the app;
 * Meta moves it on its own. A number with its own two-step PIN refuses ours: the merchant enters it.
 */
async function register(store: Pick<Store, "id">, phone: PhoneInfo, flow: string | null, token: string, deps: Pick<WaDeps, "fetchImpl">, pin?: string): Promise<Registration> {
  if (phone.platform_type === "CLOUD_API") return { registered: true, step: null, pinEnc: null };
  if (flow === "business_app") return { registered: false, step: "business_app_number", pinEnc: null };
  const usePin = pin ?? newPin();
  try {
    await registerPhone(phone.id, usePin, token, deps.fetchImpl);
    return { registered: true, step: null, pinEnc: pin ? null : waEncrypt(store.id, "pin", usePin) };
  } catch (err) {
    if (err instanceof WhatsappApiError && PIN_MISMATCH_CODES.includes(err.code ?? -1)) {
      if (pin) throw refuse("That PIN doesn't match your number's two-step verification PIN. Check it in WhatsApp Manager (Phone numbers → Two-step verification) and try again.", "pin_mismatch");
      return { registered: false, step: "pin_required", pinEnc: null };
    }
    if (err instanceof WhatsappApiError && (err.action === "retry" || err.action === "network")) return { registered: false, step: "register_failed", pinEnc: null };
    if (err instanceof WhatsappApiError) {
      logger.warn({ storeId: store.id, code: err.code, details: err.details }, "whatsapp number registration refused");
      return { registered: false, step: "register_failed", pinEnc: null };
    }
    throw err;
  }
}

/** The number's details as stored. */
const phoneFields = (p: PhoneInfo) => ({
  phoneNumberId: p.id,
  displayPhoneNumber: p.display_phone_number ?? null,
  verifiedName: p.verified_name ?? null,
  nameStatus: p.name_status ?? null,
  qualityRating: p.quality_rating ?? null,
  messagingLimitTier: p.messaging_limit_tier ?? null,
});

/** Another store's live connection already sends from this number. */
async function numberTaken(storeId: string, phoneNumberId: string): Promise<boolean> {
  const other = await systemDb.waConnection.findFirst({ where: { phoneNumberId, storeId: { not: storeId } }, select: { id: true } });
  return !!other;
}

const NUMBER_TAKEN = "This WhatsApp number is already connected to another store in bizinsights. Disconnect it there first, or choose another number.";

/** Finish a sign-up the browser brings back from Meta's window. */
export async function finishSignup(deps: WaDeps, input: SignupFinish & { store: Store; userId: string; ip?: string }): Promise<WaConnection> {
  const raw = await deps.coord.take(signupKey(input.nonce)).catch(() => null);
  const started = raw ? (JSON.parse(raw) as { userId: string; storeId: string }) : null;
  if (!started || started.userId !== input.userId || started.storeId !== input.store.id) {
    throw refuse("This WhatsApp sign-in wasn't started here, or it took too long. Press Connect WhatsApp again.", "state_mismatch");
  }
  const p = waPlatform();
  if (!p) throw refuse("Connecting WhatsApp isn't switched on yet.", "not_configured", 503);

  // 1. The code (30 seconds) for the business's token.
  let token: string;
  try {
    token = await exchangeSignupCode(p, input.code, deps.fetchImpl);
  } catch (err) {
    if (err instanceof WhatsappApiError && (err.action === "network" || err.action === "retry")) throw refuse("WhatsApp didn't answer. Press Connect WhatsApp again in a minute.", "meta_unavailable", 503);
    throw refuse("Meta's sign-in expired before bizinsights could finish it. Press Connect WhatsApp again and go straight through Meta's window.", "code_rejected");
  }

  // 2. Whose token it is, and what it may reach.
  const info = await inspectToken(p, token, deps.fetchImpl).catch((err: unknown) => metaRefusal(err, "checking the sign-in"));
  if (!info.valid || info.appId !== p.appId) throw refuse("Meta's sign-in wasn't for bizinsights. Press Connect WhatsApp again.", "wrong_app");
  const missing = REQUIRED_SCOPES.filter((s) => !info.scopes.includes(s));
  if (missing.length) throw refuse("bizinsights needs both WhatsApp permissions to send for you. Press Connect WhatsApp again and leave them ticked on Meta's screen.", "permission_missing", 400);
  let wabaId = input.wabaId;
  if (wabaId && info.wabaIds.length && !info.wabaIds.includes(wabaId)) throw refuse("You didn't give bizinsights access to that WhatsApp Business account. Press Connect WhatsApp again and choose it on Meta's screen.", "waba_not_granted");
  if (!wabaId) {
    if (info.wabaIds.length !== 1) throw refuse("Meta didn't say which WhatsApp Business account to use. Press Connect WhatsApp again and choose one account on Meta's screen.", "no_account");
    wabaId = info.wabaIds[0]!;
  }

  // 3. The account and its numbers.
  const [waba, phones] = await Promise.all([
    getWaba(wabaId, token, deps.fetchImpl).catch((err: unknown) => metaRefusal(err, "reading your WhatsApp Business account")),
    listPhones(wabaId, token, deps.fetchImpl).catch((err: unknown) => metaRefusal(err, "reading your phone numbers")),
  ]);
  let phone: PhoneInfo | null = null;
  let step: ConnectionStep | null = null;
  if (input.phoneNumberId) {
    phone = phones.find((x) => x.id === input.phoneNumberId) ?? null;
    if (!phone) throw refuse("That phone number isn't in the WhatsApp Business account you chose. Press Connect WhatsApp again.", "phone_not_in_account");
  } else if (phones.length === 1) {
    phone = phones[0]!;
  } else {
    step = phones.length ? "choose_number" : "no_number";
  }
  if (phone && (await numberTaken(input.store.id, phone.id))) throw refuse(NUMBER_TAKEN, "number_in_use", 409);

  // 4. The token to Nango; bizinsights' app to the account's webhooks.
  const nangoConnectionId = await storeTokenInNango(
    { storeId: input.store.id, token, tags: { end_user_id: input.userId, organization_id: input.store.workspaceId, bi_store: input.store.id, bi_provider: "whatsapp", bi_waba: wabaId } },
    deps,
  ).catch((err: unknown) => {
    if (err instanceof NangoUnavailableError) throw refuse("bizinsights couldn't save your WhatsApp connection just now. Press Connect WhatsApp again in a minute.", "save_failed", 503);
    throw err;
  });
  let subscribedAt: Date | null = null;
  try {
    await subscribeApp(wabaId, token, deps.fetchImpl);
    subscribedAt = new Date();
  } catch (err) {
    // Not fatal: the health check subscribes again. Until then replies and statuses don't arrive.
    logger.warn({ err, storeId: input.store.id }, "whatsapp: subscribing to the account's webhooks failed; the health check retries");
  }

  // 5. The number onto the Cloud API, and its details.
  let reg: Registration = { registered: false, step, pinEnc: null };
  if (phone) {
    const full = await getPhone(phone.id, token, deps.fetchImpl).catch(() => phone!);
    phone = { ...phone, ...full };
    reg = await register(input.store, phone, input.flow, token, deps);
  }

  const status = reg.registered && !reg.step ? "active" : "action_required";
  const data = {
    status,
    step: reg.step,
    statusDetail: reg.step ? CONNECTION_STEPS[reg.step] : null,
    nangoConnectionId,
    signupFlow: input.flow,
    businessId: input.businessId,
    wabaId,
    wabaName: waba.name ?? null,
    ...(phone ? phoneFields(phone) : { phoneNumberId: null, displayPhoneNumber: null, verifiedName: null, nameStatus: null, qualityRating: null, messagingLimitTier: null }),
    registered: reg.registered,
    ...(reg.pinEnc ? { pinEnc: reg.pinEnc } : {}),
    grantedScopes: info.scopes.filter((s) => s.startsWith("whatsapp_")),
    subscribedAt,
    lastCheckedAt: new Date(),
    reconnectSince: null,
    connectedByUserId: input.userId,
    connectedAt: new Date(),
    disconnectedAt: null,
  };
  let conn: WaConnection;
  try {
    conn = await systemDb.waConnection.upsert({ where: { storeId: input.store.id }, create: { workspaceId: input.store.workspaceId, storeId: input.store.id, ...data }, update: data });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw refuse(NUMBER_TAKEN, "number_in_use", 409);
    throw e;
  }
  await syncTemplates(conn, token, deps.fetchImpl).catch((err: unknown) => logger.warn({ err, storeId: conn.storeId }, "whatsapp templates not synced on connect; the health check retries"));
  await resolveAlerts(input.store.id, [WA_ALERT.reconnect, WA_ALERT.account]).catch(() => 0);
  await audit({
    workspaceId: input.store.workspaceId,
    actorUserId: input.userId,
    action: "whatsapp.connected",
    targetType: "store",
    targetId: input.store.id,
    metadata: { wabaId, phoneNumberId: conn.phoneNumberId, flow: input.flow, status, step: reg.step },
    ip: input.ip,
  });
  return conn;
}

/** The numbers in the connected account, for "choose a number". */
export async function accountNumbers(deps: WaDeps, store: Store): Promise<Array<{ id: string; displayPhoneNumber: string | null; verifiedName: string | null; registered: boolean; inUse: boolean }>> {
  const conn = await requireConn(store);
  const token = await connectionToken(conn, deps);
  const phones = await listPhones(conn.wabaId, token, deps.fetchImpl).catch((err: unknown) => metaRefusal(err, "reading your phone numbers"));
  const taken = new Set(
    (await systemDb.waConnection.findMany({ where: { phoneNumberId: { in: phones.map((x) => x.id) }, storeId: { not: store.id } }, select: { phoneNumberId: true } })).map((r) => r.phoneNumberId),
  );
  return phones.map((x) => ({ id: x.id, displayPhoneNumber: x.display_phone_number ?? null, verifiedName: x.verified_name ?? null, registered: x.platform_type === "CLOUD_API", inUse: taken.has(x.id) }));
}

async function requireConn(store: Pick<Store, "id">): Promise<WaConnection> {
  const conn = await systemDb.waConnection.findUnique({ where: { storeId: store.id } });
  if (!conn || conn.status === "disconnected" || !conn.nangoConnectionId) throw refuse("Connect WhatsApp first.", "not_connected", 409);
  return conn;
}

/** "Choose a number": the account has several, or the first one was replaced. */
export async function chooseNumber(deps: WaDeps, input: { store: Store; userId: string; phoneNumberId: string; ip?: string }): Promise<WaConnection> {
  const conn = await requireConn(input.store);
  const token = await connectionToken(conn, deps);
  const phones = await listPhones(conn.wabaId, token, deps.fetchImpl).catch((err: unknown) => metaRefusal(err, "reading your phone numbers"));
  let phone = phones.find((x) => x.id === input.phoneNumberId);
  if (!phone) throw refuse("That number isn't in your WhatsApp Business account.", "phone_not_in_account");
  if (await numberTaken(input.store.id, phone.id)) throw refuse(NUMBER_TAKEN, "number_in_use", 409);
  phone = { ...phone, ...(await getPhone(phone.id, token, deps.fetchImpl).catch(() => phone!)) };
  const reg = await register(input.store, phone, conn.signupFlow, token, deps);
  const updated = await systemDb.waConnection
    .update({
      where: { id: conn.id },
      data: { ...phoneFields(phone), registered: reg.registered, step: reg.step, statusDetail: reg.step ? CONNECTION_STEPS[reg.step] : null, status: reg.registered && !reg.step ? "active" : "action_required", ...(reg.pinEnc ? { pinEnc: reg.pinEnc } : {}) },
    })
    .catch((e: unknown) => {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw refuse(NUMBER_TAKEN, "number_in_use", 409);
      throw e;
    });
  await audit({ workspaceId: input.store.workspaceId, actorUserId: input.userId, action: "whatsapp.number_chosen", targetType: "store", targetId: input.store.id, metadata: { phoneNumberId: phone.id, registered: reg.registered }, ip: input.ip });
  return updated;
}

/** The merchant enters their number's existing two-step verification PIN, to finish registering it. */
export async function registerWithPin(deps: WaDeps, input: { store: Store; userId: string; pin: string; ip?: string }): Promise<WaConnection> {
  if (!/^\d{6}$/.test(input.pin)) throw refuse("The PIN is 6 digits.", "invalid_pin");
  const conn = await requireConn(input.store);
  if (!conn.phoneNumberId) throw refuse("Choose a number first.", "no_number", 409);
  const token = await connectionToken(conn, deps);
  const phone = await getPhone(conn.phoneNumberId, token, deps.fetchImpl).catch((err: unknown) => metaRefusal(err, "reading your number"));
  const reg = await register(input.store, phone, conn.signupFlow, token, deps, input.pin);
  const updated = await systemDb.waConnection.update({
    where: { id: conn.id },
    data: { registered: reg.registered, step: reg.step, statusDetail: reg.step ? CONNECTION_STEPS[reg.step] : null, status: reg.registered && !reg.step ? "active" : "action_required", ...phoneFields(phone) },
  });
  await audit({ workspaceId: input.store.workspaceId, actorUserId: input.userId, action: "whatsapp.number_registered", targetType: "store", targetId: input.store.id, metadata: { registered: reg.registered }, ip: input.ip });
  return updated;
}

export interface CheckResult {
  status: WaConnection["status"];
  templates: number | null;
}

/**
 * Ask Meta how the connection stands: the token still works, bizinsights is still subscribed to the
 * account, the number's quality, limit and registration, and the templates. Run by "Check again"
 * and every few hours by the sweep. A rate limit or an outage changes nothing (the next check retries).
 */
export async function checkConnection(deps: WaDeps, conn: WaConnection): Promise<CheckResult> {
  if (conn.status === "disconnected" || !conn.nangoConnectionId) return { status: conn.status, templates: null };
  const now = new Date();
  let token: string;
  try {
    token = await connectionToken(conn, deps);
  } catch (err) {
    await systemDb.waConnection.update({ where: { id: conn.id }, data: { lastCheckedAt: now } });
    if (err instanceof WhatsappError && err.code === "reconnect_needed") return { status: "reconnect", templates: null };
    throw err;
  }
  const p = waPlatform();
  try {
    const data: Prisma.WaConnectionUpdateInput = { lastCheckedAt: now };
    if (p && !(await appSubscribed(p, conn.wabaId, token, deps.fetchImpl))) {
      await subscribeApp(conn.wabaId, token, deps.fetchImpl);
      data.subscribedAt = now;
      logger.info({ storeId: conn.storeId }, "whatsapp: subscribed again to the account's webhooks");
    } else if (!conn.subscribedAt) {
      data.subscribedAt = now;
    }
    let step = conn.step as ConnectionStep | null;
    let registered = conn.registered;
    if (conn.phoneNumberId) {
      const phone = await getPhone(conn.phoneNumberId, token, deps.fetchImpl);
      Object.assign(data, phoneFields(phone));
      if (phone.platform_type === "CLOUD_API") {
        registered = true;
        if (step === "business_app_number" || step === "register_failed" || step === "pin_required") step = null;
      } else if (step === "register_failed") {
        const reg = await register({ id: conn.storeId }, phone, conn.signupFlow, token, deps);
        registered = reg.registered;
        step = reg.step;
        if (reg.pinEnc) data.pinEnc = reg.pinEnc;
      }
    } else {
      const phones = await listPhones(conn.wabaId, token, deps.fetchImpl);
      step = phones.length ? "choose_number" : "no_number";
    }
    const templates = await syncTemplates(conn, token, deps.fetchImpl);
    data.registered = registered;
    data.step = step;
    data.statusDetail = step ? CONNECTION_STEPS[step] : null;
    // A connection on reconnect or with an account problem that answers again is working again.
    data.status = registered && !step ? "active" : "action_required";
    // Held messages wait 48 hours from when the connection stopped sending, then are cancelled (sweep).
    data.reconnectSince = data.status === "active" ? null : (conn.reconnectSince ?? now);
    const updated = await systemDb.waConnection.update({ where: { id: conn.id }, data });
    await markWorking({ ...updated, status: conn.status });
    return { status: updated.status, templates };
  } catch (err) {
    await systemDb.waConnection.update({ where: { id: conn.id }, data: { lastCheckedAt: now } });
    if (err instanceof WhatsappApiError) {
      if (err.action === "reconnect") {
        await markReconnect(conn, "Meta no longer accepts bizinsights' access", deps);
        return { status: "reconnect", templates: null };
      }
      if (err.action === "account") {
        await markAccountProblem(conn, "Meta restricted the WhatsApp account; check WhatsApp Manager", deps, { holdSending: true });
        return { status: "error", templates: null };
      }
      if (err.action === "retry" || err.action === "network") return { status: conn.status, templates: null };
      logger.warn({ storeId: conn.storeId, code: err.code, details: err.details }, "whatsapp health check refused");
      return { status: conn.status, templates: null };
    }
    throw err;
  }
}

/**
 * Disconnect: bizinsights unsubscribes from the account's webhooks and deletes its token (at Nango),
 * cancels what was waiting to be sent and every running campaign, and keeps the history. The number
 * itself keeps working in WhatsApp; removing bizinsights from the business is the merchant's, in
 * Meta Business Suite (the page says how).
 */
export async function disconnect(deps: WaDeps, input: { store: Store; userId: string | null; ip?: string; reason?: string }): Promise<void> {
  const conn = await systemDb.waConnection.findUnique({ where: { storeId: input.store.id } });
  if (!conn || conn.status === "disconnected") return;
  if (conn.nangoConnectionId) {
    try {
      const token = await connectionToken(conn, deps);
      await unsubscribeApp(conn.wabaId, token, deps.fetchImpl).catch((err: unknown) => logger.info({ err, storeId: conn.storeId }, "whatsapp: unsubscribing on disconnect failed; carrying on"));
    } catch {
      /* the token is already gone: nothing to unsubscribe with */
    }
    await deleteNangoToken(conn.nangoConnectionId, deps.fetchImpl).catch((err: unknown) => logger.warn({ err, storeId: conn.storeId }, "whatsapp: deleting the Nango connection failed; it is no longer used"));
    forgetWaToken(conn.nangoConnectionId);
  }
  const now = new Date();
  await systemDb.$transaction([
    systemDb.waConnection.update({
      where: { id: conn.id },
      data: { status: "disconnected", step: null, statusDetail: input.reason ?? null, nangoConnectionId: null, phoneNumberId: null, disconnectedAt: now, reconnectSince: null },
    }),
    systemDb.waMessage.updateMany({ where: { storeId: conn.storeId, status: "queued" }, data: { status: "cancelled", reason: "disconnected", finalAt: now, payloadEnc: null } }),
    systemDb.waCampaign.updateMany({ where: { storeId: conn.storeId, status: { in: ["scheduled", "sending"] } }, data: { status: "cancelled", cancelledAt: now, cancelReason: "disconnected" } }),
  ]);
  await resolveAlerts(conn.storeId, [WA_ALERT.reconnect, WA_ALERT.account, WA_ALERT.webhook]).catch(() => 0);
  await audit({ workspaceId: conn.workspaceId, actorUserId: input.userId, action: "whatsapp.disconnected", targetType: "store", targetId: conn.storeId, metadata: { wabaId: conn.wabaId, reason: input.reason ?? "merchant" }, ip: input.ip });
}

/** The PIN bizinsights set on the number, for an owner or admin moving it elsewhere. Audited. */
export async function revealPin(input: { store: Store; userId: string; ip?: string }): Promise<string | null> {
  const conn = await systemDb.waConnection.findUnique({ where: { storeId: input.store.id }, select: { pinEnc: true, workspaceId: true, storeId: true } });
  if (!conn?.pinEnc) return null;
  const pin = waDecrypt(conn.storeId, "pin", conn.pinEnc);
  await audit({ workspaceId: conn.workspaceId, actorUserId: input.userId, action: "whatsapp.pin_viewed", targetType: "store", targetId: conn.storeId, ip: input.ip });
  return pin;
}

export type { WaPlatform };

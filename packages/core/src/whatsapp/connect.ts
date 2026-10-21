/** Connecting and disconnecting a store's WhatsApp number. */
import { systemDb, type WhatsappConnection } from "@app/db";
import { keyVersionOf, randomToken, sha256Hex } from "@app/shared";
import { env } from "../env.js";
import { providerDetail } from "../errors.js";
import { logger } from "../logger.js";
import type { FetchLike } from "../shopify.js";
import {
  graph,
  waAccountInfo,
  waAccountNumbers,
  waAccountPhoneIds,
  waPhoneInfo,
  waRegisterPhone,
  waSetAppWebhook,
  waSubscribeApp,
  waPlatformConfig,
  waTokenInfo,
  WhatsappApiError,
} from "./graph.js";
import { WhatsappError } from "./errors.js";
import { connectionToken, ensureSettings, syncTemplates, waDecrypt, waEncrypt } from "./store.js";

/** Connecting can't go ahead until the merchant fixes what the message says (a 400). */
export class WhatsappConnectError extends WhatsappError {
  constructor(message: string, code: string) {
    super(message, 400, code);
    this.name = "WhatsappConnectError";
  }
}

export interface ConnectInput {
  store: { id: string; workspaceId: string };
  mode: "embedded" | "manual";
  wabaId: string;
  phoneNumberId: string;
  businessId?: string | null;
  accessToken: string;
  /** Manual mode: the merchant's app secret, which signs their webhooks. */
  appSecret?: string | null;
  userId: string | null;
}

/**
 * Check the number belongs to the account and the token can reach both, subscribe the account's
 * webhooks, and save the connection (token encrypted). Templates are fetched straight away.
 */
export async function connectWhatsapp(input: ConnectInput, fetchImpl: FetchLike): Promise<WhatsappConnection> {
  const taken = await systemDb.whatsappConnection.findFirst({ where: { phoneNumberId: input.phoneNumberId, NOT: { storeId: input.store.id } }, select: { id: true } });
  if (taken) throw new WhatsappConnectError("This WhatsApp number is already connected to another store in bizinsights. Disconnect it there first.", "number_in_use");
  let phone;
  let account;
  try {
    const ids = await waAccountPhoneIds(input.wabaId, input.accessToken, fetchImpl);
    if (!ids.includes(input.phoneNumberId)) throw new WhatsappConnectError("That phone number ID isn't in that WhatsApp Business Account.", "phone_not_in_account");
    [phone, account] = await Promise.all([waPhoneInfo(input.phoneNumberId, input.accessToken, fetchImpl), waAccountInfo(input.wabaId, input.accessToken, fetchImpl)]);
    await waSubscribeApp(input.wabaId, input.accessToken, fetchImpl);
  } catch (err) {
    if (err instanceof WhatsappConnectError) throw err;
    if (err instanceof WhatsappApiError) {
      if (err.action === "reconnect" || err.httpStatus === 401 || err.httpStatus === 403) {
        throw new WhatsappConnectError("Meta didn't accept that access token for this account. Check it has whatsapp_business_messaging and whatsapp_business_management permissions.", "token_rejected");
      }
      if (err.httpStatus === 400 || err.httpStatus === 404) throw new WhatsappConnectError(`Meta couldn't find that account or number: ${providerDetail(err.details ?? err.title)}`, "not_found");
    }
    throw err;
  }
  const accessTokenEnc = waEncrypt(input.store.id, "access", input.accessToken);
  let verify: { enc: string; hash: string } | null = null;
  if (input.mode === "manual") {
    const existing = await systemDb.whatsappConnection.findUnique({ where: { storeId: input.store.id }, select: { verifyTokenEnc: true, verifyTokenHash: true, mode: true } });
    if (existing?.mode === "manual" && existing.verifyTokenEnc && existing.verifyTokenHash) verify = { enc: existing.verifyTokenEnc, hash: existing.verifyTokenHash };
    else {
      const token = `wa_vt_${randomToken(18)}`;
      verify = { enc: waEncrypt(input.store.id, "verify", token), hash: sha256Hex(token) };
    }
  }
  const registered = phone.platform_type === "CLOUD_API";
  const data = {
    mode: input.mode,
    businessId: input.businessId ?? account.owner_business_info?.id ?? null,
    wabaId: input.wabaId,
    wabaName: account.name ?? null,
    phoneNumberId: input.phoneNumberId,
    displayPhoneNumber: phone.display_phone_number ?? null,
    verifiedName: phone.verified_name ?? null,
    nameStatus: phone.name_status ?? null,
    qualityRating: phone.quality_rating ?? null,
    messagingLimitTier: phone.messaging_limit_tier ?? null,
    registered,
    status: registered ? "active" : "pending",
    lastError: null,
    accessTokenEnc,
    appSecretEnc: input.mode === "manual" && input.appSecret ? waEncrypt(input.store.id, "app_secret", input.appSecret) : null,
    verifyTokenEnc: verify?.enc ?? null,
    verifyTokenHash: verify?.hash ?? null,
    tokenKeyVersion: keyVersionOf(accessTokenEnc),
    connectedByUserId: input.userId,
    lastSyncedAt: new Date(),
  };
  const before = await systemDb.whatsappConnection.findUnique({ where: { storeId: input.store.id } });
  // Another number replaces the old one: its templates belong to the old account.
  if (before && (before.wabaId !== input.wabaId || before.phoneNumberId !== input.phoneNumberId)) {
    await systemDb.whatsappTemplate.deleteMany({ where: { connectionId: before.id } });
  }
  const conn = await systemDb.whatsappConnection.upsert({
    where: { storeId: input.store.id },
    create: { ...data, workspaceId: input.store.workspaceId, storeId: input.store.id },
    update: { ...data, ...(before && before.wabaId === input.wabaId ? {} : { webhookVerifiedAt: null, lastWebhookAt: null }) },
  });
  await ensureSettings(input.store);
  await syncTemplates(conn, input.accessToken, fetchImpl).catch((err: unknown) => logger.warn({ err, storeId: input.store.id }, "template sync after connect failed; Refresh retries it"));
  return conn;
}

const NEEDED_SCOPES = ["whatsapp_business_management", "whatsapp_business_messaging"];

const tokenRejected = () =>
  new WhatsappConnectError("Meta didn't accept that access token. Copy it again from Meta (it's long and starts with EAA), or generate a new one.", "token_rejected");

export interface DiscoveredNumber {
  id: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  /** On the Cloud API already; otherwise bizinsights asks for a PIN after connecting. */
  registered: boolean;
}

export interface Discovered {
  /** The Meta app the token belongs to (so the page can link straight to its app secret). */
  appId: string | null;
  accounts: Array<{ id: string; name: string | null; numbers: DiscoveredNumber[] }>;
}

/**
 * From nothing but the merchant's access token: the WhatsApp Business Accounts and numbers it can
 * reach, so they pick a number instead of hunting for two numeric ids. An empty list means Meta
 * didn't say which accounts the token was given; the page then asks for the ids.
 */
export async function discoverWhatsapp(accessToken: string, fetchImpl: FetchLike): Promise<Discovered> {
  let info;
  try {
    info = await waTokenInfo(accessToken, fetchImpl);
  } catch (err) {
    if (err instanceof WhatsappApiError && (err.action === "reconnect" || err.httpStatus === 400 || err.httpStatus === 401 || err.httpStatus === 403)) throw tokenRejected();
    throw err;
  }
  const missing = info.scopes.length ? NEEDED_SCOPES.filter((s) => !info.scopes.includes(s)) : [];
  if (missing.length) {
    throw new WhatsappConnectError(`This token is missing the ${missing.join(" and ")} permission${missing.length > 1 ? "s" : ""}. Generate a new one and tick both WhatsApp permissions.`, "missing_permissions");
  }
  const accounts = await Promise.all(
    (info.wabaIds ?? []).slice(0, 10).map(async (id) => {
      try {
        const [account, numbers] = await Promise.all([waAccountInfo(id, accessToken, fetchImpl), waAccountNumbers(id, accessToken, fetchImpl)]);
        return {
          id,
          name: account.name ?? null,
          numbers: numbers.map((n) => ({ id: n.id, displayPhoneNumber: n.display_phone_number ?? null, verifiedName: n.verified_name ?? null, registered: n.platform_type === "CLOUD_API" })),
        };
      } catch (err) {
        logger.warn({ err, wabaId: id }, "whatsapp discovery: could not read an account");
        return null;
      }
    }),
  );
  return { appId: info.appId, accounts: accounts.filter((a): a is NonNullable<typeof a> => !!a) };
}

/**
 * Before saving a manual connection: the app secret must belong to the token's app, or every
 * webhook Meta sends would fail its signature check. Returns the app id (null when Meta wouldn't
 * say, in which case the secret can't be checked and the webhook is set up by hand).
 */
export async function checkManualApp(accessToken: string, appSecret: string, fetchImpl: FetchLike): Promise<string | null> {
  const appId = await waTokenInfo(accessToken, fetchImpl).then(
    (i) => i.appId,
    (err: unknown) => {
      logger.warn({ err }, "whatsapp: couldn't read the token's app; skipping the app secret check");
      return null;
    },
  );
  if (!appId) return null;
  try {
    await graph(fetchImpl, `${appId}|${appSecret}`, "GET", `${appId}/subscriptions`);
  } catch (err) {
    if (err instanceof WhatsappApiError && err.httpStatus >= 400 && err.httpStatus < 500) {
      throw new WhatsappConnectError("That app secret doesn't belong to the Meta app your token was made with. Copy the secret from the same app.", "wrong_app_secret");
    }
    throw err;
  }
  return appId;
}

/**
 * Point the merchant's app's webhook at bizinsights. "verified": Meta completed the handshake;
 * "in_use": the app's WhatsApp webhook already goes elsewhere (left alone); "failed": do it by hand.
 */
export async function setupManualWebhook(conn: WhatsappConnection, appId: string, appSecret: string, fetchImpl: FetchLike): Promise<"verified" | "in_use" | "failed"> {
  const verifyToken = manualVerifyToken(conn);
  if (!verifyToken) return "failed";
  try {
    const r = await waSetAppWebhook({ appId, appSecret }, `${env().API_URL}/webhooks/whatsapp`, verifyToken, fetchImpl);
    if (r === "in_use") return "in_use";
    if (r === "already") {
      // Already delivering here (an earlier connection with this app): no handshake comes, nor is one needed.
      await systemDb.whatsappConnection.update({ where: { id: conn.id }, data: { webhookVerifiedAt: new Date() } });
      return "verified";
    }
    const after = await systemDb.whatsappConnection.findUnique({ where: { id: conn.id }, select: { webhookVerifiedAt: true } });
    return after?.webhookVerifiedAt ? "verified" : "failed";
  } catch (err) {
    logger.warn({ err, connectionId: conn.id }, "whatsapp: setting the app's webhook failed; the merchant can do it by hand");
    return "failed";
  }
}

/**
 * bizinsights' own Meta app (Continue with WhatsApp): keep its WhatsApp webhook pointed at bizinsights,
 * so the owner never pastes a callback URL into Meta. Needs the app id, secret and verify token.
 */
export async function ensurePlatformWebhook(fetchImpl: FetchLike): Promise<"unconfigured" | "set" | "already" | "in_use"> {
  const cfg = waPlatformConfig();
  if (!cfg?.verifyToken) return "unconfigured";
  const r = await waSetAppWebhook({ appId: cfg.appId, appSecret: cfg.appSecret }, `${env().API_URL}/webhooks/whatsapp`, cfg.verifyToken, fetchImpl);
  if (r === "in_use") logger.warn({ appId: cfg.appId }, "bizinsights' Meta app sends WhatsApp webhooks to another URL; left alone");
  return r;
}

const isPinMismatch = (err: unknown) => err instanceof WhatsappApiError && (err.code === 133005 || err.code === 133006 || /pin/i.test(err.details ?? ""));

/** Register the number with the Cloud API (Embedded Signup numbers that aren't yet). */
export async function registerWhatsapp(conn: WhatsappConnection, pin: string, fetchImpl: FetchLike): Promise<WhatsappConnection> {
  try {
    await waRegisterPhone(conn.phoneNumberId, pin, connectionToken(conn), fetchImpl);
  } catch (err) {
    if (isPinMismatch(err)) {
      throw new WhatsappConnectError("That PIN doesn't match the number's two-step verification PIN. Use the PIN you set in WhatsApp Manager, or reset it there.", "wrong_pin");
    }
    throw err;
  }
  return systemDb.whatsappConnection.update({ where: { id: conn.id }, data: { registered: true, status: "active", lastError: null, pinEnc: waEncrypt(conn.storeId, "pin", pin) } });
}

/** A random 6-digit PIN (leading zeros allowed). */
function randomPin(): string {
  const n = new Uint32Array(1);
  crypto.getRandomValues(n);
  return String(n[0]! % 1_000_000).padStart(6, "0");
}

/**
 * Right after Embedded Signup's Cloud API flow: register the new number so it can send, without
 * asking the merchant for anything. Meta's registration takes a PIN, which becomes the number's
 * two-step verification PIN when it has none; bizinsights picks one and keeps it (encrypted) so the
 * merchant can see it later. A number that already has a PIN refuses ours and stays "pending":
 * the merchant then types their own. Numbers kept on the WhatsApp Business app (coexistence) are
 * never registered here, since that would move them off the app.
 */
export async function autoRegisterWhatsapp(conn: WhatsappConnection, fetchImpl: FetchLike): Promise<{ conn: WhatsappConnection; outcome: "already" | "registered" | "pin_needed" | "failed" }> {
  if (conn.registered) return { conn, outcome: "already" };
  try {
    return { conn: await registerWhatsapp(conn, randomPin(), fetchImpl), outcome: "registered" };
  } catch (err) {
    if (err instanceof WhatsappConnectError && err.code === "wrong_pin") return { conn, outcome: "pin_needed" };
    logger.warn({ err, connectionId: conn.id }, "whatsapp: registering the number after Embedded Signup failed; the merchant can retry with a PIN");
    return { conn, outcome: "failed" };
  }
}

/** The number's two-step verification PIN, when bizinsights knows it. */
export const connectionPin = (conn: Pick<WhatsappConnection, "storeId" | "pinEnc">) => (conn.pinEnc ? waDecrypt(conn.storeId, "pin", conn.pinEnc) : null);

/** The verify token a manual connection's Meta app is given (shown to the store's admins). */
export const manualVerifyToken = (conn: Pick<WhatsappConnection, "storeId" | "verifyTokenEnc">) => (conn.verifyTokenEnc ? waDecrypt(conn.storeId, "verify", conn.verifyTokenEnc) : null);

/** Disconnect: the token and templates are deleted, waiting messages cancelled; history stays. */
export async function disconnectWhatsapp(conn: WhatsappConnection, fetchImpl: FetchLike): Promise<void> {
  // Best effort: stop Meta sending this account's webhooks to the app that was subscribed, unless
  // another store still relies on that subscription (stores can share one account): unsubscribing
  // then would silently cut off its STOP replies and delivery statuses.
  const others = await systemDb.whatsappConnection.count({ where: { wabaId: conn.wabaId, mode: conn.mode, id: { not: conn.id } } });
  if (!others) await graph(fetchImpl, connectionToken(conn), "DELETE", `${conn.wabaId}/subscribed_apps`).catch(() => undefined);
  await systemDb.$transaction([
    systemDb.whatsappTemplate.deleteMany({ where: { connectionId: conn.id } }),
    systemDb.whatsappConnection.delete({ where: { id: conn.id } }),
  ]);
  await systemDb.whatsappMessage.updateMany({
    where: { storeId: conn.storeId, status: "scheduled" },
    data: { status: "cancelled", cancelledAt: new Date(), reason: "whatsapp_disconnected", paramsEnc: null },
  });
}

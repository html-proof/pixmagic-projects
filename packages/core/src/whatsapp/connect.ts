/** Connecting and disconnecting a store's WhatsApp number. */
import { systemDb, type WhatsappConnection } from "@app/db";
import { keyVersionOf, randomToken, sha256Hex } from "@app/shared";
import { logger } from "../logger.js";
import type { FetchLike } from "../shopify.js";
import { graph, waAccountInfo, waAccountPhoneIds, waPhoneInfo, waRegisterPhone, waSubscribeApp, WhatsappApiError } from "./graph.js";
import { connectionToken, ensureSettings, syncTemplates, waDecrypt, waEncrypt } from "./store.js";

export class WhatsappConnectError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
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
  if (taken) throw new WhatsappConnectError("This WhatsApp number is already connected to another store in Insights. Disconnect it there first.", "number_in_use");
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
      if (err.httpStatus === 400 || err.httpStatus === 404) throw new WhatsappConnectError(`Meta couldn't find that account or number: ${err.details ?? err.title}`, "not_found");
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

/** Register the number with the Cloud API (Embedded Signup numbers that aren't yet). */
export async function registerWhatsapp(conn: WhatsappConnection, pin: string, fetchImpl: FetchLike): Promise<WhatsappConnection> {
  try {
    await waRegisterPhone(conn.phoneNumberId, pin, connectionToken(conn), fetchImpl);
  } catch (err) {
    if (err instanceof WhatsappApiError && (err.code === 133005 || err.code === 133006 || /pin/i.test(err.details ?? ""))) {
      throw new WhatsappConnectError("That PIN doesn't match the number's two-step verification PIN. Use the PIN you set in WhatsApp Manager, or reset it there.", "wrong_pin");
    }
    throw err;
  }
  return systemDb.whatsappConnection.update({ where: { id: conn.id }, data: { registered: true, status: "active", lastError: null } });
}

/** The verify token a manual connection's Meta app is given (shown to the store's admins). */
export const manualVerifyToken = (conn: Pick<WhatsappConnection, "storeId" | "verifyTokenEnc">) => (conn.verifyTokenEnc ? waDecrypt(conn.storeId, "verify", conn.verifyTokenEnc) : null);

/** Disconnect: the token and templates are deleted, waiting messages cancelled; history stays. */
export async function disconnectWhatsapp(conn: WhatsappConnection, fetchImpl: FetchLike): Promise<void> {
  // Best effort: stop Meta sending this account's webhooks to the app that was subscribed.
  await graph(fetchImpl, connectionToken(conn), "DELETE", `${conn.wabaId}/subscribed_apps`).catch(() => undefined);
  await systemDb.$transaction([
    systemDb.whatsappTemplate.deleteMany({ where: { connectionId: conn.id } }),
    systemDb.whatsappConnection.delete({ where: { id: conn.id } }),
  ]);
  await systemDb.whatsappMessage.updateMany({
    where: { storeId: conn.storeId, status: "scheduled" },
    data: { status: "cancelled", cancelledAt: new Date(), reason: "whatsapp_disconnected", paramsEnc: null },
  });
}

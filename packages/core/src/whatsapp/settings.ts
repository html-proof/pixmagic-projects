/**
 * The store's WhatsApp settings (Step 3, Configure), its test number (Step 4: verified by a code
 * sent to it over the connected WhatsApp, then a test message the provider must report as sent),
 * and "Pause all automation".
 */
import { createHash, randomInt } from "node:crypto";
import { systemDb, type Store, type WappConnection, type WappSettings } from "@app/db";
import { isTimeZone, maskPhone, normalizePhone, renderWaText, waSampleValues, waSettingsSchema, WA_DAILY_LIMIT, type WaProvider } from "@app/shared";
import { audit } from "../notify.js";
import { businessNameOf, liveConnection, settingsOf, waDecrypt, waEncrypt, waPhoneHash, WhatsappError, type WaDeps } from "./common.js";
import { onDoNotMessageList } from "./contacts.js";
import { queueMessage } from "./messages.js";
import { templateUsable } from "./templates.js";

/** A verification code lives this long, may be tried this often, and sent this often per store and hour. */
const CODE_TTL_MS = 10 * 60_000;
const CODE_MAX_TRIES = 5;
const CODES_PER_HOUR = 3;

const codeHash = (storeId: string, phoneHash: string, code: string) => createHash("sha256").update(`wapp-test:${storeId}:${phoneHash}:${code}`).digest("hex");

/** Saves the settings (Step 3). Choosing how customers agree to order updates is recorded with who chose it. */
export async function saveWaSettings(input: { store: Store; userId: string; data: unknown; ip?: string }): Promise<WappSettings> {
  const s = waSettingsSchema.parse(input.data);
  if (s.timeZone && !isTimeZone(s.timeZone)) throw new WhatsappError("Pick a time zone from the list.", 400, "invalid_time_zone");
  const conn = await liveConnection(input.store.id);
  const provider = (conn?.provider ?? "qr") as WaProvider;
  if (s.dailyLimit > WA_DAILY_LIMIT[provider].max) throw new WhatsappError(`At most ${WA_DAILY_LIMIT[provider].max} messages a day on this connection.`, 400, "daily_limit_too_high");
  const before = await systemDb.wappSettings.findUnique({ where: { storeId: input.store.id } });
  const now = new Date();
  const basisChanged = (before?.orderUpdates ?? "unset") !== s.orderUpdates;
  const data = {
    businessName: s.businessName || null,
    orderUpdates: s.orderUpdates,
    ...(basisChanged ? { orderUpdatesSetBy: input.userId, orderUpdatesSetAt: now } : {}),
    marketingEnabled: s.marketingEnabled,
    shopifySmsConsent: s.shopifySmsConsent,
    sendWindowStart: s.sendWindow.start,
    sendWindowEnd: s.sendWindow.end,
    timeZone: s.timeZone || null,
    dailyLimit: s.dailyLimit,
    perCustomerDailyLimit: s.perCustomerDailyLimit,
    retentionDays: s.retentionDays,
    configuredAt: before?.configuredAt ?? now,
    updatedByUserId: input.userId,
  };
  const row = await systemDb.wappSettings.upsert({ where: { storeId: input.store.id }, create: { storeId: input.store.id, workspaceId: input.store.workspaceId, ...data }, update: data });
  await audit({
    workspaceId: input.store.workspaceId,
    actorUserId: input.userId,
    action: "whatsapp.settings_saved",
    targetType: "store",
    targetId: input.store.id,
    metadata: { orderUpdates: s.orderUpdates, marketingEnabled: s.marketingEnabled, shopifySmsConsent: s.shopifySmsConsent, dailyLimit: s.dailyLimit, retentionDays: s.retentionDays },
    ip: input.ip,
  });
  return row;
}

/** The number a linked phone (QR) is WhatsApp for: WhatsApp itself said so when the phone was linked. */
function isLinkedNumber(storeId: string, conn: Pick<WappConnection, "provider" | "phoneEnc"> | null, e164: string): boolean {
  if (conn?.provider !== "qr" || !conn.phoneEnc) return false;
  try {
    return waDecrypt(storeId, "linked_phone", conn.phoneEnc) === e164;
  } catch {
    return false;
  }
}

/** The verified test number is the linked phone's own (its tests land in that phone's chat with itself). */
export async function testIsLinkedNumber(store: Pick<Store, "id">, conn: Pick<WappConnection, "provider" | "phoneEnc"> | null): Promise<boolean> {
  if (conn?.provider !== "qr" || !conn.phoneEnc) return false;
  const s = await systemDb.wappSettings.findUnique({ where: { storeId: store.id }, select: { testVerifiedAt: true, testPhoneEnc: true } });
  if (!s?.testVerifiedAt || !s.testPhoneEnc) return false;
  try {
    return isLinkedNumber(store.id, conn, waDecrypt(store.id, "test_phone", s.testPhoneEnc));
  } catch {
    return false;
  }
}

/**
 * Step 4, first half: a 6-digit code to the merchant's own number, over the connected WhatsApp. Only
 * a number whose code comes back is used for tests (the person entering it has that phone).
 *
 * The linked phone's own number gets no code: a code sent from a number to itself arrives as no new
 * message (WhatsApp files it in that phone's chat with itself, without a notification; in production
 * it was reported sent and never delivered). That number is the store's by WhatsApp's own word (the
 * phone was linked with it), and a test to it reaches no one else, so it is verified as it is entered.
 */
export async function startTestVerification(
  deps: Pick<WaDeps, "queues" | "coord">,
  input: { store: Store; userId: string; phone: string; country?: string | null; ip?: string },
): Promise<{ expiresAt: Date | null; phone: string; linkedNumber: boolean }> {
  const conn = await liveConnection(input.store.id);
  if (!conn || conn.status !== "connected") throw new WhatsappError("Connect WhatsApp first: the code is sent from your connected number.", 409, "not_connected");
  const phone = normalizePhone(input.phone, input.country ?? null);
  if (!phone) throw new WhatsappError("Enter your number with its country code, for example +61 412 345 678.", 400, "invalid_phone");
  const phoneHash = waPhoneHash(input.store.id, phone.waId);
  if (await onDoNotMessageList(input.store.id, phoneHash, "transactional")) {
    throw new WhatsappError("That number asked not to get WhatsApp messages from this store (it replied STOP). Use another number, or reply START from it first.", 409, "suppressed");
  }
  if (isLinkedNumber(input.store.id, conn, phone.e164)) {
    const fields = {
      testPhoneHash: phoneHash,
      testPhoneEnc: waEncrypt(input.store.id, "test_phone", phone.e164),
      testPhoneMasked: maskPhone(phone.e164),
      testCodeHash: null,
      testCodeExpiresAt: null,
      testCodeAttempts: 0,
      testVerifiedAt: new Date(),
      testPassedAt: null,
      updatedByUserId: input.userId,
    };
    await systemDb.wappSettings.upsert({ where: { storeId: input.store.id }, create: { storeId: input.store.id, workspaceId: input.store.workspaceId, ...fields }, update: fields });
    await audit({ workspaceId: input.store.workspaceId, actorUserId: input.userId, action: "whatsapp.test_number_verified", targetType: "store", targetId: input.store.id, metadata: { linkedNumber: true }, ip: input.ip });
    return { expiresAt: null, phone: maskPhone(phone.e164), linkedNumber: true };
  }
  if ((await deps.coord.hit(`wapp:verify:${input.store.id}`, 3600)) > CODES_PER_HOUR) throw new WhatsappError("Too many codes sent in the last hour. Try again later.", 429, "rate_limited");
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const expiresAt = new Date(Date.now() + CODE_TTL_MS);
  const fields = {
    testPhoneHash: phoneHash,
    testPhoneEnc: waEncrypt(input.store.id, "test_phone", phone.e164),
    testPhoneMasked: maskPhone(phone.e164),
    testCodeHash: codeHash(input.store.id, phoneHash, code),
    testCodeExpiresAt: expiresAt,
    testCodeAttempts: 0,
    testVerifiedAt: null,
    testPassedAt: null,
    updatedByUserId: input.userId,
  };
  await systemDb.wappSettings.upsert({ where: { storeId: input.store.id }, create: { storeId: input.store.id, workspaceId: input.store.workspaceId, ...fields }, update: fields });
  const name = businessNameOf(input.store, await settingsOf(input.store));
  await queueMessage(deps, {
    store: input.store,
    conn,
    source: "verification",
    category: "transactional",
    phone,
    payload: { text: `Your bizinsights code for ${name}'s WhatsApp is ${code}. It expires in 10 minutes. If you didn't ask for it, ignore this message.` },
    // The code isn't kept in the history, where anyone who may read messages would see it.
    preview: `A bizinsights verification code for ${name}'s test number (the code isn't kept here).`,
    idempotencyKey: `verify:${phoneHash.slice(0, 16)}:${Date.now()}`,
    createdByUserId: input.userId,
  });
  await audit({ workspaceId: input.store.workspaceId, actorUserId: input.userId, action: "whatsapp.test_number_code_sent", targetType: "store", targetId: input.store.id, ip: input.ip });
  return { expiresAt, phone: maskPhone(phone.e164), linkedNumber: false };
}

/** Step 4, second half: the code the merchant read on their phone. */
export async function confirmTestVerification(input: { store: Store; userId: string; code: string; ip?: string }): Promise<void> {
  const s = await systemDb.wappSettings.findUnique({ where: { storeId: input.store.id } });
  if (!s?.testCodeHash || !s.testPhoneHash || !s.testCodeExpiresAt || s.testCodeExpiresAt < new Date()) throw new WhatsappError("That code has expired. Send a new one.", 409, "code_expired");
  if (s.testCodeAttempts >= CODE_MAX_TRIES) throw new WhatsappError("Too many wrong codes. Send a new one.", 429, "too_many_tries");
  const ok = codeHash(input.store.id, s.testPhoneHash, input.code.replace(/\D/g, "")) === s.testCodeHash;
  if (!ok) {
    await systemDb.wappSettings.update({ where: { storeId: input.store.id }, data: { testCodeAttempts: { increment: 1 } } });
    throw new WhatsappError("That code isn't right. Check the WhatsApp message and try again.", 400, "wrong_code");
  }
  await systemDb.wappSettings.update({ where: { storeId: input.store.id }, data: { testVerifiedAt: new Date(), testCodeHash: null, testCodeExpiresAt: null, testCodeAttempts: 0 } });
  await audit({ workspaceId: input.store.workspaceId, actorUserId: input.userId, action: "whatsapp.test_number_verified", targetType: "store", targetId: input.store.id, ip: input.ip });
}

/**
 * Step 4: a test message to the verified number (a template with sample values, or a short text).
 * The page then follows that message's real status; the step is done when WhatsApp reports it sent.
 */
export async function sendTestMessage(deps: Pick<WaDeps, "queues">, input: { store: Store; userId: string; templateId?: string | null; text?: string | null }): Promise<{ messageId: string }> {
  const conn = await liveConnection(input.store.id);
  if (!conn || conn.status !== "connected") throw new WhatsappError("WhatsApp isn't connected. Connect it first.", 409, "not_connected");
  const s = await systemDb.wappSettings.findUnique({ where: { storeId: input.store.id } });
  if (!s?.testVerifiedAt || !s.testPhoneEnc) throw new WhatsappError("Verify your test number first.", 409, "no_test_number");
  const phone = normalizePhone(waDecrypt(input.store.id, "test_phone", s.testPhoneEnc), null)!;
  const settings = await settingsOf(input.store);
  const name = businessNameOf(input.store, settings);
  let text = (input.text ?? "").trim();
  let templateId: string | null = null;
  let category: "transactional" | "marketing" = "transactional";
  if (input.templateId) {
    const t = await systemDb.wappTemplate.findFirst({ where: { id: input.templateId, storeId: input.store.id } });
    if (!t) throw new WhatsappError("Pick one of this store's templates.", 400, "template_not_found");
    const usable = templateUsable(t, conn);
    if (!usable.ok) throw new WhatsappError(`That template can't be sent: ${usable.reason}`, 409, "template_unavailable");
    text = renderWaText(t.body, waSampleValues(name), { lenient: true });
    templateId = t.id;
    category = t.category as typeof category;
  }
  if (!text) text = `This is a test message from ${name} on bizinsights. WhatsApp is connected and working.`;
  const { message } = await queueMessage(deps, {
    store: input.store,
    conn,
    source: "test",
    category,
    phone,
    payload: { text: text.slice(0, 1024) },
    templateId,
    idempotencyKey: `test:${Date.now()}:${input.userId.slice(-6)}`,
    createdByUserId: input.userId,
  });
  return { messageId: message.id };
}

/** "Pause all automation": automations start nothing, and their (and campaigns') waiting messages are held. */
export async function setAutomationPaused(input: { store: Store; userId: string; paused: boolean; ip?: string }) {
  const data = input.paused ? { automationPausedAt: new Date(), automationPausedBy: input.userId } : { automationPausedAt: null, automationPausedBy: null };
  await systemDb.wappSettings.upsert({ where: { storeId: input.store.id }, create: { storeId: input.store.id, workspaceId: input.store.workspaceId, ...data }, update: data });
  await audit({ workspaceId: input.store.workspaceId, actorUserId: input.userId, action: input.paused ? "whatsapp.automation_paused_all" : "whatsapp.automation_resumed_all", targetType: "store", targetId: input.store.id, ip: input.ip });
}

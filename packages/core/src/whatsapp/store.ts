/**
 * WhatsApp persistence: encrypted fields, contacts and their consent, the store's settings, the
 * connected number and its templates. Everything here scopes by store; callers have already
 * decided the store is the caller's (API routes) or came from a verified webhook (worker).
 */
import { Prisma, systemDb, type WhatsappConnection, type WhatsappContact } from "@app/db";
import {
  decrypt,
  encrypt,
  hmacSha256Hex,
  keyVersionOf,
  maskPhone,
  randomToken,
  sha256Hex,
  whatsappConfigSchema,
  type NormalizedPhone,
  type WhatsappConfig,
} from "@app/shared";
import { env } from "../env.js";
import { logger } from "../logger.js";
import type { FetchLike } from "../shopify.js";
import { keyring } from "../tokens.js";
import { waListTemplates, waPhoneInfo, WhatsappApiError } from "./graph.js";

// ---------------------------------------------------------------------------
// Encryption. The AAD binds each ciphertext to its store and purpose, so a value can't be moved
// to another store's row or read back as something else.
// ---------------------------------------------------------------------------

export type WaSecretKind = "access" | "app_secret" | "verify" | "pin" | "phone" | "name" | "params" | "track" | "review" | "recovery" | "click";

const aad = (storeId: string, kind: WaSecretKind) => `wa:${storeId}:${kind}`;

export const waEncrypt = (storeId: string, kind: WaSecretKind, plaintext: string) => encrypt(plaintext, keyring(), aad(storeId, kind));
export const waDecrypt = (storeId: string, kind: WaSecretKind, ciphertext: string) => decrypt(ciphertext, keyring(), aad(storeId, kind));

/** Finds a contact from a webhook's wa_id without decrypting anything. */
export const phoneHash = (storeId: string, waId: string) => hmacSha256Hex(env().CUSTOMER_HASH_KEY, `wa:${storeId}:${waId}`);

/** A random link token and the hash it is looked up by. */
export function newLinkToken(): { token: string; hash: string } {
  const token = randomToken(24);
  return { token, hash: sha256Hex(token) };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export function parseConfig(raw: unknown): WhatsappConfig {
  const parsed = whatsappConfigSchema.safeParse(raw ?? {});
  if (parsed.success) return parsed.data;
  // A stored config that no longer validates (a field tightened since) keeps working with the
  // fields that still do, rather than switching every notification off.
  logger.warn({ issues: parsed.error.issues.slice(0, 3) }, "whatsapp config failed validation; using defaults for the rest");
  const fallback = whatsappConfigSchema.parse({});
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  for (const key of Object.keys(fallback) as Array<keyof WhatsappConfig>) {
    const one = whatsappConfigSchema.shape[key].safeParse(obj[key]);
    if (one.success) (fallback as Record<string, unknown>)[key] = one.data;
  }
  return fallback;
}

/** The store's WhatsApp settings, or null when WhatsApp has never been turned on for it. */
export async function storeWhatsapp(storeId: string): Promise<{ config: WhatsappConfig; connection: WhatsappConnection | null } | null> {
  const [settings, connection] = await Promise.all([
    systemDb.whatsappSettings.findUnique({ where: { storeId } }),
    systemDb.whatsappConnection.findUnique({ where: { storeId } }),
  ]);
  if (!settings) return null;
  return { config: parseConfig(settings.config), connection };
}

export async function ensureSettings(store: { id: string; workspaceId: string }) {
  return systemDb.whatsappSettings.upsert({
    where: { storeId: store.id },
    create: { storeId: store.id, workspaceId: store.workspaceId, config: {} },
    update: {},
  });
}

// ---------------------------------------------------------------------------
// Contacts and consent
// ---------------------------------------------------------------------------

export type MarketingSignal =
  /** Shopify's text-message marketing consent (counts only if the merchant says their wording covers WhatsApp). */
  | { status: "opted_in" | "opted_out"; source: "shopify_sms" }
  /** The customer said so on WhatsApp itself (START/STOP, Meta's marketing preference). */
  | { status: "opted_in" | "opted_out"; source: "whatsapp" | "whatsapp_keyword" | "meta_preferences" | "merchant" };

/**
 * Upsert the contact for a number, and apply what the event says about marketing consent.
 * A "no" said on WhatsApp is only undone by a "yes" said on WhatsApp: Shopify's SMS consent can
 * fill in an unknown, never overrule the customer's own STOP.
 */
export async function upsertContact(
  store: { id: string; workspaceId: string },
  phone: NormalizedPhone,
  info: { firstName?: string | null; customerKey?: string | null; marketing?: MarketingSignal | null; inboundAt?: Date | null } = {},
): Promise<WhatsappContact> {
  const hash = phoneHash(store.id, phone.waId);
  const firstName = info.firstName?.trim().split(/\s+/)[0]?.slice(0, 60) || null;
  const now = new Date();
  let contact: WhatsappContact;
  try {
    contact = await systemDb.whatsappContact.upsert({
      where: { storeId_phoneHash: { storeId: store.id, phoneHash: hash } },
      create: {
        workspaceId: store.workspaceId,
        storeId: store.id,
        phoneHash: hash,
        phoneEnc: waEncrypt(store.id, "phone", phone.waId),
        phoneMasked: maskPhone(phone.e164),
        country: phone.country,
        customerKey: info.customerKey ?? null,
        firstNameEnc: firstName ? waEncrypt(store.id, "name", firstName) : null,
        lastInboundAt: info.inboundAt ?? null,
      },
      update: {
        ...(firstName ? { firstNameEnc: waEncrypt(store.id, "name", firstName) } : {}),
        ...(info.customerKey ? { customerKey: info.customerKey } : {}),
        ...(info.inboundAt ? { lastInboundAt: info.inboundAt } : {}),
      },
    });
  } catch (err) {
    // Two webhooks for the same new number at once: the other one created it.
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
    contact = await systemDb.whatsappContact.findUniqueOrThrow({ where: { storeId_phoneHash: { storeId: store.id, phoneHash: hash } } });
  }
  if (info.marketing) contact = await applyMarketing(contact, info.marketing, now);
  return contact;
}

const WHATSAPP_SOURCES = new Set(["whatsapp", "whatsapp_keyword", "meta_preferences"]);

export async function applyMarketing(contact: WhatsappContact, signal: MarketingSignal, at = new Date()): Promise<WhatsappContact> {
  if (contact.marketingStatus === signal.status) return contact;
  const saidOnWhatsapp = contact.marketingSource ? WHATSAPP_SOURCES.has(contact.marketingSource) || contact.marketingSource === "merchant" : false;
  if (signal.source === "shopify_sms" && contact.marketingStatus === "opted_out" && saidOnWhatsapp) return contact;
  if (signal.source === "shopify_sms" && signal.status === "opted_in" && contact.optedOut) return contact;
  return systemDb.whatsappContact.update({
    where: { id: contact.id },
    data: { marketingStatus: signal.status, marketingSource: signal.source, marketingUpdatedAt: at },
  });
}

/** Whether this number sent the store STOP: then nothing goes to it, test messages included. */
export async function numberOptedOut(storeId: string, waId: string): Promise<boolean> {
  const c = await systemDb.whatsappContact.findUnique({ where: { storeId_phoneHash: { storeId, phoneHash: phoneHash(storeId, waId) } }, select: { optedOut: true } });
  return !!c?.optedOut;
}

/** STOP: nothing at all goes to this number any more (order updates included). */
export async function optOutContact(contact: WhatsappContact, source: string, at = new Date()) {
  if (contact.optedOut && contact.marketingStatus === "opted_out") return contact;
  const updated = await systemDb.whatsappContact.update({
    where: { id: contact.id },
    data: { optedOut: true, optedOutAt: at, optOutSource: source, marketingStatus: "opted_out", marketingSource: source, marketingUpdatedAt: at },
  });
  // Whatever was waiting for them is cancelled now, not at send time.
  await systemDb.whatsappMessage.updateMany({
    where: { contactId: contact.id, status: "scheduled" },
    data: { status: "cancelled", cancelledAt: at, reason: "opted_out", paramsEnc: null },
  });
  return updated;
}

/** START after a STOP: order updates may resume, and marketing is opted in. */
export async function optInContact(contact: WhatsappContact, source: "whatsapp_keyword" | "meta_preferences", at = new Date()) {
  return systemDb.whatsappContact.update({
    where: { id: contact.id },
    data: { optedOut: false, optedOutAt: null, optOutSource: null, marketingStatus: "opted_in", marketingSource: source, marketingUpdatedAt: at },
  });
}

/** Only the contact's own number decrypts it: the send path, nothing else. */
export const contactWaId = (c: Pick<WhatsappContact, "storeId" | "phoneEnc">) => waDecrypt(c.storeId, "phone", c.phoneEnc);
export const contactFirstName = (c: Pick<WhatsappContact, "storeId" | "firstNameEnc">) => (c.firstNameEnc ? waDecrypt(c.storeId, "name", c.firstNameEnc) : null);

// ---------------------------------------------------------------------------
// The connected number
// ---------------------------------------------------------------------------

export const connectionToken = (c: Pick<WhatsappConnection, "storeId" | "accessTokenEnc">) => waDecrypt(c.storeId, "access", c.accessTokenEnc);

/** Messaging limit tier → how many customers a day the number may start conversations with. */
export function tierLimit(tier: string | null | undefined): number {
  switch ((tier ?? "").toUpperCase()) {
    case "TIER_50":
      return 50;
    case "TIER_250":
      return 250;
    case "TIER_1K":
      return 1_000;
    case "TIER_10K":
      return 10_000;
    case "TIER_100K":
      return 100_000;
    case "TIER_UNLIMITED":
      return Number.POSITIVE_INFINITY;
    default:
      return 250;
  }
}

/** Meta no longer accepts the token: nothing sends until the merchant reconnects. */
export async function markReconnect(connectionId: string, error: string) {
  await systemDb.whatsappConnection.updateMany({ where: { id: connectionId }, data: { status: "reconnect", lastError: error.slice(0, 500) } });
}

/** Re-read the number's details and every template from Meta. */
export async function refreshConnection(conn: WhatsappConnection, fetchImpl: FetchLike): Promise<WhatsappConnection> {
  const token = connectionToken(conn);
  try {
    const phone = await waPhoneInfo(conn.phoneNumberId, token, fetchImpl);
    await syncTemplates(conn, token, fetchImpl);
    return await systemDb.whatsappConnection.update({
      where: { id: conn.id },
      data: {
        displayPhoneNumber: phone.display_phone_number ?? conn.displayPhoneNumber,
        verifiedName: phone.verified_name ?? conn.verifiedName,
        qualityRating: phone.quality_rating ?? conn.qualityRating,
        nameStatus: phone.name_status ?? conn.nameStatus,
        messagingLimitTier: phone.messaging_limit_tier ?? conn.messagingLimitTier,
        // A number that has been on the Cloud API reports CLOUD_API.
        registered: conn.registered || phone.platform_type === "CLOUD_API",
        status: conn.registered || phone.platform_type === "CLOUD_API" ? "active" : "pending",
        lastError: null,
        lastSyncedAt: new Date(),
      },
    });
  } catch (err) {
    if (err instanceof WhatsappApiError && err.action === "reconnect") {
      await markReconnect(conn.id, err.message);
      return { ...conn, status: "reconnect", lastError: err.message };
    }
    throw err;
  }
}

export async function syncTemplates(conn: WhatsappConnection, token: string, fetchImpl: FetchLike): Promise<number> {
  const list = await waListTemplates(conn.wabaId, token, fetchImpl);
  const seen = new Set<string>();
  for (const t of list) {
    seen.add(`${t.name}:${t.language}`);
    await systemDb.whatsappTemplate.upsert({
      where: { connectionId_name_language: { connectionId: conn.id, name: t.name, language: t.language } },
      create: {
        workspaceId: conn.workspaceId,
        storeId: conn.storeId,
        connectionId: conn.id,
        metaId: t.id,
        name: t.name,
        language: t.language,
        category: t.category,
        status: t.status,
        components: t.components as unknown as Prisma.InputJsonValue,
        rejectedReason: t.rejected_reason && t.rejected_reason !== "NONE" ? t.rejected_reason : null,
        qualityScore: t.quality_score?.score ?? null,
      },
      update: {
        metaId: t.id,
        category: t.category,
        status: t.status,
        components: t.components as unknown as Prisma.InputJsonValue,
        rejectedReason: t.rejected_reason && t.rejected_reason !== "NONE" ? t.rejected_reason : null,
        qualityScore: t.quality_score?.score ?? null,
      },
    });
  }
  // Deleted in WhatsApp Manager: gone here too, so nothing tries to send it.
  const stored = await systemDb.whatsappTemplate.findMany({ where: { connectionId: conn.id }, select: { id: true, name: true, language: true } });
  const gone = stored.filter((s) => !seen.has(`${s.name}:${s.language}`)).map((s) => s.id);
  if (gone.length) await systemDb.whatsappTemplate.deleteMany({ where: { id: { in: gone } } });
  return list.length;
}

const REENCRYPT_PAGE = 500;

/** Calls `each` on every row `load` pages through by id; returns how many it changed. */
async function forEachRow<R extends { id: string }>(load: (afterId?: string) => Promise<R[]>, each: (row: R) => Promise<boolean>): Promise<number> {
  let changed = 0;
  let after: string | undefined;
  for (;;) {
    const rows = await load(after);
    for (const r of rows) if (await each(r)) changed++;
    if (rows.length < REENCRYPT_PAGE) return changed;
    after = rows[rows.length - 1]!.id;
  }
}

/**
 * Re-encrypt everything WhatsApp keeps under the token keyring with the active key: connection
 * secrets, contacts, message parameters and links, tracking and review tokens, abandoned
 * checkouts. Part of key rotation (reencryptAllTokens, docs/RUNBOOK.md). Values already on the
 * active key are skipped, so a second run changes nothing. Returns the number of rows rewritten.
 *
 * It runs while the Worker keeps writing these rows, so each write applies only if the row's
 * encrypted values are still the ones read (a message sent meanwhile has had its parameters
 * cleared, and must not get them back); a row changed in between is left for the next run. And it
 * keeps `updatedAt`, which the retention sweeps measure from.
 */
export async function reencryptWhatsappData(): Promise<number> {
  const active = keyring().active;
  /** The value under the active key, or undefined (left as is) when it already is or is empty. */
  const reseal = (storeId: string, kind: WaSecretKind, v: string | null) =>
    v && keyVersionOf(v) !== active ? waEncrypt(storeId, kind, waDecrypt(storeId, kind, v)) : undefined;
  const unchanged = (data: Record<string, string | undefined>) => Object.values(data).every((v) => v === undefined);
  const page = { orderBy: { id: "asc" as const }, take: REENCRYPT_PAGE };
  const afterId = (id?: string) => (id ? { id: { gt: id } } : {});

  const connections = await forEachRow(
    (id) => systemDb.whatsappConnection.findMany({ ...page, where: afterId(id) }),
    async (r) => {
      const data = {
        accessTokenEnc: reseal(r.storeId, "access", r.accessTokenEnc),
        appSecretEnc: reseal(r.storeId, "app_secret", r.appSecretEnc),
        verifyTokenEnc: reseal(r.storeId, "verify", r.verifyTokenEnc),
        pinEnc: reseal(r.storeId, "pin", r.pinEnc),
      };
      if (unchanged(data)) return false;
      const { count } = await systemDb.whatsappConnection.updateMany({
        where: { id: r.id, accessTokenEnc: r.accessTokenEnc, appSecretEnc: r.appSecretEnc, verifyTokenEnc: r.verifyTokenEnc, pinEnc: r.pinEnc },
        data: { ...data, tokenKeyVersion: active, updatedAt: r.updatedAt },
      });
      return count === 1;
    },
  );
  const contacts = await forEachRow(
    (id) => systemDb.whatsappContact.findMany({ ...page, where: afterId(id), select: { id: true, storeId: true, phoneEnc: true, firstNameEnc: true, updatedAt: true } }),
    async (r) => {
      const data = { phoneEnc: reseal(r.storeId, "phone", r.phoneEnc), firstNameEnc: reseal(r.storeId, "name", r.firstNameEnc) };
      if (unchanged(data)) return false;
      const { count } = await systemDb.whatsappContact.updateMany({
        where: { id: r.id, phoneEnc: r.phoneEnc, firstNameEnc: r.firstNameEnc },
        data: { ...data, updatedAt: r.updatedAt },
      });
      return count === 1;
    },
  );
  const messages = await forEachRow(
    (id) => systemDb.whatsappMessage.findMany({ ...page, where: afterId(id), select: { id: true, storeId: true, paramsEnc: true, clickUrlEnc: true, updatedAt: true } }),
    async (r) => {
      const data = { paramsEnc: reseal(r.storeId, "params", r.paramsEnc), clickUrlEnc: reseal(r.storeId, "click", r.clickUrlEnc) };
      if (unchanged(data)) return false;
      const { count } = await systemDb.whatsappMessage.updateMany({
        where: { id: r.id, paramsEnc: r.paramsEnc, clickUrlEnc: r.clickUrlEnc },
        data: { ...data, updatedAt: r.updatedAt },
      });
      return count === 1;
    },
  );
  const trackings = await forEachRow(
    (id) => systemDb.orderTracking.findMany({ ...page, where: afterId(id), select: { id: true, storeId: true, tokenEnc: true, reviewTokenEnc: true, updatedAt: true } }),
    async (r) => {
      const data = { tokenEnc: reseal(r.storeId, "track", r.tokenEnc), reviewTokenEnc: reseal(r.storeId, "review", r.reviewTokenEnc) };
      if (unchanged(data)) return false;
      const { count } = await systemDb.orderTracking.updateMany({
        where: { id: r.id, tokenEnc: r.tokenEnc, reviewTokenEnc: r.reviewTokenEnc },
        data: { ...data, updatedAt: r.updatedAt },
      });
      return count === 1;
    },
  );
  const checkouts = await forEachRow(
    (id) => systemDb.abandonedCheckout.findMany({ ...page, where: afterId(id), select: { id: true, storeId: true, customerNameEnc: true, recoveryUrlEnc: true, updatedAt: true } }),
    async (r) => {
      const data = { customerNameEnc: reseal(r.storeId, "name", r.customerNameEnc), recoveryUrlEnc: reseal(r.storeId, "recovery", r.recoveryUrlEnc) };
      if (unchanged(data)) return false;
      const { count } = await systemDb.abandonedCheckout.updateMany({
        where: { id: r.id, customerNameEnc: r.customerNameEnc, recoveryUrlEnc: r.recoveryUrlEnc },
        data: { ...data, updatedAt: r.updatedAt },
      });
      return count === 1;
    },
  );
  const total = connections + contacts + messages + trackings + checkouts;
  if (total) logger.info({ connections, contacts, messages, trackings, checkouts }, "whatsapp data re-encrypted");
  return total;
}

/**
 * What every part of WhatsApp Automation shares: its dependencies and errors, encryption of
 * customers' numbers and messages, bizinsights' Meta app (Embedded Signup and the webhooks), the
 * store's connection and settings, and the queue jobs.
 */
import { systemDb, type Store, type WaConnection, type WaSettings } from "@app/db";
import { decrypt, encrypt, hmacSha256Hex, keyVersionOf, type OrderUpdateBasis } from "@app/shared";
import type { Coord } from "../coord.js";
import { env } from "../env.js";
import { AppError } from "../errors.js";
import type { Mailer } from "../mailer.js";
import type { Producer, Queues } from "../queues.js";
import type { FetchLike } from "../shopify.js";
import { keyring } from "../tokens.js";

export interface WaDeps {
  coord: Coord;
  queues: Queues;
  fetchImpl: FetchLike;
  mailer: Mailer;
}

/** A WhatsApp rule the merchant broke, or a step they must take first (the message is written for them). */
export class WhatsappError extends AppError {
  constructor(message: string, status: 400 | 403 | 404 | 409 | 429 | 502 | 503, code: string, detail?: unknown) {
    super(message, status, code, detail);
    this.name = "WhatsappError";
  }
}

// ---------------------------------------------------------------------------
// Queue jobs: they ride the sync queue (like SMS's), told apart by `kind`.
// ---------------------------------------------------------------------------

export type WhatsappJob =
  /** Send one message (its row carries everything). */
  | { kind: "whatsapp"; messageId: string }
  /** Make the next batch of a campaign's messages. */
  | { kind: "whatsapp_dispatch"; campaignId: string; storeId: string }
  /** Apply one stored webhook delivery from Meta. */
  | { kind: "whatsapp_webhook"; eventId: string };

export const waQueue = (queues: Queues) => queues.sync as unknown as Producer<WhatsappJob>;

/** The longest a queued send waits in the queue; sends due later are picked up by the sweep. */
export const WA_MAX_QUEUE_DELAY_S = 12 * 3600;

// ---------------------------------------------------------------------------
// Encryption. The AAD binds each ciphertext to its store (or the webhook row) and purpose.
// ---------------------------------------------------------------------------

export type WaSecretKind = "phone" | "name" | "payload" | "preview" | "pin" | "test_phone" | "webhook";

const aad = (scope: string, kind: WaSecretKind) => `wa2:${scope}:${kind}`;
export const waEncrypt = (scope: string, kind: WaSecretKind, plaintext: string) => encrypt(plaintext, keyring(), aad(scope, kind));
export const waDecrypt = (scope: string, kind: WaSecretKind, ciphertext: string) => decrypt(ciphertext, keyring(), aad(scope, kind));
/** A ciphertext encrypted again with the active key (key rotation), or null when it already is. */
export function waReencrypt(scope: string, kind: WaSecretKind, ciphertext: string): string | null {
  const ring = keyring();
  if (keyVersionOf(ciphertext) === ring.active) return null;
  return encrypt(decrypt(ciphertext, ring, aad(scope, kind)), ring, aad(scope, kind));
}

/**
 * Finds a number at a store without decrypting anything (`digits`: E.164 without the plus). The same
 * keyed hash the earlier WhatsApp feature used, so a recorded privacy request (data_requests.phone_hash)
 * finds the customer in both.
 */
export const waPhoneHash = (storeId: string, digits: string) => hmacSha256Hex(env().CUSTOMER_HASH_KEY, `wa:${storeId}:${digits}`);

// ---------------------------------------------------------------------------
// bizinsights' Meta app (apps/aws/src/settings.ts and the app secret)
// ---------------------------------------------------------------------------

export interface WaPlatform {
  appId: string;
  appSecret: string;
  /** The Facebook Login for Business configuration of the WhatsApp Embedded Signup variation. */
  configId: string;
  version: string;
  verifyToken: string;
}

/**
 * The app's secret: its own, or the Meta Ads app's only when WhatsApp runs on that same app (no
 * WHATSAPP_APP_ID, or the same id). On an app of its own, the Ads app's secret signs nothing WhatsApp sends.
 */
function appSecretOf(e: ReturnType<typeof env>): string {
  if (e.WHATSAPP_APP_SECRET) return e.WHATSAPP_APP_SECRET;
  return !e.WHATSAPP_APP_ID || e.WHATSAPP_APP_ID === e.META_APP_ID ? e.META_APP_SECRET : "";
}

/** The secret Meta signs this app's webhooks with ("" when it isn't set). */
export const waAppSecret = () => appSecretOf(env());

/** What "Connect WhatsApp" still lacks on this server, by setting name (empty: it works). */
export function waPlatformMissing(): string[] {
  const e = env();
  return [
    !e.WHATSAPP_APP_ID && !e.META_APP_ID ? "WHATSAPP_APP_ID" : null,
    !e.WHATSAPP_CONFIG_ID ? "WHATSAPP_CONFIG_ID" : null,
    !appSecretOf(e) ? "WHATSAPP_APP_SECRET" : null,
    !e.WHATSAPP_WEBHOOK_VERIFY_TOKEN ? "WHATSAPP_WEBHOOK_VERIFY_TOKEN" : null,
    !e.NANGO_SECRET_KEY ? "NANGO_SECRET_KEY" : null,
  ].filter((x): x is string => !!x);
}

/** bizinsights' Meta app, or null until every setting Embedded Signup needs is there (the page then says so). */
export function waPlatform(): WaPlatform | null {
  if (waPlatformMissing().length) return null;
  const e = env();
  return { appId: e.WHATSAPP_APP_ID || e.META_APP_ID, appSecret: appSecretOf(e), configId: e.WHATSAPP_CONFIG_ID, version: e.WHATSAPP_API_VERSION, verifyToken: e.WHATSAPP_WEBHOOK_VERIFY_TOKEN };
}

export const waVersion = () => env().WHATSAPP_API_VERSION;

/** Where Meta sends this app's WhatsApp webhooks. */
export const waWebhookUrl = () => `${env().API_URL.replace(/\/$/, "")}/webhooks/whatsapp`;

// ---------------------------------------------------------------------------
// The store, its connection and its settings
// ---------------------------------------------------------------------------

export const storeLabel = (store: Pick<Store, "name" | "shopDomain">) => store.name?.trim() || store.shopDomain.replace(/\.myshopify\.com$/, "");

export async function storeById(id: string): Promise<Store | null> {
  return systemDb.store.findUnique({ where: { id } });
}

/** The store's connection, unless it was disconnected. */
export async function liveConnection(storeId: string): Promise<WaConnection | null> {
  const c = await systemDb.waConnection.findUnique({ where: { storeId } });
  return c && c.status !== "disconnected" ? c : null;
}

/** Whether a connection can send right now. */
export const canSend = (c: Pick<WaConnection, "status" | "registered" | "phoneNumberId" | "nangoConnectionId"> | null) =>
  !!c && c.status === "active" && c.registered && !!c.phoneNumberId && !!c.nangoConnectionId;

export interface WaSettingsView {
  orderUpdates: OrderUpdateBasis;
  orderUpdatesSetBy: string | null;
  orderUpdatesSetAt: Date | null;
  shopifySmsConsent: boolean;
  sendWindow: { start: number; end: number };
  dailyLimit: number | null;
  testPhoneMasked: string | null;
  hasTestPhone: boolean;
  /** The custom-event key's last characters and when it was made (null: none yet). */
  eventKey: { hint: string; createdAt: Date } | null;
}

export function waSettingsView(s: WaSettings | null): WaSettingsView {
  return {
    orderUpdates: (s?.orderUpdates ?? "unset") as OrderUpdateBasis,
    orderUpdatesSetBy: s?.orderUpdatesSetBy ?? null,
    orderUpdatesSetAt: s?.orderUpdatesSetAt ?? null,
    shopifySmsConsent: s?.shopifySmsConsent ?? false,
    sendWindow: { start: s?.sendWindowStart ?? 9, end: s?.sendWindowEnd ?? 20 },
    dailyLimit: s?.dailyLimit ?? null,
    testPhoneMasked: s?.testPhoneMasked ?? null,
    hasTestPhone: !!s?.testPhoneEnc,
    eventKey: s?.eventKeyHint && s.eventKeyCreatedAt ? { hint: s.eventKeyHint, createdAt: s.eventKeyCreatedAt } : null,
  };
}

export async function settingsOf(storeId: string): Promise<WaSettingsView> {
  return waSettingsView(await systemDb.waSettings.findUnique({ where: { storeId } }));
}

/** The merchant's own number for test messages (E.164), or null. */
export async function testPhoneOf(storeId: string): Promise<string | null> {
  const s = await systemDb.waSettings.findUnique({ where: { storeId }, select: { testPhoneEnc: true } });
  return s?.testPhoneEnc ? waDecrypt(storeId, "test_phone", s.testPhoneEnc) : null;
}

/**
 * What every part of WhatsApp Automation shares (docs/whatsapp.md): its dependencies and errors,
 * encryption of customers' numbers, message texts and the business's Meta token, the store's
 * connection and settings, and the queue it runs on.
 */
import { systemDb, type Store, type WappConnection, type WappSettings } from "@app/db";
import { decrypt, encrypt, hmacSha256Hex, keyVersionOf, WA_DAILY_LIMIT, WA_DEFAULT_RETENTION_DAYS, type WaOrderUpdateBasis, type WaSendWindow } from "@app/shared";
import type { Coord } from "../coord.js";
import { env } from "../env.js";
import { AppError } from "../errors.js";
import type { Mailer } from "../mailer.js";
import type { BlobStore, Producer, Queues, WhatsappJob } from "../queues.js";
import type { FetchLike } from "../shopify.js";
import { keyring } from "../tokens.js";

export interface WaDeps {
  coord: Coord;
  queues: Queues;
  fetchImpl: FetchLike;
  mailer: Mailer;
  /** Attachments waiting to be sent (S3 on AWS). */
  payloads: BlobStore;
}

/** A WhatsApp rule the merchant broke, or a step they must take first (the message is written for them). */
export class WhatsappError extends AppError {
  constructor(message: string, status: 400 | 403 | 404 | 409 | 410 | 422 | 429 | 502 | 503, code: string, detail?: unknown) {
    super(message, status, code, detail);
    this.name = "WhatsappError";
  }
}

export const waQueue = (queues: Queues): Producer<WhatsappJob> => queues.whatsapp;

/**
 * Alerts WhatsApp raises and resolves (worded in @app/shared/alerts). `loggedOut` and `provider` were
 * a QR-linked phone's and bizinsights' Evolution API service's: only ever resolved now.
 */
export const WA_ALERTS = {
  reconnect: "whatsapp_reconnect",
  down: "whatsapp_disconnected",
  qrRetired: "whatsapp_qr_retired",
  loggedOut: "whatsapp_logged_out",
  provider: "whatsapp_provider_down",
} as const;

/** SQS delays a message by at most 15 minutes; sends due later are queued by the sweep. */
export const WA_MAX_QUEUE_DELAY_S = 900;

// ---------------------------------------------------------------------------
// Encryption. The AAD binds each ciphertext to its store and purpose.
// ---------------------------------------------------------------------------

/**
 * `instance_token`: the business's Meta token (Evolution API instances' own keys before 2026-10-28,
 * hence the name, which the existing ciphertexts are bound to); `webhook_key`: a QR-linked
 * instance's webhook key, until the instance is deleted.
 */
export type WaSecretKind = "phone" | "name" | "payload" | "preview" | "instance_token" | "webhook_key" | "linked_phone" | "test_phone" | "webhook";

const aad = (scope: string, kind: WaSecretKind) => `wapp:${scope}:${kind}`;
export const waEncrypt = (scope: string, kind: WaSecretKind, plaintext: string) => encrypt(plaintext, keyring(), aad(scope, kind));
export const waDecrypt = (scope: string, kind: WaSecretKind, ciphertext: string) => decrypt(ciphertext, keyring(), aad(scope, kind));
/** A ciphertext encrypted again with the active key (key rotation), or null when it already is. */
export function waReencrypt(scope: string, kind: WaSecretKind, ciphertext: string): string | null {
  const ring = keyring();
  if (keyVersionOf(ciphertext) === ring.active) return null;
  return encrypt(decrypt(ciphertext, ring, aad(scope, kind)), ring, aad(scope, kind));
}

/**
 * Finds a number at a store without decrypting anything (`digits`: E.164 without the plus). The
 * same keyed hash every WhatsApp feature used, so a recorded privacy request (data_requests.phone_hash)
 * finds the customer.
 */
export const waPhoneHash = (storeId: string, digits: string) => hmacSha256Hex(env().CUSTOMER_HASH_KEY, `wa:${storeId}:${digits}`);

// ---------------------------------------------------------------------------
// The store, its connection and its settings
// ---------------------------------------------------------------------------

export const storeLabel = (store: Pick<Store, "name" | "shopDomain">) => store.name?.trim() || store.shopDomain.replace(/\.myshopify\.com$/, "");

export async function storeById(id: string): Promise<Store | null> {
  return systemDb.store.findUnique({ where: { id } });
}

export async function connectionOf(storeId: string): Promise<WappConnection | null> {
  return systemDb.wappConnection.findUnique({ where: { storeId } });
}

/** A connection through Meta that still holds the business's token (a retired QR link never is one). */
const holdsToken = (c: Pick<WappConnection, "provider" | "instanceTokenEnc">) => c.provider === "cloud_api" && !!c.instanceTokenEnc;

/** The store's connection unless it was disconnected (it may be connected, or waiting to be reconnected). */
export async function liveConnection(storeId: string): Promise<WappConnection | null> {
  const c = await connectionOf(storeId);
  return c && c.status !== "disconnected" && holdsToken(c) ? c : null;
}

/** Whether a connection can be sent through now (Meta last accepted bizinsights' access for it). */
export const connectionCanSend = (c: Pick<WappConnection, "status" | "provider" | "instanceTokenEnc"> | null): boolean => !!c && c.status === "connected" && holdsToken(c);

/** Whether the store's automations listen at all: a connection that is up, or waiting to be reconnected for less than its grace period. */
export const connectionListens = (c: Pick<WappConnection, "status" | "provider" | "instanceTokenEnc"> | null): boolean =>
  !!c && holdsToken(c) && (c.status === "connected" || c.status === "reconnecting" || c.status === "logged_out");

export interface WaSettingsView {
  businessName: string | null;
  orderUpdates: WaOrderUpdateBasis;
  orderUpdatesSetBy: string | null;
  orderUpdatesSetAt: Date | null;
  marketingEnabled: boolean;
  shopifySmsConsent: boolean;
  sendWindow: WaSendWindow;
  /** The zone the sending hours are in: the setting, else the store's. */
  timeZone: string;
  timeZoneSet: string | null;
  dailyLimit: number | null;
  perCustomerDailyLimit: number;
  retentionDays: number;
  configuredAt: Date | null;
  testPhoneMasked: string | null;
  testVerifiedAt: Date | null;
  testPassedAt: Date | null;
  /** A verification code is waiting to be entered (until when). */
  testCodeExpiresAt: Date | null;
  automationPausedAt: Date | null;
  automationPausedBy: string | null;
}

export function waSettingsView(s: WappSettings | null, store: Pick<Store, "timezone">): WaSettingsView {
  const pending = s?.testCodeHash && s.testCodeExpiresAt && s.testCodeExpiresAt > new Date() ? s.testCodeExpiresAt : null;
  return {
    businessName: s?.businessName ?? null,
    orderUpdates: (s?.orderUpdates ?? "unset") as WaOrderUpdateBasis,
    orderUpdatesSetBy: s?.orderUpdatesSetBy ?? null,
    orderUpdatesSetAt: s?.orderUpdatesSetAt ?? null,
    marketingEnabled: s?.marketingEnabled ?? false,
    shopifySmsConsent: s?.shopifySmsConsent ?? false,
    sendWindow: { start: s?.sendWindowStart ?? 9, end: s?.sendWindowEnd ?? 20 },
    timeZone: s?.timeZone || store.timezone || "UTC",
    timeZoneSet: s?.timeZone ?? null,
    dailyLimit: s?.dailyLimit ?? null,
    perCustomerDailyLimit: s?.perCustomerDailyLimit ?? 3,
    retentionDays: s?.retentionDays ?? WA_DEFAULT_RETENTION_DAYS,
    configuredAt: s?.configuredAt ?? null,
    testPhoneMasked: s?.testPhoneMasked ?? null,
    testVerifiedAt: s?.testVerifiedAt ?? null,
    testPassedAt: s?.testPassedAt ?? null,
    testCodeExpiresAt: pending,
    automationPausedAt: s?.automationPausedAt ?? null,
    automationPausedBy: s?.automationPausedBy ?? null,
  };
}

export async function settingsOf(store: Pick<Store, "id" | "timezone">): Promise<WaSettingsView> {
  return waSettingsView(await systemDb.wappSettings.findUnique({ where: { storeId: store.id } }), store);
}

/** The most business-started messages the store sends a day. */
export const dailyLimitOf = (s: Pick<WaSettingsView, "dailyLimit">) => Math.min(s.dailyLimit ?? WA_DAILY_LIMIT.default, WA_DAILY_LIMIT.max);

/** The store's verified test number (E.164), or null. */
export async function verifiedTestPhone(storeId: string): Promise<string | null> {
  const s = await systemDb.wappSettings.findUnique({ where: { storeId }, select: { testPhoneEnc: true, testVerifiedAt: true } });
  return s?.testPhoneEnc && s.testVerifiedAt ? waDecrypt(storeId, "test_phone", s.testPhoneEnc) : null;
}

/** What {{store_name}} says: the business name in Settings, else the store's name. */
export const businessNameOf = (store: Pick<Store, "name" | "shopDomain">, s: Pick<WaSettingsView, "businessName">) => s.businessName?.trim() || storeLabel(store);

/** Days down after which waiting messages are cancelled rather than held. */
export const DOWN_GRACE_MS = 48 * 3600_000;

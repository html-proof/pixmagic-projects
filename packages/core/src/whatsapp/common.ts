/**
 * What every part of WhatsApp Automation shares (docs/whatsapp.md): its dependencies and errors,
 * encryption of customers' numbers, message texts and the instances' keys, the store's connection
 * and settings, and the queue it runs on.
 */
import { systemDb, type Store, type WappConnection, type WappSettings } from "@app/db";
import {
  decrypt,
  encrypt,
  hmacSha256Hex,
  keyVersionOf,
  WA_DAILY_LIMIT,
  WA_DEFAULT_RETENTION_DAYS,
  type WaConnectionStatus,
  type WaOrderUpdateBasis,
  type WaProvider,
  type WaSendWindow,
} from "@app/shared";
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
  constructor(message: string, status: 400 | 403 | 404 | 409 | 422 | 429 | 502 | 503, code: string, detail?: unknown) {
    super(message, status, code, detail);
    this.name = "WhatsappError";
  }
}

export const waQueue = (queues: Queues): Producer<WhatsappJob> => queues.whatsapp;

/** SQS delays a message by at most 15 minutes; sends due later are queued by the sweep. */
export const WA_MAX_QUEUE_DELAY_S = 900;

// ---------------------------------------------------------------------------
// Encryption. The AAD binds each ciphertext to its store and purpose.
// ---------------------------------------------------------------------------

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

/** The store's connection unless the merchant disconnected it (it may be pairing, connected, down). */
export async function liveConnection(storeId: string): Promise<WappConnection | null> {
  const c = await connectionOf(storeId);
  return c && c.status !== "disconnected" && c.instanceName ? c : null;
}

/** Whether a connection can be sent through now (the provider last said it is open). */
export const connectionCanSend = (c: Pick<WappConnection, "status" | "instanceName"> | null): boolean => !!c && c.status === "connected" && !!c.instanceName;

/** Whether the store's automations listen at all: a connection that is up, or down for less than its grace period. */
export const connectionListens = (c: Pick<WappConnection, "status" | "instanceName"> | null): boolean =>
  !!c && !!c.instanceName && (c.status === "connected" || c.status === "reconnecting" || c.status === "logged_out");

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

/** The most business-started messages the store sends a day on this provider. */
export const dailyLimitOf = (s: Pick<WaSettingsView, "dailyLimit">, provider: WaProvider) => Math.min(s.dailyLimit ?? WA_DAILY_LIMIT[provider].default, WA_DAILY_LIMIT[provider].max);

/** The store's verified test number (E.164), or null. */
export async function verifiedTestPhone(storeId: string): Promise<string | null> {
  const s = await systemDb.wappSettings.findUnique({ where: { storeId }, select: { testPhoneEnc: true, testVerifiedAt: true } });
  return s?.testPhoneEnc && s.testVerifiedAt ? waDecrypt(storeId, "test_phone", s.testPhoneEnc) : null;
}

/** What {{store_name}} says: the business name in Settings, else the store's name. */
export const businessNameOf = (store: Pick<Store, "name" | "shopDomain">, s: Pick<WaSettingsView, "businessName">) => s.businessName?.trim() || storeLabel(store);

/** Days down after which waiting messages are cancelled rather than held. */
export const DOWN_GRACE_MS = 48 * 3600_000;

/** Statuses in which the store's connection holds a live instance at the provider. */
export const INSTANCE_STATUSES: WaConnectionStatus[] = ["pairing", "connected", "reconnecting", "logged_out", "failed"];

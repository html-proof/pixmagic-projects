/**
 * What every part of Customer Messaging shares: its dependencies, its errors, encryption of
 * customers' numbers and texts, the platform's switches, a store's sender, the audit trail and
 * what a text is expected to cost.
 */
import { systemDb, type SmsSenderConfiguration, type Store } from "@app/db";
import { decrypt, encrypt, hmacSha256Hex, randomToken, sha256Hex } from "@app/shared";
import { billingMonth, type SmsTransactionalBasis } from "@app/shared/sms";
import type { Coord } from "../coord.js";
import { env, switchedOn } from "../env.js";
import { AppError } from "../errors.js";
import { logger } from "../logger.js";
import type { Mailer } from "../mailer.js";
import { audit } from "../notify.js";
import type { Producer, Queues } from "../queues.js";
import type { FetchLike } from "../shopify.js";
import { keyring } from "../tokens.js";
import type { SmsProvider } from "./provider.js";

export interface SmsDeps {
  coord: Coord;
  queues: Queues;
  fetchImpl: FetchLike;
  mailer: Mailer;
  sms: SmsProvider;
}

/** A Customer Messaging rule the person broke, or a step they must take first (the message is written for them). */
export class SmsError extends AppError {
  constructor(message: string, status: 400 | 403 | 404 | 409 | 429, code: string, detail?: unknown) {
    super(message, status, code, detail);
    this.name = "SmsError";
  }
}

// ---------------------------------------------------------------------------
// Queue jobs: sends ride the sync queue (like WhatsApp's), told apart by `kind`.
// ---------------------------------------------------------------------------

export interface SmsSendJob {
  kind: "sms";
  jobId: string;
}
export type SmsJob = SmsSendJob;

export const smsQueue = (queues: Queues) => queues.sync as unknown as Producer<SmsJob>;

/** The longest a queued send waits in the queue; sends due later are picked up by the sweep. */
export const MAX_QUEUE_DELAY_S = 12 * 3600;

// ---------------------------------------------------------------------------
// Encryption. The AAD binds each ciphertext to its store and purpose.
// ---------------------------------------------------------------------------

export type SmsSecretKind = "phone" | "name" | "values" | "body" | "recovery" | "test_phone";

const aad = (storeId: string, kind: SmsSecretKind) => `sms:${storeId}:${kind}`;
export const smsEncrypt = (storeId: string, kind: SmsSecretKind, plaintext: string) => encrypt(plaintext, keyring(), aad(storeId, kind));
export const smsDecrypt = (storeId: string, kind: SmsSecretKind, ciphertext: string) => decrypt(ciphertext, keyring(), aad(storeId, kind));

/** Finds a number at a store without decrypting anything (E.164 with the plus). */
export const smsPhoneHash = (storeId: string, e164: string) => hmacSha256Hex(env().CUSTOMER_HASH_KEY, `sms:${storeId}:${e164}`);

/** A 10-character opt-out code for a message's link, and the hash it is looked up by. */
export function newOptOutCode(): { code: string; hash: string } {
  const code = randomToken(8).replace(/[^A-Za-z0-9]/g, "").slice(0, 10).padEnd(10, "x");
  return { code, hash: sha256Hex(code) };
}

/** The opt-out link in a marketing text: the /stop page, which confirms before anything changes. */
export const optOutUrl = (code: string) => `${env().APP_URL.replace(/\/$/, "")}/stop?c=${code}`;

// ---------------------------------------------------------------------------
// The platform's switches (apps/aws/src/settings.ts)
// ---------------------------------------------------------------------------

export type SmsMode = "off" | "sandbox" | "live";
export const smsMode = (): SmsMode => env().SMS_MODE;
export const marketingSwitchedOn = () => switchedOn(env().SMS_MARKETING_ENABLED);
export const smsRegion = (sender?: Pick<SmsSenderConfiguration, "awsRegion"> | null) => sender?.awsRegion || env().SMS_DEFAULT_REGION || process.env.AWS_REGION || "ap-southeast-2";

/**
 * The configuration set for a region: SMS_CONFIGURATION_SET is one name (the App stack's, in the
 * default region only: a configuration set exists in one region), or JSON {"<region>": "<name>"}.
 * None for a region without one: the text goes without, and reports no delivery events.
 */
export function configurationSetFor(region: string): string | null {
  const raw = env().SMS_CONFIGURATION_SET.trim();
  if (!raw) return null;
  if (raw.startsWith("{")) {
    try {
      const map = JSON.parse(raw) as Record<string, string>;
      return map[region] ?? null;
    } catch {
      return null;
    }
  }
  return region === smsRegion(null) ? raw : null;
}

// ---------------------------------------------------------------------------
// A store's sender
// ---------------------------------------------------------------------------

export const senderOf = (storeId: string) => systemDb.smsSenderConfiguration.findUnique({ where: { storeId } });

export type SenderProblem = "missing" | "unverified" | "no_countries" | "sending_off" | "held";

/** Why a store's sender can't send right now, or null when it can (the overview and the send path). */
export function senderProblem(s: SmsSenderConfiguration | null, now = new Date()): SenderProblem | null {
  if (!s) return "missing";
  if (s.identityCheck !== "verified") return "unverified";
  if (!s.countries.length) return "no_countries";
  if (!s.sendingEnabled) return "sending_off";
  if (s.heldUntil && s.heldUntil > now) return "held";
  return null;
}

export const transactionalBasisOf = (s: SmsSenderConfiguration | null): SmsTransactionalBasis => (s?.transactionalBasis as SmsTransactionalBasis) ?? "none";

export async function storeById(storeId: string): Promise<Store | null> {
  return systemDb.store.findUnique({ where: { id: storeId } });
}

// ---------------------------------------------------------------------------
// Audit: the module's own trail (with snapshots, for version history) and the workspace's log
// ---------------------------------------------------------------------------

export interface SmsAuditInput {
  workspaceId: string;
  storeId?: string | null;
  actorUserId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  version?: number | null;
  snapshot?: unknown;
  metadata?: Record<string, unknown>;
  ip?: string;
}

/**
 * Record a change. Best effort and never throws (it runs after the change is committed), like
 * core's audit(). The snapshot carries templates' and rules' content, never a customer's number.
 */
export async function smsAudit(input: SmsAuditInput): Promise<void> {
  try {
    await systemDb.smsAuditLog.create({
      data: {
        workspaceId: input.workspaceId,
        storeId: input.storeId ?? null,
        actorUserId: input.actorUserId ?? null,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId,
        version: input.version ?? null,
        snapshot: (input.snapshot ?? undefined) as never,
        metadata: (input.metadata ?? undefined) as never,
        ip: input.ip,
      },
    });
  } catch (err) {
    logger.error({ err, workspaceId: input.workspaceId, action: input.action, targetType: input.targetType, targetId: input.targetId }, "sms audit write failed");
  }
  await audit({ workspaceId: input.workspaceId, actorUserId: input.actorUserId, action: `sms.${input.action}`, targetType: input.targetType, targetId: input.targetId, metadata: { ...(input.metadata ?? {}), ...(input.version ? { version: input.version } : {}) }, ip: input.ip });
}

// ---------------------------------------------------------------------------
// What a text costs
// ---------------------------------------------------------------------------

/** The owner's price list (SMS_PRICE_TABLE), per part, by country. */
export function priceTable(): Record<string, number> {
  try {
    const raw = JSON.parse(env().SMS_PRICE_TABLE || "{}") as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw)) if (/^[A-Z]{2}$/.test(k) && typeof v === "number" && v >= 0) out[k] = v;
    return out;
  } catch {
    return {};
  }
}

export interface PartPrice {
  usd: number;
  /** aws_billed: the average AWS charged this account per part for the country in the last 90 days; price_list: SMS_PRICE_TABLE. */
  source: "aws_billed" | "price_list";
}

/** What one part of a text to `country` is expected to cost, from what AWS actually billed, else the owner's price list; null when neither knows. */
export async function partPrice(country: string | null): Promise<PartPrice | null> {
  if (!country) return null;
  const since = new Date(Date.now() - 90 * 86400_000);
  const agg = await systemDb.smsCostRecord.aggregate({ where: { country, recordedAt: { gte: since }, parts: { gt: 0 } }, _sum: { totalUsd: true, parts: true } });
  const parts = agg._sum.parts ?? 0;
  if (parts > 0) return { usd: Number(agg._sum.totalUsd ?? 0) / parts, source: "aws_billed" };
  const listed = priceTable()[country];
  return listed !== undefined ? { usd: listed, source: "price_list" } : null;
}

/** What a store has spent on texts this month (AWS's prices, plus estimates for texts AWS hasn't priced yet). */
export async function monthSpend(storeId: string | null, at = new Date()): Promise<{ billedUsd: number; pendingUsd: number; totalUsd: number; messages: number }> {
  const month = billingMonth(at);
  const start = new Date(`${month}-01T00:00:00.000Z`);
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  const storeWhere = storeId ? { storeId } : {};
  const inMonth = { gte: start, lt: end };
  const [billed, pending, messages] = await Promise.all([
    systemDb.smsCostRecord.aggregate({ where: { ...storeWhere, month }, _sum: { totalUsd: true } }),
    systemDb.smsMessageJob.aggregate({ where: { ...storeWhere, acceptedAt: inMonth, priceUsd: null, status: { in: ["sending", "accepted", "pending", "uncertain"] } }, _sum: { estimatedCostUsd: true } }),
    systemDb.smsMessageJob.count({ where: { ...storeWhere, acceptedAt: inMonth } }),
  ]);
  const billedUsd = Number(billed._sum.totalUsd ?? 0);
  const pendingUsd = Number(pending._sum.estimatedCostUsd ?? 0);
  return { billedUsd, pendingUsd, totalUsd: billedUsd + pendingUsd, messages };
}

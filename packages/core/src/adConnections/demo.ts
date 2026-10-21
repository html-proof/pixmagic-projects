/**
 * The Google Ads demo connection ("Try demo" on the Google Ads card): a row in ad_connections like any
 * Google Ads account's, except that it holds no token (nothing was granted, so there is nothing to
 * encrypt, refresh or revoke), is marked is_demo, and carries the seed its figures are generated from
 * (ads/googleAdsSource.ts). Connecting, resetting and disconnecting it, what it says about itself, and
 * the switch that offers it. It is never a Google authorization: the row records bizinsights' own
 * simulated connection, and every answer about it says so.
 */
import { systemDb, type AdConnection } from "@app/db";
import {
  DEMO_ACCOUNT_ID,
  DEMO_ACCOUNT_NAME,
  DEMO_BADGE,
  DEMO_DISCLAIMER,
  DEMO_PERMISSIONS,
  demoAccountFacts,
  isDemoSeed,
  newDemoSeed,
  type DemoAccountFacts,
  type GoogleAdsConnectionStatus,
} from "@app/shared";
import { DEMO_ACCOUNT_STATUS_DETAIL, isDemoConnection } from "../ads/googleAdsSource.js";
import { env, switchedOn } from "../env.js";
import { AppError } from "../errors.js";
import { logger } from "../logger.js";
import type { Queues } from "../queues.js";
import { resolveAdAlerts } from "./alerts.js";
import { ADS_REQUEST_STALE_MS, enqueueAdCatchUp } from "./sync.js";

/** Whether this server offers the demo (GOOGLE_ADS_DEMO_ENABLED). Demo connections already made keep working either way. */
export const googleAdsDemoEnabled = (): boolean => switchedOn(env().GOOGLE_ADS_DEMO_ENABLED);

/**
 * The settings the real Google Ads sign-in still lacks on this server, by name (never a value): what
 * "Connect Google Ads" says instead of opening Google when the sign-in isn't set up. Empty once it is.
 */
export function googleProductionMissing(): string[] {
  const e = env();
  return [
    !e.GOOGLE_ADS_CLIENT_ID ? "GOOGLE_ADS_CLIENT_ID" : null,
    !e.GOOGLE_ADS_CLIENT_SECRET ? "GOOGLE_ADS_CLIENT_SECRET" : null,
    !switchedOn(e.GOOGLE_ADS_ENABLED) ? "GOOGLE_ADS_ENABLED" : null,
  ].filter((n): n is string => n !== null);
}

/** A rule of the demo the person ran into: answered as it is (AppError). */
export class AdsDemoError extends AppError {
  constructor(message: string, status: number, code: string) {
    super(message, status, code);
    this.name = "AdsDemoError";
  }
}

/**
 * What happens to a demo's figures when it is disconnected: they are deleted with the connection, as a
 * real account's are. Nothing of a demo is kept for later; connecting again generates it afresh.
 */
export const DEMO_RETENTION = "delete" as const;

/** The store's demo connection, if it has one. */
export async function findGoogleAdsDemo(storeId: string): Promise<AdConnection | null> {
  return systemDb.adConnection.findFirst({ where: { storeId, provider: "google", isDemo: true } });
}

export interface ConnectDemoInput {
  workspaceId: string;
  storeId: string;
  /** Who connected it (recorded on the row, as for a real account). */
  userId: string | null;
  /** A seed to generate from; a fresh one when absent. */
  seed?: number;
  /** The store's currency and time zone: the demo account adopts them, so its figures sit next to the store's. */
  store: { currency: string | null; timezone: string | null };
}

/**
 * Connect the demo account to a store: one per store (connecting again brings an existing one back,
 * shown and active, with the same figures). Its first 90 days are fetched the way a real account's are
 * (enqueueAdCatchUp: the sync job reads the generator instead of Google), and the card says
 * "Synchronizing" until they land. Returns the row as the catch-up left it.
 */
export async function connectGoogleAdsDemo(queues: Queues, input: ConnectDemoInput): Promise<{ connection: AdConnection; isNew: boolean; window: { since: string; until: string } | null }> {
  if (!googleAdsDemoEnabled()) throw new AdsDemoError("The Google Ads demo isn't switched on for this server.", 503, "demo_disabled");
  const facts = demoAccountFacts(input.store);
  const seed = isDemoSeed(input.seed) ? input.seed : newDemoSeed();
  const where = { storeId_provider_accountId: { storeId: input.storeId, provider: "google", accountId: DEMO_ACCOUNT_ID } };
  const before = await systemDb.adConnection.findUnique({ where });
  // Google's ids are digits, so no real account has the demo's id; a row with it that isn't a demo is never overwritten.
  if (before && !before.isDemo) throw new AdsDemoError("Another connection already uses the demo account's id.", 409, "demo_conflict");
  const row = before
    ? await systemDb.adConnection.update({
        where: { id: before.id },
        data: { enabled: true, status: "active", errorCode: null, lastError: null, consecutiveFailures: 0, connectedByUserId: input.userId, accountStatus: "active", accountStatusDetail: DEMO_ACCOUNT_STATUS_DETAIL, syncRequestedAt: null },
      })
    : await systemDb.adConnection.create({
        data: {
          workspaceId: input.workspaceId,
          storeId: input.storeId,
          provider: "google",
          accountId: DEMO_ACCOUNT_ID,
          accountName: DEMO_ACCOUNT_NAME,
          currency: facts.currency,
          timezone: facts.timezone,
          isDemo: true,
          demoSeed: seed,
          // No grant, no token: nothing to encrypt, and no key version to keep (0 names none).
          accessTokenEnc: "",
          refreshTokenEnc: null,
          accessTokenExpiresAt: null,
          tokenKeyVersion: 0,
          connectedByUserId: input.userId,
          externalUserId: null,
          grantedScopes: [],
          accountStatus: "active",
          accountStatusDetail: DEMO_ACCOUNT_STATUS_DETAIL,
        },
      });
  if (before) await resolveAdAlerts(row).catch((err: unknown) => logger.warn({ err, connectionId: row.id }, "ad alerts not resolved"));
  const window = await enqueueAdCatchUp(queues, row, { interactive: true });
  const connection = window ? await systemDb.adConnection.findUniqueOrThrow({ where: { id: row.id } }) : row;
  logger.info({ connectionId: row.id, storeId: input.storeId, workspaceId: input.workspaceId, isNew: !before }, "google ads demo connected");
  return { connection, isNew: !before, window };
}

/**
 * Generate the demo afresh: its stored days go, it gets a new seed (or the one asked for), and its
 * 90 days are fetched again. A sync still running for the old seed reads the row when it runs, so it
 * writes the new seed's figures too; the primary key (connection, campaign, day) keeps a day written
 * twice from doubling.
 */
export async function resetGoogleAdsDemo(queues: Queues, conn: AdConnection, seed?: number): Promise<{ connection: AdConnection; seed: number }> {
  if (!isDemoConnection(conn)) throw new AdsDemoError("Only a demo connection can be reset.", 400, "not_demo");
  const next = isDemoSeed(seed) ? seed : newDemoSeed();
  await systemDb.$transaction([
    systemDb.adCampaignDaily.deleteMany({ where: { connectionId: conn.id } }),
    systemDb.adConnection.update({
      where: { id: conn.id },
      data: { demoSeed: next, historyFrom: null, syncedThrough: null, lastSyncedAt: null, status: "active", errorCode: null, lastError: null, consecutiveFailures: 0, syncRequestedAt: null },
    }),
  ]);
  await enqueueAdCatchUp(queues, { id: conn.id, provider: conn.provider, timezone: conn.timezone, historyFrom: null, syncedThrough: null }, { interactive: true });
  logger.info({ connectionId: conn.id, storeId: conn.storeId }, "google ads demo reset");
  return { connection: await systemDb.adConnection.findUniqueOrThrow({ where: { id: conn.id } }), seed: next };
}

/**
 * Disconnect the demo: its figures and its row go (DEMO_RETENTION), a sync in flight finds nothing to
 * write to, and its alerts close. No platform is told: there is no grant to hand back, and no other
 * connection is touched.
 */
export async function disconnectGoogleAdsDemo(conn: AdConnection): Promise<void> {
  if (!isDemoConnection(conn)) throw new AdsDemoError("Only a demo connection can be disconnected here.", 400, "not_demo");
  await systemDb.$transaction([systemDb.adCampaignDaily.deleteMany({ where: { connectionId: conn.id } }), systemDb.adConnection.delete({ where: { id: conn.id } })]);
  await resolveAdAlerts(conn).catch((err: unknown) => logger.warn({ err, connectionId: conn.id }, "ad alerts not resolved"));
  logger.info({ connectionId: conn.id, storeId: conn.storeId }, "google ads demo disconnected");
}

/** A sync someone asked for is still on its way (the same rule the cards use). */
const syncRunning = (c: Pick<AdConnection, "enabled" | "syncRequestedAt">, now: number) => c.enabled && !!c.syncRequestedAt && now - c.syncRequestedAt.getTime() <= ADS_REQUEST_STALE_MS;

/**
 * Where a Google Ads connection stands, in the status endpoint's words, from the row alone: a demo row
 * is a demo status whatever a browser claims, and a real row never reads as one.
 */
export function googleAdsConnectionStatus(c: Pick<AdConnection, "provider" | "isDemo" | "status" | "enabled" | "syncRequestedAt" | "lastSyncedAt">, now = Date.now()): GoogleAdsConnectionStatus {
  if (isDemoConnection(c)) {
    if (c.status !== "active") return "demo_error";
    return syncRunning(c, now) || (c.enabled && !c.lastSyncedAt) ? "demo_syncing" : "connected_demo";
  }
  return c.status === "active" ? "connected_production" : "production_error";
}

/** The demo account as the account endpoint and the connection flow show it: its facts, its state, and what it may read. */
export interface DemoAccountView extends DemoAccountFacts {
  connectionId: string;
  /** The seed the figures are generated from (shown so a developer can reproduce or reset them). */
  seed: number;
  enabled: boolean;
  status: GoogleAdsConnectionStatus;
  connectedAt: string;
  lastSyncedAt: string | null;
  /** The account's own days stored without a gap. */
  historyFrom: string | null;
  syncedThrough: string | null;
  syncRequestedAt: string | null;
  permissions: readonly string[];
  badge: string;
  disclaimer: string;
}

export function demoAccountView(conn: AdConnection, now = Date.now()): DemoAccountView {
  return {
    ...demoAccountFacts({ currency: conn.currency, timezone: conn.timezone }),
    connectionId: conn.id,
    seed: conn.demoSeed ?? 0,
    enabled: conn.enabled,
    status: googleAdsConnectionStatus(conn, now),
    connectedAt: conn.createdAt.toISOString(),
    lastSyncedAt: conn.lastSyncedAt?.toISOString() ?? null,
    historyFrom: conn.historyFrom,
    syncedThrough: conn.syncedThrough,
    syncRequestedAt: conn.syncRequestedAt?.toISOString() ?? null,
    permissions: DEMO_PERMISSIONS,
    badge: DEMO_BADGE,
    disclaimer: DEMO_DISCLAIMER,
  };
}

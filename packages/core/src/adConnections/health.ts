/**
 * How the ad connections stand, for whoever runs bizinsights (`pnpm --filter @app/worker ops:ad-health`,
 * docs/RUNBOOK.md): how many there are per platform, how each is authorized and where each stands,
 * which ones stopped syncing or keep failing, what the last day's syncs came to, and whether Nango is
 * set up. Ids and counts only: never a token, a ciphertext, a Nango connection id, an email or an
 * account's name, so the report can be pasted into a ticket.
 */
import { systemDb } from "@app/db";
import type { AdProvider } from "@app/shared";
import type { Coord } from "../coord.js";
import { env } from "../env.js";
import type { FetchLike } from "../shopify.js";
import { nangoProviders } from "./config.js";
import { connectableAdProviders } from "./nango.js";

/** How long an active, shown account may go without a successful sync before it is listed. */
export const AD_HEALTH_STALE_MS = 24 * 3600_000;
/** A connection made this long ago that never synced is listed too (its first sync should have landed). */
const NEVER_SYNCED_AFTER_MS = 3600_000;
/** Failures in a row from which a connection is listed as failing. */
export const AD_HEALTH_FAILING_FROM = 3;
const LIST_MAX = 50;

/** One connection as the report lists it: where it is and how its syncs stand, nothing it holds. */
export interface AdHealthConnection {
  id: string;
  provider: string;
  accountId: string;
  workspaceId: string;
  storeId: string;
  source: string;
  status: string;
  errorCode: string | null;
  lastSyncedAt: Date | null;
  lastSyncAttemptAt: Date | null;
  consecutiveFailures: number;
}

export interface AdConnectionHealth {
  at: Date;
  /** Connections per platform, how they were authorized (nango, direct) and their status. */
  connections: Array<{ provider: string; source: string; status: string; count: number }>;
  /** Connections per error code (none: working). */
  errorCodes: Array<{ errorCode: string; count: number }>;
  /** Made by bizinsights' own sign-in and not moved to Nango yet (adConnections/migrate.ts). */
  directLeft: number;
  /** Waiting for someone to press Reconnect. */
  waitingForReconnect: number;
  /** Shown, active, and no successful sync for a day (or never, an hour after connecting). At most 50. */
  stale: AdHealthConnection[];
  /** Failed this many syncs in a row or more (AD_HEALTH_FAILING_FROM). At most 50. */
  failing: AdHealthConnection[];
  /** The last 24 hours of ad_sync_runs. */
  syncs: {
    byOutcome: Array<{ outcome: string; count: number }>;
    byProvider: Array<{ provider: string; outcome: string; count: number }>;
    /** The commonest reasons syncs failed (error codes), at most 10. */
    failureReasons: Array<{ reason: string; count: number }>;
  };
  nango: {
    /** NANGO_SECRET_KEY is set on this server. */
    keySet: boolean;
    /** The platforms this server connects through Nango (NANGO_PROVIDERS, keys set). */
    providers: Record<AdProvider, boolean>;
    /** Of those, the ones a card offers now (connectableAdProviders: Nango holds the integration); null when not asked (no coordinator). */
    connectable: Record<AdProvider, boolean> | null;
  };
}

const listed = {
  id: true,
  provider: true,
  accountId: true,
  workspaceId: true,
  storeId: true,
  source: true,
  status: true,
  errorCode: true,
  lastSyncedAt: true,
  lastSyncAttemptAt: true,
  consecutiveFailures: true,
} as const;

/** The report. Reads only; asks Nango which integrations it holds only when given a coordinator. */
export async function adConnectionHealth(opts: { coord?: Coord; fetchImpl?: FetchLike; now?: Date } = {}): Promise<AdConnectionHealth> {
  const now = opts.now ?? new Date();
  const staleBefore = new Date(now.getTime() - AD_HEALTH_STALE_MS);
  const since = new Date(now.getTime() - 24 * 3600_000);
  const [connections, errorCodes, directLeft, waitingForReconnect, stale, failing, byOutcome, byProvider, reasons] = await Promise.all([
    systemDb.adConnection.groupBy({ by: ["provider", "source", "status"], _count: { _all: true }, orderBy: [{ provider: "asc" }, { source: "asc" }, { status: "asc" }] }),
    systemDb.adConnection.groupBy({ by: ["errorCode"], where: { errorCode: { not: null } }, _count: { _all: true }, orderBy: { errorCode: "asc" } }),
    // As migrate.ts counts what is left to move.
    systemDb.adConnection.count({ where: { source: "direct", isDemo: false, accessTokenEnc: { not: "" } } }),
    systemDb.adConnection.count({ where: { status: "reconnect" } }),
    systemDb.adConnection.findMany({
      where: {
        enabled: true,
        status: "active",
        OR: [{ lastSyncedAt: { lt: staleBefore } }, { lastSyncedAt: null, createdAt: { lt: new Date(now.getTime() - NEVER_SYNCED_AFTER_MS) } }],
      },
      select: listed,
      orderBy: [{ lastSyncedAt: { sort: "asc", nulls: "first" } }, { id: "asc" }],
      take: LIST_MAX,
    }),
    systemDb.adConnection.findMany({
      where: { consecutiveFailures: { gte: AD_HEALTH_FAILING_FROM } },
      select: listed,
      orderBy: [{ consecutiveFailures: "desc" }, { id: "asc" }],
      take: LIST_MAX,
    }),
    systemDb.adSyncRun.groupBy({ by: ["outcome"], where: { startedAt: { gte: since } }, _count: { _all: true }, orderBy: { outcome: "asc" } }),
    systemDb.adSyncRun.groupBy({ by: ["provider", "outcome"], where: { startedAt: { gte: since } }, _count: { _all: true }, orderBy: [{ provider: "asc" }, { outcome: "asc" }] }),
    systemDb.adSyncRun.groupBy({ by: ["reason"], where: { startedAt: { gte: since }, outcome: "failed" }, _count: { _all: true } }),
  ]);
  let connectable: Record<AdProvider, boolean> | null = null;
  if (opts.coord) {
    try {
      connectable = await connectableAdProviders(opts.coord, opts.fetchImpl);
    } catch {
      connectable = null;
    }
  }
  return {
    at: now,
    connections: connections.map((g) => ({ provider: g.provider, source: g.source, status: g.status, count: g._count._all })),
    errorCodes: errorCodes.map((g) => ({ errorCode: g.errorCode!, count: g._count._all })),
    directLeft,
    waitingForReconnect,
    stale,
    failing,
    syncs: {
      byOutcome: byOutcome.map((g) => ({ outcome: g.outcome, count: g._count._all })),
      byProvider: byProvider.map((g) => ({ provider: g.provider, outcome: g.outcome, count: g._count._all })),
      failureReasons: reasons
        .map((g) => ({ reason: g.reason ?? "unknown", count: g._count._all }))
        .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
        .slice(0, 10),
    },
    nango: { keySet: !!env().NANGO_SECRET_KEY, providers: nangoProviders(), connectable },
  };
}

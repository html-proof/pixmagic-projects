/**
 * How the ad connections stand, for whoever runs bizinsights (`pnpm --filter @app/worker ops:ad-health`,
 * docs/RUNBOOK.md): how many there are per platform and where each stands, which ones stopped syncing
 * or keep failing, what the last day's syncs came to, and which platforms can be connected. Ids and
 * counts only: never a token, a ciphertext, an email or an account's name, so the report can be pasted
 * into a ticket.
 */
import { systemDb } from "@app/db";
import type { AdProvider } from "@app/shared";
import { adsConfigured } from "./config.js";

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
  status: string;
  errorCode: string | null;
  lastSyncedAt: Date | null;
  lastSyncAttemptAt: Date | null;
  consecutiveFailures: number;
}

export interface AdConnectionHealth {
  at: Date;
  /** Connections per platform and status. */
  connections: Array<{ provider: string; status: string; count: number }>;
  /** Connections per error code (none: working). */
  errorCodes: Array<{ errorCode: string; count: number }>;
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
  /** The platforms a card offers Connect for (this server holds the platform's own app's keys). */
  configured: Record<AdProvider, boolean>;
}

const listed = {
  id: true,
  provider: true,
  accountId: true,
  workspaceId: true,
  storeId: true,
  status: true,
  errorCode: true,
  lastSyncedAt: true,
  lastSyncAttemptAt: true,
  consecutiveFailures: true,
} as const;

/** The report. Reads only. */
export async function adConnectionHealth(opts: { now?: Date } = {}): Promise<AdConnectionHealth> {
  const now = opts.now ?? new Date();
  const staleBefore = new Date(now.getTime() - AD_HEALTH_STALE_MS);
  const since = new Date(now.getTime() - 24 * 3600_000);
  const [connections, errorCodes, waitingForReconnect, stale, failing, byOutcome, byProvider, reasons] = await Promise.all([
    systemDb.adConnection.groupBy({ by: ["provider", "status"], _count: { _all: true }, orderBy: [{ provider: "asc" }, { status: "asc" }] }),
    systemDb.adConnection.groupBy({ by: ["errorCode"], where: { errorCode: { not: null } }, _count: { _all: true }, orderBy: { errorCode: "asc" } }),
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
  return {
    at: now,
    connections: connections.map((g) => ({ provider: g.provider, status: g.status, count: g._count._all })),
    errorCodes: errorCodes.map((g) => ({ errorCode: g.errorCode!, count: g._count._all })),
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
    configured: adsConfigured(),
  };
}

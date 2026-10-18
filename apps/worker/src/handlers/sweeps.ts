/** The cron sweeps: nightly reconcile, sales re-reads, stuck jobs, expiring tokens, and the one-off seeds after a move. */
import { systemDb } from "@app/db";
import {
  getAccessToken,
  logger,
  migrateToExpiringToken,
  raiseAlert,
  seedResync,
  settleReturningCustomers,
  ShopifyHttpError,
  startReconciliation,
  StoreDisconnectedError,
  type SyncKind,
} from "@app/core";
import { syncProblem } from "@app/core/reports";
import { expandScopes, localDay } from "@app/shared";
import { enqueueAggregate, type WorkerDeps } from "./common.js";
import { BACKFILL_DAYS } from "./sync.js";
import { FAILED_AGGREGATE_TTL_S, failedAggregateKey } from "./aggregate.js";

/** Days of recently updated orders the daily reconcile re-pulls (at least; see reconcileOrderDays). */
export const RECONCILE_ORDER_DAYS = 3;

/** How long after the daily re-pull the check against Shopify starts (SQS delays at most 15 minutes). */
export const VERIFY_AFTER_RECONCILE_S = 900;

/**
 * How long a store is left alone once its reconcile has been enqueued.
 *
 * The reconcile runs on every quarter-hour tick, not only at 03:15: the database lives on a PC that
 * is often asleep or offline at that hour, and a once-a-day run that fails is simply gone. The lease
 * is what turns those ticks into "once a day per store": each tick reconciles exactly the stores
 * whose lease has lapsed, so a store missed by a failed run is picked up by the next tick that
 * reaches the database, and one already enqueued is never enqueued again by the tick after it
 * (or by the 03:15 trigger, which fires in the same minute). A little under a day, so a store is
 * reconciled about every 22 hours; nothing depends on the hour, and the orders window is sized
 * from the last sweep anyway. Kept in the Coordinator, which answers while Postgres does not.
 */
const RECONCILE_LEASE_MS = 22 * 3600_000;

/**
 * Days of orders a reconcile re-pulls: back past the store's last successful orders sweep, so a
 * store the reconcile could not reach for days has the whole gap re-pulled rather than only its
 * last three days (order updates whose webhooks were lost in the gap were never seen otherwise).
 *
 * `lastSyncedAt` is when the last successful orders sweep of any kind finished - the backfill,
 * "Refresh data", the dashboard's auto-refresh or a reconcile - and it is already on the store
 * row, so this costs nothing. The extra day covers that sweep's own run time (its window was set
 * when it started). Capped below BACKFILL_DAYS, where ordersSearch switches to `created_at` and
 * would stop seeing older orders updated in the gap; a store without a completed backfill (null)
 * keeps the fixed window, as its import has to be redone anyway.
 */
export function reconcileOrderDays(lastSyncedAt: Date | null, now = Date.now()): number {
  if (!lastSyncedAt) return RECONCILE_ORDER_DAYS;
  const gap = Math.ceil((now - lastSyncedAt.getTime()) / 86400_000) + 1;
  return Math.min(BACKFILL_DAYS - 1, Math.max(RECONCILE_ORDER_DAYS, gap));
}

/**
 * Days in the backfill window that have orders or sales but no daily_store_metrics row.
 *
 * The dashboard's KPIs read only daily_store_metrics, and an aggregate message can still be lost.
 * A backfill's final aggregate is the only one most of its days ever get (a small store's bulk
 * export is a single chunk), and the store is marked synced as soon as it is enqueued; every
 * later job recomputes only the days of the orders it re-pulls. So one lost message left weeks of
 * history at zero revenue on a store that read "synced", for good. recomputeDays is a pure upsert
 * of the source tables, which makes re-running it for these days always safe, and it writes a row
 * for every day it is given (zeros included), so a day it has repaired is not found here again.
 */
export async function unaggregatedDays(storeId: string, fromDay: string): Promise<string[]> {
  const rows = await systemDb.$queryRaw<Array<{ day: string }>>`
    SELECT d.day FROM (
      SELECT local_day AS day FROM orders WHERE store_id = ${storeId} AND local_day >= ${fromDay}
      UNION
      SELECT local_day AS day FROM order_sales WHERE store_id = ${storeId} AND local_day >= ${fromDay}
    ) d
    WHERE NOT EXISTS (SELECT 1 FROM daily_store_metrics m WHERE m.store_id = ${storeId} AND m.day = d.day)`;
  return rows.map((r) => r.day);
}

/**
 * Run once after the app moves to a new address with a copy of the database (a new deployment,
 * or a custom domain), for every connected store:
 *
 * - `install_pixel`: a web pixel posts to the URL it was given when it was made, so every existing
 *   pixel still sends the storefront's events to the old host. The job points it here (runSync).
 * - A full orders re-import: customer hashes are keyed with CUSTOMER_HASH_KEY, which a move can't
 *   always carry over (a secret that can't be read back). The import upserts customer_key
 *   with this deployment's key and recomputes "returning", so repeat customers are recognised again.
 *
 * Safe to repeat (everything upserts), but it costs Shopify rate limit, so it is a maintenance
 * action (`{ "action": "after-move" }` on AWS), never scheduled. Returns what it queued.
 */
export async function seedAfterMove(deps: Pick<WorkerDeps, "queues">) {
  const stores = await systemDb.store.findMany({
    where: { status: { in: ["active", "syncing", "error"] } },
    select: { id: true, workspaceId: true, grantedScopes: true, pixelInstalled: true },
  });
  let jobs = 0;
  for (const s of stores) {
    const kinds: SyncKind[] = ["orders"];
    if (s.pixelInstalled || expandScopes(s.grantedScopes).has("write_pixels")) kinds.push("install_pixel");
    for (const kind of kinds) {
      const job = await systemDb.syncJob.create({ data: { workspaceId: s.workspaceId, storeId: s.id, kind } });
      // No sinceDays: the whole history carries hashes made with the old key.
      await deps.queues.sync.send({ storeId: s.id, kind, syncJobId: job.id });
      jobs++;
    }
  }
  logger.info({ stores: stores.length, jobs }, "queued the after-move repair");
  return { stores: stores.length, jobs };
}

/**
 * Settle every store's new and returning customers again from what is stored (settleReturningCustomers)
 * and recompute the days that changed. Run after each deploy's migrations (the `reread` action):
 * cheap, and it repairs at once whatever an earlier rule decided, ahead of the re-reads that bring in
 * Shopify's own positions. Returns the number of days queued.
 */
export async function settleAllCustomers(deps: Pick<WorkerDeps, "queues">) {
  const stores = await systemDb.store.findMany({ where: { status: { not: "uninstalled" } }, select: { id: true } });
  let days = 0;
  for (const s of stores) {
    const changed = await settleReturningCustomers(s.id);
    if (changed.size) await enqueueAggregate(deps as WorkerDeps, s.id, changed);
    days += changed.size;
  }
  if (days) logger.info({ stores: stores.length, days }, "settled new and returning customers again");
  return days;
}

/** How often one store's sales records may be re-read without anyone asking (shared with the dashboard's). */
const SALES_REREAD_EVERY_S = 86_400;

/**
 * Re-read the import window (by creation date) for every store holding orders whose sales records
 * were never read: stored before bizinsights read them, or known only from a webhook whose read
 * failed. Daily totals are made from the sales records alone, so such an order adds nothing to
 * sales, and every webhook that re-aggregates its day makes that day look worse.
 *
 * The dashboard queues the same re-read, but only while someone has that store open: a store
 * nobody opened (a client's, say) kept understated sales indefinitely. This runs after every
 * deploy's migrations and on the scheduled tick. The lease is the dashboard's (`auto:reread`), so
 * between them a store is re-read at most once a day; a store already importing orders is left
 * to finish. Returns the number of stores queued.
 */
export async function seedSalesRereads(deps: Pick<WorkerDeps, "queues" | "coord">) {
  const since = new Date(Date.now() - BACKFILL_DAYS * 86_400_000);
  const lacking = await systemDb.order.findMany({
    where: {
      shopifyCreatedAt: { gte: since },
      OR: [
        { salesUpdatedAt: null },
        // A customer's order never read with what Shopify says of their history (stored before it
        // was read): new or returning can only be guessed until it is.
        { customerKey: { not: null }, customerOrderIndex: null, customerOrderCount: null },
      ],
    },
    distinct: ["storeId"],
    select: { storeId: true },
  });
  if (!lacking.length) return 0;
  const stores = await systemDb.store.findMany({
    where: { id: { in: lacking.map((o) => o.storeId) }, status: "active", accessTokenEnc: { not: null } },
    select: { id: true, workspaceId: true },
  });
  let queued = 0;
  for (const s of stores) {
    const importing = await systemDb.syncJob.count({
      where: { storeId: s.id, kind: "orders", status: { in: ["queued", "running"] }, createdAt: { gt: new Date(Date.now() - 30 * 60_000) } },
    });
    if (importing) continue;
    if ((await deps.coord.hit(`auto:reread:${s.id}`, SALES_REREAD_EVERY_S)) !== 1) continue;
    const job = await systemDb.syncJob.create({ data: { workspaceId: s.workspaceId, storeId: s.id, kind: "orders" } });
    await deps.queues.sync.send({ storeId: s.id, kind: "orders", syncJobId: job.id, sinceDays: BACKFILL_DAYS });
    queued++;
  }
  logger.info({ stores: stores.length, queued }, "queued sales record re-reads");
  return queued;
}

/**
 * Daily safety net for missed webhooks and lost aggregates: re-pull recently updated orders
 * (see reconcileOrderDays) and, with read_products, the whole catalog and stock levels
 * (inventory changes don't always reach us as products/update webhooks); and recompute any day
 * in the backfill window whose daily totals are missing (see unaggregatedDays).
 *
 * Each store is gated by its own lease (RECONCILE_LEASE_MS), taken before anything is enqueued
 * and given back if enqueueing fails, so a run that stops part-way - the database dropping
 * mid-loop - neither enqueues the stores it reached a second time nor silently skips the rest:
 * the next tick does exactly those. Returns the number of stores reconciled by this call.
 */
export async function scheduleReconcile(deps: WorkerDeps) {
  // Read on every tick now, so only what is needed (not the token ciphertexts).
  const stores = await systemDb.store.findMany({
    where: { status: { in: ["active", "error"] } },
    select: { id: true, workspaceId: true, grantedScopes: true, timezone: true, currency: true, lastSyncedAt: true, ordersHistoryFrom: true, status: true },
  });
  const now = Date.now();
  let reconciled = 0;
  for (const s of stores) {
    const lease = `reconcile:${s.id}`;
    if (!(await deps.coord.acquire(lease, RECONCILE_LEASE_MS))) continue;
    let failedDays: string | null = null;
    try {
      // Read before anything is sent, so a failure here leaves nothing behind for the retry to duplicate.
      const unaggregated = await unaggregatedDays(s.id, localDay(new Date(now - BACKFILL_DAYS * 86400_000), s.timezone));
      // Plus the days whose recompute ran out of attempts (rememberFailedAggregate).
      failedDays = await deps.coord.take(failedAggregateKey(s.id));
      const missing = [...new Set([...unaggregated, ...(failedDays ? (JSON.parse(failedDays) as string[]) : [])])].sort();
      const sinceDays = reconcileOrderDays(s.lastSyncedAt, now);
      if (sinceDays > RECONCILE_ORDER_DAYS) logger.info({ storeId: s.id, sinceDays, lastSyncedAt: s.lastSyncedAt }, "reconcile catching up on a gap");
      const kinds: SyncKind[] = ["orders"];
      if (expandScopes(s.grantedScopes).has("read_products")) kinds.push("products", "variants");
      for (const kind of kinds) {
        const job = await systemDb.syncJob.create({ data: { workspaceId: s.workspaceId, storeId: s.id, kind } });
        await deps.queues.sync.send({ storeId: s.id, kind, syncJobId: job.id, ...(kind === "orders" ? { sinceDays } : {}) });
      }
      if (missing.length) {
        logger.warn({ storeId: s.id, days: missing.length }, "re-aggregating days that have orders but no daily totals");
        await enqueueAggregate(deps, s.id, missing);
      }
      // Then the last 7 finished days are checked against Shopify, once that re-pull has had time
      // to land (docs/kpis.md "Checked against Shopify"). A store whose sync is broken is left out:
      // its check could only report what the sync problem already says.
      if (s.status === "active") {
        await startReconciliation(deps, s, "scheduled", { delaySeconds: VERIFY_AFTER_RECONCILE_S }).catch((err: unknown) =>
          logger.warn({ err, storeId: s.id }, "couldn't start the daily check against Shopify"),
        );
      }
    } catch (err) {
      // Best-effort: the Coordinator does not need Postgres, but a failed release must not hide
      // the error that matters. Unreleased, the store would wait out the lease instead.
      await deps.coord.release(lease).catch(() => {});
      // Put back the failed days taken above, so the run that retries this store still sees them.
      if (failedDays) await deps.coord.put(failedAggregateKey(s.id), failedDays, FAILED_AGGREGATE_TTL_S).catch(() => {});
      throw err;
    }
    reconciled++;
  }
  return reconciled;
}

/**
 * How long a started job may go without a sign of life before the watchdog calls it dead.
 *
 * Its chain touches `lastActivityAt` on its first message, every page and every bulk step, and
 * those are minutes apart at most (the cost-budget pace, the bulk poll backoff, retry backoff).
 * `startedAt` alone could not say this: it is stamped once, so a healthy import running past
 * this long was reaped as dead.
 */
const STALE_RUNNING_MS = 30 * 60 * 1000;

/**
 * How long a job may stay queued without ever being picked up. Hours beyond any backlog (the
 * sync consumer works four messages at a time), so a row this old has lost its message.
 */
const STALE_UNSTARTED_MS = 6 * 60 * 60 * 1000;

/**
 * Fail jobs whose chain died without reporting, and unstick their store.
 *
 * `runSync` marks a job `running` and relies on `consume` to record the outcome. That holds for a
 * thrown error, but not for an invocation the runtime *kills* - a CPU or time limit, as seen in
 * production - nor for a final attempt whose bookkeeping could not reach
 * the database either. The job stays unfinished, and because a store only leaves `syncing` when a
 * backfill job finishes, the store stays `syncing` forever and the merchant is told their import
 * is still in progress indefinitely. Two pixmagic.myshopify.com jobs sat that way for 7+ hours.
 *
 * Reaped: a started job (running, or queued because an older `onFailure` rewrote a retry that
 * way) with no sign of life for STALE_RUNNING_MS, and a job never picked up in STALE_UNSTARTED_MS.
 * A younger never-started job may just be waiting behind a backlog.
 *
 * The invariant this restores: a store never stays in `syncing` on the strength of a job that
 * nothing is working on. Only then is the store moved to `error` with a critical alert - the dead
 * job was its import. Any other store has its data and is not waiting on the job: flipping it
 * reported a healthy store as broken half an hour after an outage, often after a newer sync of the
 * same kind had already succeeded.
 */
export async function failStaleJobs(deps: WorkerDeps) {
  const cutoff = new Date(Date.now() - STALE_RUNNING_MS);
  const quiet = { OR: [{ lastActivityAt: { lt: cutoff } }, { lastActivityAt: null, startedAt: { lt: cutoff } }] };
  const stale = await systemDb.syncJob.findMany({
    where: {
      OR: [
        { status: { in: ["running", "queued"] }, startedAt: { not: null }, ...quiet },
        { status: "queued", startedAt: null, createdAt: { lt: new Date(Date.now() - STALE_UNSTARTED_MS) } },
      ],
    },
  });

  let reaped = 0;
  for (const job of stale) {
    const error = job.startedAt
      ? `Sync stopped without reporting (no progress for over ${Math.round(STALE_RUNNING_MS / 60000)} minutes); the job was marked failed automatically`
      : `Sync never started (queued for over ${Math.round(STALE_UNSTARTED_MS / 3600_000)} hours); the job was marked failed automatically`;
    // Only if nothing has touched it since it was read: a chain resuming after an outage is alive.
    const { count } = await systemDb.syncJob.updateMany({
      where: { id: job.id, status: job.status, lastActivityAt: job.lastActivityAt },
      data: { status: "failed", finishedAt: new Date(), error },
    });
    if (!count) continue;
    reaped++;
    const log = { syncJobId: job.id, storeId: job.storeId, kind: job.kind, startedAt: job.startedAt, lastActivityAt: job.lastActivityAt };

    // An uninstalled store has no sync to recover and must not be dragged back into `error`.
    const store = await systemDb.store.findUnique({ where: { id: job.storeId } });
    if (!store || store.status === "uninstalled") {
      logger.warn(log, "reaped stale sync job");
      continue;
    }
    if (store.status === "syncing") {
      logger.error(log, "reaped stale sync job; its store's import is dead");
      // Conditional, so a store that finished or was uninstalled since it was read stays as it is.
      const flipped = await systemDb.store.updateMany({ where: { id: store.id, status: "syncing" }, data: { status: "error" } });
      if (!flipped.count) continue;
      await raiseAlert(
        {
          workspaceId: store.workspaceId,
          storeId: store.id,
          severity: "critical",
          code: `sync_${job.kind}_failed`,
          message: `We couldn't sync ${job.kind} for ${store.shopDomain}: ${error}`,
        },
        deps.mailer,
        deps.fetchImpl,
      );
      continue;
    }
    // A store in `error` has already been reported, and its retries re-pull this kind anyway.
    if (store.status !== "active") {
      logger.warn(log, "reaped stale sync job; store already reported");
      continue;
    }
    const newer = await systemDb.syncJob.findFirst({
      where: { storeId: job.storeId, kind: job.kind, status: "succeeded", finishedAt: { gt: job.startedAt ?? job.createdAt } },
      select: { id: true },
    });
    if (newer) {
      logger.warn({ ...log, supersededBy: newer.id }, "reaped stale sync job; a newer one already succeeded");
      continue;
    }
    // Nothing of this kind has landed since: worth telling someone, but the data the store already
    // has is no less valid, and the next refresh or the daily reconcile tries again.
    logger.warn(log, "reaped stale sync job; nothing newer has succeeded");
    await raiseAlert(
      {
        workspaceId: store.workspaceId,
        storeId: store.id,
        severity: "warning",
        code: `sync_${job.kind}_stalled`,
        message: `Syncing ${job.kind} for ${store.shopDomain} stopped without finishing, and nothing newer has completed yet. The next scheduled sync will try again.`,
      },
      deps.mailer,
      deps.fetchImpl,
    );
  }
  return reaped;
}

/**
 * Validity a token must have left to sit out a sweep: one 15-minute tick plus getAccessToken's 5-minute
 * margin. Expiring offline tokens live an hour, so each store rotates about every 45 minutes,
 * which also keeps its 90-day refresh token from running out while nobody opens the dashboard.
 */
export const TOKEN_SWEEP_VALIDITY_MS = 20 * 60_000;
/** A store Shopify wouldn't move to an expiring token is asked again after this long. */
const TOKEN_MIGRATE_RETRY_MS = 3600_000;

/**
 * Rotate tokens that expire before the next tick, so request paths rarely block on a refresh, and
 * move stores still on a non-expiring token to an expiring one (migrateToExpiringToken). Returns
 * how many stores got a new token.
 */
export async function refreshExpiringTokens(deps: WorkerDeps) {
  const soon = new Date(Date.now() + TOKEN_SWEEP_VALIDITY_MS);
  const stores = await systemDb.store.findMany({
    where: {
      status: { not: "uninstalled" },
      accessTokenEnc: { not: null },
      OR: [{ accessTokenExpiresAt: null }, { accessTokenExpiresAt: { lt: soon }, refreshTokenEnc: { not: null } }],
    },
  });
  let renewed = 0;
  for (const s of stores) {
    const cooldown = `sweep:token-migrate:${s.id}`;
    try {
      if (s.accessTokenExpiresAt) {
        await getAccessToken(s, deps.coord, deps.fetchImpl, TOKEN_SWEEP_VALIDITY_MS);
        renewed++;
      } else if (await deps.coord.acquire(cooldown, TOKEN_MIGRATE_RETRY_MS)) {
        if (await migrateToExpiringToken(s, deps.coord, deps.fetchImpl)) {
          renewed++;
          // Moved either way: a failure here leaves the store to its dashboard's retry (autoRefresh).
          await resumeAfterLostAccess(deps, s.id).catch((err: unknown) =>
            logger.error({ err, storeId: s.id }, "store moved to an expiring token, but its sync was not queued again"),
          );
        }
      }
    } catch (err) {
      // Shopify or the network having a moment: the next tick asks again, not the next hour.
      if (!s.accessTokenExpiresAt && !(err instanceof ShopifyHttpError && !err.retryable)) await deps.coord.release(cooldown).catch(() => {});
      // A store Shopify cut off fails its next sync the same way, which is what tells the merchant.
      if (err instanceof StoreDisconnectedError) logger.warn({ err, storeId: s.id }, "token refresh refused; the store must be reconnected");
      else logger.error({ err, storeId: s.id }, s.accessTokenExpiresAt ? "token refresh failed" : "move to an expiring token failed");
    }
  }
  return renewed;
}

/**
 * A store whose import failed because Shopify refused its old token (it refuses a new public app's
 * non-expiring tokens outright, as on the App Store reviewers' stores on 2026-10-17/18) syncs again
 * once it holds one Shopify takes, instead of showing Reconnect until someone opens its dashboard.
 * A successful sync puts it back to active.
 */
async function resumeAfterLostAccess(deps: WorkerDeps, storeId: string) {
  const store = await systemDb.store.findUniqueOrThrow({ where: { id: storeId } });
  if (store.status !== "error") return;
  const failed = await systemDb.syncJob.findFirst({ where: { storeId, status: "failed" }, orderBy: { createdAt: "desc" }, select: { error: true } });
  if (syncProblem(failed?.error) !== "access") return;
  const jobs = await seedResync(deps, store);
  logger.info({ storeId, shop: store.shopDomain, jobs: jobs.length }, "store syncs again now that Shopify takes its token");
}

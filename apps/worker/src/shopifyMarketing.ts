import { logger, marketingReady, requestShopifyMarketing, shopifyMarketingQueue, syncShopifyMarketing, type ShopifyMarketingJob } from "@app/core";
import { systemDb } from "@app/db";
import { expandScopes } from "@app/shared";
import type { WorkerDeps } from "./handlers.js";

/** Why a read of Shopify's marketing report is asked for again: its own failure, which the queue's backoff retries. */
export class MarketingReadFailedError extends Error {
  constructor(storeId: string) {
    super(`Shopify's marketing report couldn't be read for store ${storeId}`);
    this.name = "MarketingReadFailedError";
  }
}

/** Seconds between one history window and the next: a walk back stays out of the way of the store's own imports. */
const BACKFILL_STEP_S = 20;

/**
 * Read a store's marketing report (packages/core/src/shopifyMarketing.ts) and keep it. A store that is
 * gone or hasn't granted its reports (read_reports, taken back since, say) is skipped. Shopify
 * refusing (no access, a report it won't run for the store) is kept on the store's sync row and left
 * to the next schedule; a failed call throws, so the queue tries again with its backoff. A read with
 * history left to walk queues the next window back.
 */
export async function runShopifyMarketing(job: ShopifyMarketingJob, deps: WorkerDeps) {
  const store = await systemDb.store.findUnique({ where: { id: job.storeId } });
  if (!store || store.status === "uninstalled" || !expandScopes(store.grantedScopes).has("read_reports")) return { skipped: true };
  if (!(await marketingReady(systemDb))) return { skipped: true };
  const res = await syncShopifyMarketing(store, job.mode, deps);
  if (res.status === "error" && res.error === "failed") throw new MarketingReadFailedError(store.id);
  if (res.status === "done" && res.more) {
    // A walk back queues its own next window; any other read starts one only while none holds the
    // store (its lease), so two walks never run side by side.
    if (job.mode === "backfill") await shopifyMarketingQueue(deps.queues).send({ kind: "shopify_marketing", storeId: store.id, mode: "backfill" }, { delaySeconds: BACKFILL_STEP_S });
    else await requestShopifyMarketing(deps, store, "backfill", { delaySeconds: BACKFILL_STEP_S });
  }
  return res;
}

/** Spread a tick's reads over a few minutes, so many stores' reports aren't asked for in one burst. */
const SPREAD_S = 300;
/** The most reads one tick queues, every mode together: the rest wait for the next tick (their leases stay free). */
export const MARKETING_SENDS_PER_TICK = 60;

/**
 * Keep each store's marketing figures current, on the 15-minute tick (leases make most ticks a no-op):
 * every store that granted its Shopify reports gets its recent days read every 6 hours and its last
 * week once a day, and its history walked back once. A store never read gets only its first read (the
 * last 90 days, then the walk back): the daily re-read starts the day after.
 */
export async function scheduleShopifyMarketing(deps: WorkerDeps) {
  if (!(await marketingReady(systemDb))) return { queued: 0 };
  const stores = await systemDb.store.findMany({
    where: { status: { in: ["active", "syncing", "error"] }, grantedScopes: { has: "read_reports" } },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  if (!stores.length) return { queued: 0 };
  const states = new Map((await systemDb.shopifyMarketingSync.findMany({ where: { storeId: { in: stores.map((s) => s.id) } }, select: { storeId: true, coveredFrom: true, backfilled: true } })).map((s) => [s.storeId, s]));
  let queued = 0;
  const send = async (storeId: string, mode: ShopifyMarketingJob["mode"]) => {
    if (queued >= MARKETING_SENDS_PER_TICK) return;
    if (await requestShopifyMarketing(deps, { id: storeId }, mode, { delaySeconds: Math.floor(Math.random() * SPREAD_S) })) queued++;
  };
  for (const s of stores) {
    const state = states.get(s.id);
    try {
      await send(s.id, "recent");
      if (!state?.coveredFrom) continue;
      await send(s.id, "reconcile");
      if (!state.backfilled) await send(s.id, "backfill");
    } catch (err) {
      // One store's send failing (its lease given back) leaves the others to this tick.
      logger.warn({ err, storeId: s.id }, "shopify marketing read not queued; the next tick tries again");
    }
  }
  return { queued };
}

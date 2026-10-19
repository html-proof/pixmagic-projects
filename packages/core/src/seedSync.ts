/** Seeding a store's imports: the first one, and the re-sync after "Refresh data" or a recovery. */
import { systemDb, type Store } from "@app/db";
import { expandScopes } from "@app/shared";
import type { Queues, SyncKind } from "./queues.js";
import { hasCapabilityScopes } from "./inventory/access.js";

/**
 * Kinds that must wait for the "shop" job, because they bucket rows by the store's local day
 * and `shop` is what learns the time zone. Everything else can start immediately.
 *
 * Only orders (and the refunds that ride with them) carry a `local_day`; the catalog does not,
 * so making products and variants wait for a round trip to Shopify bought nothing and simply
 * added a serial hop to the front of every import. The worker fans these out after `shop`;
 * the rest are enqueued here, straight away.
 */
const NEEDS_TIMEZONE = new Set<SyncKind>(["orders", "inventory"]);

/**
 * Create the initial sync job rows (visible as onboarding progress) and enqueue everything
 * that can start now. The worker runs `shop` first (it sets currency/time zone, which day
 * bucketing depends on) and then fans out the jobs that were waiting on it.
 */
export async function seedInitialSync(deps: { queues: Pick<Queues, "sync"> }, store: Pick<Store, "id" | "workspaceId" | "grantedScopes">) {
  const scopes = expandScopes(store.grantedScopes);
  const kinds: SyncKind[] = ["shop", "orders"];
  if (scopes.has("read_products")) kinds.push("products", "variants");
  if (scopes.has("write_pixels")) kinds.push("install_pixel");
  // Stock levels, once granted (the inventory pass records the store's day, so it waits for the zone).
  if (hasCapabilityScopes(store.grantedScopes, "stock_levels")) kinds.push("inventory");

  const jobs = [];
  for (const kind of kinds) {
    jobs.push(await systemDb.syncJob.create({ data: { workspaceId: store.workspaceId, storeId: store.id, kind } }));
  }
  // `shop` starts exactly these, not whatever else the store has queued (see runSync).
  const waitingJobIds = jobs.filter((j) => NEEDS_TIMEZONE.has(j.kind as SyncKind)).map((j) => j.id);
  for (const job of jobs) {
    if (NEEDS_TIMEZONE.has(job.kind as SyncKind)) continue;
    await deps.queues.sync.send({ storeId: store.id, kind: job.kind as SyncKind, syncJobId: job.id, ...(job.kind === "shop" ? { waitingJobIds } : {}) });
  }
  return jobs;
}

/** Days of orders a manual refresh re-pulls once the full backfill has completed. */
export const REFRESH_ORDER_DAYS = 7;

/**
 * "Refresh data": a store that never finished its first import gets the full initial sync
 * again; otherwise re-pull the catalog, stock levels and recently updated orders.
 */
export async function seedResync(
  deps: { queues: Pick<Queues, "sync"> },
  store: Pick<Store, "id" | "workspaceId" | "grantedScopes" | "lastSyncedAt">,
  orderDays: number = REFRESH_ORDER_DAYS,
) {
  if (!store.lastSyncedAt) return seedInitialSync(deps, store);
  const scopes = expandScopes(store.grantedScopes);
  const kinds: SyncKind[] = ["orders"];
  if (scopes.has("read_products")) kinds.push("products", "variants");
  if (hasCapabilityScopes(store.grantedScopes, "stock_levels")) kinds.push("inventory");
  const jobs = [];
  for (const kind of kinds) {
    const job = await systemDb.syncJob.create({ data: { workspaceId: store.workspaceId, storeId: store.id, kind } });
    await deps.queues.sync.send({
      storeId: store.id,
      kind,
      syncJobId: job.id,
      ...(kind === "orders" ? { sinceDays: orderDays } : {}),
    });
    jobs.push(job);
  }
  return jobs;
}

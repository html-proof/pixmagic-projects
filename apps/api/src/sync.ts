import { systemDb, type Prisma, type Store } from "@app/db";
import type { SyncKind } from "@app/core";
import { expandScopes } from "@app/shared";
import type { Deps } from "./context.js";

/**
 * Kinds that must wait for the "shop" job, because they bucket rows by the store's local day
 * and `shop` is what learns the time zone. Everything else can start immediately.
 *
 * Only orders (and the refunds that ride with them) carry a `local_day`; the catalog does not,
 * so making products and variants wait for a round trip to Shopify bought nothing and simply
 * added a serial hop to the front of every import. The worker fans these out after `shop`;
 * the rest are enqueued here, straight away.
 */
const NEEDS_TIMEZONE = new Set<SyncKind>(["orders"]);

/**
 * Create the initial sync job rows (visible as onboarding progress) and enqueue everything
 * that can start now. The worker runs `shop` first (it sets currency/time zone, which day
 * bucketing depends on) and then fans out the jobs that were waiting on it.
 */
export async function seedInitialSync(deps: Pick<Deps, "queues">, store: Pick<Store, "id" | "workspaceId" | "grantedScopes">) {
  const scopes = expandScopes(store.grantedScopes);
  const kinds: SyncKind[] = ["shop", "orders"];
  if (scopes.has("read_products")) kinds.push("products", "variants");
  if (scopes.has("write_pixels")) kinds.push("install_pixel");

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

/** A job never picked up counts as waiting for a consumer for this long after it was created. */
const QUEUED_WINDOW_MS = 30 * 60 * 1000;

/**
 * Sync jobs something is still working on: running, with a sign of life (`lastActivityAt`, else
 * `startedAt` on rows from before it existed) within `idleMs`; or never picked up and young enough
 * to be waiting behind other messages.
 *
 * A row merely existing says nothing. A chain whose last attempt failed while the database was
 * unreachable, or that the runtime killed, leaves its row queued or running with nothing behind
 * it - and counting it held the dashboard's refreshes off for half an hour after an outage, and
 * stopped a reconnect from re-importing a store stuck in "syncing".
 */
export function liveSyncJobs(storeId: string, idleMs: number): Prisma.SyncJobWhereInput {
  const since = new Date(Date.now() - idleMs);
  return {
    storeId,
    OR: [
      { status: "running", OR: [{ lastActivityAt: { gt: since } }, { lastActivityAt: null, startedAt: { gt: since } }] },
      { status: "queued", startedAt: null, createdAt: { gt: new Date(Date.now() - QUEUED_WINDOW_MS) } },
    ],
  };
}

/**
 * While someone has the dashboard open (it polls every 15 s), keep the store close to Shopify
 * even when webhooks are missed: re-pull recently updated orders every 5 minutes and the
 * catalog + stock every 30; a store with a sync problem retries its import every 30 minutes.
 */
export const AUTO_REFRESH = { ordersEverySec: 300, catalogEverySec: 1800, retryEverySec: 1800, orderDays: 2, sourcesEverySec: 86_400, sourcesDays: 60 } as const;

/** Whether the store has orders in the import window that were stored without a source. */
async function missingSources(storeId: string): Promise<boolean> {
  const since = new Date(Date.now() - AUTO_REFRESH.sourcesDays * 86_400_000);
  return !!(await systemDb.order.findFirst({ where: { storeId, trafficSource: null, shopifyCreatedAt: { gte: since } }, select: { id: true } }));
}

/**
 * A running job silent for longer than this is not holding off a refresh. Its chain writes on
 * every page and bulk step, a minute or two apart at most even through retries, so ten minutes of
 * nothing means it is dead - and if it is not, a second refresh is harmless (the upserts are
 * idempotent) where a missed one leaves the dashboard stale.
 */
const BUSY_IDLE_MS = 10 * 60 * 1000;

/**
 * Called on each dashboard poll; cheap when nothing is due (a few counter hits). Returns the
 * kinds it queued (for tests and logs).
 */
export async function autoRefresh(
  deps: Pick<Deps, "queues" | "coord">,
  store: Pick<Store, "id" | "workspaceId" | "grantedScopes" | "lastSyncedAt" | "status">,
): Promise<string[]> {
  if (store.status !== "active" && store.status !== "error") return [];
  const busy = await systemDb.syncJob.count({ where: liveSyncJobs(store.id, BUSY_IDLE_MS) });
  if (busy) return [];
  // At most once per window per store, however many people are watching.
  const due = async (what: string, everySec: number) => (await deps.coord.hit(`auto:${what}:${store.id}`, everySec)) === 1;

  if (store.status === "error" || !store.lastSyncedAt) {
    if (!(await due("retry", AUTO_REFRESH.retryEverySec))) return [];
    return (await seedResync(deps, store)).map((j) => j.kind);
  }
  const kinds: Array<{ kind: SyncKind; sinceDays?: number }> = [];
  // Orders stored before Insights recorded where customers came from: re-read the import window
  // once (by creation date), which fills their sources in. At most daily, and only while any lack one.
  if ((await due("sources", AUTO_REFRESH.sourcesEverySec)) && (await missingSources(store.id))) {
    kinds.push({ kind: "orders", sinceDays: AUTO_REFRESH.sourcesDays });
  } else if (await due("orders", AUTO_REFRESH.ordersEverySec)) kinds.push({ kind: "orders", sinceDays: AUTO_REFRESH.orderDays });
  if (expandScopes(store.grantedScopes).has("read_products") && (await due("catalog", AUTO_REFRESH.catalogEverySec))) {
    kinds.push({ kind: "products" }, { kind: "variants" });
  }
  for (const k of kinds) {
    const job = await systemDb.syncJob.create({ data: { workspaceId: store.workspaceId, storeId: store.id, kind: k.kind } });
    await deps.queues.sync.send({ storeId: store.id, kind: k.kind, syncJobId: job.id, ...(k.sinceDays ? { sinceDays: k.sinceDays } : {}) });
  }
  return kinds.map((k) => k.kind);
}

/** Days of orders a manual refresh re-pulls once the full backfill has completed. */
export const REFRESH_ORDER_DAYS = 7;

/**
 * "Refresh data": a store that never finished its first import gets the full initial sync
 * again; otherwise re-pull the catalog, stock levels and recently updated orders.
 */
export async function seedResync(
  deps: Pick<Deps, "queues">,
  store: Pick<Store, "id" | "workspaceId" | "grantedScopes" | "lastSyncedAt">,
) {
  if (!store.lastSyncedAt) return seedInitialSync(deps, store);
  const scopes = expandScopes(store.grantedScopes);
  const kinds: SyncKind[] = ["orders"];
  if (scopes.has("read_products")) kinds.push("products", "variants");
  const jobs = [];
  for (const kind of kinds) {
    const job = await systemDb.syncJob.create({ data: { workspaceId: store.workspaceId, storeId: store.id, kind } });
    await deps.queues.sync.send({
      storeId: store.id,
      kind,
      syncJobId: job.id,
      ...(kind === "orders" ? { sinceDays: REFRESH_ORDER_DAYS } : {}),
    });
    jobs.push(job);
  }
  return jobs;
}

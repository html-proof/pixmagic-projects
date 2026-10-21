import { systemDb, type Prisma, type Store } from "@app/db";
import { seedResync, type SyncKind } from "@app/core";
import { expandScopes } from "@app/shared";
import type { Deps } from "./context.js";

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

/**
 * Whether the store has orders in the import window that were stored without something only a
 * full read gives: where the customer came from, Shopify's sales records (orders stored before
 * the sales totals were read from them, or known only from a webhook whose read failed), or when
 * the order was processed (stored before that was read: the day it counts on, with its gift-card
 * flag and its sales' agreements, which a read fills in too).
 */
async function needsReread(storeId: string): Promise<boolean> {
  const since = new Date(Date.now() - AUTO_REFRESH.sourcesDays * 86_400_000);
  return !!(await systemDb.order.findFirst({
    where: { storeId, shopifyCreatedAt: { gte: since }, OR: [{ trafficSource: null }, { salesUpdatedAt: null }, { shopifyProcessedAt: null }] },
    select: { id: true },
  }));
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
  // Orders stored before bizinsights recorded where customers came from, or before the sales totals
  // were read from Shopify's sales records: re-read the import window once (by creation date),
  // which fills them in. At most daily, and only while any lack one. (The key was "sources" before
  // the sales records: a new one, so every store re-reads on its first dashboard view.)
  if ((await due("reread", AUTO_REFRESH.sourcesEverySec)) && (await needsReread(store.id))) {
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

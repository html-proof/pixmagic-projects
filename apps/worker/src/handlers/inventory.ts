/**
 * The sync queue's inventory passes (core/inventory/sync.ts): every location, then every location's
 * stock levels a page at a time, each message one page, re-sent with the next cursor. At the end,
 * the variants' totals, the day's snapshot and the stock alerts. A pass from the scheduled check
 * records each level that differed from Shopify ("reconcile" movements); webhooks keep levels
 * current in between. The sweeps that start and follow up on passes are at the bottom.
 */
import { systemDb, type Store } from "@app/db";
import {
  applyLevels,
  ensureInventoryWebhooks,
  evaluateFastMovement,
  evaluateStockAlerts,
  finishInventoryPass,
  graphqlLocationLevelSchema,
  graphqlLocationSchema,
  hasCapabilityScopes,
  hasFinishedPass,
  INVENTORY_LOCATIONS_QUERY,
  INVENTORY_PAGE_SIZE,
  inventorySettings,
  LEVEL_NAMES,
  levelsFromLocationPage,
  LOCATION_LEVELS_QUERY,
  locationGid,
  logger,
  markLocationsGone,
  notifyStockAlerts,
  parseShopifyList,
  recordPassLocations,
  recordPassPage,
  removeLevelsNotSeen,
  ShopifyGraphqlError,
  startInventoryPass,
  takeSnapshot,
  upsertLocations,
  type SyncJobData,
} from "@app/core";
import { UnrecoverableError, type WorkerDeps } from "./common.js";
import { gql, MAX_PACE_DELAY_S, shopifyReader, type Pace, type Page } from "./shopifyRead.js";

type Step = "continued" | "done";
type InventoryData = NonNullable<SyncJobData["inventory"]>;

/** One step of an inventory pass. "done" once the last location's last page is in and the pass is finished. */
export async function runInventoryStep(data: SyncJobData, store: Store, deps: WorkerDeps, pace: Pace): Promise<Step> {
  if (!hasCapabilityScopes(store.grantedScopes, "stock_levels")) {
    // Queued by a scope grant that didn't cover every scope stock levels need: nothing to read yet.
    logger.info({ storeId: store.id, scopes: store.grantedScopes }, "inventory pass skipped: the store hasn't granted stock-level access");
    return "done";
  }
  // A job queued without a pass (the first import, a scope grant): this message starts one.
  let inv: InventoryData;
  if (data.inventory) {
    inv = data.inventory;
  } else {
    const startedAt = new Date();
    const trigger = (await hasFinishedPass(store.id)) ? "manual" : "import";
    const run = await systemDb.inventorySyncRun.create({ data: { workspaceId: store.workspaceId, storeId: store.id, trigger, status: "running", startedAt } });
    inv = { trigger, runId: run.id, phase: "locations", startedAt: startedAt.toISOString() };
  }
  const since = new Date(inv.startedAt);
  const send = (next: Partial<SyncJobData> & { inventory: InventoryData }, defaultSize?: number) =>
    deps.queues.sync.send(
      { ...data, ...next, ...(data.pageSize && defaultSize && next.cursor ? { pageSize: Math.min(defaultSize, data.pageSize * 2) } : next.cursor ? {} : { pageSize: undefined }) },
      { delaySeconds: Math.min(MAX_PACE_DELAY_S, Math.ceil(pace.pendingMs / 1000)) },
    );
  const touch = (progress: number) => systemDb.syncJob.update({ where: { id: data.syncJobId }, data: { progress, lastActivityAt: new Date() } });

  if (inv.phase === "locations") {
    if (!data.cursor) {
      // The stock and location webhooks, subscribed once per store (and again if one went missing).
      await ensureInventoryWebhooks(store, shopifyReader(deps, store).gql).catch((err: unknown) =>
        logger.warn({ err, storeId: store.id }, "inventory webhooks couldn't be checked; the scheduled check keeps stock in step"),
      );
    }
    const d = await page<{ locations: Page<unknown> }>(deps, store, pace, data, INVENTORY_LOCATIONS_QUERY, INVENTORY_PAGE_SIZE.locations, {});
    if (!d) return "continued";
    const nodes = parseShopifyList(graphqlLocationSchema, d.locations.nodes, "GraphQL location", { storeId: store.id });
    const ids = await upsertLocations(store, nodes, new Date());
    const locations = [...(inv.locations ?? []), ...ids];
    await touch(locations.length);
    if (d.locations.pageInfo.hasNextPage && d.locations.pageInfo.endCursor) {
      await send({ cursor: d.locations.pageInfo.endCursor, inventory: { ...inv, locations } }, INVENTORY_PAGE_SIZE.locations);
      return "continued";
    }
    await markLocationsGone(store, since);
    if (inv.runId) await recordPassLocations(inv.runId, locations.length);
    await send({ cursor: null, progress: 0, inventory: { ...inv, phase: "levels", locations, index: 0 } });
    return "continued";
  }

  const locations = inv.locations ?? [];
  const index = inv.index ?? 0;
  const location = locations[index];
  if (location) {
    const d = await page<{ location: { inventoryLevels: Page<unknown> } | null }>(deps, store, pace, data, LOCATION_LEVELS_QUERY, INVENTORY_PAGE_SIZE.levels, {
      id: locationGid(location),
      names: LEVEL_NAMES,
    });
    if (!d) return "continued";
    // A location deleted since the listing has no levels to read: its rows go below.
    const nodes = d.location ? parseShopifyList(graphqlLocationLevelSchema, d.location.inventoryLevels.nodes, "GraphQL inventory level", { storeId: store.id }) : [];
    const reads = levelsFromLocationPage(location, nodes);
    const result = await applyLevels(store, reads, inv.trigger === "reconcile" ? "reconcile" : "sync");
    if (inv.runId) await recordPassPage(inv.runId, reads.length, inv.trigger === "import" ? [] : result.differences);
    const progress = (data.progress ?? 0) + reads.length;
    await touch(progress);
    if (d.location && d.location.inventoryLevels.pageInfo.hasNextPage && d.location.inventoryLevels.pageInfo.endCursor) {
      await send({ cursor: d.location.inventoryLevels.pageInfo.endCursor, progress, inventory: inv }, INVENTORY_PAGE_SIZE.levels);
      return "continued";
    }
    // This location is done: levels it no longer lists aren't stocked there any more.
    await removeLevelsNotSeen(store, location, since);
    if (index + 1 < locations.length) {
      await send({ cursor: null, progress, inventory: { ...inv, index: index + 1 } });
      return "continued";
    }
  }
  await finishInventoryPass(store, inv.runId);
  return "done";
}

/**
 * One page at `data.pageSize` (else `defaultSize`). On MAX_COST_EXCEEDED the same message goes
 * back with half the page size and null is returned, as fetchPage does for the other kinds; a
 * collection that comes back null is passed on (a location deleted mid-pass), not taken as withheld.
 */
async function page<T>(deps: WorkerDeps, store: Store, pace: Pace, data: SyncJobData, query: string, defaultSize: number, variables: Record<string, unknown>): Promise<T | null> {
  const first = Math.max(1, Math.floor(data.pageSize ?? defaultSize));
  try {
    return await gql<T>(deps, store, pace, query, { ...variables, first, cursor: data.cursor ?? null });
  } catch (err) {
    if (!(err instanceof ShopifyGraphqlError) || !err.costExceeded) throw err;
    if (first <= 1) throw new UnrecoverableError(`Shopify inventory query exceeds the cost limit even at one item per page: ${err.message}`);
    const pageSize = Math.max(1, Math.floor(first / 2));
    logger.warn({ storeId: store.id, kind: data.kind, from: first, to: pageSize }, "shopify query too expensive; halving page size");
    await deps.queues.sync.send({ ...data, pageSize });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Sweeps (every quarter hour)
// ---------------------------------------------------------------------------

/** Snapshots and the fast-selling check run at most this often per store. */
const HOURLY_LEASE_MS = 55 * 60_000;

/**
 * The stores whose inventory is set up (stock levels granted, or Stock settings saved: a store
 * nobody has set up gets no alerts it never asked for): start the scheduled check against Shopify
 * for each one due (every `reconcileHours`, from its settings), record the day's stock and
 * re-evaluate the alerts hourly (with Shopify's totals only, the catalog import is what moves
 * them), look for unusual sell-offs, and announce new stock alerts. Each store on its own: one
 * failing doesn't stop the rest.
 */
export async function sweepInventory(deps: WorkerDeps, now = new Date()) {
  const stores = await systemDb.store.findMany({ where: { status: { in: ["active", "error"] } } });
  const configured = new Set((await systemDb.inventorySettings.findMany({ select: { storeId: true } })).map((s) => s.storeId));
  const result = { checksStarted: 0, snapshots: 0, announced: 0 };
  for (const store of stores) {
    try {
      const levels = hasCapabilityScopes(store.grantedScopes, "stock_levels");
      if (!levels && !configured.has(store.id)) continue;
      if (levels) {
        const settings = await inventorySettings(store.id);
        const last = await systemDb.inventorySyncRun.findFirst({ where: { storeId: store.id }, orderBy: { startedAt: "desc" } });
        const due = !last || now.getTime() - last.startedAt.getTime() >= settings.reconcileHours * 3600_000;
        if (due && (await startInventoryPass(deps, store, last ? "reconcile" : "import"))) result.checksStarted++;
      }
      if (await deps.coord.acquire(`inventory-hourly:${store.id}`, HOURLY_LEASE_MS)) {
        if (levels && (await takeSnapshot(store, now))) result.snapshots++;
        await evaluateStockAlerts(store);
        await evaluateFastMovement(store, now);
      }
      result.announced += await notifyStockAlerts(deps, store, now);
    } catch (err) {
      logger.error({ err, storeId: store.id }, "inventory sweep failed for a store; the next tick tries again");
    }
  }
  return result;
}

/** How long a pass's record and the stock history are kept. */
const RUNS_KEEP_MS = 90 * 86_400_000;
const MOVEMENTS_KEEP_MS = 2 * 365 * 86_400_000;

/** Old pass records and stock history, a bounded batch per tick. */
export async function pruneInventory(batch = 20_000) {
  const runs = await systemDb.inventorySyncRun.deleteMany({ where: { startedAt: { lt: new Date(Date.now() - RUNS_KEEP_MS) }, status: { not: "running" } } });
  const cutoff = new Date(Date.now() - MOVEMENTS_KEEP_MS);
  const movements = await systemDb.$executeRaw`
    DELETE FROM inventory_movements WHERE ctid IN (SELECT ctid FROM inventory_movements WHERE observed_at < ${cutoff} LIMIT ${batch})`;
  return { runs: runs.count, movements };
}

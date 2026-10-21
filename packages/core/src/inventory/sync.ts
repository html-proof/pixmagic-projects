/**
 * Keeping the stored stock in step with Shopify: full passes over every location's levels (the
 * import once the scopes are granted, a manual refresh, and the scheduled check against Shopify,
 * which counts what differed), and the webhooks in between (a level read again the moment Shopify
 * says it changed). The worker runs the passes page by page (apps/worker, runInventorySync).
 */
import { Prisma, systemDb, type Store } from "@app/db";
import type { InventoryTrigger, Queues } from "../queues.js";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { graphqlItemLevelSchema, graphqlLocationSchema, parseShopify, restInventoryItemSchema, restInventoryLevelSchema, restLocationSchema } from "../shopifyPayloads.js";
import { expandScopes } from "@app/shared";
import { hasCapabilityScopes } from "./access.js";
import { evaluateStockAlerts } from "./alerts.js";
import { applyLevels, hasFinishedPass, levelFromItem, removeLevel, removeLocation, updateVariantTotals, upsertLocations, type LevelDifference } from "./levels.js";
import { INVENTORY_LOCATION_QUERY, INVENTORY_WEBHOOK_TOPICS, ITEM_LEVEL_QUERY, itemGid, LEVEL_NAMES, locationGid, WEBHOOK_SUBSCRIPTIONS_QUERY, WEBHOOK_SUBSCRIPTION_CREATE } from "./queries.js";
import type { InventoryGql } from "./shopify.js";
import { takeSnapshot } from "./stock.js";

/** A pass still queued or running after this long, and quiet for PASS_QUIET_MS, is taken for dead: a new one may start. */
const PASS_STALE_MS = 3 * 3600_000;
/** How long a pass's pages may fall silent (the pace, retry backoff) and it still counts as under way. */
const PASS_QUIET_MS = 30 * 60_000;
/** Differences kept as examples on a pass's record. */
const SAMPLE_SIZE = 20;

/**
 * The store's inventory jobs that are under way: queued or running, and alive (queued lately, or a
 * page read lately). A job whose message was lost stays queued until the stale-job sweep fails it
 * hours later; it neither holds up the next pass nor shows as "Refreshing" in the meantime.
 */
export function livePassWhere(now = new Date()): Prisma.SyncJobWhereInput {
  return {
    kind: "inventory",
    status: { in: ["queued", "running"] },
    OR: [{ createdAt: { gt: new Date(now.getTime() - PASS_STALE_MS) } }, { lastActivityAt: { gt: new Date(now.getTime() - PASS_QUIET_MS) } }],
  };
}

/**
 * Start a full pass for the store, unless it can't read stock levels or one is already under way.
 * Returns the job's and the pass's ids, or null.
 */
export async function startInventoryPass(
  deps: { queues: Pick<Queues, "sync"> },
  store: Pick<Store, "id" | "workspaceId" | "grantedScopes" | "status">,
  trigger: InventoryTrigger,
  opts: { delaySeconds?: number } = {},
): Promise<{ syncJobId: string; runId: string } | null> {
  if (store.status === "uninstalled" || !hasCapabilityScopes(store.grantedScopes, "stock_levels")) return null;
  const busy = await systemDb.syncJob.findFirst({ where: { storeId: store.id, ...livePassWhere() } });
  if (busy) return null;
  const startedAt = new Date();
  const job = await systemDb.syncJob.create({ data: { workspaceId: store.workspaceId, storeId: store.id, kind: "inventory" } });
  const run = await systemDb.inventorySyncRun.create({ data: { workspaceId: store.workspaceId, storeId: store.id, trigger, status: "running", startedAt } });
  await deps.queues.sync.send(
    { storeId: store.id, kind: "inventory", syncJobId: job.id, inventory: { trigger, runId: run.id, phase: "locations", startedAt: startedAt.toISOString() } },
    opts.delaySeconds ? { delaySeconds: opts.delaySeconds } : undefined,
  );
  return { syncJobId: job.id, runId: run.id };
}

/** Count a page of a pass on its record: levels read, and the ones that differed (with a few examples). */
export async function recordPassPage(runId: string, levels: number, differences: readonly LevelDifference[]) {
  const run = await systemDb.inventorySyncRun.findUnique({ where: { id: runId }, select: { sample: true } });
  if (!run) return;
  const sample = Array.isArray(run.sample) ? (run.sample as unknown[]) : [];
  const more = differences.slice(0, Math.max(0, SAMPLE_SIZE - sample.length)).map((d) => ({ inventoryItemId: d.inventoryItemId, locationId: d.locationId, name: d.name, ours: d.ours, shopify: d.shopify }));
  await systemDb.inventorySyncRun.update({
    where: { id: runId },
    data: {
      levelsChecked: { increment: levels },
      differences: { increment: new Set(differences.map((d) => `${d.inventoryItemId}|${d.locationId}`)).size },
      ...(more.length ? { sample: [...sample, ...more] as Prisma.InputJsonValue } : {}),
    },
  });
}

/** Every location read: from now on the pass reads `locations` levels. */
export async function recordPassLocations(runId: string, locations: number) {
  await systemDb.inventorySyncRun.update({ where: { id: runId }, data: { locations } });
}

/**
 * The end of a full pass: every variant's total from its levels, today's snapshot, the stock
 * alerts for every variant, and the pass recorded as done.
 */
export async function finishInventoryPass(store: Pick<Store, "id" | "workspaceId" | "grantedScopes" | "timezone">, runId: string | undefined) {
  if (runId) await systemDb.inventorySyncRun.update({ where: { id: runId }, data: { status: "succeeded", finishedAt: new Date() } });
  await updateVariantTotals(systemDb, store.id);
  await takeSnapshot(store);
  await evaluateStockAlerts(store);
  const run = runId ? await systemDb.inventorySyncRun.findUnique({ where: { id: runId } }) : null;
  if (run?.differences) logger.info({ storeId: store.id, runId, trigger: run.trigger, levels: run.levelsChecked, differences: run.differences }, "inventory pass found levels that differed from Shopify; corrected");
}

/** A pass that gave up: its record says so (the job's own failure handling raises the alert). */
export async function failInventoryPass(runId: string | undefined, error: string) {
  if (!runId) return;
  await systemDb.inventorySyncRun.updateMany({ where: { id: runId, status: "running" }, data: { status: "failed", error: error.slice(0, 500), finishedAt: new Date() } });
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

/** The variants whose stock is `inventoryItemId`'s. */
async function variantsOfItem(storeId: string, inventoryItemId: string): Promise<string[]> {
  const rows = await systemDb.productVariant.findMany({ where: { storeId, inventoryItemId }, select: { shopifyId: true } });
  return rows.map((r) => r.shopifyId);
}

/**
 * inventory_levels/update and /connect: read the level again (the payload carries only
 * `available`, and may be older than what Shopify holds now) and store it if it is newer.
 */
export async function onLevelWebhook(store: Store, gql: InventoryGql, payload: unknown, context: Record<string, unknown>): Promise<boolean> {
  const p = parseShopify(restInventoryLevelSchema, payload, "inventory level webhook", context);
  if (!p) return false;
  // A delivery after the merchant gave the access back: nothing can be read (the next grant re-reads everything).
  if (!hasCapabilityScopes(store.grantedScopes, "stock_levels")) return false;
  const item = String(p.inventory_item_id);
  const location = String(p.location_id);
  const d = await gql<{ inventoryItem: unknown }>(ITEM_LEVEL_QUERY, { item: itemGid(item), location: locationGid(location), names: LEVEL_NAMES });
  const node = d.inventoryItem ? parseShopify(graphqlItemLevelSchema, d.inventoryItem, "GraphQL inventory level", context) : null;
  const totals = await hasFinishedPass(store.id);
  const read = node ? levelFromItem(location, node) : null;
  if (read) await applyLevels(store, [read], "webhook", { updateTotals: totals });
  else await removeLevel(store, item, location, { updateTotals: totals });
  await evaluateStockAlerts(store, { variants: await variantsOfItem(store.id, item) });
  return true;
}

/** inventory_levels/disconnect: the item is no longer stocked at the location. */
export async function onLevelDisconnect(store: Store, payload: unknown, context: Record<string, unknown>): Promise<boolean> {
  const p = parseShopify(restInventoryLevelSchema, payload, "inventory level webhook", context);
  if (!p) return false;
  const item = String(p.inventory_item_id);
  await removeLevel(store, item, String(p.location_id), { updateTotals: await hasFinishedPass(store.id) });
  await evaluateStockAlerts(store, { variants: await variantsOfItem(store.id, item) });
  return true;
}

/**
 * inventory_items/update: cost, tracking, SKU and shipping, on the variant that owns the item.
 * Turning tracking off makes the variant "not tracked" (its total null); turning it on gives it
 * its levels' total.
 */
export async function onInventoryItemWebhook(store: Store, payload: unknown, context: Record<string, unknown>): Promise<boolean> {
  const p = parseShopify(restInventoryItemSchema, payload, "inventory item webhook", context);
  if (!p) return false;
  const item = String(p.id);
  const data: Prisma.ProductVariantUpdateManyMutationInput = {};
  if (p.cost !== undefined) data.unitCost = p.cost === null || p.cost === "" ? null : Number(p.cost);
  if (p.requires_shipping !== undefined && p.requires_shipping !== null) data.requiresShipping = p.requires_shipping;
  if (p.sku !== undefined) data.sku = p.sku || null;
  if (p.tracked === false) data.inventoryQuantity = null;
  if (Object.keys(data).length) await systemDb.productVariant.updateMany({ where: { storeId: store.id, inventoryItemId: item }, data });
  if (p.tracked === true) {
    const [sum] = await systemDb.$queryRaw<Array<{ total: number | null }>>`
      SELECT SUM(available)::int AS total FROM inventory_levels WHERE store_id = ${store.id} AND inventory_item_id = ${item}`;
    await systemDb.productVariant.updateMany({ where: { storeId: store.id, inventoryItemId: item, inventoryQuantity: null }, data: { inventoryQuantity: sum?.total ?? 0 } });
  }
  await evaluateStockAlerts(store, { variants: await variantsOfItem(store.id, item) });
  return true;
}

/** locations/*: the location read again (or, deleted, kept as deleted with its stock gone). */
export async function onLocationWebhook(store: Store, gql: InventoryGql, topic: string, payload: unknown, context: Record<string, unknown>): Promise<boolean> {
  const p = parseShopify(restLocationSchema, payload, topic, context);
  if (!p) return false;
  if (!hasCapabilityScopes(store.grantedScopes, "stock_levels")) return false;
  const id = String(p.id);
  if (topic === "locations/delete") {
    await removeLocation(store, id);
    await evaluateStockAlerts(store);
    return true;
  }
  const d = await gql<{ location: unknown }>(INVENTORY_LOCATION_QUERY, { id: locationGid(id) });
  const node = d.location ? parseShopify(graphqlLocationSchema, d.location, "GraphQL location", context) : null;
  if (!node) {
    await removeLocation(store, id);
  } else {
    await upsertLocations(store, [node]);
  }
  if (topic === "locations/deactivate" || topic === "locations/activate") await evaluateStockAlerts(store);
  return true;
}

/**
 * Subscribe the store to the inventory topics it holds the scopes for, once (Shopify keeps
 * shop-specific subscriptions until the app is uninstalled or the scope is given back). Returns the
 * number created. Delivered to the same address, and signed with the same secret, as the toml's.
 */
export async function ensureInventoryWebhooks(store: Pick<Store, "id" | "grantedScopes">, gql: InventoryGql): Promise<number> {
  const scopes = expandScopes(store.grantedScopes);
  const wanted = INVENTORY_WEBHOOK_TOPICS.filter((t) => scopes.has(t.scope));
  if (!wanted.length) return 0;
  const uri = `${env().API_URL}/webhooks/shopify`;
  const have = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < 10; page++) {
    const d: { webhookSubscriptions: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Array<{ topic: string; uri?: string | null }> } } = await gql(
      WEBHOOK_SUBSCRIPTIONS_QUERY,
      { cursor },
    );
    for (const n of d.webhookSubscriptions.nodes) if (!n.uri || n.uri === uri) have.add(n.topic);
    if (!d.webhookSubscriptions.pageInfo.hasNextPage || !d.webhookSubscriptions.pageInfo.endCursor) break;
    cursor = d.webhookSubscriptions.pageInfo.endCursor;
  }
  let created = 0;
  for (const t of wanted) {
    if (have.has(t.topic)) continue;
    const r = await gql<{ webhookSubscriptionCreate: { webhookSubscription: { id: string } | null; userErrors: Array<{ message: string }> } }>(WEBHOOK_SUBSCRIPTION_CREATE, {
      topic: t.topic,
      sub: { uri },
    });
    const errs = r.webhookSubscriptionCreate.userErrors;
    // "Address for this topic has already been taken": subscribed already (by another path).
    if (errs.length && !errs.every((e) => /already been taken/i.test(e.message))) {
      logger.warn({ storeId: store.id, topic: t.topic, errors: errs.map((e) => e.message) }, "inventory webhook subscription refused");
      continue;
    }
    created++;
  }
  if (created) logger.info({ storeId: store.id, created }, "inventory webhooks subscribed");
  return created;
}


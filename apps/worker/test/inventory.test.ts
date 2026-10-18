import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectDb, systemDb } from "@app/db";
import { resetDb } from "@app/db/testing";
import {
  encryptTokenFields,
  evaluateStockAlerts,
  memoryBlobs,
  memoryCoord,
  memoryMailer,
  memoryQueues,
  notifyStockAlerts,
  startInventoryPass,
  STOCK_ALERT_CODE,
  takeSnapshot,
  type FetchLike,
  type SyncJobData,
} from "@app/core";
import { localDay } from "@app/shared";
import { processWebhook, runSync, sweepInventory, type WorkerDeps } from "../src/handlers.js";
import { consume, type QueueMessage } from "../src/index.js";

/**
 * The Inventory module's sync against a fake Shopify that holds locations and per-location levels
 * (every quantity state), answers the inventory queries the way the Admin API does (pages, one
 * item's level, webhook subscriptions) and counts what it was asked.
 */
const queues = memoryQueues();
const coord = memoryCoord();
const payloads = memoryBlobs();
const mailer = memoryMailer();
let fetchImpl: FetchLike;
let deps: WorkerDeps;

const INVENTORY_SCOPES = ["read_orders", "read_products", "read_inventory", "read_locations"];

interface FakeLevel {
  available: number;
  on_hand?: number;
  committed?: number;
  incoming?: number;
  reserved?: number;
  damaged?: number;
  safety_stock?: number;
  quality_control?: number;
  updatedAt: string;
}

interface FakeShop {
  locations: Array<{ id: string; name: string; isActive?: boolean; city?: string }>;
  /** `${item}|${location}` → level. */
  levels: Map<string, FakeLevel>;
  subscriptions: Array<{ topic: string; uri: string }>;
  asked: string[];
  costExceededOnce?: boolean;
  status?: number;
}

let shop: FakeShop;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const id = (gid: string) => gid.split("/").pop()!;
const quantities = (l: FakeLevel, names: string[]) =>
  names.map((name) => {
    const onHand = l.on_hand ?? l.available + (l.committed ?? 0) + (l.reserved ?? 0) + (l.damaged ?? 0) + (l.safety_stock ?? 0) + (l.quality_control ?? 0);
    const v: Record<string, number> = { available: l.available, on_hand: onHand, committed: l.committed ?? 0, incoming: l.incoming ?? 0, reserved: l.reserved ?? 0, damaged: l.damaged ?? 0, safety_stock: l.safety_stock ?? 0, quality_control: l.quality_control ?? 0 };
    return { name, quantity: v[name] ?? 0 };
  });
const locationNode = (l: FakeShop["locations"][number]) => ({
  id: `gid://shopify/Location/${l.id}`,
  name: l.name,
  isActive: l.isActive ?? true,
  fulfillsOnlineOrders: true,
  isFulfillmentService: false,
  address: { address1: "1 Main St", address2: null, city: l.city ?? "Melbourne", province: "VIC", zip: "3000", country: "Australia", countryCode: "AU", formatted: ["1 Main St", `${l.city ?? "Melbourne"} VIC 3000`, "Australia"] },
});

function fakeShopify(): FetchLike {
  return async (_url, init) => {
    if (shop.status && shop.status !== 200) return json({ errors: "[API] Invalid API key or access token" }, shop.status);
    const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
    const op = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "?";
    shop.asked.push(op);
    switch (op) {
      case "WebhookSubscriptions":
        return json({ data: { webhookSubscriptions: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: shop.subscriptions.map((s, i) => ({ id: `gid://shopify/WebhookSubscription/${i}`, ...s })) } } });
      case "WebhookSubscriptionCreate":
        shop.subscriptions.push({ topic: variables.topic, uri: variables.sub.uri });
        return json({ data: { webhookSubscriptionCreate: { webhookSubscription: { id: "gid://shopify/WebhookSubscription/x", topic: variables.topic }, userErrors: [] } } });
      case "InventoryLocations":
        return json({ data: { locations: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: shop.locations.map(locationNode) } } });
      case "InventoryLocation": {
        const l = shop.locations.find((x) => x.id === id(variables.id));
        return json({ data: { location: l ? locationNode(l) : null } });
      }
      case "LocationLevels": {
        if (shop.costExceededOnce) {
          shop.costExceededOnce = false;
          return json({ errors: [{ message: "Query cost is 2003, which exceeds the single query max cost limit (1000).", extensions: { code: "MAX_COST_EXCEEDED" } }] });
        }
        const loc = id(variables.id);
        if (!shop.locations.some((l) => l.id === loc)) return json({ data: { location: null } });
        const all = [...shop.levels.entries()].filter(([k]) => k.endsWith(`|${loc}`)).sort(([a], [b]) => a.localeCompare(b));
        const start = variables.cursor ? Number(variables.cursor) : 0;
        const page = all.slice(start, start + variables.first);
        const next = start + variables.first < all.length;
        return json({
          data: {
            location: {
              id: variables.id,
              inventoryLevels: {
                pageInfo: { hasNextPage: next, endCursor: next ? String(start + variables.first) : null },
                nodes: page.map(([k, l]) => ({ updatedAt: l.updatedAt, item: { id: `gid://shopify/InventoryItem/${k.split("|")[0]}` }, quantities: quantities(l, variables.names) })),
              },
            },
          },
        });
      }
      case "InventoryItemLevel": {
        const l = shop.levels.get(`${id(variables.item)}|${id(variables.location)}`);
        return json({ data: { inventoryItem: { id: variables.item, tracked: true, inventoryLevel: l ? { updatedAt: l.updatedAt, quantities: quantities(l, variables.names) } : null } } });
      }
      default:
        throw new Error(`unexpected Shopify call ${op}`);
    }
  };
}

beforeAll(() => {
  deps = { coord, queues, payloads, mailer, fetchImpl: ((...a: Parameters<FetchLike>) => fetchImpl(...a)) as FetchLike };
});
afterAll(async () => {
  await disconnectDb();
});
beforeEach(async () => {
  await resetDb();
  queues.clear();
  coord.clear();
  mailer.sent.length = 0;
  shop = { locations: [], levels: new Map(), subscriptions: [], asked: [] };
  fetchImpl = fakeShopify();
});

async function makeStore(scopes = INVENTORY_SCOPES, shopDomain = "s.myshopify.com", wsName = "W") {
  const ws = await systemDb.workspace.create({ data: { name: wsName } });
  const store = await systemDb.store.create({ data: { workspaceId: ws.id, shopDomain, grantedScopes: scopes, status: "active", timezone: "Australia/Melbourne", currency: "AUD" } });
  await systemDb.store.update({ where: { id: store.id }, data: encryptTokenFields(store.id, { accessToken: "shpat_x", scopes, accessTokenExpiresAt: null, refreshToken: null, refreshTokenExpiresAt: null }) });
  return systemDb.store.findUniqueOrThrow({ where: { id: store.id } });
}

/** A product with variants, each with its inventory item (`item` = 900 + variant). */
async function catalog(store: { id: string; workspaceId: string }, product: string, variants: Array<{ id: string; tracked?: boolean; price?: number; cost?: number | null; threshold?: number }>, status = "active") {
  await systemDb.product.create({ data: { workspaceId: store.workspaceId, storeId: store.id, shopifyId: product, title: `Product ${product}`, status, vendor: "Acme", productType: "Shirts", shopifyUpdatedAt: new Date("2026-01-01T00:00:00Z"), collections: [{ id: "77", title: "Summer" }] } });
  for (const v of variants) {
    await systemDb.productVariant.create({
      data: {
        workspaceId: store.workspaceId,
        storeId: store.id,
        productShopifyId: product,
        shopifyId: v.id,
        title: `V${v.id}`,
        sku: `SKU-${v.id}`,
        price: v.price ?? 20,
        unitCost: v.cost === undefined ? 8 : v.cost,
        inventoryQuantity: v.tracked === false ? null : 0,
        inventoryItemId: String(900 + Number(v.id)),
        lowStockThreshold: v.threshold ?? null,
        shopifyUpdatedAt: new Date("2026-01-01T00:00:00Z"),
      },
    });
  }
}

const item = (variant: string) => String(900 + Number(variant));

/** Run every queued inventory message (and the ones they queue) to the end. */
async function drain(limit = 200) {
  for (let i = 0; i < limit; i++) {
    const msg = queues.sent.sync.shift();
    queues.sentOpts.sync.shift();
    if (!msg) return;
    await runSync(msg as SyncJobData, deps);
  }
  throw new Error("inventory pass didn't finish");
}

async function fullPass(store: Awaited<ReturnType<typeof makeStore>>, trigger: "import" | "manual" | "reconcile" = "import") {
  const started = await startInventoryPass(deps, store, trigger);
  expect(started).not.toBeNull();
  await drain();
  return systemDb.inventorySyncRun.findUniqueOrThrow({ where: { id: started!.runId } });
}

let webhookSeq = 0;
async function webhook(topic: string, payload: unknown) {
  const ev = await systemDb.webhookEvent.create({ data: { webhookId: `inv-${++webhookSeq}`, topic, shopDomain: "s.myshopify.com" } });
  await processWebhook({ eventId: ev.id, topic, shop: "s.myshopify.com", payload }, deps);
  return ev;
}

const level = (store: { id: string }, variant: string, location: string) =>
  systemDb.inventoryLevel.findUnique({ where: { storeId_inventoryItemId_locationShopifyId: { storeId: store.id, inventoryItemId: item(variant), locationShopifyId: location } } });

describe("inventory pass", () => {
  it("stores every location and every quantity state per item and location, exactly as Shopify reports them", async () => {
    const store = await makeStore();
    await catalog(store, "1", [{ id: "11" }, { id: "12" }]); // a product with two variants
    await catalog(store, "2", [{ id: "21" }]); // a single-variant product
    await catalog(store, "3", [{ id: "31", tracked: false }]); // stock not tracked
    shop.locations = [{ id: "100", name: "Warehouse" }, { id: "200", name: "Shop", city: "Sydney" }];
    const t = "2026-10-19T01:00:00Z";
    shop.levels.set(`${item("11")}|100`, { available: 50, committed: 3, incoming: 10, damaged: 2, updatedAt: t });
    shop.levels.set(`${item("11")}|200`, { available: 7, updatedAt: t });
    shop.levels.set(`${item("12")}|100`, { available: 0, committed: 1, updatedAt: t }); // zero available, one committed
    shop.levels.set(`${item("21")}|100`, { available: 4, reserved: 1, safety_stock: 2, quality_control: 1, updatedAt: t });
    shop.levels.set(`${item("31")}|100`, { available: 99, updatedAt: t });

    const run = await fullPass(store);
    expect(run).toMatchObject({ status: "succeeded", trigger: "import", locations: 2, levelsChecked: 5, differences: 0 });

    // Shopify says 50 available at the warehouse: so do we, and every other state as Shopify has it.
    expect(await level(store, "11", "100")).toMatchObject({ available: 50, onHand: 55, committed: 3, incoming: 10, damaged: 2, reserved: 0 });
    expect(await level(store, "11", "200")).toMatchObject({ available: 7, onHand: 7 });
    expect(await level(store, "21", "100")).toMatchObject({ available: 4, onHand: 8, reserved: 1, safetyStock: 2, qualityControl: 1 });
    // Each variant's total is the sum over its locations (Shopify's ProductVariant.inventoryQuantity).
    const v11 = await systemDb.productVariant.findUniqueOrThrow({ where: { storeId_shopifyId: { storeId: store.id, shopifyId: "11" } } });
    expect(v11.inventoryQuantity).toBe(57);
    // Untracked stays untracked: no total, and its level isn't counted anywhere.
    expect((await systemDb.productVariant.findUniqueOrThrow({ where: { storeId_shopifyId: { storeId: store.id, shopifyId: "31" } } })).inventoryQuantity).toBeNull();

    const locations = await systemDb.inventoryLocation.findMany({ where: { storeId: store.id }, orderBy: { shopifyId: "asc" } });
    expect(locations.map((l) => [l.shopifyId, l.name, l.isActive, l.formattedAddress])).toEqual([
      ["100", "Warehouse", true, "1 Main St, Melbourne VIC 3000, Australia"],
      ["200", "Shop", true, "1 Main St, Sydney VIC 3000, Australia"],
    ]);

    // The day's snapshot: storewide totals count each item at each location once, tracked only.
    const today = localDay(new Date(), store.timezone);
    const all = await systemDb.inventorySnapshot.findUniqueOrThrow({ where: { storeId_day_locationKey: { storeId: store.id, day: today, locationKey: "all" } } });
    expect(all).toMatchObject({ trackedVariants: 3, untrackedVariants: 1, available: 61, onHand: 71, committed: 4, incoming: 10, outOfStock: 1, lowStock: 1 });
    // On hand × cost (8) for the three tracked variants: (55 + 7) + 1 + 8 = 71 units → 568.
    expect(Number(all.costValue)).toBe(568);
    const shopSnap = await systemDb.inventorySnapshot.findUniqueOrThrow({ where: { storeId_day_locationKey: { storeId: store.id, day: today, locationKey: "200" } } });
    expect(shopSnap).toMatchObject({ available: 7, onHand: 7 });

    // Alerts: 12 is out (0 available anywhere), 21 is low (4 ≤ 10); 11 has 57, fine.
    const alerts = await systemDb.inventoryAlert.findMany({ where: { storeId: store.id, resolvedAt: null }, orderBy: { variantShopifyId: "asc" } });
    expect(alerts.map((a) => [a.variantShopifyId, a.kind, a.available])).toEqual([
      ["12", "out_of_stock", 0],
      ["21", "low_stock", 4],
    ]);

    // The stock and location webhooks are subscribed once, to the API's address.
    expect(shop.subscriptions.map((s) => s.topic).sort()).toEqual(
      ["INVENTORY_ITEMS_UPDATE", "INVENTORY_LEVELS_CONNECT", "INVENTORY_LEVELS_DISCONNECT", "INVENTORY_LEVELS_UPDATE", "LOCATIONS_ACTIVATE", "LOCATIONS_CREATE", "LOCATIONS_DEACTIVATE", "LOCATIONS_DELETE", "LOCATIONS_UPDATE"].sort(),
    );
    expect(new Set(shop.subscriptions.map((s) => s.uri))).toEqual(new Set(["http://localhost:4000/webhooks/shopify"]));
    // A second pass subscribes nothing again.
    await fullPass(store, "manual");
    expect(shop.subscriptions).toHaveLength(9);
  });

  it("pages through a location's levels and halves the page when Shopify says the query costs too much", async () => {
    const store = await makeStore();
    const variants = Array.from({ length: 5 }, (_, i) => ({ id: String(40 + i) }));
    await catalog(store, "4", variants);
    shop.locations = [{ id: "100", name: "Warehouse" }];
    for (const v of variants) shop.levels.set(`${item(v.id)}|100`, { available: 20, updatedAt: "2026-10-19T01:00:00Z" });
    shop.costExceededOnce = true;
    const started = await startInventoryPass(deps, store, "import");
    // The first level page is refused as too expensive: the same page comes back at half the size.
    let halved: SyncJobData | undefined;
    for (let i = 0; i < 50 && queues.sent.sync.length; i++) {
      const msg = queues.sent.sync.shift()!;
      queues.sentOpts.sync.shift();
      if (msg.pageSize && !halved) halved = msg;
      await runSync(msg, deps);
    }
    expect(halved?.pageSize).toBe(100);
    const run = await systemDb.inventorySyncRun.findUniqueOrThrow({ where: { id: started!.runId } });
    expect(run).toMatchObject({ status: "succeeded", levelsChecked: 5 });
    expect(await systemDb.inventoryLevel.count({ where: { storeId: store.id } })).toBe(5);
  });

  it("the scheduled check counts and corrects what differs from Shopify, and drops what Shopify no longer lists", async () => {
    const store = await makeStore();
    await catalog(store, "1", [{ id: "11" }, { id: "12" }]);
    shop.locations = [{ id: "100", name: "Warehouse" }, { id: "200", name: "Shop" }];
    shop.levels.set(`${item("11")}|100`, { available: 50, updatedAt: "2026-10-19T01:00:00Z" });
    shop.levels.set(`${item("12")}|100`, { available: 5, updatedAt: "2026-10-19T01:00:00Z" });
    shop.levels.set(`${item("12")}|200`, { available: 3, updatedAt: "2026-10-19T01:00:00Z" });
    await fullPass(store);

    // In Shopify, without any webhook reaching us: a sale, an item moved off a location, a location closed.
    shop.levels.set(`${item("11")}|100`, { available: 48, committed: 2, updatedAt: "2026-10-19T02:00:00Z" });
    shop.levels.delete(`${item("12")}|100`);
    shop.locations = [{ id: "100", name: "Warehouse" }];
    shop.levels.delete(`${item("12")}|200`);

    const run = await fullPass(store, "reconcile");
    expect(run).toMatchObject({ status: "succeeded", trigger: "reconcile", levelsChecked: 1, differences: 1 });
    expect(run.sample).toEqual(expect.arrayContaining([expect.objectContaining({ inventoryItemId: item("11"), locationId: "100", name: "available", ours: 50, shopify: 48 })]));
    expect(await level(store, "11", "100")).toMatchObject({ available: 48, committed: 2 });
    expect(await level(store, "12", "100")).toBeNull();
    expect(await level(store, "12", "200")).toBeNull();
    // The closed location is kept (history names it), marked deleted.
    expect((await systemDb.inventoryLocation.findUniqueOrThrow({ where: { storeId_shopifyId: { storeId: store.id, shopifyId: "200" } } })).deletedAt).not.toBeNull();
    // The difference is in the stock history as found by the check.
    const moves = await systemDb.inventoryMovement.findMany({ where: { storeId: store.id }, orderBy: { quantityName: "asc" } });
    expect(moves.map((m) => [m.quantityName, m.before, m.after, m.delta, m.source, m.productTitle, m.locationName])).toEqual([
      ["available", 50, 48, -2, "reconcile", "Product 1", "Warehouse"],
      ["committed", 0, 2, 2, "reconcile", "Product 1", "Warehouse"],
    ]);
    // 12 has none left anywhere now.
    expect((await systemDb.productVariant.findUniqueOrThrow({ where: { storeId_shopifyId: { storeId: store.id, shopifyId: "12" } } })).inventoryQuantity).toBe(0);
  });

  it("is skipped for a store that hasn't granted stock-level access", async () => {
    const store = await makeStore(["read_orders", "read_products"]);
    expect(await startInventoryPass(deps, store, "import")).toBeNull();
    // A job queued anyway (a grant of only read_inventory): done without asking Shopify anything.
    const job = await systemDb.syncJob.create({ data: { workspaceId: store.workspaceId, storeId: store.id, kind: "inventory" } });
    await runSync({ storeId: store.id, kind: "inventory", syncJobId: job.id }, deps);
    expect(shop.asked).toEqual([]);
    expect((await systemDb.syncJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("succeeded");
  });

  it("a store Shopify no longer accepts fails the pass at once, without flagging the store's import", async () => {
    const store = await makeStore();
    await catalog(store, "1", [{ id: "11" }]);
    shop.locations = [{ id: "100", name: "Warehouse" }];
    const started = await startInventoryPass(deps, store, "reconcile");
    shop.status = 401;
    const msg = queues.sent.sync.shift()!;
    queues.sentOpts.sync.shift();
    let acked = false;
    const qm: QueueMessage = { id: "m1", body: msg, attempts: 1, ack: () => (acked = true), retry: () => {} };
    await consume("sync", qm, { ...deps, dbHealthy: async () => true });
    expect(acked).toBe(true);
    expect((await systemDb.syncJob.findUniqueOrThrow({ where: { id: started!.syncJobId } })).status).toBe("failed");
    expect((await systemDb.inventorySyncRun.findUniqueOrThrow({ where: { id: started!.runId } })).status).toBe("failed");
    expect(await systemDb.alert.count({ where: { storeId: store.id, code: "sync_inventory_failed" } })).toBe(1);
  });

  it("never mixes two stores' stock, even with the same Shopify ids", async () => {
    const a = await makeStore(INVENTORY_SCOPES, "s.myshopify.com", "A");
    const b = await makeStore(INVENTORY_SCOPES, "t.myshopify.com", "B");
    await catalog(a, "1", [{ id: "11" }]);
    await catalog(b, "1", [{ id: "11" }]);
    shop.locations = [{ id: "100", name: "Warehouse" }];
    shop.levels.set(`${item("11")}|100`, { available: 5, updatedAt: "2026-10-19T01:00:00Z" });
    await fullPass(a);
    expect(await level(a, "11", "100")).toMatchObject({ available: 5 });
    expect(await level(b, "11", "100")).toBeNull();
    expect((await systemDb.productVariant.findUniqueOrThrow({ where: { storeId_shopifyId: { storeId: b.id, shopifyId: "11" } } })).inventoryQuantity).toBe(0);
  });
});

describe("inventory webhooks", () => {
  async function imported() {
    const store = await makeStore();
    await catalog(store, "1", [{ id: "11" }]);
    shop.locations = [{ id: "100", name: "Warehouse" }, { id: "200", name: "Shop" }];
    shop.levels.set(`${item("11")}|100`, { available: 30, updatedAt: "2026-10-19T01:00:00Z" });
    await fullPass(store);
    return store;
  }

  it("inventory_levels/update reads the level again and records the change once, however often it arrives", async () => {
    const store = await imported();
    shop.levels.set(`${item("11")}|100`, { available: 29, committed: 1, updatedAt: "2026-10-19T03:00:00Z" });
    const payload = { inventory_item_id: Number(item("11")), location_id: 100, available: 29, updated_at: "2026-10-19T03:00:00Z" };
    const ev = await webhook("inventory_levels/update", payload);
    expect(await level(store, "11", "100")).toMatchObject({ available: 29, committed: 1 });
    // The same delivery again (Shopify retries): already processed, nothing recorded twice.
    await processWebhook({ eventId: ev.id, topic: "inventory_levels/update", shop: "s.myshopify.com", payload }, deps);
    // A second delivery of the same change: the level is read again and found unchanged.
    await webhook("inventory_levels/update", payload);
    const moves = await systemDb.inventoryMovement.findMany({ where: { storeId: store.id, source: "webhook" } });
    expect(moves.map((m) => [m.quantityName, m.before, m.after])).toEqual(expect.arrayContaining([["available", 30, 29], ["committed", 0, 1]]));
    expect(moves).toHaveLength(2);
    expect((await systemDb.productVariant.findUniqueOrThrow({ where: { storeId_shopifyId: { storeId: store.id, shopifyId: "11" } } })).inventoryQuantity).toBe(29);
  });

  it("an older read never overwrites a newer one (webhooks out of order)", async () => {
    const store = await imported();
    // Stored: a newer state than the one Shopify will answer with (a late re-read racing a newer write).
    await systemDb.inventoryLevel.update({
      where: { storeId_inventoryItemId_locationShopifyId: { storeId: store.id, inventoryItemId: item("11"), locationShopifyId: "100" } },
      data: { available: 10, shopifyUpdatedAt: new Date("2026-10-19T05:00:00Z") },
    });
    shop.levels.set(`${item("11")}|100`, { available: 25, updatedAt: "2026-10-19T04:00:00Z" });
    await webhook("inventory_levels/update", { inventory_item_id: Number(item("11")), location_id: 100, available: 25 });
    expect(await level(store, "11", "100")).toMatchObject({ available: 10 });
  });

  it("connect stocks the item at a new location; disconnect removes it", async () => {
    const store = await imported();
    shop.levels.set(`${item("11")}|200`, { available: 6, updatedAt: "2026-10-19T03:00:00Z" });
    await webhook("inventory_levels/connect", { inventory_item_id: Number(item("11")), location_id: 200, available: 6 });
    expect(await level(store, "11", "200")).toMatchObject({ available: 6 });
    expect((await systemDb.productVariant.findUniqueOrThrow({ where: { storeId_shopifyId: { storeId: store.id, shopifyId: "11" } } })).inventoryQuantity).toBe(36);
    await webhook("inventory_levels/disconnect", { inventory_item_id: Number(item("11")), location_id: 200 });
    expect(await level(store, "11", "200")).toBeNull();
    expect((await systemDb.productVariant.findUniqueOrThrow({ where: { storeId_shopifyId: { storeId: store.id, shopifyId: "11" } } })).inventoryQuantity).toBe(30);
  });

  it("inventory_items/update: cost and tracking change on the variant", async () => {
    const store = await imported();
    await webhook("inventory_items/update", { id: Number(item("11")), sku: "NEW-SKU", cost: "9.25", tracked: false, requires_shipping: true });
    const v = await systemDb.productVariant.findUniqueOrThrow({ where: { storeId_shopifyId: { storeId: store.id, shopifyId: "11" } } });
    expect(v).toMatchObject({ sku: "NEW-SKU", inventoryQuantity: null, requiresShipping: true });
    expect(Number(v.unitCost)).toBe(9.25);
    await webhook("inventory_items/update", { id: Number(item("11")), tracked: true });
    expect((await systemDb.productVariant.findUniqueOrThrow({ where: { storeId_shopifyId: { storeId: store.id, shopifyId: "11" } } })).inventoryQuantity).toBe(30);
  });

  it("a delivery after the store gave stock-level access back is set aside without asking Shopify", async () => {
    const store = await makeStore(["read_orders", "read_products"]);
    const ev = await webhook("inventory_levels/update", { inventory_item_id: 999, location_id: 100, available: 1 });
    expect(shop.asked).toEqual([]);
    expect((await systemDb.webhookEvent.findUniqueOrThrow({ where: { id: ev.id } })).status).toBe("succeeded");
    expect(await systemDb.inventoryLevel.count({ where: { storeId: store.id } })).toBe(0);
  });

  it("locations/delete keeps the location as deleted and drops its stock", async () => {
    const store = await imported();
    await webhook("locations/delete", { id: 100 });
    expect((await systemDb.inventoryLocation.findUniqueOrThrow({ where: { storeId_shopifyId: { storeId: store.id, shopifyId: "100" } } })).deletedAt).not.toBeNull();
    expect(await level(store, "11", "100")).toBeNull();
  });
});

describe("stock alerts", () => {
  it("announce a newly low or sold-out item once, keep the bell in step, and resolve when it's restocked", async () => {
    const store = await makeStore();
    const member = await systemDb.user.create({ data: { email: "owner@example.com", emailVerified: true } });
    await systemDb.membership.create({ data: { workspaceId: store.workspaceId, userId: member.id, role: "owner" } });
    // A viewer without inventory access isn't emailed.
    const viewer = await systemDb.user.create({ data: { email: "viewer@example.com", emailVerified: true } });
    await systemDb.membership.create({ data: { workspaceId: store.workspaceId, userId: viewer.id, role: "viewer", permissions: ["analytics.sales"] } });
    await catalog(store, "1", [{ id: "11" }, { id: "12", threshold: 2 }]);
    shop.locations = [{ id: "100", name: "Warehouse" }];
    shop.levels.set(`${item("11")}|100`, { available: 0, updatedAt: "2026-10-19T01:00:00Z" });
    shop.levels.set(`${item("12")}|100`, { available: 3, updatedAt: "2026-10-19T01:00:00Z" }); // its own threshold: 2, so not low
    await fullPass(store);

    expect(await notifyStockAlerts(deps, store)).toBe(1);
    expect(mailer.sent.map((m) => m.to)).toEqual(["owner@example.com"]);
    expect(mailer.sent[0]!.text).toContain("1 item is out of stock.");
    expect(mailer.sent[0]!.text).toContain("Product 1 (V11), SKU SKU-11, 0 available");
    const bell = await systemDb.alert.findFirstOrThrow({ where: { storeId: store.id, code: STOCK_ALERT_CODE, resolvedAt: null } });
    expect(bell.message).toContain("1 item is out of stock.");

    // Still out on the next ticks, and the same webhook again: nothing more is sent.
    await evaluateStockAlerts(store);
    expect(await notifyStockAlerts(deps, store)).toBe(0);
    expect(mailer.sent).toHaveLength(1);

    // Restocked: the alert and the bell are resolved.
    shop.levels.set(`${item("11")}|100`, { available: 40, updatedAt: "2026-10-19T03:00:00Z" });
    await webhook("inventory_levels/update", { inventory_item_id: Number(item("11")), location_id: 100 });
    await notifyStockAlerts(deps, store);
    expect(await systemDb.inventoryAlert.count({ where: { storeId: store.id, resolvedAt: null } })).toBe(0);
    expect(await systemDb.alert.count({ where: { storeId: store.id, code: STOCK_ALERT_CODE, resolvedAt: null } })).toBe(0);

    // Sold out again within a day: the alert opens again, but nobody is emailed twice in a day.
    shop.levels.set(`${item("11")}|100`, { available: 0, updatedAt: "2026-10-19T04:00:00Z" });
    await webhook("inventory_levels/update", { inventory_item_id: Number(item("11")), location_id: 100 });
    expect(await notifyStockAlerts(deps, store)).toBe(0);
    expect(mailer.sent).toHaveLength(1);
    expect(await systemDb.alert.count({ where: { storeId: store.id, code: STOCK_ALERT_CODE, resolvedAt: null } })).toBe(1);
  });

  it("a member who turned stock alerts off isn't emailed; the bell is left out when turned off", async () => {
    const store = await makeStore();
    const member = await systemDb.user.create({ data: { email: "owner@example.com", emailVerified: true } });
    await systemDb.membership.create({ data: { workspaceId: store.workspaceId, userId: member.id, role: "owner" } });
    await systemDb.notificationPreference.create({ data: { userId: member.id, workspaceId: store.workspaceId, stockAlerts: false } });
    await systemDb.inventorySettings.create({ data: { storeId: store.id, workspaceId: store.workspaceId, dashboardAlerts: false } });
    await catalog(store, "1", [{ id: "11" }]);
    shop.locations = [{ id: "100", name: "Warehouse" }];
    shop.levels.set(`${item("11")}|100`, { available: 1, updatedAt: "2026-10-19T01:00:00Z" });
    await fullPass(store);
    expect(await notifyStockAlerts(deps, store)).toBe(1);
    expect(mailer.sent).toHaveLength(0);
    expect(await systemDb.alert.count({ where: { storeId: store.id, code: STOCK_ALERT_CODE } })).toBe(0);
  });

  it("a store nobody set up gets no alerts; with Shopify's totals only, alerts start once its settings are saved", async () => {
    const store = await makeStore(["read_orders", "read_products"]);
    const owner = await systemDb.user.create({ data: { email: "owner@example.com", emailVerified: true } });
    await systemDb.membership.create({ data: { workspaceId: store.workspaceId, userId: owner.id, role: "owner" } });
    await catalog(store, "1", [{ id: "11" }]); // 0 available (Shopify's total): out of stock
    await sweepInventory(deps);
    expect(await systemDb.inventoryAlert.count()).toBe(0);
    expect(mailer.sent).toHaveLength(0);
    // Stock settings saved: the next sweep evaluates and announces, without asking Shopify anything.
    await systemDb.inventorySettings.create({ data: { storeId: store.id, workspaceId: store.workspaceId } });
    const r = await sweepInventory(deps);
    expect(r.announced).toBe(1);
    expect(mailer.sent.map((m) => m.to)).toEqual(["owner@example.com"]);
    expect(shop.asked).toEqual([]);
  });

  it("the sweep starts the scheduled check when it is due, records the day, and leaves a fresh store alone", async () => {
    const store = await makeStore();
    await catalog(store, "1", [{ id: "11" }]);
    shop.locations = [{ id: "100", name: "Warehouse" }];
    shop.levels.set(`${item("11")}|100`, { available: 3, updatedAt: "2026-10-19T01:00:00Z" });
    // Never checked: the first pass is the import.
    expect((await sweepInventory(deps)).checksStarted).toBe(1);
    await drain();
    expect((await sweepInventory(deps)).checksStarted).toBe(0);
    // Six hours later (the default interval) it is due again.
    const later = new Date(Date.now() + 6 * 3600_000 + 60_000);
    const r = await sweepInventory(deps, later);
    expect(r.checksStarted).toBe(1);
    const queued = queues.sent.sync.at(-1)!;
    expect(queued.inventory?.trigger).toBe("reconcile");
    expect(await takeSnapshot(store)).toBe(true);
  });
});

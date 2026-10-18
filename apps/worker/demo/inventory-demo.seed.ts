import { afterAll, it } from "vitest";
import { disconnectDb, systemDb } from "@app/db";
import {
  applyLevels,
  bulkUpsertProducts,
  bulkUpsertVariants,
  evaluateStockAlerts,
  normalizeRestOrder,
  purgeStoreData,
  takeSnapshot,
  upsertLocations,
  upsertOrder,
  type NormalizedProduct,
  type NormalizedVariant,
} from "@app/core";
import { addDays, localDay } from "@app/shared";

/**
 * Sample data for the LOCAL Inventory demo (database inventory_demo; see inventory.vitest.config.ts):
 * a store with three locations, a small catalog with variants, stock levels in every state, orders
 * over the last 45 days, two weeks of day's-end stock records and some stock changes. Written
 * through the module's own code where it can be (levels, alerts, today's snapshot); the earlier
 * days' records are made up for the demo and labelled as such by the store's name. Test values only.
 */

afterAll(async () => disconnectDb());

let rnd = 11;
const rand = () => ((rnd = (rnd * 1103515245 + 12345) % 2147483648) / 2147483648);

const STORE = "inv_demo_store";
const TZ = "Australia/Melbourne";

const CATALOG: Array<{ id: number; title: string; vendor: string; type: string; collection: [string, string]; variants: Array<{ title: string; price: number; cost: number | null; options?: Array<[string, string]>; tracked?: boolean }> }> = [
  { id: 101, title: "Classic Cotton Tee", vendor: "Northwind Apparel", type: "T-Shirts", collection: ["11", "Essentials"], variants: [
    { title: "S / White", price: 29, cost: 9.5, options: [["Size", "S"], ["Colour", "White"]] },
    { title: "M / White", price: 29, cost: 9.5, options: [["Size", "M"], ["Colour", "White"]] },
    { title: "L / White", price: 29, cost: 9.5, options: [["Size", "L"], ["Colour", "White"]] },
    { title: "M / Black", price: 29, cost: 9.5, options: [["Size", "M"], ["Colour", "Black"]] },
  ] },
  { id: 102, title: "Canvas Tote Bag", vendor: "Harbour Goods", type: "Bags", collection: ["12", "Accessories"], variants: [{ title: "Default Title", price: 24, cost: 7 }] },
  { id: 103, title: "Premium Hoodie", vendor: "Northwind Apparel", type: "Hoodies", collection: ["11", "Essentials"], variants: [
    { title: "M", price: 79, cost: 31, options: [["Size", "M"]] },
    { title: "L", price: 79, cost: 31, options: [["Size", "L"]] },
  ] },
  { id: 104, title: "Ceramic Coffee Mug", vendor: "Harbour Goods", type: "Homeware", collection: ["13", "Home"], variants: [{ title: "Default Title", price: 18, cost: null }] },
  { id: 105, title: "Wool Beanie", vendor: "Northwind Apparel", type: "Accessories", collection: ["12", "Accessories"], variants: [{ title: "Default Title", price: 32, cost: 11 }] },
  { id: 106, title: "Gift Wrapping", vendor: "Harbour Goods", type: "Services", collection: ["12", "Accessories"], variants: [{ title: "Default Title", price: 5, cost: null, tracked: false }] },
  { id: 107, title: "Linen Napkin Set", vendor: "Harbour Goods", type: "Homeware", collection: ["13", "Home"], variants: [{ title: "Default Title", price: 36, cost: 12 }] },
];

/** Stock per variant (index across the catalog) at each location: [warehouse, city shop, pop-up]. */
const STOCK: Array<[number, number, number]> = [
  [140, 22, 0], // Tee S
  [96, 31, 6], // Tee M White
  [8, 2, 0], // Tee L: low
  [0, 0, 0], // Tee M Black: out
  [6, 1, 0], // Tote: low
  [44, 9, 3], // Hoodie M
  [0, 0, 0], // Hoodie L: out
  [210, 40, 12], // Mug
  [3, 0, 0], // Beanie: low
  [0, 0, 0], // Gift wrapping (untracked)
  [64, 0, 0], // Napkins: slow
];

it("seeds the Inventory demo", async () => {
  const email = process.env.INVENTORY_DEMO_EMAIL ?? "demo.merchant@example.com";
  const user = await systemDb.user.findUnique({ where: { email } });
  if (!user) throw new Error(`Sign in as ${email} on the demo first`);

  await purgeStoreData(STORE).catch(() => {});
  await systemDb.workspace.deleteMany({ where: { id: "inv_demo_ws" } });
  await systemDb.store.deleteMany({ where: { id: STORE } });
  const ws = await systemDb.workspace.create({ data: { id: "inv_demo_ws", name: "Northwind Goods" } });
  await systemDb.membership.create({ data: { workspaceId: ws.id, userId: user.id, role: "owner" } });
  const scopes = ["read_orders", "read_products", "read_inventory", "read_locations", "write_inventory"];
  const store = await systemDb.store.create({
    data: { id: STORE, workspaceId: ws.id, shopDomain: "northwind-goods.myshopify.com", name: "Northwind Goods (sample data)", timezone: TZ, currency: "AUD", status: "active", grantedScopes: scopes, lastSyncedAt: new Date(), ordersHistoryFrom: new Date(Date.now() - 60 * 86_400_000) },
  });

  // ---- catalog
  const updated = new Date(Date.now() - 86_400_000);
  const products: NormalizedProduct[] = CATALOG.map((p) => ({
    shopifyId: String(p.id),
    title: p.title,
    status: "active",
    vendor: p.vendor,
    productType: p.type,
    createdAt: new Date("2026-03-01T00:00:00Z"),
    updatedAt: updated,
    handle: p.title.toLowerCase().replace(/\s+/g, "-"),
    description: `${p.title}: sample product for the bizinsights Inventory demo.`,
    tags: ["sample"],
    category: null,
    collections: [{ id: p.collection[0], title: p.collection[1] }],
    imageUrl: null,
    onlineStoreUrl: null,
  }));
  await bulkUpsertProducts(store, products);
  const variants: NormalizedVariant[] = [];
  let vid = 1000;
  for (const p of CATALOG) {
    p.variants.forEach((v, i) => {
      vid++;
      variants.push({
        shopifyId: String(vid),
        productShopifyId: String(p.id),
        title: v.title,
        sku: `${p.title.split(" ").map((w) => w[0]).join("").toUpperCase()}-${vid}`,
        price: v.price,
        inventoryQuantity: v.tracked === false ? null : 0,
        unitCost: v.cost,
        updatedAt: updated,
        inventoryItemId: String(vid + 5000),
        barcode: `93100${vid}`,
        compareAtPrice: null,
        options: (v.options ?? []).map(([name, value]) => ({ name, value })),
        taxable: true,
        inventoryPolicy: "deny",
        requiresShipping: v.tracked !== false,
        weight: v.tracked === false ? null : 0.3,
        weightUnit: "KILOGRAMS",
        position: i + 1,
        createdAt: new Date("2026-03-01T00:00:00Z"),
      });
    });
  }
  await bulkUpsertVariants(store, variants);

  // ---- locations and levels
  const loc = (id: string, name: string, city: string, active = true) => ({
    id: `gid://shopify/Location/${id}`,
    name,
    isActive: active,
    fulfillsOnlineOrders: true,
    isFulfillmentService: false,
    address: { address1: "1 Sample St", address2: null, city, province: "VIC", zip: "3000", country: "Australia", countryCode: "AU", formatted: ["1 Sample St", `${city} VIC 3000`, "Australia"] },
  });
  await upsertLocations(store, [loc("7001", "Main warehouse", "Dandenong"), loc("7002", "City shop", "Melbourne"), loc("7003", "Pop-up stall", "Fitzroy")]);
  const startedAt = new Date(Date.now() - 2 * 3600_000);
  const run = await systemDb.inventorySyncRun.create({ data: { workspaceId: ws.id, storeId: STORE, trigger: "import", status: "running", startedAt } });
  const reads = variants.flatMap((v, i) =>
    (["7001", "7002", "7003"] as const).flatMap((location, j) => {
      const available = STOCK[i]![j]!;
      if (j > 0 && available === 0 && i !== 3) return [];
      const committed = j === 0 && available > 20 ? Math.floor(available / 12) : 0;
      return [{
        inventoryItemId: v.inventoryItemId!,
        locationId: location,
        quantities: { available, onHand: available + committed + (i === 5 && j === 0 ? 2 : 0), committed, incoming: i === 2 && j === 0 ? 48 : i === 6 && j === 0 ? 24 : 0, reserved: 0, damaged: i === 5 && j === 0 ? 2 : 0, safetyStock: 0, qualityControl: 0 },
        updatedAt: new Date(Date.now() - 3 * 3600_000),
      }];
    }),
  );
  await applyLevels(store, reads, "sync");
  await systemDb.inventorySyncRun.update({ where: { id: run.id }, data: { status: "succeeded", finishedAt: new Date(), locations: 3, levelsChecked: reads.length } });

  // A few changes seen since: sales coming through, a restock, and one found by the check.
  const change = async (variant: number, location: string, delta: number, source: "webhook" | "reconcile") => {
    const r = reads.find((x) => x.inventoryItemId === variants[variant]!.inventoryItemId && x.locationId === location)!;
    r.quantities = { ...r.quantities, available: r.quantities.available + delta, onHand: r.quantities.onHand + delta };
    r.updatedAt = new Date(r.updatedAt.getTime() + 600_000);
    await applyLevels(store, [r], source, { updateTotals: true });
  };
  await change(1, "7001", -2, "webhook");
  await change(0, "7002", -1, "webhook");
  await change(7, "7001", 36, "webhook");
  await change(5, "7001", -1, "reconcile");
  await systemDb.$executeRaw`UPDATE product_variants v SET inventory_quantity = COALESCE((SELECT SUM(l.available) FROM inventory_levels l WHERE l.store_id = v.store_id AND l.inventory_item_id = v.inventory_item_id), 0) WHERE v.store_id = ${STORE} AND v.inventory_quantity IS NOT NULL`;

  // ---- orders over the last 45 days
  let orderId = 50000;
  const today = localDay(new Date(), TZ);
  for (let d = 44; d >= 0; d--) {
    const n = Math.floor(rand() * 6) + 2;
    for (let k = 0; k < n; k++) {
      const vi = [0, 1, 1, 1, 2, 4, 5, 7, 7, 8][Math.floor(rand() * 10)]!;
      const v = variants[vi]!;
      const at = new Date(Date.now() - d * 86_400_000 - Math.floor(rand() * 8) * 3600_000);
      const qty = rand() < 0.2 ? 2 : 1;
      orderId++;
      await upsertOrder(
        store,
        normalizeRestOrder({
          id: orderId,
          name: `#${orderId}`,
          currency: "AUD",
          created_at: at.toISOString(),
          updated_at: at.toISOString(),
          subtotal_price: String(v.price * qty),
          total_discounts: "0",
          total_tax: "0",
          total_price: String(v.price * qty),
          financial_status: "paid",
          line_items: [{ id: orderId * 10, product_id: Number(v.productShopifyId), variant_id: Number(v.shopifyId), sku: v.sku, title: v.title, quantity: qty, price: String(v.price) }],
        }),
      );
    }
  }

  // ---- two weeks of day's-end records (sample), then today's from the real stock
  for (let d = 14; d >= 1; d--) {
    const day = addDays(today, -d);
    const drift = d * 9;
    await systemDb.inventorySnapshot.create({
      data: { workspaceId: ws.id, storeId: STORE, day, locationKey: "all", trackedVariants: 10, untrackedVariants: 1, available: 760 + drift, onHand: 790 + drift, committed: 24, incoming: d > 7 ? 0 : 72, lowStock: d > 5 ? 2 : 3, outOfStock: d > 9 ? 1 : 2, costValue: (11200 + drift * 10).toFixed(2), variantsWithCost: 8, variantsInStock: 9, retailValue: (30500 + drift * 28).toFixed(2), takenAt: new Date() },
    });
  }
  await takeSnapshot(store);
  await evaluateStockAlerts(store);
  // eslint-disable-next-line no-console
  console.log(`Inventory demo seeded for ${email}: workspace "${ws.name}", ${variants.length} variants, ${reads.length} levels, ${orderId - 50000} orders.`);
});

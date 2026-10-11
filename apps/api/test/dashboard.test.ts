import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { recomputeDays } from "@app/core";
import { systemDb } from "@app/db";
import { addDays, localDay } from "@app/shared";
import { syncProblem } from "../src/routes/dashboard.js";
import { clean, createStore, createWorkspace, setup, signIn, teardown, type TestCtx } from "./helpers.js";

let ctx: TestCtx;
beforeAll(async () => (ctx = await setup()));
afterAll(async () => teardown(ctx));
beforeEach(async () => clean(ctx));

const TZ = "America/New_York";
const ALL_SCOPES = ["read_orders", "read_products", "read_customers"];
type Store = Awaited<ReturnType<typeof createStore>>;

interface SeedLine {
  product?: string;
  variant?: string;
  qty: number;
  price: number;
  discount?: number;
}

interface SeedOrder {
  id: string;
  createdAt: string | Date;
  cancelled?: boolean;
  subtotal?: number;
  discounts?: number;
  tax?: number;
  shipping?: number;
  source?: string | null;
  fulfillment?: string | null;
  fulfilledAfterHours?: number;
  codes?: string[];
  lines?: SeedLine[];
}

/** Insert an order the way the pipeline stores it (UTC timestamps, store-local day). */
async function seedOrder(store: Store, o: SeedOrder) {
  const created = new Date(o.createdAt);
  const subtotal = o.subtotal ?? 0;
  const tax = o.tax ?? 0;
  const shipping = o.shipping ?? 0;
  await systemDb.order.create({
    data: {
      workspaceId: store.workspaceId,
      storeId: store.id,
      shopifyId: o.id,
      name: `#${o.id}`,
      currency: "USD",
      localDay: localDay(created, store.timezone),
      shopifyCreatedAt: created,
      shopifyUpdatedAt: created,
      cancelledAt: o.cancelled ? created : null,
      financialStatus: "paid",
      subtotal,
      totalDiscounts: o.discounts ?? 0,
      totalTax: tax,
      totalShipping: shipping,
      totalPrice: subtotal + tax + shipping,
      sourceName: o.source ?? null,
      fulfillmentStatus: o.fulfillment ?? null,
      fulfilledAt: o.fulfilledAfterHours === undefined ? null : new Date(created.getTime() + o.fulfilledAfterHours * 3_600_000),
      discountCodes: o.codes ?? [],
      lineItems: {
        create: (o.lines ?? []).map((l, i) => ({
          workspaceId: store.workspaceId,
          storeId: store.id,
          shopifyId: `${o.id}-${i}`,
          productShopifyId: l.product ?? null,
          variantShopifyId: l.variant ?? null,
          title: `Item ${i}`,
          quantity: l.qty,
          price: l.price,
          discount: l.discount ?? 0,
        })),
      },
    },
  });
}

async function seedProduct(store: Store, id: string, title: string, status: string | null, vendor: string | null = null) {
  await systemDb.product.create({
    data: { workspaceId: store.workspaceId, storeId: store.id, shopifyId: id, title, status, vendor, shopifyUpdatedAt: new Date() },
  });
}

async function seedVariant(store: Store, product: string, id: string, v: { qty: number | null; price: number; cost?: number; title?: string; sku?: string }) {
  await systemDb.productVariant.create({
    data: {
      workspaceId: store.workspaceId,
      storeId: store.id,
      productShopifyId: product,
      shopifyId: id,
      title: v.title ?? "Default Title",
      sku: v.sku ?? null,
      price: v.price,
      inventoryQuantity: v.qty,
      unitCost: v.cost ?? null,
      shopifyUpdatedAt: new Date(),
    },
  });
}

async function owner(scopes = ALL_SCOPES) {
  const a = await signIn(ctx, "ua", "a@x.com");
  const ws = await createWorkspace(ctx, a.headers, "A");
  const store = await createStore(ws, "a.myshopify.com", scopes, { timezone: TZ, name: "Demo Shop" });
  return { a, ws, store };
}

async function overview(headers: Record<string, string>, ws: string, storeId: string, qs = "preset=30d") {
  return ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${storeId}/overview?${qs}`, headers });
}

/** Whole store-local days between two YYYY-MM-DD days. */
const dayDiff = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

describe("order modules (store time zone, DST weekend)", () => {
  // US DST starts 2026-03-08 02:00 local: 06:30Z is 01:30 EST, 07:30Z is 03:30 EDT.
  const RANGE = "preset=custom&from=2026-03-07&to=2026-03-09";

  async function seedWeekend(store: Store) {
    await seedProduct(store, "p1", "Tee", "ACTIVE", "Acme");
    await seedProduct(store, "p2", "Mug", "active", "Beta");
    // A: Fri 23:59 local (Sat 04:59Z) — outside the local range, still unfulfilled.
    await seedOrder(store, { id: "A", createdAt: "2026-03-07T04:59:00Z", subtotal: 999, tax: 50, source: "web", fulfillment: "unfulfilled", codes: ["SAVE10"], lines: [{ product: "p1", qty: 9, price: 111 }] });
    await seedOrder(store, {
      id: "B", createdAt: "2026-03-08T06:30:00Z", subtotal: 100, discounts: 10, tax: 8, shipping: 5, source: "web",
      fulfillment: "fulfilled", fulfilledAfterHours: 24, codes: ["SAVE10"],
      lines: [{ product: "p1", variant: "v1", qty: 1, price: 50 }, { product: "p2", variant: "v2", qty: 2, price: 30, discount: 10 }],
    });
    await seedOrder(store, {
      id: "C", createdAt: "2026-03-08T07:30:00Z", subtotal: 50, discounts: 5, tax: 4, source: "web",
      fulfillment: "partially_fulfilled", fulfilledAfterHours: 12, codes: ["save10", "FREESHIP", "SAVE10"],
      lines: [{ product: "p1", variant: "v1", qty: 1, price: 55, discount: 5 }],
    });
    await seedOrder(store, { id: "D", createdAt: "2026-03-09T03:30:00Z", subtotal: 30, discounts: 3, tax: 2.4, shipping: 3, source: "pos", fulfillment: "unfulfilled", codes: ["SAVE10"], lines: [{ product: "p2", qty: 1, price: 33, discount: 3 }] });
    // E: legacy row with no fulfillment status / channel yet, and a blank code.
    await seedOrder(store, { id: "E", createdAt: "2026-03-09T16:00:00Z", subtotal: 20, source: null, codes: ["  "], lines: [{ product: "zz", qty: 4, price: 5 }] });
    // F: cancelled — excluded everywhere except recent orders.
    await seedOrder(store, { id: "F", createdAt: "2026-03-09T20:00:00Z", cancelled: true, subtotal: 500, tax: 100, source: "web", fulfillment: "unfulfilled", codes: ["SAVE10"], lines: [{ product: "p1", qty: 5, price: 100 }] });
  }

  it("computes channels, timing, fulfillment, discount codes, tax/shipping and vendors for the range", async () => {
    const { a, ws, store } = await owner();
    await seedWeekend(store);
    const res = await overview(a.headers, ws, store.id, RANGE);
    expect(res.statusCode).toBe(200);
    const { modules: m, range, data } = res.json();
    expect(range).toEqual({ from: "2026-03-07", to: "2026-03-09" });

    expect(m.sales_overview.current).toMatchObject({ tax: 14.4, shipping: 8 });

    expect(m.channels.items).toEqual([
      { source: "web", label: "Online Store", orders: 2, sales: 150, share: 0.75 },
      { source: "pos", label: "Point of Sale", orders: 1, sales: 30, share: 0.15 },
      { source: null, label: "Unknown", orders: 1, sales: 20, share: 0.1 },
    ]);

    // B Sun 01:30 EST, C Sun 03:30 EDT, D Sun 23:30 EDT (Mon 03:30Z), E Mon 12:00 EDT.
    const hours = Array<number>(24).fill(0);
    hours[1] = hours[3] = hours[23] = hours[12] = 1;
    expect(m.order_timing).toEqual({ byWeekday: [1, 0, 0, 0, 0, 0, 3], byHour: hours, busiestDay: "Sunday", busiestHour: 1 });

    expect(m.fulfillment.current).toEqual({ orders: 4, fulfilled: 1, partiallyFulfilled: 1, unfulfilled: 1, avgHoursToFulfill: 18 });
    // All time: A, C and D still need shipping (E has no status, F is cancelled).
    const today = localDay(new Date(), TZ);
    expect(m.fulfillment.openNow).toBe(3);
    expect(m.fulfillment.oldestOpenDays).toBe(dayDiff("2026-03-06", today));

    expect(m.discount_codes.items).toEqual([
      { code: "SAVE10", orders: 3, discount: 18, sales: 180 },
      { code: "FREESHIP", orders: 1, discount: 5, sales: 50 },
    ]);

    // Vendor revenue = line price × qty − discount, range only, cancelled excluded; unknown products skipped.
    expect(m.catalog.topVendors).toEqual([
      { vendor: "Acme", revenue: 100, units: 2 },
      { vendor: "Beta", revenue: 80, units: 3 },
    ]);
    expect(m.catalog.products).toEqual({ active: 2, draft: 0, archived: 0, total: 2 });

    expect(data).toEqual({ orders: 6, products: 2, variants: 0, oldestOrderDay: "2026-03-06", newestOrderDay: "2026-03-09" });
  });

  it("lists the latest orders overall, flagging cancelled ones", async () => {
    const { a, ws, store } = await owner();
    await seedWeekend(store);
    // A 7-day preset around "now" does not include March, but recent orders are not range-limited.
    const res = await overview(a.headers, ws, store.id, "preset=7d");
    const items = res.json().modules.recent_orders.items;
    expect(items.map((o: { name: string }) => o.name)).toEqual(["#F", "#E", "#D", "#C", "#B", "#A"]);
    expect(items[0]).toMatchObject({ shopifyId: "F", createdAt: "2026-03-09T20:00:00.000Z", total: 600, cancelled: true, channel: "Online Store", units: 5, fulfillmentStatus: "unfulfilled", financialStatus: "paid" });
    expect(items[4]).toMatchObject({ name: "#B", total: 113, units: 3, cancelled: false, fulfillmentStatus: "fulfilled" });
    expect(items[1]).toMatchObject({ channel: "Unknown", fulfillmentStatus: null });
    expect(typeof items[0].id).toBe("string");
  });

  it("returns empty, honest module values for a store without data", async () => {
    const { a, ws, store } = await owner();
    const res = await overview(a.headers, ws, store.id);
    const { modules: m, data } = res.json();
    expect(m.channels.items).toEqual([]);
    expect(m.order_timing).toMatchObject({ busiestDay: null, busiestHour: null });
    expect(m.order_timing.byWeekday).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(m.fulfillment).toEqual({ current: { orders: 0, fulfilled: 0, partiallyFulfilled: 0, unfulfilled: 0, avgHoursToFulfill: null }, openNow: 0, oldestOpenDays: null });
    expect(m.discount_codes.items).toEqual([]);
    expect(m.recent_orders.items).toEqual([]);
    expect(m.inventory).toEqual({
      current: { trackedVariants: 0, unitsInStock: 0, stockValueAtCost: null, variantsWithCost: 0, retailValue: 0, outOfStock: 0, lowStock: 0 },
      lowStockItems: [],
    });
    expect(m.catalog).toEqual({ products: { active: 0, draft: 0, archived: 0, total: 0 }, variants: 0, topVendors: [] });
    expect(m.sales_overview.current).toMatchObject({ tax: 0, shipping: 0 });
    expect(data).toEqual({ orders: 0, products: 0, variants: 0, oldestOrderDay: null, newestOrderDay: null });
  });
});

describe("date ranges", () => {
  it("charts every day of the range, quiet days as zero", async () => {
    const { a, ws, store } = await owner();
    await seedOrder(store, { id: "A", createdAt: "2026-03-06T17:00:00Z", lines: [{ qty: 1, price: 40 }] });
    await seedOrder(store, { id: "B", createdAt: "2026-03-08T17:00:00Z", lines: [{ qty: 2, price: 30, discount: 5 }] });
    await seedOrder(store, { id: "C", createdAt: "2026-03-08T18:00:00Z", cancelled: true, lines: [{ qty: 1, price: 99 }] });
    await recomputeDays(store, ["2026-03-06", "2026-03-08"]);

    const res = await overview(a.headers, ws, store.id, "preset=custom&from=2026-03-05&to=2026-03-09");
    expect(res.statusCode).toBe(200);
    const s = res.json().modules.sales_overview;
    // Only the 6th and 8th have daily rows; the chart used to be just those two points.
    const quiet = { netSales: 0, orders: 0, refunds: 0, averageOrderValue: null };
    expect(s.series).toEqual([
      { day: "2026-03-05", ...quiet },
      { day: "2026-03-06", netSales: 40, orders: 1, refunds: 0, averageOrderValue: 40 },
      { day: "2026-03-07", ...quiet },
      { day: "2026-03-08", netSales: 55, orders: 1, refunds: 0, averageOrderValue: 55 },
      { day: "2026-03-09", ...quiet },
    ]);
    expect(s.current).toMatchObject({ netSales: 95, orders: 2 });
  });

  it("breaks this year down by month, whatever dates are picked, from the first imported order on", async () => {
    const { a, ws, store } = await owner();
    const today = localDay(new Date(), TZ);
    const thisMonth = today.slice(0, 7);
    // Two orders this month (one today), and the first imported order earlier this month or today.
    await seedOrder(store, { id: "T", createdAt: new Date(), lines: [{ qty: 1, price: 70 }] });
    await recomputeDays(store, [today]);

    const res = await overview(a.headers, ws, store.id, "preset=7d");
    const body = res.json();
    expect(body.today).toBe(today);
    const y = body.modules.sales_overview.year;
    expect(y.year).toBe(Number(today.slice(0, 4)));
    expect(y.months.at(-1)).toMatchObject({ month: thisMonth, current: true, to: today, netSales: 70, orders: 1, averageOrderValue: 70 });
    // Nothing was imported before today's order: earlier months are "none", not $0 months.
    expect(y.months.slice(0, -1).every((m: { coverage: string }) => m.coverage === "none")).toBe(true);
    expect(y.total).toBe(70);
  });

  it("reports a custom range up to the store's today, and compares it with as many days before", async () => {
    const { a, ws, store } = await owner();
    const today = localDay(new Date(), TZ);
    const res = await overview(a.headers, ws, store.id, `preset=custom&from=${addDays(today, -2)}&to=${addDays(today, 20)}`);
    expect(res.statusCode).toBe(200);
    const { range, previous, modules } = res.json();
    expect(range).toEqual({ from: addDays(today, -2), to: today });
    expect(previous).toEqual({ from: addDays(today, -5), to: addDays(today, -3) });
    expect(modules.sales_overview.series.map((x: { day: string }) => x.day)).toEqual([addDays(today, -2), addDays(today, -1), today]);
  });

  it("refuses ranges it can't report on with a 400, never a 500", async () => {
    const { a, ws, store } = await owner();
    const today = localDay(new Date(), TZ);
    for (const qs of [
      `preset=custom&from=${addDays(today, 1)}&to=${addDays(today, 3)}`,
      "preset=custom&from=2026-13-01&to=2026-13-05",
      "preset=custom&from=2026-02-30&to=2026-03-02",
      "preset=custom&from=2026-03-09&to=2026-03-01",
      "preset=custom&from=2026-03-09",
    ]) {
      const res = await overview(a.headers, ws, store.id, qs);
      expect(res.statusCode, qs).toBe(400);
      expect(res.json().error, qs).toBe("invalid_range");
    }
  });
});

describe("channels and catalog details", () => {
  it("merges raw sources that are the same channel; apps stay separate", async () => {
    const { a, ws, store } = await owner();
    const at = new Date(Date.now() - 2 * 86_400_000);
    await seedOrder(store, { id: "1", createdAt: at, subtotal: 300, source: "subscription_contract" });
    await seedOrder(store, { id: "2", createdAt: at, subtotal: 200, source: "subscription_contract_checkout_one" });
    await seedOrder(store, { id: "3", createdAt: at, subtotal: 100, source: "web" });
    await seedOrder(store, { id: "4", createdAt: at, subtotal: 50, source: "Web" });
    await seedOrder(store, { id: "5", createdAt: at, subtotal: 30, source: "580111" });
    await seedOrder(store, { id: "6", createdAt: at, subtotal: 20, source: "999" });
    const items = (await overview(a.headers, ws, store.id)).json().modules.channels.items;
    expect(items.map((c: { label: string; orders: number; sales: number }) => [c.label, c.orders, c.sales])).toEqual([
      ["Subscriptions", 2, 500],
      ["Online Store", 2, 150],
      ["Other sales channel app", 1, 30],
      ["Other sales channel app", 1, 20],
    ]);
    expect(items[0].source).toBe("subscription_contract");
    expect(items[0].share).toBeCloseTo(500 / 700);
    expect(items.reduce((t: number, c: { share: number }) => t + c.share, 0)).toBeCloseTo(1);
  });

  it("counts unlisted products (live, link-only) as active", async () => {
    const { a, ws, store } = await owner();
    await seedProduct(store, "1", "Live", "active");
    await seedProduct(store, "2", "Link only", "unlisted");
    await seedProduct(store, "3", "Draft", "draft");
    const m = (await overview(a.headers, ws, store.id)).json().modules;
    expect(m.catalog.products).toEqual({ active: 2, draft: 1, archived: 0, total: 3 });
  });
});

describe("live updates (dashboard polls every 15 s)", () => {
  const sent = () => ctx.deps.queues.sent.sync.map((j) => `${j.kind}:${j.sinceDays ?? "-"}`).sort();

  it("re-pulls recent orders and the catalog from Shopify at most once per window, however often it is polled", async () => {
    const { a, ws, store } = await owner();
    await systemDb.store.update({ where: { id: store.id }, data: { lastSyncedAt: new Date() } });
    ctx.deps.queues.clear();
    expect((await overview(a.headers, ws, store.id)).statusCode).toBe(200);
    expect(sent()).toEqual(["orders:2", "products:-", "variants:-"]);

    // Jobs still queued: the next polls don't pile more on top...
    expect((await overview(a.headers, ws, store.id)).statusCode).toBe(200);
    expect(ctx.deps.queues.sent.sync).toHaveLength(3);
    // ...and once they're done, nothing is due again until the window passes.
    await systemDb.syncJob.updateMany({ where: { storeId: store.id }, data: { status: "succeeded" } });
    await overview(a.headers, ws, store.id);
    expect(ctx.deps.queues.sent.sync).toHaveLength(3);
  });

  it("a sync still making progress holds refreshes off; one that died in an outage does not", async () => {
    const { a, ws, store } = await owner(["read_orders"]);
    await systemDb.store.update({ where: { id: store.id }, data: { lastSyncedAt: new Date() } });
    const ago = (min: number) => new Date(Date.now() - min * 60_000);
    // A refresh started 15 minutes ago; its last page landed a minute ago.
    const job = await systemDb.syncJob.create({
      data: { workspaceId: ws, storeId: store.id, kind: "orders", status: "running", createdAt: ago(15), startedAt: ago(15), lastActivityAt: ago(1) },
    });
    ctx.deps.queues.clear();
    await overview(a.headers, ws, store.id);
    expect(ctx.deps.queues.sent.sync).toHaveLength(0);

    // Its chain died in a database outage instead, still running as far as its row says. Counting
    // the row kept the dashboard from refreshing for half an hour after the database came back.
    await systemDb.syncJob.update({ where: { id: job.id }, data: { lastActivityAt: ago(14) } });
    await overview(a.headers, ws, store.id);
    expect(sent()).toEqual(["orders:2"]);
  });

  it("retries the import of a store with a sync problem, and leaves an importing store alone", async () => {
    const { a, ws, store } = await owner();
    await systemDb.store.update({ where: { id: store.id }, data: { status: "error", lastSyncedAt: null } });
    ctx.deps.queues.clear();
    await overview(a.headers, ws, store.id);
    // Full import again. The catalog starts immediately; only orders waits for `shop`, which is
    // what learns the time zone their day bucketing needs.
    expect(sent()).toEqual(["products:-", "shop:-", "variants:-"]);

    ctx.deps.queues.clear();
    ctx.deps.coord.clear();
    await systemDb.syncJob.deleteMany({ where: { storeId: store.id } });
    await systemDb.store.update({ where: { id: store.id }, data: { status: "syncing" } });
    await overview(a.headers, ws, store.id);
    expect(ctx.deps.queues.sent.sync).toHaveLength(0);
  });
});

describe("inventory module", () => {
  it("values stock and flags variants about to run out using 30-day velocity", async () => {
    const { a, ws, store } = await owner();
    const today = localDay(new Date(), TZ);
    const at = (day: string) => `${day}T16:00:00Z`; // midday in New York: same local day

    await seedProduct(store, "p1", "Tee", "ACTIVE", "Acme");
    await seedProduct(store, "p2", "Old tee", "ARCHIVED", "Acme");
    await seedProduct(store, "p3", "Mug", "draft", "Beta");
    await seedVariant(store, "p1", "v1", { qty: 3, price: 20, cost: 8, title: "Small", sku: "TEE-S" });
    await seedVariant(store, "p1", "v2", { qty: 100, price: 20, cost: 8, title: "Medium", sku: "TEE-M" });
    await seedVariant(store, "p1", "v3", { qty: 0, price: 20, cost: 8, title: "Large" });
    await seedVariant(store, "p1", "v8", { qty: -2, price: 5, title: "Oversold" });
    await seedVariant(store, "p2", "v4", { qty: 50, price: 20, cost: 8 }); // archived product: ignored
    await seedVariant(store, "p3", "v5", { qty: 40, price: 10 });
    await seedVariant(store, "p3", "v6", { qty: null, price: 10 }); // not tracked: ignored
    await seedVariant(store, "gone", "v7", { qty: 2, price: 15 }); // product row missing: still counted

    // Velocity window is the last 30 store-local days including today.
    await seedOrder(store, { id: "o1", createdAt: at(addDays(today, -29)), subtotal: 6000, lines: [{ product: "p1", variant: "v2", qty: 300, price: 20 }] });
    await seedOrder(store, { id: "o2", createdAt: at(addDays(today, -1)), subtotal: 80, lines: [{ product: "p1", variant: "v1", qty: 3, price: 20 }, { product: "p3", variant: "v5", qty: 2, price: 10 }] });
    await seedOrder(store, { id: "o3", createdAt: at(addDays(today, -30)), subtotal: 20000, lines: [{ product: "p1", variant: "v1", qty: 1000, price: 20 }] });
    await seedOrder(store, { id: "o4", createdAt: at(addDays(today, -2)), cancelled: true, subtotal: 10000, lines: [{ product: "p1", variant: "v1", qty: 500, price: 20 }] });

    const res = await overview(a.headers, ws, store.id);
    expect(res.statusCode).toBe(200);
    const { inventory, catalog } = res.json().modules;
    expect(inventory.current).toEqual({
      trackedVariants: 6,
      unitsInStock: 145,
      stockValueAtCost: 824,
      variantsWithCost: 3,
      retailValue: 2490,
      outOfStock: 2,
      lowStock: 3,
    });
    expect(inventory.lowStockItems).toEqual([
      { productTitle: "Tee", variantTitle: "Medium", sku: "TEE-M", quantity: 100, dailySales: 10, daysOfCover: 10 },
      { productTitle: "Tee", variantTitle: "Small", sku: "TEE-S", quantity: 3, dailySales: 0.1, daysOfCover: 30 },
      { productTitle: "Unknown product", variantTitle: "Default Title", sku: null, quantity: 2, dailySales: 0, daysOfCover: null },
    ]);

    expect(catalog.products).toEqual({ active: 1, draft: 1, archived: 1, total: 3 });
    expect(catalog.variants).toBe(8);
    expect(catalog.topVendors).toEqual([
      { vendor: "Acme", revenue: 6060, units: 303 },
      { vendor: "Beta", revenue: 20, units: 2 },
    ]);
  });
});

describe("scopes and tenancy", () => {
  it("only includes modules the granted scopes enable; data summary is always present", async () => {
    const a = await signIn(ctx, "ua", "a@x.com");
    const ws = await createWorkspace(ctx, a.headers, "A");
    const ordersOnly = await createStore(ws, "o.myshopify.com", ["read_orders"]);
    const productsOnly = await createStore(ws, "p.myshopify.com", ["read_products"]);
    await seedProduct(productsOnly, "p1", "Tee", "active");
    await seedVariant(productsOnly, "p1", "v1", { qty: 4, price: 10 });

    const o = (await overview(a.headers, ws, ordersOnly.id)).json();
    expect(Object.keys(o.modules).sort()).toEqual(["channels", "discount_codes", "fulfillment", "order_timing", "recent_orders", "refunds", "sales_overview"]);
    expect(o.capabilities.find((c: { id: string }) => c.id === "inventory").missingScopes).toEqual(["read_products"]);
    expect(o.data).toEqual({ orders: 0, products: 0, variants: 0, oldestOrderDay: null, newestOrderDay: null });

    const p = (await overview(a.headers, ws, productsOnly.id)).json();
    expect(Object.keys(p.modules).sort()).toEqual(["catalog", "inventory"]);
    expect(p.modules.inventory.current).toMatchObject({ trackedVariants: 1, unitsInStock: 4, lowStock: 1 });
    expect(p.data).toMatchObject({ products: 1, variants: 1, orders: 0 });
  });

  it("never reads another workspace's store (404) and never mixes stores", async () => {
    const { a, ws, store } = await owner();
    const b = await signIn(ctx, "ub", "b@x.com");
    const wsB = await createWorkspace(ctx, b.headers, "B");
    const storeB = await createStore(wsB, "b.myshopify.com", ALL_SCOPES, { timezone: TZ });
    await seedOrder(store, { id: "1", createdAt: new Date(), subtotal: 10, source: "web", codes: ["A"], lines: [{ product: "p", variant: "v", qty: 1, price: 10 }] });
    await seedProduct(store, "p", "Tee", "active", "Acme");
    await seedVariant(store, "p", "v", { qty: 1, price: 10 });

    expect((await overview(b.headers, ws, store.id)).statusCode).toBe(404);
    expect((await overview(b.headers, wsB, store.id)).statusCode).toBe(404);

    // Same Shopify ids in another tenant's store must not leak into A's numbers.
    await seedOrder(storeB, { id: "1", createdAt: new Date(), subtotal: 999, source: "web", codes: ["A"], lines: [{ product: "p", variant: "v", qty: 50, price: 10 }] });
    await seedProduct(storeB, "p", "Tee B", "active", "Acme");
    await seedVariant(storeB, "p", "v", { qty: 500, price: 10 });

    const mine = (await overview(a.headers, ws, store.id)).json();
    expect(mine.modules.channels.items).toEqual([{ source: "web", label: "Online Store", orders: 1, sales: 10, share: 1 }]);
    expect(mine.modules.discount_codes.items).toEqual([{ code: "A", orders: 1, discount: 0, sales: 10 }]);
    expect(mine.modules.recent_orders.items).toHaveLength(1);
    expect(mine.modules.inventory.current).toMatchObject({ trackedVariants: 1, unitsInStock: 1 });
    expect(mine.modules.inventory.lowStockItems).toEqual([{ productTitle: "Tee", variantTitle: "Default Title", sku: null, quantity: 1, dailySales: 0.03, daysOfCover: 30 }]);
    expect(mine.modules.catalog.topVendors).toEqual([{ vendor: "Acme", revenue: 10, units: 1 }]);
    expect(mine.data).toMatchObject({ orders: 1, products: 1, variants: 1 });
  });
});

describe("a store whose sync stopped", () => {
  it("reads Shopify's answers into a reason", () => {
    expect(syncProblem("Shopify 402: Unavailable Shop")).toBe("shop_unavailable");
    expect(syncProblem("Shopify 404: Not Found")).toBe("shop_gone");
    expect(syncProblem("Shopify 423: Locked")).toBe("shop_locked");
    expect(syncProblem("Shopify auth error 403")).toBe("access");
    expect(syncProblem("Store x.myshopify.com is not connected")).toBe("access");
    expect(syncProblem("Shopify 4020 something")).toBe("other");
    expect(syncProblem(null)).toBe("other");
  });

  it("says why, from Shopify's own answer: a frozen store isn't the same as lost access", async () => {
    const { a, ws, store } = await owner();
    expect((await overview(a.headers, ws, store.id)).json().syncProblem).toBeNull();

    await systemDb.store.update({ where: { id: store.id }, data: { status: "error" } });
    const fail = (error: string, minutesAgo: number) =>
      systemDb.syncJob.create({ data: { workspaceId: ws, storeId: store.id, kind: "orders", status: "failed", error, createdAt: new Date(Date.now() - minutesAgo * 60_000) } });
    await fail("Shopify auth error 401", 60);
    expect((await overview(a.headers, ws, store.id)).json().syncProblem).toBe("access");
    // The latest failure decides: the store has since been frozen (an unpaid Shopify bill, say).
    await fail("Shopify 402: Unavailable Shop", 5);
    expect((await overview(a.headers, ws, store.id)).json().syncProblem).toBe("shop_unavailable");
  });
});

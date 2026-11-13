import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { systemDb, withTenant } from "@app/db";
import { collectionSales } from "@app/core/reports";
import { clean, createStore, createWorkspace, setup, signIn, teardown, type TestCtx } from "./helpers.js";

/**
 * GET .../analytics/collections/sales: each Shopify collection's product sales (core
 * reports/collections.ts), on Top products' terms, by the collections products are in now.
 */

let ctx: TestCtx;
beforeAll(async () => (ctx = await setup()));
afterAll(async () => teardown(ctx));
beforeEach(async () => clean(ctx));

const SCOPES = ["read_orders", "read_products"];
type Store = Awaited<ReturnType<typeof createStore>>;
// 8 and 9 March.
const RANGE = "preset=custom&from=2026-03-08&to=2026-03-09";

interface Line {
  product: string | null;
  qty: number;
  price: number;
  discount?: number;
}

/** An order as the pipeline stores it, with Shopify's sales records: a sale per line, and for a cancelled order their reversal. */
async function seedOrder(store: Store, id: string, at: string, lines: Line[], o: { cancelled?: boolean; pending?: boolean } = {}) {
  const created = new Date(at);
  const day = at.slice(0, 10);
  const placed = lines.map((l, i) => ({ lineItemShopifyId: `${id}-${i}`, quantity: l.qty, amount: l.qty * l.price - (l.discount ?? 0), discount: l.discount ?? 0 }));
  const sales = [...placed.map((x) => ({ ...x, actionType: "order" })), ...(o.cancelled ? placed.map((x) => ({ ...x, actionType: "return", amount: -x.amount, discount: 0 })) : [])];
  const subtotal = placed.reduce((a, x) => a + x.amount, 0);
  return systemDb.order.create({
    data: {
      workspaceId: store.workspaceId,
      storeId: store.id,
      shopifyId: id,
      name: `#${id}`,
      currency: "USD",
      localDay: day,
      shopifyCreatedAt: created,
      shopifyUpdatedAt: created,
      cancelledAt: o.cancelled ? created : null,
      subtotal,
      totalDiscounts: 0,
      totalTax: 0,
      totalShipping: 0,
      totalPrice: subtotal,
      salesUpdatedAt: o.pending ? null : created,
      lineItems: {
        create: lines.map((l, i) => ({ workspaceId: store.workspaceId, storeId: store.id, shopifyId: `${id}-${i}`, productShopifyId: l.product, title: `Item ${i}`, quantity: l.qty, price: l.price, discount: l.discount ?? 0 })),
      },
      sales: {
        create: sales.map((x, i) => ({ ...x, workspaceId: store.workspaceId, storeId: store.id, shopifyId: `${id}-sale-${i}`, lineType: "product", tax: 0, localDay: day, happenedAt: created })),
      },
    },
  });
}

/** A catalog product and the collections Shopify has it in (undefined: never read). */
async function seedProduct(store: Store, id: string, title: string, collections?: Array<{ id: string; title: string }>) {
  await systemDb.product.create({ data: { workspaceId: store.workspaceId, storeId: store.id, shopifyId: id, title, status: "active", shopifyUpdatedAt: new Date(), ...(collections ? { collections } : {}) } });
}

const SUMMER = { id: "10", title: "Summer" };
const SALE = { id: "11", title: "Sale" };
const HOME = { id: "12", title: "Home" };

/** Tee in Summer and Sale, Hat in Summer, Mug in Home, Gift in none, Old's collections never read. */
async function catalog(store: Store) {
  await seedProduct(store, "tee", "Tee", [SUMMER, SALE]);
  await seedProduct(store, "hat", "Hat", [SUMMER]);
  await seedProduct(store, "mug", "Mug", [HOME]);
  await seedProduct(store, "gift", "Gift", []);
  await seedProduct(store, "old", "Old");
}

async function owner(scopes = SCOPES) {
  const a = await signIn(ctx, "ua", "a@x.com");
  const ws = await createWorkspace(ctx, a.headers, "A");
  const store = await createStore(ws, "a.myshopify.com", scopes, { ordersHistoryFrom: new Date(0) });
  return { a, ws, store };
}

/** The dates' sales: two Summer products in one order, a cancellation, a partial refund the day after, and one of each other kind. */
async function trade(store: Store) {
  const o1 = await seedOrder(store, "o1", "2026-03-08T12:00:00Z", [{ product: "tee", qty: 2, price: 20, discount: 5 }, { product: "hat", qty: 1, price: 10 }]);
  await seedOrder(store, "o2", "2026-03-08T13:00:00Z", [{ product: "mug", qty: 1, price: 15 }]);
  await seedOrder(store, "o3", "2026-03-08T14:00:00Z", [{ product: "gift", qty: 1, price: 8 }]);
  await seedOrder(store, "o4", "2026-03-08T15:00:00Z", [{ product: "old", qty: 1, price: 7 }]);
  await seedOrder(store, "o5", "2026-03-08T16:00:00Z", [{ product: "tee", qty: 1, price: 20 }], { cancelled: true });
  // One tee of o1 refunded on the 9th: on the day of the refund, with the return's sign.
  await systemDb.orderSale.create({
    data: { workspaceId: store.workspaceId, storeId: store.id, orderId: o1.id, shopifyId: "o1-refund", localDay: "2026-03-09", happenedAt: new Date("2026-03-09T10:00:00Z"), actionType: "return", lineType: "product", lineItemShopifyId: "o1-0", quantity: 1, amount: -17.5, discount: 0, tax: 0 },
  });
  // The days just before the dates: one tee, which is none of the dates' sales.
  await seedOrder(store, "o0", "2026-03-06T12:00:00Z", [{ product: "tee", qty: 1, price: 20 }]);
}

const get = (headers: Record<string, string>, ws: string, storeId: string, qs = RANGE) =>
  ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${storeId}/analytics/collections/sales?${qs}`, headers });

describe("sales by collection (GET .../analytics/collections/sales)", () => {
  it("counts a product's sales in each of its collections, orders once per collection, refunds on their own day", async () => {
    const { a, ws, store } = await owner();
    await catalog(store);
    await trade(store);
    const res = await get(a.headers, ws, store.id);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ complete: true, range: { from: "2026-03-08", to: "2026-03-09" }, total: 3 });
    // The dates alone: nothing of the period before is named or worked out.
    for (const k of ["previous", "baseline", "pendingBaselineOrders"]) expect(body).not.toHaveProperty(k);
    expect(body.items.map((c: { title: string }) => c.title)).toEqual(["Summer", "Sale", "Home"]);
    const [summer, sale, home] = body.items;
    // Tee 2 × 20 less 5, Hat 10, o5's tee sold and cancelled, one tee refunded the next day.
    expect(summer).toMatchObject({ collectionId: "10", netSales: 27.5, grossSales: 70, discounts: 5, returns: 37.5, units: 2, orders: 2, productsSold: 2 });
    // The tee alone: the same tee sales as in Summer.
    expect(sale).toMatchObject({ collectionId: "11", netSales: 17.5, grossSales: 60, discounts: 5, returns: 37.5, units: 1, orders: 2, productsSold: 1 });
    expect(home).toMatchObject({ collectionId: "12", netSales: 15, units: 1, orders: 1, productsSold: 1 });
    // Each sale once: the shares are of these, and add up to more than 100% with the tee in two collections.
    expect(body.totals).toMatchObject({ netSales: 57.5, units: 5, orders: 5, productsSold: 5 });
    expect(summer.share).toBeCloseTo(27.5 / 57.5, 9);
    expect(body.items.reduce((s: number, c: { share: number }) => s + c.share, 0) + body.none.share + body.unknown.share).toBeGreaterThan(1);
    // The gift is in no collection; Old's collections were never read: neither is guessed.
    expect(body.none).toMatchObject({ netSales: 8, units: 1, orders: 1 });
    expect(body.unknown).toMatchObject({ netSales: 7, units: 1, orders: 1 });
    for (const f of [summer, home, body.totals, body.none, body.unknown]) for (const k of ["previous", "deltas"]) expect(f).not.toHaveProperty(k);

    // The 9th alone: only the refund, a negative sale of Summer and Sale, and no order.
    const fresh = await systemDb.store.findUniqueOrThrow({ where: { id: store.id } });
    const ninth = await withTenant(ws, (tx) => collectionSales(tx, { ws, storeId: store.id }, fresh, { from: "2026-03-09", to: "2026-03-09" }));
    expect(ninth.items.map((c: { title: string; netSales: number; units: number; orders: number }) => [c.title, c.netSales, c.units, c.orders])).toEqual([
      ["Sale", -17.5, -1, 0],
      ["Summer", -17.5, -1, 0],
    ]);
    expect(ninth.none).toBeNull();
  });

  it("lists only the collections that sold in the dates, by net sales then title", async () => {
    const { a, ws, store } = await owner();
    await catalog(store);
    await seedOrder(store, "now", "2026-03-08T12:00:00Z", [{ product: "mug", qty: 2, price: 10 }, { product: "hat", qty: 2, price: 10 }]);
    await seedOrder(store, "then", "2026-03-06T12:00:00Z", [{ product: "tee", qty: 1, price: 30 }]);
    const body = (await get(a.headers, ws, store.id)).json();
    // The tee (Sale, and Summer too) sold only two days before the dates: Sale isn't listed with $0.
    expect(body.items.map((c: { title: string; netSales: number }) => [c.title, c.netSales])).toEqual([
      ["Home", 20],
      ["Summer", 20],
    ]);
    expect(body.total).toBe(2);
    expect(body.totals).toMatchObject({ netSales: 40, units: 4, orders: 1 });
  });

  it("gives the dates' sales whether or not the days before them were imported", async () => {
    const { a, ws, store } = await owner();
    // Shopify shared orders from the 7th on: the days just before the dates aren't all in.
    await systemDb.store.update({ where: { id: store.id }, data: { ordersHistoryFrom: new Date("2026-03-07T00:00:00Z") } });
    await catalog(store);
    await trade(store);
    await systemDb.order.deleteMany({ where: { shopifyId: "o0" } });
    // An order of the day before whose sales haven't been read yet doesn't hold the dates' figures back.
    await seedOrder(store, "late-before", "2026-03-07T12:00:00Z", [{ product: "mug", qty: 1, price: 15 }], { pending: true });
    const res = await get(a.headers, ws, store.id);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ complete: true, pendingOrders: 0, historyFrom: "2026-03-07" });
    expect(body.items[0]).toMatchObject({ title: "Summer", netSales: 27.5 });
  });

  it("answers a 366-day range, and a preset by its name", async () => {
    // What the products page sends for a financial year with a 29 February in it.
    const { a, ws, store } = await owner();
    const res = await get(a.headers, ws, store.id, "preset=custom&from=2023-07-01&to=2024-06-30");
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ range: { from: "2023-07-01", to: "2024-06-30" } });
    const week = await get(a.headers, ws, store.id, "preset=wtd");
    expect(week.statusCode, week.body).toBe(200);
    expect(week.json().range.from <= week.json().range.to).toBe(true);
  });

  it("withholds every figure until the dates' sales are all in", async () => {
    const { a, ws, store } = await owner();
    await catalog(store);
    await trade(store);
    // An order whose sales haven't been read yet.
    await seedOrder(store, "late", "2026-03-09T12:00:00Z", [{ product: "mug", qty: 1, price: 15 }], { pending: true });
    expect((await get(a.headers, ws, store.id)).json()).toMatchObject({ complete: false, pendingOrders: 1, total: 0, items: [], none: null, unknown: null, totals: null });
    // Dates from before the imported orders begin: not "no sales".
    await systemDb.order.deleteMany({ where: { shopifyId: "late" } });
    await systemDb.store.update({ where: { id: store.id }, data: { ordersHistoryFrom: new Date("2026-03-01T00:00:00Z") } });
    const early = (await get(a.headers, ws, store.id, "preset=custom&from=2026-02-20&to=2026-02-21")).json();
    expect(early).toMatchObject({ complete: false, historyFrom: "2026-03-01", items: [], totals: null });
    // A sale whose product can't be known.
    await systemDb.store.update({ where: { id: store.id }, data: { ordersHistoryFrom: new Date(0) } });
    await seedOrder(store, "lost", "2026-03-08T18:00:00Z", [{ product: null, qty: 1, price: 5 }]);
    expect((await get(a.headers, ws, store.id)).json()).toMatchObject({ complete: false, unknownIdentitySales: 1, items: [], totals: null });
  });

  it("adds up more than 10,000 orders without a cap", async () => {
    const { a, ws, store } = await owner();
    await seedProduct(store, "popular", "Popular", [SUMMER, SALE]);
    const at = new Date("2026-03-08T18:00:00Z");
    const ids = Array.from({ length: 10001 }, (_, i) => `scale-${i}`);
    await systemDb.order.createMany({ data: ids.map((id) => ({ id, workspaceId: ws, storeId: store.id, shopifyId: id, name: id, currency: "USD", localDay: "2026-03-08", shopifyCreatedAt: at, shopifyUpdatedAt: at, salesUpdatedAt: at, subtotal: 1, totalDiscounts: 0, totalTax: 0, totalShipping: 0, totalPrice: 1 })) });
    await systemDb.orderLineItem.createMany({ data: ids.map((id) => ({ workspaceId: ws, storeId: store.id, orderId: id, shopifyId: id, productShopifyId: "popular", title: "Popular", quantity: 1, price: 1, discount: 0 })) });
    await systemDb.orderSale.createMany({ data: ids.map((id) => ({ workspaceId: ws, storeId: store.id, orderId: id, shopifyId: id, lineItemShopifyId: id, localDay: "2026-03-08", happenedAt: at, actionType: "order", lineType: "product", quantity: 1, amount: 1, discount: 0, tax: 0 })) });
    const res = await get(a.headers, ws, store.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().items.map((c: { title: string; netSales: number; units: number; orders: number }) => [c.title, c.netSales, c.units, c.orders])).toEqual([
      ["Sale", 10001, 10001, 10001],
      ["Summer", 10001, 10001, 10001],
    ]);
  }, 60000);

  it("says when the collections were last read from Shopify", async () => {
    const { a, ws, store } = await owner();
    const at = new Date("2026-03-10T02:00:00Z");
    await systemDb.syncJob.create({ data: { workspaceId: ws, storeId: store.id, kind: "products", status: "succeeded", finishedAt: new Date("2026-03-09T02:00:00Z") } });
    await systemDb.syncJob.create({ data: { workspaceId: ws, storeId: store.id, kind: "products", status: "succeeded", finishedAt: at } });
    await systemDb.syncJob.create({ data: { workspaceId: ws, storeId: store.id, kind: "products", status: "failed", finishedAt: new Date("2026-03-11T02:00:00Z") } });
    await systemDb.syncJob.create({ data: { workspaceId: ws, storeId: store.id, kind: "orders", status: "succeeded", finishedAt: new Date("2026-03-12T02:00:00Z") } });
    expect((await get(a.headers, ws, store.id)).json().membershipAsOf).toBe(at.toISOString());
  });

  it("needs View product performance and the store's orders and products", async () => {
    const { ws, store } = await owner();
    const sales = await signIn(ctx, "us", "s@x.com");
    await systemDb.membership.create({ data: { workspaceId: ws, userId: sales.user.id, role: "custom", permissions: ["analytics.sales", "products.view"] } });
    expect((await get(sales.headers, ws, store.id)).statusCode).toBe(403);
    const performance = await signIn(ctx, "up", "p@x.com");
    await systemDb.membership.create({ data: { workspaceId: ws, userId: performance.user.id, role: "custom", permissions: ["products.performance"] } });
    expect((await get(performance.headers, ws, store.id)).statusCode).toBe(200);
    const ordersOnly = await createStore(ws, "o.myshopify.com", ["read_orders"]);
    const refused = await get(performance.headers, ws, ordersOnly.id);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe("missing_scope");
  });

  it("answers 404 for another workspace's store before reading the question, and keeps each store's catalog its own", async () => {
    const { a, ws, store } = await owner();
    await catalog(store);
    await trade(store);
    const b = await signIn(ctx, "ub", "b@x.com");
    const wsB = await createWorkspace(ctx, b.headers, "B");
    const storeB = await createStore(wsB, "b.myshopify.com", SCOPES, { ordersHistoryFrom: new Date(0) });
    // The same product ids in the other business, in other collections, with sales of their own.
    await seedProduct(storeB, "gift", "Gift", [{ id: "99", title: "Their collection" }]);
    await seedProduct(storeB, "mug", "Mug", [{ id: "12", title: "Their home" }]);
    await seedOrder(storeB, "b1", "2026-03-08T12:00:00Z", [{ product: "gift", qty: 3, price: 100 }, { product: "mug", qty: 1, price: 50 }]);
    for (const qs of [RANGE, "preset=nonsense"]) {
      expect((await get(a.headers, ws, storeB.id, qs)).statusCode).toBe(404);
      expect((await get(a.headers, wsB, storeB.id, qs)).statusCode).toBe(404);
    }
    // One's own store with a question that can't be read is a 400.
    expect((await get(a.headers, ws, store.id, "preset=nonsense")).statusCode).toBe(400);
    const mine = (await get(a.headers, ws, store.id)).json();
    expect(mine.items.map((c: { collectionId: string; title: string; netSales: number }) => [c.collectionId, c.title, c.netSales])).toEqual([
      ["10", "Summer", 27.5],
      ["11", "Sale", 17.5],
      ["12", "Home", 15],
    ]);
    expect(mine.none).toMatchObject({ netSales: 8 });
    expect(mine.totals.netSales).toBe(57.5);
    const theirs = (await get(b.headers, wsB, storeB.id)).json();
    expect(theirs.items.map((c: { title: string; netSales: number }) => [c.title, c.netSales])).toEqual([
      ["Their collection", 300],
      ["Their home", 50],
    ]);
  });
});

describe("top products narrowed to a collection (collectionId)", () => {
  it("ranks only the collection's products", async () => {
    const { a, ws, store } = await owner();
    await catalog(store);
    await trade(store);
    const top = (collectionId?: string) =>
      ctx.app.inject({
        method: "GET",
        url: `/workspaces/${ws}/stores/${store.id}/analytics/products/top-selling?dateFrom=2026-03-08&dateTo=2026-03-09${collectionId ? `&collectionId=${collectionId}` : ""}`,
        headers: a.headers,
      });
    expect((await top()).json().items.map((p: { productId: string }) => p.productId).sort()).toEqual(["gift", "hat", "mug", "old", "tee"]);
    const summer = (await top("10")).json();
    expect(summer.items.map((p: { productId: string; revenue: number }) => [p.productId, p.revenue])).toEqual([
      ["tee", 17.5],
      ["hat", 10],
    ]);
    expect((await top("12")).json().items.map((p: { productId: string }) => p.productId)).toEqual(["mug"]);
    expect((await top("404")).json().items).toEqual([]);
  });
});

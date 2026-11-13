import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { logger, recomputeDays } from "@app/core";
import { systemDb, withTenant } from "@app/db";
import { addDays, adsenseFinalThrough, daysBetweenInclusive, localDay, monthsEarlier, resolvePreset, yearEarlier } from "@app/shared";
import { storeOverview, syncProblem } from "@app/core/reports";
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
  /** Shopify's payment state, lowercase; paid when not given. */
  financial?: string | null;
  subtotal?: number;
  discounts?: number;
  tax?: number;
  shipping?: number;
  source?: string | null;
  fulfillment?: string | null;
  fulfilledAfterHours?: number;
  codes?: string[];
  lines?: SeedLine[];
  traffic?: { source: string; medium: string; campaign?: string; host?: string };
}

/**
 * Shopify's sales records for a seeded order: a sale per line (or one for the subtotal when it has
 * no lines), its tax on the first, a shipping sale, and for a cancelled order the reversal of all
 * of it at the moment of cancellation (the order's own here), as Shopify records them.
 */
function seedSales(store: Store, o: SeedOrder, created: Date) {
  const tax = o.tax ?? 0;
  const shipping = o.shipping ?? 0;
  const day = localDay(created, store.timezone);
  const placed = (o.lines?.length ? o.lines : [{ qty: 1, price: o.subtotal ?? 0 }]).map((l: SeedLine, i) => ({
    lineType: "product",
    lineItemShopifyId: o.lines?.length ? `${o.id}-${i}` : null,
    quantity: l.qty,
    amount: l.qty * l.price - (l.discount ?? 0) + (i === 0 ? tax : 0),
    discount: l.discount ?? 0,
    tax: i === 0 ? tax : 0,
  }));
  if (shipping) placed.push({ lineType: "shipping", lineItemShopifyId: null, quantity: 0, amount: shipping, discount: 0, tax: 0 });
  const rows = [
    ...placed.map((x) => ({ ...x, actionType: "order" })),
    ...(o.cancelled ? placed.map((x) => ({ ...x, actionType: "return", amount: -x.amount, tax: -x.tax, discount: 0 })) : []),
  ];
  return rows.map((x, i) => ({ ...x, workspaceId: store.workspaceId, storeId: store.id, shopifyId: `${o.id}-sale-${i}`, localDay: day, happenedAt: created }));
}

/** Insert an order the way the pipeline stores it (UTC timestamps, store-local day, Shopify's sales). */
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
      financialStatus: o.financial === undefined ? "paid" : o.financial,
      subtotal,
      totalDiscounts: o.discounts ?? 0,
      totalTax: tax,
      totalShipping: shipping,
      totalPrice: subtotal + tax + shipping,
      sourceName: o.source ?? null,
      fulfillmentStatus: o.fulfillment ?? null,
      fulfilledAt: o.fulfilledAfterHours === undefined ? null : new Date(created.getTime() + o.fulfilledAfterHours * 3_600_000),
      discountCodes: o.codes ?? [],
      trafficSource: o.traffic?.source ?? null,
      trafficMedium: o.traffic?.medium ?? null,
      trafficCampaign: o.traffic?.campaign ?? null,
      referrerHost: o.traffic?.host ?? null,
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
      salesUpdatedAt: created,
      sales: { create: seedSales(store, o, created) },
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
    // F: cancelled the same day: an order of that day (as Shopify counts it) whose sale is reversed,
    // so it adds nothing to sales; timing and shipping leave it out.
    await seedOrder(store, { id: "F", createdAt: "2026-03-09T20:00:00Z", cancelled: true, subtotal: 500, tax: 100, source: "web", fulfillment: "unfulfilled", codes: ["SAVE10"], lines: [{ product: "p1", qty: 5, price: 100 }] });
    await recomputeDays(store, ["2026-03-06", "2026-03-07", "2026-03-08", "2026-03-09"]);
  }

  it("works out product costs from each item's cost per item in Shopify while Shopify's profit report gives none", async () => {
    const { a, ws, store } = await owner();
    await seedVariant(store, "p1", "v1", { qty: 10, price: 50, cost: 20 });
    await seedVariant(store, "p2", "v2", { qty: 10, price: 30, cost: 7 });
    await seedWeekend(store);
    const m = (await overview(a.headers, ws, store.id, RANGE)).json().modules;
    // B: v1 × 1 and v2 × 2, C: v1 × 1 → 2 × 20 + 2 × 7. D and E sold items with no variant, so no
    // cost per item (30 + 20 of net sales); F's 5 came back with its cancellation, at no cost either way.
    expect(m.product_costs).toEqual({ current: { costOfGoodsSold: 54, netSalesWithCost: 150, netSalesWithoutCost: 50 } });
    expect(m.product_costs.current.netSalesWithCost + m.product_costs.current.netSalesWithoutCost).toBe(m.sales_overview.current.netSales);

    // A member not shown costs ("View costs and stock value") gets none, as with Shopify's report.
    const v = await signIn(ctx, "uv", "v@x.com");
    const membership = await systemDb.membership.create({ data: { workspaceId: ws, userId: v.user.id, role: "custom", permissions: ["analytics.sales", "finance.breakdown"] } });
    expect((await overview(v.headers, ws, store.id, RANGE)).json().modules.product_costs).toBeUndefined();
    await systemDb.membership.update({ where: { id: membership.id }, data: { permissions: ["analytics.sales", "finance.breakdown", "inventory.view", "inventory.costs"] } });
    expect((await overview(v.headers, ws, store.id, RANGE)).json().modules.product_costs).toEqual(m.product_costs);
  });

  it("computes channels, timing, fulfillment, discount codes, tax/shipping and vendors for the range", async () => {
    const { a, ws, store } = await owner();
    await seedWeekend(store);
    const res = await overview(a.headers, ws, store.id, RANGE);
    expect(res.statusCode).toBe(200);
    const { modules: m, range, data } = res.json();
    expect(range).toEqual({ from: "2026-03-07", to: "2026-03-09" });

    // B 8 + C 4 + D 2.40 (F's 100 is reversed by its cancellation); B 5 + D 3. The cancellation took
    // F's 600 (tax in) off total sales: what the Total sales tile says refunds took.
    expect(m.sales_overview.current).toMatchObject({ tax: 14.4, shipping: 8, netSales: 200, totalSales: 222.4, totalRefunded: 600, returns: 500, orders: 5 });

    expect(m.channels.items).toEqual([
      { source: "web", label: "Online Store", orders: 3, sales: 150, share: 0.75 },
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

    // From the orders' sales records, before tax: B 10 + C 5 + D 3 of discounts, 100 + 50 + 30 of net
    // sales. F (cancelled) used SAVE10 too, so it is one of its orders, as in Shopify's sales by
    // discount, with nothing discounted and its net sales back to 0. (The orders' totals would say
    // otherwise: they include tax, and shipping discounts.)
    expect(m.discount_codes.items).toEqual([
      { code: "SAVE10", orders: 4, discount: 18, sales: 180 },
      { code: "FREESHIP", orders: 1, discount: 5, sales: 50 },
    ]);

    // Vendor net sales from the product sales in the range (F sold and reversed nets to 0); unknown products skipped.
    expect(m.catalog.topVendors).toEqual([
      { vendor: "Acme", revenue: 100, units: 2 },
      { vendor: "Beta", revenue: 80, units: 3 },
    ]);
    expect(m.catalog.products).toEqual({ active: 2, draft: 0, archived: 0, total: 2 });

    // Where the dates begin (no creation date read yet: the first order's day), and the orders older
    // than Shopify's 60 days out of reach until Shopify approves bizinsights for them.
    expect(data).toEqual({ orders: 6, products: 2, variants: 0, oldestOrderDay: "2026-03-06", newestOrderDay: "2026-03-09", historyFrom: "2026-03-06", createdDay: null, startDay: "2026-03-06", history: { access: "awaiting_shopify", years: [] } });
  });

  it("lists the latest orders placed in the dates, flagging cancelled ones, and counts the dates' cancellations", async () => {
    const { a, ws, store } = await owner();
    await seedWeekend(store);
    // Dates without any of them: none, like every other section for those dates.
    const none = (await overview(a.headers, ws, store.id, "preset=7d")).json().modules.recent_orders;
    expect(none).toEqual({ items: [], cancelledInRange: 0 });
    const res = await overview(a.headers, ws, store.id, "preset=custom&from=2026-03-01&to=2026-03-31");
    const { items, cancelledInRange } = res.json().modules.recent_orders;
    expect(items.map((o: { name: string }) => o.name)).toEqual(["#F", "#E", "#D", "#C", "#B", "#A"]);
    // F was cancelled on 9 Mar (New York): counted on the day of the cancellation.
    expect(cancelledInRange).toBe(1);
    // The weekend alone: A (Friday night, New York) isn't in it.
    const weekend = (await overview(a.headers, ws, store.id, RANGE)).json().modules.recent_orders.items;
    expect(weekend.map((o: { name: string }) => o.name)).toEqual(["#F", "#E", "#D", "#C", "#B"]);
    expect(items[0]).toMatchObject({ shopifyId: "F", createdAt: "2026-03-09T20:00:00.000Z", total: 600, cancelled: true, channel: "Online Store", units: 5, fulfillmentStatus: "unfulfilled", financialStatus: "paid" });
    expect(items[4]).toMatchObject({ name: "#B", total: 113, units: 3, cancelled: false, fulfillmentStatus: "fulfilled" });
    expect(items[1]).toMatchObject({ channel: "Unknown", fulfillmentStatus: null });
    expect(typeof items[0].id).toBe("string");
  });

  it("says how the dates' orders went: completed, awaiting payment, unsuccessful, what was sent, and checkouts left", async () => {
    const { a, ws, store } = await owner([...ALL_SCOPES, "write_pixels", "read_customer_events"]);
    await seedWeekend(store);
    // Without the storefront pixel there is no count of checkouts left, which isn't the same as none.
    const before = (await overview(a.headers, ws, store.id, RANGE)).json().modules.order_outcomes;
    // The Orders tile's 5 orders: B, C, D and E paid, F cancelled (and left out of what is to send).
    expect(before).toEqual({
      orders: 5,
      outcome: { completed: 4, awaitingPayment: 0, unsuccessful: 1, cancelled: 1, paymentFailed: 0, refunded: 0 },
      // B sent (3 items), C partly, D still to send; E's status isn't known yet, so it is in none of the three.
      shipping: { orders: 4, sent: 1, partlySent: 1, notSent: 1, items: 9, itemsSent: 3 },
      checkouts: null,
    });

    // Monday 9 March (New York): cash on delivery not paid yet, a payment voided, an authorization run out, one refunded in full.
    const monday = (id: string, financial: string, hour: number, fulfillment = "unfulfilled") =>
      seedOrder(store, { id, createdAt: `2026-03-09T${hour}:00:00Z`, financial, subtotal: 10, fulfillment, lines: [{ product: "p1", qty: 2, price: 5 }] });
    await monday("G", "pending", 14);
    await monday("H", "voided", 15);
    await monday("I", "expired", 16);
    await monday("J", "refunded", 17, "restocked");
    await monday("K", "authorized", 18, "fulfilled");
    // An order of gift cards only isn't an order of the Orders tile.
    await systemDb.order.create({
      data: { workspaceId: ws, storeId: store.id, shopifyId: "GC", name: "#GC", currency: "USD", localDay: "2026-03-09", shopifyCreatedAt: new Date("2026-03-09T19:00:00Z"), shopifyUpdatedAt: new Date(), giftCardOnly: true, financialStatus: "pending", subtotal: 50, totalDiscounts: 0, totalTax: 0, totalShipping: 0, totalPrice: 50 },
    });
    // The pixel counted Monday in full: four shoppers started a checkout, one bought; one never got that far.
    await systemDb.store.update({ where: { id: store.id }, data: { pixelInstalled: true, pixelInstalledAt: new Date("2026-03-08T12:00:00Z") } });
    const visit = (day: string, visitor: string, step: number) => systemDb.funnelVisit.create({ data: { workspaceId: ws, storeId: store.id, day, visitor, furthestStep: step } });
    for (const [visitor, step] of [["v1", 3], ["v2", 3], ["v3", 4], ["v4", 2]] as const) await visit("2026-03-09", visitor, step);
    await visit("2026-03-08", "v5", 3);
    await recomputeDays(store, ["2026-03-09"]);

    const res = (await overview(a.headers, ws, store.id, "preset=custom&from=2026-03-09&to=2026-03-09")).json();
    // Monday's orders (D was Sunday night in New York), as the Orders tile counts them.
    expect(res.modules.sales_overview.current.orders).toBe(7);
    expect(res.modules.order_outcomes).toEqual({
      orders: 7,
      // E paid; G pending and K authorized wait on the money; F cancelled, H and I failed, J refunded.
      outcome: { completed: 1, awaitingPayment: 2, unsuccessful: 4, cancelled: 1, paymentFailed: 2, refunded: 1 },
      // E, G and K go ahead: K sent (2 items), G still to send, E's status not known yet.
      shipping: { orders: 3, sent: 1, partlySent: 0, notSent: 1, items: 8, itemsSent: 2 },
      checkouts: { started: 3, completed: 1, left: 2, from: null },
    });
    // The pixel began in the middle of Sunday: the weekend's checkouts count from Monday, and say so.
    expect((await overview(a.headers, ws, store.id, RANGE)).json().modules.order_outcomes.checkouts).toEqual({ started: 3, completed: 1, left: 2, from: "2026-03-09" });
    // Dates before the pixel: not counted.
    expect((await overview(a.headers, ws, store.id, "preset=custom&from=2026-03-07&to=2026-03-07")).json().modules.order_outcomes.checkouts).toBeNull();
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
    expect(m.order_outcomes).toEqual({
      orders: 0,
      outcome: { completed: 0, awaitingPayment: 0, unsuccessful: 0, cancelled: 0, paymentFailed: 0, refunded: 0 },
      shipping: { orders: 0, sent: 0, partlySent: 0, notSent: 0, items: 0, itemsSent: 0 },
      checkouts: null,
    });
    expect(m.inventory).toEqual({
      current: { trackedVariants: 0, unitsInStock: 0, stockValueAtCost: null, variantsWithCost: 0, retailValue: 0, outOfStock: 0, lowStock: 0 },
      lowStockItems: [],
    });
    expect(m.catalog).toEqual({ products: { active: 0, draft: 0, archived: 0, total: 0 }, variants: 0, topVendors: [] });
    expect(m.sales_overview.current).toMatchObject({ tax: 0, shipping: 0 });
    expect(data).toEqual({ orders: 0, products: 0, variants: 0, oldestOrderDay: null, newestOrderDay: null, historyFrom: null, createdDay: null, startDay: null, history: { access: "awaiting_shopify", years: [] } });
  });
});

describe("the order list (GET …/orders, the Orders & shipping page)", () => {
  const MARCH = "preset=custom&from=2026-03-01&to=2026-03-31";
  interface Item { id: string; name: string; total: number; createdAt: string; financialStatus?: string | null; fulfillmentStatus?: string | null; cancelled?: boolean }

  function list(headers: Record<string, string>, ws: string, storeId: string, qs = MARCH) {
    return ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${storeId}/orders?${qs}`, headers });
  }
  /** The order numbers of an answer that must be a 200. */
  async function names(headers: Record<string, string>, ws: string, storeId: string, qs: string): Promise<string[]> {
    const res = await list(headers, ws, storeId, qs);
    expect(res.statusCode, `${qs}: ${res.body}`).toBe(200);
    return (res.json().items as Item[]).map((o) => o.name);
  }

  /**
   * March 2026 in New York (EDT from the 8th): one order in each payment and fulfillment state worth
   * telling apart, 12 orders placed at the same moment for the same total (only their ids tell them
   * apart), one placed on 28 February local time (1 March in UTC) and one on 31 March local time
   * (1 April in UTC). 21 orders in March.
   */
  async function seedMarch(store: Store) {
    const at = (day: string) => `2026-03-${day}T15:00:00Z`;
    const one = (id: string, createdAt: string, subtotal: number, financial: string | null, fulfillment: string | null, cancelled = false) =>
      seedOrder(store, { id, createdAt, subtotal, financial, fulfillment, cancelled, source: "web", lines: [{ qty: 2, price: subtotal / 2 }] });
    await one("0999", "2026-03-01T03:00:00Z", 99, "paid", "fulfilled");
    await one("1001", at("10"), 50, "paid", "fulfilled");
    await one("1002", at("11"), 20, "pending", "unfulfilled");
    await one("1003", at("12"), 80, "authorized", "partially_fulfilled");
    await one("1004", at("13"), 30, "refunded", "restocked", true);
    await one("1005", at("14"), 40, "partially_refunded", "fulfilled");
    await one("1006", at("15"), 10, "voided", null, true);
    await one("1007", at("16"), 60, null, "on_hold");
    await one("EU-12", at("17"), 15, "expired", "unfulfilled");
    await one("3001", "2026-04-01T03:00:00Z", 70, "partially_paid", "fulfilled");
    for (let i = 1; i <= 12; i++) await one(`50${String(i).padStart(2, "0")}`, "2026-03-20T12:00:00Z", 25, "paid", null);
  }

  it("pages through the orders placed in the dates (store-local days), each as the overview's recent orders give it", async () => {
    const { a, ws, store } = await owner();
    await seedMarch(store);
    const res = await list(a.headers, ws, store.id, `${MARCH}&pageSize=100`);
    expect(res.statusCode, res.body).toBe(200);
    const all = res.json();
    expect(Object.keys(all).sort()).toEqual(["items", "page", "pageSize", "range", "total"]);
    expect(all).toMatchObject({ range: { from: "2026-03-01", to: "2026-03-31" }, total: 21, page: 1, pageSize: 100 });
    // 28 February in New York is out, 31 March in New York is in, whatever the UTC date says.
    const listed = (all.items as Item[]).map((o) => o.name);
    expect(listed).toHaveLength(21);
    expect(listed).not.toContain("#0999");
    expect(listed[0]).toBe("#3001");
    // Every field of every order, exactly the overview's: its recent orders are the list's first 10, newest first.
    const recent = (await overview(a.headers, ws, store.id, MARCH)).json().modules.recent_orders.items;
    expect(all.items.slice(0, 10)).toEqual(recent);
    expect(all.items.find((o: Item) => o.name === "#1004")).toEqual({
      id: expect.any(String), shopifyId: "1004", name: "#1004", createdAt: "2026-03-13T15:00:00.000Z", total: 30,
      financialStatus: "refunded", fulfillmentStatus: "restocked", channel: "Online Store", units: 2, cancelled: true,
    });

    // The default page: 25 newest first.
    const first = (await list(a.headers, ws, store.id)).json();
    expect(first).toMatchObject({ total: 21, page: 1, pageSize: 25 });
    expect(first.items).toEqual(all.items);
    // Fewer days, fewer orders.
    expect(await names(a.headers, ws, store.id, "preset=custom&from=2026-03-10&to=2026-03-12")).toEqual(["#1003", "#1002", "#1001"]);
    // The default dates (the last 30 days) hold none of them.
    const now = (await list(a.headers, ws, store.id, "")).json();
    expect(now).toMatchObject({ total: 0, items: [] });
    expect(now.range.to).toBe(localDay(new Date(), TZ));
  });

  it("sorts newest, oldest or by total, the order's id breaking ties, so pages never overlap or skip one", async () => {
    const { a, ws, store } = await owner();
    await seedMarch(store);
    for (const sort of ["newest", "oldest", "total_desc", "total_asc"]) {
      const whole = (await list(a.headers, ws, store.id, `${MARCH}&sort=${sort}&pageSize=100`)).json().items as Item[];
      const pages: Item[] = [];
      for (const page of [1, 2, 3]) {
        const res = (await list(a.headers, ws, store.id, `${MARCH}&sort=${sort}&pageSize=10&page=${page}`)).json();
        expect(res).toMatchObject({ total: 21, page, pageSize: 10 });
        expect(res.items, `${sort} page ${page}`).toHaveLength(page < 3 ? 10 : 1);
        pages.push(...res.items);
      }
      expect(pages.map((o) => o.id), sort).toEqual(whole.map((o) => o.id));
      expect(new Set(pages.map((o) => o.id)).size).toBe(21);
      // Asked again, the same page.
      expect((await list(a.headers, ws, store.id, `${MARCH}&sort=${sort}&pageSize=10&page=2`)).json().items).toEqual(pages.slice(10, 20));
      // Past the last page: none, and still how many there are.
      expect((await list(a.headers, ws, store.id, `${MARCH}&sort=${sort}&pageSize=10&page=4`)).json()).toMatchObject({ total: 21, page: 4, items: [] });

      const totals = whole.map((o) => o.total);
      const times = whole.map((o) => o.createdAt);
      if (sort === "total_desc") expect(totals).toEqual([...totals].sort((x, y) => y - x));
      if (sort === "total_asc") expect(totals).toEqual([...totals].sort((x, y) => x - y));
      if (sort === "newest") expect(times).toEqual([...times].sort().reverse());
      if (sort === "oldest") expect(times).toEqual([...times].sort());
      // The 12 orders placed at the same moment for the same total: in id order, by the sort's direction.
      const tied = whole.filter((o) => o.createdAt === "2026-03-20T12:00:00.000Z").map((o) => o.id);
      expect(tied).toHaveLength(12);
      expect(tied).toEqual(sort === "oldest" ? [...tied].sort() : [...tied].sort().reverse());
    }
    expect(await names(a.headers, ws, store.id, `${MARCH}&sort=total_desc&pageSize=10`).then((n) => n.slice(0, 4))).toEqual(["#1003", "#3001", "#1007", "#1001"]);
    expect(await names(a.headers, ws, store.id, `${MARCH}&sort=total_asc&pageSize=10`).then((n) => n.slice(0, 3))).toEqual(["#1006", "#EU-12", "#1002"]);
  });

  it("filters by payment, shipping and cancellation, and searches order numbers", async () => {
    const { a, ws, store } = await owner();
    await seedMarch(store);
    const bulk = Array.from({ length: 12 }, (_, i) => `#50${String(i + 1).padStart(2, "0")}`);
    const of = async (qs: string) => (await names(a.headers, ws, store.id, `${MARCH}&pageSize=100&${qs}`)).sort();

    // Payment: paid; waiting on the money; refunded in full or in part; anything else, or not known.
    expect(await of("payment=paid")).toEqual(["#1001", ...bulk].sort());
    expect(await of("payment=pending")).toEqual(["#1002", "#1003", "#3001"]);
    expect(await of("payment=refunded")).toEqual(["#1004", "#1005"]);
    expect(await of("payment=other")).toEqual(["#1006", "#1007", "#EU-12"]);
    // Shipping: sent in full, in part, or nothing sent (restocked, on hold, or not known yet included).
    expect(await of("shipping=shipped")).toEqual(["#1001", "#1005", "#3001"]);
    expect(await of("shipping=partly")).toEqual(["#1003"]);
    expect(await of("shipping=not_shipped")).toEqual(["#1002", "#1004", "#1006", "#1007", "#EU-12", ...bulk].sort());
    expect(await of("cancelled=only")).toEqual(["#1004", "#1006"]);
    expect(await of("cancelled=exclude")).toHaveLength(19);
    expect(await of("payment=paid&shipping=shipped&cancelled=exclude")).toEqual(["#1001"]);
    // The total counts the filtered orders.
    expect((await list(a.headers, ws, store.id, `${MARCH}&payment=paid&pageSize=10`)).json()).toMatchObject({ total: 13, pageSize: 10 });

    // Part of an order number, any case, its "#" optional; LIKE's wildcards are only themselves.
    expect(await of("q=100")).toEqual(["#1001", "#1002", "#1003", "#1004", "#1005", "#1006", "#1007"]);
    expect(await of("q=1003")).toEqual(["#1003"]);
    expect(await of(`q=${encodeURIComponent("#1003")}`)).toEqual(["#1003"]);
    expect(await of(`q=${encodeURIComponent("  #eu-1 ")}`)).toEqual(["#EU-12"]);
    expect(await of("q=100&cancelled=only")).toEqual(["#1004", "#1006"]);
    expect(await of(`q=${encodeURIComponent("%")}`)).toEqual([]);
    expect(await of(`q=${encodeURIComponent("1_0")}`)).toEqual([]);
    expect(await of("q=0999")).toEqual([]);
    // Nothing but a "#": every order.
    expect(await of(`q=${encodeURIComponent("#")}`)).toHaveLength(21);
  });

  it("refuses a question it can't answer with a 400, and a store without order access with a 403", async () => {
    const { a, ws, store } = await owner();
    for (const qs of ["pageSize=9", "pageSize=101", "page=0", "page=x", "sort=price", "payment=failed", "shipping=sent", "cancelled=yes", `q=${"1".repeat(41)}`]) {
      const res = await list(a.headers, ws, store.id, `${MARCH}&${qs}`);
      expect(res.statusCode, qs).toBe(400);
      expect(res.json().error, qs).toBe("validation");
    }
    for (const qs of ["preset=custom&from=2026-03-09&to=2026-03-01", "preset=custom&from=2026-03-09"]) {
      const res = await list(a.headers, ws, store.id, qs);
      expect(res.statusCode, qs).toBe(400);
      expect(res.json().error, qs).toBe("invalid_range");
    }
    const productsOnly = await createStore(ws, "p.myshopify.com", ["read_products"], { timezone: TZ });
    const res = await list(a.headers, ws, productsOnly.id);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("missing_scopes");
  });

  it("never reads another workspace's store (404) and never mixes stores", async () => {
    const { a, ws, store } = await owner();
    await seedMarch(store);
    const b = await signIn(ctx, "ub", "b@x.com");
    const wsB = await createWorkspace(ctx, b.headers, "B");
    const storeB = await createStore(wsB, "b.myshopify.com", ALL_SCOPES, { timezone: TZ });
    // The same Shopify ids and order numbers in the other business's store.
    await seedOrder(storeB, { id: "1001", createdAt: "2026-03-10T15:00:00Z", subtotal: 999, financial: "paid", fulfillment: "fulfilled" });

    expect((await list(b.headers, ws, store.id)).statusCode).toBe(404);
    expect((await list(b.headers, wsB, store.id)).statusCode).toBe(404);
    expect((await list(a.headers, ws, storeB.id)).statusCode).toBe(404);
    // A filter or a bad question changes nothing: still 404.
    expect((await list(b.headers, wsB, store.id, `${MARCH}&pageSize=5`)).statusCode).toBe(404);

    const mine = (await list(a.headers, ws, store.id, `${MARCH}&q=1001`)).json();
    expect(mine.total).toBe(1);
    expect(mine.items[0]).toMatchObject({ name: "#1001", total: 50 });
    expect((await list(b.headers, wsB, storeB.id, MARCH)).json()).toMatchObject({ total: 1, items: [{ name: "#1001", total: 999 }] });
  });

  it("needs View order list; payment status, fulfillment status and cancellations each need their own permission, to see or to filter by", async () => {
    const { a, ws, store } = await owner();
    await seedMarch(store);
    const m = await signIn(ctx, "um", "member@x.com");
    await systemDb.membership.create({ data: { workspaceId: ws, userId: m.user.id, role: "custom", permissions: ["analytics.sales", "orders.fulfillment"] } });
    const grant = (permissions: string[]) => systemDb.membership.update({ where: { workspaceId_userId: { workspaceId: ws, userId: m.user.id } }, data: { permissions } });
    const fields = async () => {
      const res = await list(m.headers, ws, store.id, `${MARCH}&q=1004`);
      expect(res.statusCode, res.body).toBe(200);
      return Object.keys(res.json().items[0]).sort();
    };
    const refused = async (qs: string) => {
      const res = await list(m.headers, ws, store.id, `${MARCH}&${qs}`);
      return res.statusCode === 403 && res.json().error === "forbidden";
    };
    const BASE = ["channel", "createdAt", "id", "name", "shopifyId", "total", "units"];

    // Fulfillment status alone isn't the order list.
    expect((await list(m.headers, ws, store.id)).statusCode).toBe(403);

    await grant(["orders.list"]);
    expect(await fields()).toEqual(BASE);
    // Searching, sorting and paging need nothing more; a filter on a hidden field is refused, whatever its value.
    expect((await list(m.headers, ws, store.id, `${MARCH}&q=100&sort=total_desc&page=2&pageSize=10`)).statusCode).toBe(200);
    for (const qs of ["payment=paid", "payment=other", "shipping=shipped", "shipping=not_shipped", "cancelled=only", "cancelled=exclude"]) expect(await refused(qs), qs).toBe(true);

    await grant(["orders.list", "orders.payments"]);
    expect(await fields()).toEqual([...BASE, "financialStatus"].sort());
    expect(await refused("payment=refunded")).toBe(false);
    expect(await names(m.headers, ws, store.id, `${MARCH}&payment=refunded`)).toEqual(["#1005", "#1004"]);
    expect(await refused("shipping=partly")).toBe(true);
    expect(await refused("cancelled=only")).toBe(true);

    await grant(["orders.list", "orders.fulfillment"]);
    expect(await fields()).toEqual([...BASE, "fulfillmentStatus"].sort());
    expect(await names(m.headers, ws, store.id, `${MARCH}&shipping=partly`)).toEqual(["#1003"]);
    expect(await refused("payment=paid")).toBe(true);
    expect(await refused("cancelled=exclude")).toBe(true);

    await grant(["orders.list", "orders.cancellations"]);
    expect(await fields()).toEqual([...BASE, "cancelled"].sort());
    expect(await names(m.headers, ws, store.id, `${MARCH}&cancelled=only`)).toEqual(["#1006", "#1004"]);
    expect(await refused("shipping=shipped")).toBe(true);

    await grant(["orders.list", "orders.payments", "orders.fulfillment", "orders.cancellations"]);
    const member = (await list(m.headers, ws, store.id, `${MARCH}&pageSize=100`)).json();
    // With every permission, exactly what the owner gets.
    expect(member).toEqual((await list(a.headers, ws, store.id, `${MARCH}&pageSize=100`)).json());
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
    // Each day carries the lines of its total sales too (here none besides net sales), what its
    // orders sold for, and how many were a customer's first (none here: no customer on them), and
    // the gross sales and discounts net sales is worked out from.
    const lines = { shipping: 0, tax: 0, duties: 0, additionalFees: 0 };
    const quiet = { grossSales: 0, discounts: 0, netSales: 0, totalSales: 0, ...lines, orders: 0, units: 0, refunds: 0, averageOrderValue: null, orderValue: 0, newCustomerOrders: 0 };
    expect(s.series).toEqual([
      { day: "2026-03-05", ...quiet },
      { day: "2026-03-06", grossSales: 40, discounts: 0, netSales: 40, totalSales: 40, ...lines, orders: 1, units: 1, refunds: 0, averageOrderValue: 40, orderValue: 40, newCustomerOrders: 0 },
      { day: "2026-03-07", ...quiet },
      // C was cancelled the same day: an order of the day, and its 99 a return, as in Shopify's reports.
      { day: "2026-03-08", grossSales: 159, discounts: 5, netSales: 55, totalSales: 55, ...lines, orders: 2, units: 2, refunds: 99, averageOrderValue: 77, orderValue: 154, newCustomerOrders: 0 },
      { day: "2026-03-09", ...quiet },
    ]);
    expect(s.current).toMatchObject({ netSales: 95, totalSales: 95, orders: 3 });
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
    // The same months of the two years before, whole, for the overview's monthly comparison: none
    // of them imported here, so each says so rather than reading as a $0 month.
    expect(y.past.map((p: { year: number }) => p.year)).toEqual([y.year - 1, y.year - 2]);
    for (const p of y.past as Array<{ year: number; total: number; months: Array<{ month: string; to: string; current: boolean; coverage: string }> }>) {
      expect(p.months.map((m) => m.month)).toEqual(y.months.map((m: { month: string }) => `${p.year}${m.month.slice(4)}`));
      expect(p.months.every((m) => m.coverage === "none" && !m.current)).toBe(true);
      expect(p.total).toBe(0);
    }
  });

  it("reports a custom range up to the store's today", async () => {
    const { a, ws, store } = await owner();
    const today = localDay(new Date(), TZ);
    const res = await overview(a.headers, ws, store.id, `preset=custom&from=${addDays(today, -2)}&to=${addDays(today, 20)}`);
    expect(res.statusCode).toBe(200);
    const { range, previous, modules } = res.json();
    expect(range).toEqual({ from: addDays(today, -2), to: today });
    // Today is still running: the period before stops at this time of day on its last day.
    expect(previous).toEqual({ from: addDays(today, -5), to: addDays(today, -3), until: expect.stringMatching(/^\d{2}:\d{2}:\d{2}$/) });
    expect(modules.sales_overview.series.map((x: { day: string }) => x.day)).toEqual([addDays(today, -2), addDays(today, -1), today]);
    // The sales are the dates' own: no figures, changes or days of the period before.
    for (const k of ["previous", "deltas", "previousSeries"]) expect(modules.sales_overview).not.toHaveProperty(k);
  });

  it("counts a day that isn't over as it stands, with nothing of the day before in its sales", async () => {
    const a = await signIn(ctx, "ua", "a@x.com");
    const ws = await createWorkspace(ctx, a.headers, "A");
    const store = await createStore(ws, "a.myshopify.com", [...ALL_SCOPES, "write_pixels", "read_customer_events"], { timezone: TZ, pixelInstalled: true });
    // Noon on Sunday 8 Mar 2026, the day US clocks go forward: 12:00 EDT is 16:00Z, and noon on
    // Saturday (EST) is 17:00Z, so the cut is by the clock, not 24 hours back (that would be 11:00).
    const now = new Date("2026-03-08T16:00:00Z");
    await seedOrder(store, { id: "T1", createdAt: "2026-03-08T14:00:00Z", lines: [{ qty: 1, price: 50 }] });
    await seedOrder(store, { id: "Y1", createdAt: "2026-03-07T15:00:00Z", lines: [{ qty: 1, price: 30 }] }); // 10:00
    await seedOrder(store, { id: "Y2", createdAt: "2026-03-07T16:30:00Z", lines: [{ qty: 2, price: 20 }] }); // 11:30
    await seedOrder(store, { id: "Y3", createdAt: "2026-03-07T18:00:00Z", lines: [{ qty: 1, price: 100 }] }); // 13:00, after the cut
    // Refunds made on Saturday, one before noon and one after: each counts when it was made.
    const refund = async (order: string, at: string, amount: number) => {
      const o = await systemDb.order.findFirstOrThrow({ where: { storeId: store.id, shopifyId: order } });
      await systemDb.orderSale.create({
        data: { workspaceId: ws, storeId: store.id, orderId: o.id, shopifyId: `${order}-refund`, localDay: "2026-03-07", happenedAt: new Date(at), actionType: "return", lineType: "product", quantity: null, amount: -amount, discount: 0, tax: 0 },
      });
    };
    await refund("Y2", "2026-03-07T16:45:00Z", 10);
    await refund("Y1", "2026-03-07T20:00:00Z", 30);
    await recomputeDays(store, ["2026-03-07", "2026-03-08"]);
    // Store visits on Saturday: two that started before noon (one bought), one after.
    for (const [visitor, at, step] of [["v1", "2026-03-07T15:30:00Z", 4], ["v2", "2026-03-07T16:50:00Z", 1], ["v3", "2026-03-07T19:00:00Z", 4]] as const) {
      await systemDb.funnelVisit.create({ data: { workspaceId: ws, storeId: store.id, day: "2026-03-07", visitor, enteredAt: new Date(at), furthestStep: step } });
    }
    await systemDb.funnelVisit.create({ data: { workspaceId: ws, storeId: store.id, day: "2026-03-08", visitor: "v4", enteredAt: new Date("2026-03-08T15:00:00Z"), furthestStep: 4 } });

    const report = (preset: "today" | "yesterday") =>
      withTenant(ws, (tx) => storeOverview(tx, store, resolvePreset(preset, now, TZ), now)) as unknown as Promise<{
        modules: { sales_overview: { current: Record<string, number> }; refunds: object; customers: object; funnel: { visits: number } };
      }>;
    expect(resolvePreset("today", now, TZ).previous).toEqual({ from: "2026-03-07", to: "2026-03-07", until: "12:00:00" });
    const { modules: m } = await report("today");
    expect(m.sales_overview.current).toMatchObject({ netSales: 50, orders: 1 });
    // Saturday's orders and refunds are Saturday's: none of them is read into Sunday's answer.
    for (const k of ["previous", "deltas", "previousSeries"]) expect(m.sales_overview).not.toHaveProperty(k);
    expect(m.refunds).not.toHaveProperty("deltas");
    expect(m.customers).not.toHaveProperty("previous");
    // Sunday's one visit; Saturday's three are Saturday's.
    expect(m.funnel.visits).toBe(1);
    for (const k of ["previous", "deltas"]) expect(m.funnel).not.toHaveProperty(k);

    // Saturday on its own is still the whole day, as daily_store_metrics holds it.
    const { modules: y } = await report("yesterday");
    expect(y.sales_overview.current).toMatchObject({ grossSales: 170, returns: 40, netSales: 130, orders: 3 });
    expect(y.funnel.visits).toBe(3);
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

describe("what the dates are compared with", () => {
  const today = localDay(new Date(), TZ);
  const d = (n: number) => addDays(today, n);
  const at = (day: string) => `${day}T17:00:00Z`; // 12:00 or 13:00 in New York, on that day

  /** A Meta ad account and an AdSense account on the store, with what they report for `days`. */
  async function seedAds(store: Store, days: Array<[day: string, spend: number, earnings: number]>) {
    // Connected long before these dates, and synced up to today: their figures reach back further than any comparison here.
    const conn = (provider: string, accountId: string) =>
      systemDb.adConnection.create({
        data: { workspaceId: store.workspaceId, storeId: store.id, provider, accountId, currency: "USD", timezone: TZ, accessTokenEnc: "x", tokenKeyVersion: 1, historyFrom: "2020-01-01", syncedThrough: today, lastSyncedAt: new Date() },
      });
    const meta = await conn("meta", "act_1");
    const sense = await conn("adsense", "pub-1");
    for (const [day, spend, earnings] of days) {
      await systemDb.adCampaignDaily.create({ data: { workspaceId: store.workspaceId, storeId: store.id, connectionId: meta.id, provider: "meta", accountId: "act_1", campaignId: "1", campaignName: "Spring", day, spend, clicks: 1 } });
      await systemDb.adsenseDaily.create({ data: { workspaceId: store.workspaceId, storeId: store.id, connectionId: sense.id, accountId: "pub-1", site: "", day, earnings, pageViews: 100 } });
    }
  }

  it("gives the dates' own figures, ads included: nothing of the period just before, or of a year earlier", async () => {
    const { a, ws, store } = await owner();
    const [from, to] = [d(-10), d(-8)];
    // A year earlier: the orders reach back that far.
    await seedOrder(store, { id: "Y0", createdAt: at(yearEarlier(from)), lines: [{ qty: 1, price: 15 }] });
    await seedOrder(store, { id: "Y1", createdAt: at(yearEarlier(d(-9))), lines: [{ qty: 1, price: 60 }] });
    // Just before the dates.
    await seedOrder(store, { id: "P1", createdAt: at(d(-12)), lines: [{ qty: 1, price: 999 }] });
    await seedOrder(store, { id: "C1", createdAt: at(d(-9)), lines: [{ qty: 1, price: 100 }] });
    await seedOrder(store, { id: "C2", createdAt: at(to), lines: [{ qty: 1, price: 50 }] });
    await recomputeDays(store, [yearEarlier(from), yearEarlier(d(-9)), d(-12), d(-9), to]);
    await seedAds(store, [[d(-9), 40, 10], [d(-12), 500, 100], [yearEarlier(d(-9)), 20, 5]]);

    const res = await overview(a.headers, ws, store.id, `preset=custom&from=${from}&to=${to}`);
    expect(res.statusCode).toBe(200);
    const before = res.json();
    // How the dates were asked for, for a panel that asks about them again.
    expect(before.preset).toBe("custom");
    expect(before.range).toEqual({ from, to });
    // Finished dates: whole days, so no time of day. The period just before holds P1.
    expect(before.previous).toEqual({ from: d(-13), to: d(-11) });
    expect(before.modules.sales_overview.current).toMatchObject({ netSales: 150, orders: 2 });
    // P1's $999 is in no figure of the sales: they are the dates' own.
    for (const k of ["previous", "deltas", "previousSeries"]) expect(before.modules.sales_overview).not.toHaveProperty(k);
    expect(before.modules.ads.current.spend).toBe(40);
    expect(before.modules.adsense.current.earnings).toBe(10);
    // The $500 spent and $100 earned just before are in no figure either.
    for (const k of ["previous", "deltas", "compared", "notCompared", "imported"]) {
      expect(before.modules.ads).not.toHaveProperty(k);
      expect(before.modules.adsense).not.toHaveProperty(k);
    }
  });

  it("answers a link that still asks for a comparison of its own with the period just before, on the dashboard and its downloads", async () => {
    const { a, ws, store } = await owner();
    // What the comparison menu wrote into the address bar while there was one: bookmarks still carry it.
    for (const qs of ["preset=7d&compare=year", `preset=7d&compare=custom&cfrom=${d(-30)}&cto=${d(-24)}`, "preset=7d&compare=custom&cfrom=2026-03-09&cto=2026-03-01", "preset=7d&compare=lastweek"]) {
      const res = await overview(a.headers, ws, store.id, qs);
      expect(res.statusCode, qs).toBe(200);
      expect(res.json().previous, qs).toEqual({ from: d(-13), to: d(-7), until: expect.stringMatching(/^\d{2}:\d{2}:\d{2}$/) });
    }
    const download = (qs: string) => ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${store.id}/export?section=sales&${qs}`, headers: a.headers });
    expect((await download("preset=7d&compare=year")).statusCode).toBe(200);
    expect((await download("preset=7d&compare=custom&cfrom=2026-03-09&cto=2026-03-01")).statusCode).toBe(200);
  });

  it("sets the store's own sales against the ad spend, and counts the orders Shopify's visit record credits to each platform's ads", async () => {
    const { a, ws, store } = await owner();
    const [from, to] = [d(-10), d(-8)];
    // Three orders in the dates: one from a Facebook ad, one from an Instagram post (no ad tag), one direct.
    await seedOrder(store, { id: "F1", createdAt: at(d(-9)), lines: [{ qty: 1, price: 100 }], traffic: { source: "facebook", medium: "paid", campaign: "spring" } });
    await seedOrder(store, { id: "I1", createdAt: at(d(-9)), lines: [{ qty: 1, price: 40 }], traffic: { source: "instagram", medium: "unpaid" } });
    await seedOrder(store, { id: "D1", createdAt: at(to), lines: [{ qty: 1, price: 60 }], traffic: { source: "direct", medium: "direct" } });
    // The dates before: one order for $20 of ads, which the dates' own figures leave out.
    await seedOrder(store, { id: "P1", createdAt: at(d(-13)), lines: [{ qty: 1, price: 50 }] });
    await recomputeDays(store, [d(-13), d(-9), to]);
    await seedAds(store, [[d(-9), 40, 10], [d(-12), 20, 5]]);

    const m = (await overview(a.headers, ws, store.id, `preset=custom&from=${from}&to=${to}`)).json().modules;
    expect(m.sales_overview.current).toMatchObject({ netSales: 200, orders: 3 });
    // $200 of sales for $40 of ads: 5× (MER), $13.33 of ads per order. The store's sales of the dates before aren't read.
    expect(m.ads.sales).toEqual({ netSales: 200, orders: 3, salesPerSpend: 5, shareOfSales: 0.2, costPerOrder: 13.33 });
    // Shopify credits the order from the Facebook ad to Meta: $100 of sales for Meta's $40. The Instagram post carried no ad tag, and the direct order isn't anyone's.
    expect(m.ads.sourced).toEqual([{ provider: "meta", orders: 1, sales: 100, salesPerSpend: 2.5 }]);
    // Paid vs organic, by the same visits (last click): the tagged Facebook ad paid, the untagged Instagram post organic, the typed address direct.
    expect(m.traffic.split).toEqual([
      { id: "paid", label: "Paid ads", orders: 1, sales: 100, share: 0.5 },
      { id: "organic", label: "Organic", orders: 1, sales: 40, share: 0.2 },
      { id: "email", label: "Email and messages", orders: 0, sales: 0, share: 0 },
      { id: "direct", label: "Direct", orders: 1, sales: 60, share: 0.3 },
      { id: "unknown", label: "Not recorded", orders: 0, sales: 0, share: 0 },
    ]);
    // Today in the dates: the same, with every order of the 30 days.
    const running = (await overview(a.headers, ws, store.id, "preset=30d")).json().modules;
    expect(running.ads.sales).toMatchObject({ netSales: 250, orders: 4 });
    for (const k of ["previous", "deltas"]) expect(running.ads.sales).not.toHaveProperty(k);
  });

  it("gives the dates' sales alone, whether or not the orders reach back before them", async () => {
    const { a, ws, store } = await owner();
    // Shopify's 60 days: the first imported order is 20 days ago.
    await seedOrder(store, { id: "O1", createdAt: at(d(-20)), lines: [{ qty: 1, price: 80 }] });
    await seedOrder(store, { id: "O2", createdAt: at(d(-5)), lines: [{ qty: 1, price: 40 }] });
    await recomputeDays(store, [d(-20), d(-5)]);

    // The 15 days before these, 33 to 19 days ago, are mostly before the first imported order.
    const qs = `preset=custom&from=${d(-18)}&to=${d(-4)}`;
    const { previous, modules: m } = (await overview(a.headers, ws, store.id, qs)).json();
    expect(previous).toEqual({ from: d(-33), to: d(-19) });
    expect(m.sales_overview.current).toMatchObject({ netSales: 40, orders: 1 });
    for (const k of ["previous", "deltas", "previousSeries"]) expect(m.sales_overview).not.toHaveProperty(k);
    expect(Object.keys(m.refunds)).toEqual(["current"]);
    expect(Object.keys(m.customers)).toEqual(["current"]);
    // Dates whose period before holds the first imported order: the same, the dates' own figures.
    const ok = (await overview(a.headers, ws, store.id, `preset=custom&from=${d(-12)}&to=${d(-5)}`)).json();
    expect(ok.previous).toEqual({ from: d(-20), to: d(-13) });
    expect(ok.modules.sales_overview.current).toMatchObject({ netSales: 40, orders: 1 });
    expect(ok.modules.sales_overview).not.toHaveProperty("deltas");
  });

  it("counts the months from where the import window starts, before a quiet store's first order", async () => {
    const { a, ws, store } = await owner();
    // Imported 60 days ago at noon in New York (Shopify's 60 days): that day was only partly
    // imported, so the history starts the day after.
    await systemDb.store.update({ where: { id: store.id }, data: { ordersHistoryFrom: new Date(at(d(-60))) } });
    // A quiet store: its first order came 25 days ago, the 34 days before it imported with none.
    await seedOrder(store, { id: "O1", createdAt: at(d(-25)), lines: [{ qty: 1, price: 80 }] });
    await seedOrder(store, { id: "O2", createdAt: at(d(-5)), lines: [{ qty: 1, price: 40 }] });
    await recomputeDays(store, [d(-25), d(-5)]);
    // The dates whose period just before is `cfrom` to `cto`: as many days, right after it.
    const compared = async (cfrom: string, cto: string) => {
      const days = daysBetweenInclusive(cfrom, cto);
      const body = (await overview(a.headers, ws, store.id, `preset=custom&from=${addDays(cto, 1)}&to=${addDays(cto, days)}`)).json();
      expect(body.previous).toMatchObject({ from: cfrom, to: cto });
      return body;
    };

    // The history starts where the import window does, not at the first order.
    const ok = await compared(d(-27), d(-16));
    expect(ok.data).toMatchObject({ oldestOrderDay: d(-25), historyFrom: d(-59) });
    expect(ok.modules.sales_overview.current).toMatchObject({ netSales: 40, orders: 1 });
    // The months go by the same start: before it "none", across it "partial", from it "full".
    for (const m of ok.modules.sales_overview.year.months as Array<{ from: string; to: string; coverage: string }>) {
      expect(m.coverage, m.from).toBe(m.to < d(-59) ? "none" : m.from >= d(-59) ? "full" : "partial");
    }
    // Days in the window without orders were imported: $0 days, not missing ones.
    const quiet = await compared(d(-59), d(-50));
    expect(quiet.modules.sales_overview.current).toMatchObject({ netSales: 0, orders: 0 });
    expect(quiet.modules.sales_overview.series).toHaveLength(10);
  });

  it("gives visits and ad figures from where each one's history starts, whatever lies before the dates", async () => {
    const { a, ws, store } = await owner([...ALL_SCOPES, "write_pixels", "read_customer_events"]);
    // Every order is in: only visits and ads have a shorter history.
    // The pixel was added at noon 20 days ago, so visits are counted in full from the day after.
    await systemDb.store.update({ where: { id: store.id }, data: { ordersHistoryFrom: new Date(0), pixelInstalled: true, pixelInstalledAt: new Date(at(d(-20))) } });
    const visit = (day: string, visitor: string, step = 0) =>
      systemDb.funnelVisit.create({ data: { workspaceId: ws, storeId: store.id, day, visitor, enteredAt: new Date(at(day)), furthestStep: step } });
    await visit(d(-20), "v0");
    await visit(d(-14), "v1", 4);
    await visit(d(-5), "v2", 4);
    await visit(d(-4), "v3");
    // Two Meta accounts: one connected long ago, one 12 days ago (its first sync brought from then on), both synced up to today.
    const conn = (provider: string, accountId: string, historyFrom: string, currency = "USD") =>
      systemDb.adConnection.create({
        data: { workspaceId: ws, storeId: store.id, provider, accountId, currency, timezone: TZ, accessTokenEnc: "x", tokenKeyVersion: 1, historyFrom, syncedThrough: today, lastSyncedAt: new Date() },
      });
    const old = await conn("meta", "act_old", d(-100));
    const recent = await conn("meta", "act_new", d(-12));
    // In euros, so not added in: its start doesn't count either.
    await conn("meta", "act_eur", d(-2), "EUR");
    const sense = await conn("adsense", "pub-1", d(-12));
    const spend = (c: { id: string; accountId: string }, day: string, amount: number) =>
      systemDb.adCampaignDaily.create({ data: { workspaceId: ws, storeId: store.id, connectionId: c.id, provider: "meta", accountId: c.accountId, campaignId: "1", campaignName: "Spring", day, spend: amount, clicks: 1 } });
    await spend(old, d(-14), 50);
    await spend(old, d(-5), 20);
    await spend(recent, d(-10), 5);
    await spend(recent, d(-5), 30);
    for (const [day, earnings] of [[d(-10), 2], [d(-5), 4]] as const) {
      await systemDb.adsenseDaily.create({ data: { workspaceId: ws, storeId: store.id, connectionId: sense.id, accountId: "pub-1", site: "", day, earnings, pageViews: 100 } });
    }
    // Dates ending 4 days ago, compared with as many days just before them.
    const compared = async (from: string) => (await overview(a.headers, ws, store.id, `preset=custom&from=${from}&to=${d(-4)}`)).json();

    // 9 days against 21 to 13 days ago, reaching back to the pixel's first, partly counted day: the
    // visit on it would read as fewer visits before.
    const early = await compared(d(-12));
    expect(early.previous).toEqual({ from: d(-21), to: d(-13) });
    expect(early.modules.funnel).toMatchObject({ visits: 2, conversionRate: 0.5, historyFrom: d(-19) });
    for (const k of ["previous", "deltas"]) expect(early.modules.funnel).not.toHaveProperty(k);
    expect(early.modules.ads).toMatchObject({ historyFrom: d(-12), current: { spend: 55 } });
    expect(early.modules.adsense).toMatchObject({ historyFrom: d(-12), current: { earnings: 6 } });
    for (const k of ["previous", "deltas", "compared", "notCompared", "imported"]) {
      expect(early.modules.ads).not.toHaveProperty(k);
      expect(early.modules.adsense).not.toHaveProperty(k);
    }

    // 7 days, from 10 days ago.
    const mid = await compared(d(-10));
    expect(mid.previous).toMatchObject({ from: d(-17), to: d(-11) });
    expect(mid.modules.funnel).toMatchObject({ visits: 2, conversionRate: 0.5 });
    expect(mid.modules.ads).toMatchObject({ current: { spend: 55 } });

    // 4 days, from 7 days ago: the $5 and $2 of the days just before aren't in them.
    const late = await compared(d(-7));
    expect(late.previous).toMatchObject({ from: d(-11), to: d(-8) });
    expect(late.modules.ads).toMatchObject({ current: { spend: 50 } });
    expect(late.modules.adsense).toMatchObject({ current: { earnings: 4 } });
  });

});

describe("ad figures only for the days the accounts have stored", () => {
  const today = localDay(new Date(), TZ);
  const d = (n: number) => addDays(today, n);

  /** An ad account on the store: synced up to today from 90 days back unless said otherwise. */
  const adAccount = (store: Store, provider: string, accountId: string, over: Record<string, unknown> = {}) =>
    systemDb.adConnection.create({
      data: {
        workspaceId: store.workspaceId,
        storeId: store.id,
        provider,
        accountId,
        accountName: `Account ${accountId}`,
        currency: "USD",
        timezone: TZ,
        accessTokenEnc: "x",
        tokenKeyVersion: 1,
        historyFrom: d(-89),
        syncedThrough: today,
        lastSyncedAt: new Date(),
        ...over,
      },
    });
  const spendDays = async (store: Store, c: { id: string; provider: string; accountId: string }, from: string, to: string, spend: number) => {
    for (let day = from; day <= to; day = addDays(day, 1)) {
      await systemDb.adCampaignDaily.create({
        data: { workspaceId: store.workspaceId, storeId: store.id, connectionId: c.id, provider: c.provider, accountId: c.accountId, campaignId: "1", campaignName: "Spring", day, spend, impressions: 100, clicks: 4, linkClicks: 2, purchases: 1, purchaseValue: 3 * spend },
      });
    }
  };
  const earnDays = async (store: Store, c: { id: string; accountId: string }, site: string, from: string, to: string, earnings: number) => {
    for (let day = from; day <= to; day = addDays(day, 1)) {
      await systemDb.adsenseDaily.create({ data: { workspaceId: store.workspaceId, storeId: store.id, connectionId: c.id, accountId: c.accountId, site, day, earnings, pageViews: 100, impressions: 50, clicks: 1 } });
    }
  };

  it("answers the Advertising pages with their modules only, narrowed to a platform or an account, part of the spend never set against the store's sales", async () => {
    const { a, ws, store } = await owner();
    const meta = await adAccount(store, "meta", "act_1");
    const google = await adAccount(store, "google", "123");
    const sense = await adAccount(store, "adsense", "pub-1");
    await spendDays(store, meta, d(-13), today, 10);
    await spendDays(store, google, d(-13), today, 5);
    await earnDays(store, sense, "", d(-13), today, 2);
    await seedOrder(store, { id: "S1", createdAt: `${d(-2)}T17:00:00Z`, lines: [{ qty: 1, price: 210 }] });
    await recomputeDays(store, [d(-2)]);
    const ask = async (qs: string) => (await overview(a.headers, ws, store.id, `preset=7d&parts=advertising${qs}`)).json().modules;

    const all = await ask("");
    // Only what the Advertising pages show: the rest of the dashboard isn't computed. The store's
    // customers and refunds come along for Shopify attribution and profitability.
    expect(all).toHaveProperty("sales_overview");
    for (const kept of ["customers", "refunds"]) expect(all).toHaveProperty(kept);
    for (const left of ["top_products", "recent_orders", "inventory", "catalog", "order_timing"]) expect(all).not.toHaveProperty(left);
    expect(all.ads.byProvider.map((p: { provider: string }) => p.provider).sort()).toEqual(["google", "meta"]);
    // Every spend platform together: Shopify's net sales per unit of all of it (MER).
    expect(all.ads.sales).toMatchObject({ netSales: 210, salesPerSpend: 2 });
    expect(all.adsense.current.earnings).toBe(14);
    // Every campaign, each with its own figures for the dates.
    expect(all.ads.campaigns).toEqual(expect.arrayContaining([expect.objectContaining({ provider: "meta", name: "Spring", spend: 70 })]));
    for (const c of all.ads.campaigns) expect(c).not.toHaveProperty("change");

    // One platform: its own figures, not set against the store's sales; no AdSense.
    const metaOnly = await ask("&platform=meta");
    expect(metaOnly.ads.byProvider.map((p: { provider: string }) => p.provider)).toEqual(["meta"]);
    expect(metaOnly.ads.current.spend).toBe(70);
    expect(metaOnly.ads.sales).toBeNull();
    expect(metaOnly.ads.shareOfSales).toBeNull();
    expect(metaOnly).not.toHaveProperty("adsense");
    // One account: its own figures only.
    const one = await ask(`&account=${google.id}`);
    expect(one.ads.accounts.map((x: { id: string }) => x.id)).toEqual([google.id]);
    expect(one.ads.current.spend).toBe(35);
    expect(one.ads.sales).toBeNull();
    expect(one).not.toHaveProperty("adsense");
    // AdSense alone: money in, its earnings next to the store's sales, no spend.
    const earned = await ask("&platform=adsense");
    expect(earned).not.toHaveProperty("ads");
    expect(earned.adsense).toMatchObject({ current: { earnings: 14 }, vsSales: 14 / 210 });

    // The dashboard's own question isn't narrowed, and keeps its top ten campaigns without changes.
    const dash = (await overview(a.headers, ws, store.id, "preset=7d&platform=meta")).json().modules;
    expect(dash.ads.byProvider).toHaveLength(2);
    expect(dash).toHaveProperty("adsense");
    expect(dash.ads.campaigns[0]).not.toHaveProperty("change");
  });

  it("gives each campaign its status as the last sync read it, for the campaign filters; one not read yet has none", async () => {
    const { a, ws, store } = await owner();
    const meta = await adAccount(store, "meta", "act_1");
    const google = await adAccount(store, "google", "123");
    await spendDays(store, meta, d(-6), today, 10);
    await spendDays(store, google, d(-6), today, 5);
    await systemDb.adCampaign.create({ data: { workspaceId: ws, storeId: store.id, connectionId: meta.id, provider: "meta", accountId: "act_1", campaignId: "1", name: "Spring", status: "CAMPAIGN_PAUSED", checkedAt: new Date() } });
    const campaigns = (await overview(a.headers, ws, store.id, "preset=7d&parts=advertising")).json().modules.ads.campaigns as Array<{ provider: string; status: string | null; statusGroup: string | null }>;
    const by = Object.fromEntries(campaigns.map((c) => [c.provider, [c.status, c.statusGroup]]));
    expect(by).toEqual({ meta: ["CAMPAIGN_PAUSED", "paused"], google: [null, null] });
    // Another workspace's campaign of the same id never lends its status.
    const otherWs = (await systemDb.workspace.create({ data: { name: "B" } })).id;
    const otherStore = await createStore(otherWs, "b.myshopify.com", ALL_SCOPES, { timezone: TZ });
    const theirs = await adAccount(otherStore, "google", "123");
    await systemDb.adCampaign.create({ data: { workspaceId: otherWs, storeId: otherStore.id, connectionId: theirs.id, provider: "google", accountId: "123", campaignId: "1", name: "Spring", status: "ENABLED", checkedAt: new Date() } });
    const again = (await overview(a.headers, ws, store.id, "preset=7d&parts=advertising")).json().modules.ads.campaigns as Array<{ provider: string; status: string | null }>;
    expect(again.find((c) => c.provider === "google")!.status).toBeNull();
  });

  it("gives each campaign Google's type, primary status and budget, and Meta's budget, as the last sync stored them; unread stays null", async () => {
    const { a, ws, store } = await owner();
    const meta = await adAccount(store, "meta", "act_1");
    const google = await adAccount(store, "google", "123");
    await spendDays(store, meta, d(-6), today, 10);
    await spendDays(store, google, d(-6), today, 5);
    const at = { workspaceId: ws, storeId: store.id, campaignId: "1", name: "Spring", checkedAt: new Date() };
    await systemDb.adCampaign.create({ data: { ...at, connectionId: meta.id, provider: "meta", accountId: "act_1", status: "ACTIVE", budgetPeriod: "LIFETIME", budgetAmount: 900 } });
    await systemDb.adCampaign.create({
      data: { ...at, connectionId: google.id, provider: "google", accountId: "123", status: "ENABLED", channelType: "SEARCH", primaryStatus: "LIMITED", primaryStatusReasons: ["BUDGET_CONSTRAINED"], budgetPeriod: "DAILY", budgetAmount: 40 },
    });
    type Row = { provider: string; channelType: string | null; primaryStatus: string | null; primaryStatusReasons: string[]; budgetPeriod: string | null; budgetAmount: number | null };
    const campaigns = (await overview(a.headers, ws, store.id, "preset=7d&parts=advertising")).json().modules.ads.campaigns as Row[];
    const by = Object.fromEntries(campaigns.map(({ provider, channelType, primaryStatus, primaryStatusReasons, budgetPeriod, budgetAmount }) => [provider, { channelType, primaryStatus, primaryStatusReasons, budgetPeriod, budgetAmount }]));
    expect(by).toEqual({
      meta: { channelType: null, primaryStatus: null, primaryStatusReasons: [], budgetPeriod: "LIFETIME", budgetAmount: 900 },
      google: { channelType: "SEARCH", primaryStatus: "LIMITED", primaryStatusReasons: ["BUDGET_CONSTRAINED"], budgetPeriod: "DAILY", budgetAmount: 40 },
    });
    // The download carries them too, in the platform's own words.
    const table = await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${store.id}/export/table?section=ads_campaigns&preset=7d&platform=google`, headers: a.headers });
    expect(table.statusCode).toBe(200);
    expect(table.json().rows[0].slice(3, 9)).toEqual(["ENABLED", "LIMITED", "BUDGET_CONSTRAINED", "SEARCH", 40, "DAILY"]);
  });

  it("never shows 0 for an account whose access ended or that was never read, and keeps a healthy platform's figures", async () => {
    const { a, ws, store } = await owner();
    const meta = await adAccount(store, "meta", "act_1");
    // Access ended three days ago: nothing stored since.
    const google = await adAccount(store, "google", "123", { status: "reconnect", errorCode: "auth_expired", syncedThrough: d(-3), lastSyncedAt: new Date(Date.now() - 3 * 86_400_000) });
    // Connected a moment ago: its first sync hasn't finished.
    await adAccount(store, "adsense", "pub-1", { historyFrom: null, syncedThrough: null, lastSyncedAt: null });
    await spendDays(store, meta, d(-13), today, 10);
    await spendDays(store, google, d(-13), d(-3), 5);

    const { modules: m } = (await overview(a.headers, ws, store.id, "preset=7d")).json();
    // Together: Google's last three days aren't known, so there is no total, only the part every account has.
    expect(m.ads.current).toBeNull();
    expect(m.ads.coverage).toEqual({ from: d(-89), through: d(-3), complete: false });
    expect(m.ads.partial).toMatchObject({ from: d(-6), to: d(-3), totals: { spend: 60 } });
    expect(m.ads.shareOfSales).toBeNull();
    expect(m.ads.series.map((x: { spend: number | null }) => x.spend)).toEqual([15, 15, 15, 15, null, null, null]);
    // Meta on its own covers the week; Google's entry is unavailable, never $0.
    const meta7 = m.ads.byProvider.find((p: { provider: string }) => p.provider === "meta");
    const google7 = m.ads.byProvider.find((p: { provider: string }) => p.provider === "google");
    expect(meta7).toMatchObject({ spend: 70, current: { spend: 70, purchases: 7, roas: 3 }, coverage: { complete: true } });
    expect(meta7.updatedAt).toEqual(expect.any(String));
    expect(google7).toMatchObject({ spend: null, current: null, partial: { from: d(-6), to: d(-3), totals: { spend: 20 } } });
    expect(m.ads.accounts.find((x: { provider: string }) => x.provider === "google")).toMatchObject({ status: "reconnect", errorCode: "auth_expired", coverage: { from: d(-89), through: d(-3) }, coversRange: false });
    // AdSense not read yet: nothing to show, and nothing shown as $0.
    expect(m.adsense).toMatchObject({ current: null, partial: null, coverage: { from: null, through: null, complete: false }, vsSales: null });
    expect(m.adsense.series.every((x: { earnings: number | null }) => x.earnings === null)).toBe(true);
  });

  it("gives what it holds of a 12-month range, with the days before the accounts' history missing", async () => {
    const { a, ws, store } = await owner();
    const meta = await adAccount(store, "meta", "act_1");
    const sense = await adAccount(store, "adsense", "pub-1");
    await spendDays(store, meta, d(-89), today, 1);
    await earnDays(store, sense, "", d(-89), today, 2);

    // 12 months up to today: from the day after the same date a year ago.
    const from = addDays(yearEarlier(today), 1);
    const res = await overview(a.headers, ws, store.id, `preset=custom&from=${from}&to=${today}`);
    expect(res.statusCode).toBe(200);
    const m = res.json().modules;
    const days = dayDiff(from, today) + 1;
    expect(m.ads.series).toHaveLength(days);
    expect(m.ads.series.filter((x: { spend: number | null }) => x.spend === null)).toHaveLength(days - 90);
    expect(m.ads).toMatchObject({ current: null, partial: { from: d(-89), to: today, totals: { spend: 90 } } });
    expect(m.adsense).toMatchObject({ current: null, partial: { from: d(-89), to: today, totals: { earnings: 180 } } });
    expect(m.adsense.series.filter((x: { earnings: number | null }) => x.earnings === null)).toHaveLength(days - 90);
  });

  it("says when an account's days follow another time zone, and leaves a day it hasn't reached missing", async () => {
    const { a, ws, store } = await owner();
    // Eleven hours behind UTC: its "today" can still be the store's yesterday, so it's stored up to then.
    const google = await adAccount(store, "google", "123", { timezone: "Pacific/Pago_Pago", syncedThrough: d(-1) });
    const meta = await adAccount(store, "meta", "act_1");
    await spendDays(store, google, d(-3), d(-1), 5);
    await spendDays(store, meta, d(-3), today, 10);

    const { modules: m } = (await overview(a.headers, ws, store.id, "preset=today")).json();
    expect(m.ads.accounts.map((x: { provider: string; timezone: string; otherTimeZone: boolean }) => [x.provider, x.timezone, x.otherTimeZone])).toEqual([
      ["google", "Pacific/Pago_Pago", true],
      ["meta", TZ, false],
    ]);
    expect(m.ads.current).toBeNull();
    expect(m.ads.byProvider.find((p: { provider: string }) => p.provider === "google")).toMatchObject({ current: null, partial: null, spend: null });
    expect(m.ads.byProvider.find((p: { provider: string }) => p.provider === "meta")).toMatchObject({ spend: 10, current: { spend: 10 } });
    expect(m.ads.seriesByProvider.find((s: { provider: string }) => s.provider === "google").series).toEqual([expect.objectContaining({ day: today, spend: null })]);

    // Over a week, the only day missing is one Google hasn't finished or begun: the week so far, through yesterday.
    const week = (await overview(a.headers, ws, store.id, "preset=7d")).json().modules.ads;
    expect(week.current).toBeNull();
    expect(week.soFar).toMatchObject({ from: d(-6), to: d(-1), totals: { spend: 45 } });
    expect(week.byProvider.find((p: { provider: string }) => p.provider === "google")).toMatchObject({ current: null, soFar: { from: d(-6), to: d(-1), totals: { spend: 15 } } });
    expect(week.series.at(-1)).toMatchObject({ day: today, spend: null });
  });

  it("gives a platform with a long history its dates whole, and one whose history starts inside them only its part", async () => {
    const { a, ws, store } = await owner();
    const google = await adAccount(store, "google", "123", { historyFrom: addDays(today, -800) });
    // Connected ten days ago: its history starts inside the last 90 days.
    const meta = await adAccount(store, "meta", "act_1", { historyFrom: d(-9) });
    const days = (from: string, to: string) => {
      const out: string[] = [];
      for (let x = from; x <= to; x = addDays(x, 1)) out.push(x);
      return out;
    };
    const rows = (c: { id: string; provider: string; accountId: string }, list: string[], spend: number) =>
      systemDb.adCampaignDaily.createMany({
        data: list.map((day) => ({ workspaceId: store.workspaceId, storeId: store.id, connectionId: c.id, provider: c.provider, accountId: c.accountId, campaignId: "1", campaignName: "Spring", day, spend, clicks: 1, linkClicks: 1, purchases: 0, purchaseValue: 0 })),
      });
    await rows(google, days(d(-179), today), 2);
    await rows(meta, days(d(-9), today), 10);

    // Last 90 days: Google's $2 a day whole; what it spent in the 90 days before is stored and in no figure.
    const m = (await overview(a.headers, ws, store.id, "preset=90d")).json().modules.ads;
    const g = m.byProvider.find((p: { provider: string }) => p.provider === "google");
    expect(g).toMatchObject({ current: { spend: 180 }, spend: 180 });
    expect(m.byProvider.find((p: { provider: string }) => p.provider === "meta")).toMatchObject({ current: null, partial: { from: d(-9), to: today, totals: { spend: 100 } } });
    expect(m).toMatchObject({ current: null, historyFrom: d(-9) });
    for (const k of ["previous", "deltas", "compared", "notCompared", "imported"]) for (const x of [m, g]) expect(x).not.toHaveProperty(k);
  });

  it("adds up the dates as they stand while they include today, with nothing of the week before", async () => {
    const { a, ws, store } = await owner();
    const meta = await adAccount(store, "meta", "act_1");
    await spendDays(store, meta, d(-13), d(-1), 10);
    // Today so far: part of a day.
    await spendDays(store, meta, today, today, 2);

    const week = (await overview(a.headers, ws, store.id, "preset=7d")).json().modules.ads;
    expect(week.current.spend).toBe(62);
    for (const k of ["previous", "deltas", "compared", "notCompared"]) expect(week).not.toHaveProperty(k);

    const day = (await overview(a.headers, ws, store.id, "preset=today")).json().modules.ads;
    expect(day.current.spend).toBe(2);
    for (const k of ["previous", "deltas", "compared", "notCompared"]) expect(day).not.toHaveProperty(k);
  });

  it("adds up only one currency, and an account in another currency that isn't read yet changes nothing", async () => {
    const { a, ws, store } = await owner();
    const usd = await adAccount(store, "meta", "act_1");
    const eur = await adAccount(store, "google", "123", { currency: "EUR" });
    await adAccount(store, "meta", "act_2", { currency: "EUR", historyFrom: null, syncedThrough: null, lastSyncedAt: null });
    await spendDays(store, usd, d(-6), today, 10);
    await spendDays(store, eur, d(-6), today, 999);

    const { modules: m } = (await overview(a.headers, ws, store.id, "preset=7d")).json();
    expect(m.ads.currency).toBe("USD");
    expect(m.ads.current.spend).toBe(70);
    expect(m.ads.byProvider.map((p: { provider: string }) => p.provider)).toEqual(["meta"]);
    expect(m.ads.accounts.map((x: { accountId: string; counted: boolean }) => [x.accountId, x.counted])).toEqual([
      ["123", false],
      ["act_1", true],
      ["act_2", false],
    ]);
  });

  it("counts only the AdSense sites chosen for the store, and sets only those next to its sales", async () => {
    const { a, ws, store } = await owner();
    const sense = await adAccount(store, "adsense", "pub-1", { sites: ["ads-shop.example.com"] });
    await earnDays(store, sense, "ads-shop.example.com", d(-6), d(-6), 12);
    await earnDays(store, sense, "blog.example.com", d(-6), d(-6), 30);
    await seedOrder(store, { id: "O1", createdAt: `${d(-6)}T17:00:00Z`, lines: [{ qty: 1, price: 400 }] });
    await recomputeDays(store, [d(-6)]);

    const { modules: m } = (await overview(a.headers, ws, store.id, "preset=7d")).json();
    expect(m.adsense.current).toMatchObject({ earnings: 12, pageViews: 100 });
    expect(m.adsense.sites.map((s: { site: string }) => s.site)).toEqual(["ads-shop.example.com"]);
    expect(m.adsense.sitesLeftOut).toEqual([expect.objectContaining({ site: "blog.example.com", earnings: 30 })]);
    expect(m.adsense.vsSales).toBe(0.03);
    expect(m.adsense.accounts[0]).toMatchObject({ sites: ["ads-shop.example.com"], coversRange: true });
  });

  it("shows earnings AdSense didn't split by site as unavailable when sites are chosen, never as another site's or as $0", async () => {
    const { a, ws, store } = await owner();
    const sense = await adAccount(store, "adsense", "pub-1", { sites: ["ads-shop.example.com"] });
    // AdSense wouldn't split this account's report by site: one row a day, every site together.
    await earnDays(store, sense, "", d(-13), today, 5);

    const { modules: m } = (await overview(a.headers, ws, store.id, "preset=7d")).json();
    expect(m.adsense).toMatchObject({ current: null, partial: null, soFar: null, vsSales: null, sites: [], sitesLeftOut: [] });
    expect(m.adsense.accounts[0]).toMatchObject({ unsplitThrough: today, coversRange: false, coverage: { from: null, through: null } });
    expect(m.adsense.series.every((x: { earnings: number | null }) => x.earnings === null)).toBe(true);
  });

  it("says whether AdSense's earnings are final, and that a refresh someone asked for is on its way", async () => {
    const { a, ws, store } = await owner();
    const asked = new Date();
    const sense = await adAccount(store, "adsense", "pub-1", { syncRequestedAt: asked, lastSyncAttemptAt: asked });
    await earnDays(store, sense, "", d(-89), today, 1);
    // Synced today: final up to the end of last month after the 10th, of the month before by then.
    const finalThrough = adsenseFinalThrough(today)!;
    const monthStart = `${finalThrough.slice(0, 8)}01`;

    const month = (await overview(a.headers, ws, store.id, `preset=custom&from=${monthStart}&to=${finalThrough}`)).json().modules.adsense;
    expect(month).toMatchObject({ finalThrough, final: true, current: { earnings: Number(finalThrough.slice(8)) } });
    expect(month.accounts[0]).toMatchObject({ finalThrough, syncRequestedAt: asked.toISOString(), lastSyncAttemptAt: asked.toISOString() });
    // The last 7 days are AdSense's estimate still.
    expect((await overview(a.headers, ws, store.id, "preset=7d")).json().modules.adsense).toMatchObject({ finalThrough, final: false });
    // Every ad account says it, spend as well.
    const meta = await adAccount(store, "meta", "act_1");
    const ads = (await overview(a.headers, ws, store.id, "preset=7d")).json().modules.ads;
    expect(ads.accounts.find((x: { id: string }) => x.id === meta.id)).toMatchObject({ syncRequestedAt: null, lastSyncAttemptAt: null });
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
    await systemDb.store.update({ where: { id: store.id }, data: { lastSyncedAt: new Date(), shopCreatedAt: new Date("2022-03-14T03:00:00Z") } });
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

  it("reads when Shopify created a store connected before that was read, once a day until it is known", async () => {
    const { a, ws, store } = await owner(["read_orders"]);
    await systemDb.store.update({ where: { id: store.id }, data: { lastSyncedAt: new Date() } });
    ctx.deps.queues.clear();
    await overview(a.headers, ws, store.id);
    expect(sent()).toEqual(["orders:2", "shop:-"]);
    // No jobs wait on it: the worker must not start any queued orders job a second time.
    expect(ctx.deps.queues.sent.sync.find((m) => m.kind === "shop")).toMatchObject({ waitingJobIds: [] });
    await systemDb.syncJob.updateMany({ where: { storeId: store.id }, data: { status: "succeeded" } });
    ctx.deps.queues.clear();
    await overview(a.headers, ws, store.id);
    expect(sent()).toEqual([]);
  });

  it("a sync still making progress holds refreshes off; one that died in an outage does not", async () => {
    const { a, ws, store } = await owner(["read_orders"]);
    await systemDb.store.update({ where: { id: store.id }, data: { lastSyncedAt: new Date(), shopCreatedAt: new Date("2022-03-14T03:00:00Z") } });
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
  it("values stock and flags low stock as the Inventory section does, the ones about to run out first", async () => {
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
    await seedVariant(store, "gone", "v7", { qty: 2, price: 15 }); // product not imported yet: left out, as in the Inventory section

    // Velocity window is the last 30 store-local days including today.
    await seedOrder(store, { id: "o1", createdAt: at(addDays(today, -29)), subtotal: 6000, lines: [{ product: "p1", variant: "v2", qty: 300, price: 20 }] });
    await seedOrder(store, { id: "o2", createdAt: at(addDays(today, -1)), subtotal: 80, lines: [{ product: "p1", variant: "v1", qty: 3, price: 20 }, { product: "p3", variant: "v5", qty: 2, price: 10 }] });
    await seedOrder(store, { id: "o3", createdAt: at(addDays(today, -30)), subtotal: 20000, lines: [{ product: "p1", variant: "v1", qty: 1000, price: 20 }] });
    await seedOrder(store, { id: "o4", createdAt: at(addDays(today, -2)), cancelled: true, subtotal: 10000, lines: [{ product: "p1", variant: "v1", qty: 500, price: 20 }] });

    const res = await overview(a.headers, ws, store.id);
    expect(res.statusCode).toBe(200);
    const { inventory, catalog } = res.json().modules;
    // The Inventory section's figures: units available (the oversold variant counts against them),
    // low = at or under the store's threshold of 10, out = nothing available.
    expect(inventory.current).toEqual({
      trackedVariants: 5,
      unitsInStock: 141,
      stockValueAtCost: 824,
      variantsWithCost: 3,
      retailValue: 2460,
      outOfStock: 2,
      lowStock: 1,
    });
    // The small tee sold 3 in the 30 days the orders cover: 0.1 a day, 30 days of cover.
    expect(inventory.lowStockItems).toEqual([{ productTitle: "Tee", variantTitle: "Small", sku: "TEE-S", quantity: 3, dailySales: 0.1, daysOfCover: 30 }]);

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
    // The owner's own costs (Settings → Costs) go with the sales they're set against.
    // With no ad account, Meta's and Google's figures come from the orders (ad_sources, ads_from_shopify).
    expect(Object.keys(o.modules).sort()).toEqual(["ad_sources", "ads_from_shopify", "channels", "discount_codes", "expenses", "fulfillment", "order_outcomes", "order_timing", "recent_orders", "refunds", "sales_overview", "traffic"]);
    expect(o.capabilities.find((c: { id: string }) => c.id === "inventory").missingScopes).toEqual(["read_products"]);
    expect(o.data).toEqual({ orders: 0, products: 0, variants: 0, oldestOrderDay: null, newestOrderDay: null, historyFrom: null, createdDay: null, startDay: null, history: { access: "awaiting_shopify", years: [] } });

    const p = (await overview(a.headers, ws, productsOnly.id)).json();
    // No orders read: no source for Meta's or Google's figures, said as such (ad_sources "none"), never figures.
    expect(Object.keys(p.modules).sort()).toEqual(["ad_sources", "catalog", "inventory"]);
    expect(p.modules.ad_sources.map((s: { source: string }) => s.source)).toEqual(["none", "none"]);
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
    // One day of orders is too little history for a sales rate (the Inventory section's rule).
    expect(mine.modules.inventory.lowStockItems).toEqual([{ productTitle: "Tee", variantTitle: "Default Title", sku: null, quantity: 1, dailySales: null, daysOfCover: null }]);
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
    expect(syncProblem("Shopify rejected our access (403); merchant must reconnect")).toBe("access");
    expect(syncProblem("Store x.myshopify.com is not connected")).toBe("access");
    expect(syncProblem("Shopify 4020 something")).toBe("other");
    expect(syncProblem(null)).toBe("other");
    // The worker's NotApprovedError, from Shopify's GraphQL answer or a collection it withheld.
    expect(syncProblem("Shopify hasn't approved the app for protected customer data yet: Shopify GraphQL error: This app is not approved to access the Order object.")).toBe("not_approved");
    expect(syncProblem("Shopify withheld orders (access denied). The app needs Shopify's approval for protected customer data before it can read them.")).toBe("not_approved");
  });

  it("tells Settings → Stores why too, so its card doesn't send everyone to reconnect", async () => {
    const { a, ws, store } = await owner();
    const list = async () => (await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores`, headers: a.headers })).json().stores;
    expect((await list())[0]).toMatchObject({ id: store.id, syncProblem: null });
    await systemDb.store.update({ where: { id: store.id }, data: { status: "error" } });
    await systemDb.syncJob.create({ data: { workspaceId: ws, storeId: store.id, kind: "orders", status: "failed", error: "Shopify hasn't approved the app for protected customer data yet: x" } });
    expect((await list())[0]).toMatchObject({ id: store.id, status: "error", syncProblem: "not_approved" });
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

describe("where sales come from", () => {
  it("adds up sales by the visit before each order: platforms, tagged ads, campaigns, other sites by name", async () => {
    const { a, ws, store } = await owner();
    const day = localDay(new Date(), TZ);
    const at = `${day}T16:00:00Z`;
    await seedOrder(store, { id: "F1", createdAt: at, subtotal: 100, traffic: { source: "facebook", medium: "paid", campaign: "Diwali" } });
    await seedOrder(store, { id: "F2", createdAt: at, subtotal: 50, traffic: { source: "facebook", medium: "unpaid" } });
    await seedOrder(store, { id: "I1", createdAt: at, subtotal: 200, traffic: { source: "instagram", medium: "paid", campaign: "Diwali" } });
    await seedOrder(store, { id: "G1", createdAt: at, subtotal: 30, traffic: { source: "google", medium: "unpaid", host: "google.com" } });
    await seedOrder(store, { id: "B1", createdAt: at, subtotal: 20, traffic: { source: "other", medium: "referral", host: "blog.example.org" } });
    await seedOrder(store, { id: "X1", createdAt: at, subtotal: 999, cancelled: true, traffic: { source: "facebook", medium: "paid" } });
    await seedOrder(store, { id: "P1", createdAt: at, subtotal: 40 });

    const t = (await overview(a.headers, ws, store.id, "preset=today")).json().modules.traffic;
    // X1 was cancelled: an order of the day, its sale reversed.
    expect(t.items.map((x: { label: string; sales: number; orders: number; paidSales: number }) => [x.label, x.sales, x.orders, x.paidSales])).toEqual([
      ["Instagram", 200, 1, 200],
      ["Facebook", 150, 3, 100],
      ["Google", 30, 1, 0],
      ["blog.example.org", 20, 1, 0],
    ]);
    expect(t.paid).toMatchObject({ orders: 3, sales: 300 });
    expect(t.paid.share).toBeCloseTo(300 / 400);
    expect(t.campaigns).toEqual([
      { source: "instagram", label: "Instagram", campaign: "Diwali", orders: 1, sales: 200 },
      { source: "facebook", label: "Facebook", campaign: "Diwali", orders: 1, sales: 100 },
    ]);
    // P1 was stored before sources were recorded: counted as waiting, not guessed.
    expect(t.pending).toBe(1);
  });
});

describe("Meta and Google advertising from the store's own orders", () => {
  it("gives the Advertising pages each platform's Shopify sales with no ad account connected, day by day, narrowed like the ad modules", async () => {
    const { a, ws, store } = await owner();
    await systemDb.store.update({ where: { id: store.id }, data: { ordersHistoryFrom: new Date(0), status: "active" } });
    const today = localDay(new Date(), TZ);
    const day = (n: number) => addDays(today, n);
    const at = (n: number) => `${day(n)}T16:00:00Z`;
    await seedOrder(store, { id: "F1", createdAt: at(-3), subtotal: 100, traffic: { source: "facebook", medium: "paid", campaign: "Spring" } });
    await seedOrder(store, { id: "I1", createdAt: at(-3), subtotal: 40, traffic: { source: "instagram", medium: "unpaid" } });
    await seedOrder(store, { id: "G1", createdAt: at(-2), subtotal: 60, traffic: { source: "google", medium: "paid", campaign: "Brand" } });
    await seedOrder(store, { id: "D1", createdAt: at(-2), subtotal: 80, traffic: { source: "direct", medium: "direct" } });
    await seedOrder(store, { id: "P1", createdAt: at(-2), subtotal: 10 });
    // The six days before the dates: in no figure.
    await seedOrder(store, { id: "F0", createdAt: at(-10), subtotal: 50, traffic: { source: "facebook", medium: "paid", campaign: "Spring" } });
    const range = `preset=custom&from=${day(-6)}&to=${day(-1)}`;
    const ask = async (qs: string) => (await overview(a.headers, ws, store.id, `${range}${qs}`)).json().modules;

    const all = await ask("&parts=advertising");
    // Nothing connected: no ad module, and the store's own record of each platform instead.
    expect(all).not.toHaveProperty("ads");
    const m = all.ads_from_shopify;
    expect(m).toMatchObject({ currency: store.currency, storeSales: 290, pending: 1 });
    expect(m).not.toHaveProperty("compared");
    const [meta, google] = m.platforms;
    expect(meta).toMatchObject({ provider: "meta", orders: 2, sales: 140, paidOrders: 1, paidSales: 100 });
    expect(meta.share).toBeCloseTo(140 / 290);
    for (const k of ["previous", "deltas"]) for (const p of [meta, google]) expect(p).not.toHaveProperty(k);
    expect(meta.sources.map((s: { source: string; sales: number }) => [s.source, s.sales])).toEqual([
      ["facebook", 100],
      ["instagram", 40],
    ]);
    expect(meta.campaigns).toEqual([{ source: "facebook", label: "Facebook", campaign: "Spring", orders: 1, sales: 100, paidSales: 100 }]);
    expect(meta.daily).toHaveLength(6);
    expect(meta.daily.find((d: { day: string }) => d.day === day(-3))).toEqual({ day: day(-3), orders: 2, sales: 140, paidSales: 100 });
    expect(meta.daily.find((d: { day: string }) => d.day === day(-2))).toEqual({ day: day(-2), orders: 0, sales: 0, paidSales: 0 });
    expect(google).toMatchObject({ provider: "google", orders: 1, sales: 60, paidSales: 60 });

    // One platform's page: that platform only. AdSense and one account have no such figures.
    expect((await ask("&parts=advertising&platform=meta")).ads_from_shopify.platforms.map((p: { provider: string }) => p.provider)).toEqual(["meta"]);
    expect(await ask("&parts=advertising&platform=adsense")).not.toHaveProperty("ads_from_shopify");
    expect(await ask("&parts=advertising&account=some-account")).not.toHaveProperty("ads_from_shopify");
    // The dashboard's own question computes them too while neither platform is connected (ad_sources).
    expect((await ask("")).ads_from_shopify.platforms.map((p: { provider: string; sales: number }) => [p.provider, p.sales])).toEqual([
      ["meta", 140],
      ["google", 60],
    ]);
  });

  it("picks each platform's source on every read: its own figures once connected, the orders before that and after its access ends, each store its own", async () => {
    const { a, ws, store } = await owner();
    await systemDb.store.update({ where: { id: store.id }, data: { ordersHistoryFrom: new Date(0), status: "active" } });
    const today = localDay(new Date(), TZ);
    const day = (n: number) => addDays(today, n);
    const at = (n: number) => `${day(n)}T16:00:00Z`;
    await seedOrder(store, { id: "F1", createdAt: at(-3), subtotal: 100, traffic: { source: "facebook", medium: "paid", campaign: "Spring" } });
    await seedOrder(store, { id: "G1", createdAt: at(-2), subtotal: 60, traffic: { source: "google", medium: "paid", campaign: "Brand" } });
    const range = `preset=custom&from=${day(-6)}&to=${day(-1)}`;
    const ask = async (qs = range) => (await overview(a.headers, ws, store.id, qs)).json().modules;
    const sourcesOf = (m: { ad_sources: Array<{ provider: string; source: string; state: string }> }) => Object.fromEntries(m.ad_sources.map((s) => [s.provider, [s.source, s.state]]));
    const shopifySales = (m: { ads_from_shopify: { platforms: Array<{ provider: string; sales: number }> } }, p: string) => m.ads_from_shopify.platforms.find((x) => x.provider === p)?.sales;
    const connect = (storeOf: Store, provider: "meta" | "google", accountId: string) =>
      systemDb.adConnection.create({
        data: { workspaceId: storeOf.workspaceId, storeId: storeOf.id, provider, accountId, currency: "USD", timezone: TZ, accessTokenEnc: "x", tokenKeyVersion: 1, historyFrom: "2020-01-01", syncedThrough: today, lastSyncedAt: new Date() },
      });
    const spend = (storeOf: Store, conn: { id: string; provider: string; accountId: string }, on: string, amount: number) =>
      systemDb.adCampaignDaily.create({
        data: { workspaceId: storeOf.workspaceId, storeId: storeOf.id, connectionId: conn.id, provider: conn.provider, accountId: conn.accountId, campaignId: "1", campaignName: "Spring", day: on, spend: amount, impressions: 1000, clicks: 20, linkClicks: 10 },
      });

    // Another workspace's store, with Meta and Google of its own and far bigger sales: never in this one's answer.
    const b = await signIn(ctx, "ub", "b@x.com");
    const wsB = await createWorkspace(ctx, b.headers, "B");
    const storeB = await createStore(wsB, "b.myshopify.com", ALL_SCOPES, { timezone: TZ, name: "Other Shop" });
    await systemDb.store.update({ where: { id: storeB.id }, data: { ordersHistoryFrom: new Date(0), status: "active" } });
    await seedOrder(storeB, { id: "F1", createdAt: at(-3), subtotal: 999, traffic: { source: "instagram", medium: "paid" } });
    await spend(storeB, await connect(storeB, "google", "999-999-9999"), day(-3), 500);

    // A: Shopify only. Both platforms from the store's orders, on the dashboard as on the Advertising pages.
    let m = await ask();
    expect(sourcesOf(m)).toEqual({ meta: ["shopify", "not_connected"], google: ["shopify", "not_connected"] });
    expect(m).not.toHaveProperty("ads");
    expect([shopifySales(m, "meta"), shopifySales(m, "google")]).toEqual([100, 60]);
    // The other store sees its own Google figures and Instagram sale, none of this one's.
    const other = (await overview(b.headers, wsB, storeB.id, range)).json().modules;
    expect(sourcesOf(other)).toEqual({ meta: ["shopify", "not_connected"], google: ["platform", "connected"] });
    expect(shopifySales(other, "meta")).toBe(999);
    expect(other.ads.byProvider.map((p: { provider: string; spend: number }) => [p.provider, p.spend])).toEqual([["google", 500]]);
    // Nor can it ask for this one's.
    expect((await overview(b.headers, wsB, store.id, range)).statusCode).toBe(404);

    // B: Meta connected. Meta's own figures, Google's still the orders, with no Google sign-in asked for.
    const meta = await connect(store, "meta", "act_1");
    await spend(store, meta, day(-3), 40);
    m = await ask();
    expect(sourcesOf(m)).toEqual({ meta: ["platform", "connected"], google: ["shopify", "not_connected"] });
    expect(m.ads.byProvider).toEqual([expect.objectContaining({ provider: "meta", spend: 40, impressions: 1000, linkClicks: 10, ctr: 0.01, cpc: 4, cpm: 40 })]);
    expect(shopifySales(m, "google")).toBe(60);
    // The orders Shopify credits to Meta's ads, beside Meta's own figures.
    expect(m.ads.sourced).toEqual([{ provider: "meta", orders: 1, sales: 100, salesPerSpend: 2.5 }]);

    // Meta's access ends before these dates were read: back to the orders, until it is reconnected.
    await systemDb.adConnection.update({ where: { id: meta.id }, data: { status: "reconnect", errorCode: "auth_expired", syncedThrough: day(-5) } });
    m = await ask();
    expect(sourcesOf(m).meta).toEqual(["shopify", "access_lost"]);
    expect(shopifySales(m, "meta")).toBe(100);
    // Dates it stored before its access ended stay Meta's own.
    expect(sourcesOf(await ask(`preset=custom&from=${day(-6)}&to=${day(-5)}`)).meta).toEqual(["platform", "access_lost"]);
    await systemDb.adConnection.update({ where: { id: meta.id }, data: { status: "active", errorCode: null, syncedThrough: today } });
    expect(sourcesOf(await ask()).meta).toEqual(["platform", "connected"]);

    // D: Google connected too. Both their own, and the orders aren't read for the dashboard at all.
    await spend(store, await connect(store, "google", "123-456-7890"), day(-2), 25);
    m = await ask();
    expect(sourcesOf(m)).toEqual({ meta: ["platform", "connected"], google: ["platform", "connected"] });
    expect(m).not.toHaveProperty("ads_from_shopify");
    // One platform's page: that platform's source alone.
    expect((await ask(`${range}&parts=advertising&platform=google`)).ad_sources).toEqual([{ provider: "google", source: "platform", state: "connected" }]);

    // Meta disconnected (its accounts removed): back to the orders.
    await systemDb.adCampaignDaily.deleteMany({ where: { connectionId: meta.id } });
    await systemDb.adConnection.delete({ where: { id: meta.id } });
    m = await ask();
    expect(sourcesOf(m)).toEqual({ meta: ["shopify", "not_connected"], google: ["platform", "connected"] });
    expect(shopifySales(m, "meta")).toBe(100);
  });

  it("counts the storefront's visits from each platform's sites while the pixel records where they came from", async () => {
    const { a, ws, store } = await owner([...ALL_SCOPES, "write_pixels", "read_customer_events"]);
    await systemDb.store.update({ where: { id: store.id }, data: { ordersHistoryFrom: new Date(0), status: "active", pixelInstalled: true, pixelInstalledAt: new Date(0) } });
    const today = localDay(new Date(), TZ);
    const day = (n: number) => addDays(today, n);
    await seedOrder(store, { id: "F1", createdAt: `${day(-3)}T16:00:00Z`, subtotal: 100, traffic: { source: "facebook", medium: "paid" } });
    const visit = (on: string, visitor: string, source: string | null, furthestStep = 0) => systemDb.funnelVisit.create({ data: { workspaceId: ws, storeId: store.id, day: on, visitor, source, furthestStep } });
    // Sources recorded from day -4 on: the visit before has none, and isn't counted as anyone's.
    await visit(day(-5), "v0", null);
    await visit(day(-4), "v1", "facebook", 2);
    await visit(day(-3), "v2", "instagram", 4);
    await visit(day(-3), "v3", "google");
    await visit(day(-3), "v4", "direct", 4);
    const m = (await overview(a.headers, ws, store.id, `preset=custom&from=${day(-6)}&to=${day(-1)}`)).json().modules;
    expect(m.ads_from_shopify.visitsFrom).toBe(day(-4));
    expect(m.ads_from_shopify.platforms.map((p: { provider: string; visits: number }) => [p.provider, p.visits])).toEqual([
      ["meta", 2],
      ["google", 1],
    ]);
    // How far those visits went in the store: one of Meta's added to cart, the other bought.
    expect(m.ads_from_shopify.platforms[0].journey).toEqual({ visits: 2, viewedProduct: 2, addedToCart: 2, startedCheckout: 1, purchased: 1 });
    expect(m.ads_from_shopify.platforms[1].journey).toEqual({ visits: 1, viewedProduct: 0, addedToCart: 0, startedCheckout: 0, purchased: 0 });
  });
});


describe("top 100 product performance", () => {
  const range = "dateFrom=2026-03-08&dateTo=2026-03-09";
  async function request(headers: Record<string, string>, ws: string, storeId: string, params = range) {
    return ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${storeId}/analytics/products/top-selling?${params}`, headers });
  }
  it("groups variants without duplicating orders, leaves out what sold only before the dates, and uses real net metrics", async () => {
    const { a, ws, store } = await owner();
    await systemDb.store.update({ where: { id: store.id }, data: { ordersHistoryFrom: new Date(0), status: "active" } });
    await seedProduct(store, "p1", "Renamed product", "active");
    await seedOrder(store, { id: "before", createdAt: "2026-03-06T18:00:00Z", lines: [{ product: "p1", variant: "old", qty: 4, price: 10 }] });
    await seedOrder(store, { id: "now", createdAt: "2026-03-08T18:00:00Z", lines: [{ product: "p1", variant: "v1", qty: 3, price: 10, discount: 5 }, { product: "p1", variant: "v2", qty: 5, price: 20 }] });
    await seedOrder(store, { id: "cancelled", createdAt: "2026-03-08T19:00:00Z", cancelled: true, lines: [{ product: "p1", variant: "v1", qty: 2, price: 10 }] });
    const res = await request(a.headers, ws, store.id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ total: 1, complete: true });
    expect(res.json().items[0]).toMatchObject({ rank: 1, title: "Renamed product", units: 8, grossUnits: 10, returnedUnits: 2, revenue: 125, grossSales: 150, discounts: 5, returns: 20, orders: 2 });
    // The two variants sold in the dates; the one sold two days before them isn't read.
    expect(res.json().items[0].variants.map((v: { variantId: string }) => v.variantId).sort()).toEqual(["v1", "v2"]);
    // Nothing of the period before: no change, score, or dates compared with.
    for (const k of ["growth", "trend", "trendScore", "previousUnits", "previousRevenue"]) expect(res.json().items[0]).not.toHaveProperty(k);
    for (const k of ["previous", "baseline", "pendingBaselineOrders", "weights", "minimumTrendUnits"]) expect(res.json()).not.toHaveProperty(k);
    // The rankings by change are gone with it.
    for (const sortBy of ["trending", "growth"]) expect((await request(a.headers, ws, store.id, `${range}&sortBy=${sortBy}`)).statusCode, sortBy).toBe(400);
  });
  it("ranks all products before limiting and pages ranks through 100", async () => {
    const { a, ws, store } = await owner();
    await systemDb.store.update({ where: { id: store.id }, data: { ordersHistoryFrom: new Date(0), status: "active" } });
    await seedOrder(store, { id: "many", createdAt: "2026-03-08T18:00:00Z", lines: Array.from({length: 125}, (_,i) => ({ product: `p${i}`, qty: i + 1, price: 1 })) });
    const res = await request(a.headers, ws, store.id, `${range}&limit=25&page=4`);
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(100);
    expect(res.json().items[0]).toMatchObject({ rank: 76, productId: "p49", units: 50 });
    expect(res.json().items.at(-1)).toMatchObject({ rank: 100, productId: "p25", units: 26 });
    const revenue = await request(a.headers, ws, store.id, `${range}&sortBy=revenue&search=p124`);
    expect(revenue.json().items).toHaveLength(1);
    expect(revenue.json().items[0].productId).toBe("p124");
  });
  it("does not combine unrelated historical lines with missing product IDs", async () => {
    const { a, ws, store } = await owner();
    await systemDb.store.update({ where: { id: store.id }, data: { ordersHistoryFrom: new Date(0), status: "active" } });
    await seedOrder(store, { id: "deleted", createdAt: "2026-03-08T18:00:00Z", lines: [{ qty: 2, price: 10 }, { qty: 3, price: 20 }] });
    const res = await request(a.headers, ws, store.id);
    expect(res.json()).toMatchObject({ complete: false, unknownIdentitySales: 2, items: [] });
  });
  it("validates filters, checks scopes and isolates tenant stores", async () => {
    const { a, ws, store } = await owner();
    await systemDb.store.update({ where: { id: store.id }, data: { ordersHistoryFrom: new Date(0), status: "active" } });
    expect((await request(a.headers, ws, store.id, `${range}&limit=101`)).statusCode).toBe(400);
    expect((await request(a.headers, ws, store.id, "dateFrom=2026-03-08")).statusCode).toBe(400);
    expect((await request(a.headers, ws, store.id, "dateFrom=2026-02-30&dateTo=2026-03-09")).statusCode).toBe(400);
    const other = await createWorkspace(ctx, a.headers, "Other");
    const foreign = await createStore(other, "foreign.myshopify.com", ALL_SCOPES);
    expect((await request(a.headers, ws, foreign.id)).statusCode).toBe(404);
    await systemDb.store.update({ where: { id: store.id }, data: { grantedScopes: ["read_products"] } });
    expect((await request(a.headers, ws, store.id)).statusCode).toBe(403);
  });
});

describe("product reporting completeness and reversals", () => {
  async function report(headers: Record<string, string>, ws: string, storeId: string, from = "2026-03-08", to = from) {
    return ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${storeId}/analytics/products/top-selling?dateFrom=${from}&dateTo=${to}`, headers });
  }
  it("withholds rankings for an incomplete import instead of ranking a partial population", async () => {
    const { a, ws, store } = await owner();
    await seedOrder(store, { id: "partial", createdAt: "2026-03-08T18:00:00Z", lines: [{ product: "p", qty: 3, price: 10 }] });
    expect((await report(a.headers, ws, store.id)).json()).toMatchObject({ complete: false, items: [], total: 0 });
    await systemDb.store.update({ where: { id: store.id }, data: { ordersHistoryFrom: new Date("2026-03-01T00:00:00Z"), status: "active" } });
    const order = await systemDb.order.findFirstOrThrow({ where: { storeId: store.id } });
    await systemDb.order.update({ where: { id: order.id }, data: { salesUpdatedAt: null } });
    expect((await report(a.headers, ws, store.id)).json()).toMatchObject({ complete: false, pendingOrders: 1, items: [] });
  });
  it("books partial refunds on the reversal date and retains return-only negative products", async () => {
    const { a, ws, store } = await owner();
    await systemDb.store.update({ where: { id: store.id }, data: { ordersHistoryFrom: new Date(0), status: "active" } });
    await seedOrder(store, { id: "partialRefund", createdAt: "2026-03-08T18:00:00Z", lines: [{ product: "p", qty: 3, price: 20, discount: 5 }] });
    const order = await systemDb.order.findFirstOrThrow({ where: { storeId: store.id } });
    await systemDb.orderSale.create({ data: { workspaceId: ws, storeId: store.id, orderId: order.id, shopifyId: "partialRefund-return", localDay: "2026-03-09", happenedAt: new Date("2026-03-09T18:00:00Z"), actionType: "return", lineType: "product", lineItemShopifyId: "partialRefund-0", quantity: 1, amount: -18.33, discount: 0, tax: 0 } });
    expect((await report(a.headers, ws, store.id, "2026-03-08", "2026-03-09")).json().items[0]).toMatchObject({ units: 2, grossUnits: 3, returnedUnits: 1, grossSales: 60, discounts: 5, returns: 18.33, revenue: 36.67 });
    expect((await report(a.headers, ws, store.id, "2026-03-09")).json().items[0]).toMatchObject({ units: -1, revenue: -18.33, orders: 0, returnedUnits: 1 });
  });
  it("aggregates more than 10,000 orders without a retrieval cap", async () => {
    const { a, ws, store } = await owner();
    await systemDb.store.update({ where: { id: store.id }, data: { ordersHistoryFrom: new Date(0), status: "active" } });
    const at = new Date("2026-03-08T18:00:00Z");
    const ids = Array.from({length: 10001}, (_, i) => `scale-${i}`);
    await systemDb.order.createMany({ data: ids.map(id => ({ id, workspaceId: ws, storeId: store.id, shopifyId: id, name: id, currency: "USD", localDay: "2026-03-08", shopifyCreatedAt: at, shopifyUpdatedAt: at, salesUpdatedAt: at, subtotal: 1, totalDiscounts: 0, totalTax: 0, totalShipping: 0, totalPrice: 1 })) });
    await systemDb.orderLineItem.createMany({ data: ids.map(id => ({ workspaceId: ws, storeId: store.id, orderId: id, shopifyId: id, productShopifyId: "popular", title: "Popular", quantity: 1, price: 1, discount: 0 })) });
    await systemDb.orderSale.createMany({ data: ids.map(id => ({ workspaceId: ws, storeId: store.id, orderId: id, shopifyId: id, lineItemShopifyId: id, localDay: "2026-03-08", happenedAt: at, actionType: "order", lineType: "product", quantity: 1, amount: 1, discount: 0, tax: 0 })) });
    const errors = vi.spyOn(logger, "error");
    const result = await report(a.headers, ws, store.id);
    const diagnostics = JSON.stringify(errors.mock.calls, (_key, value) => value instanceof Error ? { name: value.name, message: value.message } : value);
    errors.mockRestore();
    expect(result.statusCode, diagnostics).toBe(200);
    expect(result.json().items[0]).toMatchObject({ units: 10001, revenue: 10001, orders: 10001 });
  }, 60000);
});

describe("product rankings and the days before the dates", () => {
  it("ranks the dates' products whatever state the orders of the days before are in", async () => {
    const { a, ws, store } = await owner();
    await systemDb.store.update({ where: { id: store.id }, data: { ordersHistoryFrom: new Date(0), status: "active" } });
    await seedOrder(store, { id: "prior-unverified", createdAt: "2026-03-07T18:00:00Z", lines: [{ product: "p", qty: 10, price: 10 }] });
    await seedOrder(store, { id: "verified-current", createdAt: "2026-03-08T18:00:00Z", lines: [{ product: "p", qty: 20, price: 10 }] });
    const prior = await systemDb.order.findFirstOrThrow({ where: { storeId: store.id, shopifyId: "prior-unverified" } });
    await systemDb.order.update({ where: { id: prior.id }, data: { salesUpdatedAt: null } });
    const request = () => ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${store.id}/analytics/products/top-selling?dateFrom=2026-03-08&dateTo=2026-03-08`, headers: a.headers });
    let res = await request();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ complete: true, pendingOrders: 0 });
    expect(res.json().items[0]).toMatchObject({ units: 20, revenue: 200 });
    await systemDb.order.update({ where: { id: prior.id }, data: { salesUpdatedAt: new Date() } });
    await systemDb.orderLineItem.deleteMany({ where: { orderId: prior.id } });
    res = await request();
    expect(res.json()).toMatchObject({ complete: true });
    expect(res.json().items[0]).toMatchObject({ units: 20, revenue: 200 });
  });
});

describe("historical dates, up to 12 months at a time", () => {
  const today = localDay(new Date(), TZ);

  it("takes the last 6 and 12 months, and any calendar year, however long ago", async () => {
    const { a, ws, store } = await owner();
    for (const [preset, from] of [["6m", addDays(monthsEarlier(today, 6), 1)], ["12m", addDays(yearEarlier(today), 1)]] as const) {
      const res = await overview(a.headers, ws, store.id, `preset=${preset}`);
      expect(res.statusCode, preset).toBe(200);
      expect(res.json().range, preset).toEqual({ from, to: today });
    }
    // 2023 on its own: an older year is a question like this one.
    await seedOrder(store, { id: "Y23", createdAt: "2023-06-01T16:00:00Z", lines: [{ qty: 1, price: 80 }] });
    await seedOrder(store, { id: "Y22", createdAt: "2022-06-01T16:00:00Z", lines: [{ qty: 1, price: 40 }] });
    await recomputeDays(store, ["2023-06-01", "2022-06-01"]);
    await systemDb.store.update({ where: { id: store.id }, data: { ordersHistoryFrom: new Date(0) } });
    const res = await overview(a.headers, ws, store.id, "preset=custom&from=2023-01-01&to=2023-12-31");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.range).toEqual({ from: "2023-01-01", to: "2023-12-31" });
    expect(body.previous).toEqual({ from: "2022-01-01", to: "2022-12-31" });
    expect(body.modules.sales_overview.current).toMatchObject({ netSales: 80, orders: 1 });
    expect(body.modules.sales_overview).not.toHaveProperty("previous");
    expect(body.modules.sales_overview.series).toHaveLength(365);
    // The leap year 2024, all 366 days of it, is 12 months too.
    expect((await overview(a.headers, ws, store.id, "preset=custom&from=2024-01-01&to=2024-12-31")).statusCode).toBe(200);
  });

  it("refuses more than 12 months at once", async () => {
    const { a, ws, store } = await owner();
    for (const qs of [
      "preset=custom&from=2023-01-01&to=2024-01-01",
      "preset=custom&from=2025-03-15&to=2026-03-15",
    ]) {
      const res = await overview(a.headers, ws, store.id, qs);
      expect(res.statusCode, qs).toBe(400);
      expect(res.json(), qs).toMatchObject({ error: "invalid_range", message: expect.stringContaining("12 months") });
    }
    // The downloads read the same rule.
    const csv = await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${store.id}/export?section=sales&preset=custom&from=2023-01-01&to=2024-01-01`, headers: a.headers });
    expect(csv.statusCode).toBe(400);
  });

  it("keeps custom dates from starting before Shopify created the store, and says where its dates begin", async () => {
    const { a, ws, store } = await owner();
    // 14 Mar 2022, 3 am UTC is still the 13th in New York.
    await systemDb.store.update({ where: { id: store.id }, data: { shopCreatedAt: new Date("2022-03-14T03:00:00Z") } });
    const before = await overview(a.headers, ws, store.id, "preset=custom&from=2022-01-01&to=2022-12-31");
    expect(before.statusCode).toBe(400);
    expect(before.json().message).toContain("first day");
    const from = await overview(a.headers, ws, store.id, "preset=custom&from=2022-03-13&to=2022-12-31");
    expect(from.statusCode).toBe(200);
    // The period before reaches back before the store: not refused.
    expect(from.json().previous).toMatchObject({ from: "2021-05-23", to: "2022-03-12" });
    expect(from.json().data).toMatchObject({ createdDay: "2022-03-13", startDay: "2022-03-13" });
    const list = await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores`, headers: a.headers });
    expect(list.json().stores[0]).toMatchObject({ startDay: "2022-03-13", shopCreatedAt: "2022-03-14T03:00:00.000Z" });
  });

  it("says how far the full order history has got, a year at a time, once the store holds read_all_orders", async () => {
    const { a, ws, store } = await owner([...ALL_SCOPES, "read_all_orders"]);
    const year = (y: number, status: string, orders: number) => ({
      workspaceId: ws,
      storeId: store.id,
      planJobId: "j",
      syncJobId: "j",
      year: y,
      fromAt: new Date(`${y}-01-01T05:00:00Z`),
      toAt: new Date(`${y + 1}-01-01T05:00:00Z`),
      status,
      orders,
      withCustomers: true,
    });
    await systemDb.orderHistoryWindow.createMany({ data: [year(2026, "done", 40), year(2025, "done", 120), year(2024, "running", 0), year(2023, "queued", 0)] });
    await systemDb.store.update({ where: { id: store.id }, data: { ordersHistoryFrom: new Date("2025-01-01T05:00:00Z") } });
    const { data } = (await overview(a.headers, ws, store.id)).json();
    expect(data.history).toEqual({
      access: "granted",
      years: [
        { year: 2026, status: "done", orders: 40, finishedAt: null },
        { year: 2025, status: "done", orders: 120, finishedAt: null },
        { year: 2024, status: "running", orders: 0, finishedAt: null },
        { year: 2023, status: "queued", orders: 0, finishedAt: null },
      ],
    });
    expect(data.historyFrom).toBe("2025-01-01");
    // 2024 isn't in yet: 2025 is answered on its own.
    expect((await overview(a.headers, ws, store.id, "preset=custom&from=2025-01-01&to=2025-12-31")).statusCode).toBe(200);
  });

  it("offers a reconnect for full order history only to the stores of an app that declares it (SHOPIFY_APP_SCOPES)", async () => {
    // Shopify approves read_all_orders app by app: a store of an app that has it can grant it by
    // reconnecting; a store of one that hasn't is waiting on Shopify, with nothing to press.
    const { a, ws, store } = await owner();
    const other = await createStore(ws, "pix.myshopify.com", ALL_SCOPES, { timezone: TZ, shopifyAppKey: "pixmagic" });
    ctx.setEnv({ SHOPIFY_APP_SCOPES: "pixmagic:read_all_orders" });
    try {
      expect((await overview(a.headers, ws, other.id)).json().data.history.access).toBe("reconnect");
      expect((await overview(a.headers, ws, store.id)).json().data.history.access).toBe("awaiting_shopify");
    } finally {
      ctx.setEnv({ SHOPIFY_APP_SCOPES: "" });
    }
  });
});

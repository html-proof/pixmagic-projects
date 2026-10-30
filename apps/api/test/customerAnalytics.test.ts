import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { systemDb, withTenant } from "@app/db";
import { customerKey, recomputeDays, settleReturningCustomers } from "@app/core";
import { customerAnalytics, type CustomerAnalyticsView } from "@app/core/reports";
import { clean, createStore, createWorkspace, setup, signIn, teardown, type TestCtx } from "./helpers.js";

/**
 * GET .../analytics/customers: repeat customers, orders and net sales per customer for the dates,
 * and monthly first-order cohorts (core reports/customers.ts), from the orders stored only, from
 * the first day customers are known on them.
 */

let ctx: TestCtx;
beforeAll(async () => (ctx = await setup()));
afterAll(async () => teardown(ctx));
beforeEach(async () => clean(ctx));

const SCOPES = ["read_orders", "read_customers"];
type Store = Awaited<ReturnType<typeof createStore>>;
const SEPTEMBER = "preset=custom&from=2026-09-01&to=2026-09-30";
// The store's "now" for the cohorts: its months run to October 2026.
const NOW = new Date("2026-10-20T12:00:00Z");
const EVERYTHING: CustomerAnalyticsView = { orders: true, money: true };

interface Seed {
  /** Shopify's customer id; null: a guest checkout. */
  customer: string | null;
  /** Net sales of the order (one product line), and its tax on top. */
  value: number;
  tax?: number;
  /** Shopify's position of the order in its customer's history. */
  index?: number;
  giftCard?: boolean;
  /** Its sales not read from Shopify yet. */
  pending?: boolean;
  /** A return of this much, on that day. */
  refund?: { day: string; value: number };
}

/** An order as the pipeline stores it, at noon (UTC) on `day`, with its sales records. */
async function seedOrder(store: Store, id: string, day: string, s: Seed) {
  const at = new Date(`${day}T12:00:00Z`);
  const tax = s.tax ?? 0;
  const sales = [
    { shopifyId: `${id}-sale`, localDay: day, happenedAt: at, actionType: "order", lineType: s.giftCard ? "gift_card" : "product", quantity: 1, amount: s.value + tax, discount: 0, tax },
    ...(s.refund ? [{ shopifyId: `${id}-return`, localDay: s.refund.day, happenedAt: new Date(`${s.refund.day}T12:00:00Z`), actionType: "return", lineType: "product", quantity: -1, amount: -s.refund.value, discount: 0, tax: 0 }] : []),
  ];
  await systemDb.order.create({
    data: {
      workspaceId: store.workspaceId,
      storeId: store.id,
      shopifyId: id,
      name: `#${id}`,
      currency: "USD",
      localDay: day,
      shopifyCreatedAt: at,
      shopifyProcessedAt: at,
      shopifyUpdatedAt: at,
      giftCardOnly: !!s.giftCard,
      subtotal: s.value,
      totalDiscounts: 0,
      totalTax: tax,
      totalShipping: 0,
      totalPrice: s.value + tax,
      customerKey: s.customer === null ? null : customerKey(store, s.customer),
      customerOrderIndex: s.index ?? null,
      salesUpdatedAt: s.pending ? null : at,
      sales: { create: sales.map((x) => ({ ...x, workspaceId: store.workspaceId, storeId: store.id, lineItemShopifyId: `${id}-line` })) },
    },
  });
  return day;
}

/** What the pipeline does after orders land: settle who is returning, then the day totals. */
async function settle(store: Store, days: Iterable<string>) {
  await settleReturningCustomers(store.id);
  await recomputeDays(store, [...new Set(days)]);
}

/**
 * The import window started at 10:00 on 14 August, so the 15th is the first whole day.
 *
 * - D bought on the 14th (before the first whole day) and again on 5 September.
 * - E first bought on 20 August, again on 1 October.
 * - A first bought on 3 September, again on the 20th and on 5 October.
 * - B first bought on 10 September (40, 10 of it returned on 2 October).
 * - C's order of 12 September is their third in Shopify: they bought before the imported orders.
 * - A guest's order, a customer of gift cards only, and a customer since redacted, in September.
 */
async function history(store: Store) {
  await systemDb.store.update({ where: { id: store.id }, data: { ordersHistoryFrom: new Date("2026-08-14T10:00:00Z") } });
  const days = [
    await seedOrder(store, "d1", "2026-08-14", { customer: "D", value: 10 }),
    await seedOrder(store, "e1", "2026-08-20", { customer: "E", value: 70 }),
    await seedOrder(store, "a1", "2026-09-03", { customer: "A", value: 50 }),
    await seedOrder(store, "d2", "2026-09-05", { customer: "D", value: 25 }),
    await seedOrder(store, "b1", "2026-09-10", { customer: "B", value: 40, refund: { day: "2026-10-02", value: 10 } }),
    await seedOrder(store, "c3", "2026-09-12", { customer: "C", value: 60, tax: 6, index: 3 }),
    await seedOrder(store, "guest", "2026-09-15", { customer: null, value: 99 }),
    await seedOrder(store, "gift", "2026-09-16", { customer: "F", value: 500, giftCard: true }),
    await seedOrder(store, "g1", "2026-09-18", { customer: "G", value: 33 }),
    await seedOrder(store, "a2", "2026-09-20", { customer: "A", value: 30 }),
    await seedOrder(store, "e2", "2026-10-01", { customer: "E", value: 15 }),
    await seedOrder(store, "a3", "2026-10-05", { customer: "A", value: 20 }),
    "2026-10-02",
  ];
  await settleReturningCustomers(store.id);
  // customers/redact: G's orders lose their customer.
  await systemDb.order.updateMany({ where: { storeId: store.id, customerKey: customerKey(store, "G") }, data: { customerKey: null } });
  await settle(store, days);
}

async function owner(scopes = SCOPES) {
  const a = await signIn(ctx, "ua", "a@x.com");
  const ws = await createWorkspace(ctx, a.headers, "A");
  const store = await createStore(ws, "a.myshopify.com", scopes);
  return { a, ws, store };
}

async function member(ws: string, uid: string, permissions: string[]) {
  const m = await signIn(ctx, uid, `${uid}@x.com`);
  await systemDb.membership.create({ data: { workspaceId: ws, userId: m.user.id, role: "custom", permissions } });
  return m;
}

const report = async (ws: string, store: Store, view: CustomerAnalyticsView = EVERYTHING, range = { from: "2026-09-01", to: "2026-09-30" }, now = NOW) => {
  const fresh = await systemDb.store.findUniqueOrThrow({ where: { id: store.id } });
  return withTenant(ws, (tx) => customerAnalytics(tx, { ws, storeId: store.id }, fresh, range, now, view));
};

const get = (headers: Record<string, string>, ws: string, storeId: string, qs = SEPTEMBER) =>
  ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${storeId}/analytics/customers?${qs}`, headers });

describe("customer lifetime figures and cohorts (core customerAnalytics)", () => {
  it("counts the dates' customers once each, from the stored orders, guests and redacted customers aside", async () => {
    const { ws, store } = await owner();
    await history(store);
    const r = await report(ws, store);
    expect(r).toMatchObject({ today: "2026-10-20", importing: false, customersFrom: "2026-08-15", historyFrom: "2026-08-14", historyAccess: "awaiting_shopify", customersLater: false });
    // A, B, C and D ordered in September; only A twice. The gift-card customer isn't one; G was redacted.
    expect(r.dates).toEqual({
      from: "2026-09-01",
      to: "2026-09-30",
      clamped: false,
      withoutCustomer: 2,
      salesPending: 0,
      salesUnread: 0,
      figures: {
        customers: 4,
        repeatCustomers: 1,
        repeatRate: 0.25,
        orders: 5,
        ordersPerCustomer: 1.25,
        // 50 + 30 + (40 − 10 returned since) + 60 (before its tax) + 25.
        netSales: 195,
        netSalesPerCustomer: 48.75,
      },
    });
  });

  it("groups customers by the month of their first purchase, month 0 being the repeat orders of that month", async () => {
    const { ws, store } = await owner();
    await history(store);
    const { cohorts } = await report(ws, store);
    expect(cohorts!.from).toBe("2026-08-15");
    expect(cohorts!.items.map((c) => [c.month, c.customers, c.partial, c.repeatCustomers])).toEqual([
      ["2026-10", 0, false, 0],
      ["2026-09", 2, false, 1],
      // August began before customers are known: D's first order of the 14th isn't counted in it.
      ["2026-08", 1, true, 1],
    ]);
    const [oct, sep, aug] = cohorts!.items;
    expect(oct!.cells).toEqual([{ n: 0, month: "2026-10", returned: 0, rate: null, running: true, netSalesPerCustomerToDate: null }]);
    // A came back in September (month 0) and October (month 1); B didn't.
    expect(sep!.cells.map((c) => [c.n, c.returned, c.rate, c.running, c.netSalesPerCustomerToDate])).toEqual([
      [0, 1, 0.5, false, 55],
      [1, 1, 0.5, true, 65],
    ]);
    expect(sep).toMatchObject({ repeatRate: 0.5, ordersPerCustomer: 2, netSalesPerCustomer: 65 });
    // E: nothing more in August or September, back in October (month 2, so far).
    expect(aug!.cells.map((c) => [c.n, c.returned, c.running, c.netSalesPerCustomerToDate])).toEqual([
      [0, 0, false, 70],
      [1, 0, false, 70],
      [2, 1, true, 85],
    ]);
    // C (Shopify's third order) and D (first bought on the 14th) came back but were never new here.
    expect(cohorts!.returningFromBefore).toBe(2);
    expect(cohorts!.acquired).toEqual({ customers: 3, repeatCustomers: 2, repeatRate: 2 / 3, orders: 6, ordersPerCustomer: 2, netSales: 215, netSalesPerCustomer: 71.67 });
  });

  it("lists only the months asked for: earlier first buyers count as from before", async () => {
    const { ws, store } = await owner();
    await history(store);
    const { cohorts } = await report(ws, store, { ...EVERYTHING, months: 2 });
    expect(cohorts!.from).toBe("2026-09-01");
    expect(cohorts!.items.map((c) => [c.month, c.customers, c.partial])).toEqual([
      ["2026-10", 0, false],
      ["2026-09", 2, false],
    ]);
    // C, D and now E (first bought in August).
    expect(cohorts!.returningFromBefore).toBe(3);
  });

  it("counts from the day after customers were first known when Your customers was granted later, and says the dates were cut", async () => {
    const { ws, store } = await owner();
    await systemDb.store.update({ where: { id: store.id }, data: { ordersHistoryFrom: new Date("2026-06-01T00:00:00Z") } });
    // Orders read before read_customers was granted have no customer; it was granted with 60 days re-read from part way through 20 August.
    const days = [
      await seedOrder(store, "old1", "2026-06-05", { customer: null, value: 10 }),
      await seedOrder(store, "old2", "2026-07-15", { customer: null, value: 10 }),
      // That morning's order, read before the grant: no customer.
      await seedOrder(store, "old3", "2026-08-20", { customer: null, value: 10 }),
      await seedOrder(store, "h1", "2026-08-20", { customer: "H", value: 10 }),
      await seedOrder(store, "i1", "2026-08-25", { customer: "I", value: 10 }),
      await seedOrder(store, "i2", "2026-09-02", { customer: "I", value: 10 }),
    ];
    await settle(store, days);
    const r = await report(ws, store, EVERYTHING, { from: "2026-06-01", to: "2026-09-30" });
    expect(r).toMatchObject({ customersFrom: "2026-08-21", historyFrom: "2026-06-01", customersLater: true });
    expect(r.dates).toMatchObject({ from: "2026-08-21", to: "2026-09-30", clamped: true, figures: { customers: 1, repeatCustomers: 1, orders: 2 }, withoutCustomer: 0 });
    expect(r.cohorts!.items.map((c) => [c.month, c.customers, c.partial])).toEqual([
      ["2026-10", 0, false],
      ["2026-09", 0, false],
      ["2026-08", 1, true],
    ]);
    // Dates that end before customers are known: no figures, not zeros.
    expect((await report(ws, store, EVERYTHING, { from: "2026-06-01", to: "2026-07-31" })).dates).toBeNull();
  });

  it("isn't started earlier by an old order that has its customer out of turn", async () => {
    const { ws, store } = await owner();
    await systemDb.store.update({ where: { id: store.id }, data: { ordersHistoryFrom: new Date("2026-06-01T00:00:00Z") } });
    const days = [
      // Old orders updated since the grant (a refund, say): they carry their customer, the others of their time don't.
      await seedOrder(store, "early", "2026-05-20", { customer: "K", value: 10 }),
      await seedOrder(store, "old1", "2026-06-05", { customer: null, value: 10 }),
      await seedOrder(store, "updated", "2026-06-10", { customer: "L", value: 10 }),
      await seedOrder(store, "old2", "2026-07-15", { customer: null, value: 10 }),
      await seedOrder(store, "old3", "2026-08-01", { customer: null, value: 10 }),
      await seedOrder(store, "h1", "2026-08-20", { customer: "H", value: 10 }),
      await seedOrder(store, "i1", "2026-08-25", { customer: "I", value: 10 }),
    ];
    await settle(store, days);
    expect(await report(ws, store, EVERYTHING, { from: "2026-06-01", to: "2026-09-30" })).toMatchObject({ customersFrom: "2026-08-20", customersLater: true, dates: { from: "2026-08-20", clamped: true } });
  });

  it("has nothing to show before any order has a known customer", async () => {
    const { ws, store } = await owner();
    await systemDb.store.update({ where: { id: store.id }, data: { ordersHistoryFrom: new Date("2026-08-14T10:00:00Z") } });
    await settle(store, [await seedOrder(store, "guest", "2026-09-15", { customer: null, value: 99 })]);
    expect(await report(ws, store)).toMatchObject({ customersFrom: null, dates: null, cohorts: null });
  });

  it("withholds net sales per customer while an order's sales aren't read from Shopify, never a partial sum", async () => {
    const { ws, store } = await owner();
    await history(store);
    await settle(store, [await seedOrder(store, "late", "2026-09-25", { customer: "B", value: 80, pending: true })]);
    const r = await report(ws, store);
    expect(r.dates!.salesPending).toBe(1);
    expect(r.cohorts!.salesPending).toBe(1);
    expect(r.dates!.figures).toMatchObject({ customers: 4, repeatCustomers: 2, netSales: null, netSalesPerCustomer: null });
    expect(r.cohorts!.acquired.netSalesPerCustomer).toBeNull();
    expect(r.cohorts!.items[1]!.cells.map((c) => c.netSalesPerCustomerToDate)).toEqual([null, null]);
    // The retention figures don't wait for sales, and nor does a cohort none of whose orders waits.
    expect(r.cohorts!.items[1]!.cells.map((c) => c.returned)).toEqual([2, 1]);
    expect(r.cohorts!.items[2]!.cells.map((c) => c.netSalesPerCustomerToDate)).toEqual([70, 70, 85]);
    expect(r.cohorts!.salesUnread).toBe(0);
  });

  it("tells sales never to be read (older than the re-read's 60 days) from sales still to come, and keeps the other cohorts' net sales", async () => {
    const { ws, store } = await owner();
    await history(store);
    // Stored before bizinsights read Shopify's sales records, and created before the 60 days it reads again.
    await settle(store, [await seedOrder(store, "old", "2026-08-16", { customer: "J", value: 45, pending: true })]);
    const r = await report(ws, store, EVERYTHING, { from: "2026-08-15", to: "2026-09-30" });
    expect(r.dates).toMatchObject({ salesPending: 0, salesUnread: 1, figures: { netSales: null, netSalesPerCustomer: null } });
    expect(r.cohorts).toMatchObject({ salesPending: 0, salesUnread: 1, acquired: { netSalesPerCustomer: null } });
    const [, sep, aug] = r.cohorts!.items;
    // August holds J's order: no net sales, never a sum that leaves it out. September's are all read.
    expect(aug!.netSalesPerCustomer).toBeNull();
    expect(aug!.cells.map((c) => c.netSalesPerCustomerToDate)).toEqual([null, null, null]);
    expect(sep).toMatchObject({ customers: 2, netSalesPerCustomer: 65 });
    // September's dates alone have nothing unread.
    expect((await report(ws, store)).dates).toMatchObject({ salesUnread: 0, figures: { netSalesPerCustomer: 48.75 } });
  });

  it("leaves order counts and net sales out unless asked for", async () => {
    const { ws, store } = await owner();
    await history(store);
    const r = await report(ws, store, { orders: false, money: false });
    expect(r).not.toHaveProperty("historyFrom");
    expect(r).not.toHaveProperty("historyAccess");
    expect(r).not.toHaveProperty("customersLater");
    expect(r.dates).toEqual({ from: "2026-09-01", to: "2026-09-30", clamped: false, figures: { customers: 4, repeatCustomers: 1, repeatRate: 0.25 } });
    expect(r.cohorts!.acquired).toEqual({ customers: 3, repeatCustomers: 2, repeatRate: 2 / 3 });
    expect(JSON.stringify(r.cohorts)).not.toMatch(/netSales|ordersPerCustomer|salesPending/);
  });
});

describe("GET .../analytics/customers", () => {
  it("answers the owner with every figure", async () => {
    const { a, ws, store } = await owner();
    await history(store);
    const res = await get(a.headers, ws, store.id);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ range: { from: "2026-09-01", to: "2026-09-30" }, months: 12, customersFrom: "2026-08-15", historyFrom: "2026-08-14", dates: { salesPending: 0 } });
    expect(body.dates.figures).toMatchObject({ customers: 4, repeatCustomers: 1, ordersPerCustomer: 1.25, netSalesPerCustomer: 48.75 });
    expect(body.dates.withoutCustomer).toBe(2);
    expect(Array.isArray(body.cohorts.items)).toBe(true);
    // The months asked for reach core: two, the store's (UTC) month and the one before, where the
    // twelve list every month since the history's August. Counted from the real today, as the route is.
    expect(body.cohorts.items.length).toBeGreaterThan(2);
    const two = (await get(a.headers, ws, store.id, `${SEPTEMBER}&months=2`)).json();
    expect(two.months).toBe(2);
    expect(two.cohorts.items).toHaveLength(2);
    expect(two.cohorts.items[0].month).toBe(new Date().toISOString().slice(0, 7));
  });

  it("shows a member with only View returning vs new customers the customers, not the store's orders or sales", async () => {
    const { ws, store } = await owner();
    await history(store);
    const customers = await member(ws, "uc", ["customers.analytics"]);
    const res = await get(customers.headers, ws, store.id);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.dates).toEqual({ from: "2026-09-01", to: "2026-09-30", clamped: false, figures: { customers: 4, repeatCustomers: 1, repeatRate: 0.25 } });
    expect(body).not.toHaveProperty("historyFrom");
    expect(body).not.toHaveProperty("historyAccess");
    expect(res.body).not.toMatch(/netSales|ordersPerCustomer|withoutCustomer|salesPending|customersLater/);
    // With the order list too: order counts, still no money.
    const orders = await member(ws, "uo", ["customers.analytics", "orders.list"]);
    const withOrders = (await get(orders.headers, ws, store.id)).json();
    expect(withOrders.dates.figures).toMatchObject({ orders: 5, ordersPerCustomer: 1.25 });
    expect(withOrders.dates.withoutCustomer).toBe(2);
    expect(JSON.stringify(withOrders)).not.toMatch(/netSales/);
  });

  it("needs View returning vs new customers and the store's orders and customers", async () => {
    const { ws, store } = await owner();
    const sales = await member(ws, "us", ["analytics.sales", "orders.list"]);
    expect((await get(sales.headers, ws, store.id)).statusCode).toBe(403);
    const customers = await member(ws, "uc", ["customers.analytics"]);
    const ordersOnly = await createStore(ws, "o.myshopify.com", ["read_orders"]);
    const refused = await get(customers.headers, ws, ordersOnly.id);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe("missing_scope");
  });

  it("answers 404 for another workspace's store before reading the question, and keeps each store's customers its own", async () => {
    const { a, ws, store } = await owner();
    await history(store);
    const b = await signIn(ctx, "ub", "b@x.com");
    const wsB = await createWorkspace(ctx, b.headers, "B");
    const storeB = await createStore(wsB, "b.myshopify.com", SCOPES, { ordersHistoryFrom: new Date("2026-08-14T10:00:00Z") });
    // The same Shopify customer ids in the other business.
    const theirs = [
      await seedOrder(storeB, "x1", "2026-09-04", { customer: "A", value: 900 }),
      await seedOrder(storeB, "x2", "2026-09-06", { customer: "A", value: 900 }),
      await seedOrder(storeB, "x3", "2026-09-07", { customer: "B", value: 900 }),
    ];
    await settle(storeB, theirs);
    for (const qs of [SEPTEMBER, "preset=nonsense", "months=0"]) {
      expect((await get(a.headers, ws, storeB.id, qs)).statusCode).toBe(404);
      expect((await get(a.headers, wsB, storeB.id, qs)).statusCode).toBe(404);
    }
    // One's own store with a question that can't be read is a 400.
    expect((await get(a.headers, ws, store.id, "preset=nonsense")).statusCode).toBe(400);
    expect((await get(a.headers, ws, store.id, `${SEPTEMBER}&months=25`)).statusCode).toBe(400);
    const mine = (await get(a.headers, ws, store.id)).json();
    expect(mine.dates.figures).toMatchObject({ customers: 4, repeatCustomers: 1, orders: 5, netSales: 195 });
    const other = (await get(b.headers, wsB, storeB.id)).json();
    expect(other.dates.figures).toMatchObject({ customers: 2, repeatCustomers: 1, orders: 3, netSales: 2700 });
    // Within the tenant's own transaction, the other business's rows aren't there at all.
    const seen = await withTenant(ws, (tx) => tx.order.count({ where: { storeId: storeB.id } }));
    expect(seen).toBe(0);
  });
});

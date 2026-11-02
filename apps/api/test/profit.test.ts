import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { systemDb, type Store } from "@app/db";
import { clean, createStore, createWorkspace, setup, signIn, teardown, type TestCtx } from "./helpers.js";

/**
 * The Profit sheet's profit and loss (GET …/profit?month=), end to end: the brief's own example (rent
 * ₹15,000, salaries ₹30,000, software ₹3,000 and other fixed costs ₹2,000 a month, a ₹10,000 day with
 * ₹4,000 of variable costs), from the store's sales records, its products' cost per item and the
 * owner's costs; who may read it, and what is left out for whom.
 */

let ctx: TestCtx;
beforeAll(async () => (ctx = await setup()));
afterAll(async () => teardown(ctx));
beforeEach(async () => clean(ctx));

type Headers = Record<string, string>;
const call = (method: string, url: string, headers: Headers = {}, payload?: unknown) => ctx.app.inject({ method, url, headers, payload });
function ok<T = any>(res: Awaited<ReturnType<typeof call>>, status = 200): T { // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(res.statusCode, res.body).toBe(status);
  return res.json();
}

// September 2026: 30 days.
const MONTH = "2026-09";
const GOOD_DAY = "2026-09-02";
const BAD_DAY = "2026-09-03";

let users = 0;
async function member(ws: string, permissions: string[]) {
  const n = ++users;
  const m = await signIn(ctx, `profit-member-${n}`, `profit${n}@example.com`);
  await systemDb.membership.create({ data: { workspaceId: ws, userId: m.user.id, role: "custom", permissions } });
  return m;
}

async function owner(name = "owner") {
  const a = await signIn(ctx, `profit-${name}`, `${name}@profit.test`);
  const ws = await createWorkspace(ctx, a.headers, `Profit ${name}`);
  const store = await createStore(ws, `profit-${name}.myshopify.com`, ["read_orders", "read_products"], { timezone: "UTC", currency: "INR", name: "Profit Shop", ordersHistoryFrom: new Date(0) });
  return { a, ws, store };
}

/** A day's sales records: one order of `qty` tees at ₹1,000, each costing ₹`unitCost` (the variant's cost per item). */
async function sell(store: Store, day: string, qty: number) {
  const at = new Date(`${day}T12:00:00Z`);
  const id = `o-${day}`;
  await systemDb.order.create({
    data: {
      workspaceId: store.workspaceId,
      storeId: store.id,
      shopifyId: id,
      name: `#${id}`,
      currency: "INR",
      localDay: day,
      shopifyCreatedAt: at,
      shopifyUpdatedAt: at,
      subtotal: qty * 1000,
      totalDiscounts: 0,
      totalTax: 0,
      totalShipping: 0,
      totalPrice: qty * 1000,
      salesUpdatedAt: at,
      lineItems: { create: [{ workspaceId: store.workspaceId, storeId: store.id, shopifyId: `${id}-0`, productShopifyId: "tee", variantShopifyId: "tee-v", title: "Tee", quantity: qty, price: 1000, discount: 0 }] },
      sales: { create: [{ workspaceId: store.workspaceId, storeId: store.id, shopifyId: `${id}-sale`, lineType: "product", actionType: "order", lineItemShopifyId: `${id}-0`, quantity: qty, amount: qty * 1000, discount: 0, tax: 0, localDay: day, happenedAt: at }] },
    },
  });
  await systemDb.dailyStoreMetrics.create({ data: { workspaceId: store.workspaceId, storeId: store.id, day, grossSales: qty * 1000, totalSales: qty * 1000, orders: 1, units: qty, orderValue: qty * 1000 } });
}

const url = (ws: string, storeId: string, rest = "") => `/workspaces/${ws}/stores/${storeId}${rest}`;
const monthly = (name: string, category: string, amount: number) => ({ name, category, amount, cadence: "monthly", startsOn: "2025-01-01", endsOn: null, note: null });

async function brief() {
  const o = await owner();
  await systemDb.productVariant.create({ data: { workspaceId: o.ws, storeId: o.store.id, productShopifyId: "tee", shopifyId: "tee-v", title: "Tee", price: 1000, unitCost: 300, shopifyUpdatedAt: new Date() } });
  // ₹10,000 on the 2nd (₹3,000 of tees at cost), ₹2,000 on the 3rd (₹600).
  await sell(o.store, GOOD_DAY, 10);
  await sell(o.store, BAD_DAY, 2);
  for (const c of [monthly("Shop rent", "rent", 15_000), monthly("Salaries", "staff", 30_000), monthly("Software", "software", 3_000), monthly("Other", "other", 2_000)]) ok(await call("POST", url(o.ws, o.store.id, "/expenses"), o.a.headers, c), 201);
  // The payment gateway's ₹1,000 on the 2nd: a variable cost, on its day.
  ok(await call("POST", url(o.ws, o.store.id, "/expenses"), o.a.headers, { name: "Gateway fees", category: "payment_fees", amount: 1_000, cadence: "once", startsOn: GOOD_DAY, endsOn: null, note: null }), 201);
  return o;
}

describe("the profit and loss of a month", () => {
  it("takes each day's variable costs and its share of the month's fixed costs off its sales", async () => {
    const { a, ws, store } = await brief();
    // Not complete yet: what is left after the known costs, never called profit.
    let pl = ok(await call("GET", url(ws, store.id, `/profit?month=${MONTH}`), a.headers));
    expect(pl).toMatchObject({ currency: "INR", month: MONTH, setup: { productCosts: "known", ads: "none", completeFrom: null, costsCount: 5 } });
    const good = () => pl.days.find((d: { from: string }) => d.from === GOOD_DAY);
    expect(good()).toMatchObject({ revenue: 10_000, productCosts: 3_000, variableCosts: 4_000, fixedCosts: 1666.67, grossProfit: 7_000, operatingProfit: null, gaps: ["costs_not_complete"], afterKnownCosts: 4333.33 });

    ok(await call("PUT", url(ws, store.id, "/expenses/settings"), a.headers, { completeFrom: "2025-01-01" }));
    pl = ok(await call("GET", url(ws, store.id, `/profit?month=${MONTH}`), a.headers));
    // The brief: ₹10,000 − ₹4,000 − ₹50,000 ÷ 30 = ₹4,333.33.
    expect(good()).toMatchObject({ revenue: 10_000, variableCosts: 4_000, fixedCosts: 1666.67, operatingProfit: 4333.33, netProfit: 4333.33, gaps: [] });
    // ₹2,000 − ₹600 − ₹1,666.67: a loss.
    expect(pl.days.find((d: { from: string }) => d.from === BAD_DAY)).toMatchObject({ revenue: 2_000, variableCosts: 600, operatingProfit: -266.67 });
    // A day with no sales still carries its share of the fixed costs.
    expect(pl.days.find((d: { from: string }) => d.from === "2026-09-10")).toMatchObject({ revenue: 0, operatingProfit: -1666.67 });
    expect(pl.days).toHaveLength(30);
    // The month: every fixed cost once, ₹50,000.
    expect(pl.total).toMatchObject({ from: "2026-09-01", to: "2026-09-30", revenue: 12_000, productCosts: 3_600, variableCosts: 4_600, fixedCosts: 50_000, operatingProfit: -42_600, netProfit: -42_600 });
    expect(pl.allocation).toEqual({ from: "2026-09-01", to: "2026-09-30", fixedCosts: 50_000, days: 30, calendarDays: 30 });
    // Twelve months ending with September, each worked out the same way.
    expect(pl.trend.map((m: { month: string }) => m.month)).toEqual(["2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"]);
    expect(pl.trend.at(-1)).toMatchObject({ month: MONTH, operatingProfit: -42_600 });
    expect(pl.trend[4]).toMatchObject({ month: "2026-02", days: 28, fixedCosts: 50_000 });
  });

  it("spreads the fixed costs over the days the store is open once its owner says which", async () => {
    const { a, ws, store } = await brief();
    expect(ok(await call("PUT", url(ws, store.id, "/expenses/settings"), a.headers, { completeFrom: "2025-01-01", operatingWeekdays: [0, 1, 2, 3, 4] })).settings).toMatchObject({ completeFrom: "2025-01-01", operatingWeekdays: [0, 1, 2, 3, 4] });
    const pl = ok(await call("GET", url(ws, store.id, `/profit?month=${MONTH}`), a.headers));
    // September 2026 has 22 weekdays: ₹50,000 ÷ 22 a weekday, none on a Sunday.
    expect(pl.allocation).toMatchObject({ days: 22, calendarDays: 30, fixedCosts: 50_000 });
    expect(pl.days.find((d: { from: string }) => d.from === GOOD_DAY).fixedCosts).toBe(2272.73);
    expect(pl.days.find((d: { from: string }) => d.from === "2026-09-06").fixedCosts).toBe(0);
    expect(pl.total.fixedCosts).toBe(50_000);
    // Saving one setting leaves the other.
    expect(ok(await call("PUT", url(ws, store.id, "/expenses/settings"), a.headers, { completeFrom: null })).settings).toMatchObject({ completeFrom: null, operatingWeekdays: [0, 1, 2, 3, 4] });
    const audit = await systemDb.auditLog.findMany({ where: { workspaceId: ws, targetType: "store" }, orderBy: { createdAt: "asc" } });
    expect(audit.map((x) => x.action)).toEqual(["expenses.completeness_changed", "expenses.operating_days_changed", "expenses.completeness_changed"]);
  });

  it("is for those who see the sales breakdown, gives no profit that would give away costs a member isn't shown, and never another workspace's", async () => {
    const { a, ws, store } = await brief();
    ok(await call("PUT", url(ws, store.id, "/expenses/settings"), a.headers, { completeFrom: "2025-01-01" }));
    // The breakdown without the product costs: revenue and the owner's costs, no profit.
    const analyst = await member(ws, ["analytics.sales", "finance.breakdown"]);
    const pl = ok(await call("GET", url(ws, store.id, `/profit?month=${MONTH}`), analyst.headers));
    expect(pl.setup).toMatchObject({ productCosts: "hidden", ads: "hidden" });
    expect(pl.days.find((d: { from: string }) => d.from === GOOD_DAY)).toMatchObject({ revenue: 10_000, productCosts: null, grossProfit: null, operatingProfit: null, fixedCosts: 1666.67 });
    expect(pl.total.gaps).toEqual(expect.arrayContaining(["product_costs_hidden", "ads_hidden"]));
    // The sales alone: refused.
    const seller = await member(ws, ["analytics.sales"]);
    expect((await call("GET", url(ws, store.id, `/profit?month=${MONTH}`), seller.headers)).statusCode).toBe(403);
    // A month that hasn't started, or isn't one.
    expect((await call("GET", url(ws, store.id, "/profit?month=2999-01"), a.headers)).statusCode).toBe(400);
    expect((await call("GET", url(ws, store.id, "/profit?month=2026-13"), a.headers)).statusCode).toBe(400);
    // Another business's owner naming this store: nothing.
    const other = await owner("other");
    expect((await call("GET", url(other.ws, store.id, `/profit?month=${MONTH}`), other.a.headers)).statusCode).toBe(404);
    expect((await call("GET", url(ws, store.id, `/profit?month=${MONTH}`), other.a.headers)).statusCode).toBe(404);
  });

  it("takes no ad spend off that leaves an account out in another currency, and names it", async () => {
    const { a, ws, store } = await brief();
    ok(await call("PUT", url(ws, store.id, "/expenses/settings"), a.headers, { completeFrom: "2025-01-01" }));
    const account = (provider: string, accountId: string, accountName: string, currency: string) =>
      systemDb.adConnection.create({
        data: { workspaceId: ws, storeId: store.id, provider, accountId, accountName, currency, timezone: "UTC", accessTokenEnc: "x", tokenKeyVersion: 1, historyFrom: "2020-01-01", syncedThrough: "2026-10-31", lastSyncedAt: new Date() },
      });
    const spent = (c: { id: string; provider: string; accountId: string }, spend: number) =>
      systemDb.adCampaignDaily.create({ data: { workspaceId: ws, storeId: store.id, connectionId: c.id, provider: c.provider, accountId: c.accountId, campaignId: "1", campaignName: "Spring", day: GOOD_DAY, spend } });
    // Meta in the store's rupees, Google in euros: the spend is Meta's ₹500 alone, so not the whole spend.
    const meta = await account("meta", "act_in", "India shop", "INR");
    const google = await account("google", "1234567890", "EU shop", "EUR");
    await spent(meta, 500);
    await spent(google, 40);
    const get = async () => ok(await call("GET", url(ws, store.id, `/profit?month=${MONTH}`), a.headers));
    let pl = await get();
    // The spend is in rupees: no "in INR, not INR", and the euro account is named.
    expect(pl.setup).toMatchObject({ ads: "unusable", adsCurrency: null, adsDemo: false });
    expect(pl.setup.adsLeftOut).toEqual([{ id: google.id, provider: "google", accountId: "1234567890", name: "EU shop", currency: "EUR" }]);
    expect(pl.days.find((d: { from: string }) => d.from === GOOD_DAY)).toMatchObject({ revenue: 10_000, adSpend: null, operatingProfit: null, gaps: ["ad_spend"] });

    // Without the euro account the rupees are the whole spend: ₹10,000 − ₹3,000 − ₹500 − ₹1,000 − ₹1,666.67.
    await systemDb.adConnection.update({ where: { id: google.id }, data: { enabled: false } });
    pl = await get();
    expect(pl.setup).toMatchObject({ ads: "known", adsCurrency: null, adsLeftOut: [] });
    expect(pl.days.find((d: { from: string }) => d.from === GOOD_DAY)).toMatchObject({ adSpend: 500, variableCosts: 4_500, operatingProfit: 3833.33, gaps: [] });

    // The euro account alone: the spend itself is in another currency, which the page says.
    await systemDb.adConnection.update({ where: { id: google.id }, data: { enabled: true } });
    await systemDb.adConnection.update({ where: { id: meta.id }, data: { enabled: false } });
    pl = await get();
    expect(pl.setup).toMatchObject({ ads: "unusable", adsCurrency: "EUR", adsLeftOut: [] });
  });

  it("gives the sheet each day's product costs and the costs' terms to work out its own columns", async () => {
    const { a, ws, store } = await brief();
    const ov = ok(await call("GET", url(ws, store.id, `/overview?preset=custom&from=2026-09-01&to=2026-09-30&parts=sheet`), a.headers));
    expect(ov.modules.product_costs.byDay.find((d: { day: string }) => d.day === GOOD_DAY)).toEqual({ day: GOOD_DAY, costOfGoodsSold: 3_000, netSalesWithCost: 10_000, netSalesWithoutCost: 0 });
    expect(ov.modules.expenses.terms).toHaveLength(5);
    expect(ov.modules.expenses.terms[0]).not.toHaveProperty("name");
    expect(ov.modules.sales_overview.series.find((d: { day: string }) => d.day === GOOD_DAY)).toMatchObject({ grossSales: 10_000, discounts: 0, netSales: 10_000 });
    // The dashboard's own answer carries no terms.
    expect(ok(await call("GET", url(ws, store.id, `/overview?preset=custom&from=2026-09-01&to=2026-09-30`), a.headers)).modules.expenses).not.toHaveProperty("terms");
  });
});

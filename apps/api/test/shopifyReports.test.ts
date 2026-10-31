import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { systemDb, withTenant, type Store } from "@app/db";
import { queryAs } from "@app/db/testing";
import { encryptTokenFields, type FetchLike } from "@app/core";
import { reportWindows, shopifyCheckReport } from "@app/core/reports";
import { resolvePreset } from "@app/shared";
import { clean, createStore, createWorkspace, setup, signIn, teardown, type TestCtx } from "./helpers.js";

/**
 * Shopify's own report figures on the dashboard (sessions, gross profit, the check of our sales
 * against Shopify's sales report) and the reconciliation report.
 */

let ctx: TestCtx;
beforeAll(async () => (ctx = await setup()));
afterAll(async () => teardown(ctx));
beforeEach(async () => clean(ctx));

const SCOPES = ["read_orders", "read_products", "read_reports"];
const RANGE = "preset=custom&from=2026-09-21&to=2026-09-21";
const ourDay = { day: "2026-09-21", grossSales: 1699.08, discounts: 54.53, refunds: 45.5, shipping: 34.54, taxes: 167.91, totalSales: 1801.5, orders: 5, units: 6 };
const shopifySales = { grossSales: 1699.08, discounts: -54.53, salesReversals: -45.5, netSales: 1599.05, shipping: 34.54, duties: 0, additionalFees: 0, taxes: 167.91, totalSales: 1801.5, orders: 5 };

async function owner(scopes = SCOPES) {
  const a = await signIn(ctx, "ua", "a@x.com");
  const ws = await createWorkspace(ctx, a.headers, "A");
  const store = await createStore(ws, "a.myshopify.com", scopes);
  return { a, ws, store };
}

async function keep(store: Store, dataset: string, w: { from: string; to: string; until?: string }, values: Record<string, number> | null, error: string | null = null) {
  await systemDb.shopifyReport.create({
    data: { workspaceId: store.workspaceId, storeId: store.id, dataset, window: `${w.from}|${w.to}|${w.until ?? ""}`, values: values ?? undefined, error, fetchedAt: new Date() },
  });
}

const overview = (headers: Record<string, string>, ws: string, storeId: string, qs = RANGE) => ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${storeId}/overview?${qs}`, headers });
const reportJobs = () => ctx.deps.queues.sent.sync.filter((j) => (j as { kind?: string }).kind === "shopify_reports") as unknown as Array<{ storeId: string; requests: Array<{ dataset: string }> }>;

describe("Shopify's own figures on the dashboard", () => {
  it("shows the kept answers: sessions, gross profit, and our sales checked against Shopify's", async () => {
    const { a, ws, store } = await owner();
    await systemDb.dailyStoreMetrics.create({ data: { workspaceId: ws, storeId: store.id, ...ourDay, ordersWithCustomer: 5, returningCustomerOrders: 0, refundedOrders: 1 } });
    const w = reportWindows(...(Object.values(resolvePreset("custom", new Date(), "UTC", { from: "2026-09-21", to: "2026-09-21" })) as [never, never]));
    await keep(store, "sales", w.current, shopifySales);
    await keep(store, "sessions", w.current, { sessions: 200, visitors: 150, cartSessions: 20, checkoutSessions: 10, completedSessions: 5, pageviews: 600 });
    await keep(store, "sessions", w.previous, { sessions: 100, visitors: 90, cartSessions: 10, checkoutSessions: 5, completedSessions: 2, pageviews: 300 });
    await keep(store, "profit", w.current, { grossProfit: 900, costOfGoodsSold: -650, netSalesWithCost: 1500, netSalesWithoutCost: 99.05 });
    await keep(store, "profit", w.previous, { grossProfit: 450, costOfGoodsSold: -300, netSalesWithCost: 700, netSalesWithoutCost: 0 });

    const res = await overview(a.headers, ws, store.id);
    expect(res.statusCode).toBe(200);
    const m = res.json().modules;
    expect(m.shopify_sessions).toMatchObject({ status: "ready", until: null, current: { sessions: 200, visitors: 150, conversionRate: 0.025 }, deltas: { sessions: 1 } });
    expect(m.shopify_sessions.deltas.conversionRate).toBeCloseTo(0.25, 9);
    expect(m.profit).toMatchObject({ status: "ready", current: { grossProfit: 900, costOfGoodsSold: 650, profitOnCosted: 850, netSalesWithoutCost: 99.05 }, deltas: { grossProfit: 1 } });
    expect(m.profit.current.marginOnCosted).toBeCloseTo(850 / 1500, 6);
    expect(m.shopify_check).toMatchObject({ status: "ready", matches: true, window: { from: "2026-09-21", to: "2026-09-21" } });
    expect(m.shopify_check.rows.find((r: { metric: string }) => r.metric === "discounts")).toMatchObject({ shopify: 54.53, ours: 54.53, state: "match" });
    // Everything was fresh: nothing to fetch again.
    expect(reportJobs()).toEqual([]);
  });

  it("says it is asking Shopify, and queues the fetch once, when nothing is kept yet", async () => {
    const { a, ws, store } = await owner();
    const first = (await overview(a.headers, ws, store.id)).json().modules;
    expect(first.shopify_sessions).toMatchObject({ status: "loading", current: null });
    expect(first.profit).toMatchObject({ status: "loading", current: null });
    expect(first.shopify_check).toMatchObject({ status: "loading", rows: null, matches: null });
    expect(reportJobs()).toHaveLength(1);
    expect(reportJobs()[0]!.requests.map((r) => r.dataset).sort()).toEqual(["profit", "profit", "sales", "sessions", "sessions"]);
    // Another poll (another tab) within the minute doesn't queue it twice.
    await overview(a.headers, ws, store.id);
    expect(reportJobs()).toHaveLength(1);
  });

  it("shows why Shopify gave no figures, without making any up", async () => {
    const { a, ws, store } = await owner();
    const w = reportWindows(...(Object.values(resolvePreset("custom", new Date(), "UTC", { from: "2026-09-21", to: "2026-09-21" })) as [never, never]));
    await keep(store, "sessions", w.current, null, "access_denied");
    await keep(store, "profit", w.current, null, "unsupported");
    const m = (await overview(a.headers, ws, store.id)).json().modules;
    expect(m.shopify_sessions).toMatchObject({ status: "access_denied", current: null });
    expect(m.profit).toMatchObject({ status: "unsupported", current: null });
  });

  it("is locked without Shopify's reports granted, and asks Shopify nothing", async () => {
    const { a, ws, store } = await owner(["read_orders", "read_products"]);
    const body = (await overview(a.headers, ws, store.id)).json();
    expect(body.modules.shopify_sessions).toBeUndefined();
    expect(body.modules.profit).toBeUndefined();
    expect(body.modules.shopify_check).toBeUndefined();
    const caps = body.capabilities.filter((c: { id: string }) => c.id === "shopify_sessions" || c.id === "profit");
    expect(caps).toHaveLength(2);
    for (const c of caps) expect(c).toMatchObject({ enabled: false, missingScopes: ["read_reports"] });
    expect(reportJobs()).toEqual([]);
  });

  it("gives a restricted member only what their permissions show", async () => {
    const { ws, store } = await owner();
    const v = await signIn(ctx, "uv", "v@x.com");
    await systemDb.membership.create({ data: { workspaceId: ws, userId: v.user.id, role: "custom", permissions: ["analytics.sales"] } });
    const m = (await overview(v.headers, ws, store.id)).json().modules;
    // Sales, but neither the breakdown (finance.breakdown) nor conversion (analytics.conversion).
    expect(m.sales_overview).toBeDefined();
    expect(m.shopify_sessions).toBeUndefined();
    expect(m.profit).toBeUndefined();
    expect(m.shopify_check).toBeUndefined();
    // Nothing they can't see is fetched for them either.
    expect(reportJobs()).toEqual([]);
  });

  it("gives Shopify's gross profit only to a member shown costs too, and asks Shopify for it only then", async () => {
    const { ws, store } = await owner();
    const v = await signIn(ctx, "uv", "v@x.com");
    // The breakdown alone, as legacy viewers and analysts and API keys hold it.
    const membership = await systemDb.membership.create({ data: { workspaceId: ws, userId: v.user.id, role: "custom", permissions: ["analytics.sales", "finance.breakdown"] } });
    const body = (await overview(v.headers, ws, store.id)).json();
    expect(body.modules.profit).toBeUndefined();
    expect(body.capabilities.some((c: { id: string }) => c.id === "profit")).toBe(false);
    // The check of the sales figures is the breakdown's.
    expect(body.modules.shopify_check).toMatchObject({ status: "loading" });
    expect(reportJobs().flatMap((j) => j.requests.map((r) => r.dataset))).toEqual(["sales"]);

    await systemDb.membership.update({ where: { id: membership.id }, data: { permissions: ["analytics.sales", "finance.breakdown", "inventory.view", "inventory.costs"] } });
    expect((await overview(v.headers, ws, store.id)).json().modules.profit).toMatchObject({ status: "loading" });
  });
});

describe("the reconciliation report (GET .../shopify-check)", () => {
  it("lists every standard period, and says what can't be verified without Shopify's reports", async () => {
    const { a, ws, store } = await owner(["read_orders", "read_products"]);
    const res = await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${store.id}/shopify-check`, headers: a.headers });
    expect(res.statusCode).toBe(200);
    const r = res.json();
    expect(r.periods.map((p: { preset: string }) => p.preset)).toEqual(["today", "yesterday", "7d", "30d", "90d", "mtd", "lastmonth"]);
    for (const p of r.periods) for (const row of p.rows) expect(row.status).toBe("not_verifiable");
    expect(r.periods[0].rows[0].note).toMatch(/hasn't granted/);
  });

  it("checks each figure against Shopify's live answer, and downloads as CSV", async () => {
    const { a, ws, store } = await owner();
    await systemDb.store.update({ where: { id: store.id }, data: { ...encryptTokenFields(store.id, { accessToken: "shpat_x", scopes: SCOPES, accessTokenExpiresAt: null, refreshToken: null, refreshTokenExpiresAt: null }), ordersHistoryFrom: new Date("2026-01-01T00:00:00Z") } });
    // Yesterday (a finished day, so its stored day row is ours) matches Shopify's; Shopify has
    // nothing for any other window.
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    await systemDb.dailyStoreMetrics.create({ data: { workspaceId: ws, storeId: store.id, ...ourDay, day: yesterday, ordersWithCustomer: 5, returningCustomerOrders: 0, refundedOrders: 1 } });
    await systemDb.order.create({ data: { workspaceId: ws, storeId: store.id, shopifyId: "1", name: "#1", currency: "AUD", localDay: "2026-01-02", shopifyCreatedAt: new Date("2026-01-02T00:00:00Z"), shopifyUpdatedAt: new Date("2026-01-02T00:00:00Z"), subtotal: 0, totalDiscounts: 0, totalTax: 0, totalShipping: 0, totalPrice: 0, discountCodes: [] } });
    ctx.setFetch(async (_url, init) => {
      const q = (JSON.parse(String(init?.body)) as { variables: { query: string } }).variables.query;
      const sales = q.endsWith(`SINCE ${yesterday} UNTIL ${yesterday}`)
        ? { gross_sales: 1699.08, discounts: -54.53, sales_reversals: -45.5, net_sales: 1599.05, shipping_charges: 34.54, duties: 0, additional_fees: 0, taxes: 167.91, total_sales: 1801.5, orders: 5 }
        : { gross_sales: 0, discounts: 0, sales_reversals: 0, net_sales: 0, shipping_charges: 0, duties: 0, additional_fees: 0, taxes: 0, total_sales: 0, orders: 0 };
      const row = q.startsWith("FROM sessions")
        ? { sessions: 10, online_store_visitors: 8, sessions_with_cart_additions: 2, sessions_that_reached_checkout: 1, sessions_that_completed_checkout: 1, pageviews: 30 }
        : q.includes("gross_profit")
          ? { gross_profit: 100, cost_of_goods_sold: -50, net_sales_with_cost_recorded: 150, net_sales_without_cost_recorded: 0 }
          : sales;
      return new Response(JSON.stringify({ data: { shopifyqlQuery: { tableData: { columns: Object.keys(row).map((name) => ({ name })), rows: [row] }, parseErrors: [] } } }), { status: 200 });
    });
    const res = await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${store.id}/shopify-check`, headers: a.headers });
    expect(res.statusCode).toBe(200);
    const periods = res.json().periods as Array<{ preset: string; rows: Array<{ metric: string; status: string; shopify: number | null; difference: number | null }> }>;
    const row = (preset: string, metric: string) => periods.find((p) => p.preset === preset)!.rows.find((r) => r.metric === metric)!;
    for (const metric of ["Gross sales", "Discounts", "Returns (sales reversals)", "Net sales", "Shipping charges", "Duties", "Additional fees", "Taxes", "Total sales", "Orders", "Average order value"]) expect(row("yesterday", metric).status, metric).toBe("match");
    // The 7 days hold yesterday's sales here, nothing in this fake Shopify: a difference, shown as one.
    expect(row("7d", "Net sales")).toMatchObject({ status: "difference", difference: 1599.05 });
    expect(row("yesterday", "Sessions").status).toBe("definition_mismatch");
    expect(row("yesterday", "Gross profit")).toMatchObject({ shopify: 100, status: "not_verifiable" });

    const csv = await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${store.id}/shopify-check?format=csv`, headers: a.headers });
    // The rate limit allows a few per store; this is the second.
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toMatch(/text\/csv/);
    expect(csv.body).toContain("Net sales");
  });

  /** The store with an access token, so Shopify is asked. */
  const withToken = (store: Store) =>
    systemDb.store.update({ where: { id: store.id }, data: encryptTokenFields(store.id, { accessToken: "shpat_x", scopes: SCOPES, accessTokenExpiresAt: null, refreshToken: null, refreshTokenExpiresAt: null }) });
  const nothing = () => new Response(JSON.stringify({ data: { shopifyqlQuery: { tableData: { columns: [], rows: [] }, parseErrors: [] } } }), { status: 200 });

  it("asks Shopify outside any database transaction: its calls take seconds, a transaction expires after 20", async () => {
    const { a, ws, store } = await owner();
    await withToken(store);
    // Transactions open on the test database, as its owner sees them (every role's sessions).
    const open = async () =>
      (await queryAs<{ n: number }>(process.env.OWNER_DATABASE_URL!, "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND state LIKE 'idle in transaction%'"))[0]!.n;
    expect(await withTenant(ws, () => open())).toBe(1);
    const during: number[] = [];
    ctx.setFetch(async () => {
      during.push(await open());
      return nothing();
    });
    const res = await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${store.id}/shopify-check`, headers: a.headers });
    expect(res.statusCode).toBe(200);
    expect(during).toHaveLength(21);
    expect(Math.max(...during)).toBe(0);
  });

  it("stops asking Shopify at its deadline, and shows what it didn't ask as not verifiable, never as 0", async () => {
    const { ws, store } = await owner();
    const s = await withToken(store);
    let calls = 0;
    // Shopify doesn't answer: the call waits until it is cut off.
    const silent: FetchLike = (_url, init) => {
      calls++;
      return new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
    };
    const started = Date.now();
    const report = await shopifyCheckReport((read) => withTenant(ws, read), s, { coord: ctx.deps.coord, fetchImpl: silent }, { periods: ["yesterday", "7d"], deadline: Date.now() + 300 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(calls).toBe(1);
    const row = (preset: string, metric: string) => report.periods.find((p) => p.preset === preset)!.rows.find((r) => r.metric === metric)!;
    expect(row("yesterday", "Net sales")).toMatchObject({ shopify: null, status: "not_verifiable", note: "Shopify's reports didn't answer." });
    for (const [preset, metric] of [["yesterday", "Sessions"], ["yesterday", "Gross profit"], ["7d", "Net sales"], ["7d", "Visitors"]] as const) {
      expect(row(preset, metric), `${preset} ${metric}`).toMatchObject({ shopify: null, status: "not_verifiable", note: expect.stringMatching(/^Not asked/) });
    }
  });

  it("another workspace naming the store can't use up the store's own allowance", async () => {
    const { a, ws, store } = await owner(["read_orders", "read_products"]);
    const b = await signIn(ctx, "ub", "b@x.com");
    const other = await createWorkspace(ctx, b.headers, "B");
    for (let i = 0; i < 3; i++) {
      const res = await ctx.app.inject({ method: "GET", url: `/workspaces/${other}/stores/${store.id}/shopify-check`, headers: b.headers });
      expect(res.statusCode).toBe(404);
    }
    expect((await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${store.id}/shopify-check`, headers: a.headers })).statusCode).toBe(200);
  });

  it("needs financial reports access (it shows every sales figure and Shopify's profit)", async () => {
    const { ws, store } = await owner();
    const v = await signIn(ctx, "uv", "v@x.com");
    const m = await systemDb.membership.create({ data: { workspaceId: ws, userId: v.user.id, role: "custom", permissions: ["analytics.sales", "finance.breakdown"] } });
    const check = () => ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${store.id}/shopify-check`, headers: v.headers });
    expect((await check()).statusCode).toBe(403);
    // Financial reports alone isn't enough either: every line of the breakdown and the profit are in it.
    await systemDb.membership.update({ where: { id: m.id }, data: { permissions: ["analytics.sales", "finance.reports"] } });
    expect((await check()).statusCode).toBe(403);
    await systemDb.membership.update({ where: { id: m.id }, data: { permissions: ["analytics.sales", "finance.breakdown", "finance.reports"] } });
    const metrics = async () => {
      const res = await check();
      expect(res.statusCode).toBe(200);
      return new Set((res.json().periods as Array<{ rows: Array<{ metric: string }> }>).flatMap((p) => p.rows.map((r) => r.metric)));
    };
    // Shopify's gross profit and cost of goods sold are costs: not without "View costs and stock value".
    const without = await metrics();
    expect(without.has("Net sales")).toBe(true);
    expect(without.has("Gross profit")).toBe(false);
    expect(without.has("Cost of goods sold")).toBe(false);
    await systemDb.membership.update({ where: { id: m.id }, data: { permissions: ["analytics.sales", "finance.breakdown", "finance.reports", "inventory.view", "inventory.costs"] } });
    const withCosts = await metrics();
    expect(withCosts.has("Gross profit")).toBe(true);
    expect(withCosts.has("Cost of goods sold")).toBe(true);
  });
});

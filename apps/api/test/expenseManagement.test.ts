import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { crossTenant, systemDb, type Store } from "@app/db";
import { addDays, localDay } from "@app/shared";
import { recordDuePaymentsEverywhere } from "@app/core";
import { clean, createStore, createWorkspace, setup, signIn, teardown, type TestCtx } from "./helpers.js";

/**
 * Profit & Loss's costs, end to end: costs that follow the sales (a percentage, an amount per order),
 * the store's own categories, a refund, the statement laid out as the owner's workbook, recurring
 * payments recorded once and kept as paid when the cost changes from its next payment, a payment
 * changed one by one, pause, resume and end, the history, removing several at once, and who may
 * change them ("Manage costs").
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

const url = (ws: string, storeId: string, rest = "") => `/workspaces/${ws}/stores/${storeId}${rest}`;
const SEPTEMBER = "preset=custom&from=2026-09-01&to=2026-09-30";

let users = 0;
async function member(ws: string, permissions: string[]) {
  const n = ++users;
  const m = await signIn(ctx, `costs-member-${n}`, `costs${n}@example.com`);
  await systemDb.membership.create({ data: { workspaceId: ws, userId: m.user.id, role: "custom", permissions } });
  return m;
}

async function owner() {
  const a = await signIn(ctx, "costs-owner", "owner@costs.test");
  const ws = await createWorkspace(ctx, a.headers, "Costs");
  const store = await createStore(ws, "costs.myshopify.com", ["read_orders", "read_products"], { timezone: "UTC", currency: "AUD", name: "Costs Shop", ordersHistoryFrom: new Date(0) });
  await systemDb.productVariant.create({ data: { workspaceId: ws, storeId: store.id, productShopifyId: "tee", shopifyId: "tee-v", title: "Tee", price: 100, unitCost: 30, shopifyUpdatedAt: new Date() } });
  return { a, ws, store };
}

/** A day's sales: one order of `qty` tees at $100 (GST 10% on top), each costing $30. */
async function sell(store: Store, day: string, qty: number) {
  const at = new Date(`${day}T12:00:00Z`);
  const id = `o-${day}`;
  await systemDb.order.create({
    data: {
      workspaceId: store.workspaceId,
      storeId: store.id,
      shopifyId: id,
      name: `#${id}`,
      currency: "AUD",
      localDay: day,
      shopifyCreatedAt: at,
      shopifyUpdatedAt: at,
      subtotal: qty * 100,
      totalDiscounts: 0,
      totalTax: qty * 10,
      totalShipping: 0,
      totalPrice: qty * 110,
      salesUpdatedAt: at,
      lineItems: { create: [{ workspaceId: store.workspaceId, storeId: store.id, shopifyId: `${id}-0`, productShopifyId: "tee", variantShopifyId: "tee-v", title: "Tee", quantity: qty, price: 100, discount: 0 }] },
      sales: { create: [{ workspaceId: store.workspaceId, storeId: store.id, shopifyId: `${id}-sale`, lineType: "product", actionType: "order", lineItemShopifyId: `${id}-0`, quantity: qty, amount: qty * 100, discount: 0, tax: qty * 10, localDay: day, happenedAt: at }] },
    },
  });
  await systemDb.dailyStoreMetrics.create({ data: { workspaceId: store.workspaceId, storeId: store.id, day, grossSales: qty * 100, taxes: qty * 10, totalSales: qty * 110, orders: 1, units: qty, orderValue: qty * 100 } });
}

const cost = (over: Record<string, unknown>) => ({ name: "Cost", category: "other", amount: 100, cadence: "monthly", startsOn: "2026-01-01", endsOn: null, note: null, ...over });

describe("costs that follow the sales, the store's own categories, and the statement", () => {
  it("lays the month out as the owner's workbook: sales with and without tax, each kind of cost, profit and the ratios", async () => {
    const { a, ws, store } = await owner();
    await sell(store, "2026-09-02", 10);
    await sell(store, "2026-09-03", 2);
    const add = async (body: Record<string, unknown>) => ok(await call("POST", url(ws, store.id, "/expenses"), a.headers, body), 201).expense;
    const shipping = await add(cost({ name: "Shipping labels", category: "shipping", method: "per_order", amount: 20, cadence: "daily", startsOn: "2026-01-01", vendor: "Australia Post" }));
    expect(shipping).toMatchObject({ method: "per_order", cadence: "daily", currency: "AUD", vendor: "Australia Post", nextDue: null });
    await add(cost({ name: "Merchant fees", category: "merchant_fees", method: "percent", percentBase: "total_sales", amount: 2, cadence: "daily" }));
    const warehouse = ok(await call("POST", url(ws, store.id, "/expense-categories"), a.headers, { name: "Warehouse", section: "fixed" }), 201).category;
    expect(ok(await call("POST", url(ws, store.id, "/expense-categories"), a.headers, { name: "warehouse", section: "variable" }), 409)).toMatchObject({ error: "category_exists" });
    await add(cost({ name: "Warehouse rent", category: `custom:${warehouse.id}`, amount: 3_000 }));
    // A courier's refund: a credit, below 0, on its day.
    await add(cost({ name: "Courier refund", category: "shipping", amount: -15.5, cadence: "once", startsOn: "2026-09-03" }));

    const st = ok(await call("GET", url(ws, store.id, `/profit/statement?${SEPTEMBER}&grain=week`), a.headers));
    expect(st).toMatchObject({ currency: "AUD", range: { from: "2026-09-01", to: "2026-09-30" }, grain: "week", setup: { productCosts: "known", ads: "none" } });
    expect(st.categories).toEqual([{ id: warehouse.id, name: "Warehouse", section: "fixed" }]);
    // $1,200 before tax, $1,320 with it: $120 of GST, never income.
    expect(st.total).toMatchObject({ revenue: 1_200, totalSales: 1_320, taxes: 120, orders: 2, units: 12, productCosts: 360, advertising: 0, fixedCosts: 3_000 });
    // Product costs $360 + shipping 2 × $20 − $15.50 + 2% of $1,320.
    expect(st.total.variableExAds).toBe(410.9);
    expect(st.total.totalExpenses).toBe(3_410.9);
    expect(st.total.vcr).toBeCloseTo(410.9 / 1_200, 6);
    expect(st.total.fcr).toBe(2.5);
    // No ad spend: none of the sales went on ads, and there is no return on ad spend to give.
    expect(st.total.mer).toBe(0);
    expect(st.total.roas).toBeNull();
    expect(st.columns.map((c: { key: string; from: string; to: string }) => [c.from, c.to])[0]).toEqual(["2026-09-01", "2026-09-06"]);
    expect(st.daily).toHaveLength(30);
    // The costs a line each: the rules over the dates, the credit on its day, the warehouse's September payment.
    const line = (name: string) => st.lines.find((l: { name: string }) => l.name === name);
    expect(line("Shipping labels")).toMatchObject({ kind: "rule", amount: 40, section: "variable", vendor: "Australia Post" });
    expect(line("Merchant fees")).toMatchObject({ kind: "rule", amount: 26.4 });
    expect(line("Courier refund")).toMatchObject({ kind: "one_time", date: "2026-09-03", amount: -15.5 });
    expect(line("Warehouse rent")).toMatchObject({ kind: "payment", date: "2026-09-01", to: "2026-09-30", amount: 3_000, status: "posted", section: "fixed" });

    // A category in use can't go; renamed or moved, its costs go with it.
    expect(ok(await call("DELETE", url(ws, store.id, `/expense-categories/${warehouse.id}`), a.headers), 409)).toMatchObject({ error: "category_in_use" });
    ok(await call("PUT", url(ws, store.id, `/expense-categories/${warehouse.id}`), a.headers, { name: "Warehouse and 3PL", section: "variable" }));
    const moved = ok(await call("GET", url(ws, store.id, `/profit/statement?${SEPTEMBER}`), a.headers));
    expect(moved.total.fixedCosts).toBe(0);
    expect(moved.total.variableExAds).toBe(3_410.9);
  });

  it("refuses a cost in another currency, or in a category the store doesn't have", async () => {
    const { a, ws, store } = await owner();
    expect(ok(await call("POST", url(ws, store.id, "/expenses"), a.headers, cost({ currency: "USD" })), 400)).toMatchObject({ error: "currency_mismatch" });
    expect(ok(await call("POST", url(ws, store.id, "/expenses"), a.headers, cost({ category: "custom:ckmadeup00000" })), 400)).toMatchObject({ error: "unknown_category" });
    expect(ok(await call("POST", url(ws, store.id, "/expenses"), a.headers, cost({ amount: -5 })), 400)).toMatchObject({ error: "validation" });
    expect(await systemDb.storeExpense.count({ where: { storeId: store.id } })).toBe(0);
  });
});

describe("recurring costs", () => {
  const today = () => localDay(new Date(), "UTC");
  /** The first of the month `n` months before this one. */
  const monthsAgo = (n: number) => {
    const d = new Date();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() - n);
    return d.toISOString().slice(0, 10);
  };

  it("records each payment once, keeps those paid when the cost changes from its next payment, and lets one be changed", async () => {
    const { a, ws, store } = await owner();
    const start = monthsAgo(3);
    const rent = ok(await call("POST", url(ws, store.id, "/expenses"), a.headers, cost({ name: "Rent", category: "rent", amount: 2_300, startsOn: start })), 201).expense;
    // The first of this month and the three before it: recorded as soon as the cost is saved.
    expect(await systemDb.expenseEntry.count({ where: { expenseId: rent.id } })).toBe(4);
    expect(rent.nextDue).toBe(monthsAgo(-1));
    // The sweep records none twice, however often it runs.
    const swept = await crossTenant("sweep", () => recordDuePaymentsEverywhere());
    expect(swept.recorded).toBe(0);
    expect(await systemDb.expenseEntry.count({ where: { expenseId: rent.id } })).toBe(4);

    // $2,500 from the next payment: the payments made stay at $2,300.
    const changed = ok(await call("PUT", url(ws, store.id, `/expenses/${rent.id}?apply=next`), a.headers, cost({ name: "Rent", category: "rent", amount: 2_500, startsOn: start })));
    expect(changed).toMatchObject({ replaced: true, expense: { amount: 2_500, startsOn: rent.nextDue, replacesId: rent.id } });
    expect((await systemDb.storeExpense.findUniqueOrThrow({ where: { id: rent.id } })).endsOn).toBe(addDays(rent.nextDue, -1));
    const paid = await systemDb.expenseEntry.findMany({ where: { expenseId: rent.id }, orderBy: { dueOn: "asc" } });
    expect(paid.map((p) => Number(p.amount))).toEqual([2_300, 2_300, 2_300, 2_300]);

    // Three months ago's payment was $2,450: that month's fixed costs say so; the others don't change.
    const first = paid[0]!.dueOn;
    const payment = ok(await call("PUT", url(ws, store.id, `/expenses/${rent.id}/payments/${first}`), a.headers, { amount: 2_450, note: "Water bill added" })).payment;
    expect(payment).toMatchObject({ due: first, amount: 2_450, scheduledAmount: 2_300, status: "posted", edited: true });
    const month = `preset=custom&from=${first}&to=${addDays(monthsAgo(2), -1)}`;
    expect(ok(await call("GET", url(ws, store.id, `/profit/statement?${month}`), a.headers)).total.fixedCosts).toBe(2_450);
    expect(ok(await call("PUT", url(ws, store.id, `/expenses/${rent.id}/payments/${addDays(first, 1)}`), a.headers, { amount: 1 }), 404)).toMatchObject({ error: "no_such_payment" });

    const list = ok(await call("GET", url(ws, store.id, `/expenses/${rent.id}/payments`), a.headers));
    expect(list.payments.map((p: { due: string; status: string }) => p.status)).toEqual(["posted", "posted", "posted", "posted"]);
    const history = ok(await call("GET", url(ws, store.id, `/expenses/${changed.expense.id}/history`), a.headers)).history;
    // This cost's changes and those of the cost it took over from, newest first.
    expect(history[0]).toMatchObject({ action: "expense.payment_changed", actor: "owner@costs.test", detail: { due: first, after: { amount: 2_450 } } });
    expect(history.map((h: { action: string }) => h.action).sort()).toEqual(["expense.added", "expense.added", "expense.ended", "expense.payment_changed"]);
  });

  it("pauses, resumes and ends a recurring cost", async () => {
    const { a, ws, store } = await owner();
    const app = ok(await call("POST", url(ws, store.id, "/expenses"), a.headers, cost({ name: "Klaviyo", category: "software", amount: 45, startsOn: monthsAgo(1) })), 201).expense;
    const paused = ok(await call("POST", url(ws, store.id, `/expenses/${app.id}/pause`), a.headers, {})).expense;
    expect(paused).toMatchObject({ pausedFrom: app.nextDue, nextDue: null });
    expect(ok(await call("POST", url(ws, store.id, `/expenses/${app.id}/pause`), a.headers, {}), 409)).toMatchObject({ error: "already_paused" });
    const resumed = ok(await call("POST", url(ws, store.id, `/expenses/${app.id}/resume`), a.headers, {})).expense;
    expect(resumed).toMatchObject({ pausedFrom: null, nextDue: app.nextDue });
    const ended = ok(await call("POST", url(ws, store.id, `/expenses/${app.id}/end`), a.headers, {})).expense;
    expect(ended).toMatchObject({ endsOn: addDays(app.nextDue, -1), nextDue: null });
    // Paid once: nothing to pause.
    const once = ok(await call("POST", url(ws, store.id, "/expenses"), a.headers, cost({ cadence: "once", startsOn: today() })), 201).expense;
    expect(ok(await call("POST", url(ws, store.id, `/expenses/${once.id}/pause`), a.headers, {}), 409)).toMatchObject({ error: "not_recurring" });
    const audit = await systemDb.auditLog.findMany({ where: { workspaceId: ws, targetId: app.id }, orderBy: { createdAt: "asc" } });
    expect(audit.map((x) => x.action)).toEqual(["expense.added", "expense.paused", "expense.resumed", "expense.ended"]);
  });
});

describe("who may change costs", () => {
  it("needs Manage costs to add, change or remove; seeing them is the sales breakdown's", async () => {
    const { a, ws, store } = await owner();
    const reader = await member(ws, ["analytics.sales", "finance.breakdown"]);
    const keeper = await member(ws, ["analytics.sales", "finance.breakdown", "finance.costs"]);
    expect(ok(await call("POST", url(ws, store.id, "/expenses"), reader.headers, cost({})), 403)).toMatchObject({ error: "forbidden" });
    expect(ok(await call("POST", url(ws, store.id, "/expense-categories"), reader.headers, { name: "Rent", section: "fixed" }), 403)).toMatchObject({ error: "forbidden" });
    const one = ok(await call("POST", url(ws, store.id, "/expenses"), keeper.headers, cost({ name: "One" })), 201).expense;
    const two = ok(await call("POST", url(ws, store.id, "/expenses"), a.headers, cost({ name: "Two" })), 201).expense;
    expect(ok(await call("GET", url(ws, store.id, "/expenses"), reader.headers)).expenses).toHaveLength(2);
    expect(ok(await call("POST", url(ws, store.id, "/expenses/bulk-delete"), reader.headers, { ids: [one.id] }), 403)).toMatchObject({ error: "forbidden" });
    // Several at once; an id the store doesn't have is left out.
    expect(ok(await call("POST", url(ws, store.id, "/expenses/bulk-delete"), keeper.headers, { ids: [one.id, two.id, "ckmadeup"] })).removed.sort()).toEqual([one.id, two.id].sort());
    expect(await systemDb.storeExpense.count({ where: { storeId: store.id } })).toBe(0);
    const removed = await systemDb.auditLog.findMany({ where: { workspaceId: ws, action: "expense.removed" } });
    expect(removed).toHaveLength(2);
  });
});

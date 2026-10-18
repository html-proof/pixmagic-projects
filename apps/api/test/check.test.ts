import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { systemDb } from "@app/db";
import { addDays, localDay } from "@app/shared";
import { clean, createStore, createWorkspace, setup, signIn, teardown, type TestCtx } from "./helpers.js";

/**
 * The dashboard's side of the check against Shopify (GET/POST .../check, `check` in the overview)
 * and returning customers counted as Shopify counts them (each customer once).
 */
let ctx: TestCtx;
beforeAll(async () => (ctx = await setup()));
afterAll(async () => teardown(ctx));
beforeEach(async () => clean(ctx));

const SCOPES = ["read_orders", "read_products", "read_customers"];
const yesterday = () => addDays(localDay(new Date(), "UTC"), -1);

async function owner() {
  const a = await signIn(ctx, "u-owner", "owner@example.com");
  const ws = await createWorkspace(ctx, a.headers);
  const store = await createStore(ws, "c.myshopify.com", SCOPES, { currency: "AUD", lastSyncedAt: new Date() });
  return { a, ws, store };
}

async function order(store: { id: string; workspaceId: string }, id: string, customer: string | null, returning: boolean, day = yesterday()) {
  await systemDb.order.create({
    data: {
      workspaceId: store.workspaceId,
      storeId: store.id,
      shopifyId: id,
      name: `#${id}`,
      currency: "AUD",
      localDay: day,
      shopifyCreatedAt: new Date(`${day}T10:00:00Z`),
      shopifyUpdatedAt: new Date(`${day}T10:00:00Z`),
      subtotal: 10,
      totalDiscounts: 0,
      totalTax: 0,
      totalShipping: 0,
      totalPrice: 10,
      customerKey: customer,
      isReturningCustomer: returning,
    },
  });
}

describe("returning customers, each counted once", () => {
  it("the rate is returning customers ÷ customers, not orders", async () => {
    const { a, ws, store } = await owner();
    // Customer A: three orders, all after an earlier one (returning). B: a first purchase. C: first
    // and second purchase in the same dates (new and returning). An order without a customer.
    await order(store, "1", "A", true);
    await order(store, "2", "A", true);
    await order(store, "3", "A", true);
    await order(store, "4", "B", false);
    await order(store, "5", "C", false);
    await order(store, "6", "C", true);
    await order(store, "7", null, false);
    const res = await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${store.id}/overview?preset=7d`, headers: a.headers });
    expect(res.statusCode).toBe(200);
    const cu = res.json().modules.customers;
    expect(cu.current).toEqual({ customers: 3, returningCustomers: 2, newCustomers: 2, returningCustomerRate: 2 / 3 });
    // By orders it would have been 4 of 6.
  });
});

describe("checked against Shopify", () => {
  it("POST starts a check of the last 7 finished days; one at a time; the overview says it is running", async () => {
    const { a, ws, store } = await owner();
    const res = await ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/stores/${store.id}/check`, headers: a.headers });
    expect(res.statusCode).toBe(202);
    expect(res.json().started).toBe(true);
    const rec = await systemDb.reconciliation.findFirstOrThrow({ where: { storeId: store.id } });
    expect(rec).toMatchObject({ trigger: "manual", status: "running", fromDay: addDays(yesterday(), -6), toDay: yesterday(), source: "shopify_records" });
    expect(ctx.deps.queues.sent.sync).toContainEqual({ kind: "verify", storeId: store.id, reconciliationId: rec.id });

    const again = await ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/stores/${store.id}/check`, headers: a.headers });
    expect(again.json()).toEqual({ id: rec.id, started: false });

    const ov = await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${store.id}/overview?preset=7d`, headers: a.headers });
    expect(ov.json().check).toEqual({ running: rec.startedAt.toISOString(), last: null });
  });

  it("GET gives the last check's figures; the overview only its outcome", async () => {
    const { a, ws, store } = await owner();
    const rec = await systemDb.reconciliation.create({
      data: {
        workspaceId: ws,
        storeId: store.id,
        source: "shopify_records",
        trigger: "scheduled",
        fromDay: "2026-10-11",
        toDay: "2026-10-17",
        timezone: "UTC",
        currency: "AUD",
        status: "repaired",
        ordersChecked: 9,
        findings: { missing: { count: 1, orders: [{ id: "9", name: "#9" }] } },
        actions: { repaired: 1, removed: 0 },
        startedAt: new Date("2026-10-18T03:30:00Z"),
        finishedAt: new Date("2026-10-18T03:31:00Z"),
        results: {
          create: [
            { workspaceId: ws, metric: "orders", shopifyValue: 9, beforeValue: 8, afterValue: 9, status: "repaired", cause: "missing" },
            { workspaceId: ws, metric: "netSales", shopifyValue: 812.5, beforeValue: 712.5, afterValue: 812.5, status: "repaired", cause: "missing" },
            { workspaceId: ws, metric: "taxes", shopifyValue: 81.25, beforeValue: 81.25, afterValue: 81.25, status: "match" },
          ],
        },
      },
    });
    const res = await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${store.id}/check`, headers: a.headers });
    expect(res.statusCode).toBe(200);
    const last = res.json().last;
    expect(last).toMatchObject({ id: rec.id, status: "repaired", from: "2026-10-11", to: "2026-10-17", currency: "AUD", findings: { missing: 1 }, repaired: 1 });
    // In the order the dashboard lists them; the order ids stay in the database.
    expect(last.results.map((r: { metric: string }) => r.metric)).toEqual(["orders", "netSales", "taxes"]);
    expect(last.results[1]).toEqual({ metric: "netSales", shopify: 812.5, before: 712.5, bizinsights: 812.5, setAside: 0, status: "repaired", cause: "missing" });
    expect(last.setAside).toBeNull();
    expect(JSON.stringify(res.json())).not.toContain("#9");

    const ov = await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${store.id}/overview?preset=7d`, headers: a.headers });
    expect(ov.json().check).toEqual({
      running: null,
      last: { status: "repaired", from: "2026-10-11", to: "2026-10-17", checkedAt: "2026-10-18T03:31:00.000Z", ordersChecked: 9, matched: 3, compared: 3, repaired: 1, setAside: 0 },
    });
  });

  it("says what a check set aside: orders Shopify no longer shares, and their share of each figure", async () => {
    const { a, ws, store } = await owner();
    const totals = { orders: 0, grossSales: 33.64, discounts: 0, returns: 0, netSales: 33.64, shipping: 0, taxes: 3.36, totalSales: 37, units: 1 };
    await systemDb.reconciliation.create({
      data: {
        workspaceId: ws,
        storeId: store.id,
        source: "shopify_records",
        trigger: "manual",
        fromDay: "2026-08-21",
        toDay: "2026-10-18",
        timezone: "UTC",
        currency: "AUD",
        status: "verified",
        ordersChecked: 200,
        findings: { not_listed: { count: 1, orders: [{ id: "2718", name: "#2718S" }] } },
        actions: { repaired: 0, removed: 0, recomputed: 59, setAside: { orders: 1, totals } },
        startedAt: new Date("2026-10-19T03:30:00Z"),
        finishedAt: new Date("2026-10-19T03:35:00Z"),
        results: {
          create: [
            { workspaceId: ws, metric: "orders", shopifyValue: 200, beforeValue: 200, afterValue: 200, status: "match" },
            { workspaceId: ws, metric: "totalSales", shopifyValue: 9000, beforeValue: 9037, afterValue: 9037, status: "match" },
          ],
        },
      },
    });
    const last = (await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${store.id}/check`, headers: a.headers })).json().last;
    expect(last.setAside).toEqual({ orders: 1, totals });
    expect(last.findings).toEqual({ not_listed: 1 });
    expect(last.results.map((r: { metric: string; setAside: number }) => [r.metric, r.setAside])).toEqual([
      ["orders", 0],
      ["totalSales", 37],
    ]);
    expect(JSON.stringify(last)).not.toContain("#2718S");

    // Everyone sees how many orders were set aside, never how much.
    const ov = await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${store.id}/overview?preset=7d`, headers: a.headers });
    expect(ov.json().check.last).toMatchObject({ status: "verified", matched: 2, compared: 2, setAside: 1 });
  });

  it("another workspace's store is not found; a store still importing can't be checked; too many checks are refused", async () => {
    const { a, ws, store } = await owner();
    const b = await signIn(ctx, "u-other", "other@example.com");
    const otherWs = await createWorkspace(ctx, b.headers, "Other");
    expect((await ctx.app.inject({ method: "GET", url: `/workspaces/${otherWs}/stores/${store.id}/check`, headers: b.headers })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: "POST", url: `/workspaces/${otherWs}/stores/${store.id}/check`, headers: b.headers })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${store.id}/check`, headers: b.headers })).statusCode).toBe(404);

    await systemDb.store.update({ where: { id: store.id }, data: { status: "syncing" } });
    const busy = await ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/stores/${store.id}/check`, headers: a.headers });
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error).toBe("store_not_ready");

    await systemDb.store.update({ where: { id: store.id }, data: { status: "active" } });
    for (let i = 0; i < 4; i++) {
      await systemDb.reconciliation.updateMany({ data: { status: "verified", finishedAt: new Date() } });
      expect((await ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/stores/${store.id}/check`, headers: a.headers })).statusCode).toBe(202);
    }
    expect((await ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/stores/${store.id}/check`, headers: a.headers })).statusCode).toBe(429);
  });
});

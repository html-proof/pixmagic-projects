import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { systemDb } from "@app/db";
import { addDays, localDay, MAX_BUSINESS_EVENTS, sha256Hex } from "@app/shared";
import { clean, createStore, createWorkspace, setup, signIn, teardown, type TestCtx } from "./helpers.js";

/**
 * The Profit sheet's data: business events (kept per store, added, changed and removed by whoever
 * sees the sales, read-only for API keys, audited, never reachable from another workspace) and the
 * dashboard's answer narrowed to the sheet (GET …/overview?parts=sheet: the sales, visits and ad
 * spend day by day, nothing else computed).
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

const TODAY = localDay(new Date(), "UTC");
const d = (n: number) => addDays(TODAY, n);

async function owner(name = "Events") {
  const a = await signIn(ctx, `events-owner-${name}`, `owner-${name.toLowerCase()}@events.test`);
  const ws = await createWorkspace(ctx, a.headers, name);
  const store = await createStore(ws, `${name.toLowerCase()}.myshopify.com`, ["read_orders", "read_products", "read_customers", "write_pixels", "read_customer_events"], {
    pixelInstalled: true,
    pixelInstalledAt: new Date(`${d(-5)}T00:00:00Z`),
    ordersHistoryFrom: new Date(0),
  });
  return { a, ws, store };
}

let users = 0;
async function member(ws: string, permissions: string[]) {
  const n = ++users;
  const m = await signIn(ctx, `events-member-${n}`, `member${n}@events.test`);
  await systemDb.membership.create({ data: { workspaceId: ws, userId: m.user.id, role: "custom", permissions } });
  return m;
}

const events = (ws: string, storeId: string) => `/workspaces/${ws}/stores/${storeId}/business-events`;
const sale = { title: "Spring sale", kind: "sale", startsOn: d(-3), endsOn: d(-2), note: "20% off, code SPRING20" };

describe("business events", () => {
  it("are added, listed by the dates they run on, changed and removed, each change audited", async () => {
    const { a, ws, store } = await owner();
    const created = ok<{ event: { id: string } & typeof sale }>(await call("POST", events(ws, store.id), a.headers, sale), 201).event;
    expect(created).toMatchObject(sale);
    ok(await call("POST", events(ws, store.id), a.headers, { title: "Launch", kind: "launch", startsOn: d(-10), endsOn: d(-10), note: null }), 201);

    // Every one without dates, earliest first; with dates, those running on any of them.
    expect(ok(await call("GET", events(ws, store.id), a.headers)).events.map((e: { title: string }) => e.title)).toEqual(["Launch", "Spring sale"]);
    expect(ok(await call("GET", `${events(ws, store.id)}?from=${d(-2)}&to=${d(0)}`, a.headers)).events.map((e: { title: string }) => e.title)).toEqual(["Spring sale"]);
    expect(ok(await call("GET", `${events(ws, store.id)}?from=${d(-1)}&to=${d(0)}`, a.headers)).events).toEqual([]);

    const changed = ok(await call("PUT", `${events(ws, store.id)}/${created.id}`, a.headers, { ...sale, title: "Spring sale (extended)", endsOn: d(-1) })).event;
    expect(changed).toMatchObject({ id: created.id, title: "Spring sale (extended)", endsOn: d(-1) });
    ok(await call("DELETE", `${events(ws, store.id)}/${created.id}`, a.headers));
    expect(ok(await call("GET", events(ws, store.id), a.headers)).events).toHaveLength(1);
    expect((await call("DELETE", `${events(ws, store.id)}/${created.id}`, a.headers)).statusCode).toBe(404);

    const log = await systemDb.auditLog.findMany({ where: { workspaceId: ws, action: { startsWith: "business_event." } }, orderBy: { createdAt: "asc" } });
    expect(log.map((l) => l.action)).toEqual(["business_event.created", "business_event.created", "business_event.updated", "business_event.deleted"]);
    // What was done and to which days; never the note.
    expect(JSON.stringify(log)).not.toContain("SPRING20");
  });

  it("refuses an event it can't keep with a 400, and more than a store keeps with a 409", async () => {
    const { a, ws, store } = await owner();
    for (const bad of [
      { ...sale, endsOn: d(-4) },
      { ...sale, kind: "party" },
      { ...sale, title: " " },
      { ...sale, startsOn: "2026-02-30" },
      { ...sale, startsOn: d(-400), endsOn: d(-1) },
      { ...sale, extra: true },
    ]) {
      expect((await call("POST", events(ws, store.id), a.headers, bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect((await call("GET", `${events(ws, store.id)}?from=${d(-1)}`, a.headers)).statusCode).toBe(400);
    await systemDb.businessEvent.createMany({
      data: Array.from({ length: MAX_BUSINESS_EVENTS }, (_, i) => ({ workspaceId: ws, storeId: store.id, kind: "other", title: `E${i}`, startsOn: d(-1), endsOn: d(-1) })),
    });
    const full = await call("POST", events(ws, store.id), a.headers, sale);
    expect(full.statusCode).toBe(409);
    expect(full.json().error).toBe("too_many_events");
  });

  it("are for whoever sees the sales; API keys only read them; another business never reaches them", async () => {
    const { a, ws, store } = await owner();
    const id = ok(await call("POST", events(ws, store.id), a.headers, sale), 201).event.id as string;

    const sales = await member(ws, ["analytics.sales"]);
    expect(ok(await call("GET", events(ws, store.id), sales.headers)).events).toHaveLength(1);
    ok(await call("POST", events(ws, store.id), sales.headers, { ...sale, title: "Their own" }), 201);
    const none = await member(ws, ["products.view"]);
    expect((await call("GET", events(ws, store.id), none.headers)).statusCode).toBe(403);
    expect((await call("POST", events(ws, store.id), none.headers, sale)).statusCode).toBe(403);

    const secret = `sk_${randomBytes(16).toString("hex")}`;
    await systemDb.apiKey.create({ data: { workspaceId: ws, name: "k", prefix: secret.slice(0, 8), keyHash: sha256Hex(secret), createdById: a.user.id } });
    const key = { authorization: `Bearer ${secret}` };
    expect((await call("GET", events(ws, store.id), key)).statusCode).toBe(200);
    expect((await call("POST", events(ws, store.id), key, sale)).statusCode).toBe(403);
    expect((await call("DELETE", `${events(ws, store.id)}/${id}`, key)).statusCode).toBe(403);

    const other = await owner("Other");
    // Their own workspace naming this store, or this event under their own store: not found either way.
    expect((await call("GET", events(other.ws, store.id), other.a.headers)).statusCode).toBe(404);
    expect((await call("PUT", `${events(other.ws, other.store.id)}/${id}`, other.a.headers, sale)).statusCode).toBe(404);
    expect((await call("DELETE", `${events(other.ws, other.store.id)}/${id}`, other.a.headers)).statusCode).toBe(404);
    expect((await call("GET", events(ws, store.id), other.a.headers)).statusCode).toBe(404);
    expect(await systemDb.businessEvent.count({ where: { id } })).toBe(1);
  });

  it("go with their store", async () => {
    const { a, ws, store } = await owner();
    ok(await call("POST", events(ws, store.id), a.headers, sale), 201);
    await systemDb.store.delete({ where: { id: store.id } });
    expect(await systemDb.businessEvent.count({ where: { workspaceId: ws } })).toBe(0);
  });
});

describe("the dashboard's answer for the sheet", () => {
  async function seed(store: Awaited<ReturnType<typeof createStore>>) {
    const ws = store.workspaceId;
    // Three days of sales: 3 orders a day, 2 by a known customer of whom 1 had bought before.
    for (const n of [-3, -2, -1]) {
      await systemDb.dailyStoreMetrics.create({
        data: { workspaceId: ws, storeId: store.id, day: d(n), grossSales: 100, totalSales: 110, taxes: 10, orders: 3, orderValue: 95, units: 5, ordersWithCustomer: 2, returningCustomerOrders: 1 },
      });
    }
    // Visits on the last two days only (the pixel counted from 5 days ago: the day before has none, which is 0).
    for (const [day, visitor] of [[d(-2), "v1"], [d(-2), "v2"], [d(-1), "v3"]] as const) {
      await systemDb.funnelVisit.create({ data: { workspaceId: ws, storeId: store.id, day, visitor, enteredAt: new Date(`${day}T10:00:00Z`), furthestStep: 1 } });
    }
    const meta = await systemDb.adConnection.create({
      data: { workspaceId: ws, storeId: store.id, provider: "meta", accountId: "act_1", currency: "USD", timezone: "UTC", accessTokenEnc: "x", tokenKeyVersion: 1, historyFrom: "2020-01-01", syncedThrough: TODAY, lastSyncedAt: new Date() },
    });
    for (const n of [-3, -2, -1]) {
      await systemDb.adCampaignDaily.create({ data: { workspaceId: ws, storeId: store.id, connectionId: meta.id, provider: "meta", accountId: "act_1", campaignId: "1", campaignName: "Spring", day: d(n), spend: 30, clicks: 1 } });
    }
  }

  it("carries the sales, visits and ad spend day by day, and none of the dashboard's other modules", async () => {
    const { a, ws, store } = await owner();
    await seed(store);
    const ov = ok(await call("GET", `/workspaces/${ws}/stores/${store.id}/overview?preset=custom&from=${d(-3)}&to=${d(-1)}&parts=sheet`, a.headers));
    expect(Object.keys(ov.modules).sort()).toEqual(["ad_connections", "ads", "funnel", "sales_overview"]);
    expect(ov.modules.sales_overview.series.map((x: Record<string, unknown>) => [x.day, x.totalSales, x.tax, x.orders, x.orderValue, x.units, x.newCustomerOrders])).toEqual(
      [-3, -2, -1].map((n) => [d(n), 110, 10, 3, 95, 5, 1]),
    );
    expect(ov.modules.funnel.visitsByDay).toEqual([
      { day: d(-3), visits: 0 },
      { day: d(-2), visits: 2 },
      { day: d(-1), visits: 1 },
    ]);
    expect(ov.modules.ads.seriesByProvider).toEqual([{ provider: "meta", series: [-3, -2, -1].map((n) => expect.objectContaining({ day: d(n), spend: 30 })) }]);
    // The dashboard's own answer is unchanged: no visits day by day there.
    const full = ok(await call("GET", `/workspaces/${ws}/stores/${store.id}/overview?preset=custom&from=${d(-3)}&to=${d(-1)}`, a.headers));
    expect(full.modules.funnel).not.toHaveProperty("visitsByDay");
  });

  it("gives a member only what they were granted, day by day too", async () => {
    const { ws, store } = await owner();
    await seed(store);
    const m = await member(ws, ["analytics.sales"]);
    const ov = ok(await call("GET", `/workspaces/${ws}/stores/${store.id}/overview?preset=custom&from=${d(-3)}&to=${d(-1)}&parts=sheet`, m.headers));
    expect(Object.keys(ov.modules)).toEqual(["sales_overview"]);
    // Total sales and tax are the breakdown's, returns are refunds', which orders were a customer's first customer analytics'.
    expect(ov.modules.sales_overview.series[0]).toEqual({ day: d(-3), netSales: 100, orders: 3, units: 5, averageOrderValue: 31.67, orderValue: 95 });
  });
});

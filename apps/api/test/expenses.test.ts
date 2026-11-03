import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { systemDb } from "@app/db";
import { addDays, localDay } from "@app/shared";
import { clean, createStore, createWorkspace, setup, signIn, teardown, type TestCtx } from "./helpers.js";

/**
 * A store's own costs (Settings → Costs), end to end: owners and admins keep them, members who may
 * see the sales breakdown read them, the dashboard adds up the dates' share of each and says whether
 * the list is complete for them, every change is in the audit log, and nothing of one workspace's
 * costs is reachable from another.
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

let users = 0;
async function member(ws: string, role: "viewer" | "custom" | "manager", permissions: string[]) {
  const n = ++users;
  const m = await signIn(ctx, `costs-member-${n}`, `costs${n}@example.com`);
  await systemDb.membership.create({ data: { workspaceId: ws, userId: m.user.id, role, permissions } });
  return m;
}

const TODAY = localDay(new Date(), "UTC");
// Last calendar month, whole: a monthly cost counts its whole amount for it.
const LAST_MONTH_END = addDays(`${TODAY.slice(0, 8)}01`, -1);
const LAST_MONTH = { from: `${LAST_MONTH_END.slice(0, 8)}01`, to: LAST_MONTH_END };

async function owner(name = "owner") {
  const a = await signIn(ctx, `costs-${name}`, `${name}@costs.test`);
  const ws = await createWorkspace(ctx, a.headers, `Costs ${name}`);
  const store = await createStore(ws, `costs-${name}.myshopify.com`, ["read_orders", "read_products"], { timezone: "UTC", currency: "AUD", name: "Costs Shop" });
  return { a, ws, store };
}

const url = (ws: string, storeId: string, rest = "") => `/workspaces/${ws}/stores/${storeId}/expenses${rest}`;
const plan = { name: "Shopify Basic", category: "shopify_plan", amount: 39, cadence: "monthly", startsOn: "2025-01-01", endsOn: null, note: "Billed on the 3rd" };
const labels = { name: "Label printer", category: "shipping", amount: 250, cadence: "once", startsOn: LAST_MONTH.from, endsOn: null, note: null };

describe("the store's own costs", () => {
  it("are kept by owners, read by members who may see the breakdown, and added up for the dashboard's dates", async () => {
    const { a, ws, store } = await owner();
    const first = ok(await call("POST", url(ws, store.id), a.headers, plan), 201).expense;
    expect(first).toMatchObject({ ...plan, id: expect.any(String) });
    ok(await call("POST", url(ws, store.id), a.headers, labels), 201);

    const list = ok(await call("GET", url(ws, store.id), a.headers));
    expect(list.currency).toBe("AUD");
    expect(list.expenses.map((e: { name: string }) => e.name).sort()).toEqual(["Label printer", "Shopify Basic"]);
    expect(list.settings).toEqual({ completeFrom: null, operatingWeekdays: [], updatedAt: null });

    // The dashboard: last month holds the whole plan and the one-off labels; not complete yet.
    const dates = `preset=custom&from=${LAST_MONTH.from}&to=${LAST_MONTH.to}`;
    const ov = ok(await call("GET", `/workspaces/${ws}/stores/${store.id}/overview?${dates}`, a.headers));
    expect(ov.modules.expenses).toMatchObject({
      currency: "AUD",
      count: 2,
      current: { total: 289, byCategory: [{ category: "shipping", amount: 250 }, { category: "shopify_plan", amount: 39 }], counted: 2 },
      complete: false,
      completeFrom: null,
    });

    // Said complete from last month's first day: complete for those dates, not for any before.
    expect(ok(await call("PUT", url(ws, store.id, "/settings"), a.headers, { completeFrom: LAST_MONTH.from })).settings.completeFrom).toBe(LAST_MONTH.from);
    expect(ok(await call("GET", `/workspaces/${ws}/stores/${store.id}/overview?${dates}`, a.headers)).modules.expenses.complete).toBe(true);
    const earlier = `preset=custom&from=${addDays(LAST_MONTH.from, -1)}&to=${LAST_MONTH.to}`;
    expect(ok(await call("GET", `/workspaces/${ws}/stores/${store.id}/overview?${earlier}`, a.headers)).modules.expenses.complete).toBe(false);

    // A member who may see the breakdown reads them, and can't change them.
    const analyst = await member(ws, "manager", ["analytics.sales", "finance.breakdown"]);
    expect(ok(await call("GET", url(ws, store.id), analyst.headers)).expenses).toHaveLength(2);
    expect(ok(await call("GET", `/workspaces/${ws}/stores/${store.id}/overview?${dates}`, analyst.headers)).modules.expenses.current.total).toBe(289);
    expect((await call("POST", url(ws, store.id), analyst.headers, plan)).statusCode).toBe(403);
    expect((await call("PUT", url(ws, store.id, `/${first.id}`), analyst.headers, plan)).statusCode).toBe(403);
    expect((await call("DELETE", url(ws, store.id, `/${first.id}`), analyst.headers)).statusCode).toBe(403);
    expect((await call("PUT", url(ws, store.id, "/settings"), analyst.headers, { completeFrom: null })).statusCode).toBe(403);
    // One who may see sales but not the breakdown gets neither the list nor the dashboard's costs.
    const seller = await member(ws, "custom", ["analytics.sales"]);
    expect((await call("GET", url(ws, store.id), seller.headers)).statusCode).toBe(403);
    expect(ok(await call("GET", `/workspaces/${ws}/stores/${store.id}/overview?${dates}`, seller.headers)).modules).not.toHaveProperty("expenses");
  });

  it("are changed and removed whole, each change in the audit log with what it was", async () => {
    const { a, ws, store } = await owner();
    const saved = ok(await call("POST", url(ws, store.id), a.headers, plan), 201).expense;
    const changed = ok(await call("PUT", url(ws, store.id, `/${saved.id}`), a.headers, { ...plan, amount: 105, name: "Shopify Grow" })).expense;
    expect(changed).toMatchObject({ id: saved.id, amount: 105, name: "Shopify Grow" });
    ok(await call("DELETE", url(ws, store.id, `/${saved.id}`), a.headers));
    expect(ok(await call("GET", url(ws, store.id), a.headers)).expenses).toEqual([]);
    expect((await call("DELETE", url(ws, store.id, `/${saved.id}`), a.headers)).statusCode).toBe(404);

    const log = await systemDb.auditLog.findMany({ where: { workspaceId: ws, targetType: "store_expense" }, orderBy: { createdAt: "asc" } });
    expect(log.map((l) => l.action)).toEqual(["expense.added", "expense.changed", "expense.removed"]);
    expect(log[1]!.metadata).toMatchObject({ before: { amount: 39, name: "Shopify Basic" }, after: { amount: 105, name: "Shopify Grow" } });
    // The note is the owner's free text: kept with the cost, never copied into the log.
    expect(JSON.stringify(log.map((l) => l.metadata))).not.toContain("Billed on the 3rd");
  });

  it("refuses a cost that can't be counted, and saves nothing", async () => {
    const { a, ws, store } = await owner();
    for (const bad of [
      { ...plan, amount: -5 },
      { ...plan, cadence: "hourly" },
      { ...plan, category: "tips" },
      { ...plan, startsOn: "2026-02-30" },
      { ...plan, endsOn: "2024-12-31" },
      { ...labels, endsOn: LAST_MONTH.to },
      { ...plan, storeId: "another" },
    ]) {
      const res = await call("POST", url(ws, store.id), a.headers, bad);
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect(await systemDb.storeExpense.count({ where: { storeId: store.id } })).toBe(0);
  });

  it("are never reachable from another workspace, and go with the store", async () => {
    const mine = await owner("mine");
    const theirs = await owner("theirs");
    const cost = ok(await call("POST", url(mine.ws, mine.store.id), mine.a.headers, plan), 201).expense;
    // Their owner, naming my store in their workspace or mine: nothing.
    expect((await call("GET", url(theirs.ws, mine.store.id), theirs.a.headers)).statusCode).toBe(404);
    expect((await call("GET", url(mine.ws, mine.store.id), theirs.a.headers)).statusCode).toBe(404);
    // My cost's id under their own store: not found, and not changed.
    expect((await call("PUT", url(theirs.ws, theirs.store.id, `/${cost.id}`), theirs.a.headers, { ...plan, amount: 1 })).statusCode).toBe(404);
    expect((await call("DELETE", url(theirs.ws, theirs.store.id, `/${cost.id}`), theirs.a.headers)).statusCode).toBe(404);
    expect(Number((await systemDb.storeExpense.findUniqueOrThrow({ where: { id: cost.id } })).amount)).toBe(39);
    // A store erased takes its costs with it.
    await systemDb.store.delete({ where: { id: mine.store.id } });
    expect(await systemDb.storeExpense.count({ where: { id: cost.id } })).toBe(0);
  });
});

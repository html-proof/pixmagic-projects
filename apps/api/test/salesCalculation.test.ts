import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { purgeStoreData, recomputeDays } from "@app/core";
import { systemDb } from "@app/db";
import { addDays, customSales, localDay, SHOPIFY_STANDARD } from "@app/shared";
import { clean, createStore, createWorkspace, setup, signIn, teardown, type TestCtx } from "./helpers.js";

/**
 * Total sales line by line and the store's own calculation (Custom sales), end to end: the lines
 * add up to Shopify's total sales and never change with the calculation, which is kept per store,
 * saved by owners and admins only, read by members who may see the breakdown, in the audit log,
 * restored on every visit, never reachable from another workspace, and named in the download.
 */

let ctx: TestCtx;
beforeAll(async () => (ctx = await setup()));
afterAll(async () => teardown(ctx));
beforeEach(async () => clean(ctx));

type Headers = Record<string, string>;
type Store = Awaited<ReturnType<typeof createStore>>;
const call = (method: string, url: string, headers: Headers = {}, payload?: unknown) => ctx.app.inject({ method, url, headers, payload });
function ok<T = any>(res: Awaited<ReturnType<typeof call>>, status = 200): T { // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(res.statusCode, res.body).toBe(status);
  return res.json();
}

let users = 0;
async function member(ws: string, role: "viewer" | "custom" | "manager", permissions: string[]) {
  const n = ++users;
  const m = await signIn(ctx, `calc-member-${n}`, `calc${n}@example.com`);
  await systemDb.membership.create({ data: { workspaceId: ws, userId: m.user.id, role, permissions } });
  return m;
}

const DAY = addDays(localDay(new Date(), "UTC"), -3);
const BEFORE = addDays(DAY, -1);
const RANGE = `preset=custom&from=${DAY}&to=${DAY}`;

/**
 * An international order on `day` with Shopify's sales records: items A$1,100 (A$100 GST in),
 * shipping A$55, duties A$44 and a A$11 additional fee (each A$1 in 11 tax), then a refund of an
 * item (A$220, A$20 GST) and of half the duty the same day.
 */
async function seedOrder(store: Store, id: string, day: string) {
  const at = new Date(`${day}T12:00:00Z`);
  const sale = (i: number, actionType: string, lineType: string, amount: number, tax: number, quantity: number | null = null) => ({
    workspaceId: store.workspaceId,
    storeId: store.id,
    shopifyId: `${id}-sale-${i}`,
    localDay: day,
    happenedAt: at,
    actionType,
    lineType,
    quantity,
    amount,
    discount: 0,
    tax,
  });
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
      financialStatus: "partially_refunded",
      subtotal: 1100,
      totalDiscounts: 0,
      totalTax: 116,
      totalShipping: 55,
      totalPrice: 1210,
      salesUpdatedAt: at,
      sales: {
        create: [
          sale(0, "order", "product", 1100, 100, 2),
          sale(1, "order", "shipping", 55, 5),
          sale(2, "order", "duty", 44, 4),
          sale(3, "order", "additional_fee", 11, 1),
          sale(4, "return", "product", -220, -20, 1),
          sale(5, "return", "duty", -22, -2),
        ],
      },
    },
  });
  await recomputeDays(store, [day]);
}

async function owner() {
  const a = await signIn(ctx, "calc-owner", "owner@calc.test");
  const ws = await createWorkspace(ctx, a.headers, "Calc");
  const store = await createStore(ws, "calc.myshopify.com", ["read_orders", "read_products"], { timezone: "UTC", currency: "AUD", name: "Calc Shop" });
  await seedOrder(store, "1001", DAY);
  await seedOrder(store, "1002", BEFORE);
  return { a, ws, store };
}

const url = (ws: string, storeId: string) => `/workspaces/${ws}/stores/${storeId}/sales-calculation`;
const excludingTax = { components: { ...SHOPIFY_STANDARD, taxes: false }, label: null, applyToDashboard: true, presets: [{ name: "Wholesale", components: { ...SHOPIFY_STANDARD, taxes: false, shipping: false } }] };

describe("total sales line by line", () => {
  it("gives each line of Shopify's total sales, and they add up to it", async () => {
    const { a, ws, store } = await owner();
    const ov = ok(await call("GET", `/workspaces/${ws}/stores/${store.id}/overview?${RANGE}`, a.headers));
    const c = ov.modules.sales_overview.current;
    // Net 1000 − 200 = 800; shipping 50; duties 40 − 20 = 20; fees 10; taxes 100 + 5 + 4 + 1 − 20 − 2 = 88.
    expect(c).toMatchObject({ netSales: 800, shipping: 50, duties: 20, additionalFees: 10, tax: 88, totalSales: 968 });
    expect(Math.round((c.netSales + c.additionalFees + c.duties + c.shipping + c.tax) * 100)).toBe(Math.round(c.totalSales * 100));
    // The dates' own lines only: nothing for the period before.
    for (const k of ["previous", "deltas", "previousSeries"]) expect(ov.modules.sales_overview).not.toHaveProperty(k);
    // Every day of the series carries its lines too (Custom sales is drawn day by day from them).
    expect(ov.modules.sales_overview.series).toEqual([expect.objectContaining({ day: DAY, totalSales: 968, shipping: 50, tax: 88, duties: 20, additionalFees: 10 })]);
    // Until something is saved, the store uses Shopify's own total sales and shows nothing else.
    expect(ov.modules.sales_overview.calculation).toEqual({ components: SHOPIFY_STANDARD, label: null, applyToDashboard: false, presets: [], updatedAt: null });
  });
});

describe("the store's sales calculation", () => {
  it("is saved by owners for everyone, restored on every visit, and never changes Shopify's figures", async () => {
    const { a, ws, store } = await owner();
    const before = ok(await call("GET", `/workspaces/${ws}/stores/${store.id}/overview?${RANGE}`, a.headers)).modules.sales_overview;

    const saved = ok(await call("PUT", url(ws, store.id), a.headers, excludingTax)).calculation;
    expect(saved).toMatchObject({ components: excludingTax.components, label: null, applyToDashboard: true, presets: excludingTax.presets });
    expect(typeof saved.updatedAt).toBe("string");

    // A member who may see the breakdown reads the same calculation, on its own and in the overview.
    const analyst = await member(ws, "manager", ["analytics.sales", "finance.breakdown"]);
    expect(ok(await call("GET", url(ws, store.id), analyst.headers)).calculation).toEqual(saved);
    expect(ok(await call("GET", `/workspaces/${ws}/stores/${store.id}/overview?${RANGE}`, analyst.headers)).modules.sales_overview.calculation).toEqual(saved);
    // Shopify's figures are exactly what they were; Custom sales is worked out from the lines.
    const after = ok(await call("GET", `/workspaces/${ws}/stores/${store.id}/overview?${RANGE}`, a.headers)).modules.sales_overview;
    expect(after.calculation).toEqual(saved);
    expect(after.current).toEqual(before.current);
    expect(after.series).toEqual(before.series);
    const c = after.current;
    expect(customSales({ netSales: c.netSales, additionalFees: c.additionalFees, duties: c.duties, shipping: c.shipping, taxes: c.tax }, saved.components)).toBe(880);

    // Owners and admins only: it changes what the whole team sees.
    expect((await call("PUT", url(ws, store.id), analyst.headers, { ...excludingTax, applyToDashboard: false })).statusCode).toBe(403);
    // A member who can't see tax, shipping or total sales gets neither the lines nor the calculation.
    const seller = await member(ws, "custom", ["analytics.sales"]);
    expect((await call("GET", url(ws, store.id), seller.headers)).statusCode).toBe(403);
    const theirs = ok(await call("GET", `/workspaces/${ws}/stores/${store.id}/overview?${RANGE}`, seller.headers)).modules.sales_overview;
    expect(theirs).not.toHaveProperty("calculation");
    expect(theirs.current).not.toHaveProperty("duties");
    expect(theirs.series[0]).not.toHaveProperty("tax");

    // Each change is in the audit log, with what it was before.
    const log = await systemDb.auditLog.findFirstOrThrow({ where: { workspaceId: ws, action: "sales_calculation.changed" } });
    expect(log).toMatchObject({ targetType: "store", targetId: store.id });
    expect(log.metadata).toMatchObject({ before: { components: SHOPIFY_STANDARD, applyToDashboard: false }, after: { components: excludingTax.components, applyToDashboard: true, presets: 1 } });
    // Only the choice is stored, never an amount.
    const row = await systemDb.salesCalculation.findUniqueOrThrow({ where: { storeId: store.id } });
    expect(JSON.stringify(row)).not.toContain("968");
  });

  it("names a calculation of the merchant's own, and drops the name of a built-in one", async () => {
    const { a, ws, store } = await owner();
    const own = ok(await call("PUT", url(ws, store.id), a.headers, { ...excludingTax, components: { ...SHOPIFY_STANDARD, additionalFees: false }, label: "Revenue without fees" })).calculation;
    expect(own.label).toBe("Revenue without fees");
    const builtIn = ok(await call("PUT", url(ws, store.id), a.headers, { ...excludingTax, label: "My name" })).calculation;
    expect(builtIn.label).toBeNull();
  });

  it("refuses a setting that isn't one, without saving anything", async () => {
    const { a, ws, store } = await owner();
    for (const bad of [
      { ...excludingTax, components: { netSales: false, additionalFees: false, duties: false, shipping: false, taxes: false } },
      { ...excludingTax, totalSales: 100 },
      { ...excludingTax, components: { ...SHOPIFY_STANDARD, tips: true } },
      { components: SHOPIFY_STANDARD },
    ]) {
      const res = await call("PUT", url(ws, store.id), a.headers, bad);
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
      expect(res.json().error).toBe("validation");
    }
    expect(await systemDb.salesCalculation.count()).toBe(0);
  });

  it("keeps every workspace to its own stores", async () => {
    const { a, ws, store } = await owner();
    ok(await call("PUT", url(ws, store.id), a.headers, excludingTax));
    const b = await signIn(ctx, "calc-other", "other@calc.test");
    const wsB = await createWorkspace(ctx, b.headers, "Other");
    const storeB = await createStore(wsB, "other.myshopify.com", ["read_orders"], { timezone: "UTC" });
    // Not a member of A's workspace: as if it didn't exist.
    expect((await call("GET", url(ws, store.id), b.headers)).statusCode).toBe(404);
    expect((await call("PUT", url(ws, store.id), b.headers, excludingTax)).statusCode).toBe(404);
    // A's store under B's own workspace: not found either, and nothing written.
    expect((await call("GET", url(wsB, store.id), b.headers)).statusCode).toBe(404);
    expect((await call("PUT", url(wsB, store.id), b.headers, { ...excludingTax, applyToDashboard: false })).statusCode).toBe(404);
    expect((await systemDb.salesCalculation.findUniqueOrThrow({ where: { storeId: store.id } })).applyToDashboard).toBe(true);
    // B's own store has its own (default) calculation.
    expect(ok(await call("GET", url(wsB, storeB.id), b.headers)).calculation.updatedAt).toBeNull();
  });

  it("downloads Custom sales as a column of its own, named, only while the store shows it", async () => {
    const { a, ws, store } = await owner();
    const csv = async () => {
      const res = await call("GET", `/workspaces/${ws}/stores/${store.id}/export?section=sales&${RANGE}`, a.headers);
      expect(res.statusCode, res.body).toBe(200);
      return res.body.trim().split(/\r?\n/).map((l) => l.split(",").map((cell) => cell.replace(/^"|"$/g, "")));
    };
    const plain = await csv();
    expect(plain[0]).toEqual(["Day", "Orders", "Total sales", "Net sales", "Additional fees", "Duties", "Shipping charges", "Taxes", "Average order value", "Returns"]);
    expect(plain[1]!.slice(0, 8)).toEqual([DAY, "1", "968", "800", "10", "20", "50", "88"]);

    ok(await call("PUT", url(ws, store.id), a.headers, excludingTax));
    const applied = await csv();
    expect(applied[0]).toContain("Custom sales (Sales excluding tax)");
    const col = applied[0]!.indexOf("Custom sales (Sales excluding tax)");
    expect(applied[1]![col]).toBe("880");
    // Shopify's total sales is still its own column, unchanged.
    expect(applied[1]![applied[0]!.indexOf("Total sales")]).toBe("968");

    ok(await call("PUT", url(ws, store.id), a.headers, { ...excludingTax, applyToDashboard: false }));
    expect((await csv())[0]).not.toContain("Custom sales (Sales excluding tax)");
  });

  it("goes with the store's data when it is erased", async () => {
    const { a, ws, store } = await owner();
    ok(await call("PUT", url(ws, store.id), a.headers, excludingTax));
    await purgeStoreData(store.id);
    expect(await systemDb.salesCalculation.count({ where: { storeId: store.id } })).toBe(0);
  });
});

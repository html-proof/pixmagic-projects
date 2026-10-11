import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { systemDb, withTenant } from "@app/db";
import { normalizeRestOrder, recomputeDays, upsertOrder } from "@app/core";
import { clean, createStore, createWorkspace, setup, signIn, teardown, type TestCtx } from "./helpers.js";

let ctx: TestCtx;
beforeAll(async () => (ctx = await setup()));
afterAll(async () => teardown(ctx));
beforeEach(async () => clean(ctx));

async function twoTenants() {
  const a = await signIn(ctx, "ua", "a@x.com");
  const b = await signIn(ctx, "ub", "b@x.com");
  const wsA = await createWorkspace(ctx, a.headers, "A");
  const wsB = await createWorkspace(ctx, b.headers, "B");
  const storeA = await createStore(wsA, "a.myshopify.com", ["read_orders"]);
  const storeB = await createStore(wsB, "b.myshopify.com", ["read_orders", "read_products", "read_customers"]);
  return { a, b, wsA, wsB, storeA, storeB };
}

const today = new Date().toISOString().slice(0, 10);

async function seedOrder(store: Awaited<ReturnType<typeof createStore>>, id: number, price: number) {
  const days = await upsertOrder(
    store,
    normalizeRestOrder({
      id,
      name: `#${id}`,
      currency: "USD",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      subtotal_price: String(price),
      total_discounts: "0",
      total_tax: "0",
      total_price: String(price),
      customer: { id: 5 },
      line_items: [{ id: id * 10, product_id: 99, title: "Hat", quantity: 1, price: String(price) }],
    }),
  );
  await recomputeDays(store, [...days]);
}

describe("tenant isolation", () => {
  it("never exposes another workspace's stores or metrics (404, not 403)", async () => {
    const { b, wsA, storeA } = await twoTenants();
    await seedOrder(storeA, 1, 100);
    for (const url of [
      `/workspaces/${wsA}/stores`,
      `/workspaces/${wsA}/stores/${storeA.id}/overview`,
      `/workspaces/${wsA}/members`,
      `/workspaces/${wsA}/audit-logs`,
    ]) {
      const res = await ctx.app.inject({ method: "GET", url, headers: b.headers });
      expect(res.statusCode, url).toBe(404);
    }
  });

  it("cannot reach a foreign store through one's own workspace path", async () => {
    const { b, wsB, storeA } = await twoTenants();
    const res = await ctx.app.inject({ method: "GET", url: `/workspaces/${wsB}/stores/${storeA.id}/overview`, headers: b.headers });
    expect(res.statusCode).toBe(404);
  });

  it("Postgres RLS hides other tenants' rows even without a where clause", async () => {
    const { wsA, wsB, storeA } = await twoTenants();
    await seedOrder(storeA, 1, 100);
    const seenFromB = await withTenant(wsB, async (tx) => ({
      stores: await tx.store.findMany(),
      orders: await tx.order.findMany(),
      metrics: await tx.dailyStoreMetrics.findMany(),
    }));
    expect(seenFromB.stores.map((s) => s.workspaceId)).toEqual([wsB]);
    expect(seenFromB.orders).toHaveLength(0);
    expect(seenFromB.metrics).toHaveLength(0);
    const seenFromA = await withTenant(wsA, (tx) => tx.order.findMany());
    expect(seenFromA).toHaveLength(1);
    // RLS WITH CHECK: cannot write into another tenant.
    await expect(withTenant(wsB, (tx) => tx.alert.create({ data: { workspaceId: wsA, severity: "info", code: "x", message: "x" } }))).rejects.toThrow();
  });

  it("enforces roles: viewers cannot manage stores", async () => {
    const { a, wsA, storeA } = await twoTenants();
    const v = await signIn(ctx, "uv", "v@x.com");
    await systemDb.membership.create({ data: { workspaceId: wsA, userId: v.user.id, role: "viewer" } });
    expect((await ctx.app.inject({ method: "GET", url: `/workspaces/${wsA}/stores`, headers: v.headers })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "DELETE", url: `/workspaces/${wsA}/stores/${storeA.id}`, headers: v.headers })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: "GET", url: `/workspaces/${wsA}/audit-logs`, headers: v.headers })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: "GET", url: `/workspaces/${wsA}/audit-logs`, headers: a.headers })).statusCode).toBe(200);
  });

  it("API keys are read-only and scoped to their workspace", async () => {
    const { a, wsA, wsB } = await twoTenants();
    const created = await ctx.app.inject({ method: "POST", url: `/workspaces/${wsA}/api-keys`, headers: a.headers, payload: { name: "BI" } });
    const secret = created.json().secret as string;
    expect(secret).toMatch(/^sk_live_/);
    const key = await systemDb.apiKey.findFirstOrThrow();
    expect(key.keyHash).not.toContain(secret);
    const bearer = { authorization: `Bearer ${secret}` };
    expect((await ctx.app.inject({ method: "GET", url: `/workspaces/${wsA}/stores`, headers: bearer })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "GET", url: `/workspaces/${wsB}/stores`, headers: bearer })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: "POST", url: `/workspaces/${wsA}/api-keys`, headers: bearer, payload: { name: "x" } })).statusCode).toBe(403);
    await ctx.app.inject({ method: "DELETE", url: `/workspaces/${wsA}/api-keys/${key.id}`, headers: a.headers });
    expect((await ctx.app.inject({ method: "GET", url: `/workspaces/${wsA}/stores`, headers: bearer })).statusCode).toBe(404);
  });
});

describe("capability-driven dashboard", () => {
  it("only returns modules backed by granted scopes, with real numbers", async () => {
    const { a, b, wsA, wsB, storeA, storeB } = await twoTenants();
    await seedOrder(storeA, 1, 100);
    await seedOrder(storeA, 2, 50);
    const resA = await ctx.app.inject({ method: "GET", url: `/workspaces/${wsA}/stores/${storeA.id}/overview?preset=7d`, headers: a.headers });
    expect(resA.statusCode).toBe(200);
    const body = resA.json();
    expect(Object.keys(body.modules).sort()).toEqual(["channels", "discount_codes", "fulfillment", "order_timing", "recent_orders", "refunds", "sales_overview", "traffic"]);
    expect(body.modules.sales_overview.current).toMatchObject({ grossSales: 150, netSales: 150, orders: 2, averageOrderValue: 75 });
    expect(body.capabilities.find((c: { id: string }) => c.id === "top_products").missingScopes).toEqual(["read_products"]);
    expect(body.range.to).toBe(today);
    expect(body.hasData).toBe(true);

    const resB = await ctx.app.inject({ method: "GET", url: `/workspaces/${wsB}/stores/${storeB.id}/overview?preset=30d`, headers: b.headers });
    const mb = resB.json();
    expect(Object.keys(mb.modules).sort()).toEqual([
      "catalog", "channels", "customers", "discount_codes", "fulfillment", "inventory",
      "order_timing", "recent_orders", "refunds", "sales_overview", "top_products", "traffic",
    ]);
    expect(mb.hasData).toBe(false);
    expect(mb.modules.sales_overview.current.averageOrderValue).toBeNull();
    expect(mb.modules.top_products.items).toEqual([]);
  });

  it("rejects invalid custom ranges", async () => {
    const { a, wsA, storeA } = await twoTenants();
    const res = await ctx.app.inject({ method: "GET", url: `/workspaces/${wsA}/stores/${storeA.id}/overview?preset=custom&from=2026-05-01&to=2026-01-01`, headers: a.headers });
    expect(res.statusCode).toBe(400);
  });
});

describe("pixel ingest", () => {
  // A fixed day, so a run near midnight can't split one shopper's visit across two days.
  const at = (min: number) => new Date(Date.UTC(2026, 9, 1, 10, min)).toISOString();
  const ev = (id: string, name: string, min: number, clientId: string, path?: string) => ({ id, name, clientId, timestamp: at(min), ...(path ? { path } : {}) });
  const post = (key: string, events: unknown[]) =>
    ctx.app.inject({ method: "POST", url: `/pixel/${key}`, headers: { "content-type": "text/plain" }, payload: JSON.stringify({ events }) });

  /** Three shoppers on 1 Oct: one leaves from the cart, one browses and leaves, one buys (on an older pixel that sends no paths). */
  async function threeVisits(key: string) {
    expect((await post(key, [ev("1", "page_viewed", 0, "c1", "/"), ev("2", "page_viewed", 1, "c1", "/collections/shirts"), ev("3", "product_viewed", 2, "c1", "/collections/shirts/products/tee")])).json().accepted).toBe(3);
    // Redelivered id 3 is ignored; a repeated id within one batch counts once.
    expect((await post(key, [ev("3", "product_viewed", 2, "c1", "/products/tee"), ev("4", "product_added_to_cart", 3, "c1", "/products/tee"), ev("5", "page_viewed", 4, "c1", "/cart"), ev("5", "page_viewed", 4, "c1", "/cart")])).json().accepted).toBe(2);
    // Out of order: the later page arrives first, and must stay the exit.
    expect((await post(key, [ev("6", "page_viewed", 9, "c2", "/search?q=linen")])).json().accepted).toBe(1);
    expect((await post(key, [ev("7", "page_viewed", 5, "c2", "/en-au/pages/about?ref=x")])).json().accepted).toBe(1);
    expect((await post(key, [ev("8", "page_viewed", 6, "c3"), ev("9", "checkout_started", 7, "c3"), ev("10", "checkout_completed", 8, "c3")])).json().accepted).toBe(3);
  }

  it("dedupes events and folds them into one visit per shopper per day", async () => {
    const { a, wsA, storeA } = await twoTenants();
    await threeVisits(storeA.pixelIngestKey!);
    const rows = await systemDb.funnelVisit.findMany({ where: { storeId: storeA.id }, orderBy: { enteredAt: "asc" } });
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.day === "2026-10-01" && r.workspaceId === wsA && /^[0-9a-f]{64}$/.test(r.visitor))).toBe(true);
    expect(rows.map((r) => [r.entrySection, r.entryPath, r.exitSection, r.exitPath, r.furthestStep, r.pageViews])).toEqual([
      ["home", "/", "cart", "/cart", 2, 3],
      ["content", "/pages/about", "search", "/search", 0, 2],
      ["checkout", "/checkout", "checkout", "/checkout", 4, 1],
    ]);
    expect((await systemDb.store.findUniqueOrThrow({ where: { id: storeA.id } })).pixelInstalled).toBe(true);
    expect((await post("nope", [ev("11", "page_viewed", 0, "c1")])).statusCode).toBe(404);
    expect((await post(storeA.pixelIngestKey!, [{ ...ev("12", "page_viewed", 0, "c1"), name: "made_up" }])).statusCode).toBe(400);
    // Funnel module still hidden: write_pixels/read_customer_events not granted.
    const ov = await ctx.app.inject({ method: "GET", url: `/workspaces/${wsA}/stores/${storeA.id}/overview`, headers: a.headers });
    expect(ov.json().modules.funnel).toBeUndefined();
  });

  it("reports how far visits got, where they landed and where they left", async () => {
    const u = await signIn(ctx, "uf", "f@x.com");
    const ws = await createWorkspace(ctx, u.headers, "F");
    const store = await createStore(ws, "f.myshopify.com", ["read_orders", "write_pixels", "read_customer_events"], { pixelInstalled: true });
    await threeVisits(store.pixelIngestKey!);
    // Another tenant's visits on the same day must not leak in.
    const other = await createStore(await createWorkspace(ctx, (await signIn(ctx, "ug", "g@x.com")).headers, "G"), "g.myshopify.com", ["read_orders"]);
    await post(other.pixelIngestKey!, [ev("x1", "page_viewed", 0, "c1", "/")]);

    const res = await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${store.id}/overview?preset=custom&from=2026-10-01&to=2026-10-01`, headers: u.headers });
    expect(res.statusCode).toBe(200);
    const f = res.json().modules.funnel;
    expect(f).toMatchObject({ visits: 3, purchases: 1, exits: 2, pagesPerVisit: 2, previous: { visits: 0, conversionRate: null }, deltas: { visits: null, conversionRate: null } });
    expect(f.conversionRate).toBeCloseTo(1 / 3);
    expect(f.steps.map((s: { step: string; reached: number; left: number }) => [s.step, s.reached, s.left])).toEqual([
      ["visited", 3, 1],
      ["viewed_product", 2, 0],
      ["added_to_cart", 2, 1],
      ["started_checkout", 1, 0],
      ["purchased", 1, 0],
    ]);
    expect(f.steps[0].leftFrom).toEqual([{ section: "search", visits: 1 }]);
    expect(f.steps[2].leftFrom).toEqual([{ section: "cart", visits: 1 }]);
    const sections = Object.fromEntries(f.sections.map((s: { section: string; visits: number; entries: number; exits: number }) => [s.section, [s.visits, s.entries, s.exits]]));
    expect(sections).toEqual({
      home: [1, 1, 0],
      collection: [1, 0, 0],
      product: [1, 0, 0],
      cart: [1, 0, 1],
      search: [1, 0, 1],
      checkout: [1, 1, 0],
      content: [1, 1, 0],
    });
    expect(f.entryPages).toEqual([
      { path: "/", section: "home", visits: 1, purchases: 0 },
      { path: "/checkout", section: "checkout", visits: 1, purchases: 1 },
      { path: "/pages/about", section: "content", visits: 1, purchases: 0 },
    ]);
    expect(f.exitPages.map((p: { path: string; visits: number }) => [p.path, p.visits])).toEqual([["/cart", 1], ["/search", 1]]);

    // Outside the visits' day there is nothing to show, and nothing is invented.
    const empty = await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${store.id}/overview?preset=custom&from=2026-09-01&to=2026-09-30`, headers: u.headers });
    expect(empty.json().modules.funnel).toMatchObject({ visits: 0, conversionRate: null, sections: [], entryPages: [], exitPages: [] });
  });
});

describe("health", () => {
  it("reports readiness", async () => {
    expect((await ctx.app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    const r = await ctx.app.inject({ method: "GET", url: "/readyz" });
    expect(r.json()).toMatchObject({ ok: true, checks: { db: true, coord: true } });
  });
});

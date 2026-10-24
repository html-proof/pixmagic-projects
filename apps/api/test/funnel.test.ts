import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { systemDb, type Store } from "@app/db";
import { recomputeDays } from "@app/core";
import { clean, createStore, createWorkspace, setup, signIn, teardown, type TestCtx } from "./helpers.js";

// The Shopping Funnel page: what the pixel records beyond the visit (device, country, product
// pages), the page's report (GET …/overview?parts=funnel), its checklist and its download.

let ctx: TestCtx;
beforeAll(async () => (ctx = await setup()));
afterAll(async () => teardown(ctx));
beforeEach(async () => clean(ctx));

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1";
const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const SCOPES = ["read_orders", "read_products", "write_pixels", "read_customer_events"];
const DAY = "2026-10-01";
const qs = (extra = "") => `preset=custom&from=${DAY}&to=${DAY}${extra}`;

describe("pixel ingest: device, country and product pages", () => {
  const at = (min: number) => new Date(Date.UTC(2026, 9, 1, 10, min)).toISOString();
  const ev = (id: string, name: string, min: number, path: string) => ({ id, name, clientId: "c1", timestamp: at(min), path });
  const post = (key: string, events: unknown[], headers: Record<string, string>) =>
    ctx.app.inject({ method: "POST", url: `/pixel/${key}`, headers: { "content-type": "text/plain", ...headers }, payload: JSON.stringify({ events }) });

  it("keeps the kind of device and the country of a visit's first batch, and the product pages it saw", async () => {
    const u = await signIn(ctx, "u1", "a@x.com");
    const store = await createStore(await createWorkspace(ctx, u.headers), "a.myshopify.com", SCOPES, { pixelInstalled: true });
    const key = store.pixelIngestKey!;
    const phone = { "user-agent": IPHONE, "x-insights-client-geo": "AU|NSW|Sydney" };
    expect((await post(key, [ev("1", "page_viewed", 0, "/"), ev("2", "product_viewed", 1, "/products/Tee?variant=3"), ev("3", "product_added_to_cart", 2, "/products/tee")], phone)).json().accepted).toBe(3);
    // A later batch from another device and place doesn't change them; a product seen from a collection is that product.
    const desk = { "user-agent": WINDOWS, "x-insights-client-geo": "US|CA|San Jose" };
    expect((await post(key, [ev("3", "product_added_to_cart", 2, "/products/tee"), ev("4", "product_viewed", 3, "/collections/kitchen/products/mug"), ev("5", "product_added_to_cart", 4, "/collections/kitchen")], desk)).json().accepted).toBe(2);

    const [visit] = await systemDb.funnelVisit.findMany({ where: { storeId: store.id } });
    expect(visit).toMatchObject({ day: DAY, device: "mobile", country: "AU", furthestStep: 2 });
    const products = await systemDb.funnelProductVisit.findMany({ where: { storeId: store.id }, orderBy: { handle: "asc" } });
    // The redelivered add (id 3) is counted once; the quick add from a collection names no product.
    expect(products.map((p) => [p.handle, p.steps, p.visitor === visit!.visitor, p.workspaceId === store.workspaceId])).toEqual([
      ["mug", 1, true, true],
      ["tee", 3, true, true],
    ]);
  });

  it("records an unknown device and no country when the request says neither", async () => {
    const u = await signIn(ctx, "u1", "a@x.com");
    const store = await createStore(await createWorkspace(ctx, u.headers), "a.myshopify.com", SCOPES, { pixelInstalled: true });
    await post(store.pixelIngestKey!, [ev("1", "page_viewed", 0, "/")], { "user-agent": "SomeBot/1.0" });
    expect(await systemDb.funnelVisit.findFirst({ where: { storeId: store.id } })).toMatchObject({ device: "unknown", country: null });
  });
});

/** Five visits on 1 Oct and two on 30 Sep, with what the page groups them by; product pages; two orders. */
async function seedStore(store: Store) {
  const ws = store.workspaceId;
  const visit = (day: string, visitor: string, step: number, v: { device?: string | null; country?: string | null; entry?: string; entryPath?: string; exitPath?: string } = {}) =>
    systemDb.funnelVisit.create({
      data: { workspaceId: ws, storeId: store.id, day, visitor, furthestStep: step, device: v.device ?? null, country: v.country ?? null, entrySection: v.entry ?? "home", entryPath: v.entryPath ?? "/", exitPath: v.exitPath ?? null, enteredAt: new Date(`${day}T10:00:00Z`), exitedAt: new Date(`${day}T10:30:00Z`) },
    });
  await visit(DAY, "c1", 4, { device: "mobile", country: "AU" });
  await visit(DAY, "c2", 2, { device: "mobile", country: "AU", entry: "product", entryPath: "/products/tee" });
  await visit(DAY, "c3", 1, { device: "desktop", country: "US", entry: "collection", entryPath: "/collections/all", exitPath: "/products/mug" });
  // Recorded before devices were: not recorded, rather than guessed.
  await visit(DAY, "c4", 0);
  await visit(DAY, "c5", 3, { device: "desktop" });
  // c5 was here before: a returning visit.
  await visit("2026-09-20", "c5", 0);
  await visit("2026-09-30", "p1", 4);
  await visit("2026-09-30", "p2", 0);
  const product = (visitor: string, handle: string, steps: number) => systemDb.funnelProductVisit.create({ data: { workspaceId: ws, storeId: store.id, day: DAY, visitor, handle, steps } });
  await product("c1", "tee", 3);
  await product("c2", "tee", 3);
  await product("c3", "tee", 1);
  await product("c3", "mug", 1);
  await product("c5", "mug", 1);
  for (const [id, handle, title] of [["101", "tee", "Linen Tee"], ["102", "mug", "Mug"], ["103", "cap", "Cap"]] as const) {
    await systemDb.product.create({ data: { workspaceId: ws, storeId: store.id, shopifyId: id, handle, title, shopifyUpdatedAt: new Date() } });
  }
  const created = new Date(`${DAY}T11:00:00Z`);
  for (const [id, productId, qty, price] of [["O1", "101", 2, 20], ["O2", "103", 1, 15]] as const) {
    await systemDb.order.create({
      data: {
        workspaceId: ws,
        storeId: store.id,
        shopifyId: id,
        name: `#${id}`,
        currency: "USD",
        localDay: DAY,
        shopifyCreatedAt: created,
        shopifyUpdatedAt: created,
        financialStatus: "paid",
        subtotal: qty * price,
        totalDiscounts: 0,
        totalTax: 0,
        totalShipping: 0,
        totalPrice: qty * price,
        lineItems: { create: [{ workspaceId: ws, storeId: store.id, shopifyId: `${id}-0`, productShopifyId: productId, title: "Item", quantity: qty, price, discount: 0 }] },
        salesUpdatedAt: created,
        sales: { create: [{ workspaceId: ws, storeId: store.id, shopifyId: `${id}-sale`, localDay: DAY, happenedAt: created, actionType: "order", lineType: "product", lineItemShopifyId: `${id}-0`, quantity: qty, amount: qty * price, discount: 0, tax: 0 }] },
      },
    });
  }
  await recomputeDays(store, [DAY]);
}

async function funnelStore() {
  const u = await signIn(ctx, "uf", "f@x.com");
  const ws = await createWorkspace(ctx, u.headers, "F");
  const store = await createStore(ws, "f.myshopify.com", SCOPES, { pixelInstalled: true, pixelInstalledAt: new Date("2026-09-01T00:00:00Z"), ordersHistoryFrom: new Date(0) });
  await seedStore(store);
  const page = async (extra = "") => {
    const res = await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${store.id}/overview?${qs(`${extra}&parts=funnel`)}`, headers: u.headers });
    expect(res.statusCode, res.body).toBe(200);
    return res.json();
  };
  return { u, ws, store, page };
}

describe("the Shopping Funnel report (parts=funnel)", () => {
  it("compares each step with the dates before, and works out every transition", async () => {
    const { page } = await funnelStore();
    const body = await page();
    // Only what the page shows is computed.
    expect(Object.keys(body.modules).sort()).toEqual(["channels", "funnel", "sales_overview", "traffic"]);
    const f = body.modules.funnel;
    expect(f.steps.map((s: { reached: number }) => s.reached)).toEqual([5, 4, 3, 2, 1]);
    expect(f.previous).toMatchObject({ visits: 2, conversionRate: 0.5, imported: true, reached: [2, 1, 1, 1, 1] });
    expect(f.browsers).toBe(5);
    expect(f.transitions.map((t: { from: string; to: string; lost: number; progression: number }) => [t.from, t.to, t.lost, t.progression])).toEqual([
      ["visited", "viewed_product", 1, 0.8],
      ["viewed_product", "added_to_cart", 1, 0.75],
      ["added_to_cart", "started_checkout", 1, 2 / 3],
      ["started_checkout", "purchased", 1, 0.5],
    ]);
    expect(f.transitions[0].previous).toEqual({ fromCount: 2, toCount: 1, progression: 0.5 });
    expect(f.daily).toEqual([{ day: DAY, reached: [5, 4, 3, 2, 1] }]);
    expect(f.detailsFrom).toBe(DAY);
    expect(f.lastEventAt).toBe(`${DAY}T10:30:00.000Z`);
    // Five visits are too few to say anything about.
    expect(f.insights).toEqual([]);
    // The orders beside it are the store's own, every order.
    expect(body.modules.sales_overview.current).toMatchObject({ orders: 2, netSales: 55 });
  });

  it("splits visits by device, country, landing page and new or returning, saying what wasn't recorded", async () => {
    const { page } = await funnelStore();
    const { segments } = (await page()).modules.funnel;
    const visits = (list: Array<{ key: string; visits: number }>) => Object.fromEntries(list.map((s) => [s.key, s.visits]));
    expect(visits(segments.device)).toEqual({ mobile: 2, desktop: 2, not_recorded: 1 });
    expect(visits(segments.country)).toEqual({ AU: 2, US: 1, unknown: 1, not_recorded: 1 });
    expect(visits(segments.landing)).toEqual({ home: 3, product: 1, collection: 1 });
    expect(visits(segments.visitor)).toEqual({ new: 4, returning: 1 });
    const mobile = segments.device.find((s: { key: string }) => s.key === "mobile");
    expect(mobile).toMatchObject({ reached: [2, 2, 2, 1, 1], conversionRate: 0.5, checkoutCompletion: 1 });
  });

  it("narrows every visit figure to the filter", async () => {
    const { page } = await funnelStore();
    const mobile = (await page("&device=mobile")).modules.funnel;
    expect(mobile.filter).toEqual({ device: "mobile" });
    expect(mobile.steps.map((s: { reached: number }) => s.reached)).toEqual([2, 2, 2, 1, 1]);
    // Nobody on a phone the day before.
    expect(mobile.previous.reached).toEqual([0, 0, 0, 0, 0]);
    expect(mobile.products.filter((p: { viewed: number | null }) => p.viewed).map((p: { handle: string; viewed: number; added: number }) => [p.handle, p.viewed, p.added])).toEqual([["tee", 2, 2]]);
    const returning = (await page("&visitor=returning")).modules.funnel;
    expect(returning.visits).toBe(1);
    expect((await page("&visitor=new&landing=home&country=AU")).modules.funnel.visits).toBe(1);
  });

  it("lists product pages with their views and adds, and the store's sales of each", async () => {
    const { page } = await funnelStore();
    const products = (await page()).modules.funnel.products;
    expect(products).toEqual([
      { handle: "tee", productId: "101", title: "Linen Tee", imageUrl: null, url: null, viewed: 3, added: 2, addRate: 2 / 3, landed: 1, landedLeft: 0, exits: 0, orders: 1, units: 2, netSales: 40 },
      { handle: "mug", productId: "102", title: "Mug", imageUrl: null, url: null, viewed: 2, added: 0, addRate: 0, landed: 0, landedLeft: 0, exits: 1, orders: 0, units: 0, netSales: 0 },
      // Sold, but no tracked visit viewed it.
      { handle: "cap", productId: "103", title: "Cap", imageUrl: null, url: null, viewed: 0, added: 0, addRate: null, landed: 0, landedLeft: 0, exits: 0, orders: 1, units: 1, netSales: 15 },
    ]);
  });

  it("rejects a filter it doesn't know", async () => {
    const { u, ws, store } = await funnelStore();
    for (const bad of ["device=phone", "visitor=old", "landing=attic", "country=australia"]) {
      const res = await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${store.id}/overview?${qs(`&parts=funnel&${bad}`)}`, headers: u.headers });
      expect(res.statusCode, bad).toBe(400);
    }
  });
});

describe("the funnel checklist", () => {
  it("marks actions done for the store, and not done again", async () => {
    const { u, ws, store, page } = await funnelStore();
    const tick = (id: string, payload: unknown) => ctx.app.inject({ method: "PUT", url: `/workspaces/${ws}/stores/${store.id}/funnel/actions/${id}`, headers: u.headers, payload });
    const done = await tick("cart.usability", { done: true });
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ id: "cart.usability", done: true, doneAt: expect.any(String) });
    // Ticking again keeps the first time.
    expect((await tick("cart.usability", { done: true })).json().doneAt).toBe(done.json().doneAt);
    expect((await page()).modules.funnel.actions).toEqual([{ id: "cart.usability", doneAt: done.json().doneAt, doneBy: u.user.id, doneByName: "f@x.com" }]);
    expect((await tick("cart.usability", { done: false })).json()).toEqual({ id: "cart.usability", done: false, doneAt: null });
    expect((await page()).modules.funnel.actions).toEqual([]);
    expect((await tick("made.up", { done: true })).statusCode).toBe(404);
    expect((await tick("cart.usability", { done: "yes" })).statusCode).toBe(400);
    expect(await systemDb.auditLog.count({ where: { workspaceId: ws, action: { startsWith: "funnel.action" } } })).toBe(3);
  });

  it("can't tick another workspace's store", async () => {
    const { store } = await funnelStore();
    const other = await signIn(ctx, "ug", "g@x.com");
    const ows = await createWorkspace(ctx, other.headers, "G");
    const res = await ctx.app.inject({ method: "PUT", url: `/workspaces/${ows}/stores/${store.id}/funnel/actions/cart.usability`, headers: other.headers, payload: { done: true } });
    expect(res.statusCode).toBe(404);
    expect(await systemDb.funnelActionCheck.count()).toBe(0);
  });
});

describe("the funnel download", () => {
  it("holds the dates, the filter, the funnel, every segment and the product pages", async () => {
    const { u, ws, store } = await funnelStore();
    const res = await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${store.id}/export?section=funnel&${qs("&device=mobile")}`, headers: u.headers });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toContain(`funnel-${DAY}-to-${DAY}.csv`);
    const csv = res.body;
    expect(csv).toContain("2026-10-01 to 2026-10-01");
    expect(csv).toContain(`"Filter","Device: Mobile"`);
    expect(csv).toContain(`"Funnel","These dates",2,2,2,1,1,50`);
    expect(csv).toContain(`"Step to step","Added to cart → Started checkout",2,,,,,,1,50,50`);
    expect(csv).toContain(`"Device","Mobile",2,2,2,1,1,50`);
    expect(csv).toContain(`"Product","Linen Tee",,,,,,,,,,2,2,100,1,2,40`);
    expect(await systemDb.auditLog.findFirst({ where: { workspaceId: ws, action: "report.exported" } })).toMatchObject({ metadata: { section: "funnel", filter: { device: "mobile" } } });
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { encryptTokenFields, normalizeRestOrder, upsertOrder, type FetchLike } from "@app/core";
import { systemDb } from "@app/db";
import { localDay } from "@app/shared";
import { clean, createStore, createWorkspace, setup, signIn, teardown, type TestCtx } from "./helpers.js";

/**
 * The Inventory API end to end: who may see and change what (Team & Access), one merchant never
 * reaching another's stock, the overview's figures and the valuation against known stock, the
 * stock list's filters, the CSV, and stock changes sent to Shopify (confirmed only when Shopify
 * says so, once per idempotency key, refused when the stock moved meanwhile, one at a time).
 */

let ctx: TestCtx;
beforeAll(async () => (ctx = await setup()));
afterAll(async () => teardown(ctx));
beforeEach(async () => clean(ctx));

const SCOPES = ["read_orders", "read_products", "read_inventory", "read_locations", "write_inventory"];
type Headers = Record<string, string>;
const call = (method: string, url: string, headers: Headers = {}, payload?: unknown) => ctx.app.inject({ method, url, headers, payload });
function ok<T = any>(res: Awaited<ReturnType<typeof call>>, status = 200): T { // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(res.statusCode, res.body).toBe(status);
  return res.json();
}

let users = 0;
/** A signed-in member of `ws` with `role` and `permissions`. */
async function member(ws: string, role: "viewer" | "custom" | "manager", permissions: string[]) {
  const n = ++users;
  const m = await signIn(ctx, `member-${n}`, `member${n}@example.com`);
  await systemDb.membership.create({ data: { workspaceId: ws, userId: m.user.id, role, permissions } });
  return m;
}

/**
 * A store with two locations and four variants:
 *  - 11 (Classic Tee / M): 50 available at the Warehouse (3 committed, 10 incoming), 7 at the Shop;
 *  - 12 (Classic Tee / L): out of stock (0 available, 2 damaged);
 *  - 21 (Canvas Tote): 4 available, so low (the store's threshold is 10); no cost recorded;
 *  - 31 (Gift wrap): Shopify doesn't track its stock.
 */
async function business(name = "Acme", scopes = SCOPES) {
  const owner = await signIn(ctx, `owner-${name}`, `owner@${name.toLowerCase()}.test`);
  const ws = await createWorkspace(ctx, owner.headers, name);
  const store = await createStore(ws, `${name.toLowerCase()}.myshopify.com`, scopes, { timezone: "Australia/Melbourne", currency: "AUD" });
  await systemDb.store.update({ where: { id: store.id }, data: encryptTokenFields(store.id, { accessToken: "shpat_test", scopes, accessTokenExpiresAt: null, refreshToken: null, refreshTokenExpiresAt: null }) });
  const p = (shopifyId: string, title: string, extra: Record<string, unknown> = {}) =>
    systemDb.product.create({ data: { workspaceId: ws, storeId: store.id, shopifyId, title, status: "active", vendor: "Acme Co", productType: "Apparel", shopifyUpdatedAt: new Date(), ...extra } });
  await p("1", "Classic Tee", { collections: [{ id: "77", title: "Summer" }], tags: ["cotton"], description: "Soft cotton." });
  await p("2", "Canvas Tote", { vendor: "Bagco", productType: "Bags" });
  await p("3", "Gift wrap");
  await p("4", "Old hat", { status: "archived" });
  const v = (shopifyId: string, product: string, title: string, extra: Record<string, unknown> = {}) =>
    systemDb.productVariant.create({
      data: { workspaceId: ws, storeId: store.id, productShopifyId: product, shopifyId, title, sku: `SKU-${shopifyId}`, barcode: `BAR${shopifyId}`, price: 30, unitCost: 12, inventoryQuantity: 0, inventoryItemId: `9${shopifyId}`, shopifyUpdatedAt: new Date(), ...extra },
    });
  await v("11", "1", "M", { inventoryQuantity: 57, options: [{ name: "Size", value: "M" }], position: 1 });
  await v("12", "1", "L", { inventoryQuantity: 0, options: [{ name: "Size", value: "L" }], position: 2 });
  await v("21", "2", "Default Title", { inventoryQuantity: 4, unitCost: null, price: 15 });
  await v("31", "3", "Default Title", { inventoryQuantity: null, price: 2 });
  await v("41", "4", "Default Title", { inventoryQuantity: 9 }); // archived: left out everywhere
  const loc = (shopifyId: string, nameL: string) =>
    systemDb.inventoryLocation.create({ data: { workspaceId: ws, storeId: store.id, shopifyId, name: nameL, isActive: true, syncedAt: new Date(), formattedAddress: `${nameL} St` } });
  await loc("100", "Warehouse");
  await loc("200", "Shop");
  const now = new Date();
  const lvl = (item: string, location: string, q: Partial<Record<"available" | "onHand" | "committed" | "incoming" | "damaged", number>>) =>
    systemDb.inventoryLevel.create({
      data: {
        workspaceId: ws,
        storeId: store.id,
        inventoryItemId: item,
        locationShopifyId: location,
        available: q.available ?? 0,
        onHand: q.onHand ?? (q.available ?? 0) + (q.committed ?? 0) + (q.damaged ?? 0),
        committed: q.committed ?? 0,
        incoming: q.incoming ?? 0,
        reserved: 0,
        damaged: q.damaged ?? 0,
        safetyStock: 0,
        qualityControl: 0,
        shopifyUpdatedAt: new Date(now.getTime() - 3600_000),
        syncedAt: now,
      },
    });
  await lvl("911", "100", { available: 50, committed: 3, incoming: 10 });
  await lvl("911", "200", { available: 7 });
  await lvl("912", "100", { available: 0, damaged: 2 });
  await lvl("921", "100", { available: 4 });
  await lvl("931", "100", { available: 5 });
  await lvl("941", "100", { available: 9 });
  await systemDb.inventorySyncRun.create({ data: { workspaceId: ws, storeId: store.id, trigger: "import", status: "succeeded", startedAt: now, finishedAt: now, locations: 2, levelsChecked: 6 } });
  return { owner, ws, store, base: `/workspaces/${ws}/stores/${store.id}/inventory` };
}

async function sale(store: { id: string; workspaceId: string; timezone: string }, id: number, variant: string, quantity: number, createdAt = new Date()) {
  await upsertOrder(
    store,
    normalizeRestOrder({
      id,
      name: `#${id}`,
      currency: "AUD",
      created_at: createdAt.toISOString(),
      updated_at: createdAt.toISOString(),
      subtotal_price: "30",
      total_discounts: "0",
      total_tax: "0",
      total_price: "30",
      financial_status: "paid",
      line_items: [{ id: id * 10, product_id: 1, variant_id: Number(variant), title: "Tee", quantity, price: "30" }],
    }),
  );
}

describe("what the overview and the stock list show", () => {
  it("adds up stock once per item and location, tracked items only, and values it from recorded costs", async () => {
    const b = await business();
    await sale(b.store, 1, "11", 3);
    const o = ok(await call("GET", `${b.base}/overview?preset=30d`, b.owner.headers));
    expect(o.source).toBe("levels");
    expect(o.kpis.products.value).toBe(3); // the archived product is left out
    expect(o.kpis.variants.value).toBe(4);
    // 50 + 7 + 0 + 4 available; on hand 53 + 7 + 2 + 4; the untracked gift wrap counted on its own.
    expect(o.kpis.available.value).toBe(61);
    expect(o.kpis.onHand.value).toBe(66);
    expect(o.kpis.committed.value).toBe(3);
    expect(o.kpis.incoming.value).toBe(10);
    expect(o.untracked).toEqual({ variants: 1, onHand: 5 });
    expect(o.kpis.outOfStock.value).toBe(1);
    expect(o.kpis.lowStock.value).toBe(1);
    // Cost value only where a cost is recorded (the tote has none): 62 units of the tee at 12.
    expect(o.kpis.costValue).toMatchObject({ value: 744, complete: false });
    expect(o.kpis.costValue.note).toContain("1 of 3");
    // Retail: on hand × price, the tote included: 62 × 30 + 4 × 15.
    expect(o.kpis.retailValue.value).toBe(1920);
    expect(o.kpis.unitsToday.value).toBe(3);
    // A day's orders aren't enough history to forecast from.
    expect(o.kpis.daysOfStock.value).toBeNull();
    expect(o.kpis.turnover.value).toBeNull();
    expect(o.outOfStock.rows.map((r: { variantId: string }) => r.variantId)).toEqual(["12"]);
    expect(o.lowStock.rows.map((r: { variantId: string }) => r.variantId)).toEqual(["21"]);
  });

  it("shows one location's stock when filtered, and the storewide total otherwise", async () => {
    const b = await business();
    const all = ok(await call("GET", `${b.base}/stock?sort=product`, b.owner.headers));
    const tee = all.rows.find((r: { variantId: string }) => r.variantId === "11");
    expect(tee).toMatchObject({ available: 57, onHand: 60, committed: 3, incoming: 10, locations: 2, status: "in_stock", sku: "SKU-11" });
    const shop = ok(await call("GET", `${b.base}/stock?location=200`, b.owner.headers));
    // Only what is stocked at the Shop, with the Shop's numbers.
    expect(shop.rows.map((r: { variantId: string; available: number }) => [r.variantId, r.available])).toEqual([["11", 7]]);
    expect(shop.location).toBe("200");
  });

  it("searches names, SKUs and barcodes in part, and filters by status, vendor and collection", async () => {
    const b = await business();
    const ids = async (qs: string) => ok(await call("GET", `${b.base}/stock?${qs}`, b.owner.headers)).rows.map((r: { variantId: string }) => r.variantId).sort();
    expect(await ids("q=class")).toEqual(["11", "12"]);
    expect(await ids("q=sku-2")).toEqual(["21"]);
    expect(await ids("q=BAR12")).toEqual(["12"]);
    expect(await ids("status=out")).toEqual(["12"]);
    expect(await ids("status=untracked")).toEqual(["31"]);
    expect(await ids("vendor=Bagco")).toEqual(["21"]);
    expect(await ids("collection=77")).toEqual(["11", "12"]);
    expect(await ids("q=100%25")).toEqual([]); // a literal %, not a wildcard
    const page = ok(await call("GET", `${b.base}/stock?pageSize=10&page=1&sort=available&dir=desc`, b.owner.headers));
    expect(page.total).toBe(4);
    expect(page.rows[0].variantId).toBe("11");
  });

  it("a variant's own threshold decides its status, and changing it moves its alert", async () => {
    const b = await business();
    ok(await call("PUT", `${b.base}/thresholds`, b.owner.headers, { target: "variant", id: "11", threshold: 60 }));
    const tee = ok(await call("GET", `${b.base}/stock?q=SKU-11`, b.owner.headers)).rows[0];
    expect(tee).toMatchObject({ status: "low", threshold: 60 });
    expect(await systemDb.inventoryAlert.count({ where: { storeId: b.store.id, variantShopifyId: "11", kind: "low_stock", resolvedAt: null } })).toBe(1);
    ok(await call("PUT", `${b.base}/thresholds`, b.owner.headers, { target: "variant", id: "11", threshold: null }));
    expect(await systemDb.inventoryAlert.count({ where: { storeId: b.store.id, variantShopifyId: "11", resolvedAt: null } })).toBe(0);
  });

  it("a product's panel: information, variants, stock per location, sales", async () => {
    const b = await business();
    await sale(b.store, 1, "11", 2);
    const d = ok(await call("GET", `${b.base}/products/1`, b.owner.headers));
    expect(d.product).toMatchObject({ title: "Classic Tee", vendor: "Acme Co", tags: ["cotton"], description: "Soft cotton.", collections: [{ id: "77", title: "Summer" }] });
    expect(d.product.adminUrl).toBe("https://admin.shopify.com/store/acme/products/1");
    expect(d.variants.map((v: { id: string; options: unknown }) => [v.id, v.options])).toEqual([
      ["11", [{ name: "Size", value: "M" }]],
      ["12", [{ name: "Size", value: "L" }]],
    ]);
    const m = d.variants[0];
    expect(m.levels.map((l: { locationName: string; available: number }) => [l.locationName, l.available])).toEqual([
      ["Shop", 7],
      ["Warehouse", 50],
    ]);
    expect(m.sales.units30).toBe(2);
    expect(d.sales.units30).toBe(2);
  });

  it("the trend shows recorded days only: nothing is reconstructed for days without a record", async () => {
    const b = await business();
    const today = localDay(new Date(), b.store.timezone);
    await systemDb.inventorySnapshot.create({
      data: { workspaceId: b.ws, storeId: b.store.id, day: today, locationKey: "all", trackedVariants: 3, untrackedVariants: 1, available: 61, onHand: 66, committed: 3, incoming: 10, lowStock: 1, outOfStock: 1, costValue: 744, variantsWithCost: 2, variantsInStock: 3, retailValue: 1920, takenAt: new Date() },
    });
    const r = ok(await call("GET", `${b.base}/reports?preset=7d`, b.owner.headers));
    expect(r.recordedDays).toBe(1);
    const last = r.trend.at(-1);
    expect(last).toMatchObject({ day: today, recorded: true, available: 61 });
    expect(r.trend.slice(0, -1).every((d: { recorded: boolean; available: number | null }) => !d.recorded && d.available === null)).toBe(true);
    expect(r.unitsByFulfillmentLocation).toBeNull();
  });
});

describe("Team & Access", () => {
  it("needs inventory.view; without it nothing of the stock is reachable", async () => {
    const b = await business();
    const m = await member(b.ws, "viewer", ["analytics.sales"]);
    for (const path of ["/status", "/overview", "/stock", "/locations", "/reports", "/products/1", "/alerts"]) {
      expect((await call("GET", `${b.base}${path}`, m.headers)).statusCode, path).toBe(403);
    }
  });

  it("costs and stock values are left out without inventory.costs, in the API and the CSV", async () => {
    const b = await business();
    const m = await member(b.ws, "custom", ["inventory.view", "inventory.export"]);
    const o = ok(await call("GET", `${b.base}/overview`, m.headers));
    expect(o.kpis.costValue).toBeNull();
    expect(o.kpis.retailValue).toBeNull();
    expect(o.kpis.turnover).toBeNull();
    const row = ok(await call("GET", `${b.base}/stock?q=SKU-11`, m.headers)).rows[0];
    expect(row.unitCost).toBeUndefined();
    expect(row.stockValue).toBeUndefined();
    const csv = await call("GET", `${b.base}/stock/export`, m.headers);
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.body).not.toContain("Cost per item");
    // With inventory.costs too, the CSV carries them.
    const full = await member(b.ws, "custom", ["inventory.view", "inventory.export", "inventory.costs"]);
    const csv2 = (await call("GET", `${b.base}/stock/export?status=out`, full.headers)).body;
    expect(csv2).toContain("Cost per item");
    // Only the rows the filter matches, as on screen.
    expect(csv2.trim().split("\r\n")).toHaveLength(2);
    expect(csv2).toContain('"Classic Tee","L","SKU-12","BAR12","All locations","Out of stock",0,2,0,0,2,10,30,12,24,0,,');
  });

  it("exporting, the history, changing stock and the settings each need their own permission", async () => {
    const b = await business();
    const m = await member(b.ws, "custom", ["inventory.view"]);
    expect((await call("GET", `${b.base}/stock/export`, m.headers)).statusCode).toBe(403);
    expect((await call("GET", `${b.base}/movements`, m.headers)).statusCode).toBe(403);
    expect((await call("GET", `${b.base}/adjustments`, m.headers)).statusCode).toBe(403);
    expect((await call("POST", `${b.base}/adjustments`, m.headers, adjustment())).statusCode).toBe(403);
    expect((await call("PUT", `${b.base}/settings`, m.headers, { reconcileHours: 2, leadTimeDays: 7, coverDays: 30 })).statusCode).toBe(403);
    expect((await call("PUT", `${b.base}/settings/alerts`, m.headers, { lowStockThreshold: 3, emailAlerts: true, dashboardAlerts: true, whatsappAlerts: false, whatsappTemplate: null })).statusCode).toBe(403);
    expect((await call("PUT", `${b.base}/thresholds`, m.headers, { target: "variant", id: "11", threshold: 1 })).statusCode).toBe(403);
    // Without product information, the panel leaves out descriptions, tags and the rest.
    const d = ok(await call("GET", `${b.base}/products/1`, m.headers));
    expect(d.product.description).toBeNull();
    expect(d.product.tags).toEqual([]);
    expect(d.history).toBeNull();
    // What the pages are told they may do.
    expect(ok(await call("GET", `${b.base}/status`, m.headers)).can).toEqual({ products: false, costs: false, history: false, export: false, adjust: false, alerts: false, settings: false, connect: false });
  });

  it("one merchant never reaches another's stock", async () => {
    const a = await business("Acme");
    const other = await business("Other");
    // Another workspace's owner, with every permission in their own: this workspace isn't there for them.
    expect((await call("GET", `${a.base}/stock`, other.owner.headers)).statusCode).toBe(404);
    expect((await call("POST", `${a.base}/adjustments`, other.owner.headers, adjustment())).statusCode).toBe(404);
    expect(await systemDb.inventoryAdjustment.count()).toBe(0);
    // Their own store id under this workspace: not found.
    expect((await call("GET", `/workspaces/${a.ws}/stores/${other.store.id}/inventory/stock`, a.owner.headers)).statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------- stock changes

let keys = 0;
const adjustment = (over: Record<string, unknown> = {}) => ({
  idempotencyKey: `key-${String(++keys).padStart(16, "0")}`,
  variantId: "11",
  locationId: "100",
  kind: "increase",
  quantity: 5,
  expected: 50,
  reason: "received",
  note: "PO 1234",
  referenceId: "PO-1234",
  ...over,
});

/**
 * Shopify's side of a stock change: the mutation's answer (`answer`), then the level read back.
 * Records each call's operation and variables.
 */
function shopify(answer: (vars: Record<string, any>) => unknown, levelAfter: { available: number; onHand?: number; damaged?: number } | null) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const calls: Array<{ op: string; vars: Record<string, any> }> = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  ctx.setFetch(async (_u, init) => {
    const { query, variables } = JSON.parse(String(init?.body));
    const op = /(?:query|mutation)\s+(\w+)/.exec(query)![1]!;
    calls.push({ op, vars: variables });
    const send = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (op === "InventoryItemLevel") {
      const l = levelAfter;
      return send({
        data: {
          inventoryItem: {
            id: variables.item,
            tracked: true,
            inventoryLevel: l
              ? {
                  updatedAt: new Date().toISOString(),
                  quantities: [
                    { name: "available", quantity: l.available },
                    { name: "on_hand", quantity: l.onHand ?? l.available + 3 + (l.damaged ?? 0) },
                    { name: "committed", quantity: 3 },
                    { name: "incoming", quantity: 10 },
                    { name: "damaged", quantity: l.damaged ?? 0 },
                  ],
                }
              : null,
          },
        },
      });
    }
    const a = answer(variables);
    if (a instanceof Response) return a;
    return send({ data: a });
  });
  return calls;
}
const confirmed = (field: string) => () => ({ [field]: { inventoryAdjustmentGroup: { id: "gid://shopify/InventoryAdjustmentGroup/1", createdAt: new Date().toISOString(), reason: "received", changes: [] }, userErrors: [] } });

describe("changing stock", () => {
  it("is shown as done only once Shopify confirms, and the level is read back from Shopify", async () => {
    const b = await business();
    const calls = shopify(confirmed("inventoryAdjustQuantities"), { available: 55 });
    const body = adjustment();
    const r = ok(await call("POST", `${b.base}/adjustments`, b.owner.headers, body));
    expect(r.adjustment).toMatchObject({ status: "confirmed", kind: "increase", delta: 5, expectedBefore: 50, resultQuantity: 55, reason: "received", note: "PO 1234", referenceId: "PO-1234", locationName: "Warehouse" });
    // What Shopify was asked: the delta on available, compared with what the person saw, with the key.
    const m = calls.find((c) => c.op === "InventoryAdjust")!;
    expect(m.vars.key).toBe(body.idempotencyKey);
    expect(m.vars.input).toMatchObject({ name: "available", reason: "received", changes: [{ inventoryItemId: "gid://shopify/InventoryItem/911", locationId: "gid://shopify/Location/100", delta: 5, changeFromQuantity: 50 }] });
    expect(m.vars.input.referenceDocumentUri).toMatch(/^gid:\/\/bizinsights\/InventoryAdjustment\//);
    // The stored level is Shopify's answer, and the change is in the history as made here.
    const level = await systemDb.inventoryLevel.findFirstOrThrow({ where: { storeId: b.store.id, inventoryItemId: "911", locationShopifyId: "100" } });
    expect(level.available).toBe(55);
    const move = await systemDb.inventoryMovement.findFirstOrThrow({ where: { storeId: b.store.id, quantityName: "available" } });
    expect(move).toMatchObject({ before: 50, after: 55, delta: 5, source: "adjustment", adjustmentId: r.adjustment.id });
    const history = ok(await call("GET", `${b.base}/movements`, b.owner.headers));
    expect(history.rows[0]).toMatchObject({ kind: "confirmed", delta: 5, adjustment: { reason: "received", by: "owner@acme.test" } });
    expect(await systemDb.auditLog.count({ where: { workspaceId: b.ws, action: "inventory.adjusted" } })).toBe(1);
  });

  it("the same request again (the same key) changes nothing more and answers the same", async () => {
    const b = await business();
    const calls = shopify(confirmed("inventoryAdjustQuantities"), { available: 55 });
    const body = adjustment();
    const first = ok(await call("POST", `${b.base}/adjustments`, b.owner.headers, body));
    const again = ok(await call("POST", `${b.base}/adjustments`, b.owner.headers, body));
    expect(again.adjustment.id).toBe(first.adjustment.id);
    expect(calls.filter((c) => c.op === "InventoryAdjust")).toHaveLength(1);
    // A different change under the same key is refused.
    expect((await call("POST", `${b.base}/adjustments`, b.owner.headers, { ...body, quantity: 9 })).statusCode).toBe(409);
  });

  it("refused when the stock moved since the person looked; they get the new number", async () => {
    const b = await business();
    shopify(() => ({ inventoryAdjustQuantities: { inventoryAdjustmentGroup: null, userErrors: [{ field: ["input"], message: "The specified compare quantity does not match", code: "CHANGE_FROM_QUANTITY_STALE" }] } }), { available: 48 });
    const res = await call("POST", `${b.base}/adjustments`, b.owner.headers, adjustment());
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "stock_changed", detail: { current: 48 } });
    const row = await systemDb.inventoryAdjustment.findFirstOrThrow({ where: { storeId: b.store.id } });
    expect(row).toMatchObject({ status: "failed", errorCode: "stock_changed" });
    // Nothing recorded as changed by us; the stored level is Shopify's current one.
    expect(await systemDb.inventoryMovement.count({ where: { storeId: b.store.id, source: "adjustment" } })).toBe(0);
    expect((await systemDb.inventoryLevel.findFirstOrThrow({ where: { storeId: b.store.id, inventoryItemId: "911", locationShopifyId: "100" } })).available).toBe(48);
  });

  it("Shopify refusing for another reason: nothing changes, and Shopify's own words stay in the logs", async () => {
    const b = await business();
    shopify(() => ({ inventoryAdjustQuantities: { inventoryAdjustmentGroup: null, userErrors: [{ field: ["input"], message: "Internal detail 0xdead", code: "SOMETHING_ELSE" }] } }), null);
    const res = await call("POST", `${b.base}/adjustments`, b.owner.headers, adjustment());
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("shopify_refused");
    expect(res.body).not.toContain("0xdead");
    expect((await systemDb.inventoryLevel.findFirstOrThrow({ where: { storeId: b.store.id, inventoryItemId: "911", locationShopifyId: "100" } })).available).toBe(50);
  });

  it("an answer that never came is 'unconfirmed'; retrying with the same key completes it once", async () => {
    const b = await business();
    let fail = true;
    const calls = shopify(() => (fail ? new Response("upstream", { status: 503 }) : confirmed("inventoryAdjustQuantities")()), { available: 55 });
    const body = adjustment();
    const res = await call("POST", `${b.base}/adjustments`, b.owner.headers, body);
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("unconfirmed");
    expect((await systemDb.inventoryAdjustment.findFirstOrThrow({ where: { storeId: b.store.id } })).status).toBe("unknown");
    expect((await systemDb.inventoryLevel.findFirstOrThrow({ where: { storeId: b.store.id, inventoryItemId: "911", locationShopifyId: "100" } })).available).toBe(50);
    fail = false;
    const r = ok(await call("POST", `${b.base}/adjustments`, b.owner.headers, body));
    expect(r.adjustment.status).toBe("confirmed");
    // Every attempt carried the same key, so Shopify applies it at most once.
    expect(new Set(calls.filter((c) => c.op === "InventoryAdjust").map((c) => c.vars.key))).toEqual(new Set([body.idempotencyKey]));
    expect(await systemDb.inventoryAdjustment.count({ where: { storeId: b.store.id } })).toBe(1);
  });

  it("two changes to the same stock at once: one waits its turn", async () => {
    const b = await business();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let n = 0;
    ctx.setFetch(async (_u, init) => {
      const { query, variables } = JSON.parse(String(init?.body));
      if (/InventoryItemLevel/.test(query)) {
        return new Response(JSON.stringify({ data: { inventoryItem: { id: variables.item, tracked: true, inventoryLevel: { updatedAt: new Date().toISOString(), quantities: [{ name: "available", quantity: 55 }] } } } }), { status: 200 });
      }
      n++;
      await gate;
      return new Response(JSON.stringify({ data: confirmed("inventoryAdjustQuantities")() }), { status: 200 });
    });
    const first = call("POST", `${b.base}/adjustments`, b.owner.headers, adjustment());
    await new Promise((r) => setTimeout(r, 200));
    const second = await call("POST", `${b.base}/adjustments`, b.owner.headers, adjustment());
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe("in_progress");
    release();
    expect((await first).statusCode).toBe(200);
    expect(n).toBe(1);
  });

  it("set, stocktake and damaged reach Shopify as the mutations for them", async () => {
    const b = await business();
    const calls = shopify((vars) => (vars.input.quantities ? confirmed("inventorySetQuantities")() : confirmed("inventoryMoveQuantities")()), { available: 40, damaged: 2 });
    ok(await call("POST", `${b.base}/adjustments`, b.owner.headers, adjustment({ kind: "set", quantity: 40, reason: "correction" })));
    ok(await call("POST", `${b.base}/adjustments`, b.owner.headers, adjustment({ kind: "stocktake", quantity: 45, expected: 53, reason: "cycle_count_available" })));
    ok(await call("POST", `${b.base}/adjustments`, b.owner.headers, adjustment({ kind: "damaged", quantity: 2, expected: 40, reason: "damaged" })));
    const [set, count, move] = calls.filter((c) => c.op !== "InventoryItemLevel");
    expect(set!.vars.input).toMatchObject({ name: "available", quantities: [{ quantity: 40, changeFromQuantity: 50 }] });
    expect(count!.vars.input).toMatchObject({ name: "on_hand", reason: "cycle_count_available", quantities: [{ quantity: 45, changeFromQuantity: 53 }] });
    expect(move!.vars.input.changes[0]).toMatchObject({ quantity: 2, from: { name: "available", changeFromQuantity: 40 }, to: { name: "damaged" } });
    expect(move!.vars.input.changes[0].to.ledgerDocumentUri).toMatch(/^gid:\/\/bizinsights\//);
  });

  it("is refused before asking Shopify: no permission from Shopify, an untracked item, a bad reason", async () => {
    const b = await business("Acme", ["read_orders", "read_products", "read_inventory", "read_locations"]);
    ctx.setFetch(async () => {
      throw new Error("Shopify must not be asked");
    });
    const r1 = await call("POST", `${b.base}/adjustments`, b.owner.headers, adjustment());
    expect(r1.statusCode).toBe(409);
    expect(r1.json().error).toBe("scope_missing");
    const c = await business("Beta");
    expect((await call("POST", `${c.base}/adjustments`, c.owner.headers, adjustment({ variantId: "31" }))).json().error).toBe("untracked");
    expect((await call("POST", `${c.base}/adjustments`, c.owner.headers, adjustment({ reason: "promotion" }))).statusCode).toBe(400);
    expect((await call("POST", `${c.base}/adjustments`, c.owner.headers, adjustment({ quantity: 0 }))).statusCode).toBe(400);
  });

  it("a settled change can't be edited afterwards, even by the database's owner", async () => {
    const b = await business();
    shopify(confirmed("inventoryAdjustQuantities"), { available: 55 });
    const r = ok(await call("POST", `${b.base}/adjustments`, b.owner.headers, adjustment()));
    await expect(systemDb.inventoryAdjustment.update({ where: { id: r.adjustment.id }, data: { note: "changed" } })).rejects.toThrow();
    await expect(systemDb.inventoryAdjustment.update({ where: { id: r.adjustment.id }, data: { status: "failed" } })).rejects.toThrow();
  });
});

describe("settings", () => {
  it("saves thresholds and alert channels (numbers never shown in full) and the check's schedule", async () => {
    const b = await business();
    const s = ok(await call("PUT", `${b.base}/settings/alerts`, b.owner.headers, { lowStockThreshold: 3, emailAlerts: false, dashboardAlerts: true, whatsappAlerts: false, whatsappTemplate: null, whatsappTo: ["+61400111222"] })).settings;
    expect(s).toMatchObject({ lowStockThreshold: 3, emailAlerts: false, whatsappTo: ["+61••••222"] });
    expect(JSON.stringify(await systemDb.inventorySettings.findUniqueOrThrow({ where: { storeId: b.store.id } }))).not.toContain("400111222");
    // The tote (4 available) is no longer low at a threshold of 3.
    const tote = ok(await call("GET", `${b.base}/stock?q=SKU-21`, b.owner.headers)).rows[0];
    expect(tote.status).toBe("in_stock");
    const t = ok(await call("PUT", `${b.base}/settings`, b.owner.headers, { reconcileHours: 2, leadTimeDays: 7, coverDays: 21 })).settings;
    expect(t).toMatchObject({ reconcileHours: 2, leadTimeDays: 7, coverDays: 21, lowStockThreshold: 3, whatsappTo: ["+61••••222"] });
    expect((await call("PUT", `${b.base}/settings`, b.owner.headers, { reconcileHours: 0, leadTimeDays: 7, coverDays: 21 })).statusCode).toBe(400);
  });

  it("refresh starts one pass at a time and needs stock-level access", async () => {
    const b = await business();
    expect(ok(await call("POST", `${b.base}/sync`, b.owner.headers), 202)).toMatchObject({ started: true });
    expect(ctx.deps.queues.sent.sync.at(-1)).toMatchObject({ kind: "inventory", inventory: { trigger: "manual", phase: "locations" } });
    expect((await call("POST", `${b.base}/sync`, b.owner.headers)).statusCode).toBe(429);
    const c = await business("Beta", ["read_orders", "read_products"]);
    expect((await call("POST", `${c.base}/sync`, c.owner.headers)).statusCode).toBe(409);
  });
});

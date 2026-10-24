import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { disconnectDb, systemDb, toNumber } from "@app/db";
import { resetDb } from "@app/db/testing";
import { encryptTokenFields, memoryBlobs, memoryCoord, memoryMailer, memoryQueues, type FetchLike } from "@app/core";
import { processWebhook, runSync, type WorkerDeps } from "../src/handlers.js";
import { consume } from "../src/index.js";
import { salesAnswer } from "./shopifySales.js";

/**
 * Shopify data that doesn't fit the schemas in core's shopifyPayloads.ts. It is logged and skipped:
 * never stored half-read, and never failing the job, since a retry would only meet the same
 * payload again. Before the schemas, an unreadable date threw on every attempt, a missing id was
 * stored as "undefined", and a variant without its product failed the whole page.
 */

const queues = memoryQueues();
const coord = memoryCoord();
let fetchImpl: FetchLike;
let deps: WorkerDeps;
let warnings: Array<Record<string, unknown>>;
let prevLevel: string | undefined;

beforeAll(() => {
  deps = { coord, queues, payloads: memoryBlobs(), mailer: memoryMailer(), fetchImpl: ((...a: Parameters<FetchLike>) => fetchImpl(...a)) as FetchLike };
});
afterAll(async () => disconnectDb());
beforeEach(async () => {
  await resetDb();
  queues.clear();
  coord.clear();
  fetchImpl = async (url, init) => {
    const sales = salesAnswer(url, init);
    if (sales) return sales;
    throw new Error("unexpected fetch");
  };
  warnings = [];
  prevLevel = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = "warn";
  vi.spyOn(console, "warn").mockImplementation((line: unknown) => {
    if (String(line).startsWith("{")) warnings.push(JSON.parse(String(line)) as Record<string, unknown>);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  process.env.LOG_LEVEL = prevLevel;
});

async function makeStore() {
  const ws = await systemDb.workspace.create({ data: { name: "W" } });
  const store = await systemDb.store.create({
    data: { workspaceId: ws.id, shopDomain: "s.myshopify.com", grantedScopes: ["read_orders", "read_products"], status: "syncing", timezone: "UTC", pixelIngestKey: "pk-s" },
  });
  await systemDb.store.update({
    where: { id: store.id },
    data: encryptTokenFields(store.id, { accessToken: "shpat_x", scopes: ["read_orders", "read_products"], accessTokenExpiresAt: null, refreshToken: null, refreshTokenExpiresAt: null }),
  });
  return systemDb.store.findUniqueOrThrow({ where: { id: store.id } });
}

let seq = 0;
async function webhook(topic: string, payload: unknown) {
  const ev = await systemDb.webhookEvent.create({ data: { webhookId: `p${++seq}`, topic, shopDomain: "s.myshopify.com" } });
  const r = await processWebhook({ eventId: ev.id, topic, shop: "s.myshopify.com", payload }, deps);
  return { r, ev: await systemDb.webhookEvent.findUniqueOrThrow({ where: { id: ev.id } }) };
}

/** The fields the schema warnings named. */
const problems = () => warnings.flatMap((w) => (w.problems as string[] | undefined) ?? []);

const order = (over: Record<string, unknown> = {}) => ({
  id: 1001,
  name: "#1001",
  currency: "USD",
  created_at: "2026-03-01T15:00:00Z",
  updated_at: "2026-03-01T15:00:00Z",
  total_price: "90.00",
  subtotal_price: "90.00",
  customer: { id: 7, email: "pii@example.com" },
  line_items: [{ id: 1, product_id: 50, title: "Tee", quantity: 2, price: "45.00" }],
  ...over,
});

const restProduct = (over: Record<string, unknown> = {}) => ({
  id: 8,
  title: "Tee",
  status: "active",
  updated_at: "2026-03-02T00:00:00Z",
  variants: [
    { id: 70, product_id: 8, title: "M", sku: "TEE-M", price: "25.00", inventory_quantity: 3, updated_at: "2026-03-02T00:00:00Z" },
    { id: 71, product_id: 8, title: "L", sku: "TEE-L", price: "26.00", inventory_quantity: 1, updated_at: "2026-03-02T00:00:00Z" },
  ],
  ...over,
});

const money = (amount: string) => ({ shopMoney: { amount } });
const gqlOrder = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: "#1",
  createdAt: "2026-03-01T15:00:00Z",
  updatedAt: "2026-03-01T15:00:00Z",
  currencyCode: "USD",
  subtotalPriceSet: money("20"),
  totalDiscountsSet: money("0"),
  totalTaxSet: money("0"),
  totalShippingPriceSet: money("0"),
  totalPriceSet: money("20"),
  lineItems: { pageInfo: { hasNextPage: false }, nodes: [{ id: `${id.replace("Order", "LineItem")}1`, title: "X", quantity: 1, originalUnitPriceSet: money("20"), totalDiscountSet: money("0") }] },
  refunds: [],
  ...over,
});
const gqlJson = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
const page = (key: string, nodes: unknown[]) => gqlJson({ [key]: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } });

describe("webhooks that don't fit", () => {
  it("an order with an unreadable date is skipped, not retried, and nothing is stored", async () => {
    const store = await makeStore();
    const { r, ev } = await webhook("orders/create", order({ created_at: "Tuesday" }));
    expect(r).toEqual({ ok: true });
    expect(ev.status).toBe("succeeded");
    expect(await systemDb.order.count()).toBe(0);
    expect(queues.sent.aggregate).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ payload: "orders/create", storeId: store.id, eventId: ev.id });
    expect(problems()).toEqual(["created_at: not a timestamp"]);
    expect(JSON.stringify(warnings)).not.toContain("pii");
  });

  it("an order missing its id, or with a quantity that isn't a number, is not stored as garbage", async () => {
    await makeStore();
    await webhook("orders/updated", order({ id: undefined }));
    await webhook("orders/paid", order({ line_items: [{ id: 1, title: "Tee", quantity: "2 units", price: "45.00" }] }));
    expect(await systemDb.order.count()).toBe(0);
    expect(problems()).toEqual(["id: Invalid input: expected number, received undefined", "line_items.0.quantity: Invalid input: expected number, received string"]);
    // A good copy afterwards goes in as usual.
    await webhook("orders/updated", order());
    expect(await systemDb.order.count()).toBe(1);
    expect(toNumber((await systemDb.order.findFirstOrThrow()).totalPrice)).toBe(90);
  });

  it("a refund that doesn't name its order is skipped instead of retried as 'order not found'", async () => {
    await makeStore();
    await webhook("orders/create", order());
    const { r } = await webhook("refunds/create", { id: 9, created_at: "2026-03-05T12:00:00Z", refund_line_items: [{ subtotal: "45.00" }] });
    expect(r).toEqual({ ok: true });
    expect(await systemDb.orderSale.count()).toBe(1);
    expect(problems()).toEqual(["order_id: Invalid input: expected number, received undefined"]);
  });

  it("a product update with one malformed variant changes nothing, so no variant is pruned", async () => {
    await makeStore();
    await webhook("products/create", restProduct());
    expect(await systemDb.productVariant.count()).toBe(2);
    // Variant 71 is unreadable. Dropping just that one would leave 70 as the complete list and
    // prune 71 from the database: the whole payload is skipped instead.
    await webhook(
      "products/update",
      restProduct({ title: "Renamed", updated_at: "2026-03-03T00:00:00Z", variants: [{ id: 70, product_id: 8, price: "1.00" }, { id: 71, product_id: 8, price: { amount: "26.00" } }] }),
    );
    expect((await systemDb.product.findFirstOrThrow()).title).toBe("Tee");
    expect((await systemDb.productVariant.findMany({ orderBy: { shopifyId: "asc" } })).map((v) => [v.shopifyId, toNumber(v.price)])).toEqual([
      ["70", 25],
      ["71", 26],
    ]);
    expect(problems()).toEqual(["variants.1.price: Invalid input: expected string, received object"]);
  });

  it("products/delete without an id deletes nothing", async () => {
    await makeStore();
    await webhook("products/create", restProduct());
    const { r } = await webhook("products/delete", { admin_graphql_api_id: "gid://shopify/Product/8" });
    expect(r).toEqual({ ok: true });
    expect(await systemDb.product.count()).toBe(1);
  });
});

describe("sync pages with nodes that don't fit", () => {
  async function job(store: { id: string; workspaceId: string }, kind: string) {
    return systemDb.syncJob.create({ data: { workspaceId: store.workspaceId, storeId: store.id, kind } });
  }

  it("orders: the nodes that fit are stored and the job still succeeds", async () => {
    const store = await makeStore();
    const j = await job(store, "orders");
    fetchImpl = async () =>
      page("orders", [
        gqlOrder("gid://shopify/Order/1"),
        gqlOrder("gid://shopify/Order/"), // no id after the slash
        gqlOrder("gid://shopify/Order/3", { createdAt: null }),
        gqlOrder("gid://shopify/Order/4", { customerJourneySummary: { ready: "yes" } }), // only the visit is lost
      ]);
    await runSync({ storeId: store.id, kind: "orders", syncJobId: j.id, pagedOnly: true, sinceDays: 3 }, deps);
    const stored = await systemDb.order.findMany({ orderBy: { shopifyId: "asc" }, select: { shopifyId: true, trafficSource: true } });
    expect(stored).toEqual([
      { shopifyId: "1", trafficSource: null },
      { shopifyId: "4", trafficSource: null },
    ]);
    expect(await systemDb.syncJob.findUniqueOrThrow({ where: { id: j.id } })).toMatchObject({ status: "succeeded", progress: 2 });
    expect(warnings.map((w) => w.payload)).toEqual(["GraphQL order", "GraphQL customer journey"]);
    expect(warnings[0]).toMatchObject({ skipped: 2, of: 4, storeId: store.id });
  });

  it("variants: one without its product no longer fails the page", async () => {
    const store = await makeStore();
    const j = await job(store, "variants");
    const variant = (id: number, over: Record<string, unknown> = {}) => ({
      id: `gid://shopify/ProductVariant/${id}`,
      title: "M",
      sku: `SKU-${id}`,
      price: "25.00",
      inventoryQuantity: 4,
      updatedAt: "2026-03-01T00:00:00Z",
      product: { id: "gid://shopify/Product/8" },
      inventoryItem: { tracked: true, unitCost: { amount: "9.50" } },
      ...over,
    });
    fetchImpl = async () => page("productVariants", [variant(70), variant(71, { product: null })]);
    await runSync({ storeId: store.id, kind: "variants", syncJobId: j.id }, deps);
    expect((await systemDb.productVariant.findMany()).map((v) => v.shopifyId)).toEqual(["70"]);
    expect(await systemDb.syncJob.findUniqueOrThrow({ where: { id: j.id } })).toMatchObject({ status: "succeeded" });
    expect(problems()).toEqual(["product: Invalid input: expected object, received null"]);
  });

  it("products: one without updatedAt is skipped", async () => {
    const store = await makeStore();
    const j = await job(store, "products");
    const product = (id: number, over: Record<string, unknown> = {}) => ({ id: `gid://shopify/Product/${id}`, title: "Tee", status: "ACTIVE", updatedAt: "2026-03-01T00:00:00Z", ...over });
    fetchImpl = async () => page("products", [product(1, { updatedAt: undefined }), product(2)]);
    await runSync({ storeId: store.id, kind: "products", syncJobId: j.id }, deps);
    expect((await systemDb.product.findMany()).map((p) => p.shopifyId)).toEqual(["2"]);
    expect(problems()).toEqual(["updatedAt: Invalid input: expected string, received undefined"]);
  });

  it("bulk import: an order line that doesn't fit is skipped and the rest ingested", async () => {
    const store = await makeStore();
    const j = await job(store, "orders");
    const bulkId = "gid://shopify/BulkOperation/1";
    const lines = [
      { ...gqlOrder("gid://shopify/Order/1"), lineItems: undefined },
      { id: "gid://shopify/LineItem/11", title: "X", quantity: 1, originalUnitPriceSet: money("20"), totalDiscountSet: money("0"), __parentId: "gid://shopify/Order/1" },
      { ...gqlOrder("gid://shopify/Order/2", { createdAt: "not yet" }), lineItems: undefined },
      { id: "gid://shopify/LineItem/21", title: "X", quantity: 1, originalUnitPriceSet: money("20"), totalDiscountSet: money("0"), __parentId: "gid://shopify/Order/2" },
    ];
    const body = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
    fetchImpl = async (url) => {
      if (String(url).startsWith("https://files.example/")) return new Response(body, { status: 200 });
      return gqlJson({ node: { id: bulkId, status: "COMPLETED", objectCount: "4", url: "https://files.example/result.jsonl", partialDataUrl: null, createdAt: new Date().toISOString() } });
    };
    await runSync({ storeId: store.id, kind: "orders", syncJobId: j.id, bulk: { phase: "ingest", id: bulkId, byteOffset: 0 } }, deps);
    expect((await systemDb.order.findMany()).map((o) => o.shopifyId)).toEqual(["1"]);
    expect(await systemDb.orderLineItem.count()).toBe(1);
    expect(await systemDb.syncJob.findUniqueOrThrow({ where: { id: j.id } })).toMatchObject({ status: "succeeded", progress: 1 });
    expect(warnings[0]).toMatchObject({ payload: "bulk order", bulkId, skipped: 1, of: 2 });
    expect(problems()).toEqual(["createdAt: not a timestamp"]);
  });
});

describe("order detail pages and bulk lines that don't fit", () => {
  const line = (id: number, over: Record<string, unknown> = {}) => ({ id: `gid://shopify/LineItem/${id}`, title: "X", quantity: 1, originalUnitPriceSet: money("10"), totalDiscountSet: money("0"), ...over });

  it("an order whose extra line items don't fit is skipped, never stored with lines missing", async () => {
    const store = await makeStore();
    const j = await systemDb.syncJob.create({ data: { workspaceId: store.workspaceId, storeId: store.id, kind: "orders" } });
    fetchImpl = async (_url, init) => {
      const { query } = JSON.parse(String(init?.body)) as { query: string };
      if (query.includes("OrderLineItems")) {
        return gqlJson({ order: { lineItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [line(11), line(12, { quantity: "lots" })] } } });
      }
      return page("orders", [gqlOrder("gid://shopify/Order/1", { lineItems: { pageInfo: { hasNextPage: true }, nodes: [line(11)] } }), gqlOrder("gid://shopify/Order/2")]);
    };
    await runSync({ storeId: store.id, kind: "orders", syncJobId: j.id, pagedOnly: true, sinceDays: 3 }, deps);
    expect((await systemDb.order.findMany()).map((o) => o.shopifyId)).toEqual(["2"]);
    expect(await systemDb.syncJob.findUniqueOrThrow({ where: { id: j.id } })).toMatchObject({ status: "succeeded", progress: 1 });
    expect(warnings[0]).toMatchObject({ payload: "GraphQL order", storeId: store.id });
    expect(problems()).toEqual(["lineItems.nodes.1.quantity: Invalid input: expected number, received string"]);
  });

  it("bulk import: an unreadable sale, or a line that isn't an object, cost only that order", async () => {
    const store = await makeStore();
    const j = await systemDb.syncJob.create({ data: { workspaceId: store.workspaceId, storeId: store.id, kind: "orders" } });
    const bulkId = "gid://shopify/BulkOperation/2";
    const sale = (id: number, parent: string, over: Record<string, unknown> = {}) => ({
      id: `gid://shopify/Sale/${id}`,
      actionType: "ORDER",
      lineType: "PRODUCT",
      quantity: 1,
      totalAmount: money("10"),
      totalDiscountAmountBeforeTaxes: money("0"),
      totalTaxAmount: money("0"),
      __parentId: parent,
      ...over,
    });
    const body = [
      JSON.stringify({ ...gqlOrder("gid://shopify/Order/1"), lineItems: undefined, agreements: undefined }),
      JSON.stringify({ ...line(11), __parentId: "gid://shopify/Order/1" }),
      JSON.stringify({ id: "gid://shopify/SalesAgreement/1", happenedAt: "2026-03-01T15:00:00Z", __parentId: "gid://shopify/Order/1" }),
      JSON.stringify(sale(1, "gid://shopify/SalesAgreement/1", { quantity: "one" })),
      "null",
      JSON.stringify({ ...gqlOrder("gid://shopify/Order/3"), lineItems: undefined, agreements: undefined }),
      JSON.stringify({ ...line(31), __parentId: "gid://shopify/Order/3" }),
      JSON.stringify({ id: "gid://shopify/SalesAgreement/3", happenedAt: "2026-03-02T00:00:00Z", __parentId: "gid://shopify/Order/3" }),
      JSON.stringify(sale(3, "gid://shopify/SalesAgreement/3")),
    ].join("\n");
    fetchImpl = async (url) => {
      if (String(url).startsWith("https://files.example/")) return new Response(`${body}\n`, { status: 200 });
      return gqlJson({ node: { id: bulkId, status: "COMPLETED", objectCount: "5", url: "https://files.example/result.jsonl", partialDataUrl: null, createdAt: new Date().toISOString() } });
    };
    await runSync({ storeId: store.id, kind: "orders", syncJobId: j.id, bulk: { phase: "ingest", id: bulkId, byteOffset: 0 } }, deps);
    expect((await systemDb.order.findMany()).map((o) => o.shopifyId)).toEqual(["3"]);
    expect(await systemDb.orderLineItem.count()).toBe(1);
    expect(await systemDb.orderSale.count()).toBe(1);
    expect(await systemDb.syncJob.findUniqueOrThrow({ where: { id: j.id } })).toMatchObject({ status: "succeeded", progress: 1 });
    expect(warnings[0]).toMatchObject({ payload: "bulk order", skipped: 2, of: 3 });
    expect(problems()).toEqual(["agreements.nodes.0.sales.nodes.0.quantity: Invalid input: expected number, received string"]);
  });
});

describe("app and GDPR topics that don't fit", () => {
  /** Through the real queue consumer, as production runs it: what counts is what it records. */
  async function consumeWebhook(store: { id: string; workspaceId: string }, topic: string, payload: unknown) {
    const ev = await systemDb.webhookEvent.create({ data: { webhookId: `g${++seq}`, topic, shopDomain: "s.myshopify.com", storeId: store.id, workspaceId: store.workspaceId } });
    const outcome = { acked: false, retried: false };
    const msg = { id: ev.id, body: { eventId: ev.id, topic, shop: "s.myshopify.com", payload }, attempts: 1, ack: () => void (outcome.acked = true), retry: () => void (outcome.retried = true) };
    await consume("webhooks", msg, deps);
    return { ...outcome, ev: await systemDb.webhookEvent.findUniqueOrThrow({ where: { id: ev.id } }) };
  }

  async function storeWithCustomers() {
    const store = await makeStore();
    return systemDb.store.update({ where: { id: store.id }, data: { grantedScopes: ["read_orders", "read_products", "read_customers"] } });
  }

  it("a customers/redact that names nobody fails loudly: recorded as failed and alerted, never marked done", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const store = await storeWithCustomers();
    await webhook("orders/create", order());
    const r = await consumeWebhook(store, "customers/redact", { shop_domain: "s.myshopify.com", customer: {}, orders_to_redact: [] });
    // Final at once (no retries: they would read the same payload), and acknowledged.
    expect(r).toMatchObject({ acked: true, retried: false, ev: { status: "failed" } });
    expect(r.ev.error).toContain("customers/redact payload couldn't be read");
    expect(await systemDb.alert.findFirst({ where: { storeId: store.id, code: "webhook_failed" } })).toMatchObject({ message: expect.stringContaining("customers/redact") });
    expect(await systemDb.auditLog.count({ where: { action: "gdpr.customer_redacted" } })).toBe(0);
    expect(problems()).toEqual(["(payload): names no customer and no orders"]);
  });

  it("a customers/redact read only in part redacts nothing rather than half, and a readable copy then does it all", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const store = await storeWithCustomers();
    await webhook("orders/create", order());
    expect((await systemDb.order.findFirstOrThrow()).customerKey).not.toBeNull();
    const bad = await consumeWebhook(store, "customers/redact", { customer: { id: 7, email: "pii@example.com" }, orders_to_redact: "1001" });
    expect(bad.ev.status).toBe("failed");
    expect((await systemDb.order.findFirstOrThrow()).customerKey).not.toBeNull();
    expect(JSON.stringify(warnings)).not.toContain("pii");

    const good = await consumeWebhook(store, "customers/redact", { customer: { id: 7, email: "pii@example.com" }, orders_to_redact: [1001] });
    expect(good.ev.status).toBe("succeeded");
    expect((await systemDb.order.findFirstOrThrow()).customerKey).toBeNull();
    expect(await systemDb.auditLog.count({ where: { action: "gdpr.customer_redacted" } })).toBe(1);
  });

  it("a customers/data_request that can't be read fails loudly too", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const store = await makeStore();
    const r = await consumeWebhook(store, "customers/data_request", { customer: { id: { nested: 7 } }, orders_requested: [1] });
    expect(r).toMatchObject({ acked: true, retried: false, ev: { status: "failed" } });
    expect(await systemDb.auditLog.count({ where: { action: "gdpr.customer_data_request" } })).toBe(0);
    expect(problems()).toEqual(["customer.id: Invalid input: expected number, received object"]);
  });

  it("app/scopes_update without `current` keeps the store's scopes instead of revoking them all", async () => {
    const store = await makeStore();
    const { r, ev } = await webhook("app/scopes_update", { previous: ["read_orders"] });
    expect(r).toEqual({ ok: true });
    expect(ev.status).toBe("succeeded");
    expect((await systemDb.store.findUniqueOrThrow({ where: { id: store.id } })).grantedScopes).toEqual(["read_orders", "read_products"]);
    expect(problems()).toEqual(["current: Invalid input: expected array, received undefined"]);
    // A readable one still applies.
    await webhook("app/scopes_update", { current: ["read_orders"] });
    expect((await systemDb.store.findUniqueOrThrow({ where: { id: store.id } })).grantedScopes).toEqual(["read_orders"]);
  });

  it("app_subscriptions/update without the charge is skipped with a warning", async () => {
    await makeStore();
    const { r, ev } = await webhook("app_subscriptions/update", { app_subscription: { status: "ACTIVE" } });
    expect(r).toEqual({ ok: true });
    expect(ev.status).toBe("succeeded");
    expect(problems()).toEqual(["app_subscription.admin_graphql_api_id: Invalid input: expected string, received undefined"]);
  });
});

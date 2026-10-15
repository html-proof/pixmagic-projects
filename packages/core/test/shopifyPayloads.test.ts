import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import {
  graphqlOrderSchema,
  graphqlProductSchema,
  graphqlVariantSchema,
  normalizeGraphqlOrder,
  normalizeGraphqlProduct,
  normalizeGraphqlVariant,
  normalizeRestOrder,
  normalizeRestProduct,
  normalizeRestProductVariants,
  normalizeRestRefund,
  parseShopify,
  parseShopifyList,
  restOrderSchema,
  restProductDeleteSchema,
  restProductSchema,
  restRefundWebhookSchema,
} from "../src/index.js";

/**
 * The boundary in front of the normalizers: what Shopify really sends passes unchanged, and what
 * doesn't fit is skipped with one warning that names the fields, never their values.
 */

let warnings: Array<Record<string, unknown>>;
let prevLevel: string | undefined;
beforeEach(() => {
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

const m = (amount: string) => ({ shopMoney: { amount } });

const restOrder = (over: Record<string, unknown> = {}) => ({
  id: 820982911946154500,
  name: "#1001",
  currency: "AUD",
  created_at: "2026-03-01T10:00:00+11:00",
  updated_at: "2026-03-01T10:05:00+11:00",
  cancelled_at: null,
  financial_status: "paid",
  fulfillment_status: "partial",
  source_name: "web",
  landing_site: "/?utm_source=facebook&utm_medium=cpc",
  referring_site: "https://m.facebook.com/",
  subtotal_price: "90.00",
  total_discounts: "10.00",
  total_tax: "9.00",
  total_price: "104.00",
  total_shipping_price_set: { shop_money: { amount: "5.00", currency_code: "AUD" } },
  customer: { id: 77, email: "secret@example.com", orders_count: 3 },
  fulfillments: [{ created_at: "2026-03-04T00:00:00Z" }, { created_at: "2026-03-02T00:00:00Z" }],
  discount_codes: [{ code: " WELCOME ", amount: "5.00", type: "fixed_amount" }],
  line_items: [
    { id: 1, product_id: 5, variant_id: 6, sku: " TEE-M ", title: "Tee", quantity: 2, price: "50.00", discount_allocations: [{ amount: "10.00" }] },
    { id: 2, product_id: null, variant_id: null, sku: null, title: "Custom", quantity: 1, price: "4.00", total_discount: "0.00" },
  ],
  refunds: [{ id: 9, created_at: "2026-03-02T00:00:00Z", refund_line_items: [{ subtotal: 25 }] }],
  ...over,
});

const restProduct = (over: Record<string, unknown> = {}) => ({
  id: 8,
  title: "Tee",
  status: "active",
  vendor: " Acme ",
  product_type: "Shirts",
  created_at: "2025-01-01T00:00:00Z",
  updated_at: "2026-02-01T00:00:00Z",
  variants: [
    { id: 70, product_id: 8, title: "M", sku: "TEE-M", price: "25.00", inventory_quantity: 3, inventory_management: "shopify", updated_at: "2026-01-15T00:00:00Z" },
    { id: 71, title: "L", sku: "", price: "26.00", inventory_quantity: 0 },
  ],
  variant_gids: [{ admin_graphql_api_id: "gid://shopify/ProductVariant/70", updated_at: "2026-01-15T00:00:00Z" }],
  ...over,
});

const gqlOrder = (over: Record<string, unknown> = {}) => ({
  id: "gid://shopify/Order/42",
  name: "#42",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
  cancelledAt: null,
  currencyCode: "USD",
  displayFinancialStatus: "PAID",
  displayFulfillmentStatus: "PARTIALLY_FULFILLED",
  sourceName: "web",
  discountCodes: [" SUMMER10 ", "", "VIP"],
  customerJourneySummary: { ready: true, lastVisit: { source: "google", sourceType: null, referrerUrl: "https://www.google.com/", landingPage: "/", utmParameters: null } },
  subtotalPriceSet: m("10.0"),
  totalDiscountsSet: m("1.0"),
  totalTaxSet: m("1.0"),
  totalShippingPriceSet: m("2.0"),
  totalPriceSet: m("12.0"),
  customer: { id: "gid://shopify/Customer/3", numberOfOrders: "4" },
  fulfillments: [{ createdAt: "2026-01-03T00:00:00Z" }],
  lineItems: {
    pageInfo: { hasNextPage: false },
    nodes: [
      {
        id: "gid://shopify/LineItem/7",
        title: "A",
        quantity: 1,
        sku: "SKU-A",
        variant: { id: "gid://shopify/ProductVariant/70" },
        product: null,
        originalUnitPriceSet: m("10.0"),
        totalDiscountSet: m("1.0"),
        __parentId: "gid://shopify/Order/42",
      },
    ],
  },
  refunds: [{ id: "gid://shopify/Refund/5", createdAt: "2026-01-04T00:00:00Z", refundLineItems: { pageInfo: { hasNextPage: false }, nodes: [{ subtotalSet: m("3.0") }] } }],
  ...over,
});

const gqlProduct = (over: Record<string, unknown> = {}) => ({
  id: "gid://shopify/Product/8",
  title: "Tee",
  status: "ACTIVE",
  vendor: "Acme",
  productType: "",
  createdAt: "2025-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  ...over,
});

const gqlVariant = (over: Record<string, unknown> = {}) => ({
  id: "gid://shopify/ProductVariant/70",
  title: "M",
  sku: "TEE-M",
  price: "25.00",
  inventoryQuantity: 4,
  updatedAt: "2026-01-01T00:00:00Z",
  product: { id: "gid://shopify/Product/8" },
  inventoryItem: { tracked: true, unitCost: { amount: "9.5" } },
  ...over,
});

/** `raw` through the boundary, failing the test if it doesn't fit. */
function parsed<S extends z.ZodTypeAny>(schema: S, raw: unknown): z.output<S> {
  const p = parseShopify(schema, raw, "test");
  if (p === null) throw new Error(`fixture rejected: ${JSON.stringify(warnings)}`);
  return p;
}

describe("payloads Shopify really sends", () => {
  it("pass the boundary and normalize exactly as before", () => {
    const rest = restOrder();
    expect(normalizeRestOrder(parsed(restOrderSchema, rest))).toEqual(normalizeRestOrder(rest));
    const refund = { id: 9, order_id: 1001, created_at: "2026-03-05T12:00:00Z", refund_line_items: [{ subtotal: "45.00", quantity: 1 }] };
    expect(normalizeRestRefund(parsed(restRefundWebhookSchema, refund))).toEqual(normalizeRestRefund(refund));
    const product = restProduct();
    expect(normalizeRestProduct(parsed(restProductSchema, product))).toEqual(normalizeRestProduct(product));
    expect(normalizeRestProductVariants(parsed(restProductSchema, product))).toEqual(normalizeRestProductVariants(product));
    for (const o of [gqlOrder(), gqlOrder({ customerJourneySummary: null, customer: null, refunds: [] }), gqlOrder({ customerJourneySummary: { ready: false, lastVisit: null } })]) {
      expect(normalizeGraphqlOrder(parsed(graphqlOrderSchema, o))).toEqual(normalizeGraphqlOrder(o));
    }
    expect(normalizeGraphqlProduct(parsed(graphqlProductSchema, gqlProduct()))).toEqual(normalizeGraphqlProduct(gqlProduct()));
    for (const v of [gqlVariant(), gqlVariant({ inventoryItem: null }), gqlVariant({ inventoryItem: { tracked: false, unitCost: null }, inventoryQuantity: null })]) {
      expect(normalizeGraphqlVariant(parsed(graphqlVariantSchema, v))).toEqual(normalizeGraphqlVariant(v));
    }
    expect(parsed(restProductDeleteSchema, { id: 8 })).toEqual({ id: 8 });
    expect(warnings).toEqual([]);
  });

  it("keep fields the schemas don't name, and leave absent ones absent", () => {
    const o = parsed(graphqlOrderSchema, gqlOrder({ newField: { from: "a later API version" } }));
    expect(o.newField).toEqual({ from: "a later API version" });
    // Absent (the detail queries don't ask for it) means "not known", unlike null (no visit).
    const { customerJourneySummary: _j, ...withoutJourney } = gqlOrder();
    const absent = parsed(graphqlOrderSchema, withoutJourney);
    expect("customerJourneySummary" in absent).toBe(false);
    expect(normalizeGraphqlOrder(absent)).toMatchObject({ traffic: null, trafficFrom: null });
    expect(normalizeGraphqlOrder(parsed(graphqlOrderSchema, gqlOrder({ customerJourneySummary: null }))).trafficFrom).toBe("journey");
    // The pre-2024-07 tracking field is told apart by its presence, so it must survive parsing too.
    const [tracked, unknown] = parsed(restProductSchema, restProduct()).variants!;
    expect("inventory_management" in tracked!).toBe(true);
    expect("inventory_management" in unknown!).toBe(false);
  });
});

describe("payloads that don't fit", () => {
  const cases: Array<[string, z.ZodTypeAny, unknown, string]> = [
    ["REST order without an id", restOrderSchema, restOrder({ id: undefined }), "id"],
    ["REST order with an unreadable created_at", restOrderSchema, restOrder({ created_at: "31/02/2026 noon" }), "created_at"],
    ["REST order with an unreadable cancelled_at", restOrderSchema, restOrder({ cancelled_at: "soon" }), "cancelled_at"],
    ["REST order whose line_items is not a list", restOrderSchema, restOrder({ line_items: { 0: {} } }), "line_items"],
    ["REST line item with a text quantity", restOrderSchema, restOrder({ line_items: [{ id: 1, title: "Tee", quantity: "two", price: "1" }] }), "line_items.0.quantity"],
    ["REST line item without an id", restOrderSchema, restOrder({ line_items: [{ title: "Tee", quantity: 1, price: "1" }] }), "line_items.0.id"],
    ["REST order with an object for a total", restOrderSchema, restOrder({ total_price: { amount: "104.00" } }), "total_price"],
    ["REST order with a numeric financial_status", restOrderSchema, restOrder({ financial_status: 7 }), "financial_status"],
    ["REST order with a refund dated nowhere", restOrderSchema, restOrder({ refunds: [{ id: 9, created_at: null }] }), "refunds.0.created_at"],
    ["refunds/create without its order", restRefundWebhookSchema, { id: 9, created_at: "2026-03-05T12:00:00Z", refund_line_items: [] }, "order_id"],
    ["REST product with one malformed variant", restProductSchema, restProduct({ variants: [{ id: 70, price: "1" }, { id: 71, price: { amount: 2 } }] }), "variants.1.price"],
    ["REST product listing a variant without its id", restProductSchema, restProduct({ variant_gids: [{ updated_at: "2026-01-15T00:00:00Z" }] }), "variant_gids.0.admin_graphql_api_id"],
    ["products/delete without an id", restProductDeleteSchema, {}, "id"],
    ["GraphQL order whose gid ends in nothing", graphqlOrderSchema, gqlOrder({ id: "gid://shopify/Order/" }), "id"],
    ["GraphQL order without a name", graphqlOrderSchema, gqlOrder({ name: null }), "name"],
    ["GraphQL line item without an id", graphqlOrderSchema, gqlOrder({ lineItems: { nodes: [{ title: "A", quantity: 1 }] } }), "lineItems.nodes.0.id"],
    ["GraphQL refund with an unreadable date", graphqlOrderSchema, gqlOrder({ refunds: [{ id: "gid://shopify/Refund/5", createdAt: "never" }] }), "refunds.0.createdAt"],
    ["GraphQL customer with a count that isn't one", graphqlOrderSchema, gqlOrder({ customer: { id: "gid://shopify/Customer/3", numberOfOrders: "lots" } }), "customer.numberOfOrders"],
    ["GraphQL money that isn't an amount", graphqlOrderSchema, gqlOrder({ totalPriceSet: { shopMoney: { amount: [12] } } }), "totalPriceSet.shopMoney.amount"],
    ["GraphQL product without updatedAt", graphqlProductSchema, gqlProduct({ updatedAt: undefined }), "updatedAt"],
    ["GraphQL variant without its product", graphqlVariantSchema, gqlVariant({ product: null }), "product"],
    ["GraphQL variant with a fractional stock level", graphqlVariantSchema, gqlVariant({ inventoryQuantity: 1.5 }), "inventoryQuantity"],
  ];

  it.each(cases)("%s: skipped, with a warning naming the field", (_name, schema, raw, path) => {
    expect(parseShopify(schema, raw, "orders/create", { storeId: "s1" })).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ level: "warn", storeId: "s1", payload: "orders/create" });
    const problems = warnings[0]!.problems as string[];
    expect(problems.some((p) => p.startsWith(`${path}: `))).toBe(true);
  });

  it("never logs the values, which can be a customer's details", () => {
    expect(parseShopify(restOrderSchema, restOrder({ created_at: "Pat Lee, 12 High St" }), "orders/create")).toBeNull();
    expect(JSON.stringify(warnings)).not.toContain("Pat Lee");
    expect(warnings[0]!.problems).toEqual(["created_at: not a timestamp"]);
  });

  it("a page keeps the nodes that fit, in order, with one warning for the rest", () => {
    const page = [gqlProduct({ id: "gid://shopify/Product/1" }), gqlProduct({ id: "" }), "not a node", gqlProduct({ id: "gid://shopify/Product/2" })];
    const ok = parseShopifyList(graphqlProductSchema, page, "GraphQL product", { storeId: "s1" });
    expect(ok.map((p) => normalizeGraphqlProduct(p).shopifyId)).toEqual(["1", "2"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ payload: "GraphQL product", storeId: "s1", skipped: 2, of: 4 });
    expect(parseShopifyList(graphqlProductSchema, [gqlProduct()], "GraphQL product")).toHaveLength(1);
    expect(warnings).toHaveLength(1); // nothing skipped, nothing said
  });

  it("a malformed customer journey costs the visit, not the order", () => {
    const o = parsed(graphqlOrderSchema, gqlOrder({ customerJourneySummary: { ready: "yes", lastVisit: 42 } }));
    const n = normalizeGraphqlOrder(o);
    expect(n).toMatchObject({ shopifyId: "42", totalPrice: 12, traffic: null, trafficFrom: null });
    expect(n.lineItems).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ payload: "GraphQL customer journey", order: "gid://shopify/Order/42" });
  });
});

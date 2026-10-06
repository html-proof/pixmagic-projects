import { describe, expect, it } from "vitest";
import {
  graphqlOrderOverflow,
  normalizeGraphqlOrder,
  normalizeGraphqlProduct,
  normalizeGraphqlVariant,
  normalizeRestOrder,
  normalizeRestProduct,
  normalizeRestProductVariants,
  normalizeRestVariant,
  ORDER_LINE_ITEMS_QUERY,
  ORDER_NESTED,
  ORDER_REFUNDS_QUERY,
  ordersQuery,
  PAGE_SIZE,
  PRODUCTS_QUERY,
  REFUND_LINE_ITEMS_QUERY,
  restFulfillmentStatus,
  VARIANTS_QUERY,
} from "../src/index.js";
import { requestedCost } from "./queryCost.js";

const MAX_COST = 1000;
const m = (amount: string) => ({ shopMoney: { amount } });

const gqlOrder = (over: Record<string, unknown> = {}) => ({
  id: "gid://shopify/Order/42",
  name: "#42",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
  currencyCode: "USD",
  displayFinancialStatus: "PAID",
  sourceName: "web",
  displayFulfillmentStatus: "PARTIALLY_FULFILLED",
  discountCodes: [" SUMMER10 ", "", "VIP"],
  subtotalPriceSet: m("10.0"),
  totalDiscountsSet: m("1.0"),
  totalTaxSet: m("1.0"),
  totalShippingPriceSet: m("2.0"),
  totalPriceSet: m("12.0"),
  fulfillments: [{ createdAt: "2026-01-03T00:00:00Z" }, { createdAt: "2026-01-02T12:00:00Z" }],
  lineItems: {
    pageInfo: { hasNextPage: false },
    nodes: [
      {
        id: "gid://shopify/LineItem/7",
        title: "A",
        quantity: 1,
        sku: "SKU-A",
        variant: { id: "gid://shopify/ProductVariant/70" },
        product: { id: "gid://shopify/Product/8" },
        originalUnitPriceSet: m("10.0"),
        totalDiscountSet: m("1.0"),
      },
    ],
  },
  refunds: [],
  ...over,
});

describe("query cost (Shopify rejects requested cost > 1000)", () => {
  it("orders page: 124 per order with customer, 123 without; default page size 7", () => {
    expect(PAGE_SIZE.orders).toBe(7);
    expect(requestedCost(ordersQuery(true), { first: 1 })).toBe(3 + 124);
    expect(requestedCost(ordersQuery(false), { first: 1 })).toBe(3 + 123);
    expect(requestedCost(ordersQuery(true), { first: PAGE_SIZE.orders })).toBe(871);
    expect(requestedCost(ordersQuery(false), { first: PAGE_SIZE.orders })).toBe(864);
    // 8 would still pass (995) but leaves no margin; 9 is rejected.
    expect(requestedCost(ordersQuery(true), { first: 8 })).toBe(995);
    expect(requestedCost(ordersQuery(true), { first: 9 })).toBeGreaterThan(MAX_COST);
  });

  /**
   * The backfill walks newest-first so the dashboard's 7- and 30-day ranges fill in within
   * seconds instead of after the whole 60-day window. `reverse` is a scalar argument, so it
   * costs nothing - which is exactly why it must be asserted rather than assumed: every cost
   * check above would still pass if someone dropped it.
   */
  it("walks orders newest-first, at no cost", () => {
    expect(ordersQuery(false)).toContain("reverse: true");
    expect(requestedCost(ordersQuery(false), { first: PAGE_SIZE.orders })).toBe(864);
  });

  it("per-order detail queries stay under the cap", () => {
    expect(requestedCost(ORDER_LINE_ITEMS_QUERY)).toBe(704);
    expect(requestedCost(ORDER_REFUNDS_QUERY)).toBe(791);
    expect(requestedCost(REFUND_LINE_ITEMS_QUERY)).toBe(304);
  });

  it("products and variants pages", () => {
    expect(requestedCost(PRODUCTS_QUERY, { first: PAGE_SIZE.products })).toBe(103);
    expect(requestedCost(VARIANTS_QUERY, { first: PAGE_SIZE.variants })).toBe(403);
  });

  it("the estimator reproduces the old orders query being far over the cap", () => {
    const old = `query Orders($cursor: String) { orders(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { id lineItems(first: 100) { nodes { id product { id } originalUnitPriceSet { shopMoney { amount } } } }
        refunds(first: 20) { id refundLineItems(first: 100) { nodes { subtotalSet { shopMoney { amount } } } } } } } }`;
    expect(requestedCost(old)).toBeGreaterThan(10 * MAX_COST);
  });
});

describe("order normalizers: channel, fulfillment, discount codes, variants", () => {
  it("GraphQL orders carry the new fields", () => {
    const g = normalizeGraphqlOrder(gqlOrder());
    expect(g).toMatchObject({
      sourceName: "web",
      fulfillmentStatus: "partially_fulfilled",
      discountCodes: ["SUMMER10", "VIP"],
    });
    expect(g.fulfilledAt?.toISOString()).toBe("2026-01-02T12:00:00.000Z"); // earliest, not first listed
    expect(g.lineItems[0]).toMatchObject({ variantShopifyId: "70", productShopifyId: "8", sku: "SKU-A" });
  });

  it("GraphQL defaults when fields are missing", () => {
    const g = normalizeGraphqlOrder(
      gqlOrder({ sourceName: null, displayFulfillmentStatus: undefined, discountCodes: undefined, fulfillments: [], lineItems: { nodes: [{ id: "gid://shopify/LineItem/1", title: "X", quantity: 1, variant: null, product: null, sku: "" }] } }),
    );
    expect(g).toMatchObject({ sourceName: null, fulfillmentStatus: null, fulfilledAt: null, discountCodes: [] });
    expect(g.lineItems[0]).toMatchObject({ variantShopifyId: null, productShopifyId: null, sku: null });
  });

  it("maps every displayFulfillmentStatus to lowercase snake", () => {
    for (const s of ["FULFILLED", "UNFULFILLED", "PARTIALLY_FULFILLED", "ON_HOLD", "IN_PROGRESS", "OPEN", "PENDING_FULFILLMENT", "RESTOCKED", "SCHEDULED", "REQUEST_DECLINED"]) {
      expect(normalizeGraphqlOrder(gqlOrder({ displayFulfillmentStatus: s })).fulfillmentStatus).toBe(s.toLowerCase());
    }
  });

  it("maps REST fulfillment_status onto the same vocabulary", () => {
    expect(restFulfillmentStatus(null)).toBe("unfulfilled");
    expect(restFulfillmentStatus(undefined)).toBe("unfulfilled");
    expect(restFulfillmentStatus("fulfilled")).toBe("fulfilled");
    expect(restFulfillmentStatus("partial")).toBe("partially_fulfilled");
    expect(restFulfillmentStatus("restocked")).toBe("restocked");
    expect(restFulfillmentStatus("On_Hold")).toBe("on_hold");
  });

  it("REST orders carry the new fields", () => {
    const n = normalizeRestOrder({
      id: 1,
      name: "#1",
      created_at: "2026-03-01T00:00:00Z",
      updated_at: "2026-03-01T00:00:00Z",
      source_name: "pos",
      fulfillment_status: "partial",
      fulfillments: [{ created_at: "2026-03-04T00:00:00Z" }, { created_at: "2026-03-02T00:00:00Z" }],
      discount_codes: [{ code: "WELCOME", amount: "5.00" }, { code: " " }],
      line_items: [{ id: 2, product_id: 3, variant_id: 4, sku: " TEE-M ", title: "Tee", quantity: 1, price: "10" }],
    });
    expect(n).toMatchObject({ sourceName: "pos", fulfillmentStatus: "partially_fulfilled", discountCodes: ["WELCOME"] });
    expect(n.fulfilledAt?.toISOString()).toBe("2026-03-02T00:00:00.000Z");
    expect(n.lineItems[0]).toMatchObject({ productShopifyId: "3", variantShopifyId: "4", sku: "TEE-M" });

    const bare = normalizeRestOrder({ id: 5, created_at: "2026-03-01T00:00:00Z", line_items: [{ id: 6, title: "X", quantity: 1, price: "1" }] });
    expect(bare).toMatchObject({ sourceName: null, fulfillmentStatus: "unfulfilled", fulfilledAt: null, discountCodes: [] });
    expect(bare.lineItems[0]).toMatchObject({ variantShopifyId: null, sku: null });
  });
});

describe("order overflow detection", () => {
  it("flags truncated line items, refund lines and a full refunds list", () => {
    expect(graphqlOrderOverflow(gqlOrder())).toEqual({ lineItems: false, refunds: false });
    expect(graphqlOrderOverflow(gqlOrder({ lineItems: { pageInfo: { hasNextPage: true }, nodes: [] } })).lineItems).toBe(true);
    const refund = (more: boolean) => ({ id: "gid://shopify/Refund/1", createdAt: "2026-01-02T00:00:00Z", refundLineItems: { pageInfo: { hasNextPage: more }, nodes: [] } });
    expect(graphqlOrderOverflow(gqlOrder({ refunds: [refund(false)] })).refunds).toBe(false);
    expect(graphqlOrderOverflow(gqlOrder({ refunds: [refund(true)] })).refunds).toBe(true);
    expect(graphqlOrderOverflow(gqlOrder({ refunds: Array.from({ length: ORDER_NESTED.refunds }, () => refund(false)) })).refunds).toBe(true);
    // Fixtures without pageInfo (older shape) never overflow.
    expect(graphqlOrderOverflow({ lineItems: { nodes: [] }, refunds: [] })).toEqual({ lineItems: false, refunds: false });
  });
});

describe("product and variant normalizers", () => {
  it("GraphQL products carry vendor, type and creation date", () => {
    const p = normalizeGraphqlProduct({ id: "gid://shopify/Product/8", title: "Tee", status: "ARCHIVED", vendor: "Acme", productType: "", createdAt: "2025-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" });
    expect(p).toEqual({
      shopifyId: "8",
      title: "Tee",
      status: "archived",
      vendor: "Acme",
      productType: null,
      createdAt: new Date("2025-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    });
  });

  it("REST products carry vendor, product_type and created_at", () => {
    const p = normalizeRestProduct({ id: 8, title: "Tee", status: "active", vendor: " Acme ", product_type: "Shirts", created_at: "2025-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" });
    expect(p).toMatchObject({ shopifyId: "8", status: "active", vendor: "Acme", productType: "Shirts" });
    expect(p.createdAt?.toISOString()).toBe("2025-01-01T00:00:00.000Z");
  });

  it("GraphQL variants: price, stock, cost; untracked stock and withheld cost", () => {
    const base = {
      id: "gid://shopify/ProductVariant/70",
      title: "M",
      sku: "TEE-M",
      price: "25.00",
      inventoryQuantity: 4,
      updatedAt: "2026-01-01T00:00:00Z",
      product: { id: "gid://shopify/Product/8" },
    };
    expect(normalizeGraphqlVariant({ ...base, inventoryItem: { tracked: true, unitCost: { amount: "9.5" } } })).toEqual({
      shopifyId: "70",
      productShopifyId: "8",
      title: "M",
      sku: "TEE-M",
      price: 25,
      inventoryQuantity: 4,
      unitCost: 9.5,
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    });
    // Not tracked: stock is meaningless. No cost set: null (authoritative).
    expect(normalizeGraphqlVariant({ ...base, inventoryItem: { tracked: false, unitCost: null } })).toMatchObject({ inventoryQuantity: null, unitCost: null });
    // inventoryItem withheld (ACCESS_DENIED): cost unknown => undefined (keep stored value).
    const withheld = normalizeGraphqlVariant({ ...base, inventoryItem: null });
    expect(withheld.unitCost).toBeUndefined();
    expect(withheld.inventoryQuantity).toBe(4);
  });

  it("REST product variants: no cost, inventory_quantity included", () => {
    const vs = normalizeRestProductVariants({
      id: 8,
      updated_at: "2026-02-01T00:00:00Z",
      variants: [
        { id: 70, product_id: 8, title: "M", sku: "TEE-M", price: "25.00", inventory_quantity: 3, inventory_management: "shopify", updated_at: "2026-01-15T00:00:00Z" },
        { id: 71, title: "L", sku: "", price: "26.00", inventory_quantity: 0, inventory_management: null },
      ],
    });
    expect(vs).toHaveLength(2);
    expect(vs[0]).toMatchObject({ shopifyId: "70", productShopifyId: "8", inventoryQuantity: 3, price: 25 });
    expect(vs[0]!.unitCost).toBeUndefined();
    expect(vs[0]!.updatedAt.toISOString()).toBe("2026-01-15T00:00:00.000Z");
    // Missing product_id / updated_at fall back to the product; untracked => null stock.
    expect(vs[1]).toMatchObject({ shopifyId: "71", productShopifyId: "8", sku: null, inventoryQuantity: null });
    expect(vs[1]!.updatedAt.toISOString()).toBe("2026-02-01T00:00:00.000Z");
    expect(normalizeRestProductVariants({ id: 9 })).toEqual([]);
    expect(normalizeRestVariant({ id: 1, product_id: 2, price: "1" }).inventoryQuantity).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import {
  bulkOrdersQuery,
  graphqlOrderOverflow,
  normalizeGraphqlOrder,
  normalizeGraphqlProduct,
  normalizeGraphqlVariant,
  normalizeRestOrder,
  normalizeRestProduct,
  normalizeRestProductVariants,
  normalizeRestVariant,
  ORDER_LINE_ITEMS_QUERY,
  ORDER_SALES_QUERY,
  orderSalesQuery,
  ordersQuery,
  PAGE_SIZE,
  PRODUCTS_QUERY,
  restFulfillmentStatus,
  restProvisionalSales,
  restSalesKey,
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
  agreements: {
    pageInfo: { hasNextPage: false },
    nodes: [
      {
        id: "gid://shopify/SalesAgreement/1",
        happenedAt: "2026-01-01T00:00:00Z",
        reason: "ORDER",
        sales: {
          pageInfo: { hasNextPage: false },
          nodes: [
            {
              id: "gid://shopify/Sale/11",
              actionType: "ORDER",
              lineType: "PRODUCT",
              quantity: 1,
              totalAmount: m("10.0"),
              totalDiscountAmountBeforeTaxes: m("1.0"),
              totalTaxAmount: m("1.0"),
              lineItem: { id: "gid://shopify/LineItem/7" },
            },
            {
              id: "gid://shopify/Sale/12",
              actionType: "ORDER",
              lineType: "SHIPPING",
              quantity: null,
              totalAmount: m("2.0"),
              totalDiscountAmountBeforeTaxes: m("0"),
              totalTaxAmount: m("0"),
            },
          ],
        },
      },
    ],
  },
  ...over,
});

describe("query cost (Shopify rejects requested cost > 1000)", () => {
  it("orders page: 161 per order with customer, 160 without; default page size 5", () => {
    expect(PAGE_SIZE.orders).toBe(5);
    // The customer's journey (where they came from) is 3 of those points, the sales 107.
    expect(requestedCost(ordersQuery(true), { first: 1 })).toBe(3 + 161);
    expect(requestedCost(ordersQuery(false), { first: 1 })).toBe(3 + 160);
    expect(requestedCost(ordersQuery(true), { first: PAGE_SIZE.orders })).toBe(808);
    expect(requestedCost(ordersQuery(false), { first: PAGE_SIZE.orders })).toBe(803);
    // 7 is rejected.
    expect(requestedCost(ordersQuery(true), { first: 7 })).toBeGreaterThan(MAX_COST);
  });

  /**
   * The backfill walks newest-first so the dashboard's 7- and 30-day ranges fill in within
   * seconds instead of after the whole 60-day window. `reverse` is a scalar argument, so it
   * costs nothing - which is exactly why it must be asserted rather than assumed: every cost
   * check above would still pass if someone dropped it.
   */
  it("walks orders newest-first, at no cost", () => {
    expect(ordersQuery(false)).toContain("reverse: true");
    expect(requestedCost(ordersQuery(false), { first: PAGE_SIZE.orders })).toBe(803);
  });

  it("per-order detail queries stay under the cap", () => {
    expect(requestedCost(ORDER_LINE_ITEMS_QUERY)).toBe(704);
    // The order's position in its customer's history costs 1, the customer's order count 1 more.
    expect(requestedCost(ORDER_SALES_QUERY)).toBe(809);
    expect(requestedCost(orderSalesQuery(true))).toBe(810);
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

describe("bulk orders query (Shopify's bulk operation rules)", () => {
  /** Field path of every connection (`edges`) in a query, arguments stripped. */
  const connections = (q: string) => {
    const stack: string[] = [];
    const paths: string[] = [];
    let last = "";
    for (const tok of q.replace(/\([^)]*\)/g, "").match(/[A-Za-z_]\w*|[{}]/g) ?? []) {
      if (tok === "{") stack.push(last);
      else if (tok === "}") stack.pop();
      else if ((last = tok) === "edges") paths.push(stack.filter((f) => f !== "edges" && f !== "node" && f).join("."));
    }
    return paths;
  };

  it("nests no connection inside a list field, and none deeper than two", () => {
    for (const q of [bulkOrdersQuery(true, null), bulkOrdersQuery(false, "created_at:>='2026-08-17T00:00:00.000Z'")]) {
      // Shopify turned the export away on every store while `refunds` (a list) carried the
      // `refundLineItems` connection. The sales records nest connections instead: an order's
      // agreements, each agreement's sales (two levels below orders, the most Shopify allows).
      expect(connections(q)).toEqual(["orders", "orders.lineItems", "orders.agreements", "orders.agreements.sales"]);
      expect(q).not.toMatch(/\brefunds\b/);
      expect(q).not.toMatch(/\b(first|after):/);
    }
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
  it("flags truncated line items, more agreements than fit, and an agreement with more sales", () => {
    expect(graphqlOrderOverflow(gqlOrder())).toEqual({ lineItems: false, sales: false });
    expect(graphqlOrderOverflow(gqlOrder({ lineItems: { pageInfo: { hasNextPage: true }, nodes: [] } })).lineItems).toBe(true);
    const agreement = (more: boolean) => ({ id: "gid://shopify/SalesAgreement/1", happenedAt: "2026-01-02T00:00:00Z", sales: { pageInfo: { hasNextPage: more }, nodes: [] } });
    expect(graphqlOrderOverflow(gqlOrder({ agreements: { pageInfo: { hasNextPage: false }, nodes: [agreement(false)] } })).sales).toBe(false);
    expect(graphqlOrderOverflow(gqlOrder({ agreements: { pageInfo: { hasNextPage: false }, nodes: [agreement(true)] } })).sales).toBe(true);
    expect(graphqlOrderOverflow(gqlOrder({ agreements: { pageInfo: { hasNextPage: true }, nodes: [agreement(false)] } })).sales).toBe(true);
    // Fixtures without pageInfo never overflow.
    expect(graphqlOrderOverflow({ lineItems: { nodes: [] }, agreements: { nodes: [] } })).toEqual({ lineItems: false, sales: false });
  });
});

describe("Shopify's sales records", () => {
  it("are read from the order's agreements, each sale dated by its agreement", () => {
    const g = normalizeGraphqlOrder(gqlOrder({ test: false }));
    expect(g.test).toBe(false);
    expect(g.sales).toEqual([
      {
        shopifyId: "11",
        happenedAt: new Date("2026-01-01T00:00:00Z"),
        actionType: "order",
        agreement: "order",
        lineType: "product",
        lineItemShopifyId: "7",
        quantity: 1,
        amount: 10,
        discount: 1,
        tax: 1,
      },
      {
        shopifyId: "12",
        happenedAt: new Date("2026-01-01T00:00:00Z"),
        actionType: "order",
        agreement: "order",
        lineType: "shipping",
        lineItemShopifyId: null,
        quantity: null,
        amount: 2,
        discount: 0,
        tax: 0,
      },
    ]);
    // A query that didn't ask for them says nothing about them: the stored ones are kept.
    expect(normalizeGraphqlOrder(gqlOrder({ agreements: undefined })).sales).toBeNull();
    expect(normalizeGraphqlOrder(gqlOrder({ test: true })).test).toBe(true);
  });

  // Found 2026-10-19 by checking a dev store of seeded orders against its own ShopifyQL sales report.
  it("date an order by when Shopify processed it, and tell gift-card-only orders and each sale's agreement", () => {
    const line = (id: number, isGiftCard: boolean) => ({ id: `gid://shopify/LineItem/${id}`, title: "x", quantity: 1, isGiftCard, originalUnitPriceSet: m("10"), totalDiscountSet: m("0") });
    const edited = { id: "gid://shopify/SalesAgreement/2", happenedAt: "2026-01-05T00:00:00Z", reason: "ORDER_EDIT", sales: { pageInfo: { hasNextPage: false }, nodes: [] } };
    const g = normalizeGraphqlOrder(gqlOrder({ processedAt: "2025-12-30T10:00:00Z" }));
    // Imported on 1 Jan for a sale on 30 Dec: Shopify's reports put it on 30 Dec.
    expect(g.processedAt).toEqual(new Date("2025-12-30T10:00:00Z"));
    expect(g.createdAt).toEqual(new Date("2026-01-01T00:00:00Z"));
    expect(normalizeGraphqlOrder(gqlOrder()).processedAt).toEqual(new Date("2026-01-01T00:00:00Z"));
    expect(g.giftCardOnly).toBe(false);
    expect(normalizeGraphqlOrder(gqlOrder({ lineItems: { pageInfo: { hasNextPage: false }, nodes: [line(1, true), line(2, true)] } })).giftCardOnly).toBe(true);
    expect(normalizeGraphqlOrder(gqlOrder({ lineItems: { pageInfo: { hasNextPage: false }, nodes: [line(1, true), line(2, false)] } })).giftCardOnly).toBe(false);
    // A truncated list could hide the item that isn't a gift card: not decided until it is whole.
    expect(normalizeGraphqlOrder(gqlOrder({ lineItems: { pageInfo: { hasNextPage: true }, nodes: [line(1, true)] } })).giftCardOnly).toBe(false);
    const agreements = gqlOrder().agreements;
    const withEdit = normalizeGraphqlOrder(gqlOrder({ agreements: { ...agreements, nodes: [...agreements.nodes, { ...edited, sales: agreements.nodes[0]!.sales }] } }));
    expect(withEdit.sales!.map((x) => x.agreement)).toEqual(["order", "order", "order_edit", "order_edit"]);

    const rest = { id: 9, created_at: "2026-03-05T00:00:00Z", processed_at: "2026-03-01T09:00:00Z", line_items: [{ id: 1, title: "Card", quantity: 1, price: "50.00", gift_card: true }] };
    const r = normalizeRestOrder(rest);
    expect(r.processedAt).toEqual(new Date("2026-03-01T09:00:00Z"));
    expect(r.giftCardOnly).toBe(true);
    // The estimate of the order as placed is dated as Shopify's own agreement will be.
    expect(r.provisionalSales).toMatchObject([{ happenedAt: new Date("2026-03-01T09:00:00Z"), agreement: "order" }]);
    expect(normalizeRestOrder({ ...rest, processed_at: undefined }).processedAt).toEqual(new Date("2026-03-05T00:00:00Z"));
  });

  it("REST orders carry none, but a provisional estimate of the order as placed", () => {
    const rest = {
      id: 9,
      created_at: "2026-03-01T00:00:00Z",
      taxes_included: true,
      line_items: [
        { id: 1, title: "Tee", quantity: 2, price: "55.00", total_discount: "11.00", tax_lines: [{ price: "9.00" }] },
        { id: 2, title: "Card", quantity: 1, price: "50.00", gift_card: true },
      ],
      shipping_lines: [{ id: 3, price: "10.00", discounted_price: "8.00", tax_lines: [{ price: "0.73" }] }],
    };
    const n = normalizeRestOrder(rest);
    expect(n.sales).toBeNull();
    expect(n.test).toBe(false);
    expect(n.provisionalSales).toEqual(restProvisionalSales(rest));
    expect(n.provisionalSales).toMatchObject([
      // Prices include tax: the amount is what the customer paid for the line, tax and all.
      { lineType: "product", lineItemShopifyId: "1", quantity: 2, amount: 99, discount: 11, tax: 9 },
      { lineType: "gift_card", amount: 50 },
      { lineType: "shipping", amount: 8, discount: 2, tax: 0.73 },
    ]);
    // Tax on top of the prices is added to the amount.
    expect(restProvisionalSales({ ...rest, taxes_included: false })[0]).toMatchObject({ amount: 108 });
    // A cancelled order has nothing to estimate.
    expect(restProvisionalSales({ ...rest, cancelled_at: "2026-03-02T00:00:00Z" })).toEqual([]);
    expect(normalizeRestOrder({ ...rest, test: true }).test).toBe(true);
  });

  it("a REST payload's money state changes with every sale, return, cancellation and edit, and nothing else", () => {
    const base = {
      id: 9,
      created_at: "2026-03-01T00:00:00Z",
      total_price: "100.00",
      current_total_price: "100.00",
      line_items: [{ id: 1, quantity: 2, current_quantity: 2, price: "50" }],
      refunds: [],
    };
    const key = restSalesKey(base);
    expect(restSalesKey({ ...base, financial_status: "paid", fulfillment_status: "fulfilled", updated_at: "2026-03-02T00:00:00Z" })).toBe(key);
    expect(restSalesKey({ ...base, total_price: "100" })).toBe(key);
    expect(restSalesKey({ ...base, current_total_price: "50.00" })).not.toBe(key);
    expect(restSalesKey({ ...base, refunds: [{ id: 5, created_at: "2026-03-02T00:00:00Z" }] })).not.toBe(key);
    expect(restSalesKey({ ...base, cancelled_at: "2026-03-02T00:00:00Z" })).not.toBe(key);
    expect(restSalesKey({ ...base, line_items: [{ id: 1, quantity: 2, current_quantity: 1, price: "50" }] })).not.toBe(key);
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

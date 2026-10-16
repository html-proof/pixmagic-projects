/**
 * Converts Shopify REST webhook payloads and Admin GraphQL nodes into one
 * internal shape. Only fields needed for KPIs are kept; customer identity is
 * reduced to an id that is hashed before storage (see persist.ts).
 *
 * The inputs have been checked against the schemas in shopifyPayloads.ts where they entered
 * (`parseShopify`), so the ids and timestamps a row needs are there and valid.
 */
import { classifyVisit, restVisit, type Traffic } from "@app/shared";
import {
  journeySummarySchema,
  parseShopify,
  type GraphqlMoney,
  type GraphqlOrder,
  type GraphqlProduct,
  type GraphqlVariant,
  type RestOrder,
  type RestProduct,
  type RestVariant,
} from "./shopifyPayloads.js";

export interface NormalizedLineItem {
  shopifyId: string;
  productShopifyId: string | null;
  variantShopifyId: string | null;
  sku: string | null;
  title: string;
  quantity: number;
  price: number;
  discount: number;
}

/**
 * One of Shopify's sales records: a line sold, returned or changed, on the day it happened. These
 * are what Shopify's own reports add up, so the dashboard's sales totals are built from them
 * (recomputeDays in persist.ts, docs/kpis.md).
 */
export interface NormalizedSale {
  shopifyId: string;
  /** When the agreement it belongs to happened: the order placed, edited, refunded or returned. */
  happenedAt: Date;
  /** order | return | update | unknown */
  actionType: string;
  /** product | shipping | gift_card | tip | duty | fee | additional_fee | adjustment | unknown */
  lineType: string;
  lineItemShopifyId: string | null;
  quantity: number | null;
  /** After discounts, taxes included; negative for a return. */
  amount: number;
  /** Discounts before taxes. */
  discount: number;
  tax: number;
}

export interface NormalizedOrder {
  shopifyId: string;
  name: string;
  currency: string;
  createdAt: Date;
  updatedAt: Date;
  cancelledAt: Date | null;
  /** A test order: never stored (Shopify's reports leave test orders out), and removed if it was. */
  test: boolean;
  financialStatus: string | null;
  subtotal: number;
  totalDiscounts: number;
  totalTax: number;
  totalShipping: number;
  totalPrice: number;
  customerId: string | null;
  customerOrderCount: number | null;
  /** Sales channel exactly as Shopify reports it (web, pos, an app id, ...); labels come from channelLabel(). */
  sourceName: string | null;
  /** Lowercase snake of GraphQL displayFulfillmentStatus (fulfilled, partially_fulfilled, unfulfilled, ...). */
  fulfillmentStatus: string | null;
  /** Earliest fulfillment's createdAt (time-to-ship), null while nothing has shipped. */
  fulfilledAt: Date | null;
  discountCodes: string[];
  /**
   * Where the customer came from; null when this source didn't say (persistence keeps what it has).
   * `trafficFrom`: "journey" is Shopify's processed record of the visit (GraphQL) and wins over
   * "landing", a webhook's landing_site/referring_site, which only fills a gap.
   */
  traffic: Traffic | null;
  trafficFrom: "journey" | "landing" | null;
  lineItems: NormalizedLineItem[];
  /**
   * Shopify's sales records for the order, all of them. Null when the source doesn't carry them
   * (REST webhooks): the stored ones are kept, and the webhook consumer reads them separately.
   */
  sales: NormalizedSale[] | null;
  /**
   * REST only: the order as placed, estimated from the payload in the shape of Shopify's sales
   * (`restProvisionalSales`). Stored only for an order whose sales were never read, so a new order
   * counts at once even when reading its sales fails; the read replaces them.
   */
  provisionalSales: NormalizedSale[] | null;
  /** REST only: the money state the payload describes (`restSalesKey`). */
  salesKey: string | null;
}

export interface NormalizedProduct {
  shopifyId: string;
  title: string;
  /** active | draft | archived | unlisted (lowercase; unlisted = live, reachable by direct link, API 2025-10+). */
  status: string | null;
  vendor: string | null;
  productType: string | null;
  createdAt: Date | null;
  updatedAt: Date;
}

export interface NormalizedVariant {
  shopifyId: string;
  productShopifyId: string;
  title: string;
  sku: string | null;
  price: number;
  /**
   * Total sellable quantity; null when Shopify doesn't track inventory for the variant.
   * `undefined` means the source didn't carry it: persistence keeps what it already has.
   */
  inventoryQuantity?: number | null;
  /**
   * The source carried a quantity but not whether Shopify tracks it (REST webhooks since API
   * 2024-07 dropped `inventory_management`): persistence keeps a variant it knows is untracked
   * (null) untracked instead of storing the meaningless quantity.
   */
  trackingUnknown?: boolean;
  /** Unit cost; `undefined` when the source doesn't carry cost (REST webhooks): keep the known value. */
  unitCost?: number | null;
  updatedAt: Date;
}

export const gidToId = (gid: string | number | null | undefined): string | null => {
  if (gid === null || gid === undefined) return null;
  const s = String(gid);
  return s.includes("/") ? (s.split("/").pop() ?? null) : s;
};

const num = (v: string | number | null | undefined): number => {
  const n = typeof v === "number" ? v : Number.parseFloat(String(v ?? "0"));
  return Number.isFinite(n) ? n : 0;
};

/** The schemas only let valid timestamps through; this throw is the backstop. */
const date = (v: string): Date => {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date ${v}`);
  return d;
};

/** Trimmed non-empty string, else null. */
const text = (v: string | null | undefined): string | null => {
  if (v === null || v === undefined) return null;
  const s = v.trim();
  return s ? s : null;
};

/** Earliest valid timestamp among `values`, else null. */
const earliest = (values: Array<string | null | undefined>): Date | null => {
  let min: Date | null = null;
  for (const v of values) {
    if (!v) continue;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) continue;
    if (!min || d < min) min = d;
  }
  return min;
};

const codes = (list: Array<string | null | undefined>): string[] => list.map(text).filter((c): c is string => c !== null);

/**
 * REST `fulfillment_status` (null | fulfilled | partial | restocked) mapped onto the
 * GraphQL displayFulfillmentStatus vocabulary used everywhere else.
 */
export function restFulfillmentStatus(v: string | null | undefined): string {
  const s = text(v)?.toLowerCase();
  if (!s) return "unfulfilled";
  if (s === "partial") return "partially_fulfilled";
  return s;
}

/**
 * A REST order payload's money state: its totals now and as placed, whether it is cancelled, how many
 * refunds it has and how many items are left. Every sale, return, cancellation and edit moves one of
 * them, so a webhook whose key matches the one the stored sales were read for needs no new read of
 * them, and the many deliveries that only change something else (paid, fulfilled, tagged) cost no
 * call to Shopify.
 */
export function restSalesKey(o: RestOrder): string {
  const money = (v: string | number | null | undefined) => num(v).toFixed(2);
  const items = (o.line_items ?? []).reduce((a, li) => a + (li.current_quantity ?? li.quantity ?? 0), 0);
  return [
    o.cancelled_at ? date(o.cancelled_at).toISOString() : "",
    money(o.total_price),
    money(o.current_total_price ?? o.total_price),
    money(o.current_subtotal_price ?? o.subtotal_price),
    money(o.current_total_tax ?? o.total_tax),
    money(o.current_total_discounts ?? o.total_discounts),
    (o.refunds ?? []).length,
    items,
  ].join("|");
}

/**
 * The sales Shopify records when an order is placed, estimated from a REST payload: a sale per line
 * item and per shipping line, valued after discounts, with their tax (added to the amount unless
 * the prices include it). Nothing for a cancelled order. Only a stand-in until the real sales are
 * read (ORDER_SALES_QUERY): with prices that include tax, a discount's tax share isn't known here.
 */
export function restProvisionalSales(o: RestOrder): NormalizedSale[] {
  if (o.cancelled_at) return [];
  const happenedAt = date(o.created_at);
  const withTax = o.taxes_included !== true;
  const taxOf = (lines: Array<{ price?: string | number | null }> | null | undefined) => (lines ?? []).reduce((a, t) => a + num(t.price), 0);
  const items = (o.line_items ?? []).map((li): NormalizedSale => {
    const quantity = li.quantity ?? 0;
    const discount = li.discount_allocations?.length ? li.discount_allocations.reduce((a, d) => a + num(d.amount), 0) : num(li.total_discount);
    const tax = taxOf(li.tax_lines);
    return {
      shopifyId: `provisional:line:${li.id}`,
      happenedAt,
      actionType: "order",
      lineType: li.gift_card ? "gift_card" : "product",
      lineItemShopifyId: String(li.id),
      quantity,
      amount: num(li.price) * quantity - discount + (withTax ? tax : 0),
      discount,
      tax,
    };
  });
  const shipping = (o.shipping_lines ?? []).map((sl, i): NormalizedSale => {
    const tax = taxOf(sl.tax_lines);
    const price = num(sl.discounted_price ?? sl.price);
    return {
      shopifyId: `provisional:shipping:${o.id}:${sl.id ?? i}`,
      happenedAt,
      actionType: "order",
      lineType: "shipping",
      lineItemShopifyId: null,
      quantity: null,
      amount: price + (withTax ? tax : 0),
      discount: num(sl.price) - price,
      tax,
    };
  });
  return [...items, ...shipping];
}

export function normalizeRestOrder(o: RestOrder): NormalizedOrder {
  return {
    shopifyId: String(o.id),
    name: String(o.name ?? o.id),
    currency: o.currency ?? "USD",
    createdAt: date(o.created_at),
    updatedAt: date(o.updated_at ?? o.created_at),
    cancelledAt: o.cancelled_at ? date(o.cancelled_at) : null,
    test: o.test === true,
    financialStatus: o.financial_status ?? null,
    subtotal: num(o.subtotal_price),
    totalDiscounts: num(o.total_discounts),
    totalTax: num(o.total_tax),
    totalShipping: num(o.total_shipping_price_set?.shop_money?.amount),
    totalPrice: num(o.total_price),
    customerId: o.customer?.id ? String(o.customer.id) : null,
    customerOrderCount: o.customer?.orders_count ?? null,
    sourceName: text(o.source_name),
    fulfillmentStatus: restFulfillmentStatus(o.fulfillment_status),
    fulfilledAt: earliest((o.fulfillments ?? []).map((f) => f.created_at)),
    discountCodes: codes((o.discount_codes ?? []).map((d) => d.code)),
    ...restTraffic(o),
    lineItems: (o.line_items ?? []).map((li) => ({
      shopifyId: String(li.id),
      productShopifyId: li.product_id ? String(li.product_id) : null,
      variantShopifyId: li.variant_id ? String(li.variant_id) : null,
      sku: text(li.sku),
      title: li.title ?? "",
      quantity: li.quantity ?? 0,
      price: num(li.price),
      discount: li.discount_allocations?.length
        ? li.discount_allocations.reduce((a, d) => a + num(d.amount), 0)
        : num(li.total_discount),
    })),
    sales: null,
    provisionalSales: restProvisionalSales(o),
    salesKey: restSalesKey(o),
  };
}

const money = (set: GraphqlMoney) => num(set?.shopMoney?.amount);

/** A webhook's landing_site / referring_site; nothing when it carries neither (never "unknown"). */
function restTraffic(o: RestOrder): Pick<NormalizedOrder, "traffic" | "trafficFrom"> {
  const v = restVisit(o);
  return v ? { traffic: classifyVisit(v, text(o.source_name)), trafficFrom: "landing" } : { traffic: null, trafficFrom: null };
}

/**
 * Shopify's journey for the order. Not asked for (detail queries) or not processed yet (`ready:
 * false`): unknown for now. Processed with no visit (POS, draft orders): that is the answer.
 */
function journeyTraffic(o: GraphqlOrder): Pick<NormalizedOrder, "traffic" | "trafficFrom"> {
  const notYet = { traffic: null, trafficFrom: null };
  if (!("customerJourneySummary" in o)) return notYet;
  const raw = o.customerJourneySummary;
  if (raw === null || raw === undefined) return { traffic: classifyVisit(null, text(o.sourceName)), trafficFrom: "journey" };
  // A journey that doesn't fit (logged) is treated like one not processed yet.
  const j = parseShopify(journeySummarySchema, raw, "GraphQL customer journey", { order: o.id });
  if (!j || j.ready === false) return notYet;
  return { traffic: classifyVisit(j.lastVisit ?? null, text(o.sourceName)), trafficFrom: "journey" };
}

/** Shopify's enum value (PRODUCT, ADDITIONAL_FEE) as stored: lowercase, "unknown" when missing. */
const saleEnum = (v: string | null | undefined) => text(v)?.toLowerCase() ?? "unknown";

/** The sales of an order's agreements, each dated by its agreement. */
export function normalizeGraphqlSales(agreements: NonNullable<GraphqlOrder["agreements"]>["nodes"]): NormalizedSale[] {
  return (agreements ?? []).flatMap((a) =>
    (a.sales?.nodes ?? []).map((s) => ({
      shopifyId: gidToId(s.id)!,
      happenedAt: date(a.happenedAt),
      actionType: saleEnum(s.actionType),
      lineType: saleEnum(s.lineType),
      lineItemShopifyId: gidToId(s.lineItem?.id),
      quantity: s.quantity ?? null,
      amount: money(s.totalAmount),
      discount: money(s.totalDiscountAmountBeforeTaxes),
      tax: money(s.totalTaxAmount),
    })),
  );
}

export function normalizeGraphqlOrder(o: GraphqlOrder): NormalizedOrder {
  return {
    shopifyId: gidToId(o.id)!,
    name: o.name,
    currency: o.currencyCode ?? "USD",
    createdAt: date(o.createdAt),
    updatedAt: date(o.updatedAt ?? o.createdAt),
    cancelledAt: o.cancelledAt ? date(o.cancelledAt) : null,
    test: o.test === true,
    financialStatus: o.displayFinancialStatus?.toLowerCase() ?? null,
    subtotal: money(o.subtotalPriceSet),
    totalDiscounts: money(o.totalDiscountsSet),
    totalTax: money(o.totalTaxSet),
    totalShipping: money(o.totalShippingPriceSet),
    totalPrice: money(o.totalPriceSet),
    customerId: gidToId(o.customer?.id),
    customerOrderCount: o.customer?.numberOfOrders != null ? Number(o.customer.numberOfOrders) : null,
    sourceName: text(o.sourceName),
    fulfillmentStatus: text(o.displayFulfillmentStatus)?.toLowerCase() ?? null,
    fulfilledAt: earliest((o.fulfillments ?? []).map((f) => f.createdAt)),
    discountCodes: codes(o.discountCodes ?? []),
    ...journeyTraffic(o),
    lineItems: (o.lineItems?.nodes ?? []).map((li) => ({
      shopifyId: gidToId(li.id)!,
      productShopifyId: gidToId(li.product?.id),
      variantShopifyId: gidToId(li.variant?.id),
      sku: text(li.sku),
      title: li.title ?? "",
      quantity: li.quantity ?? 0,
      price: money(li.originalUnitPriceSet),
      discount: money(li.totalDiscountSet),
    })),
    sales: o.agreements ? normalizeGraphqlSales(o.agreements.nodes) : null,
    provisionalSales: null,
    salesKey: null,
  };
}

export function normalizeGraphqlProduct(p: GraphqlProduct): NormalizedProduct {
  return {
    shopifyId: gidToId(p.id)!,
    title: p.title ?? "",
    status: text(p.status)?.toLowerCase() ?? null,
    vendor: text(p.vendor),
    productType: text(p.productType),
    createdAt: p.createdAt ? date(p.createdAt) : null,
    updatedAt: date(p.updatedAt),
  };
}

/** products/create|update webhook payload. */
export function normalizeRestProduct(p: RestProduct): NormalizedProduct {
  return {
    shopifyId: String(p.id),
    title: p.title ?? "",
    status: text(p.status)?.toLowerCase() ?? null,
    vendor: text(p.vendor),
    productType: text(p.product_type),
    createdAt: p.created_at ? date(p.created_at) : null,
    updatedAt: p.updated_at ? date(p.updated_at) : new Date(),
  };
}

export function normalizeGraphqlVariant(v: GraphqlVariant): NormalizedVariant {
  // inventoryItem withheld (null) or not requested (undefined): we know nothing about cost/tracking.
  const item = v.inventoryItem;
  const qty = v.inventoryQuantity ?? null;
  const productShopifyId = gidToId(v.product.id);
  if (!productShopifyId) throw new Error(`Variant ${v.id} has no product id`);
  return {
    shopifyId: gidToId(v.id)!,
    productShopifyId,
    title: v.title ?? "",
    sku: text(v.sku),
    price: num(v.price),
    inventoryQuantity: item?.tracked === false ? null : qty,
    unitCost: item ? (item.unitCost?.amount != null ? num(item.unitCost.amount) : null) : undefined,
    updatedAt: date(v.updatedAt),
  };
}

/**
 * One entry of a REST product payload's `variants[]`. REST payloads carry no cost, so
 * `unitCost` stays undefined (persistence keeps the cost the GraphQL sync stored).
 */
export function normalizeRestVariant(v: RestVariant, product?: RestProduct): NormalizedVariant {
  const productId = v.product_id ?? product?.id;
  if (productId === null || productId === undefined) throw new Error(`Variant ${v.id} has no product id`);
  const qty = v.inventory_quantity ?? undefined;
  // Older payloads say whether stock is tracked (inventory_management: "shopify" | null). Newer
  // ones (API 2024-07+) usually leave the field out, so tracking is then unknown.
  const hasTracking = "inventory_management" in v;
  const untracked = hasTracking && !v.inventory_management;
  const updated = v.updated_at ?? product?.updated_at;
  return {
    shopifyId: String(v.id),
    productShopifyId: String(productId),
    title: v.title ?? "",
    sku: text(v.sku),
    price: num(v.price),
    inventoryQuantity: untracked ? null : qty,
    ...(!hasTracking && qty !== undefined ? { trackingUnknown: true } : {}),
    unitCost: undefined,
    updatedAt: updated ? date(updated) : new Date(),
  };
}

export function normalizeRestProductVariants(p: RestProduct): NormalizedVariant[] {
  return (p.variants ?? []).map((v) => normalizeRestVariant(v, p));
}

// ---------------------------------------------------------------- queries
//
// Shopify rejects a query whose *requested* cost exceeds 1000 points (MAX_COST_EXCEEDED).
// Requested cost model: scalar/enum = 0, object = 1, connection = 2 + first × (cost of one
// node, the node object included), list field with `first` = first × (cost of one element);
// nested costs multiply. A MoneyBag `xxxSet { shopMoney { amount } }` = 1 + 1 = 2.
// `pageInfo` is counted as one more object (conservative; Shopify may fold it into the 2).
// packages/core/test/queryCost.ts re-derives every number below from the query text.

/** Default page sizes for the paginated sync kinds (overridable per message via SyncJobData.pageSize). */
export const PAGE_SIZE = { orders: 5, products: 100, variants: 100 } as const;

/**
 * Truncation limits of the nested selections in ordersQuery(); see graphqlOrderOverflow(). Most
 * orders have one agreement (placed) or two (and a refund), with a sale per item plus shipping.
 */
export const ORDER_NESTED = { lineItems: 5, agreements: 2, sales: 6 } as const;

/** Page sizes of the per-order detail queries used when an order overflows ORDER_NESTED. */
export const ORDER_DETAIL = { lineItems: 100, sales: 100 } as const;

/**
 * The visit that ended in the order (Order.customerJourneySummary.lastVisit; read_orders is enough).
 * Cost: customerJourneySummary 1 + lastVisit 1 + utmParameters 1 = 3 (the rest are scalars).
 */
const VISIT_FIELDS = /* GraphQL */ `source sourceType referrerUrl landingPage utmParameters { source medium campaign }`;

// LineItem node: 1 (LineItem) + variant 1 + product 1 + originalUnitPriceSet 2 + totalDiscountSet 2 = 7
const LINE_ITEM_FIELDS = /* GraphQL */ `
  id title quantity sku
  variant { id }
  product { id }
  originalUnitPriceSet { shopMoney { amount } }
  totalDiscountSet { shopMoney { amount } }`;

/**
 * A sale of an agreement (Order.agreements → sales): Shopify's record of a line sold, returned or
 * changed, which its reports add up. Sale node: 1 (Sale) + 3 MoneyBags × 2 + lineItem 1 = 8.
 */
const SALE_FIELDS = /* GraphQL */ `
  id actionType lineType quantity
  totalAmount { shopMoney { amount } }
  totalDiscountAmountBeforeTaxes { shopMoney { amount } }
  totalTaxAmount { shopMoney { amount } }
  ... on ProductSale { lineItem { id } }`;

/**
 * Orders page. Cost per Order node:
 *   1 (Order) + 5 MoneyBags × 2 = 10 + customer { id numberOfOrders } 1 (only with read_customers)
 *   + customerJourneySummary { lastVisit { utmParameters } } 3
 *   + fulfillments(first: 1) = 1 × 1 = 1
 *   + lineItems(first: 5) = 2 + 1 (pageInfo) + 5 × 7 = 38
 *   + agreements(first: 2) = 2 + 1 (pageInfo) + 2 × (1 (agreement) + sales(first: 6) = 2 + 1 (pageInfo) + 6 × 8 = 51) = 107
 *   = 161 with customer (160 without).
 * orders(first: $first) = 2 + 1 (pageInfo) + $first × 161:
 *   $first = 5 → 3 + 805 = 808 (803 without customer) ≤ 900;  6 → 969, too close to the 1000 cap.
 * Orders whose line items / sales don't fit are completed with the detail queries below.
 *
 * `reverse: true` makes the walk newest-first, and it is the single most valuable argument in
 * this file. Shopify's cost budget caps the backfill at roughly one 7-order page per 8.6s, so a
 * busy store's 60-day import takes hours however it is written; what the merchant actually
 * notices is how long the dashboard stays empty. The dashboard defaults to 7- and 30-day ranges
 * and already renders partial data, so walking oldest-first meant it showed nothing until the
 * import had crossed most of the window — the wait was mostly self-inflicted. Newest-first fills
 * the visible range within seconds and leaves the slow tail to finish unwatched.
 *
 * Nothing downstream depends on the direction: `progress` is a count, `recomputeDays` is a pure
 * function of the stored rows, and the "fully synced" transition fires on "no next page", not on
 * a date. The one exception is `upsertOrder`'s returning-customer fallback - see
 * `recomputeReturningCustomers` in persist.ts, which repairs it after the backfill.
 */
export function ordersQuery(includeCustomer: boolean): string {
  return /* GraphQL */ `
    query Orders($first: Int!, $cursor: String, $query: String) {
      orders(first: $first, after: $cursor, query: $query, sortKey: CREATED_AT, reverse: true) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id name createdAt updatedAt cancelledAt test currencyCode displayFinancialStatus
          sourceName displayFulfillmentStatus discountCodes
          customerJourneySummary { ready lastVisit { ${VISIT_FIELDS} } }
          subtotalPriceSet { shopMoney { amount } }
          totalDiscountsSet { shopMoney { amount } }
          totalTaxSet { shopMoney { amount } }
          totalShippingPriceSet { shopMoney { amount } }
          totalPriceSet { shopMoney { amount } }
          ${includeCustomer ? "customer { id numberOfOrders }" : ""}
          fulfillments(first: 1) { createdAt }
          lineItems(first: ${ORDER_NESTED.lineItems}) {
            pageInfo { hasNextPage }
            nodes { ${LINE_ITEM_FIELDS} }
          }
          agreements(first: ${ORDER_NESTED.agreements}) {
            pageInfo { hasNextPage }
            nodes {
              id happenedAt
              sales(first: ${ORDER_NESTED.sales}) {
                pageInfo { hasNextPage }
                nodes { ${SALE_FIELDS} }
              }
            }
          }
        }
      }
    }`;
}

/**
 * The same orders, as a Shopify **bulk operation** query.
 *
 * Bulk operations are exempt from the query-cost budget, and that budget is the entire reason
 * the paged walk above is capped at 5 orders per request: `lineItems(first: 5)` and
 * `agreements(first: 2)` are 145 of an Order node's 161 points, so a page of 5 costs 808 of the
 * 1000 Shopify allows in one query, and the bucket refills at 100/s. A 60-day backfill of a
 * busy store therefore takes hours however carefully it is paced. Shopify runs this query
 * server-side instead and hands back one JSONL file, which turns the same import into minutes.
 *
 * Four rules shape the text, all of them Shopify's:
 *
 *  - **No pagination arguments.** `first`/`after` are rejected, which is also why the line-item
 *    truncation the paged path has to repair simply does not arise here: every connection is
 *    returned whole.
 *  - **No GraphQL variables**, so the order filter is interpolated into the query string. It
 *    comes from the same `ordersSearch()` as the paged path, so both see the same window, and
 *    it is JSON-escaped on the way in.
 *  - **Connections become separate JSONL lines** carrying `__parentId` (a sale names its
 *    agreement); plain list fields (`fulfillments`) stay inlined on the parent.
 *    `apps/worker/src/bulkOrders.ts` reassembles them into the shape `normalizeGraphqlOrder`
 *    already expects, so there is one normalizer, not two.
 *
 * Shopify refuses a connection inside a list field ("connection field within a list field"),
 * which is what the old refunds { refundLineItems } selection was. orders → agreements → sales
 * nests connections two levels deep, the most a bulk query may. If Shopify turns it down anyway,
 * `bulkOperationRunQuery` answers with `userErrors` and the caller falls back to the paged path:
 * a slow import rather than a broken one.
 */
export function bulkOrdersQuery(includeCustomer: boolean, search: string | null): string {
  const args = ["sortKey: CREATED_AT", "reverse: true"];
  if (search) args.unshift(`query: ${JSON.stringify(search)}`);
  return /* GraphQL */ `
    {
      orders(${args.join(", ")}) {
        edges {
          node {
            id name createdAt updatedAt cancelledAt test currencyCode displayFinancialStatus
            sourceName displayFulfillmentStatus discountCodes
            customerJourneySummary { ready lastVisit { ${VISIT_FIELDS} } }
            subtotalPriceSet { shopMoney { amount } }
            totalDiscountsSet { shopMoney { amount } }
            totalTaxSet { shopMoney { amount } }
            totalShippingPriceSet { shopMoney { amount } }
            totalPriceSet { shopMoney { amount } }
            ${includeCustomer ? "customer { id numberOfOrders }" : ""}
            fulfillments { createdAt }
            lineItems { edges { node { ${LINE_ITEM_FIELDS} } } }
            agreements { edges { node { id happenedAt sales { edges { node { ${SALE_FIELDS} } } } } } }
          }
        }
      }
    }`;
}

/** Start a bulk export. Only one may run per shop per app at a time. */
export const BULK_OPERATION_RUN_QUERY = /* GraphQL */ `
  mutation BulkRun($query: String!) {
    bulkOperationRunQuery(query: $query) {
      bulkOperation { id status }
      userErrors { field message code }
    }
  }
`;

/** The shop's current bulk operation for this app, whoever started it (i.e. an earlier attempt). */
export const CURRENT_BULK_OPERATION = /* GraphQL */ `
  query CurrentBulk {
    currentBulkOperation(type: QUERY) {
      id status errorCode objectCount fileSize url partialDataUrl createdAt completedAt
    }
  }
`;

/**
 * One bulk operation by id. Re-read before every ingest chunk rather than storing `url`: the
 * result link is a short-lived signed URL, so re-resolving makes expiry a non-event.
 */
export const BULK_OPERATION_NODE = /* GraphQL */ `
  query BulkNode($id: ID!) {
    node(id: $id) {
      ... on BulkOperation {
        id status errorCode objectCount fileSize url partialDataUrl createdAt completedAt
      }
    }
  }
`;

export const BULK_OPERATION_CANCEL = /* GraphQL */ `
  mutation BulkCancel($id: ID!) {
    bulkOperationCancel(id: $id) {
      bulkOperation { id status }
      userErrors { field message }
    }
  }
`;

export interface BulkOperationStatus {
  id: string;
  status: "CREATED" | "RUNNING" | "COMPLETED" | "CANCELING" | "CANCELED" | "FAILED" | "EXPIRED";
  errorCode?: string | null;
  objectCount?: string | number | null;
  url?: string | null;
  partialDataUrl?: string | null;
  createdAt?: string | null;
}

/**
 * Whether an order node from ordersQuery() was truncated: more line items than fit, more
 * agreements than fit, or an agreement with more sales than fit.
 */
export function graphqlOrderOverflow(o: Pick<GraphqlOrder, "lineItems" | "agreements">): { lineItems: boolean; sales: boolean } {
  return {
    lineItems: o.lineItems?.pageInfo?.hasNextPage === true,
    sales:
      o.agreements?.pageInfo?.hasNextPage === true ||
      (o.agreements?.nodes ?? []).some((a) => a.sales?.pageInfo?.hasNextPage === true),
  };
}

/**
 * All line items of one order, 100 per page.
 * Cost: 1 (Order) + lineItems(first: 100) = 2 + 1 (pageInfo) + 100 × 7 = 703 → 704.
 */
export const ORDER_LINE_ITEMS_QUERY = /* GraphQL */ `
  query OrderLineItems($id: ID!, $cursor: String) {
    order(id: $id) {
      lineItems(first: ${ORDER_DETAIL.lineItems}, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { ${LINE_ITEM_FIELDS} }
      }
    }
  }`;

/**
 * One order's sales, an agreement at a time: `$cursor` walks the agreements, `$salesCursor` the
 * sales of the current one when it has more than 100. Used for an order that overflows the page
 * and for the webhooks, which carry no sales. `updatedAt` dates what was read (the staleness guard).
 * Cost: 1 (Order) + agreements(first: 1) = 2 + 1 (pageInfo) + 1 × (1 (agreement)
 *   + sales(first: 100) = 2 + 1 (pageInfo) + 100 × 8 = 803) = 807 → 808.
 */
export const ORDER_SALES_QUERY = /* GraphQL */ `
  query OrderSales($id: ID!, $cursor: String, $salesCursor: String) {
    order(id: $id) {
      updatedAt
      agreements(first: 1, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id happenedAt
          sales(first: ${ORDER_DETAIL.sales}, after: $salesCursor) {
            pageInfo { hasNextPage endCursor }
            nodes { ${SALE_FIELDS} }
          }
        }
      }
    }
  }`;

/**
 * Products page. Cost: Product node = 1 (all other fields are scalars/enums);
 * products(first: $first) = 2 + 1 (pageInfo) + $first × 1 → 100 → 103.
 */
export const PRODUCTS_QUERY = /* GraphQL */ `
  query Products($first: Int!, $cursor: String) {
    products(first: $first, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { id title status vendor productType createdAt updatedAt }
    }
  }`;

/**
 * Variants page (price, stock, unit cost). Cost per ProductVariant node:
 *   1 (variant) + product 1 + inventoryItem 1 + unitCost (MoneyV2) 1 = 4.
 * productVariants(first: $first) = 2 + 1 (pageInfo) + $first × 4 → 100 → 403.
 * unitCost may be withheld (ACCESS_DENIED) → null; shopifyGraphql keeps the rest of the data.
 */
export const VARIANTS_QUERY = /* GraphQL */ `
  query Variants($first: Int!, $cursor: String) {
    productVariants(first: $first, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id title sku price inventoryQuantity updatedAt
        product { id }
        inventoryItem { tracked unitCost { amount } }
      }
    }
  }`;

export const SHOP_QUERY = /* GraphQL */ `
  query Shop { shop { name currencyCode ianaTimezone } }`;

export const WEB_PIXEL_CREATE = /* GraphQL */ `
  mutation WebPixelCreate($settings: JSON!) {
    webPixelCreate(webPixel: { settings: $settings }) {
      userErrors { field message code }
      webPixel { id }
    }
  }`;

/** This app's web pixel on the store (one per app), with the settings it was created with. */
export const WEB_PIXEL_QUERY = /* GraphQL */ `
  query WebPixel { webPixel { id settings } }`;

export const WEB_PIXEL_UPDATE = /* GraphQL */ `
  mutation WebPixelUpdate($id: ID!, $settings: JSON!) {
    webPixelUpdate(id: $id, webPixel: { settings: $settings }) {
      userErrors { field message code }
      webPixel { id }
    }
  }`;

/**
 * A recurring charge for a plan. APPLY_IMMEDIATELY: once approved it replaces the subscription in
 * force at once (Shopify cancels the old one, with a prorated credit), so a plan change never
 * leaves two charges running and the plan the app gives is the one being paid for.
 */
export const APP_SUBSCRIPTION_CREATE = /* GraphQL */ `
  mutation AppSubscriptionCreate($name: String!, $returnUrl: URL!, $amount: Decimal!, $currency: CurrencyCode!, $test: Boolean) {
    appSubscriptionCreate(
      name: $name
      returnUrl: $returnUrl
      test: $test
      replacementBehavior: APPLY_IMMEDIATELY
      lineItems: [{ plan: { appRecurringPricingDetails: { price: { amount: $amount, currencyCode: $currency } } } }]
    ) {
      userErrors { field message }
      confirmationUrl
      appSubscription { id status }
    }
  }`;

/** Whether the shop is a development store, where Shopify accepts only test charges. */
export const SHOP_PARTNER_DEVELOPMENT = /* GraphQL */ `
  query ShopPartnerDevelopment {
    shop { plan { partnerDevelopment } }
  }`;

/** Ends a charge now (a downgrade to Free). `prorate` credits the merchant for the unused days. */
export const APP_SUBSCRIPTION_CANCEL = /* GraphQL */ `
  mutation AppSubscriptionCancel($id: ID!, $prorate: Boolean) {
    appSubscriptionCancel(id: $id, prorate: $prorate) {
      userErrors { field message }
      appSubscription { id status }
    }
  }`;

/**
 * Where Shopify says the given charges stand. A charge this installation can't see comes back null:
 * one made for an earlier installation of the app, which uninstalling cancelled.
 */
export const APP_SUBSCRIPTION_STATUSES = /* GraphQL */ `
  query AppSubscriptionStatuses($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on AppSubscription { id status }
    }
  }`;

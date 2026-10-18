/**
 * Converts Shopify REST webhook payloads and Admin GraphQL nodes into one
 * internal shape. Only fields needed for KPIs are kept; customer identity is
 * reduced to an id that is hashed before storage (see persist.ts).
 *
 * The inputs have been checked against the schemas in shopifyPayloads.ts where they entered
 * (`parseShopify`), so the ids and timestamps a row needs are there and valid.
 */
import { classifyVisit, restVisit, type Traffic } from "@app/shared";
import { journeySummarySchema, parseShopify, type GraphqlMoney, type GraphqlOrder, type GraphqlProduct, type GraphqlVariant, type RestOrder, type RestProduct, type RestVariant } from "./shopifyPayloads.js";

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
  /**
   * The agreement it belongs to (Shopify's OrderActionType, lowercase): order (the order as
   * placed), order_edit, refund, return, ... Null when the source didn't say.
   */
  agreement: string | null;
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
  /**
   * When the sale happened (Order.processedAt): the date Shopify's reports put the order on. The
   * same moment as createdAt for an order placed in the store; earlier for one imported, synced
   * from POS offline or brought in by a marketplace app. createdAt when the source has none.
   */
  processedAt: Date;
  updatedAt: Date;
  cancelledAt: Date | null;
  /** A test order: never stored (Shopify's reports leave test orders out), and removed if it was. */
  test: boolean;
  /** Every item a gift card: Shopify's reports count neither the order nor its customer. */
  giftCardOnly: boolean;
  financialStatus: string | null;
  subtotal: number;
  totalDiscounts: number;
  totalTax: number;
  totalShipping: number;
  totalPrice: number;
  customerId: string | null;
  /** The customer's lifetime order count when read (Customer.numberOfOrders); null when not read. */
  customerOrderCount: number | null;
  /**
   * Shopify's position of this order in the customer's order history (1 = their first purchase,
   * CustomerJourneySummary.customerOrderIndex). Null when the source doesn't say: REST webhooks,
   * an order with no journey (POS, draft orders), or a journey not processed yet.
   */
  customerOrderIndex: number | null;
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

/** An order whose every item is a gift card (none: not one), from its line items' gift-card flags. */
const giftCardsOnly = (flags: Array<boolean | null | undefined>): boolean => flags.length > 0 && flags.every((f) => f === true);

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
  // The order's own agreement happened when the order was processed.
  const happenedAt = date(o.processed_at ?? o.created_at);
  const withTax = o.taxes_included !== true;
  const taxOf = (lines: Array<{ price?: string | number | null }> | null | undefined) => (lines ?? []).reduce((a, t) => a + num(t.price), 0);
  const items = (o.line_items ?? []).map((li): NormalizedSale => {
    const quantity = li.quantity ?? 0;
    const discount = li.discount_allocations?.length ? li.discount_allocations.reduce((a, d) => a + num(d.amount), 0) : num(li.total_discount);
    const tax = taxOf(li.tax_lines);
    return {
      shopifyId: `provisional:line:${li.id}`,
      happenedAt,
      agreement: "order",
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
      agreement: "order",
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
    processedAt: date(o.processed_at ?? o.created_at),
    updatedAt: date(o.updated_at ?? o.created_at),
    cancelledAt: o.cancelled_at ? date(o.cancelled_at) : null,
    test: o.test === true,
    giftCardOnly: giftCardsOnly((o.line_items ?? []).map((li) => li.gift_card)),
    financialStatus: o.financial_status ?? null,
    subtotal: num(o.subtotal_price),
    totalDiscounts: num(o.total_discounts),
    totalTax: num(o.total_tax),
    totalShipping: num(o.total_shipping_price_set?.shop_money?.amount),
    totalPrice: num(o.total_price),
    customerId: o.customer?.id ? String(o.customer.id) : null,
    customerOrderCount: o.customer?.orders_count ?? null,
    customerOrderIndex: null,
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
 * false`): unknown for now. Processed with no visit (POS, draft orders): that is the answer. The
 * order's position in its customer's history comes with it whenever Shopify gives one.
 */
function journeyTraffic(o: GraphqlOrder): Pick<NormalizedOrder, "traffic" | "trafficFrom" | "customerOrderIndex"> {
  const notYet = { traffic: null, trafficFrom: null, customerOrderIndex: null };
  if (!("customerJourneySummary" in o)) return notYet;
  const raw = o.customerJourneySummary;
  if (raw === null || raw === undefined) return { traffic: classifyVisit(null, text(o.sourceName)), trafficFrom: "journey", customerOrderIndex: null };
  // A journey that doesn't fit (logged) is treated like one not processed yet.
  const j = parseShopify(journeySummarySchema, raw, "GraphQL customer journey", { order: o.id });
  if (!j) return notYet;
  const customerOrderIndex = orderIndex(j.customerOrderIndex);
  if (j.ready === false) return { ...notYet, customerOrderIndex };
  return { traffic: classifyVisit(j.lastVisit ?? null, text(o.sourceName)), trafficFrom: "journey", customerOrderIndex };
}

/** A position in the customer's history, if it is one (1 or more). */
export const orderIndex = (v: string | number | null | undefined): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 ? n : null;
};

/** Shopify's enum value (PRODUCT, ADDITIONAL_FEE) as stored: lowercase, "unknown" when missing. */
const saleEnum = (v: string | null | undefined) => text(v)?.toLowerCase() ?? "unknown";

/** The sales of an order's agreements, each dated by its agreement. */
export function normalizeGraphqlSales(agreements: NonNullable<GraphqlOrder["agreements"]>["nodes"]): NormalizedSale[] {
  return (agreements ?? []).flatMap((a) =>
    (a.sales?.nodes ?? []).map((s) => ({
      shopifyId: gidToId(s.id)!,
      happenedAt: date(a.happenedAt),
      actionType: saleEnum(s.actionType),
      agreement: text(a.reason)?.toLowerCase() ?? null,
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
    processedAt: date(o.processedAt ?? o.createdAt),
    updatedAt: date(o.updatedAt ?? o.createdAt),
    cancelledAt: o.cancelledAt ? date(o.cancelledAt) : null,
    test: o.test === true,
    // Read off whole line items only: a truncated list (completed later by the detail query) could
    // hide the one item that isn't a gift card.
    giftCardOnly: o.lineItems?.pageInfo?.hasNextPage === true ? false : giftCardsOnly((o.lineItems?.nodes ?? []).map((li) => li.isGiftCard)),
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

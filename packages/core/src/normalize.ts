/**
 * Converts Shopify REST webhook payloads and Admin GraphQL nodes into one
 * internal shape. Only fields needed for KPIs are kept; customer identity is
 * reduced to an id that is hashed before storage (see persist.ts).
 */
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

export interface NormalizedRefund {
  shopifyId: string;
  createdAt: Date;
  lineSubtotal: number;
}

export interface NormalizedOrder {
  shopifyId: string;
  name: string;
  currency: string;
  createdAt: Date;
  updatedAt: Date;
  cancelledAt: Date | null;
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
  lineItems: NormalizedLineItem[];
  refunds: NormalizedRefund[];
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

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number.parseFloat(String(v ?? "0"));
  return Number.isFinite(n) ? n : 0;
};

const date = (v: unknown): Date => {
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date ${String(v)}`);
  return d;
};

/** Trimmed non-empty string, else null. */
const text = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
};

/** Earliest valid timestamp among `values`, else null. */
const earliest = (values: unknown[]): Date | null => {
  let min: Date | null = null;
  for (const v of values) {
    if (!v) continue;
    const d = new Date(String(v));
    if (Number.isNaN(d.getTime())) continue;
    if (!min || d < min) min = d;
  }
  return min;
};

const codes = (list: unknown[]): string[] => list.map(text).filter((c): c is string => c !== null);

/**
 * REST `fulfillment_status` (null | fulfilled | partial | restocked) mapped onto the
 * GraphQL displayFulfillmentStatus vocabulary used everywhere else.
 */
export function restFulfillmentStatus(v: unknown): string {
  const s = text(v)?.toLowerCase();
  if (!s) return "unfulfilled";
  if (s === "partial") return "partially_fulfilled";
  return s;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function normalizeRestRefund(r: any): NormalizedRefund {
  return {
    shopifyId: String(r.id),
    createdAt: date(r.created_at),
    lineSubtotal: (r.refund_line_items ?? []).reduce((a: number, li: any) => a + num(li.subtotal), 0),
  };
}

export function normalizeRestOrder(o: any): NormalizedOrder {
  return {
    shopifyId: String(o.id),
    name: String(o.name ?? o.id),
    currency: String(o.currency ?? "USD"),
    createdAt: date(o.created_at),
    updatedAt: date(o.updated_at ?? o.created_at),
    cancelledAt: o.cancelled_at ? date(o.cancelled_at) : null,
    financialStatus: o.financial_status ?? null,
    subtotal: num(o.subtotal_price),
    totalDiscounts: num(o.total_discounts),
    totalTax: num(o.total_tax),
    totalShipping: num(o.total_shipping_price_set?.shop_money?.amount),
    totalPrice: num(o.total_price),
    customerId: o.customer?.id ? String(o.customer.id) : null,
    customerOrderCount:
      typeof o.customer?.orders_count === "number" ? o.customer.orders_count : null,
    sourceName: text(o.source_name),
    fulfillmentStatus: restFulfillmentStatus(o.fulfillment_status),
    fulfilledAt: earliest((o.fulfillments ?? []).map((f: any) => f?.created_at)),
    discountCodes: codes((o.discount_codes ?? []).map((d: any) => d?.code)),
    lineItems: (o.line_items ?? []).map((li: any) => ({
      shopifyId: String(li.id),
      productShopifyId: li.product_id ? String(li.product_id) : null,
      variantShopifyId: li.variant_id ? String(li.variant_id) : null,
      sku: text(li.sku),
      title: String(li.title ?? ""),
      quantity: Number(li.quantity ?? 0),
      price: num(li.price),
      discount: Array.isArray(li.discount_allocations) && li.discount_allocations.length
        ? li.discount_allocations.reduce((a: number, d: any) => a + num(d.amount), 0)
        : num(li.total_discount),
    })),
    refunds: (o.refunds ?? []).map(normalizeRestRefund),
  };
}

const money = (set: any) => num(set?.shopMoney?.amount);

export function normalizeGraphqlOrder(o: any): NormalizedOrder {
  return {
    shopifyId: gidToId(o.id)!,
    name: String(o.name),
    currency: String(o.currencyCode ?? "USD"),
    createdAt: date(o.createdAt),
    updatedAt: date(o.updatedAt ?? o.createdAt),
    cancelledAt: o.cancelledAt ? date(o.cancelledAt) : null,
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
    fulfilledAt: earliest((o.fulfillments ?? []).map((f: any) => f?.createdAt)),
    discountCodes: codes(o.discountCodes ?? []),
    lineItems: (o.lineItems?.nodes ?? []).map((li: any) => ({
      shopifyId: gidToId(li.id)!,
      productShopifyId: gidToId(li.product?.id),
      variantShopifyId: gidToId(li.variant?.id),
      sku: text(li.sku),
      title: String(li.title ?? ""),
      quantity: Number(li.quantity ?? 0),
      price: money(li.originalUnitPriceSet),
      discount: money(li.totalDiscountSet),
    })),
    refunds: (o.refunds ?? []).map((r: any) => ({
      shopifyId: gidToId(r.id)!,
      createdAt: date(r.createdAt),
      lineSubtotal: (r.refundLineItems?.nodes ?? []).reduce(
        (a: number, li: any) => a + money(li.subtotalSet),
        0,
      ),
    })),
  };
}

export function normalizeGraphqlProduct(p: any): NormalizedProduct {
  return {
    shopifyId: gidToId(p.id)!,
    title: String(p.title ?? ""),
    status: text(p.status)?.toLowerCase() ?? null,
    vendor: text(p.vendor),
    productType: text(p.productType),
    createdAt: p.createdAt ? date(p.createdAt) : null,
    updatedAt: date(p.updatedAt ?? p.createdAt),
  };
}

/** products/create|update webhook payload (also used for products/delete, which only carries `id`). */
export function normalizeRestProduct(p: any): NormalizedProduct {
  return {
    shopifyId: String(p.id),
    title: String(p.title ?? ""),
    status: text(p.status)?.toLowerCase() ?? null,
    vendor: text(p.vendor),
    productType: text(p.product_type),
    createdAt: p.created_at ? date(p.created_at) : null,
    updatedAt: p.updated_at ? date(p.updated_at) : new Date(),
  };
}

export function normalizeGraphqlVariant(v: any): NormalizedVariant {
  const item = v.inventoryItem;
  // inventoryItem withheld (null) or not requested: we know nothing about cost/tracking.
  const known = item !== null && item !== undefined && typeof item === "object";
  const qty = v.inventoryQuantity === null || v.inventoryQuantity === undefined ? null : Number(v.inventoryQuantity);
  const productShopifyId = gidToId(v.product?.id);
  if (!productShopifyId) throw new Error(`Variant ${String(v.id)} has no product id`);
  return {
    shopifyId: gidToId(v.id)!,
    productShopifyId,
    title: String(v.title ?? ""),
    sku: text(v.sku),
    price: num(v.price),
    inventoryQuantity: known && item.tracked === false ? null : qty,
    unitCost: known ? (item.unitCost?.amount != null ? num(item.unitCost.amount) : null) : undefined,
    updatedAt: date(v.updatedAt),
  };
}

/**
 * One entry of a REST product payload's `variants[]`. REST payloads carry no cost, so
 * `unitCost` stays undefined (persistence keeps the cost the GraphQL sync stored).
 */
export function normalizeRestVariant(v: any, product?: any): NormalizedVariant {
  const productId = v.product_id ?? product?.id;
  if (productId === null || productId === undefined) throw new Error(`Variant ${String(v.id)} has no product id`);
  const qty = typeof v.inventory_quantity === "number" ? v.inventory_quantity : undefined;
  // Older payloads say whether stock is tracked (inventory_management: "shopify" | null). Newer
  // ones (API 2024-07+) usually leave the field out, so tracking is then unknown.
  const hasTracking = "inventory_management" in v;
  const untracked = hasTracking && !v.inventory_management;
  const updated = v.updated_at ?? product?.updated_at;
  return {
    shopifyId: String(v.id),
    productShopifyId: String(productId),
    title: String(v.title ?? ""),
    sku: text(v.sku),
    price: num(v.price),
    inventoryQuantity: untracked ? null : qty,
    ...(!hasTracking && qty !== undefined ? { trackingUnknown: true } : {}),
    unitCost: undefined,
    updatedAt: updated ? date(updated) : new Date(),
  };
}

export function normalizeRestProductVariants(p: any): NormalizedVariant[] {
  return (Array.isArray(p.variants) ? p.variants : []).map((v: any) => normalizeRestVariant(v, p));
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
export const PAGE_SIZE = { orders: 7, products: 100, variants: 100 } as const;

/** Truncation limits of the nested selections in ordersQuery(); see graphqlOrderOverflow(). */
export const ORDER_NESTED = { lineItems: 10, refunds: 2, refundLineItems: 5 } as const;

/** Page sizes of the per-order detail queries used when an order overflows ORDER_NESTED. */
export const ORDER_DETAIL = { lineItems: 100, refunds: 10, refundLineItems: 25, refundLineItemsPage: 100 } as const;

// LineItem node: 1 (LineItem) + variant 1 + product 1 + originalUnitPriceSet 2 + totalDiscountSet 2 = 7
const LINE_ITEM_FIELDS = /* GraphQL */ `
  id title quantity sku
  variant { id }
  product { id }
  originalUnitPriceSet { shopMoney { amount } }
  totalDiscountSet { shopMoney { amount } }`;

/**
 * Orders page. Cost per Order node:
 *   1 (Order) + 5 MoneyBags × 2 = 10 + customer { id numberOfOrders } 1 (only with read_customers)
 *   + fulfillments(first: 1) = 1 × 1 = 1
 *   + lineItems(first: 10) = 2 + 1 (pageInfo) + 10 × 7 = 73
 *   + refunds(first: 2) = 2 × (1 (Refund) + refundLineItems(first: 5) = 2 + 1 (pageInfo) + 5 × (1 + subtotalSet 2) = 18) = 38
 *   = 124 with customer (123 without).
 * orders(first: $first) = 2 + 1 (pageInfo) + $first × 124:
 *   $first = 7 → 3 + 868 = 871 (864 without customer) ≤ 900;  8 → 995 (too close to 1000);  9 → 1119 (rejected).
 * Orders whose line items / refunds don't fit are completed with the detail queries below.
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
          id name createdAt updatedAt cancelledAt currencyCode displayFinancialStatus
          sourceName displayFulfillmentStatus discountCodes
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
          refunds(first: ${ORDER_NESTED.refunds}) {
            id createdAt
            refundLineItems(first: ${ORDER_NESTED.refundLineItems}) {
              pageInfo { hasNextPage }
              nodes { subtotalSet { shopMoney { amount } } }
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
 * the paged walk above is capped at 7 orders per request: `lineItems(first: 10)` and
 * `refunds(first: 2)` are 111 of an Order node's 123 points, so a page of 7 costs 864 of the
 * 1000 Shopify allows in one query, and the bucket refills at 100/s. A 60-day backfill of a
 * busy store therefore takes hours however carefully it is paced. Shopify runs this query
 * server-side instead and hands back one JSONL file, which turns the same import into minutes.
 *
 * Three rules shape the text, all of them Shopify's:
 *
 *  - **No pagination arguments.** `first`/`after` are rejected, which is also why the nested
 *    truncation the paged path has to repair (`graphqlOrderOverflow`, `completeOrder`) simply
 *    does not arise here: every connection is returned whole.
 *  - **No GraphQL variables**, so the order filter is interpolated into the query string. It
 *    comes from the same `ordersSearch()` as the paged path, so both see the same window, and
 *    it is JSON-escaped on the way in.
 *  - **Connections become separate JSONL lines** carrying `__parentId`; plain list fields
 *    (`fulfillments`, `refunds`) stay inlined on the parent. `apps/worker/src/bulkOrders.ts`
 *    reassembles them into the shape `normalizeGraphqlOrder` already expects, so there is one
 *    normalizer, not two.
 *
 * Unverified against a live shop: `refundLineItems` is a connection inside the inlined
 * `refunds` list, and Shopify's limits on nesting there are not documented precisely enough to
 * be sure it is accepted. If it is not, `bulkOperationRunQuery` answers with `userErrors` and
 * the caller falls back to the paged path, so the cost of being wrong is a slow import rather
 * than a broken one. Confirm it against a development store and remove this note.
 */
export function bulkOrdersQuery(includeCustomer: boolean, search: string | null): string {
  const args = ["sortKey: CREATED_AT", "reverse: true"];
  if (search) args.unshift(`query: ${JSON.stringify(search)}`);
  return /* GraphQL */ `
    {
      orders(${args.join(", ")}) {
        edges {
          node {
            id name createdAt updatedAt cancelledAt currencyCode displayFinancialStatus
            sourceName displayFulfillmentStatus discountCodes
            subtotalPriceSet { shopMoney { amount } }
            totalDiscountsSet { shopMoney { amount } }
            totalTaxSet { shopMoney { amount } }
            totalShippingPriceSet { shopMoney { amount } }
            totalPriceSet { shopMoney { amount } }
            ${includeCustomer ? "customer { id numberOfOrders }" : ""}
            fulfillments { createdAt }
            lineItems { edges { node { ${LINE_ITEM_FIELDS} } } }
            refunds {
              id createdAt
              refundLineItems { edges { node { subtotalSet { shopMoney { amount } } } } }
            }
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
 * Whether an order node from ordersQuery() was truncated: more line items than fit, a
 * refund with more refund line items than fit, or as many refunds as requested (there
 * may be more; Order.refunds is a plain list without pageInfo).
 */
export function graphqlOrderOverflow(o: any): { lineItems: boolean; refunds: boolean } {
  const refunds: any[] = Array.isArray(o.refunds) ? o.refunds : [];
  return {
    lineItems: o.lineItems?.pageInfo?.hasNextPage === true,
    refunds:
      refunds.length >= ORDER_NESTED.refunds ||
      refunds.some((r) => r?.refundLineItems?.pageInfo?.hasNextPage === true),
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
 * Up to 10 refunds of one order with 25 refund line items each.
 * Cost: 1 (Order) + refunds(first: 10) = 10 × (1 (Refund) + refundLineItems(first: 25)
 *   = 2 + 1 (pageInfo) + 25 × (1 + subtotalSet 2) = 78) = 790 → 791.
 */
export const ORDER_REFUNDS_QUERY = /* GraphQL */ `
  query OrderRefunds($id: ID!) {
    order(id: $id) {
      refunds(first: ${ORDER_DETAIL.refunds}) {
        id createdAt
        refundLineItems(first: ${ORDER_DETAIL.refundLineItems}) {
          pageInfo { hasNextPage endCursor }
          nodes { subtotalSet { shopMoney { amount } } }
        }
      }
    }
  }`;

/**
 * Remaining refund line items of one refund (when it has more than 25).
 * Cost: 1 (Refund) + refundLineItems(first: 100) = 2 + 1 (pageInfo) + 100 × 3 = 303 → 304.
 */
export const REFUND_LINE_ITEMS_QUERY = /* GraphQL */ `
  query RefundLineItems($id: ID!, $cursor: String) {
    refund(id: $id) {
      refundLineItems(first: ${ORDER_DETAIL.refundLineItemsPage}, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { subtotalSet { shopMoney { amount } } }
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

export const APP_SUBSCRIPTION_CREATE = /* GraphQL */ `
  mutation AppSubscriptionCreate($name: String!, $returnUrl: URL!, $amount: Decimal!, $currency: CurrencyCode!, $test: Boolean) {
    appSubscriptionCreate(
      name: $name
      returnUrl: $returnUrl
      test: $test
      lineItems: [{ plan: { appRecurringPricingDetails: { price: { amount: $amount, currencyCode: $currency } } } }]
    ) {
      userErrors { field message }
      confirmationUrl
      appSubscription { id status }
    }
  }`;

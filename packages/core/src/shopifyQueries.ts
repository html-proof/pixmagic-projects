/**
 * The GraphQL documents bizinsights sends to Shopify's Admin API (orders, bulk operations,
 * products, the shop, the web pixel, billing), with the page sizes that keep each query's
 * requested cost under Shopify's limit. What comes back is read by normalize.ts.
 */
import type { GraphqlOrder, GraphqlProduct } from "./shopifyPayloads.js";

// Shopify rejects a query whose *requested* cost exceeds 1000 points (MAX_COST_EXCEEDED).
// Requested cost model: scalar/enum = 0, object = 1, connection = 2 + first × (cost of one
// node, the node object included), list field with `first` = first × (cost of one element);
// nested costs multiply. A MoneyBag `xxxSet { shopMoney { amount } }` = 1 + 1 = 2.
// `pageInfo` is counted as one more object (conservative; Shopify may fold it into the 2).
// packages/core/test/queryCost.ts re-derives every number below from the query text.

/** Default page sizes for the paginated sync kinds (overridable per message via SyncJobData.pageSize). */
export const PAGE_SIZE = { orders: 5, products: 50, variants: 100 } as const;

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
  id title quantity sku isGiftCard
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
 * a date. Whether an order is a returning customer's comes from Shopify's position of the order
 * in the customer's history, whatever order they arrive in (`settleReturningCustomers`).
 */
export function ordersQuery(includeCustomer: boolean): string {
  return /* GraphQL */ `
    query Orders($first: Int!, $cursor: String, $query: String) {
      orders(first: $first, after: $cursor, query: $query, sortKey: CREATED_AT, reverse: true) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id name createdAt processedAt updatedAt cancelledAt test currencyCode displayFinancialStatus
          sourceName displayFulfillmentStatus discountCodes
          customerJourneySummary { ready customerOrderIndex lastVisit { ${VISIT_FIELDS} } }
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
            id name createdAt processedAt updatedAt cancelledAt test currencyCode displayFinancialStatus
            sourceName displayFulfillmentStatus discountCodes
            customerJourneySummary { ready customerOrderIndex lastVisit { ${VISIT_FIELDS} } }
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

/**
 * The shop's current bulk operation for this app, whoever started it: an earlier attempt of the same
 * job, or another import's, maybe made with other fields. The worker adopts it only when Shopify
 * created it since the sync job was, and otherwise cancels one still running (adoptOrSubmit in
 * apps/worker/src/bulkOrders.ts).
 */
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
 * It also reads the order's position in its customer's history (customerJourneySummary, read_orders)
 * and, with read_customers, the customer's lifetime order count: a webhook carries neither, and they
 * decide whether the order is a new or a returning customer's (settleReturningCustomers).
 * Cost: 1 (Order) + customerJourneySummary 1 [+ customer 1] + agreements(first: 1) = 2 + 1
 *   (pageInfo) + 1 × (1 (agreement) + sales(first: 100) = 2 + 1 (pageInfo) + 100 × 8 = 803) = 807
 *   → 809, 810 with the customer.
 */
export function orderSalesQuery(includeCustomer: boolean): string {
  return /* GraphQL */ `
  query OrderSales($id: ID!, $cursor: String, $salesCursor: String) {
    order(id: $id) {
      updatedAt
      customerJourneySummary { customerOrderIndex }
      ${includeCustomer ? "customer { numberOfOrders }" : ""}
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
}

/** orderSalesQuery without the customer (a store that hasn't granted read_customers). */
export const ORDER_SALES_QUERY = orderSalesQuery(false);

/**
 * Products page, with the product information the Inventory module shows (description, tags,
 * category, featured image, collections). Cost per Product node: 1 + category 1 + featuredMedia
 * (1 + preview 1 + image 1) 3 + collections(first: 10) (2 + 1 (pageInfo) + 10 × 1) 13 = 18;
 * products(first: $first) = 2 + 1 (pageInfo) + $first × 18 → 50 → 903. That is close to the
 * 1,000 a query may ask for: add nothing here. A product in more than 10 collections has the rest
 * read with PRODUCT_COLLECTIONS_QUERY (productCollectionsOverflow), so none is left out.
 */
export const PRODUCTS_QUERY = /* GraphQL */ `
  query Products($first: Int!, $cursor: String) {
    products(first: $first, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id title status vendor productType createdAt updatedAt
        handle tags onlineStoreUrl description(truncateAt: 5000)
        category { fullName }
        featuredMedia { preview { image { url } } }
        collections(first: 10) { pageInfo { hasNextPage endCursor } nodes { id title } }
      }
    }
  }`;

/**
 * One product's collections, 250 a page: the rest of them after PRODUCTS_QUERY's first 10, and a
 * new product's (products/create payloads carry none). Cost: 1 (Product) + collections(first: 250)
 * = 2 + 1 (pageInfo) + 250 × 1 → 254.
 */
export const PRODUCT_COLLECTIONS_QUERY = /* GraphQL */ `
  query ProductCollections($id: ID!, $cursor: String) {
    product(id: $id) {
      collections(first: 250, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { id title }
      }
    }
  }`;

/** Where the rest of a products-page node's collections start (its page didn't hold them all), else null. */
export function productCollectionsOverflow(p: Pick<GraphqlProduct, "collections">): string | null {
  const info = p.collections?.pageInfo;
  return info?.hasNextPage === true && info.endCursor ? info.endCursor : null;
}

/**
 * Variants page (price, stock, unit cost, and the inventory item and details the Inventory module
 * shows). Cost per ProductVariant node: 1 (variant) + selectedOptions 1 + product 1 + inventoryItem
 * (1 + unitCost 1 + measurement (1 + weight 1)) 4 = 7.
 * productVariants(first: $first) = 2 + 1 (pageInfo) + $first × 7 → 100 → 703.
 * unitCost may be withheld (ACCESS_DENIED) → null; shopifyGraphql keeps the rest of the data.
 * `barcode` is marked deprecated in 2026-10 (still served; `barcodes` is a connection, which would
 * cost a page of its own per variant): move when Shopify retires it.
 */
export const VARIANTS_QUERY = /* GraphQL */ `
  query Variants($first: Int!, $cursor: String) {
    productVariants(first: $first, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id title sku price inventoryQuantity updatedAt
        createdAt barcode compareAtPrice taxable inventoryPolicy position
        selectedOptions { name value }
        product { id }
        inventoryItem { id tracked requiresShipping unitCost { amount } measurement { weight { value unit } } }
      }
    }
  }`;

/** The store's details: its name, currency and time zone, and when Shopify created it (where the dashboard's dates begin). */
export const SHOP_QUERY = /* GraphQL */ `
  query Shop { shop { name currencyCode ianaTimezone createdAt } }`;

/**
 * The store's first order by creation date, the one order search an import plan needs: where the
 * history to import begins (packages/core/src/orderHistory.ts). With read_all_orders it is the
 * store's first order ever; without, the oldest of the last 60 days.
 */
export const OLDEST_ORDER_QUERY = /* GraphQL */ `
  query OldestOrder { orders(first: 1, sortKey: CREATED_AT) { nodes { createdAt } } }`;

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

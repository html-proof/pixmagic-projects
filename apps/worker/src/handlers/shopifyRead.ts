/**
 * Reading a store from Shopify at the pace its rate limits allow: GraphQL pages, an order's line
 * items and sales records beyond the first page, and the reader the daily check uses (verify.ts).
 */
import type { Store } from "@app/db";
import { env, withAccessToken, gidToId, graphqlOrderOverflow, graphqlProductCollectionsSchema, logger, normalizeGraphqlCollection, normalizeGraphqlSales, ORDER_LINE_ITEMS_QUERY, parseShopify, PRODUCT_COLLECTIONS_QUERY, replaceOrderSales, storedSalesState, graphqlAgreementListSchema, graphqlOrderSchema, shopifyGraphqlWithCost, ShopifyGraphqlError, ShopifyHttpError, StoreDisconnectedError, orderSalesQuery, orderCustomerHistorySchema, orderIndex, type CustomerHistory, type GraphqlOrder, type ProductCollection, type SyncJobData } from "@app/core";
import { expandScopes } from "@app/shared";
import { AccessRevokedError, enqueueAggregate, NotApprovedError, sleep, UnrecoverableError, type WorkerDeps } from "./common.js";

/** Ceiling on the cost-budget delay we hand to the next message, in seconds. */
export const MAX_PACE_DELAY_S = 60;

/**
 * Carries Shopify's cost-budget delay between calls in one invocation.
 *
 * The delay has to be honoured *before the next call*, not after the last one. Within an
 * invocation that means sleeping - the calls that follow (a page's per-order detail fetches)
 * need the budget to have refilled. But the delay owed after the final call of an invocation
 * belongs on the next queue message instead: sleeping it here would hold one of only four
 * `insights-sync` slots doing nothing, and for the orders backfill that was most of the wall
 * clock. So `gql` pays the pending delay on the way in and records the new one on the way out,
 * and whatever is still pending when the invocation ends becomes the message's `delaySeconds`.
 */
export interface Pace {
  pendingMs: number;
}

/** Shopify's answers about the shop rather than the request (see gql). */
export const SHOP_UNAVAILABLE = new Set([402, 404, 423]);

export async function gql<T>(deps: WorkerDeps, store: Store, pace: Pace, query: string, variables?: Record<string, unknown>) {
  try {
    if (pace.pendingMs > 0) {
      await sleep(pace.pendingMs);
      pace.pendingMs = 0;
    }
    // A token swapped under this call (moved to an expiring one, rotated, reconnected) is retried with
    // the new one rather than taken for lost access.
    const { data, requiredDelayMs } = await withAccessToken(store, deps.coord, deps.fetchImpl, (accessToken) =>
      shopifyGraphqlWithCost<T>({
        shop: store.shopDomain,
        accessToken,
        apiVersion: env().SHOPIFY_API_VERSION,
        query,
        variables,
        fetchImpl: deps.fetchImpl,
      }),
    );
    pace.pendingMs = requiredDelayMs;
    return data;
  } catch (err) {
    // Not connected / auth revoked: retrying won't help.
    if (err instanceof StoreDisconnectedError) throw new AccessRevokedError(err.message);
    if (err instanceof ShopifyHttpError && (err.status === 401 || err.status === 403)) {
      logger.warn({ shop: store.shopDomain, app: store.shopifyAppKey, status: err.status, reason: err.message }, "Shopify refused the store's token");
      throw new AccessRevokedError(`Shopify rejected our access (${err.status}); merchant must reconnect`);
    }
    // The shop itself is unavailable: frozen, paused or closed (402), not found (404), locked (423).
    // That lasts days, not the minutes of the retry budget: six attempts per job only repeated the
    // same answer. The message stays Shopify's ("Shopify 402: ..."): the dashboard reads it
    // (syncProblem). Not AccessRevokedError: the store's access is fine and comes back with the shop.
    if (err instanceof ShopifyHttpError && SHOP_UNAVAILABLE.has(err.status)) throw new UnrecoverableError(err.message);
    // The app isn't approved for protected customer data: lasts until Shopify approves it, so six
    // attempts only repeated it, and the store then read as one to reconnect (production, 2026-10-18).
    if (err instanceof ShopifyGraphqlError && NOT_APPROVED.test(err.message)) {
      logger.warn({ shop: store.shopDomain, app: store.shopifyAppKey, reason: err.message }, "Shopify hasn't approved the app for protected customer data");
      throw new NotApprovedError(`Shopify hasn't approved the app for protected customer data yet: ${err.message}`);
    }
    throw err;
  }
}

/**
 * Shopify's answer to an app it hasn't approved for protected customer data ("This app is not
 * approved to access the Order object. See .../protected-customer-data ...").
 */
const NOT_APPROVED = /not approved to (access|use)|protected[- ]customer[- ]data/i;

export interface Page<N> {
  pageInfo: { hasNextPage: boolean; endCursor?: string | null };
  nodes: N[];
}
/**
 * An agreement as ORDER_SALES_QUERY returns it. Its sales stay unread here: they are checked with
 * the whole order (graphqlOrderSchema in completeOrder) or the whole list (refreshOrderSales).
 */
type RawAgreement = Record<string, unknown> & { sales?: Page<unknown> | null };

/**
 * Fetch one page of a paginated kind with `$first` = the message's page size. When
 * Shopify rejects the query as too expensive (MAX_COST_EXCEEDED) the same message
 * (same cursor and progress) is re-enqueued with half the page size and null is
 * returned; at page size 1 there is nothing left to shrink, so the job fails.
 */
export async function fetchPage<T>(
  deps: WorkerDeps,
  store: Store,
  pace: Pace,
  data: SyncJobData,
  query: string,
  defaultSize: number,
  variables: Record<string, unknown> = {},
): Promise<T | null> {
  const first = Math.max(1, Math.floor(data.pageSize ?? defaultSize));
  let d: T;
  try {
    d = await gql<T>(deps, store, pace, query, { ...variables, first, cursor: data.cursor ?? null });
  } catch (err) {
    if (!(err instanceof ShopifyGraphqlError) || !err.costExceeded) throw err;
    if (first <= 1) throw new UnrecoverableError(`Shopify ${data.kind} query exceeds the cost limit even at one item per page: ${err.message}`);
    const pageSize = Math.max(1, Math.floor(first / 2));
    logger.warn({ storeId: store.id, kind: data.kind, from: first, to: pageSize }, "shopify query too expensive; halving page size");
    await deps.queues.sync.send({ ...data, pageSize });
    return null;
  }
  // The whole collection came back null next to ACCESS_DENIED errors: Shopify withholds it from
  // apps not (yet) approved for protected customer data. Retrying can't help; say so plainly.
  const withheld = Object.entries((d ?? {}) as Record<string, unknown>).filter(([, v]) => v === null).map(([k]) => k);
  if (withheld.length) {
    throw new NotApprovedError(
      `Shopify withheld ${withheld.join(", ")} (access denied). The app needs Shopify's approval for protected customer data before it can read them.`,
    );
  }
  return d;
}

/** All line items of one order (ORDER_LINE_ITEMS_QUERY, 100 per page); null if the order is gone. */
async function fetchOrderLineItems(deps: WorkerDeps, store: Store, pace: Pace, orderId: string): Promise<unknown[] | null> {
  const nodes: unknown[] = [];
  let cursor: string | null = null;
  for (;;) {
    const d: { order: { lineItems: Page<unknown> } | null } = await gql(deps, store, pace, ORDER_LINE_ITEMS_QUERY, { id: orderId, cursor });
    if (!d.order) return null;
    nodes.push(...d.order.lineItems.nodes);
    const { hasNextPage, endCursor } = d.order.lineItems.pageInfo;
    if (!hasNextPage || !endCursor) return nodes;
    cursor = endCursor;
  }
}

/** Pages of PRODUCT_COLLECTIONS_QUERY read for one product: 1,000 collections past its products page's 10. */
export const PRODUCT_COLLECTION_PAGES = 4;

/**
 * One product's collections from `cursor` on (PRODUCT_COLLECTIONS_QUERY, 250 a page), after
 * `first` (those its products page held), so its sales count in every collection it is in (core
 * reports/collections.ts). Undefined when the product is gone or the answer doesn't fit the schema
 * (logged): the stored collections are kept. Past PRODUCT_COLLECTION_PAGES the rest are left out,
 * and that is logged.
 */
export async function readProductCollections(
  deps: WorkerDeps,
  store: Store,
  pace: Pace,
  productGid: string,
  cursor: string | null,
  first: ProductCollection[] = [],
): Promise<ProductCollection[] | undefined> {
  const out = [...first];
  for (let page = 0; page < PRODUCT_COLLECTION_PAGES; page++) {
    const raw = await gql<unknown>(deps, store, pace, PRODUCT_COLLECTIONS_QUERY, { id: productGid, cursor });
    const d = parseShopify(graphqlProductCollectionsSchema, raw, "GraphQL product collections", { storeId: store.id, product: gidToId(productGid) });
    if (!d?.product) return undefined;
    out.push(...d.product.collections.nodes.map(normalizeGraphqlCollection));
    const info = d.product.collections.pageInfo;
    if (!info?.hasNextPage || !info.endCursor) return out;
    cursor = info.endCursor;
  }
  logger.warn({ storeId: store.id, product: gidToId(productGid), collections: out.length }, "product is in more collections than are read; the rest are left out");
  return out;
}

/**
 * All agreements of one order with all of their sales (orderSalesQuery, an agreement at a time,
 * a hundred sales at a time), the order's updated_at as Shopify answered, and what Shopify says
 * about the customer's history (`history`); null if the order is gone.
 */
async function fetchOrderAgreements(
  deps: WorkerDeps,
  store: Store,
  pace: Pace,
  orderId: string,
): Promise<{ updatedAt: string; agreements: unknown[]; history: CustomerHistory } | null> {
  const agreements: unknown[] = [];
  let updatedAt: string | null = null;
  let history: CustomerHistory | null = null;
  let cursor: string | null = null;
  const query = orderSalesQuery(expandScopes(store.grantedScopes).has("read_customers"));
  for (;;) {
    let current: RawAgreement | null = null;
    const sales: unknown[] = [];
    let salesCursor: string | null = null;
    let next: Page<unknown>["pageInfo"];
    for (;;) {
      const d: { order: ({ updatedAt: string; agreements: Page<RawAgreement> } & Record<string, unknown>) | null } = await gql(deps, store, pace, query, {
        id: orderId,
        cursor,
        salesCursor,
      });
      if (!d.order) return null;
      updatedAt ??= d.order.updatedAt;
      history ??= customerHistory(d.order, store.id);
      next = d.order.agreements.pageInfo;
      const a = d.order.agreements.nodes[0];
      if (!a) break;
      current ??= a;
      sales.push(...(a.sales?.nodes ?? []));
      const info = a.sales?.pageInfo;
      if (!info?.hasNextPage || !info.endCursor) break;
      salesCursor = info.endCursor;
    }
    if (current) agreements.push({ ...current, sales: { nodes: sales } });
    if (!next.hasNextPage || !next.endCursor) {
      return { updatedAt: updatedAt ?? new Date().toISOString(), agreements, history: history ?? { customerOrderIndex: null, customerOrderCount: null } };
    }
    cursor = next.endCursor;
  }
}

/** The customer history fields of an orderSalesQuery answer; what doesn't fit is dropped (logged), never the sales. */
function customerHistory(order: Record<string, unknown>, storeId: string): CustomerHistory {
  const h = parseShopify(orderCustomerHistorySchema, order, "GraphQL order customer history", { storeId });
  const count = h?.customer?.numberOfOrders;
  return {
    customerOrderIndex: orderIndex(h?.customerJourneySummary?.customerOrderIndex),
    customerOrderCount: count === null || count === undefined ? null : Number(count),
  };
}

/**
 * Orders pages carry at most 5 line items and 2 agreements (6 sales each) per order to stay
 * under Shopify's cost cap. Re-fetch whatever was truncated so the order is complete
 * before it is stored (upsertOrder replaces line items and sales wholesale). Null when what the
 * detail queries returned doesn't fit the schema (logged): an order missing lines must not be stored.
 */
export async function completeOrder(deps: WorkerDeps, store: Store, pace: Pace, node: GraphqlOrder): Promise<GraphqlOrder | null> {
  const over = graphqlOrderOverflow(node);
  if (!over.lineItems && !over.sales) return node;
  const full: Record<string, unknown> = { ...node };
  if (over.lineItems) {
    const nodes = await fetchOrderLineItems(deps, store, pace, node.id);
    if (nodes) full.lineItems = { nodes };
  }
  if (over.sales) {
    const read = await fetchOrderAgreements(deps, store, pace, node.id);
    if (read) full.agreements = { nodes: read.agreements };
  }
  return parseShopify(graphqlOrderSchema, full, "GraphQL order", { storeId: store.id });
}

/**
 * Shopify reads for a job outside the sync chains (the check against Shopify, apps/worker/src/
 * verify.ts): the same paced, error-mapped calls, sharing one pace across the invocation.
 */
export function shopifyReader(deps: WorkerDeps, store: Store) {
  const pace: Pace = { pendingMs: 0 };
  return {
    gql: <T>(query: string, variables?: Record<string, unknown>) => gql<T>(deps, store, pace, query, variables),
    /** An orders-page node made whole (line items and sales past the page's limits); null when it doesn't fit. */
    completeOrder: (node: GraphqlOrder) => completeOrder(deps, store, pace, node),
    /** The delay Shopify's cost budget still asks for before the next call, in ms. */
    pendingMs: () => pace.pendingMs,
  };
}

/**
 * Read an order's sales from Shopify and store them, after a webhook: REST payloads carry none.
 * Skipped when the order isn't stored (a test order, or one not synced yet: the reconcile reads
 * it), and when the stored sales were read for the payload's money state already (`salesKey`, see
 * restSalesKey) unless `force`. `salesKey` undefined keeps the stored key. Returns the days to
 * recompute.
 */
async function refreshOrderSales(deps: WorkerDeps, store: Store, shopifyId: string, salesKey: string | null | undefined, force = false): Promise<Set<string>> {
  const none = new Set<string>();
  const state = await storedSalesState(store, shopifyId);
  if (!state) return none;
  if (!force && state.salesUpdatedAt && salesKey && state.salesKey === salesKey) return none;
  const read = await fetchOrderAgreements(deps, store, { pendingMs: 0 }, `gid://shopify/Order/${shopifyId}`);
  if (!read) return none;
  // All or nothing: storing some of an order's sales would understate it.
  const agreements = parseShopify(graphqlAgreementListSchema, read.agreements, "GraphQL order sales", { storeId: store.id, order: shopifyId });
  if (!agreements) return none;
  return (await replaceOrderSales(store, shopifyId, normalizeGraphqlSales(agreements), new Date(read.updatedAt), salesKey, read.history)) ?? none;
}

/**
 * `refreshOrderSales` for a webhook, whose own write (`written`: the days it touched) must reach
 * the dashboard whatever happens to the read. Shopify refusing our access, or not having approved
 * the app for protected customer data, is not this delivery's failure: the order keeps what it has
 * (its provisional sales) and the store's sync reports why. Any other failure aggregates what was
 * written and throws, for the queue to retry.
 */
export async function readSalesAfterWebhook(
  deps: WorkerDeps,
  store: Store,
  shopifyId: string,
  salesKey: string | null | undefined,
  written: Set<string>,
  force = false,
): Promise<Set<string>> {
  try {
    return await refreshOrderSales(deps, store, shopifyId, salesKey, force);
  } catch (err) {
    if (err instanceof AccessRevokedError || err instanceof NotApprovedError) {
      logger.warn({ storeId: store.id, order: shopifyId, err: err.message }, "couldn't read the order's sales from Shopify; keeping what is stored");
      return new Set();
    }
    await enqueueAggregate(deps, store.id, written);
    throw err;
  }
}

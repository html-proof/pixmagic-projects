import { runBulkOrders } from "./bulkOrders.js";
import { systemDb, type Store } from "@app/db";
import {
  applySubscriptionUpdate,
  audit,
  customerKey,
  deleteProduct,
  endBillingForStore,
  env,
  getAccessToken,
  gidToId,
  graphqlOrderOverflow,
  logger,
  normalizeGraphqlOrder,
  normalizeGraphqlProduct,
  normalizeGraphqlVariant,
  normalizeRestOrder,
  normalizeRestProduct,
  normalizeRestProductVariants,
  normalizeRestRefund,
  ORDER_DETAIL,
  ORDER_LINE_ITEMS_QUERY,
  ORDER_REFUNDS_QUERY,
  ordersQuery,
  PAGE_SIZE,
  parseShopify,
  parseShopifyList,
  PRODUCTS_QUERY,
  pruneVariants,
  purgeStoreData,
  raiseAlert,
  recordDataRequest,
  resolveAlerts,
  REFUND_LINE_ITEMS_QUERY,
  customersDataRequestSchema,
  customersRedactSchema,
  graphqlOrderSchema,
  graphqlProductSchema,
  graphqlVariantSchema,
  restOrderSchema,
  restProductDeleteSchema,
  restProductSchema,
  restRefundWebhookSchema,
  scopesUpdateSchema,
  SHOP_QUERY,
  shopifyGraphqlWithCost,
  ShopifyGraphqlError,
  ShopifyHttpError,
  StoreDisconnectedError,
  subscriptionUpdateSchema,
  syncBillingFromShopify,
  upsertOrder,
  upsertProduct,
  upsertRefund,
  upsertVariant,
  VARIANTS_QUERY,
  WEB_PIXEL_CREATE,
  WEB_PIXEL_QUERY,
  WEB_PIXEL_UPDATE,
  recomputeDays,
  bulkUpsertProducts,
  bulkUpsertVariants,
  seedScopeFollowUp,
  recomputeReturningCustomers,
  backfillDays,
  type AggregateJobData,
  type BlobStore,
  type Coord,
  ADS_RECENT_DAYS,
  ADS_RECHECK_DAYS,
  AdsApiError,
  AdsAuthError,
  enqueueAdSync,
  syncAdConnection,
  type AdsSyncData,
  type FetchLike,
  type GraphqlOrder,
  type Mailer,
  type Queues,
  type SyncJobData,
  type SyncKind,
  type WebhookJobData,
  dispatchStore,
  redactWhatsappCustomer,
  sendWhatsappMessage,
  whatsappOnShopifyEvent,
  type WhatsappJob,
  emailOnShopifyEvent,
  processBusinessEvent,
  purgeEmailStoreData,
  redactEmailCustomer,
  sendEmailMessage,
  type EmailJob,
  type SmtpConnect,
} from "@app/core";
import { expandScopes, localDay } from "@app/shared";

export interface WorkerDeps {
  coord: Coord;
  queues: Queues;
  payloads: BlobStore;
  mailer: Mailer;
  fetchImpl: FetchLike;
  /** Outbound TCP for SMTP email accounts (apps/aws/src/nodeSmtp.ts). Absent: SMTP accounts can't send. */
  smtpConnect?: SmtpConnect;
}

/** Thrown when retrying cannot help (store disconnected, access revoked). The job fails immediately. */
export class UnrecoverableError extends Error {
  override name = "UnrecoverableError";
}

/**
 * Shopify no longer accepts our credentials for the store (401/403, or no token at all): every
 * job for it will fail the same way until the merchant reconnects, whatever kind it is.
 */
export class AccessRevokedError extends UnrecoverableError {
  // Keeps the parent's `name`: logs and callers that match on "UnrecoverableError" still see one.
}

/** Shopify only exposes the last 60 days of orders without read_all_orders. */
export const BACKFILL_DAYS = 60;

/** Ceiling on the cost-budget delay we hand to the next message, in seconds. */
const MAX_PACE_DELAY_S = 60;

/** Orders a backfill aggregates page-by-page before switching to a single pass at the end. */
export const AGG_EAGER_ORDERS = 500;

/**
 * Orders search filter for a sync message. The initial backfill (no sinceDays) pulls
 * all history when the store granted read_all_orders, else the last BACKFILL_DAYS by
 * creation date; reconcile/refresh (short sinceDays) re-pull recently *updated* orders.
 */
export function ordersSearch(data: Pick<SyncJobData, "sinceDays">, grantedScopes: string[], now = Date.now()): string | null {
  if (!data.sinceDays && expandScopes(grantedScopes).has("read_all_orders")) return null;
  const since = new Date(now - (data.sinceDays ?? BACKFILL_DAYS) * 86400_000).toISOString();
  const field = data.sinceDays && data.sinceDays < BACKFILL_DAYS ? "updated_at" : "created_at";
  return `${field}:>='${since}'`;
}

async function enqueueAggregate(deps: WorkerDeps, storeId: string, days: Iterable<string>) {
  const list = [...new Set(days)].sort();
  for (let i = 0; i < list.length; i += 31) {
    const chunk = list.slice(i, i + 31);
    await deps.queues.aggregate.send({ storeId, days: chunk });
  }
}

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
interface Pace {
  pendingMs: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type PixelUserError = { code: string; message: string };

/** The ingest URL in a web pixel's settings: Shopify returns them as a JSON string (or, defensively, an object). */
export function pixelIngestUrl(settings: unknown): string | null {
  try {
    const s = typeof settings === "string" ? (JSON.parse(settings) as unknown) : settings;
    const url = s && typeof s === "object" ? (s as { ingestUrl?: unknown }).ingestUrl : null;
    return typeof url === "string" ? url : null;
  } catch {
    return null;
  }
}

async function gql<T>(deps: WorkerDeps, store: Store, pace: Pace, query: string, variables?: Record<string, unknown>) {
  try {
    if (pace.pendingMs > 0) {
      await sleep(pace.pendingMs);
      pace.pendingMs = 0;
    }
    const accessToken = await getAccessToken(store, deps.coord, deps.fetchImpl);
    const { data, requiredDelayMs } = await shopifyGraphqlWithCost<T>({
      shop: store.shopDomain,
      accessToken,
      apiVersion: env().SHOPIFY_API_VERSION,
      query,
      variables,
      fetchImpl: deps.fetchImpl,
    });
    pace.pendingMs = requiredDelayMs;
    return data;
  } catch (err) {
    // Not connected / auth revoked: retrying won't help.
    if (err instanceof StoreDisconnectedError) throw new AccessRevokedError(err.message);
    if (err instanceof ShopifyHttpError && (err.status === 401 || err.status === 403)) {
      throw new AccessRevokedError(`Shopify rejected our access (${err.status}); merchant must reconnect`);
    }
    throw err;
  }
}

// ---------------------------------------------------------------- sync

interface Page<N> {
  pageInfo: { hasNextPage: boolean; endCursor?: string | null };
  nodes: N[];
}
/**
 * A refund as ORDER_REFUNDS_QUERY returns it. The detail queries' nodes stay unread here: they are
 * checked with the whole order (graphqlOrderSchema in completeOrder) once every page is in.
 */
type RawRefund = Record<string, unknown> & { id: string; refundLineItems?: Page<unknown> | null };

/**
 * Fetch one page of a paginated kind with `$first` = the message's page size. When
 * Shopify rejects the query as too expensive (MAX_COST_EXCEEDED) the same message
 * (same cursor and progress) is re-enqueued with half the page size and null is
 * returned; at page size 1 there is nothing left to shrink, so the job fails.
 */
async function fetchPage<T>(
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
    throw new UnrecoverableError(
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

/**
 * Refunds of one order with all of their refund line items (ORDER_REFUNDS_QUERY, then
 * REFUND_LINE_ITEMS_QUERY for refunds with more than 25 lines); null if the order is gone.
 */
async function fetchOrderRefunds(deps: WorkerDeps, store: Store, pace: Pace, orderId: string): Promise<unknown[] | null> {
  const d: { order: { refunds: RawRefund[] } | null } = await gql(deps, store, pace, ORDER_REFUNDS_QUERY, { id: orderId });
  if (!d.order) return null;
  if (d.order.refunds.length >= ORDER_DETAIL.refunds) {
    // Order.refunds is a plain list (no pagination): later refunds only arrive via refunds/create webhooks.
    logger.warn({ storeId: store.id, orderId, imported: d.order.refunds.length }, "order may have more refunds than one query returns");
  }
  const refunds: unknown[] = [];
  for (const r of d.order.refunds) {
    const items: unknown[] = [...(r.refundLineItems?.nodes ?? [])];
    let info: Page<unknown>["pageInfo"] | undefined = r.refundLineItems?.pageInfo;
    while (info?.hasNextPage && info.endCursor) {
      const p: { refund: { refundLineItems: Page<unknown> } | null } = await gql(deps, store, pace, REFUND_LINE_ITEMS_QUERY, { id: r.id, cursor: info.endCursor });
      if (!p.refund) break;
      items.push(...p.refund.refundLineItems.nodes);
      info = p.refund.refundLineItems.pageInfo;
    }
    refunds.push({ ...r, refundLineItems: { nodes: items } });
  }
  return refunds;
}

/**
 * Orders pages carry at most 10 line items and 2 refunds (5 lines each) per order to stay
 * under Shopify's cost cap, and the bulk export carries refunds without their lines at all.
 * Re-fetch whatever was truncated so the order is complete
 * before it is stored (upsertOrder replaces line items wholesale). Null when what the detail
 * queries returned doesn't fit the schema (logged): an order missing lines must not be stored.
 */
async function completeOrder(deps: WorkerDeps, store: Store, pace: Pace, node: GraphqlOrder): Promise<GraphqlOrder | null> {
  const over = graphqlOrderOverflow(node);
  if (!over.lineItems && !over.refunds) return node;
  const full: Record<string, unknown> = { ...node };
  if (over.lineItems) {
    const nodes = await fetchOrderLineItems(deps, store, pace, node.id);
    if (nodes) full.lineItems = { nodes };
  }
  if (over.refunds) {
    const refunds = await fetchOrderRefunds(deps, store, pace, node.id);
    if (refunds) full.refunds = refunds;
  }
  return parseShopify(graphqlOrderSchema, full, "GraphQL order", { storeId: store.id });
}

/**
 * One sync step. Paginated kinds (products, variants, orders) process a single page
 * per queue message and re-enqueue themselves with the next cursor, so a large
 * store never runs into the per-invocation time limit and a failure retries
 * only the page that failed.
 */
export async function runSync(data: SyncJobData, deps: WorkerDeps) {
  const store = await systemDb.store.findUnique({ where: { id: data.storeId } });
  if (!store || store.status === "uninstalled") return { skipped: true };
  const job = await systemDb.syncJob.findUnique({ where: { id: data.syncJobId } });
  if (!job || job.status === "succeeded") return { skipped: true }; // redelivery
  if (!data.cursor) {
    const now = new Date();
    await systemDb.syncJob.update({ where: { id: job.id }, data: { status: "running", startedAt: now, lastActivityAt: now, attempts: { increment: 1 } } });
  }
  const pace: Pace = { pendingMs: 0 };
  // Whatever delay is still owed after this page's last Shopify call rides on the next message
  // rather than being slept here. Capped so a nonsense restoreRate reading cannot park a chain.
  //
  // `pageSize` climbs back toward the default on every successful page. Halving on
  // MAX_COST_EXCEEDED used to be permanent - the reduced size rides in the message, so one
  // transient rejection pinned the whole rest of the chain at half speed (or a quarter, if it
  // happened twice), doubling the number of pages and therefore the number of paced waits.
  const next = (cursor: string, progress: number, defaultSize?: number) =>
    deps.queues.sync.send(
      { ...data, cursor, progress, ...(data.pageSize && defaultSize ? { pageSize: Math.min(defaultSize, data.pageSize * 2) } : {}) },
      { delaySeconds: Math.min(MAX_PACE_DELAY_S, Math.ceil(pace.pendingMs / 1000)) },
    );
  const halved = { ok: true, continued: true } as const;

  switch (data.kind) {
    case "shop": {
      const d = await gql<{ shop: { name: string; currencyCode: string; ianaTimezone: string } }>(deps, store, pace, SHOP_QUERY);
      await systemDb.store.update({ where: { id: store.id }, data: { name: d.shop.name, currency: d.shop.currencyCode, timezone: d.shop.ianaTimezone } });
      // Fan out the jobs that were waiting on the time zone. Only day-bucketed kinds wait here
      // (see NEEDS_TIMEZONE in apps/api/src/sync.ts); the catalog was enqueued at seed time and
      // is already running, so re-sending it would duplicate the work.
      //
      // Exactly the jobs seeded with this one. Every queued orders row of the store also took in
      // rows a dead chain or another connect had left behind, and started each as a competing
      // backfill. `startedAt: null` keeps a redelivered shop job from re-sending one that has
      // been picked up since; a row the watchdog gave up on before it ever started still goes.
      const pending = await systemDb.syncJob.findMany({
        where: {
          storeId: store.id,
          startedAt: null,
          ...(data.waitingJobIds
            ? { id: { in: data.waitingJobIds } }
            : // Sent before the ids were carried: the orders rows seeded in the same breath as this job.
              { kind: "orders", createdAt: { gte: job.createdAt, lt: new Date(job.createdAt.getTime() + 60_000) } }),
        },
      });
      for (const j of pending) {
        await deps.queues.sync.send({ storeId: store.id, kind: j.kind as SyncJobData["kind"], syncJobId: j.id });
      }
      break;
    }
    case "products": {
      const d = await fetchPage<{ products: Page<unknown> }>(deps, store, pace, data, PRODUCTS_QUERY, PAGE_SIZE.products);
      if (!d) return halved;
      const products = parseShopifyList(graphqlProductSchema, d.products.nodes, "GraphQL product", { storeId: store.id });
      await bulkUpsertProducts(store, products.map(normalizeGraphqlProduct));
      const n = (data.progress ?? 0) + d.products.nodes.length;
      await systemDb.syncJob.update({ where: { id: data.syncJobId }, data: { progress: n, lastActivityAt: new Date() } });
      if (d.products.pageInfo.hasNextPage && d.products.pageInfo.endCursor) {
        await next(d.products.pageInfo.endCursor, n, PAGE_SIZE.products);
        return { ok: true, continued: true };
      }
      break;
    }
    case "variants": {
      const d = await fetchPage<{ productVariants: Page<unknown> }>(deps, store, pace, data, VARIANTS_QUERY, PAGE_SIZE.variants);
      if (!d) return halved;
      const variants = parseShopifyList(graphqlVariantSchema, d.productVariants.nodes, "GraphQL variant", { storeId: store.id });
      await bulkUpsertVariants(store, variants.map(normalizeGraphqlVariant));
      const n = (data.progress ?? 0) + d.productVariants.nodes.length;
      await systemDb.syncJob.update({ where: { id: data.syncJobId }, data: { progress: n, lastActivityAt: new Date() } });
      if (d.productVariants.pageInfo.hasNextPage && d.productVariants.pageInfo.endCursor) {
        await next(d.productVariants.pageInfo.endCursor, n, PAGE_SIZE.variants);
        return { ok: true, continued: true };
      }
      break;
    }
    case "orders": {
      // Shared by both paths: everything is in, so settle the returning-customer guesses,
      // aggregate every day once, and only then call the store fully synced.
      const finishBackfill = async () => {
        if (!data.sinceDays) {
          // enqueueAggregate chunks at 31 days, so a 60-day window is two messages rather than
          // the ~1,400 a per-page backfill would have sent.
          await recomputeReturningCustomers(store.id);
          await enqueueAggregate(deps, store.id, await backfillDays(store.id));
        }
        // Only a full backfill (or a refresh of a store that already had one) means "fully
        // synced". A 3-day reconcile finishing on a store whose backfill failed must not hide
        // that failure: lastSyncedAt stays null, so "Refresh data" re-runs the full import.
        if (!data.sinceDays || store.lastSyncedAt) {
          await systemDb.store.update({ where: { id: store.id }, data: { status: "active", lastSyncedAt: new Date() } });
        }
      };

      // A first backfill goes through Shopify's Bulk Operations API, which is exempt from the
      // query-cost budget that caps the paged walk at ~7 orders per 8.6s. Short `sinceDays`
      // jobs (reconcile/refresh) stay paged: a handful of pages, where submitting an export and
      // polling for it would be slower. `pagedOnly` is set once bulk has failed for this job.
      if (!data.sinceDays && !data.pagedOnly) {
        const r = await runBulkOrders(data, store, deps, {
          gql: (query, variables) => gql(deps, store, pace, query, variables),
          ordersSearch: () => ordersSearch(data, store.grantedScopes),
          completeOrder: (node) => completeOrder(deps, store, pace, node),
        });
        if (!r.done) return { ok: true, continued: true };
        await finishBackfill();
        break;
      }

      const includeCustomer = expandScopes(store.grantedScopes).has("read_customers");
      const d = await fetchPage<{ orders: Page<unknown> }>(deps, store, pace, data, ordersQuery(includeCustomer), PAGE_SIZE.orders, {
        query: ordersSearch(data, store.grantedScopes),
      });
      if (!d) return halved;
      let n = data.progress ?? 0;
      const days = new Set<string>();
      for (const node of parseShopifyList(graphqlOrderSchema, d.orders.nodes, "GraphQL order", { storeId: store.id })) {
        const full = await completeOrder(deps, store, pace, node);
        if (!full) continue;
        for (const day of await upsertOrder(store, normalizeGraphqlOrder(full))) days.add(day);
        n++;
      }
      await systemDb.syncJob.update({ where: { id: data.syncJobId }, data: { progress: n, lastActivityAt: new Date() } });
      // A backfill aggregates its first pages eagerly and the rest once at the end. Each
      // recompute is a full rescan of the affected days, and orders arrive a few at a time, so
      // aggregating every page made a busy day's totals get rebuilt once per page touching it -
      // hundreds of times over an import, all but the last of them thrown away. The eager
      // window is what the merchant actually looks at: newest-first means those first pages are
      // the recent days the 7- and 30-day presets read, so the dashboard still lights up at
      // once. Short `sinceDays` jobs (reconcile/refresh) keep aggregating per page - a handful
      // of pages, where latency matters more than the duplicated work.
      if (!data.sinceDays && n > AGG_EAGER_ORDERS) {
        logger.debug({ storeId: store.id, orders: n }, "backfill past the eager window; aggregating at the end");
      } else {
        await enqueueAggregate(deps, store.id, days);
      }
      if (d.orders.pageInfo.hasNextPage && d.orders.pageInfo.endCursor) {
        await next(d.orders.pageInfo.endCursor, n, PAGE_SIZE.orders);
        return { ok: true, continued: true };
      }
      await finishBackfill();
      break;
    }
    case "install_pixel": {
      const ingestUrl = `${env().API_URL}/pixel/${store.pixelIngestKey}`;
      const settings = JSON.stringify({ ingestUrl });
      const d = await gql<{ webPixelCreate: { userErrors: PixelUserError[]; webPixel: { id: string } | null } }>(deps, store, pace, WEB_PIXEL_CREATE, { settings });
      const errs = d.webPixelCreate.userErrors.filter((e) => e.code !== "TAKEN");
      if (errs.length) throw new Error(`webPixelCreate: ${errs.map((e) => e.message).join("; ")}`);
      // TAKEN: the store already has our pixel, posting wherever it was told when it was made. After
      // a move to a new address (a new deployment, or a custom domain) that is the old host, which
      // would keep receiving the storefront's events for good: point it here instead.
      if (d.webPixelCreate.userErrors.length) {
        const { webPixel } = await gql<{ webPixel: { id: string; settings: unknown } | null }>(deps, store, pace, WEB_PIXEL_QUERY);
        if (webPixel && pixelIngestUrl(webPixel.settings) !== ingestUrl) {
          const u = await gql<{ webPixelUpdate: { userErrors: PixelUserError[] } }>(deps, store, pace, WEB_PIXEL_UPDATE, { id: webPixel.id, settings });
          if (u.webPixelUpdate.userErrors.length) throw new Error(`webPixelUpdate: ${u.webPixelUpdate.userErrors.map((e) => e.message).join("; ")}`);
          logger.info({ storeId: store.id }, "pointed the store's web pixel at this address");
        }
      }
      await systemDb.store.update({ where: { id: store.id }, data: { pixelInstalled: true } });
      break;
    }
  }
  await systemDb.syncJob.update({ where: { id: data.syncJobId }, data: { status: "succeeded", finishedAt: new Date(), error: null } });
  // This kind syncs again, so its failure alert is over (and the next failure gets announced).
  // Except a short orders refresh on a store whose full import never completed: that import is
  // still the open problem, and the store stays in `error` for it (see finishBackfill).
  if (!(data.kind === "orders" && data.sinceDays && !store.lastSyncedAt)) {
    await resolveAlerts(store.id, [`sync_${data.kind}_failed`, `sync_${data.kind}_stalled`]);
  }
  return { ok: true };
}

// ---------------------------------------------------------------- webhooks

/** Topics about the app installation itself (not store data). */
const APP_SCOPED_TOPICS = new Set(["app/uninstalled", "app/scopes_update", "shop/redact", "app_subscriptions/update"]);

/** How long app/scopes_update holds back the import work it queues (see that case below). */
const SCOPE_FOLLOW_UP_DELAY_S = 60;

/** REST product payloads list at most this many variants; a shorter list is complete. */
const REST_PRODUCT_VARIANT_LIMIT = 100;

/** How long a deleted product's id is remembered (covers webhook retries and late deliveries). */
const TOMBSTONE_TTL_S = 7 * 86400;
const tombstoneKey = (storeId: string, productId: string) => `tomb:product:${storeId}:${productId}`;

/** True when products/delete ran for this product recently (the marker is kept in place). */
async function deletedRecently(deps: WorkerDeps, storeId: string, productId: string): Promise<boolean> {
  const key = tombstoneKey(storeId, productId);
  // Coord has no plain read: take and put back (only this product's own webhooks touch the key).
  const mark = await deps.coord.take(key);
  if (mark === null) return false;
  await deps.coord.put(key, mark, TOMBSTONE_TTL_S);
  return true;
}

/** A GDPR request whose payload doesn't fit its schema: the fields that didn't are in the warning logged with it. */
const unreadableGdprRequest = (topic: string) => new UnrecoverableError(`Shopify's ${topic} payload couldn't be read, so the request was not carried out`);

/**
 * shop/redact: erase the store. Its synced data, its WhatsApp and email records, its import jobs,
 * alerts and privacy requests go, and so does the store row itself: a later install starts from
 * nothing (a new workspace and a new claim) instead of being joined to the account that had it
 * before. A workspace made for the store that nobody ever claimed goes with it.
 */
async function eraseStore(store: Store, deps: WorkerDeps) {
  await purgeStoreData(store.id, deps.fetchImpl);
  await purgeEmailStoreData(store.id);
  // One transaction: a retry after a failure finds the store still there and does it all again.
  await systemDb.$transaction(async (tx) => {
    // A claim of the workspace takes the same lock (apps/api/src/routes/shopify.ts).
    await tx.$queryRaw`SELECT id FROM workspaces WHERE id = ${store.workspaceId} FOR UPDATE`;
    await tx.syncJob.deleteMany({ where: { storeId: store.id } });
    await tx.alert.deleteMany({ where: { storeId: store.id } });
    await tx.dataRequest.deleteMany({ where: { storeId: store.id } });
    await tx.webhookEvent.updateMany({ where: { storeId: store.id }, data: { storeId: null } });
    await tx.store.delete({ where: { id: store.id } });
    const ws = await tx.workspace.findUnique({ where: { id: store.workspaceId }, select: { awaitingClaim: true } });
    const members = await tx.membership.count({ where: { workspaceId: store.workspaceId } });
    const stores = await tx.store.count({ where: { workspaceId: store.workspaceId } });
    if (ws?.awaitingClaim && members === 0 && stores === 0) await tx.workspace.delete({ where: { id: store.workspaceId } });
  });
}

export async function processWebhook(data: WebhookJobData, deps: WorkerDeps) {
  const ev = await systemDb.webhookEvent.findUnique({ where: { id: data.eventId } });
  if (!ev || ev.status === "succeeded") {
    // Intake can queue a second copy of a delivery, each with its own blob (see
    // apps/api/src/routes/webhooks.ts). The copy that loses the race still owns one to clean up.
    if (data.payloadKey) await deps.payloads.delete(data.payloadKey).catch(() => {});
    return { skipped: true }; // idempotent
  }
  await systemDb.webhookEvent.update({ where: { id: ev.id }, data: { status: "running", attempts: { increment: 1 } } });

  const store = await systemDb.store.findUnique({ where: { shopDomain: data.shop } });
  let p: unknown = data.payload;
  if (data.payloadKey) {
    const raw = await deps.payloads.get(data.payloadKey);
    if (raw === null) throw new UnrecoverableError(`Webhook payload ${data.payloadKey} is missing`);
    p = JSON.parse(raw);
  }

  // A shop may have installed more than one of our apps: uninstall/scopes/redact events from an
  // app the store isn't connected through say nothing about this connection.
  const otherApp = !!store && !!data.app && data.app !== store.shopifyAppKey && APP_SCOPED_TOPICS.has(data.topic);
  if (!store) {
    // Unknown shop (e.g. GDPR webhook after full deletion). Nothing to do.
    logger.info({ topic: data.topic, shop: data.shop }, "webhook for unknown shop");
  } else if (otherApp) {
    logger.info({ topic: data.topic, shop: data.shop, app: data.app, storeApp: store.shopifyAppKey }, "webhook from another of our apps; ignored");
  } else {
    const logIds = { storeId: store.id, eventId: ev.id };
    switch (data.topic) {
      case "orders/create":
      case "orders/updated":
      case "orders/paid":
      case "orders/cancelled":
      case "orders/fulfilled":
      case "orders/partially_fulfilled":
      case "orders/edited": {
        if (store.status === "uninstalled") break;
        // orders/edited sends {order_edit: {...}}: refetching would need the order; reconcile job covers it.
        if (data.topic === "orders/edited") break;
        // A payload that doesn't fit is logged and skipped, not retried: a retry gets the same payload.
        const order = parseShopify(restOrderSchema, p, data.topic, logIds);
        if (!order) break;
        const days = await upsertOrder(store, normalizeRestOrder(order));
        await enqueueAggregate(deps, store.id, days);
        break;
      }
      case "refunds/create": {
        if (store.status === "uninstalled") break;
        const refund = parseShopify(restRefundWebhookSchema, p, data.topic, logIds);
        if (!refund) break;
        const days = await upsertRefund(store, String(refund.order_id), normalizeRestRefund(refund));
        // Order not synced yet: retry later (queue backoff); reconcile also catches it.
        if (!days) throw new Error(`Order ${refund.order_id} not found for refund ${refund.id}`);
        await enqueueAggregate(deps, store.id, days);
        break;
      }
      case "products/create":
      case "products/update": {
        if (store.status === "uninstalled") break;
        const payload = parseShopify(restProductSchema, p, data.topic, logIds);
        if (!payload) break;
        const product = normalizeRestProduct(payload);
        // Product ids are never reused, so anything arriving after products/delete (a late or
        // retried update) is stale and must not bring the product and its stock back.
        if (await deletedRecently(deps, store.id, product.shopifyId)) break;
        // A stale product payload carries stale variants too (it could resurrect a deleted one): skip it.
        if (!(await upsertProduct(store, product))) break;
        // Each variant also has its own updated_at guard; stock levels come with them, cost doesn't.
        const variants = normalizeRestProductVariants(payload);
        for (const v of variants) await upsertVariant(store, v);
        // Which variants still exist: `variant_gids` lists all of them (variants[] stops at 100);
        // without it, only a variants[] list shorter than that limit is known to be complete.
        const keep = payload.variant_gids
          ? payload.variant_gids.map((g) => gidToId(g.admin_graphql_api_id)).filter((id): id is string => !!id)
          : variants.length > 0 && variants.length < REST_PRODUCT_VARIANT_LIMIT
            ? variants.map((v) => v.shopifyId)
            : [];
        if (keep.length) await pruneVariants(store, product.shopifyId, keep, product.updatedAt);
        break;
      }
      case "products/delete": {
        const gone = parseShopify(restProductDeleteSchema, p, data.topic, logIds);
        if (!gone) break;
        await deleteProduct(store, String(gone.id));
        await deps.coord.put(tombstoneKey(store.id, String(gone.id)), "1", TOMBSTONE_TTL_S);
        break;
      }
      case "app/uninstalled": {
        // Shopify retries a failed delivery for up to 48 hours, and the merchant may well have
        // reinstalled in the meantime (that is the usual fix for an accidental uninstall). Applying
        // a delivery older than the current installation would wipe live tokens and disconnect a
        // working store, with nothing to put it back. Scope the write to the install it refers to.
        // `installedAt` is nullable and SQL comparisons never match NULL, so an unknown install
        // time must fall through to "apply it": failing to process a real uninstall would keep a
        // revoked merchant's tokens and data, which is worse than the stale delivery guarded here.
        const triggeredAt = data.triggeredAt ? new Date(data.triggeredAt) : null;
        const { count } = await systemDb.store.updateMany({
          where: {
            id: store.id,
            ...(triggeredAt ? { OR: [{ installedAt: null }, { installedAt: { lte: triggeredAt } }] } : {}),
          },
          data: { status: "uninstalled", uninstalledAt: new Date(), accessTokenEnc: null, refreshTokenEnc: null, accessTokenExpiresAt: null, refreshTokenExpiresAt: null },
        });
        if (count === 0) {
          logger.info(
            { topic: data.topic, shop: data.shop, storeId: store.id, triggeredAt: data.triggeredAt, installedAt: store.installedAt },
            "stale app/uninstalled predates the current installation; ignored",
          );
          // The uninstall still cancelled every charge made before it, and the reinstall may have
          // been handled before Shopify's word on them (or this delivery) arrived: ask Shopify which
          // still stand. A failure is retried with the delivery.
          if (store.accessTokenEnc && (await systemDb.subscription.count({ where: { billingStoreId: store.id } }))) {
            await syncBillingFromShopify(store, await getAccessToken(store, deps.coord, deps.fetchImpl), deps.fetchImpl);
          }
          break;
        }
        await audit({ workspaceId: store.workspaceId, action: "store.uninstalled", targetType: "store", targetId: store.id });
        // Shopify cancels an app's charges when it is uninstalled, and its app_subscriptions/update
        // saying so may never reach an app that is gone: the plan ends here.
        await endBillingForStore(store.id, "uninstalled");
        break;
      }
      case "app/scopes_update": {
        // Without a readable `current`, every scope would count as revoked: skipped instead.
        const update = parseShopify(scopesUpdateSchema, p, data.topic, logIds);
        if (!update) break;
        const raw = Array.isArray(update.current) ? update.current : update.current.split(",");
        const current = raw.map((s) => s.trim()).filter(Boolean);
        const newlyGranted = current.filter((s) => !store.grantedScopes.includes(s));
        const revoked = store.grantedScopes.filter((s) => !current.includes(s));
        // Granting a scope doesn't backfill the data it guards. Queue what the new scopes make
        // possible — and, for read_customers, necessary (see scopeFollowUpKinds). This fires
        // however the grant happened: our own request flow, or a merchant acting in their admin
        // where we never saw it, which is the case nothing else would cover.
        // Queued *before* the scopes are saved: "newly granted" is worked out against the saved
        // scopes, so saving first meant a retry after a failed queue send found nothing new and the
        // backfill was lost for good. This way a retry can at worst queue it twice (idempotent).
        // Held back a minute, because the jobs read the saved scopes when they run (an orders
        // import that ran before the save would skip the customer hash read_customers allows).
        await seedScopeFollowUp(deps, store, newlyGranted, { delaySeconds: SCOPE_FOLLOW_UP_DELAY_S });
        await systemDb.store.update({ where: { id: store.id }, data: { grantedScopes: current } });
        await audit({ workspaceId: store.workspaceId, action: "store.scopes_updated", targetId: store.id, metadata: { current, granted: newlyGranted, revoked } });
        break;
      }
      case "app_subscriptions/update": {
        const update = parseShopify(subscriptionUpdateSchema, p, data.topic, logIds);
        if (!update) break;
        const sub = update.app_subscription;
        await applySubscriptionUpdate(store.workspaceId, sub.admin_graphql_api_id, (sub.status ?? "unknown").toLowerCase());
        break;
      }
      // ---- Mandatory GDPR compliance topics ----
      // Never skipped: one that can't be read fails at once (UnrecoverableError: a retry would read
      // the same payload), so the delivery is recorded as failed and the store's webhook alert is
      // raised, instead of a request that wasn't carried out being marked as done.
      case "customers/data_request": {
        const request = parseShopify(customersDataRequestSchema, p, data.topic, logIds);
        if (!request) throw unreadableGdprRequest(data.topic);
        // Shopify asks the app to give the store owner what it holds about the customer. The
        // request is recorded (hashes only) and the owner downloads the export, compiled from the
        // live records, from Settings → Privacy requests (packages/core/src/privacy.ts).
        const customerId = request.customer?.id != null ? String(request.customer.id) : null;
        const { request: recorded, created } = await recordDataRequest(store, {
          requestId: String(request.data_request?.id ?? ev.webhookId),
          customerId,
          email: request.customer?.email,
          phone: request.customer?.phone,
          ordersRequested: (request.orders_requested ?? []).map(String),
        });
        if (created) {
          await audit({
            workspaceId: store.workspaceId,
            action: "gdpr.customer_data_request",
            targetType: "data_request",
            targetId: recorded.id,
            metadata: { customerId, ordersRequested: recorded.ordersRequested.length },
          });
        }
        // Until the owner has downloaded it. A retry after a failed alert raises it then (an open
        // alert isn't repeated, so a redelivery doesn't email twice).
        if (recorded.downloadedAt) break;
        await raiseAlert(
          {
            workspaceId: store.workspaceId,
            storeId: store.id,
            severity: "warning",
            code: "privacy_request",
            message:
              `A customer of ${store.shopDomain} asked, through Shopify, for the data bizinsights holds about them. ` +
              `Download it from Settings, Privacy requests, and send it to them: Shopify gives 30 days to answer.`,
          },
          deps.mailer,
          deps.fetchImpl,
        );
        break;
      }
      case "customers/redact": {
        // It must name the customer or their orders (customersRedactSchema): who else to redact?
        const redact = parseShopify(customersRedactSchema, p, data.topic, logIds);
        if (!redact) throw unreadableGdprRequest(data.topic);
        if (redact.customer?.id) {
          await systemDb.order.updateMany({ where: { storeId: store.id, customerKey: customerKey(store, String(redact.customer.id)) }, data: { customerKey: null } });
        }
        const whatsappRecords = await redactWhatsappCustomer(store, redact);
        // Email automations: the customer's events and the messages sent to them from this store.
        const emailRecords = await redactEmailCustomer(store, redact.customer?.email);
        // A data request for the same customer names them too (by hashes): it goes as well.
        if (redact.customer?.id != null) await systemDb.dataRequest.deleteMany({ where: { storeId: store.id, customerId: String(redact.customer.id) } });
        await audit({ workspaceId: store.workspaceId, action: "gdpr.customer_redacted", metadata: { whatsappRecords, emailRecords } });
        break;
      }
      case "shop/redact": {
        // Sent 48 hours after an uninstall. A store installed again since then is in use under
        // its new installation's grant: erasing it now would wipe a working store.
        if (store.status !== "uninstalled") {
          logger.info({ topic: data.topic, shop: data.shop, storeId: store.id, status: store.status }, "shop/redact for a store installed again since; nothing erased");
          await audit({ workspaceId: store.workspaceId, action: "gdpr.shop_redact_skipped", targetType: "store", targetId: store.id, metadata: { reason: "reinstalled" } });
          break;
        }
        await eraseStore(store, deps);
        await audit({ workspaceId: store.workspaceId, action: "gdpr.shop_redacted", targetType: "store", targetId: store.id, metadata: { shop: store.shopDomain } });
        break;
      }
      default:
        // checkouts/* and fulfillments/* are only for WhatsApp (below).
        if (!data.topic.startsWith("checkouts/") && !data.topic.startsWith("fulfillment")) logger.info({ topic: data.topic }, "unhandled webhook topic");
    }
    // WhatsApp order updates, delivery updates and cart reminders (a no-op unless the store turned them on).
    // After the analytics write, and idempotent, so a retry of this delivery repeats nothing.
    await whatsappOnShopifyEvent(store, data.topic, p, deps);
    // Email automations listening to orders and checkouts (a no-op unless one is enabled). Idempotent too.
    await emailOnShopifyEvent(store, data.topic, p, deps);
  }
  await systemDb.webhookEvent.update({ where: { id: ev.id }, data: { status: "succeeded", processedAt: new Date(), error: null } });
  if (data.payloadKey) await deps.payloads.delete(data.payloadKey).catch(() => {});
  const storeId = store?.id ?? ev.storeId;
  if (storeId) await resolveAlerts(storeId, ["webhook_failed"]);
  return { ok: true };
}

// ---------------------------------------------------------------- aggregate

export async function runAggregate(data: AggregateJobData) {
  const store = await systemDb.store.findUnique({ where: { id: data.storeId }, select: { id: true, workspaceId: true } });
  if (!store) return { skipped: true };
  await recomputeDays(store, data.days);
  return { ok: true, days: data.days.length };
}

/** Days whose recompute gave up, per store, kept in the Coordinator for the next reconcile. */
const failedAggregateKey = (storeId: string) => `agg-failed:${storeId}`;
const FAILED_AGGREGATE_TTL_S = 14 * 86400;
/** More than a backfill's worth of days is never needed: the oldest are dropped. */
const FAILED_AGGREGATE_MAX_DAYS = 400;

/**
 * Remember the days of an aggregate job that has run out of attempts. The reconcile repairs days
 * with no totals at all (see unaggregatedDays), but a day whose recompute failed keeps its old,
 * now wrong, totals and would never be looked at again; the next reconcile recomputes these too.
 */
export async function rememberFailedAggregate(deps: Pick<WorkerDeps, "coord">, data: AggregateJobData) {
  const key = failedAggregateKey(data.storeId);
  const prev = await deps.coord.take(key);
  const days = [...new Set([...(prev ? (JSON.parse(prev) as string[]) : []), ...data.days])].sort().slice(-FAILED_AGGREGATE_MAX_DAYS);
  await deps.coord.put(key, JSON.stringify(days), FAILED_AGGREGATE_TTL_S);
}

// ---------------------------------------------------------------- scheduled

/** Days of recently updated orders the daily reconcile re-pulls (at least; see reconcileOrderDays). */
export const RECONCILE_ORDER_DAYS = 3;

/**
 * How long a store is left alone once its reconcile has been enqueued.
 *
 * The reconcile runs on every quarter-hour tick, not only at 03:15: the database lives on a PC that
 * is often asleep or offline at that hour, and a once-a-day run that fails is simply gone. The lease
 * is what turns those ticks into "once a day per store": each tick reconciles exactly the stores
 * whose lease has lapsed, so a store missed by a failed run is picked up by the next tick that
 * reaches the database, and one already enqueued is never enqueued again by the tick after it
 * (or by the 03:15 trigger, which fires in the same minute). A little under a day, so a store is
 * reconciled about every 22 hours; nothing depends on the hour, and the orders window is sized
 * from the last sweep anyway. Kept in the Coordinator, which answers while Postgres does not.
 */
const RECONCILE_LEASE_MS = 22 * 3600_000;

/**
 * Days of orders a reconcile re-pulls: back past the store's last successful orders sweep, so a
 * store the reconcile could not reach for days has the whole gap re-pulled rather than only its
 * last three days (order updates whose webhooks were lost in the gap were never seen otherwise).
 *
 * `lastSyncedAt` is when the last successful orders sweep of any kind finished - the backfill,
 * "Refresh data", the dashboard's auto-refresh or a reconcile - and it is already on the store
 * row, so this costs nothing. The extra day covers that sweep's own run time (its window was set
 * when it started). Capped below BACKFILL_DAYS, where ordersSearch switches to `created_at` and
 * would stop seeing older orders updated in the gap; a store without a completed backfill (null)
 * keeps the fixed window, as its import has to be redone anyway.
 */
export function reconcileOrderDays(lastSyncedAt: Date | null, now = Date.now()): number {
  if (!lastSyncedAt) return RECONCILE_ORDER_DAYS;
  const gap = Math.ceil((now - lastSyncedAt.getTime()) / 86400_000) + 1;
  return Math.min(BACKFILL_DAYS - 1, Math.max(RECONCILE_ORDER_DAYS, gap));
}

/**
 * Days in the backfill window that have orders or refunds but no daily_store_metrics row.
 *
 * The dashboard's KPIs read only daily_store_metrics, and an aggregate message can still be lost.
 * A backfill's final aggregate is the only one most of its days ever get (a small store's bulk
 * export is a single chunk), and the store is marked synced as soon as it is enqueued; every
 * later job recomputes only the days of the orders it re-pulls. So one lost message left weeks of
 * history at zero revenue on a store that read "synced", for good. recomputeDays is a pure upsert
 * of the source tables, which makes re-running it for these days always safe, and it writes a row
 * for every day it is given (zeros included), so a day it has repaired is not found here again.
 */
async function unaggregatedDays(storeId: string, fromDay: string): Promise<string[]> {
  const rows = await systemDb.$queryRaw<Array<{ day: string }>>`
    SELECT d.day FROM (
      SELECT local_day AS day FROM orders WHERE store_id = ${storeId} AND local_day >= ${fromDay}
      UNION
      SELECT local_day AS day FROM refunds WHERE store_id = ${storeId} AND local_day >= ${fromDay}
    ) d
    WHERE NOT EXISTS (SELECT 1 FROM daily_store_metrics m WHERE m.store_id = ${storeId} AND m.day = d.day)`;
  return rows.map((r) => r.day);
}

/**
 * Run once after the app moves to a new address with a copy of the database (a new deployment,
 * or a custom domain), for every connected store:
 *
 * - `install_pixel`: a web pixel posts to the URL it was given when it was made, so every existing
 *   pixel still sends the storefront's events to the old host. The job points it here (runSync).
 * - A full orders re-import: customer hashes are keyed with CUSTOMER_HASH_KEY, which a move can't
 *   always carry over (a secret that can't be read back). The import upserts customer_key
 *   with this deployment's key and recomputes "returning", so repeat customers are recognised again.
 *
 * Safe to repeat (everything upserts), but it costs Shopify rate limit, so it is a maintenance
 * action (`{ "action": "after-move" }` on AWS), never scheduled. Returns what it queued.
 */
export async function seedAfterMove(deps: Pick<WorkerDeps, "queues">) {
  const stores = await systemDb.store.findMany({
    where: { status: { in: ["active", "syncing", "error"] } },
    select: { id: true, workspaceId: true, grantedScopes: true, pixelInstalled: true },
  });
  let jobs = 0;
  for (const s of stores) {
    const kinds: SyncKind[] = ["orders"];
    if (s.pixelInstalled || expandScopes(s.grantedScopes).has("write_pixels")) kinds.push("install_pixel");
    for (const kind of kinds) {
      const job = await systemDb.syncJob.create({ data: { workspaceId: s.workspaceId, storeId: s.id, kind } });
      // No sinceDays: the whole history carries hashes made with the old key.
      await deps.queues.sync.send({ storeId: s.id, kind, syncJobId: job.id });
      jobs++;
    }
  }
  logger.info({ stores: stores.length, jobs }, "queued the after-move repair");
  return { stores: stores.length, jobs };
}

/**
 * Daily safety net for missed webhooks and lost aggregates: re-pull recently updated orders
 * (see reconcileOrderDays) and, with read_products, the whole catalog and stock levels
 * (inventory changes don't always reach us as products/update webhooks); and recompute any day
 * in the backfill window whose daily totals are missing (see unaggregatedDays).
 *
 * Each store is gated by its own lease (RECONCILE_LEASE_MS), taken before anything is enqueued
 * and given back if enqueueing fails, so a run that stops part-way - the database dropping
 * mid-loop - neither enqueues the stores it reached a second time nor silently skips the rest:
 * the next tick does exactly those. Returns the number of stores reconciled by this call.
 */
export async function scheduleReconcile(deps: WorkerDeps) {
  // Read on every tick now, so only what is needed (not the token ciphertexts).
  const stores = await systemDb.store.findMany({
    where: { status: { in: ["active", "error"] } },
    select: { id: true, workspaceId: true, grantedScopes: true, timezone: true, lastSyncedAt: true },
  });
  const now = Date.now();
  let reconciled = 0;
  for (const s of stores) {
    const lease = `reconcile:${s.id}`;
    if (!(await deps.coord.acquire(lease, RECONCILE_LEASE_MS))) continue;
    let failedDays: string | null = null;
    try {
      // Read before anything is sent, so a failure here leaves nothing behind for the retry to duplicate.
      const unaggregated = await unaggregatedDays(s.id, localDay(new Date(now - BACKFILL_DAYS * 86400_000), s.timezone));
      // Plus the days whose recompute ran out of attempts (rememberFailedAggregate).
      failedDays = await deps.coord.take(failedAggregateKey(s.id));
      const missing = [...new Set([...unaggregated, ...(failedDays ? (JSON.parse(failedDays) as string[]) : [])])].sort();
      const sinceDays = reconcileOrderDays(s.lastSyncedAt, now);
      if (sinceDays > RECONCILE_ORDER_DAYS) logger.info({ storeId: s.id, sinceDays, lastSyncedAt: s.lastSyncedAt }, "reconcile catching up on a gap");
      const kinds: SyncKind[] = ["orders"];
      if (expandScopes(s.grantedScopes).has("read_products")) kinds.push("products", "variants");
      for (const kind of kinds) {
        const job = await systemDb.syncJob.create({ data: { workspaceId: s.workspaceId, storeId: s.id, kind } });
        await deps.queues.sync.send({ storeId: s.id, kind, syncJobId: job.id, ...(kind === "orders" ? { sinceDays } : {}) });
      }
      if (missing.length) {
        logger.warn({ storeId: s.id, days: missing.length }, "re-aggregating days that have orders but no daily totals");
        await enqueueAggregate(deps, s.id, missing);
      }
    } catch (err) {
      // Best-effort: the Coordinator does not need Postgres, but a failed release must not hide
      // the error that matters. Unreleased, the store would wait out the lease instead.
      await deps.coord.release(lease).catch(() => {});
      // Put back the failed days taken above, so the run that retries this store still sees them.
      if (failedDays) await deps.coord.put(failedAggregateKey(s.id), failedDays, FAILED_AGGREGATE_TTL_S).catch(() => {});
      throw err;
    }
    reconciled++;
  }
  return reconciled;
}

/**
 * How long a started job may go without a sign of life before the watchdog calls it dead.
 *
 * Its chain touches `lastActivityAt` on its first message, every page and every bulk step, and
 * those are minutes apart at most (the cost-budget pace, the bulk poll backoff, retry backoff).
 * `startedAt` alone could not say this: it is stamped once, so a healthy import running past
 * this long was reaped as dead.
 */
const STALE_RUNNING_MS = 30 * 60 * 1000;

/**
 * How long a job may stay queued without ever being picked up. Hours beyond any backlog (the
 * sync consumer works four messages at a time), so a row this old has lost its message.
 */
const STALE_UNSTARTED_MS = 6 * 60 * 60 * 1000;

/**
 * Fail jobs whose chain died without reporting, and unstick their store.
 *
 * `runSync` marks a job `running` and relies on `consume` to record the outcome. That holds for a
 * thrown error, but not for an invocation the runtime *kills* - a CPU or time limit, as seen in
 * production - nor for a final attempt whose bookkeeping could not reach
 * the database either. The job stays unfinished, and because a store only leaves `syncing` when a
 * backfill job finishes, the store stays `syncing` forever and the merchant is told their import
 * is still in progress indefinitely. Two pixmagic.myshopify.com jobs sat that way for 7+ hours.
 *
 * Reaped: a started job (running, or queued because an older `onFailure` rewrote a retry that
 * way) with no sign of life for STALE_RUNNING_MS, and a job never picked up in STALE_UNSTARTED_MS.
 * A younger never-started job may just be waiting behind a backlog.
 *
 * The invariant this restores: a store never stays in `syncing` on the strength of a job that
 * nothing is working on. Only then is the store moved to `error` with a critical alert - the dead
 * job was its import. Any other store has its data and is not waiting on the job: flipping it
 * reported a healthy store as broken half an hour after an outage, often after a newer sync of the
 * same kind had already succeeded.
 */
export async function failStaleJobs(deps: WorkerDeps) {
  const cutoff = new Date(Date.now() - STALE_RUNNING_MS);
  const quiet = { OR: [{ lastActivityAt: { lt: cutoff } }, { lastActivityAt: null, startedAt: { lt: cutoff } }] };
  const stale = await systemDb.syncJob.findMany({
    where: {
      OR: [
        { status: { in: ["running", "queued"] }, startedAt: { not: null }, ...quiet },
        { status: "queued", startedAt: null, createdAt: { lt: new Date(Date.now() - STALE_UNSTARTED_MS) } },
      ],
    },
  });

  let reaped = 0;
  for (const job of stale) {
    const error = job.startedAt
      ? `Sync stopped without reporting (no progress for over ${Math.round(STALE_RUNNING_MS / 60000)} minutes); the job was marked failed automatically`
      : `Sync never started (queued for over ${Math.round(STALE_UNSTARTED_MS / 3600_000)} hours); the job was marked failed automatically`;
    // Only if nothing has touched it since it was read: a chain resuming after an outage is alive.
    const { count } = await systemDb.syncJob.updateMany({
      where: { id: job.id, status: job.status, lastActivityAt: job.lastActivityAt },
      data: { status: "failed", finishedAt: new Date(), error },
    });
    if (!count) continue;
    reaped++;
    const log = { syncJobId: job.id, storeId: job.storeId, kind: job.kind, startedAt: job.startedAt, lastActivityAt: job.lastActivityAt };

    // An uninstalled store has no sync to recover and must not be dragged back into `error`.
    const store = await systemDb.store.findUnique({ where: { id: job.storeId } });
    if (!store || store.status === "uninstalled") {
      logger.warn(log, "reaped stale sync job");
      continue;
    }
    if (store.status === "syncing") {
      logger.error(log, "reaped stale sync job; its store's import is dead");
      // Conditional, so a store that finished or was uninstalled since it was read stays as it is.
      const flipped = await systemDb.store.updateMany({ where: { id: store.id, status: "syncing" }, data: { status: "error" } });
      if (!flipped.count) continue;
      await raiseAlert(
        {
          workspaceId: store.workspaceId,
          storeId: store.id,
          severity: "critical",
          code: `sync_${job.kind}_failed`,
          message: `We couldn't sync ${job.kind} for ${store.shopDomain}: ${error}`,
        },
        deps.mailer,
        deps.fetchImpl,
      );
      continue;
    }
    // A store in `error` has already been reported, and its retries re-pull this kind anyway.
    if (store.status !== "active") {
      logger.warn(log, "reaped stale sync job; store already reported");
      continue;
    }
    const newer = await systemDb.syncJob.findFirst({
      where: { storeId: job.storeId, kind: job.kind, status: "succeeded", finishedAt: { gt: job.startedAt ?? job.createdAt } },
      select: { id: true },
    });
    if (newer) {
      logger.warn({ ...log, supersededBy: newer.id }, "reaped stale sync job; a newer one already succeeded");
      continue;
    }
    // Nothing of this kind has landed since: worth telling someone, but the data the store already
    // has is no less valid, and the next refresh or the daily reconcile tries again.
    logger.warn(log, "reaped stale sync job; nothing newer has succeeded");
    await raiseAlert(
      {
        workspaceId: store.workspaceId,
        storeId: store.id,
        severity: "warning",
        code: `sync_${job.kind}_stalled`,
        message: `Syncing ${job.kind} for ${store.shopDomain} stopped without finishing, and nothing newer has completed yet. The next scheduled sync will try again.`,
      },
      deps.mailer,
      deps.fetchImpl,
    );
  }
  return reaped;
}

/** Rotate tokens that expire within the next hour so request paths rarely block on refresh. */
export async function refreshExpiringTokens(deps: WorkerDeps) {
  const soon = new Date(Date.now() + 3600_000);
  const stores = await systemDb.store.findMany({
    where: { status: { not: "uninstalled" }, accessTokenEnc: { not: null }, accessTokenExpiresAt: { lt: soon } },
  });
  for (const s of stores) {
    try {
      await getAccessToken(s, deps.coord, deps.fetchImpl, 3600_000);
    } catch (err) {
      logger.error({ err, storeId: s.id }, "token refresh failed");
    }
  }
  return stores.length;
}

// ---------------------------------------------------------------------------
// WhatsApp
// ---------------------------------------------------------------------------

/** One WhatsApp message, or a store's due messages in a batch (campaigns, catch-up). */
/** Email integrations: send one message, or run the automations for one business event. */
export async function runEmailJob(job: EmailJob, deps: WorkerDeps) {
  if (job.kind === "email_send") return { outcome: await sendEmailMessage(job.messageId, deps) };
  return processBusinessEvent(job.eventId, deps);
}

export async function runWhatsappJob(job: WhatsappJob, deps: WorkerDeps) {
  if (job.kind === "whatsapp") return { outcome: await sendWhatsappMessage(job.messageId, deps) };
  return dispatchStore(job.storeId, deps);
}

// ---------------------------------------------------------------------------
// Ad platforms (Meta Ads, Google Ads)
// ---------------------------------------------------------------------------

/**
 * Fetch one ad account's days. Access that has ended, or a request the platform refuses, won't
 * get better by retrying: the connection is marked (reconnect / error) for Settings to show, and
 * the job stops. Rate limits and outages throw on, so the queue retries with backoff.
 */
export async function runAdsSync(data: AdsSyncData, deps: WorkerDeps) {
  try {
    const res = await syncAdConnection(data.connectionId, data.since, data.until, deps.fetchImpl);
    if (!res.skipped) logger.info({ connectionId: data.connectionId, since: data.since, until: data.until, rows: res.stored }, "ad account synced");
  } catch (err) {
    if (err instanceof AdsAuthError || err instanceof AdsApiError) throw new UnrecoverableError(err.message);
    throw err;
  }
}

/** One recent-days refresh per ad account per hour, and one 30-day re-check a day. */
const ADS_RECENT_LEASE_MS = 55 * 60_000;
const ADS_RECHECK_LEASE_MS = 22 * 3600_000;
/** Spread a tick's ad syncs over a few minutes, so a busy server doesn't hit Google's and Meta's quotas in one burst. */
const ADS_SPREAD_S = 300;

/**
 * Keep connected ad accounts current. Runs on the 15-minute tick; leases make most ticks a no-op.
 * Spend for today changes all day; conversions are attributed days later, so once a day the last
 * 30 days are fetched again. Accounts waiting for a reconnect are left alone.
 */
export async function scheduleAdsSync(deps: WorkerDeps) {
  const all = await systemDb.adConnection.findMany({
    where: { enabled: true, status: { in: ["active", "error"] } },
    select: { id: true, timezone: true, storeId: true },
  });
  // A store that uninstalled the app stops pulling ad data with the tokens it left behind; they are
  // revoked when its data is purged (shop/redact), or used again if it reinstalls before that.
  const gone = new Set(
    (await systemDb.store.findMany({ where: { id: { in: [...new Set(all.map((c) => c.storeId))] }, status: "uninstalled" }, select: { id: true } })).map((s) => s.id),
  );
  const conns = all.filter((c) => !gone.has(c.storeId));
  let sent = 0;
  for (const c of conns) {
    const wide = `ads-recheck:${c.id}`;
    const recent = `ads-recent:${c.id}`;
    const lease = (await deps.coord.acquire(wide, ADS_RECHECK_LEASE_MS)) ? wide : (await deps.coord.acquire(recent, ADS_RECENT_LEASE_MS)) ? recent : null;
    if (!lease) continue;
    try {
      await enqueueAdSync(deps.queues, c, lease === wide ? ADS_RECHECK_DAYS : ADS_RECENT_DAYS, { delaySeconds: Math.floor(Math.random() * ADS_SPREAD_S) });
      sent++;
    } catch (err) {
      await deps.coord.release(lease).catch(() => {});
      throw err;
    }
  }
  return sent;
}

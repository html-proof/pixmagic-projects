import { Prisma, systemDb, type Store } from "@app/db";
import { expandScopes, hmacSha256Hex, localDay } from "@app/shared";
import { env } from "./env.js";
import { logger } from "./logger.js";
import type { NormalizedLineItem, NormalizedOrder, NormalizedProduct, NormalizedSale, NormalizedVariant } from "./normalize.js";
import { releaseAdLoginsWhere, revokeAdAccessIfUnused } from "./adConnections.js";
import type { FetchLike } from "./shopify.js";
import { deleteRetiredNangoToken, purgeLegacyWhatsappOps, purgeWhatsappStoreOps } from "./whatsapp/purge.js";

type StoreCtx = Pick<Store, "id" | "workspaceId" | "timezone" | "grantedScopes">;

const historicalLineSelect = { shopifyId: true, productShopifyId: true, variantShopifyId: true, sku: true, title: true } as const;
type HistoricalLine = Pick<NormalizedLineItem, "productShopifyId" | "variantShopifyId" | "sku" | "title">;

/** Deleted products/variants become null in GraphQL; keep identities already learned for this line. */
function retainLineHistory(line: NormalizedLineItem, before?: HistoricalLine): NormalizedLineItem {
  return { ...line, productShopifyId: line.productShopifyId ?? before?.productShopifyId ?? null,
    variantShopifyId: line.variantShopifyId ?? before?.variantShopifyId ?? null,
    sku: line.sku ?? before?.sku ?? null, title: line.title.trim() ? line.title : before?.title ?? "" };
}

/**
 * Customers are never stored; only a keyed hash scoped to the store, and only
 * when the merchant granted read_customers (the "customers" capability).
 */
export function customerKey(store: Pick<Store, "id">, customerId: string): string {
  return hmacSha256Hex(env().CUSTOMER_HASH_KEY, `${store.id}:${customerId}`);
}

/**
 * Idempotent order upsert. Older payloads (by Shopify updated_at) never
 * overwrite newer ones, so webhook redelivery / out-of-order delivery is safe.
 * Returns the set of local days whose aggregates must be recomputed.
 *
 * Sales are replaced wholesale when the payload carries them (GraphQL) and kept when it doesn't
 * (REST webhooks: the consumer reads them separately, `replaceOrderSales`), or when the stored
 * ones were read at a later state of the order than the payload's; an order whose sales were never
 * read gets the payload's provisional ones meanwhile. A test order is never stored, and one stored
 * before is removed: Shopify's reports leave test orders out.
 */
export async function upsertOrder(store: StoreCtx, o: NormalizedOrder): Promise<Set<string>> {
  if (o.test) return removeOrders(store, [o.shopifyId]);
  const days = new Set<string>();
  // The day Shopify's reports put the order on: when it was processed.
  const day = localDay(o.processedAt, store.timezone);
  const existing = await systemDb.order.findUnique({
    where: { storeId_shopifyId: { storeId: store.id, shopifyId: o.shopifyId } },
    select: { id: true, shopifyUpdatedAt: true, localDay: true, trafficSource: true },
  });
  // Where the customer came from: Shopify's processed journey replaces what's stored; a
  // webhook's landing link only fills a gap; nothing known keeps what's there.
  const traffic =
    o.traffic && (o.trafficFrom === "journey" || !existing?.trafficSource)
      ? { trafficSource: o.traffic.source, trafficMedium: o.traffic.medium, trafficCampaign: o.traffic.campaign, referrerHost: o.traffic.referrerHost }
      : {};
  if (existing && existing.shopifyUpdatedAt > o.updatedAt) {
    // A stale copy of the order: nothing else of it is written, but the journey can still be news.
    if (o.trafficFrom === "journey" && "trafficSource" in traffic) await systemDb.order.update({ where: { id: existing.id }, data: traffic });
    return days;
  }

  const withCustomers = expandScopes(store.grantedScopes).has("read_customers");
  const ck = withCustomers && o.customerId ? customerKey(store, o.customerId) : null;

  const base = {
    name: o.name,
    currency: o.currency,
    localDay: day,
    shopifyCreatedAt: o.createdAt,
    shopifyProcessedAt: o.processedAt,
    shopifyUpdatedAt: o.updatedAt,
    giftCardOnly: o.giftCardOnly,
    cancelledAt: o.cancelledAt,
    financialStatus: o.financialStatus,
    subtotal: o.subtotal,
    totalDiscounts: o.totalDiscounts,
    totalTax: o.totalTax,
    totalShipping: o.totalShipping,
    totalPrice: o.totalPrice,
    customerKey: ck,
    // What Shopify says about the customer's history, when this copy says anything (a REST webhook
    // doesn't): kept otherwise. Whether the order is a returning customer's is settled from them
    // once it is written (settleReturningCustomers).
    ...(o.customerOrderIndex !== null ? { customerOrderIndex: o.customerOrderIndex } : {}),
    ...(o.customerOrderCount !== null ? { customerOrderCount: o.customerOrderCount } : {}),
    sourceName: o.sourceName,
    fulfillmentStatus: o.fulfillmentStatus,
    fulfilledAt: o.fulfilledAt,
    discountCodes: o.discountCodes,
    ...traffic,
  };

  let stale = false;
  await systemDb.$transaction(async (tx) => {
    // The check above runs before the write. Two deliveries of one order processed at once both
    // passed it, and the older one could commit last. So: one writer per order at a time (a
    // transaction-scoped advisory lock, which also covers an order that doesn't exist yet), and
    // the check again under it.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`order:${store.id}:${o.shopifyId}`}))`;
    const current = await tx.order.findUnique({
      where: { storeId_shopifyId: { storeId: store.id, shopifyId: o.shopifyId } },
      select: { shopifyUpdatedAt: true, salesUpdatedAt: true },
    });
    if (current && current.shopifyUpdatedAt > o.updatedAt) {
      stale = true;
      return;
    }
    // The payload's sales, unless the stored ones were read at a later state (a webhook's read
    // landing while this copy was on its way); else, for an order never read, its estimate.
    const freshSales = o.sales && !(current?.salesUpdatedAt && current.salesUpdatedAt > o.updatedAt) ? o.sales : null;
    const sales = freshSales ?? (current?.salesUpdatedAt ? null : o.provisionalSales);
    const data = { ...base, ...(freshSales ? { salesUpdatedAt: o.updatedAt, salesKey: o.salesKey } : {}) };
    const order = await tx.order.upsert({
      where: { storeId_shopifyId: { storeId: store.id, shopifyId: o.shopifyId } },
      create: { ...data, workspaceId: store.workspaceId, storeId: store.id, shopifyId: o.shopifyId },
      update: data,
    });
    const previousLines = current ? await tx.orderLineItem.findMany({
      where: { workspaceId: store.workspaceId, storeId: store.id, orderId: order.id }, select: historicalLineSelect,
    }) : [];
    const previousById = new Map(previousLines.map(line => [line.shopifyId, line]));
    await tx.orderLineItem.deleteMany({ where: { orderId: order.id } });
    if (o.lineItems.length) {
      await tx.orderLineItem.createMany({
        data: o.lineItems.map(line => retainLineHistory(line, previousById.get(line.shopifyId))).map((li) => ({
          workspaceId: store.workspaceId,
          storeId: store.id,
          orderId: order.id,
          shopifyId: li.shopifyId,
          productShopifyId: li.productShopifyId,
          variantShopifyId: li.variantShopifyId,
          sku: li.sku,
          title: li.title,
          quantity: li.quantity,
          price: li.price,
          discount: li.discount,
        })),
        skipDuplicates: true,
      });
    }
    if (sales) for (const d of await writeSalesTx(tx, store, order.id, sales)) days.add(d);
  });
  if (stale) return days;

  days.add(day);
  if (existing && existing.localDay !== day) days.add(existing.localDay);
  if (ck) for (const d of await settleReturningCustomers(store.id, [ck])) days.add(d);
  return days;
}

type TxClient = Parameters<Parameters<typeof systemDb.$transaction>[0]>[0];

/** The rows of `sales` for one order, as order_sales stores them. */
function saleRows(store: StoreCtx, orderId: string, sales: NormalizedSale[]) {
  return dedupe(sales).map((x) => ({
    workspaceId: store.workspaceId,
    storeId: store.id,
    orderId,
    shopifyId: x.shopifyId,
    localDay: localDay(x.happenedAt, store.timezone),
    happenedAt: x.happenedAt,
    actionType: x.actionType,
    lineType: x.lineType,
    lineItemShopifyId: x.lineItemShopifyId,
    quantity: x.quantity,
    amount: x.amount,
    discount: x.discount,
    tax: x.tax,
  }));
}

/** Replace an order's sales with `sales`; returns the days they were and are now on. */
async function writeSalesTx(tx: TxClient, store: StoreCtx, orderId: string, sales: NormalizedSale[]) {
  const days = new Set<string>();
  const old = await tx.orderSale.findMany({ where: { orderId }, select: { localDay: true }, distinct: ["localDay"] });
  for (const r of old) days.add(r.localDay);
  await tx.orderSale.deleteMany({ where: { orderId } });
  const rows = saleRows(store, orderId, sales);
  for (const r of rows) days.add(r.localDay);
  if (rows.length) await tx.orderSale.createMany({ data: rows });
  return days;
}

/**
 * Store an order's sales read from Shopify after a webhook (REST payloads carry none). `readAt` is
 * the order's updated_at that Shopify answered with, and the staleness guard: sales already read at
 * a later state are kept. `salesKey` is the webhook payload's (`restSalesKey`), so the next delivery
 * in the same money state skips the read; undefined keeps the stored one. Returns the affected
 * days, or null when the order isn't stored (not synced yet, or a test order).
 */
export async function replaceOrderSales(
  store: StoreCtx,
  orderShopifyId: string,
  sales: NormalizedSale[],
  readAt: Date,
  salesKey: string | null | undefined,
  history: CustomerHistory = { customerOrderIndex: null, customerOrderCount: null },
): Promise<Set<string> | null> {
  const written = await systemDb.$transaction(async (tx) => {
    // One writer per order, as in upsertOrder (the same lock key).
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`order:${store.id}:${orderShopifyId}`}))`;
    const order = await tx.order.findUnique({
      where: { storeId_shopifyId: { storeId: store.id, shopifyId: orderShopifyId } },
      select: { id: true, localDay: true, salesUpdatedAt: true, customerKey: true },
    });
    if (!order) return null;
    if (order.salesUpdatedAt && order.salesUpdatedAt > readAt) return { days: new Set<string>(), customerKey: null };
    const days = await writeSalesTx(tx, store, order.id, sales);
    await tx.order.update({
      where: { id: order.id },
      data: {
        salesUpdatedAt: readAt,
        ...(salesKey !== undefined ? { salesKey } : {}),
        ...(history.customerOrderIndex !== null ? { customerOrderIndex: history.customerOrderIndex } : {}),
        ...(history.customerOrderCount !== null ? { customerOrderCount: history.customerOrderCount } : {}),
      },
    });
    days.add(order.localDay);
    return { days, customerKey: order.customerKey };
  });
  if (!written) return null;
  if (written.customerKey) for (const d of await settleReturningCustomers(store.id, [written.customerKey])) written.days.add(d);
  return written.days;
}

/** What an order read says about its customer's history (see Order.customerOrderIndex in the schema). */
export interface CustomerHistory {
  customerOrderIndex: number | null;
  customerOrderCount: number | null;
}

/** The money state the stored sales of an order were read for, or undefined when it isn't stored. */
export async function storedSalesState(store: Pick<Store, "id">, orderShopifyId: string) {
  const o = await systemDb.order.findUnique({
    where: { storeId_shopifyId: { storeId: store.id, shopifyId: orderShopifyId } },
    select: { salesUpdatedAt: true, salesKey: true },
  });
  return o ?? undefined;
}

/**
 * Delete these orders (with their line items and sales): test orders, and orders the merchant
 * deleted in Shopify, which its reports no longer count (`orders/delete`, or found gone by the
 * reconciliation). Returns the days they were on, and the days whose other orders changed from
 * new to returning customer's or back (the customer's history lost an order).
 */
export async function removeOrders(store: Pick<Store, "id">, shopifyIds: string[]): Promise<Set<string>> {
  const days = new Set<string>();
  if (!shopifyIds.length) return days;
  const rows = await systemDb.$queryRaw<Array<{ day: string; customer_key: string | null }>>`
    SELECT o.local_day AS day, o.customer_key FROM orders o WHERE o.store_id = ${store.id} AND o.shopify_id = ANY(${shopifyIds}::text[])
    UNION
    SELECT s.local_day AS day, NULL AS customer_key FROM order_sales s JOIN orders o ON o.id = s.order_id
    WHERE o.store_id = ${store.id} AND o.shopify_id = ANY(${shopifyIds}::text[])`;
  if (!rows.length) return days;
  await systemDb.order.deleteMany({ where: { storeId: store.id, shopifyId: { in: shopifyIds } } });
  for (const r of rows) days.add(r.day);
  const keys = [...new Set(rows.map((r) => r.customer_key).filter((k): k is string => !!k))];
  for (const d of await settleReturningCustomers(store.id, keys)) days.add(d);
  return days;
}

/**
 * Write many orders - with their line items and refunds - in one transaction of four
 * statements, instead of `upsertOrder`'s pre-read plus interactive transaction per order.
 *
 * `upsertOrder` costs about six round trips per order, which is fine for a webhook and
 * ruinous for an import: the bulk backfill hands this hundreds of orders at a time. The
 * guarantees are the same, expressed in SQL rather than TypeScript:
 *
 *  - the staleness guard becomes `WHERE orders.shopify_updated_at <= excluded...`, so a page
 *    that was in flight still cannot overwrite a newer webhook. Rows it skips are not returned
 *    by the upsert, which is also how we know whose line items to leave alone - no separate
 *    pre-read needed.
 *  - line items are replaced wholesale (delete then insert) inside the transaction, so an
 *    order is never visible with half its items.
 *
 * The delete and the insert are separate statements on purpose. Folding them into one
 * data-modifying CTE would be a round trip cheaper and wrong: CTE execution order is
 * unspecified, so the insert could run before the delete and collide on the unique index.
 *
 * Whether each order is a returning customer's is settled for the batch's customers in one
 * statement at the end (`settleReturningCustomers`), from Shopify's position of each order in its
 * customer's history; the import settles the whole store again once every order is in.
 *
 * Sales and test orders are handled as `upsertOrder` handles them.
 *
 * Returns the store-local days touched, for the caller to aggregate.
 */
export async function writeOrderBatch(store: StoreCtx, orders: NormalizedOrder[]): Promise<Set<string>> {
  const all = dedupe(orders);
  const days = await removeOrders(store, all.filter((o) => o.test).map((o) => o.shopifyId));
  const rows = all.filter((o) => !o.test);
  if (!rows.length) return days;

  const withCustomers = expandScopes(store.grantedScopes).has("read_customers");
  const payload = rows.map((o) => {
    const day = localDay(o.processedAt, store.timezone);
    days.add(day);
    for (const x of o.sales ?? []) days.add(localDay(x.happenedAt, store.timezone));
    return {
      shopify_id: o.shopifyId,
      name: o.name,
      currency: o.currency,
      local_day: day,
      created_at: ts(o.createdAt),
      processed_at: ts(o.processedAt),
      updated_at: ts(o.updatedAt),
      gift_card_only: o.giftCardOnly,
      cancelled_at: ts(o.cancelledAt),
      financial_status: o.financialStatus,
      subtotal: String(o.subtotal),
      total_discounts: String(o.totalDiscounts),
      total_tax: String(o.totalTax),
      total_shipping: String(o.totalShipping),
      total_price: String(o.totalPrice),
      customer_key: withCustomers && o.customerId ? customerKey(store, o.customerId) : null,
      // Provisional until settleReturningCustomers runs below, from Shopify's own position of the order.
      is_returning_customer: (o.customerOrderIndex ?? 0) > 1,
      customer_order_index: o.customerOrderIndex,
      customer_order_count: o.customerOrderCount,
      source_name: o.sourceName,
      fulfillment_status: o.fulfillmentStatus,
      fulfilled_at: ts(o.fulfilledAt),
      discount_codes: o.discountCodes,
      traffic_source: o.traffic?.source ?? null,
      traffic_medium: o.traffic?.medium ?? null,
      traffic_campaign: o.traffic?.campaign ?? null,
      referrer_host: o.traffic?.referrerHost ?? null,
      sales_updated_at: o.sales ? ts(o.updatedAt) : null,
      sales_key: o.sales ? o.salesKey : null,
    };
  });

  await systemDb.$transaction(async (tx) => {
    // When each order's stored sales were read, before this batch writes: sales read at a later
    // state than the batch's copy (a webhook's read meanwhile) are kept, as in upsertOrder. Locked,
    // so no such read lands between this look and the write.
    const held = await tx.$queryRaw<Array<{ shopify_id: string; sales_updated_at: Date | null; local_day: string }>>`
      SELECT shopify_id, sales_updated_at, local_day FROM orders
      WHERE store_id = ${store.id} AND shopify_id = ANY(${rows.map((o) => o.shopifyId)}::text[])
      FOR UPDATE`;
    const salesReadAt = new Map(held.map((r) => [r.shopify_id, r.sales_updated_at]));
    // An order can move day: one stored by its creation before its processed date was read.
    for (const r of held) days.add(r.local_day);
    const salesFresh = (o: NormalizedOrder) => {
      const readAt = salesReadAt.get(o.shopifyId);
      return !!o.sales && !(readAt && readAt > o.updatedAt);
    };
    const written = await tx.$queryRaw<Array<{ id: string; shopify_id: string }>>`
      INSERT INTO orders (id, workspace_id, store_id, shopify_id, name, currency, local_day, shopify_created_at, shopify_processed_at,
                          shopify_updated_at, gift_card_only,
                          cancelled_at, financial_status, subtotal, total_discounts, total_tax, total_shipping, total_price,
                          customer_key, is_returning_customer, source_name, fulfillment_status, fulfilled_at, discount_codes,
                          traffic_source, traffic_medium, traffic_campaign, referrer_host, sales_updated_at, sales_key,
                          customer_order_index, customer_order_count)
      SELECT gen_random_uuid()::text, ${store.workspaceId}, ${store.id}, s.shopify_id, s.name, s.currency, s.local_day,
             (s.created_at)::timestamptz AT TIME ZONE 'UTC', (s.processed_at)::timestamptz AT TIME ZONE 'UTC',
             (s.updated_at)::timestamptz AT TIME ZONE 'UTC', s.gift_card_only,
             (s.cancelled_at)::timestamptz AT TIME ZONE 'UTC', s.financial_status,
             s.subtotal::numeric, s.total_discounts::numeric, s.total_tax::numeric, s.total_shipping::numeric, s.total_price::numeric,
             s.customer_key, s.is_returning_customer, s.source_name, s.fulfillment_status,
             (s.fulfilled_at)::timestamptz AT TIME ZONE 'UTC', s.discount_codes,
             s.traffic_source, s.traffic_medium, s.traffic_campaign, s.referrer_host,
             (s.sales_updated_at)::timestamptz AT TIME ZONE 'UTC', s.sales_key,
             s.customer_order_index, s.customer_order_count
      FROM jsonb_to_recordset(${JSON.stringify(payload)}::jsonb) AS s(
        shopify_id text, name text, currency text, local_day text, created_at text, processed_at text, updated_at text,
        gift_card_only boolean, cancelled_at text, financial_status text, subtotal text, total_discounts text, total_tax text,
        total_shipping text, total_price text,
        customer_key text, is_returning_customer boolean, source_name text, fulfillment_status text, fulfilled_at text,
        discount_codes text[], traffic_source text, traffic_medium text, traffic_campaign text, referrer_host text,
        sales_updated_at text, sales_key text, customer_order_index int, customer_order_count int
      )
      ON CONFLICT (store_id, shopify_id) DO UPDATE SET
        name = EXCLUDED.name, currency = EXCLUDED.currency, local_day = EXCLUDED.local_day,
        shopify_created_at = EXCLUDED.shopify_created_at, shopify_processed_at = EXCLUDED.shopify_processed_at,
        shopify_updated_at = EXCLUDED.shopify_updated_at, gift_card_only = EXCLUDED.gift_card_only,
        cancelled_at = EXCLUDED.cancelled_at, financial_status = EXCLUDED.financial_status,
        subtotal = EXCLUDED.subtotal, total_discounts = EXCLUDED.total_discounts, total_tax = EXCLUDED.total_tax,
        total_shipping = EXCLUDED.total_shipping, total_price = EXCLUDED.total_price,
        customer_key = EXCLUDED.customer_key,
        -- Settled for the batch's customers after this (settleReturningCustomers); a copy that
        -- says nothing about the customer's history keeps what was known.
        customer_order_index = COALESCE(EXCLUDED.customer_order_index, orders.customer_order_index),
        customer_order_count = COALESCE(EXCLUDED.customer_order_count, orders.customer_order_count),
        source_name = EXCLUDED.source_name, fulfillment_status = EXCLUDED.fulfillment_status,
        fulfilled_at = EXCLUDED.fulfilled_at, discount_codes = EXCLUDED.discount_codes,
        -- The bulk export carries Shopify's journey; while it isn't processed yet (null), keep what's known.
        traffic_source = COALESCE(EXCLUDED.traffic_source, orders.traffic_source),
        traffic_medium = CASE WHEN EXCLUDED.traffic_source IS NULL THEN orders.traffic_medium ELSE EXCLUDED.traffic_medium END,
        traffic_campaign = CASE WHEN EXCLUDED.traffic_source IS NULL THEN orders.traffic_campaign ELSE EXCLUDED.traffic_campaign END,
        referrer_host = CASE WHEN EXCLUDED.traffic_source IS NULL THEN orders.referrer_host ELSE EXCLUDED.referrer_host END,
        -- Orders without sales in the payload, or whose stored sales were read later, keep theirs.
        sales_updated_at = GREATEST(EXCLUDED.sales_updated_at, orders.sales_updated_at),
        sales_key = CASE WHEN EXCLUDED.sales_updated_at IS NOT NULL AND (orders.sales_updated_at IS NULL OR orders.sales_updated_at <= EXCLUDED.sales_updated_at)
                         THEN EXCLUDED.sales_key ELSE orders.sales_key END
      WHERE orders.shopify_updated_at <= EXCLUDED.shopify_updated_at
      RETURNING id, shopify_id`;

    const idFor = new Map(written.map((w) => [w.shopify_id, w.id]));
    if (!idFor.size) return;

    const previousLines = await tx.orderLineItem.findMany({
      where: { workspaceId: store.workspaceId, storeId: store.id, orderId: { in: [...idFor.values()] } }, select: historicalLineSelect,
    });
    const previousById = new Map(previousLines.map(line => [line.shopifyId, line]));
    await tx.$executeRaw`DELETE FROM order_line_items WHERE order_id = ANY(${[...idFor.values()]}::text[])`;

    const items = rows.flatMap((o) => {
      const orderId = idFor.get(o.shopifyId);
      return orderId
        ? o.lineItems.map(line => retainLineHistory(line, previousById.get(line.shopifyId))).map((li) => ({
            order_id: orderId,
            shopify_id: li.shopifyId,
            product_shopify_id: li.productShopifyId,
            variant_shopify_id: li.variantShopifyId,
            sku: li.sku,
            title: li.title,
            quantity: li.quantity,
            price: String(li.price),
            discount: String(li.discount),
          }))
        : [];
    });
    if (items.length) {
      await tx.$executeRaw`
        INSERT INTO order_line_items (id, workspace_id, store_id, order_id, shopify_id, product_shopify_id, variant_shopify_id, sku, title, quantity, price, discount)
        SELECT gen_random_uuid()::text, ${store.workspaceId}, ${store.id}, s.order_id, s.shopify_id, s.product_shopify_id,
               s.variant_shopify_id, s.sku, s.title, s.quantity, s.price::numeric, s.discount::numeric
        FROM jsonb_to_recordset(${JSON.stringify(items)}::jsonb) AS s(
          order_id text, shopify_id text, product_shopify_id text, variant_shopify_id text, sku text,
          title text, quantity int, price text, discount text
        )
        ON CONFLICT (store_id, shopify_id) DO NOTHING`;
    }

    // Sales are replaced wholesale too, for the written orders that carry them; the days the old
    // ones were on need recomputing as well.
    const withSales = rows.filter((o) => salesFresh(o) && idFor.has(o.shopifyId));
    if (!withSales.length) return;
    const old = await tx.$queryRaw<Array<{ day: string }>>`
      DELETE FROM order_sales WHERE order_id = ANY(${withSales.map((o) => idFor.get(o.shopifyId)!)}::text[]) RETURNING local_day AS day`;
    for (const r of old) days.add(r.day);
    const sales = withSales.flatMap((o) =>
      saleRows(store, idFor.get(o.shopifyId)!, o.sales!).map((x) => ({
        order_id: x.orderId,
        shopify_id: x.shopifyId,
        local_day: x.localDay,
        happened_at: ts(x.happenedAt),
        action_type: x.actionType,
        line_type: x.lineType,
        line_item_shopify_id: x.lineItemShopifyId,
        quantity: x.quantity,
        amount: String(x.amount),
        discount: String(x.discount),
        tax: String(x.tax),
      })),
    );
    if (sales.length) {
      await tx.$executeRaw`
        INSERT INTO order_sales (id, workspace_id, store_id, order_id, shopify_id, local_day, happened_at, action_type, line_type,
                                 line_item_shopify_id, quantity, amount, discount, tax)
        SELECT gen_random_uuid()::text, ${store.workspaceId}, ${store.id}, s.order_id, s.shopify_id, s.local_day,
               (s.happened_at)::timestamptz AT TIME ZONE 'UTC', s.action_type, s.line_type, s.line_item_shopify_id, s.quantity,
               s.amount::numeric, s.discount::numeric, s.tax::numeric
        FROM jsonb_to_recordset(${JSON.stringify(sales)}::jsonb) AS s(
          order_id text, shopify_id text, local_day text, happened_at text, action_type text, line_type text,
          line_item_shopify_id text, quantity int, amount text, discount text, tax text
        )
        ON CONFLICT (store_id, shopify_id) DO UPDATE SET
          order_id = EXCLUDED.order_id, local_day = EXCLUDED.local_day, happened_at = EXCLUDED.happened_at,
          action_type = EXCLUDED.action_type, line_type = EXCLUDED.line_type, line_item_shopify_id = EXCLUDED.line_item_shopify_id,
          quantity = EXCLUDED.quantity, amount = EXCLUDED.amount, discount = EXCLUDED.discount, tax = EXCLUDED.tax`;
    }
  });
  const keys = [...new Set(payload.map((p) => p.customer_key).filter((k): k is string => !!k))];
  for (const d of await settleReturningCustomers(store.id, keys)) days.add(d);
  return days;
}

/**
 * Idempotent product upsert with the same staleness guard as orders. vendor /
 * productType / createdAt left undefined keep their stored values. Returns false
 * when the payload was older than what is stored (nothing written).
 */
export async function upsertProduct(
  store: Pick<Store, "id" | "workspaceId">,
  p: Pick<NormalizedProduct, "shopifyId" | "title" | "status" | "updatedAt"> &
    Partial<Pick<NormalizedProduct, "vendor" | "productType" | "createdAt" | "handle" | "description" | "tags" | "category" | "collections" | "imageUrl" | "onlineStoreUrl">>,
): Promise<boolean> {
  const where = { storeId_shopifyId: { storeId: store.id, shopifyId: p.shopifyId } };
  const existing = await systemDb.product.findUnique({ where, select: { shopifyUpdatedAt: true } });
  if (existing && existing.shopifyUpdatedAt > p.updatedAt) return false;
  const data = {
    title: p.title,
    status: p.status,
    shopifyUpdatedAt: p.updatedAt,
    ...(p.vendor !== undefined ? { vendor: p.vendor } : {}),
    ...(p.productType !== undefined ? { productType: p.productType } : {}),
    ...(p.createdAt !== undefined ? { shopifyCreatedAt: p.createdAt } : {}),
    ...(p.handle !== undefined ? { handle: p.handle } : {}),
    ...(p.description !== undefined ? { description: p.description } : {}),
    ...(p.tags !== undefined ? { tags: p.tags } : {}),
    ...(p.category !== undefined ? { category: p.category } : {}),
    ...(p.collections !== undefined ? { collections: p.collections as unknown as Prisma.InputJsonValue } : {}),
    ...(p.imageUrl !== undefined ? { imageUrl: p.imageUrl } : {}),
    ...(p.onlineStoreUrl !== undefined ? { onlineStoreUrl: p.onlineStoreUrl } : {}),
  };
  return writeIfNotNewer(
    () => systemDb.product.updateMany({ where: { storeId: store.id, shopifyId: p.shopifyId, shopifyUpdatedAt: { lte: p.updatedAt } }, data }),
    () => systemDb.product.create({ data: { ...data, workspaceId: store.workspaceId, storeId: store.id, shopifyId: p.shopifyId } }),
    !!existing,
  );
}

/**
 * The write half of a staleness-guarded upsert, safe against a concurrent delivery of the same
 * item: the update only matches a row that is not newer than the payload, in one statement, so a
 * newer copy written between the caller's check and this write is never overwritten. A row that
 * didn't exist is created; if another delivery created it first (unique violation), the guarded
 * update decides. True when this payload was written.
 */
async function writeIfNotNewer(update: () => Promise<{ count: number }>, create: () => Promise<unknown>, existed: boolean): Promise<boolean> {
  if (existed) return (await update()).count > 0;
  try {
    await create();
    return true;
  } catch (err) {
    if ((err as { code?: unknown }).code !== "P2002") throw err;
    return (await update()).count > 0;
  }
}

/** A variant's details for the Inventory module, as columns: only the ones the source carried. */
function variantDetails(v: NormalizedVariant) {
  return {
    ...(v.inventoryItemId !== undefined ? { inventoryItemId: v.inventoryItemId } : {}),
    ...(v.barcode !== undefined ? { barcode: v.barcode } : {}),
    ...(v.compareAtPrice !== undefined ? { compareAtPrice: v.compareAtPrice } : {}),
    ...(v.options !== undefined ? { options: v.options === null ? Prisma.DbNull : (v.options as unknown as Prisma.InputJsonValue) } : {}),
    ...(v.taxable !== undefined ? { taxable: v.taxable } : {}),
    ...(v.inventoryPolicy !== undefined ? { inventoryPolicy: v.inventoryPolicy } : {}),
    ...(v.requiresShipping !== undefined ? { requiresShipping: v.requiresShipping } : {}),
    ...(v.weight !== undefined ? { weight: v.weight } : {}),
    ...(v.weightUnit !== undefined ? { weightUnit: v.weightUnit } : {}),
    ...(v.position !== undefined ? { position: v.position } : {}),
    ...(v.createdAt !== undefined ? { shopifyCreatedAt: v.createdAt } : {}),
  };
}

/**
 * Idempotent variant upsert (older payloads never overwrite newer ones). Fields the
 * source doesn't carry (`undefined`) keep their stored value: REST webhooks have no
 * unit cost, so a cost synced over GraphQL is never wiped by a products/update.
 */
export async function upsertVariant(store: Pick<Store, "id" | "workspaceId">, v: NormalizedVariant): Promise<boolean> {
  const where = { storeId_shopifyId: { storeId: store.id, shopifyId: v.shopifyId } };
  const existing = await systemDb.productVariant.findUnique({ where, select: { shopifyUpdatedAt: true, inventoryQuantity: true } });
  if (existing && existing.shopifyUpdatedAt > v.updatedAt) return false;
  // A quantity whose tracking state is unknown must not turn a known-untracked variant (null)
  // into a tracked one; for new rows, assume tracked (the variants sync corrects it).
  const keepUntracked = v.trackingUnknown === true && !!existing && existing.inventoryQuantity === null;
  const data = {
    productShopifyId: v.productShopifyId,
    title: v.title,
    sku: v.sku,
    price: v.price,
    shopifyUpdatedAt: v.updatedAt,
    ...(v.inventoryQuantity !== undefined && !keepUntracked ? { inventoryQuantity: v.inventoryQuantity } : {}),
    ...(v.unitCost !== undefined ? { unitCost: v.unitCost } : {}),
    ...variantDetails(v),
  };
  return writeIfNotNewer(
    () => systemDb.productVariant.updateMany({ where: { storeId: store.id, shopifyId: v.shopifyId, shopifyUpdatedAt: { lte: v.updatedAt } }, data }),
    () => systemDb.productVariant.create({ data: { ...data, workspaceId: store.workspaceId, storeId: store.id, shopifyId: v.shopifyId } }),
    !!existing,
  );
}

/**
 * Timestamps are bound as ISO strings and cast here, never as JS `Date`s.
 *
 * `shopify_created_at` / `shopify_updated_at` are `TIMESTAMP(3)` *without* time zone holding
 * UTC. Binding a `Date` through `$executeRaw` lets the driver render a `timestamptz` literal
 * and the session time zone decide what it means - a silent shift that would land orders on
 * the wrong `local_day` in some deployments and not others. Going through `timestamptz` and
 * back out `AT TIME ZONE 'UTC'` pins it.
 */
const ts = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** Last write wins, mirroring a sequential loop - and ON CONFLICT cannot hit a row twice. */
function dedupe<T extends { shopifyId: string }>(rows: T[]): T[] {
  const by = new Map<string, T>();
  for (const r of rows) by.set(r.shopifyId, r);
  return [...by.values()];
}

/**
 * Catalog pages, one statement instead of one round trip per row.
 *
 * A 100-product page used to be ~200 sequential round trips (a staleness pre-read plus an
 * upsert each), and each of those is a real network hop to the database. The pre-read is gone: `WHERE … shopify_updated_at <= excluded…`
 * is the same staleness guard expressed as part of the upsert, and it has to stay - without it
 * a slow catalog page could overwrite a newer `products/update` webhook.
 *
 * `upsertProduct` / `upsertVariant` are unchanged and still serve the webhook path, which
 * needs their per-row return value and their "undefined keeps the stored value" semantics.
 */
export async function bulkUpsertProducts(store: Pick<Store, "id" | "workspaceId">, products: NormalizedProduct[]) {
  const all = dedupe(products);
  // Without the product information (a page asked for before it was read), the stored one is kept.
  const partial = all.filter((p) => p.handle === undefined);
  for (const p of partial) await upsertProduct(store, p);
  const rows = all.filter((p) => p.handle !== undefined);
  if (!rows.length) return;
  await systemDb.$executeRaw`
    INSERT INTO products (id, workspace_id, store_id, shopify_id, title, status, vendor, product_type, shopify_created_at, shopify_updated_at,
                          handle, description, tags, category, collections, image_url, online_store_url)
    SELECT gen_random_uuid()::text, ${store.workspaceId}, ${store.id}, s.shopify_id, s.title, s.status, s.vendor, s.product_type,
           (s.created_at)::timestamptz AT TIME ZONE 'UTC', (s.updated_at)::timestamptz AT TIME ZONE 'UTC',
           s.handle, s.description, ARRAY(SELECT jsonb_array_elements_text(s.tags::jsonb)), s.category, s.collections::jsonb, s.image_url, s.online_store_url
    FROM unnest(
      ${rows.map((p) => p.shopifyId)}::text[], ${rows.map((p) => p.title)}::text[], ${rows.map((p) => p.status)}::text[],
      ${rows.map((p) => p.vendor ?? null)}::text[], ${rows.map((p) => p.productType ?? null)}::text[],
      ${rows.map((p) => ts(p.createdAt))}::text[], ${rows.map((p) => ts(p.updatedAt))}::text[],
      ${rows.map((p) => p.handle ?? null)}::text[], ${rows.map((p) => p.description ?? null)}::text[],
      ${rows.map((p) => JSON.stringify(p.tags ?? []))}::text[], ${rows.map((p) => p.category ?? null)}::text[],
      ${rows.map((p) => JSON.stringify(p.collections ?? []))}::text[], ${rows.map((p) => p.imageUrl ?? null)}::text[],
      ${rows.map((p) => p.onlineStoreUrl ?? null)}::text[]
    ) AS s(shopify_id, title, status, vendor, product_type, created_at, updated_at, handle, description, tags, category, collections, image_url, online_store_url)
    ON CONFLICT (store_id, shopify_id) DO UPDATE SET
      title = EXCLUDED.title, status = EXCLUDED.status, vendor = EXCLUDED.vendor,
      product_type = EXCLUDED.product_type, shopify_created_at = EXCLUDED.shopify_created_at,
      shopify_updated_at = EXCLUDED.shopify_updated_at, handle = EXCLUDED.handle, description = EXCLUDED.description,
      tags = EXCLUDED.tags, category = EXCLUDED.category, collections = EXCLUDED.collections,
      image_url = EXCLUDED.image_url, online_store_url = EXCLUDED.online_store_url
    WHERE products.shopify_updated_at <= EXCLUDED.shopify_updated_at`;
}

/**
 * As above for variants. Rows whose `unitCost` is `undefined` (Shopify withheld
 * `inventoryItem`) or whose tracking state is unknown fall back to `upsertVariant` one at a
 * time: both cases mean "keep whatever is stored", which a bulk statement cannot express
 * without a second signal per column. The GraphQL variants sync always knows both, so in the
 * import that fast path takes every row; the slow path exists for REST webhook payloads.
 */
export async function bulkUpsertVariants(store: Pick<Store, "id" | "workspaceId">, variants: NormalizedVariant[]) {
  const rows = dedupe(variants);
  // Also one at a time: a page without the variant details (asked for before they were read, or
  // with the inventory item withheld), whose stored details are kept.
  const partial = rows.filter(
    (v) => v.unitCost === undefined || v.trackingUnknown === true || v.inventoryQuantity === undefined || v.barcode === undefined || v.inventoryItemId === undefined || v.weight === undefined,
  );
  const full = rows.filter((v) => !partial.includes(v));
  for (const v of partial) await upsertVariant(store, v);
  if (!full.length) return;
  const txt = (x: string | number | boolean | null | undefined) => (x === null || x === undefined ? null : String(x));
  await systemDb.$executeRaw`
    INSERT INTO product_variants (id, workspace_id, store_id, product_shopify_id, shopify_id, title, sku, price, inventory_quantity, unit_cost, shopify_updated_at,
                                  inventory_item_id, barcode, compare_at_price, options, taxable, inventory_policy, requires_shipping, weight, weight_unit, position, shopify_created_at)
    SELECT gen_random_uuid()::text, ${store.workspaceId}, ${store.id}, s.product_shopify_id, s.shopify_id, s.title, s.sku,
           s.price::numeric, s.inventory_quantity::int, s.unit_cost::numeric, (s.updated_at)::timestamptz AT TIME ZONE 'UTC',
           s.inventory_item_id, s.barcode, s.compare_at_price::numeric, s.options::jsonb, s.taxable::boolean, s.inventory_policy,
           s.requires_shipping::boolean, s.weight::numeric, s.weight_unit, s.position::int, (s.created_at)::timestamptz AT TIME ZONE 'UTC'
    FROM unnest(
      ${full.map((v) => v.productShopifyId)}::text[], ${full.map((v) => v.shopifyId)}::text[], ${full.map((v) => v.title)}::text[],
      ${full.map((v) => v.sku ?? null)}::text[], ${full.map((v) => String(v.price))}::text[],
      ${full.map((v) => (v.inventoryQuantity == null ? null : String(v.inventoryQuantity)))}::text[],
      ${full.map((v) => (v.unitCost == null ? null : String(v.unitCost)))}::text[],
      ${full.map((v) => ts(v.updatedAt))}::text[],
      ${full.map((v) => v.inventoryItemId ?? null)}::text[], ${full.map((v) => v.barcode ?? null)}::text[],
      ${full.map((v) => txt(v.compareAtPrice))}::text[], ${full.map((v) => (v.options ? JSON.stringify(v.options) : null))}::text[],
      ${full.map((v) => txt(v.taxable))}::text[], ${full.map((v) => v.inventoryPolicy ?? null)}::text[],
      ${full.map((v) => txt(v.requiresShipping))}::text[], ${full.map((v) => txt(v.weight))}::text[],
      ${full.map((v) => v.weightUnit ?? null)}::text[], ${full.map((v) => txt(v.position))}::text[],
      ${full.map((v) => ts(v.createdAt))}::text[]
    ) AS s(product_shopify_id, shopify_id, title, sku, price, inventory_quantity, unit_cost, updated_at,
           inventory_item_id, barcode, compare_at_price, options, taxable, inventory_policy, requires_shipping, weight, weight_unit, position, created_at)
    ON CONFLICT (store_id, shopify_id) DO UPDATE SET
      product_shopify_id = EXCLUDED.product_shopify_id, title = EXCLUDED.title, sku = EXCLUDED.sku,
      price = EXCLUDED.price, inventory_quantity = EXCLUDED.inventory_quantity, unit_cost = EXCLUDED.unit_cost,
      shopify_updated_at = EXCLUDED.shopify_updated_at, inventory_item_id = EXCLUDED.inventory_item_id,
      barcode = EXCLUDED.barcode, compare_at_price = EXCLUDED.compare_at_price, options = EXCLUDED.options,
      taxable = EXCLUDED.taxable, inventory_policy = EXCLUDED.inventory_policy, requires_shipping = EXCLUDED.requires_shipping,
      weight = EXCLUDED.weight, weight_unit = EXCLUDED.weight_unit, position = EXCLUDED.position,
      shopify_created_at = EXCLUDED.shopify_created_at
    WHERE product_variants.shopify_updated_at <= EXCLUDED.shopify_updated_at`;
}

/**
 * Drop a product's variants that a (complete, non-stale) product payload no longer
 * lists. Variants updated after `asOf` are kept: they are newer than the payload
 * (e.g. created after it and already synced), so the payload can't speak for them.
 */
export async function pruneVariants(
  store: Pick<Store, "id">,
  productShopifyId: string,
  keepShopifyIds: string[],
  asOf: Date,
): Promise<number> {
  const where = { storeId: store.id, productShopifyId, shopifyId: { notIn: keepShopifyIds }, shopifyUpdatedAt: { lte: asOf } };
  const items = await variantItems(store.id, where);
  const [res] = await systemDb.$transaction([
    systemDb.productVariant.deleteMany({ where }),
    // Their stock went with them in Shopify (the inventory item belongs to the variant).
    systemDb.inventoryLevel.deleteMany({ where: { storeId: store.id, inventoryItemId: { in: items } } }),
  ]);
  return res.count;
}

/** The inventory items of the variants `where` picks. */
async function variantItems(storeId: string, where: Prisma.ProductVariantWhereInput): Promise<string[]> {
  const rows = await systemDb.productVariant.findMany({ where: { ...where, storeId, inventoryItemId: { not: null } }, select: { inventoryItemId: true } });
  return rows.map((r) => r.inventoryItemId!);
}

/** products/delete: the product, all of its variants and their stock levels. */
export async function deleteProduct(store: Pick<Store, "id">, productShopifyId: string) {
  const items = await variantItems(store.id, { productShopifyId });
  await systemDb.$transaction([
    systemDb.inventoryLevel.deleteMany({ where: { storeId: store.id, inventoryItemId: { in: items } } }),
    systemDb.productVariant.deleteMany({ where: { storeId: store.id, productShopifyId } }),
    systemDb.product.deleteMany({ where: { storeId: store.id, shopifyId: productShopifyId } }),
  ]);
}

/**
 * Recompute daily aggregates for the given store-local days from the stored orders and their
 * sales. Pure function of the source tables => safe to run any number of times.
 * Mirrors aggregateDaily() in packages/shared/src/kpi.ts (tested for parity); the definitions
 * are Shopify's own (docs/kpis.md):
 *
 *  - Orders: orders placed that day, cancelled ones included (test orders are never stored).
 *  - Money comes from the sales that happened that day, whatever day the order was placed: a
 *    sale's value before tax is its amount less its tax. Product and adjustment lines make net
 *    sales: an order action adds to gross sales (value + discount) and discounts; any other action
 *    (a return, a cancellation, an edit) is a return, so net sales = gross − discounts − returns.
 *    Shipping lines make shipping, duty lines duties, and fees, additional fees and lines of no
 *    known type additional fees (`chargeLine` in @app/shared): those three and taxes go to total
 *    sales only. Gift cards and tips count nowhere, as in Shopify's reports.
 *  - Total refunded: a return action's sales (refunds, returns, cancellations) with their tax, all
 *    lines but gift cards: what they took off total sales that day.
 *  - Every sale keeps the sign Shopify gave it: a refund's adjustment lines come in pairs of both
 *    signs, and only their sum is what it took back (`saleValue` in @app/shared).
 *
 * One recompute per store at a time (a transaction-scoped advisory lock): the aggregate queue runs
 * two jobs at once, and two recomputes of a day that read before and after a webhook's write could
 * otherwise commit in the wrong order, leaving the older totals. The statement's snapshot is taken
 * after the lock, so whichever runs last reads every write committed before it.
 */
export async function recomputeDays(store: Pick<Store, "id" | "workspaceId">, days: string[]) {
  if (!days.length) return;
  await systemDb.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`aggregate:${store.id}`}))`;
    await tx.$executeRaw`
    ${dayTotals(store, days)}
    INSERT INTO daily_store_metrics
      (workspace_id, store_id, day, gross_sales, discounts, refunds, shipping, taxes, duties, additional_fees, total_sales, total_refunded, orders, order_value, units,
       orders_with_customer, returning_customer_orders, refunded_orders)
    SELECT ${store.workspaceId}, ${store.id}, day, gross_sales, discounts, refunds, shipping, taxes, duties, additional_fees, total_sales, total_refunded, orders, order_value, units,
           orders_with_customer, returning_customer_orders, refunded_orders
    FROM t
    ON CONFLICT (store_id, day) DO UPDATE SET
      gross_sales = EXCLUDED.gross_sales,
      discounts = EXCLUDED.discounts,
      refunds = EXCLUDED.refunds,
      shipping = EXCLUDED.shipping,
      taxes = EXCLUDED.taxes,
      duties = EXCLUDED.duties,
      additional_fees = EXCLUDED.additional_fees,
      total_sales = EXCLUDED.total_sales,
      total_refunded = EXCLUDED.total_refunded,
      orders = EXCLUDED.orders,
      order_value = EXCLUDED.order_value,
      units = EXCLUDED.units,
      orders_with_customer = EXCLUDED.orders_with_customer,
      returning_customer_orders = EXCLUDED.returning_customer_orders,
      refunded_orders = EXCLUDED.refunded_orders`;
  });
}

/**
 * The query behind `recomputeDays`, as CTEs ending in `t`: one row per day of `days`, with
 * daily_store_metrics' columns. With `until` (a timestamp expression, UTC like the tables) only
 * the orders placed and the sales made before that moment count: a part-day, which the dashboard
 * compares a running day with (`Comparison.until` in @app/shared).
 */
export function dayTotals(store: Pick<Store, "id" | "workspaceId">, days: string[], until?: Prisma.Sql) {
  return Prisma.sql`
    WITH d AS (SELECT unnest(${days}::text[]) AS day),
    o AS (
      -- Orders on the day Shopify processed them (local_day), orders of gift cards only left out:
      -- Shopify's reports count neither them nor their customers.
      SELECT local_day AS day,
             COUNT(*)::int AS orders,
             (COUNT(*) FILTER (WHERE customer_key IS NOT NULL))::int AS owc,
             (COUNT(*) FILTER (WHERE customer_key IS NOT NULL AND is_returning_customer))::int AS ret
      FROM orders
      WHERE workspace_id = ${store.workspaceId} AND store_id = ${store.id} AND local_day = ANY(${days}::text[])
        AND NOT gift_card_only
        ${until ? Prisma.sql`AND COALESCE(shopify_processed_at, shopify_created_at) < ${until}` : Prisma.empty}
      GROUP BY local_day
    ),
    v AS (
      -- own_day: a sale on the day its order was placed (the order's own, or an edit made that day).
      SELECT s.local_day AS day, s.order_id, s.action_type, s.line_type, s.quantity, s.discount, s.amount - s.tax AS value, s.tax,
             s.local_day = o.local_day AS own_day
      FROM order_sales s JOIN orders o ON o.id = s.order_id
      WHERE s.workspace_id = ${store.workspaceId} AND s.store_id = ${store.id} AND s.local_day = ANY(${days}::text[])
        AND s.line_type <> 'tip'
        ${until ? Prisma.sql`AND s.happened_at < ${until}` : Prisma.empty}
    ),
    s AS (
      -- Gift cards count as items only (Shopify's net items sold): no sales, tax or returns.
      SELECT day,
             SUM(value + discount) FILTER (WHERE line_type IN ('product', 'adjustment') AND action_type = 'order') AS gross,
             SUM(discount) FILTER (WHERE line_type IN ('product', 'adjustment') AND action_type = 'order') AS disc,
             SUM(value) FILTER (WHERE line_type IN ('product', 'adjustment') AND action_type = 'order' AND own_day) AS placed,
             -SUM(value) FILTER (WHERE line_type IN ('product', 'adjustment') AND action_type <> 'order') AS returns,
             SUM(value) FILTER (WHERE line_type = 'shipping') AS shipping,
             SUM(tax) FILTER (WHERE line_type <> 'gift_card') AS taxes,
             SUM(value) FILTER (WHERE line_type = 'duty') AS duties,
             SUM(value) FILTER (WHERE line_type NOT IN ('shipping', 'product', 'adjustment', 'gift_card', 'duty')) AS fees,
             -SUM(value + tax) FILTER (WHERE action_type = 'return' AND line_type <> 'gift_card') AS refunded,
             (SUM(ABS(COALESCE(quantity, 0))) FILTER (WHERE line_type IN ('product', 'gift_card') AND action_type = 'order'))::int AS units_in,
             (SUM(ABS(COALESCE(quantity, 0))) FILTER (WHERE line_type IN ('product', 'gift_card') AND action_type = 'return'))::int AS units_out,
             (COUNT(DISTINCT order_id) FILTER (WHERE action_type = 'return' AND line_type <> 'gift_card'))::int AS ro
      FROM v
      GROUP BY day
    ),
    t AS (
      SELECT d.day,
             COALESCE(s.gross, 0) AS gross_sales, COALESCE(s.disc, 0) AS discounts, COALESCE(s.returns, 0) AS refunds,
             COALESCE(s.shipping, 0) AS shipping, COALESCE(s.taxes, 0) AS taxes,
             COALESCE(s.duties, 0) AS duties, COALESCE(s.fees, 0) AS additional_fees,
             COALESCE(s.gross, 0) - COALESCE(s.disc, 0) - COALESCE(s.returns, 0) + COALESCE(s.shipping, 0) + COALESCE(s.taxes, 0)
               + COALESCE(s.duties, 0) + COALESCE(s.fees, 0) AS total_sales,
             COALESCE(s.refunded, 0) AS total_refunded,
             COALESCE(o.orders, 0) AS orders, COALESCE(s.placed, 0) AS order_value,
             COALESCE(s.units_in, 0) - COALESCE(s.units_out, 0) AS units,
             COALESCE(o.owc, 0) AS orders_with_customer, COALESCE(o.ret, 0) AS returning_customer_orders, COALESCE(s.ro, 0) AS refunded_orders
      FROM d
      LEFT JOIN o ON o.day = d.day
      LEFT JOIN s ON s.day = d.day
    )`;
}

/**
 * Every store-local day the store has any data on.
 *
 * Used to aggregate once at the end of a backfill instead of once per page. Reading the days
 * actually stored, rather than generating the backfill window, keeps it correct for a store
 * with `read_all_orders`, whose backfill has no window at all.
 */
export async function backfillDays(storeId: string): Promise<string[]> {
  const rows = await systemDb.$queryRaw<Array<{ day: string }>>`
    SELECT local_day AS day FROM orders WHERE store_id = ${storeId}
    UNION
    SELECT local_day AS day FROM order_sales WHERE store_id = ${storeId}`;
  return rows.map((r) => r.day);
}

/**
 * Decide, for the given customers' orders (every customer of the store when `customerKeys` is
 * left out), whether each is a returning customer's, as Shopify does: an order is a new customer's
 * when it is their very first purchase, and a returning customer's when their order history already
 * holds an earlier one, whatever they bought since. Returns the store-local days whose orders
 * changed, for the caller to recompute.
 *
 * - "Earlier" is by when the orders happened (processed; ties by order id), as Shopify's reports
 *   judge it, and an order of gift cards only doesn't count. Checked order by order against
 *   ShopifyQL on a seeded dev store of 985 orders (2026-10-19): this matched 877 of 878 customers'
 *   orders (the one left: two orders of one moment, now ordered by id), while Shopify's own position
 *   of the order (`customer_order_index`), which follows creation, matched 705: imported orders
 *   are created in another order than they happened. Shopify's report settles asynchronously, so
 *   check it some minutes after the orders are made.
 * - Orders from before the imported history aren't stored: Shopify's position counting more orders
 *   created up to this one than are stored proves there are some (they were created, and almost
 *   always happened, before it). Without a position (no journey: POS and draft orders, or not read
 *   with it yet), the customer's lifetime order count, as Shopify last gave it, above the orders
 *   stored for them proves the same.
 *
 * Until 2026-10-18 the lifetime count alone decided ("more than one order"), read whenever the
 * order was imported, so a customer's first order turned "returning" once they bought again, and
 * the flag never came back. Every order is now worked out from scratch, so this also repairs those.
 * Earlier cancelled orders count as order history, as they do in Shopify's.
 */
export async function settleReturningCustomers(storeId: string, customerKeys?: string[]): Promise<Set<string>> {
  if (customerKeys && !customerKeys.length) return new Set();
  const only = customerKeys ? Prisma.sql`AND customer_key = ANY(${customerKeys}::text[])` : Prisma.empty;
  // Orders follow each other by when they happened (processed; created before that was read), and
  // Shopify's order ids grow with time, so (at, length, id) orders two orders of one moment too.
  const rows = await systemDb.$queryRaw<Array<{ day: string }>>`
    WITH mine AS (
      SELECT id, customer_key, COALESCE(shopify_processed_at, shopify_created_at) AS at, shopify_created_at AS created,
             length(shopify_id) AS idlen, shopify_id AS sid, gift_card_only, customer_order_index, customer_order_count, local_day
      FROM orders WHERE store_id = ${storeId} AND customer_key IS NOT NULL ${only}
    ),
    c AS (SELECT customer_key, COUNT(*) AS held, MAX(customer_order_count) AS n FROM mine GROUP BY customer_key),
    r AS (
      SELECT m.id, m.local_day,
             EXISTS (SELECT 1 FROM mine p WHERE p.customer_key = m.customer_key AND NOT p.gift_card_only
                       AND (p.at, p.idlen, p.sid) < (m.at, m.idlen, m.sid))
             OR CASE WHEN m.customer_order_index IS NOT NULL
                     THEN m.customer_order_index > (SELECT COUNT(*) FROM mine p WHERE p.customer_key = m.customer_key
                                                      AND (p.created, p.idlen, p.sid) <= (m.created, m.idlen, m.sid))
                     ELSE COALESCE(c.n, 0) > c.held
                END AS ret
      FROM mine m JOIN c ON c.customer_key = m.customer_key
    )
    UPDATE orders o SET is_returning_customer = r.ret
    FROM r
    WHERE o.id = r.id AND o.is_returning_customer IS DISTINCT FROM r.ret
    RETURNING r.local_day AS day`;
  return new Set(rows.map((r) => r.day));
}

/** shop/redact & uninstall cleanup: remove all synced commerce data for a store. */
export async function purgeStoreData(storeId: string, fetchImpl?: FetchLike) {
  // Read first: the ad platforms' grants are revoked once the rows are gone (so the store's own
  // connections no longer count as "still using" the grant). Best effort, never blocks the purge.
  const adConnections = await systemDb.adConnection.findMany({ where: { storeId } });
  // The retired WhatsApp module kept its token at Nango: it goes first (best effort), while its row still says where.
  await deleteRetiredNangoToken(storeId, fetchImpl ?? fetch);
  await systemDb.$transaction([
    systemDb.orderLineItem.deleteMany({ where: { storeId } }),
    systemDb.orderSale.deleteMany({ where: { storeId } }),
    systemDb.refund.deleteMany({ where: { storeId } }),
    systemDb.order.deleteMany({ where: { storeId } }),
    systemDb.productVariant.deleteMany({ where: { storeId } }),
    systemDb.product.deleteMany({ where: { storeId } }),
    // Inventory: stock levels, locations, the stock history and its records, alerts and settings.
    systemDb.inventoryLevel.deleteMany({ where: { storeId } }),
    systemDb.inventoryLocation.deleteMany({ where: { storeId } }),
    systemDb.inventoryMovement.deleteMany({ where: { storeId } }),
    systemDb.inventorySnapshot.deleteMany({ where: { storeId } }),
    systemDb.inventoryAdjustment.deleteMany({ where: { storeId } }),
    systemDb.inventoryAlert.deleteMany({ where: { storeId } }),
    systemDb.inventorySyncRun.deleteMany({ where: { storeId } }),
    systemDb.inventorySettings.deleteMany({ where: { storeId } }),
    systemDb.dailyStoreMetrics.deleteMany({ where: { storeId } }),
    // The full history's import plan, year by year: the next import plans its own.
    systemDb.orderHistoryWindow.deleteMany({ where: { storeId } }),
    // The store's own sales calculation (which lines Custom sales counts) goes with its figures.
    systemDb.salesCalculation.deleteMany({ where: { storeId } }),
    // Its checks against Shopify describe data that is gone.
    systemDb.reconciliation.deleteMany({ where: { storeId } }),
    systemDb.shopifyReport.deleteMany({ where: { storeId } }),
    systemDb.funnelDaily.deleteMany({ where: { storeId } }),
    systemDb.funnelVisit.deleteMany({ where: { storeId } }),
    systemDb.funnelProductVisit.deleteMany({ where: { storeId } }),
    systemDb.funnelActionCheck.deleteMany({ where: { storeId } }),
    systemDb.pixelEventSeen.deleteMany({ where: { storeId } }),
    // Connected ad accounts belong to the store too: their numbers and their tokens go with it.
    systemDb.adCampaignDaily.deleteMany({ where: { storeId } }),
    systemDb.adsenseDaily.deleteMany({ where: { storeId } }),
    systemDb.adConnection.deleteMany({ where: { storeId } }),
    // WhatsApp Automation: customers' numbers, consent, messages, automations, campaigns and the
    // store's connection (what was set up at Meta for its number is undone first: the erase's caller does it).
    // Then what the retired WhatsApp features still hold until their tables are dropped.
    ...purgeWhatsappStoreOps(storeId),
    ...purgeLegacyWhatsappOps(storeId),
    // Customer Messaging (SMS): customers' numbers, consent history, texts, costs, and the store's sender.
    systemDb.smsDeliveryEvent.deleteMany({ where: { storeId } }),
    systemDb.smsCostRecord.deleteMany({ where: { storeId } }),
    systemDb.smsMessageJob.deleteMany({ where: { storeId } }),
    systemDb.smsCampaignRecipient.deleteMany({ where: { storeId } }),
    systemDb.smsCampaign.deleteMany({ where: { storeId } }),
    systemDb.smsSegment.deleteMany({ where: { storeId } }),
    systemDb.smsAutomationRule.deleteMany({ where: { storeId } }),
    systemDb.smsTemplateVersion.deleteMany({ where: { storeId } }),
    systemDb.smsTemplate.deleteMany({ where: { storeId } }),
    systemDb.smsCheckout.deleteMany({ where: { storeId } }),
    systemDb.smsConsentRecord.deleteMany({ where: { storeId } }),
    systemDb.smsContactOrder.deleteMany({ where: { storeId } }),
    systemDb.smsContact.deleteMany({ where: { storeId } }),
    systemDb.smsSuppression.deleteMany({ where: { storeId } }),
    systemDb.smsTestNumber.deleteMany({ where: { storeId } }),
    systemDb.smsAuditLog.deleteMany({ where: { storeId } }),
    systemDb.smsSenderConfiguration.deleteMany({ where: { storeId } }),
    systemDb.smsSetup.deleteMany({ where: { storeId } }),
    // The orders and visits are gone, and where their history started with them: the next import
    // and pixel record their own.
    systemDb.store.updateMany({ where: { id: storeId }, data: { ordersHistoryFrom: null, pixelInstalledAt: null } }),
  ]);
  // Deleting our copy of a token leaves the access it grants alive at Google or Meta.
  for (const conn of adConnections) await revokeAdAccessIfUnused(conn, fetchImpl);
  // A sign-in still waiting for its ad accounts goes too, with its grant.
  await releaseAdLoginsWhere({ storeId }, fetchImpl).catch((err: unknown) => logger.warn({ err, storeId }, "a waiting ad login wasn't let go with its store"));
}

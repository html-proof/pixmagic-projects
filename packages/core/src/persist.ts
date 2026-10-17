import { Prisma, systemDb, type Store } from "@app/db";
import { expandScopes, hmacSha256Hex, localDay } from "@app/shared";
import { env } from "./env.js";
import type { NormalizedOrder, NormalizedProduct, NormalizedSale, NormalizedVariant } from "./normalize.js";
import { revokeAdAccessIfUnused } from "./adConnections.js";
import type { FetchLike } from "./shopify.js";

type StoreCtx = Pick<Store, "id" | "workspaceId" | "timezone" | "grantedScopes">;

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
  const day = localDay(o.createdAt, store.timezone);
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
  let isReturning = false;
  if (ck) {
    if (o.customerOrderCount !== null) isReturning = o.customerOrderCount > 1;
    if (!isReturning) {
      const prior = await systemDb.order.count({
        where: { storeId: store.id, customerKey: ck, shopifyCreatedAt: { lt: o.createdAt }, cancelledAt: null },
      });
      isReturning = prior > 0;
    }
  }

  const base = {
    name: o.name,
    currency: o.currency,
    localDay: day,
    shopifyCreatedAt: o.createdAt,
    shopifyUpdatedAt: o.updatedAt,
    cancelledAt: o.cancelledAt,
    financialStatus: o.financialStatus,
    subtotal: o.subtotal,
    totalDiscounts: o.totalDiscounts,
    totalTax: o.totalTax,
    totalShipping: o.totalShipping,
    totalPrice: o.totalPrice,
    customerKey: ck,
    isReturningCustomer: isReturning,
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
    await tx.orderLineItem.deleteMany({ where: { orderId: order.id } });
    if (o.lineItems.length) {
      await tx.orderLineItem.createMany({
        data: o.lineItems.map((li) => ({
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
): Promise<Set<string> | null> {
  return systemDb.$transaction(async (tx) => {
    // One writer per order, as in upsertOrder (the same lock key).
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`order:${store.id}:${orderShopifyId}`}))`;
    const order = await tx.order.findUnique({
      where: { storeId_shopifyId: { storeId: store.id, shopifyId: orderShopifyId } },
      select: { id: true, localDay: true, salesUpdatedAt: true },
    });
    if (!order) return null;
    if (order.salesUpdatedAt && order.salesUpdatedAt > readAt) return new Set<string>();
    const days = await writeSalesTx(tx, store, order.id, sales);
    await tx.order.update({ where: { id: order.id }, data: { salesUpdatedAt: readAt, ...(salesKey !== undefined ? { salesKey } : {}) } });
    days.add(order.localDay);
    return days;
  });
}

/** The money state the stored sales of an order were read for, or undefined when it isn't stored. */
export async function storedSalesState(store: Pick<Store, "id">, orderShopifyId: string) {
  const o = await systemDb.order.findUnique({
    where: { storeId_shopifyId: { storeId: store.id, shopifyId: orderShopifyId } },
    select: { salesUpdatedAt: true, salesKey: true },
  });
  return o ?? undefined;
}

/** Delete these orders (with their line items and sales); returns the days they were on. */
async function removeOrders(store: StoreCtx, shopifyIds: string[]): Promise<Set<string>> {
  const days = new Set<string>();
  if (!shopifyIds.length) return days;
  const rows = await systemDb.$queryRaw<Array<{ day: string }>>`
    SELECT o.local_day AS day FROM orders o WHERE o.store_id = ${store.id} AND o.shopify_id = ANY(${shopifyIds}::text[])
    UNION
    SELECT s.local_day AS day FROM order_sales s JOIN orders o ON o.id = s.order_id
    WHERE o.store_id = ${store.id} AND o.shopify_id = ANY(${shopifyIds}::text[])`;
  if (!rows.length) return days;
  await systemDb.order.deleteMany({ where: { storeId: store.id, shopifyId: { in: shopifyIds } } });
  for (const r of rows) days.add(r.day);
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
 * It deliberately does NOT derive `is_returning_customer` by counting earlier orders the way
 * `upsertOrder` does: that costs a query per order and is wrong anyway when orders do not
 * arrive oldest-first. Shopify's own count is used when present, and
 * `recomputeReturningCustomers` settles the rest once the import is complete.
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
    const day = localDay(o.createdAt, store.timezone);
    days.add(day);
    for (const x of o.sales ?? []) days.add(localDay(x.happenedAt, store.timezone));
    return {
      shopify_id: o.shopifyId,
      name: o.name,
      currency: o.currency,
      local_day: day,
      created_at: ts(o.createdAt),
      updated_at: ts(o.updatedAt),
      cancelled_at: ts(o.cancelledAt),
      financial_status: o.financialStatus,
      subtotal: String(o.subtotal),
      total_discounts: String(o.totalDiscounts),
      total_tax: String(o.totalTax),
      total_shipping: String(o.totalShipping),
      total_price: String(o.totalPrice),
      customer_key: withCustomers && o.customerId ? customerKey(store, o.customerId) : null,
      is_returning_customer: (o.customerOrderCount ?? 0) > 1,
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
    const salesReadAt = new Map(
      (
        await tx.$queryRaw<Array<{ shopify_id: string; sales_updated_at: Date | null }>>`
          SELECT shopify_id, sales_updated_at FROM orders
          WHERE store_id = ${store.id} AND shopify_id = ANY(${rows.map((o) => o.shopifyId)}::text[])
          FOR UPDATE`
      ).map((r) => [r.shopify_id, r.sales_updated_at]),
    );
    const salesFresh = (o: NormalizedOrder) => {
      const readAt = salesReadAt.get(o.shopifyId);
      return !!o.sales && !(readAt && readAt > o.updatedAt);
    };
    const written = await tx.$queryRaw<Array<{ id: string; shopify_id: string }>>`
      INSERT INTO orders (id, workspace_id, store_id, shopify_id, name, currency, local_day, shopify_created_at, shopify_updated_at,
                          cancelled_at, financial_status, subtotal, total_discounts, total_tax, total_shipping, total_price,
                          customer_key, is_returning_customer, source_name, fulfillment_status, fulfilled_at, discount_codes,
                          traffic_source, traffic_medium, traffic_campaign, referrer_host, sales_updated_at, sales_key)
      SELECT gen_random_uuid()::text, ${store.workspaceId}, ${store.id}, s.shopify_id, s.name, s.currency, s.local_day,
             (s.created_at)::timestamptz AT TIME ZONE 'UTC', (s.updated_at)::timestamptz AT TIME ZONE 'UTC',
             (s.cancelled_at)::timestamptz AT TIME ZONE 'UTC', s.financial_status,
             s.subtotal::numeric, s.total_discounts::numeric, s.total_tax::numeric, s.total_shipping::numeric, s.total_price::numeric,
             s.customer_key, s.is_returning_customer, s.source_name, s.fulfillment_status,
             (s.fulfilled_at)::timestamptz AT TIME ZONE 'UTC', s.discount_codes,
             s.traffic_source, s.traffic_medium, s.traffic_campaign, s.referrer_host,
             (s.sales_updated_at)::timestamptz AT TIME ZONE 'UTC', s.sales_key
      FROM jsonb_to_recordset(${JSON.stringify(payload)}::jsonb) AS s(
        shopify_id text, name text, currency text, local_day text, created_at text, updated_at text, cancelled_at text,
        financial_status text, subtotal text, total_discounts text, total_tax text, total_shipping text, total_price text,
        customer_key text, is_returning_customer boolean, source_name text, fulfillment_status text, fulfilled_at text,
        discount_codes text[], traffic_source text, traffic_medium text, traffic_campaign text, referrer_host text,
        sales_updated_at text, sales_key text
      )
      ON CONFLICT (store_id, shopify_id) DO UPDATE SET
        name = EXCLUDED.name, currency = EXCLUDED.currency, local_day = EXCLUDED.local_day,
        shopify_created_at = EXCLUDED.shopify_created_at, shopify_updated_at = EXCLUDED.shopify_updated_at,
        cancelled_at = EXCLUDED.cancelled_at, financial_status = EXCLUDED.financial_status,
        subtotal = EXCLUDED.subtotal, total_discounts = EXCLUDED.total_discounts, total_tax = EXCLUDED.total_tax,
        total_shipping = EXCLUDED.total_shipping, total_price = EXCLUDED.total_price,
        customer_key = EXCLUDED.customer_key,
        is_returning_customer = orders.is_returning_customer OR EXCLUDED.is_returning_customer,
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

    await tx.$executeRaw`DELETE FROM order_line_items WHERE order_id = ANY(${[...idFor.values()]}::text[])`;

    const items = rows.flatMap((o) => {
      const orderId = idFor.get(o.shopifyId);
      return orderId
        ? o.lineItems.map((li) => ({
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
    Partial<Pick<NormalizedProduct, "vendor" | "productType" | "createdAt">>,
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
  const rows = dedupe(products);
  if (!rows.length) return;
  await systemDb.$executeRaw`
    INSERT INTO products (id, workspace_id, store_id, shopify_id, title, status, vendor, product_type, shopify_created_at, shopify_updated_at)
    SELECT gen_random_uuid()::text, ${store.workspaceId}, ${store.id}, s.shopify_id, s.title, s.status, s.vendor, s.product_type,
           (s.created_at)::timestamptz AT TIME ZONE 'UTC', (s.updated_at)::timestamptz AT TIME ZONE 'UTC'
    FROM unnest(
      ${rows.map((p) => p.shopifyId)}::text[], ${rows.map((p) => p.title)}::text[], ${rows.map((p) => p.status)}::text[],
      ${rows.map((p) => p.vendor ?? null)}::text[], ${rows.map((p) => p.productType ?? null)}::text[],
      ${rows.map((p) => ts(p.createdAt))}::text[], ${rows.map((p) => ts(p.updatedAt))}::text[]
    ) AS s(shopify_id, title, status, vendor, product_type, created_at, updated_at)
    ON CONFLICT (store_id, shopify_id) DO UPDATE SET
      title = EXCLUDED.title, status = EXCLUDED.status, vendor = EXCLUDED.vendor,
      product_type = EXCLUDED.product_type, shopify_created_at = EXCLUDED.shopify_created_at,
      shopify_updated_at = EXCLUDED.shopify_updated_at
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
  const partial = rows.filter((v) => v.unitCost === undefined || v.trackingUnknown === true || v.inventoryQuantity === undefined);
  const full = rows.filter((v) => !partial.includes(v));
  for (const v of partial) await upsertVariant(store, v);
  if (!full.length) return;
  await systemDb.$executeRaw`
    INSERT INTO product_variants (id, workspace_id, store_id, product_shopify_id, shopify_id, title, sku, price, inventory_quantity, unit_cost, shopify_updated_at)
    SELECT gen_random_uuid()::text, ${store.workspaceId}, ${store.id}, s.product_shopify_id, s.shopify_id, s.title, s.sku,
           s.price::numeric, s.inventory_quantity::int, s.unit_cost::numeric, (s.updated_at)::timestamptz AT TIME ZONE 'UTC'
    FROM unnest(
      ${full.map((v) => v.productShopifyId)}::text[], ${full.map((v) => v.shopifyId)}::text[], ${full.map((v) => v.title)}::text[],
      ${full.map((v) => v.sku ?? null)}::text[], ${full.map((v) => String(v.price))}::text[],
      ${full.map((v) => (v.inventoryQuantity == null ? null : String(v.inventoryQuantity)))}::text[],
      ${full.map((v) => (v.unitCost == null ? null : String(v.unitCost)))}::text[],
      ${full.map((v) => ts(v.updatedAt))}::text[]
    ) AS s(product_shopify_id, shopify_id, title, sku, price, inventory_quantity, unit_cost, updated_at)
    ON CONFLICT (store_id, shopify_id) DO UPDATE SET
      product_shopify_id = EXCLUDED.product_shopify_id, title = EXCLUDED.title, sku = EXCLUDED.sku,
      price = EXCLUDED.price, inventory_quantity = EXCLUDED.inventory_quantity, unit_cost = EXCLUDED.unit_cost,
      shopify_updated_at = EXCLUDED.shopify_updated_at
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
  const res = await systemDb.productVariant.deleteMany({
    where: {
      storeId: store.id,
      productShopifyId,
      shopifyId: { notIn: keepShopifyIds },
      shopifyUpdatedAt: { lte: asOf },
    },
  });
  return res.count;
}

/** products/delete: the product and all of its variants. */
export async function deleteProduct(store: Pick<Store, "id">, productShopifyId: string) {
  await systemDb.$transaction([
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
 *    Shipping lines make shipping, duties and fees go to total sales only; gift cards and tips
 *    count nowhere, as in Shopify's reports.
 *  - A return is never counted as money in, whichever sign Shopify gave it (`-ABS`).
 */
export async function recomputeDays(store: Pick<Store, "id" | "workspaceId">, days: string[]) {
  if (!days.length) return;
  await systemDb.$executeRaw`
    ${dayTotals(store, days)}
    INSERT INTO daily_store_metrics
      (workspace_id, store_id, day, gross_sales, discounts, refunds, shipping, taxes, total_sales, orders, units,
       orders_with_customer, returning_customer_orders, refunded_orders)
    SELECT ${store.workspaceId}, ${store.id}, day, gross_sales, discounts, refunds, shipping, taxes, total_sales, orders, units,
           orders_with_customer, returning_customer_orders, refunded_orders
    FROM t
    ON CONFLICT (store_id, day) DO UPDATE SET
      gross_sales = EXCLUDED.gross_sales,
      discounts = EXCLUDED.discounts,
      refunds = EXCLUDED.refunds,
      shipping = EXCLUDED.shipping,
      taxes = EXCLUDED.taxes,
      total_sales = EXCLUDED.total_sales,
      orders = EXCLUDED.orders,
      units = EXCLUDED.units,
      orders_with_customer = EXCLUDED.orders_with_customer,
      returning_customer_orders = EXCLUDED.returning_customer_orders,
      refunded_orders = EXCLUDED.refunded_orders`;
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
      SELECT local_day AS day,
             COUNT(*)::int AS orders,
             (COUNT(*) FILTER (WHERE customer_key IS NOT NULL))::int AS owc,
             (COUNT(*) FILTER (WHERE customer_key IS NOT NULL AND is_returning_customer))::int AS ret
      FROM orders
      WHERE workspace_id = ${store.workspaceId} AND store_id = ${store.id} AND local_day = ANY(${days}::text[])
        ${until ? Prisma.sql`AND shopify_created_at < ${until}` : Prisma.empty}
      GROUP BY local_day
    ),
    v AS (
      SELECT local_day AS day, order_id, action_type, line_type, quantity, discount,
             CASE WHEN action_type = 'return' THEN -ABS(amount - tax) ELSE amount - tax END AS value,
             CASE WHEN action_type = 'return' THEN -ABS(tax) ELSE tax END AS tax
      FROM order_sales
      WHERE workspace_id = ${store.workspaceId} AND store_id = ${store.id} AND local_day = ANY(${days}::text[])
        AND line_type NOT IN ('gift_card', 'tip')
        ${until ? Prisma.sql`AND happened_at < ${until}` : Prisma.empty}
    ),
    s AS (
      SELECT day,
             SUM(value + discount) FILTER (WHERE line_type IN ('product', 'adjustment') AND action_type = 'order') AS gross,
             SUM(discount) FILTER (WHERE line_type IN ('product', 'adjustment') AND action_type = 'order') AS disc,
             -SUM(value) FILTER (WHERE line_type IN ('product', 'adjustment') AND action_type <> 'order') AS returns,
             SUM(value) FILTER (WHERE line_type = 'shipping') AS shipping,
             SUM(tax) AS taxes,
             SUM(value) FILTER (WHERE line_type <> 'shipping' AND line_type NOT IN ('product', 'adjustment')) AS other,
             (SUM(ABS(COALESCE(quantity, 0))) FILTER (WHERE line_type = 'product' AND action_type = 'order'))::int AS units_in,
             (SUM(ABS(COALESCE(quantity, 0))) FILTER (WHERE line_type = 'product' AND action_type = 'return'))::int AS units_out,
             (COUNT(DISTINCT order_id) FILTER (WHERE action_type = 'return'))::int AS ro
      FROM v
      GROUP BY day
    ),
    t AS (
      SELECT d.day,
             COALESCE(s.gross, 0) AS gross_sales, COALESCE(s.disc, 0) AS discounts, COALESCE(s.returns, 0) AS refunds,
             COALESCE(s.shipping, 0) AS shipping, COALESCE(s.taxes, 0) AS taxes,
             COALESCE(s.gross, 0) - COALESCE(s.disc, 0) - COALESCE(s.returns, 0) + COALESCE(s.shipping, 0) + COALESCE(s.taxes, 0) + COALESCE(s.other, 0) AS total_sales,
             COALESCE(o.orders, 0) AS orders, COALESCE(s.units_in, 0) - COALESCE(s.units_out, 0) AS units,
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
 * Repair `is_returning_customer` across a store after a backfill.
 *
 * `upsertOrder` decides this per order, and when Shopify withholds `numberOfOrders` it falls
 * back to counting the customer's earlier orders *already in our database*. That fallback is
 * only correct if orders arrive oldest-first, which they deliberately no longer do - the
 * backfill walks newest-first so the dashboard fills immediately (see `ordersQuery`). One pass
 * at the end of the backfill, when every order is present, settles it.
 *
 * `OR`-ing rather than replacing preserves a `true` that came from `numberOfOrders > 1`: that
 * knows about the customer's orders outside our 60-day window, and nothing in our tables does.
 */
export async function recomputeReturningCustomers(storeId: string) {
  await systemDb.$executeRaw`
    UPDATE orders o SET is_returning_customer = TRUE
    WHERE o.store_id = ${storeId}
      AND o.customer_key IS NOT NULL
      AND NOT o.is_returning_customer
      AND EXISTS (
        SELECT 1 FROM orders p
        WHERE p.store_id = o.store_id
          AND p.customer_key = o.customer_key
          AND p.cancelled_at IS NULL
          AND p.shopify_created_at < o.shopify_created_at
      )`;
}

/** shop/redact & uninstall cleanup: remove all synced commerce data for a store. */
export async function purgeStoreData(storeId: string, fetchImpl?: FetchLike) {
  // Read first: the ad platforms' grants are revoked once the rows are gone (so the store's own
  // connections no longer count as "still using" the grant). Best effort, never blocks the purge.
  const adConnections = await systemDb.adConnection.findMany({ where: { storeId } });
  await systemDb.$transaction([
    systemDb.orderLineItem.deleteMany({ where: { storeId } }),
    systemDb.orderSale.deleteMany({ where: { storeId } }),
    systemDb.refund.deleteMany({ where: { storeId } }),
    systemDb.order.deleteMany({ where: { storeId } }),
    systemDb.productVariant.deleteMany({ where: { storeId } }),
    systemDb.product.deleteMany({ where: { storeId } }),
    systemDb.dailyStoreMetrics.deleteMany({ where: { storeId } }),
    systemDb.funnelDaily.deleteMany({ where: { storeId } }),
    systemDb.funnelVisit.deleteMany({ where: { storeId } }),
    systemDb.pixelEventSeen.deleteMany({ where: { storeId } }),
    // Connected ad accounts belong to the store too: their numbers and their tokens go with it.
    systemDb.adCampaignDaily.deleteMany({ where: { storeId } }),
    systemDb.adsenseDaily.deleteMany({ where: { storeId } }),
    systemDb.adConnection.deleteMany({ where: { storeId } }),
    // WhatsApp: customers' numbers, messages, timelines, reviews, and the store's own credentials.
    systemDb.whatsappMessageEvent.deleteMany({ where: { storeId } }),
    systemDb.whatsappMessage.deleteMany({ where: { storeId } }),
    systemDb.whatsappContact.deleteMany({ where: { storeId } }),
    systemDb.orderTrackingEvent.deleteMany({ where: { storeId } }),
    systemDb.orderTracking.deleteMany({ where: { storeId } }),
    systemDb.abandonedCheckout.deleteMany({ where: { storeId } }),
    systemDb.customerReview.deleteMany({ where: { storeId } }),
    systemDb.whatsappCampaign.deleteMany({ where: { storeId } }),
    systemDb.whatsappAutomationRun.deleteMany({ where: { storeId } }),
    systemDb.whatsappAutomationRule.deleteMany({ where: { storeId } }),
    systemDb.whatsappTemplate.deleteMany({ where: { storeId } }),
    systemDb.whatsappConnection.deleteMany({ where: { storeId } }),
    systemDb.whatsappSettings.deleteMany({ where: { storeId } }),
    // The orders are gone, and the import window with them: the next import records its own.
    systemDb.store.updateMany({ where: { id: storeId }, data: { ordersHistoryFrom: null } }),
  ]);
  // Deleting our copy of a token leaves the access it grants alive at Google or Meta.
  for (const conn of adConnections) await revokeAdAccessIfUnused(conn, fetchImpl);
}

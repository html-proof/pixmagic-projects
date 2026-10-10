import { systemDb, type Store } from "@app/db";
import { expandScopes, hmacSha256Hex, localDay } from "@app/shared";
import { env } from "./env.js";
import type { NormalizedOrder, NormalizedProduct, NormalizedRefund, NormalizedVariant } from "./normalize.js";

type StoreCtx = Pick<Store, "id" | "workspaceId" | "timezone" | "grantedScopes">;

/**
 * Customers are never stored; only a keyed hash scoped to the store, and only
 * when the merchant granted read_customers (the "customers" capability).
 */
export function customerKey(store: Pick<Store, "id">, customerId: string): string {
  return hmacSha256Hex(env().OTP_PEPPER, `${store.id}:${customerId}`);
}

/**
 * Idempotent order upsert. Older payloads (by Shopify updated_at) never
 * overwrite newer ones, so webhook redelivery / out-of-order delivery is safe.
 * Returns the set of local days whose aggregates must be recomputed.
 */
export async function upsertOrder(store: StoreCtx, o: NormalizedOrder): Promise<Set<string>> {
  const days = new Set<string>();
  const day = localDay(o.createdAt, store.timezone);
  const existing = await systemDb.order.findUnique({
    where: { storeId_shopifyId: { storeId: store.id, shopifyId: o.shopifyId } },
    select: { id: true, shopifyUpdatedAt: true, localDay: true },
  });
  if (existing && existing.shopifyUpdatedAt > o.updatedAt) return days;

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
  };

  await systemDb.$transaction(async (tx) => {
    const order = await tx.order.upsert({
      where: { storeId_shopifyId: { storeId: store.id, shopifyId: o.shopifyId } },
      create: { ...base, workspaceId: store.workspaceId, storeId: store.id, shopifyId: o.shopifyId },
      update: base,
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
    for (const r of o.refunds) {
      const rd = await upsertRefundTx(tx, store, order.id, r);
      days.add(rd);
    }
  });

  days.add(day);
  if (existing && existing.localDay !== day) days.add(existing.localDay);
  return days;
}

type TxClient = Parameters<Parameters<typeof systemDb.$transaction>[0]>[0];

async function upsertRefundTx(tx: TxClient, store: StoreCtx, orderId: string, r: NormalizedRefund) {
  const day = localDay(r.createdAt, store.timezone);
  const data = { localDay: day, shopifyCreatedAt: r.createdAt, lineSubtotal: r.lineSubtotal };
  await tx.refund.upsert({
    where: { storeId_shopifyId: { storeId: store.id, shopifyId: r.shopifyId } },
    create: { ...data, workspaceId: store.workspaceId, storeId: store.id, orderId, shopifyId: r.shopifyId },
    update: data,
  });
  return day;
}

/** refunds/create webhook. Returns affected days, or null if the order is unknown yet. */
export async function upsertRefund(
  store: StoreCtx,
  orderShopifyId: string,
  r: NormalizedRefund,
): Promise<Set<string> | null> {
  const order = await systemDb.order.findUnique({
    where: { storeId_shopifyId: { storeId: store.id, shopifyId: orderShopifyId } },
    select: { id: true },
  });
  if (!order) return null;
  const day = await systemDb.$transaction((tx) => upsertRefundTx(tx, store, order.id, r));
  return new Set([day]);
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
 * Returns the store-local days touched, for the caller to aggregate.
 */
export async function writeOrderBatch(store: StoreCtx, orders: NormalizedOrder[]): Promise<Set<string>> {
  const days = new Set<string>();
  const rows = dedupe(orders);
  if (!rows.length) return days;

  const withCustomers = expandScopes(store.grantedScopes).has("read_customers");
  const payload = rows.map((o) => {
    const day = localDay(o.createdAt, store.timezone);
    days.add(day);
    for (const r of o.refunds) days.add(localDay(r.createdAt, store.timezone));
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
    };
  });

  await systemDb.$transaction(async (tx) => {
    const written = await tx.$queryRaw<Array<{ id: string; shopify_id: string }>>`
      INSERT INTO orders (id, workspace_id, store_id, shopify_id, name, currency, local_day, shopify_created_at, shopify_updated_at,
                          cancelled_at, financial_status, subtotal, total_discounts, total_tax, total_shipping, total_price,
                          customer_key, is_returning_customer, source_name, fulfillment_status, fulfilled_at, discount_codes)
      SELECT gen_random_uuid()::text, ${store.workspaceId}, ${store.id}, s.shopify_id, s.name, s.currency, s.local_day,
             (s.created_at)::timestamptz AT TIME ZONE 'UTC', (s.updated_at)::timestamptz AT TIME ZONE 'UTC',
             (s.cancelled_at)::timestamptz AT TIME ZONE 'UTC', s.financial_status,
             s.subtotal::numeric, s.total_discounts::numeric, s.total_tax::numeric, s.total_shipping::numeric, s.total_price::numeric,
             s.customer_key, s.is_returning_customer, s.source_name, s.fulfillment_status,
             (s.fulfilled_at)::timestamptz AT TIME ZONE 'UTC', s.discount_codes
      FROM jsonb_to_recordset(${JSON.stringify(payload)}::jsonb) AS s(
        shopify_id text, name text, currency text, local_day text, created_at text, updated_at text, cancelled_at text,
        financial_status text, subtotal text, total_discounts text, total_tax text, total_shipping text, total_price text,
        customer_key text, is_returning_customer boolean, source_name text, fulfillment_status text, fulfilled_at text,
        discount_codes text[]
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
        fulfilled_at = EXCLUDED.fulfilled_at, discount_codes = EXCLUDED.discount_codes
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

    const refunds = rows.flatMap((o) => {
      const orderId = idFor.get(o.shopifyId);
      return orderId
        ? o.refunds.map((r) => ({
            order_id: orderId,
            shopify_id: r.shopifyId,
            local_day: localDay(r.createdAt, store.timezone),
            created_at: ts(r.createdAt),
            line_subtotal: String(r.lineSubtotal),
          }))
        : [];
    });
    if (refunds.length) {
      await tx.$executeRaw`
        INSERT INTO refunds (id, workspace_id, store_id, order_id, shopify_id, local_day, shopify_created_at, line_subtotal)
        SELECT gen_random_uuid()::text, ${store.workspaceId}, ${store.id}, s.order_id, s.shopify_id, s.local_day,
               (s.created_at)::timestamptz AT TIME ZONE 'UTC', s.line_subtotal::numeric
        FROM jsonb_to_recordset(${JSON.stringify(refunds)}::jsonb) AS s(
          order_id text, shopify_id text, local_day text, created_at text, line_subtotal text
        )
        ON CONFLICT (store_id, shopify_id) DO UPDATE SET
          local_day = EXCLUDED.local_day, shopify_created_at = EXCLUDED.shopify_created_at,
          line_subtotal = EXCLUDED.line_subtotal`;
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
  await systemDb.product.upsert({
    where,
    create: { ...data, workspaceId: store.workspaceId, storeId: store.id, shopifyId: p.shopifyId },
    update: data,
  });
  return true;
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
  await systemDb.productVariant.upsert({
    where,
    create: { ...data, workspaceId: store.workspaceId, storeId: store.id, shopifyId: v.shopifyId },
    update: data,
  });
  return true;
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
 * upsert each), and Hyperdrive is deliberately created with query caching off, so each of
 * those is a real network hop. The pre-read is gone: `WHERE … shopify_updated_at <= excluded…`
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
 * Recompute daily aggregates for the given store-local days from normalized
 * rows. Pure function of the source tables => safe to run any number of times.
 * Mirrors aggregateDaily() in packages/shared/src/kpi.ts (tested for parity).
 */
export async function recomputeDays(store: Pick<Store, "id" | "workspaceId">, days: string[]) {
  if (!days.length) return;
  await systemDb.$executeRaw`
    WITH d AS (SELECT unnest(${days}::text[]) AS day),
    o AS (
      SELECT local_day AS day,
             COUNT(*)::int AS orders,
             (COUNT(*) FILTER (WHERE customer_key IS NOT NULL))::int AS owc,
             (COUNT(*) FILTER (WHERE customer_key IS NOT NULL AND is_returning_customer))::int AS ret
      FROM orders
      WHERE store_id = ${store.id} AND cancelled_at IS NULL AND local_day = ANY(${days}::text[])
      GROUP BY local_day
    ),
    li AS (
      SELECT o.local_day AS day,
             SUM(li.price * li.quantity) AS gross,
             SUM(li.discount) AS disc,
             SUM(li.quantity)::int AS units
      FROM order_line_items li JOIN orders o ON o.id = li.order_id
      WHERE o.store_id = ${store.id} AND o.cancelled_at IS NULL AND o.local_day = ANY(${days}::text[])
      GROUP BY o.local_day
    ),
    r AS (
      SELECT local_day AS day, SUM(line_subtotal) AS refunds, COUNT(DISTINCT order_id)::int AS ro
      FROM refunds
      WHERE store_id = ${store.id} AND local_day = ANY(${days}::text[])
      GROUP BY local_day
    )
    INSERT INTO daily_store_metrics
      (workspace_id, store_id, day, gross_sales, discounts, refunds, orders, units,
       orders_with_customer, returning_customer_orders, refunded_orders)
    SELECT ${store.workspaceId}, ${store.id}, d.day,
           COALESCE(li.gross, 0), COALESCE(li.disc, 0), COALESCE(r.refunds, 0),
           COALESCE(o.orders, 0), COALESCE(li.units, 0),
           COALESCE(o.owc, 0), COALESCE(o.ret, 0), COALESCE(r.ro, 0)
    FROM d
    LEFT JOIN o ON o.day = d.day
    LEFT JOIN li ON li.day = d.day
    LEFT JOIN r ON r.day = d.day
    ON CONFLICT (store_id, day) DO UPDATE SET
      gross_sales = EXCLUDED.gross_sales,
      discounts = EXCLUDED.discounts,
      refunds = EXCLUDED.refunds,
      orders = EXCLUDED.orders,
      units = EXCLUDED.units,
      orders_with_customer = EXCLUDED.orders_with_customer,
      returning_customer_orders = EXCLUDED.returning_customer_orders,
      refunded_orders = EXCLUDED.refunded_orders`;
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
    SELECT local_day AS day FROM refunds WHERE store_id = ${storeId}`;
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
export async function purgeStoreData(storeId: string) {
  await systemDb.$transaction([
    systemDb.orderLineItem.deleteMany({ where: { storeId } }),
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
    systemDb.adConnection.deleteMany({ where: { storeId } }),
  ]);
}

import { Prisma, type Tx } from "@app/db";
import { addDays, eachDay, type DateRange } from "@app/shared";
import { importedData } from "./catalog.js";
import { r2, SALE_UNITS, SALE_VALUE, type Scope } from "./common.js";
import type { Store } from "@app/db";

export const PRODUCT_SORTS = ["units", "revenue", "returned", "lowest"] as const;
export type ProductSort = typeof PRODUCT_SORTS[number];
export interface ProductOptions {
  sortBy?: ProductSort; direction?: "asc" | "desc"; limit?: number; page?: number;
  search?: string; productId?: string; collectionId?: string;
}
export interface ProductMetrics {
  key: string; productId: string | null; title: string; imageUrl: string | null;
  sku: string | null; units: number; grossUnits: number; returnedUnits: number;
  revenue: number; grossSales: number; discounts: number; returns: number;
  orders: number; activeDays: number; recentUnits: number; lastSold: string | null;
}

/** The dates' products in the order asked for, the best 100, a page of them. */
export function rankProducts(rows: ProductMetrics[], options: ProductOptions = {}) {
  const sort = options.sortBy ?? "units";
  const scored = [...rows];
  const value = (p: ProductMetrics) => sort === "revenue" ? p.revenue : sort === "returned" ? p.returnedUnits : p.units;
  const ascending = options.direction ? options.direction === "asc" : sort === "lowest";
  scored.sort((a,b) => (value(a) - value(b)) * (ascending ? 1 : -1) || b.revenue - a.revenue || a.key.localeCompare(b.key));
  const ranked = scored.slice(0, 100).map((p, i) => ({ ...p, rank: i + 1 }));
  const limit = Math.min(100, Math.max(1, options.limit ?? 100));
  const page = Math.max(1, options.page ?? 1);
  return { items: ranked.slice((page - 1) * limit, page * limit), total: ranked.length, page, limit };
}

type Raw = Record<"units" | "gross_units" | "returned_units" | "revenue" | "gross_sales" | "discounts" | "returns" | "orders" | "active_days" | "recent_units", string | number | bigint> & {
  key: string; product_id: string | null; variant_id: string | null; title: string; image_url: string | null; sku: string | null; last_sold: Date | null; current_events: bigint;
};

/**
 * Whether the product sales of `range` are all in and each tied to its product: the dates are
 * imported (`historyFrom`), the store isn't mid-import, no order's sales are provisional or waiting
 * to be read, and every sale has its line item with a product id. `complete` false: nothing is
 * ranked or grouped (Top products, Sales by collection), rather than a partial population.
 */
export async function productSalesCoverage(tx: Tx, { ws, storeId }: Scope, store: Pick<Store, "ordersHistoryFrom" | "status">, range: DateRange, historyFrom: string | null) {
  const current = Prisma.sql`s.local_day BETWEEN ${range.from} AND ${range.to}`;
  const [quality] = await tx.$queryRaw<Array<{ provisional: number; unmatched: number; unknown_identity: number }>>`
    WITH checked AS MATERIALIZED (
      -- Bounded unique-key probes avoid a quadratic join plan immediately after a large import,
      -- before PostgreSQL has collected statistics for the new tenant's rows.
      SELECT s.order_id,
        (SELECT o.sales_updated_at IS NULL FROM orders o
         WHERE o.workspace_id = ${ws} AND o.store_id = ${storeId} AND o.id = s.order_id LIMIT 1) AS provisional,
        (SELECT li.product_shopify_id IS NOT NULL FROM order_line_items li
         WHERE li.workspace_id = ${ws} AND li.store_id = ${storeId} AND li.shopify_id = s.line_item_shopify_id
           AND li.order_id = s.order_id LIMIT 1) AS mapped
      FROM order_sales s
      WHERE s.workspace_id = ${ws} AND s.store_id = ${storeId} AND s.line_type = 'product'
        AND ${current}
    )
    SELECT COUNT(DISTINCT order_id) FILTER (WHERE provisional)::int AS provisional,
      COUNT(*) FILTER (WHERE mapped IS NULL)::int AS unmatched,
      COUNT(*) FILTER (WHERE mapped = FALSE)::int AS unknown_identity
    FROM checked`;
  const pendingOrders = await tx.order.count({ where: { workspaceId: ws, storeId, localDay: { gte: range.from, lte: range.to }, salesUpdatedAt: null } });
  const complete = store.ordersHistoryFrom !== null && historyFrom !== null && range.from >= historyFrom &&
    store.status === "active" && pendingOrders === 0 && !quality?.provisional && !quality?.unmatched && !quality?.unknown_identity;
  return { complete, pendingOrders, unmatchedSales: quality?.unmatched ?? 0, unknownIdentitySales: quality?.unknown_identity ?? 0 };
}

/** Aggregate every ledger row before ranking. Never limit orders or catalog products. */
export async function productPerformance(tx: Tx, scope: Scope, store: Store, range: DateRange, options: ProductOptions = {}) {
  const { ws, storeId } = scope;
  const data = await importedData(tx, scope, store);
  const coverage = await productSalesCoverage(tx, scope, store, range, data.historyFrom);
  const { complete } = coverage;
  const current = Prisma.sql`s.local_day BETWEEN ${range.from} AND ${range.to}`;
  const rows = await tx.$queryRaw<Raw[]>`
    SELECT COALESCE(li.product_shopify_id, 'variant:' || li.variant_shopify_id, 'line:' || li.shopify_id) AS key,
      li.product_shopify_id AS product_id, li.variant_shopify_id AS variant_id,
      COALESCE(MAX(p.title), MAX(li.title)) AS title, MAX(p.image_url) AS image_url, MAX(li.sku) AS sku,
      COUNT(*) FILTER (WHERE ${current}) AS current_events,
      COALESCE(SUM(${SALE_UNITS}) FILTER (WHERE ${current}), 0) AS units,
      COALESCE(SUM(ABS(s.quantity)) FILTER (WHERE ${current} AND s.action_type = 'order'), 0) AS gross_units,
      COALESCE(SUM(ABS(s.quantity)) FILTER (WHERE ${current} AND s.action_type = 'return'), 0) AS returned_units,
      COALESCE(SUM(${SALE_VALUE}) FILTER (WHERE ${current}), 0)::text AS revenue,
      COALESCE(SUM(${SALE_VALUE} + s.discount) FILTER (WHERE ${current} AND s.action_type = 'order'), 0)::text AS gross_sales,
      COALESCE(SUM(s.discount) FILTER (WHERE ${current} AND s.action_type = 'order'), 0)::text AS discounts,
      (-COALESCE(SUM(${SALE_VALUE}) FILTER (WHERE ${current} AND s.action_type <> 'order'), 0))::text AS returns,
      COUNT(DISTINCT s.order_id) FILTER (WHERE ${current} AND s.action_type = 'order') AS orders,
      COUNT(DISTINCT s.local_day) FILTER (WHERE ${current} AND s.action_type = 'order') AS active_days,
      COALESCE(SUM(${SALE_UNITS}) FILTER (WHERE ${current} AND s.local_day >= ${addDays(range.to, -2)}), 0) AS recent_units,
      MAX(s.happened_at) FILTER (WHERE ${current} AND s.action_type = 'order') AS last_sold
    FROM order_sales s
    JOIN LATERAL (
      SELECT li.product_shopify_id, li.variant_shopify_id, li.title, li.sku, li.shopify_id
      FROM order_line_items li WHERE li.workspace_id = ${ws} AND li.store_id = ${storeId}
        AND li.shopify_id = s.line_item_shopify_id AND li.order_id = s.order_id LIMIT 1
    ) li ON TRUE
    LEFT JOIN LATERAL (
      SELECT p.title, p.image_url, p.collections FROM products p
      WHERE p.workspace_id = ${ws} AND p.store_id = ${storeId} AND p.shopify_id = li.product_shopify_id LIMIT 1
    ) p ON TRUE
    WHERE s.workspace_id = ${ws} AND s.store_id = ${storeId} AND s.line_type = 'product'
      AND ${current}
      ${options.productId ? Prisma.sql`AND li.product_shopify_id = ${options.productId}` : Prisma.empty}
      ${options.collectionId ? Prisma.sql`AND EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(p.collections, '[]'::jsonb)) c WHERE c->>'id' = ${options.collectionId})` : Prisma.empty}
    GROUP BY key, li.product_shopify_id, li.variant_shopify_id`;
  const products = new Map<string, ProductMetrics & { variants: Array<{ variantId: string | null; sku: string | null; units: number; revenue: number }> }>();
  const active = new Set(rows.filter(r => Number(r.current_events) > 0).map(r => r.key));
  // Reaggregate products in SQL below instead of summing distinct order/day counts across variants.
  for (const r of rows) {
    const metrics: ProductMetrics = {
      key: r.key, productId: r.product_id, title: r.title, imageUrl: r.image_url, sku: r.sku,
      units: Number(r.units), grossUnits: Number(r.gross_units), returnedUnits: Number(r.returned_units), revenue: Number(r.revenue),
      grossSales: Number(r.gross_sales), discounts: Number(r.discounts), returns: Number(r.returns), orders: Number(r.orders),
      activeDays: Number(r.active_days), recentUnits: Number(r.recent_units), lastSold: r.last_sold?.toISOString() ?? null,
    };
    const variant = { variantId: r.variant_id, sku: r.sku, units: metrics.units, revenue: metrics.revenue };
    const p = products.get(r.key);
    if (!p) products.set(r.key, { ...metrics, variants: [variant] });
    else {
      for (const field of ["units", "grossUnits", "returnedUnits", "revenue", "grossSales", "discounts", "returns", "recentUnits"] as const) p[field] += metrics[field];
      p.sku = p.sku === metrics.sku ? p.sku : null;
      if (metrics.lastSold && (!p.lastSold || metrics.lastSold > p.lastSold)) p.lastSold = metrics.lastSold;
      p.variants.push(variant);
    }
  }
  const counts = await tx.$queryRaw<Array<{ key: string; orders: bigint; days: bigint }>>`
    SELECT COALESCE(li.product_shopify_id, 'variant:' || li.variant_shopify_id, 'line:' || li.shopify_id) AS key,
      COUNT(DISTINCT s.order_id) AS orders, COUNT(DISTINCT s.local_day) AS days
    FROM order_sales s JOIN LATERAL (
      SELECT li.product_shopify_id, li.variant_shopify_id, li.shopify_id
      FROM order_line_items li WHERE li.workspace_id = ${ws} AND li.store_id = ${storeId}
        AND li.shopify_id = s.line_item_shopify_id AND li.order_id = s.order_id LIMIT 1
    ) li ON TRUE
    WHERE s.workspace_id = ${ws} AND s.store_id = ${storeId} AND s.line_type = 'product' AND s.action_type = 'order' AND ${current}
    GROUP BY key`;
  for (const r of counts) { const p = products.get(r.key); if (p) { p.orders = Number(r.orders); p.activeDays = Number(r.days); } }
  if (options.sortBy === "lowest") {
    // Zero-selling catalog products are meaningful in Lowest Performing, but are not best sellers.
    const catalog = await tx.$queryRaw<Array<{ shopify_id: string; title: string; image_url: string | null }>>`
      SELECT p.shopify_id, p.title, p.image_url FROM products p
      WHERE p.workspace_id = ${ws} AND p.store_id = ${storeId}
        ${options.productId ? Prisma.sql`AND p.shopify_id = ${options.productId}` : Prisma.empty}
        ${options.collectionId ? Prisma.sql`AND EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(p.collections, '[]'::jsonb)) c WHERE c->>'id' = ${options.collectionId})` : Prisma.empty}`;
    for (const p of catalog) {
      if (!products.has(p.shopify_id)) products.set(p.shopify_id, { key: p.shopify_id, productId: p.shopify_id, title: p.title, imageUrl: p.image_url, sku: null, units: 0, grossUnits: 0, returnedUnits: 0, revenue: 0, grossSales: 0, discounts: 0, returns: 0, orders: 0, activeDays: 0, recentUnits: 0, lastSold: null, variants: [] });
      active.add(p.shopify_id);
    }
  }
  const search = options.search?.trim().toLowerCase();
  for (const p of products.values()) for (const field of ["revenue", "grossSales", "discounts", "returns"] as const) p[field] = r2(p[field]);
  const eligible = [...products.values()].filter(p => active.has(p.key) && (!search || [p.title, p.productId, ...p.variants.map(v => v.sku)].some(v => v?.toLowerCase().includes(search))));
  const result = rankProducts(eligible, options);
  return { ...result, items: complete ? result.items.map(p => ({ ...p, variants: products.get(p.key)!.variants })) : [], total: complete ? result.total : 0,
    ...coverage, historyFrom: data.historyFrom, lastSyncedAt: store.lastSyncedAt };
}

/**
 * The dates' product costs from the store's own records, for when Shopify's profit report doesn't
 * give them (./shopify.ts `profit`: the store hasn't granted its reports, or Shopify refused or
 * failed): the items sold, returns taken off (SALE_UNITS), at the cost per item each variant has in
 * Shopify now (product_variants.unit_cost). Shopify's report takes the cost recorded with each sale
 * instead, so the two differ only where a cost per item changed since. The net sales of items with no
 * cost per item (none entered, a custom item, a variant since deleted) are added up apart, as
 * Shopify's report does, so the dashboard can say their cost is missing.
 */
export async function productCosts(tx: Tx, { ws, storeId }: Scope, range: DateRange) {
  const [r] = await tx.$queryRaw<Array<{ cost: string | null; with_cost: string | null; without_cost: string | null }>>`
    SELECT SUM(${SALE_UNITS} * v.unit_cost)::text AS cost,
      SUM(${SALE_VALUE}) FILTER (WHERE v.unit_cost IS NOT NULL)::text AS with_cost,
      SUM(${SALE_VALUE}) FILTER (WHERE v.unit_cost IS NULL)::text AS without_cost
    FROM order_sales s
    LEFT JOIN order_line_items li ON li.workspace_id = ${ws} AND li.store_id = ${storeId} AND li.shopify_id = s.line_item_shopify_id
    LEFT JOIN product_variants v ON v.workspace_id = ${ws} AND v.store_id = ${storeId} AND v.shopify_id = li.variant_shopify_id
    WHERE s.workspace_id = ${ws} AND s.store_id = ${storeId} AND s.line_type = 'product'
      AND s.local_day BETWEEN ${range.from} AND ${range.to}`;
  const money = (v: string | null | undefined) => r2(Number(v ?? 0));
  return { current: { costOfGoodsSold: money(r?.cost), netSalesWithCost: money(r?.with_cost), netSalesWithoutCost: money(r?.without_cost) } };
}

/**
 * The same as `productCosts`, day by day (the store-local day of each sale): what the Profit sheet's
 * gross and operating profit take off each day. Every day of `range`, 0 on a day with no product sold.
 */
export async function productCostsByDay(tx: Tx, { ws, storeId }: Scope, range: DateRange) {
  const rows = await tx.$queryRaw<Array<{ day: string; cost: string | null; with_cost: string | null; without_cost: string | null }>>`
    SELECT s.local_day AS day, SUM(${SALE_UNITS} * v.unit_cost)::text AS cost,
      SUM(${SALE_VALUE}) FILTER (WHERE v.unit_cost IS NOT NULL)::text AS with_cost,
      SUM(${SALE_VALUE}) FILTER (WHERE v.unit_cost IS NULL)::text AS without_cost
    FROM order_sales s
    LEFT JOIN order_line_items li ON li.workspace_id = ${ws} AND li.store_id = ${storeId} AND li.shopify_id = s.line_item_shopify_id
    LEFT JOIN product_variants v ON v.workspace_id = ${ws} AND v.store_id = ${storeId} AND v.shopify_id = li.variant_shopify_id
    WHERE s.workspace_id = ${ws} AND s.store_id = ${storeId} AND s.line_type = 'product'
      AND s.local_day BETWEEN ${range.from} AND ${range.to}
    GROUP BY s.local_day`;
  const money = (v: string | null | undefined) => r2(Number(v ?? 0));
  const byDay = new Map(rows.map((r) => [r.day, { day: r.day, costOfGoodsSold: money(r.cost), netSalesWithCost: money(r.with_cost), netSalesWithoutCost: money(r.without_cost) }]));
  return eachDay(range.from, range.to).map((day) => byDay.get(day) ?? { day, costOfGoodsSold: 0, netSalesWithCost: 0, netSalesWithoutCost: 0 });
}

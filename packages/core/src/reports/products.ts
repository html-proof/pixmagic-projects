import { Prisma, type Tx } from "@app/db";
import { addDays, comparisonImported, daysBetweenInclusive, resolvePreset, type DateRange } from "@app/shared";
import { importedData } from "./catalog.js";
import { localMoment, r2, SALE_UNITS, SALE_VALUE, type Scope } from "./common.js";
import type { Store } from "@app/db";

export const PRODUCT_SORTS = ["units", "revenue", "trending", "growth", "returned", "lowest"] as const;
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
  previousUnits: number; previousRevenue: number;
}
export const TREND_WEIGHTS = { units: .3, unitGrowth: .2, revenueGrowth: .15, orders: .15, velocity: .1, consistency: .1 };
export const MIN_TREND_UNITS = 5;
const positive = (n: number) => Math.max(0, n);
const momentum = (current: number, previous: number) => positive(current - previous) / Math.max(1, Math.abs(current), Math.abs(previous));

/** Normalized to [0,100]; new one-sale products never qualify for momentum ranking. */
export function rankProducts(rows: ProductMetrics[], days: number, baseline: boolean, options: ProductOptions = {}) {
  const max = (field: "units" | "orders" | "recentUnits") => rows.reduce((m, r) => Math.max(m, positive(r[field])), 1);
  const maxima = { units: max("units"), orders: max("orders"), recentUnits: max("recentUnits") };
  const sort = options.sortBy ?? "units";
  const scored = rows.map(p => {
    const growth = baseline && p.previousUnits > 0 ? (p.units - p.previousUnits) / p.previousUnits * 100 : null;
    const trend = !baseline || p.previousUnits < 0 ? "No baseline" : p.previousUnits === 0 && p.units > 0 ? "New" : p.units > p.previousUnits ? "Rising" : p.units < p.previousUnits ? "Falling" : "Stable";
    const w = TREND_WEIGHTS;
    const trendScore = !baseline ? null : p.units < MIN_TREND_UNITS ? 0 : 100 * (
      w.units * positive(p.units) / maxima.units + w.unitGrowth * momentum(p.units, p.previousUnits) +
      w.revenueGrowth * momentum(p.revenue, p.previousRevenue) + w.orders * p.orders / maxima.orders +
      w.velocity * positive(p.recentUnits) / maxima.recentUnits + w.consistency * Math.min(1, p.activeDays / days));
    return { ...p, growth, trend, trendScore };
  });
  const value = (p: typeof scored[number]) => sort === "revenue" ? p.revenue : sort === "trending" ? p.trendScore : sort === "growth" ? p.units >= MIN_TREND_UNITS ? p.growth : null : sort === "returned" ? p.returnedUnits : p.units;
  const ascending = options.direction ? options.direction === "asc" : sort === "lowest";
  scored.sort((a,b) => {
    const av = value(a), bv = value(b);
    if (av === null && bv !== null) return 1;
    if (bv === null && av !== null) return -1;
    return ((av ?? 0) - (bv ?? 0)) * (ascending ? 1 : -1) || b.revenue - a.revenue || a.key.localeCompare(b.key);
  });
  const ranked = scored.slice(0, 100).map((p, i) => ({ ...p, rank: i + 1 }));
  const limit = Math.min(100, Math.max(1, options.limit ?? 100));
  const page = Math.max(1, options.page ?? 1);
  return { items: ranked.slice((page - 1) * limit, page * limit), total: ranked.length, page, limit };
}

type Raw = Record<"units" | "gross_units" | "returned_units" | "revenue" | "gross_sales" | "discounts" | "returns" | "orders" | "active_days" | "recent_units" | "previous_units" | "previous_revenue", string | number | bigint> & {
  key: string; product_id: string | null; variant_id: string | null; title: string; image_url: string | null; sku: string | null; last_sold: Date | null; current_events: bigint;
};

/** Aggregate every ledger row before ranking. Never limit orders or catalog products. */
export async function productPerformance(tx: Tx, scope: Scope, store: Store, range: DateRange, options: ProductOptions = {}, now = new Date()) {
  const { ws, storeId } = scope;
  const data = await importedData(tx, scope, store);
  const previous = resolvePreset("custom", now, store.timezone, range).previous;
  const baseline = comparisonImported(previous, data.historyFrom);
  const [quality] = await tx.$queryRaw<Array<{ provisional: number; unmatched: number }>>`
    SELECT COUNT(DISTINCT o.id) FILTER (WHERE o.sales_updated_at IS NULL)::int AS provisional,
      COUNT(*) FILTER (WHERE li.id IS NULL)::int AS unmatched
    FROM order_sales s
    JOIN orders o ON o.workspace_id = ${ws} AND o.store_id = s.store_id AND o.id = s.order_id
    LEFT JOIN order_line_items li ON li.workspace_id = ${ws} AND li.store_id = s.store_id AND li.order_id = s.order_id AND li.shopify_id = s.line_item_shopify_id
    WHERE s.workspace_id = ${ws} AND s.store_id = ${storeId} AND s.line_type = 'product'
      AND s.local_day BETWEEN ${range.from} AND ${range.to}`;
  const pendingOrders = await tx.order.count({ where: { workspaceId: ws, storeId, localDay: { gte: previous.from, lte: range.to }, salesUpdatedAt: null } });
  const complete = store.ordersHistoryFrom !== null && data.historyFrom !== null && range.from >= data.historyFrom &&
    store.status === "active" && pendingOrders === 0 && !quality?.provisional && !quality?.unmatched;
  const current = Prisma.sql`s.local_day BETWEEN ${range.from} AND ${range.to}`;
  const before = Prisma.sql`s.local_day BETWEEN ${previous.from} AND ${previous.to} ${previous.until ? Prisma.sql`AND s.happened_at < ${localMoment(previous.to, previous.until, store.timezone)}` : Prisma.empty}`;
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
      MAX(s.happened_at) FILTER (WHERE ${current} AND s.action_type = 'order') AS last_sold,
      COALESCE(SUM(${SALE_UNITS}) FILTER (WHERE ${before}), 0) AS previous_units,
      COALESCE(SUM(${SALE_VALUE}) FILTER (WHERE ${before}), 0)::text AS previous_revenue
    FROM order_sales s
    JOIN order_line_items li ON li.workspace_id = ${ws} AND li.store_id = s.store_id AND li.order_id = s.order_id AND li.shopify_id = s.line_item_shopify_id
    LEFT JOIN products p ON p.workspace_id = ${ws} AND p.store_id = s.store_id AND p.shopify_id = li.product_shopify_id
    WHERE s.workspace_id = ${ws} AND s.store_id = ${storeId} AND s.line_type = 'product'
      AND s.local_day BETWEEN ${previous.from} AND ${range.to}
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
      previousUnits: Number(r.previous_units), previousRevenue: Number(r.previous_revenue),
    };
    const variant = { variantId: r.variant_id, sku: r.sku, units: metrics.units, revenue: metrics.revenue };
    const p = products.get(r.key);
    if (!p) products.set(r.key, { ...metrics, variants: [variant] });
    else {
      for (const field of ["units", "grossUnits", "returnedUnits", "revenue", "grossSales", "discounts", "returns", "recentUnits", "previousUnits", "previousRevenue"] as const) p[field] += metrics[field];
      p.sku = p.sku === metrics.sku ? p.sku : null;
      if (metrics.lastSold && (!p.lastSold || metrics.lastSold > p.lastSold)) p.lastSold = metrics.lastSold;
      p.variants.push(variant);
    }
  }
  const counts = await tx.$queryRaw<Array<{ key: string; orders: bigint; days: bigint }>>`
    SELECT COALESCE(li.product_shopify_id, 'variant:' || li.variant_shopify_id, 'line:' || li.shopify_id) AS key,
      COUNT(DISTINCT s.order_id) AS orders, COUNT(DISTINCT s.local_day) AS days
    FROM order_sales s JOIN order_line_items li ON li.workspace_id = ${ws} AND li.store_id = s.store_id AND li.order_id = s.order_id AND li.shopify_id = s.line_item_shopify_id
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
      if (!products.has(p.shopify_id)) products.set(p.shopify_id, { key: p.shopify_id, productId: p.shopify_id, title: p.title, imageUrl: p.image_url, sku: null, units: 0, grossUnits: 0, returnedUnits: 0, revenue: 0, grossSales: 0, discounts: 0, returns: 0, orders: 0, activeDays: 0, recentUnits: 0, lastSold: null, previousUnits: 0, previousRevenue: 0, variants: [] });
      active.add(p.shopify_id);
    }
  }
  const search = options.search?.trim().toLowerCase();
  for (const p of products.values()) for (const field of ["revenue", "grossSales", "discounts", "returns", "previousRevenue"] as const) p[field] = r2(p[field]);
  const eligible = [...products.values()].filter(p => active.has(p.key) && (!search || [p.title, p.productId, ...p.variants.map(v => v.sku)].some(v => v?.toLowerCase().includes(search))));
  const result = rankProducts(eligible, daysBetweenInclusive(range.from, range.to), baseline && complete, options);
  return { ...result, items: complete ? result.items.map(p => ({ ...p, variants: products.get(p.key)!.variants })) : [], total: complete ? result.total : 0,
    complete, baseline: baseline && complete, pendingOrders, unmatchedSales: quality?.unmatched ?? 0, previous, historyFrom: data.historyFrom, lastSyncedAt: store.lastSyncedAt, weights: TREND_WEIGHTS, minimumTrendUnits: MIN_TREND_UNITS };
}

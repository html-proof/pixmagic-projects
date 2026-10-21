import { Prisma, type Store, type Tx } from "@app/db";
import { dailyRate, historyStart, MIN_HISTORY_DAYS, type DateRange } from "@app/shared";
import { salesDays, soldCte, STATUS, stockScope, variantStockCte } from "../inventory/stock.js";
import { num, numOrNull, r1, r2, SALE_UNITS, SALE_VALUE, type Scope } from "./common.js";

/**
 * The dashboard's stock card, on the Inventory section's own terms (docs/inventory.md), so the two
 * never disagree about a store's stock: the same stock per variant (`variantStockCte`: every
 * location's levels once the store granted them, else Shopify's totals), the same low and out of
 * stock (`STATUS`: at or under the variant's, the product's or the store's low-stock threshold),
 * and the same sales rate (items sold over the last 30 days the imported orders cover, from
 * Shopify's sales records; none with under MIN_HISTORY_DAYS days). Tracked variants of
 * non-archived products, as the Inventory overview counts them.
 */
export async function inventory(tx: Tx, store: Pick<Store, "id" | "workspaceId" | "grantedScopes" | "timezone" | "ordersHistoryFrom">, today: string) {
  const [scope, sales] = await Promise.all([stockScope(store), salesDays(store, today)]);
  // Stock value counts the units on hand where the levels are known, else the units available.
  const held = scope.source === "levels" ? Prisma.sql`on_hand` : Prisma.sql`available`;
  const [sum] = await tx.$queryRaw<
    Array<{ tracked: number; units: number; cost_value: string | null; with_cost: number; retail: string; out_of_stock: number; low_stock: number }>
  >`
    WITH ${variantStockCte(scope)}
    SELECT COUNT(*) FILTER (WHERE tracked)::int AS tracked,
           COALESCE(SUM(available) FILTER (WHERE tracked), 0)::int AS units,
           SUM(GREATEST(${held}, 0) * unit_cost) FILTER (WHERE tracked AND ${held} > 0)::text AS cost_value,
           COUNT(*) FILTER (WHERE tracked AND unit_cost IS NOT NULL)::int AS with_cost,
           COALESCE(SUM(GREATEST(${held}, 0) * price) FILTER (WHERE tracked), 0)::text AS retail,
           COUNT(*) FILTER (WHERE ${STATUS} = 'out')::int AS out_of_stock,
           COUNT(*) FILTER (WHERE ${STATUS} = 'low')::int AS low_stock
    FROM vs`;
  // The low-stock variants, the ones about to run out first: the fewest days of stock at the
  // sales rate (unknown ones last), then the fewest units, then catalog order.
  const rated = sales.days >= MIN_HISTORY_DAYS;
  const low = await tx.$queryRaw<Array<{ product_title: string; variant_title: string; sku: string | null; qty: number; units: number; cover: number | null }>>`
    WITH ${variantStockCte(scope)}, ${soldCte(scope, sales.from, today)},
    low AS (
      SELECT vs.product_title, vs.variant_title, vs.sku, vs.position, vs.variant_id, vs.available AS qty, COALESCE(s.units, 0)::int AS units,
             CASE WHEN ${rated} AND COALESCE(s.units, 0) > 0 THEN vs.available::float8 * ${sales.days}::float8 / s.units::float8 END AS cover
      FROM vs LEFT JOIN sold s ON s.variant_id = vs.variant_id
      WHERE ${STATUS} = 'low'
    )
    SELECT product_title, variant_title, sku, qty, units, cover
    FROM low
    ORDER BY cover ASC NULLS LAST, qty ASC, product_title ASC, position ASC NULLS LAST, variant_title ASC, variant_id ASC
    LIMIT 10`;
  return {
    current: {
      trackedVariants: num(sum?.tracked),
      unitsInStock: num(sum?.units),
      stockValueAtCost: sum?.with_cost ? numOrNull(sum.cost_value) : null,
      variantsWithCost: num(sum?.with_cost),
      retailValue: num(sum?.retail),
      outOfStock: num(sum?.out_of_stock),
      lowStock: num(sum?.low_stock),
    },
    lowStockItems: low.map((x) => {
      const rate = dailyRate(x.units, sales.days);
      return {
        productTitle: x.product_title,
        variantTitle: x.variant_title,
        sku: x.sku,
        quantity: num(x.qty),
        dailySales: rate === null ? null : r2(rate),
        daysOfCover: x.cover === null ? null : r1(num(x.cover)),
      };
    }),
  };
}

/** Products by status and the vendors whose products sold best in the range. */
export async function catalog(tx: Tx, { ws, storeId }: Scope, r: DateRange) {
  const [counts] = await tx.$queryRaw<Array<{ active: number; draft: number; archived: number; total: number; variants: number }>>`
    SELECT COUNT(*) FILTER (WHERE LOWER(p.status) IN ('active', 'unlisted'))::int AS active,
           COUNT(*) FILTER (WHERE LOWER(p.status) = 'draft')::int AS draft,
           COUNT(*) FILTER (WHERE LOWER(p.status) = 'archived')::int AS archived,
           COUNT(*)::int AS total,
           (SELECT COUNT(*) FROM product_variants v WHERE v.workspace_id = ${ws} AND v.store_id = ${storeId})::int AS variants
    FROM products p
    WHERE p.workspace_id = ${ws} AND p.store_id = ${storeId}`;
  // Net sales by vendor, from the product sales that happened in the range (before tax, after
  // discounts and returns), on the same terms as top products and the sales overview. Line items'
  // own prices include tax where the store's prices do, and leave order discounts and returns out.
  const vendors = await tx.$queryRaw<Array<{ vendor: string; revenue: string; units: bigint }>>`
    SELECT TRIM(p.vendor) AS vendor, SUM(${SALE_VALUE})::text AS revenue,
           SUM(${SALE_UNITS})::bigint AS units
    FROM order_sales s
    JOIN order_line_items li ON li.store_id = s.store_id AND li.shopify_id = s.line_item_shopify_id
    JOIN products p ON p.workspace_id = ${ws} AND p.store_id = ${storeId} AND p.shopify_id = li.product_shopify_id
    WHERE s.workspace_id = ${ws} AND s.store_id = ${storeId} AND li.workspace_id = ${ws}
      AND s.line_type = 'product' AND s.local_day BETWEEN ${r.from} AND ${r.to}
      AND p.vendor IS NOT NULL AND TRIM(p.vendor) <> ''
    GROUP BY TRIM(p.vendor)
    HAVING SUM(${SALE_VALUE}) > 0
    ORDER BY SUM(${SALE_VALUE}) DESC, TRIM(p.vendor)
    LIMIT 5`;
  return {
    products: { active: num(counts?.active), draft: num(counts?.draft), archived: num(counts?.archived), total: num(counts?.total) },
    variants: num(counts?.variants),
    topVendors: vendors.map((x) => ({ vendor: x.vendor, revenue: num(x.revenue), units: num(x.units) })),
  };
}

/**
 * What has been imported so far (all time, cancelled orders included), and from which day every
 * order is in (`historyFrom`, see `historyStart`): what comparisons and the "not imported" days
 * go by, while oldest/newestOrderDay are the orders actually held. Not a module: always present.
 */
export async function importedData(tx: Tx, { ws, storeId }: Scope, store: Pick<Store, "ordersHistoryFrom" | "timezone">) {
  const [row] = await tx.$queryRaw<Array<{ orders: number; oldest_day: string | null; newest_day: string | null; products: number; variants: number }>>`
    SELECT o.orders, o.oldest_day, o.newest_day,
           (SELECT COUNT(*) FROM products p WHERE p.workspace_id = ${ws} AND p.store_id = ${storeId})::int AS products,
           (SELECT COUNT(*) FROM product_variants v WHERE v.workspace_id = ${ws} AND v.store_id = ${storeId})::int AS variants
    FROM (
      SELECT COUNT(*)::int AS orders, MIN(local_day) AS oldest_day, MAX(local_day) AS newest_day
      FROM orders
      WHERE workspace_id = ${ws} AND store_id = ${storeId}
    ) o`;
  return {
    orders: num(row?.orders),
    products: num(row?.products),
    variants: num(row?.variants),
    oldestOrderDay: row?.oldest_day ?? null,
    newestOrderDay: row?.newest_day ?? null,
    historyFrom: historyStart(store.ordersHistoryFrom, store.timezone, row?.oldest_day ?? null),
  };
}

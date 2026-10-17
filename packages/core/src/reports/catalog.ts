import { Prisma, type Store, type Tx } from "@app/db";
import { addDays, historyStart, type DateRange } from "@app/shared";
import { num, numOrNull, r1, r2, SALE_VALUE, type Scope } from "./common.js";

/** Stock rules for the inventory module. */
const VELOCITY_DAYS = 30;
const LOW_STOCK_UNITS = 5;
const LOW_COVER_DAYS = 14;

/**
 * Stock on hand for tracked variants of non-archived products, with sales
 * velocity over the last VELOCITY_DAYS store-local days (today included).
 */
export async function inventory(tx: Tx, { ws, storeId }: Scope, today: string) {
  const velocityFrom = addDays(today, -(VELOCITY_DAYS - 1));
  const stock = Prisma.sql`
    sold AS (
      SELECT li.variant_shopify_id, SUM(li.quantity) AS units
      FROM order_line_items li
      JOIN orders o ON o.id = li.order_id
      WHERE li.workspace_id = ${ws} AND li.store_id = ${storeId}
        AND o.workspace_id = ${ws} AND o.store_id = ${storeId}
        AND o.cancelled_at IS NULL AND o.local_day BETWEEN ${velocityFrom} AND ${today}
        AND li.variant_shopify_id IS NOT NULL
      GROUP BY li.variant_shopify_id
    ),
    stock AS (
      SELECT v.title AS variant_title, v.sku, v.inventory_quantity AS qty, v.price, v.unit_cost,
             p.title AS product_title,
             COALESCE(s.units, 0)::float8 / ${VELOCITY_DAYS}::float8 AS daily
      FROM product_variants v
      LEFT JOIN products p ON p.workspace_id = ${ws} AND p.store_id = ${storeId} AND p.shopify_id = v.product_shopify_id
      LEFT JOIN sold s ON s.variant_shopify_id = v.shopify_id
      WHERE v.workspace_id = ${ws} AND v.store_id = ${storeId}
        AND v.inventory_quantity IS NOT NULL
        AND (p.status IS NULL OR LOWER(p.status) <> 'archived')
    ),
    covered AS (
      SELECT *, CASE WHEN daily > 0 THEN qty / daily END AS cover,
             (qty > 0 AND (qty <= ${LOW_STOCK_UNITS}::int OR (daily > 0 AND qty / daily < ${LOW_COVER_DAYS}::float8))) AS low
      FROM stock
    )`;
  const [sum] = await tx.$queryRaw<
    Array<{ tracked: number; units: bigint; cost_value: string | null; with_cost: number; retail: string; out_of_stock: number; low_stock: number }>
  >`
    WITH ${stock}
    SELECT COUNT(*)::int AS tracked,
           COALESCE(SUM(GREATEST(qty, 0)), 0)::bigint AS units,
           SUM(GREATEST(qty, 0) * unit_cost)::text AS cost_value,
           COUNT(unit_cost)::int AS with_cost,
           COALESCE(SUM(GREATEST(qty, 0) * price), 0)::text AS retail,
           COUNT(*) FILTER (WHERE qty <= 0)::int AS out_of_stock,
           COUNT(*) FILTER (WHERE low)::int AS low_stock
    FROM covered`;
  const low = await tx.$queryRaw<
    Array<{ product_title: string | null; variant_title: string; sku: string | null; qty: number; daily: number; cover: number | null }>
  >`
    WITH ${stock}
    SELECT product_title, variant_title, sku, qty, daily, cover
    FROM covered
    WHERE low
    ORDER BY cover ASC NULLS LAST, qty ASC, product_title, variant_title
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
    lowStockItems: low.map((x) => ({
      productTitle: x.product_title ?? "Unknown product",
      variantTitle: x.variant_title,
      sku: x.sku,
      quantity: num(x.qty),
      dailySales: r2(num(x.daily)),
      daysOfCover: x.cover === null ? null : r1(num(x.cover)),
    })),
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
           SUM(CASE s.action_type WHEN 'order' THEN ABS(COALESCE(s.quantity, 0)) WHEN 'return' THEN -ABS(COALESCE(s.quantity, 0)) ELSE 0 END)::bigint AS units
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

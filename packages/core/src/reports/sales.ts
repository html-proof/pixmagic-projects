import { toNumber, type Tx } from "@app/db";
import { eachDay, type DailyMetricsRow, type DateRange } from "@app/shared";
import { r2, SALE_VALUE, type Scope } from "./common.js";

export async function dailyRows(tx: Tx, workspaceId: string, storeId: string, r: DateRange): Promise<DailyMetricsRow[]> {
  const rows = await tx.dailyStoreMetrics.findMany({
    where: { workspaceId, storeId, day: { gte: r.from, lte: r.to } },
    orderBy: { day: "asc" },
  });
  return rows.map((x) => ({
    day: x.day,
    grossSales: toNumber(x.grossSales),
    discounts: toNumber(x.discounts),
    refunds: toNumber(x.refunds),
    shipping: toNumber(x.shipping),
    taxes: toNumber(x.taxes),
    totalSales: toNumber(x.totalSales),
    orders: x.orders,
    units: x.units,
    ordersWithCustomer: x.ordersWithCustomer,
    returningCustomerOrders: x.returningCustomerOrders,
    refundedOrders: x.refundedOrders,
  }));
}

/**
 * One point per day of the range. daily_store_metrics only has rows for days with orders or
 * refunds, so the quiet days are filled in as zeros: without them the chart drew "last 30 days"
 * as however many days happened to sell, ending on the last sale rather than on today.
 */
export function dailySeries(rows: DailyMetricsRow[], r: DateRange) {
  const byDay = new Map(rows.map((x) => [x.day, x]));
  return eachDay(r.from, r.to).map((day) => {
    const x = byDay.get(day);
    if (!x) return { day, netSales: 0, totalSales: 0, orders: 0, refunds: 0, averageOrderValue: null };
    const beforeRefunds = r2(x.grossSales - x.discounts);
    return {
      day,
      netSales: r2(beforeRefunds - x.refunds),
      totalSales: r2(x.totalSales),
      orders: x.orders,
      refunds: r2(x.refunds),
      averageOrderValue: x.orders > 0 ? r2(beforeRefunds / x.orders) : null,
    };
  });
}

/**
 * Best sellers in the range: each product's net sales (before tax, after discounts and returns)
 * and items sold less items returned, from the product sales that happened in the range, as
 * Shopify's sales by product counts them. The products together make the range's net sales.
 */
export async function topProducts(tx: Tx, { ws, storeId }: Scope, range: DateRange) {
  const top = await tx.$queryRaw<Array<{ product_shopify_id: string | null; title: string; revenue: string; units: bigint }>>`
    SELECT li.product_shopify_id, COALESCE(MAX(p.title), MAX(li.title)) AS title,
           SUM(${SALE_VALUE})::text AS revenue,
           SUM(CASE s.action_type WHEN 'order' THEN ABS(COALESCE(s.quantity, 0)) WHEN 'return' THEN -ABS(COALESCE(s.quantity, 0)) ELSE 0 END) AS units
    FROM order_sales s
    JOIN order_line_items li ON li.store_id = s.store_id AND li.shopify_id = s.line_item_shopify_id
    LEFT JOIN products p ON p.workspace_id = ${ws} AND p.store_id = li.store_id AND p.shopify_id = li.product_shopify_id
    WHERE s.workspace_id = ${ws} AND s.store_id = ${storeId} AND li.workspace_id = ${ws}
      AND s.line_type = 'product' AND s.local_day BETWEEN ${range.from} AND ${range.to}
    GROUP BY li.product_shopify_id
    HAVING SUM(${SALE_VALUE}) > 0
    ORDER BY SUM(${SALE_VALUE}) DESC
    LIMIT 5`;
  return {
    items: top.map((t) => ({ productId: t.product_shopify_id, title: t.title, revenue: Number(t.revenue), units: Number(t.units) })),
  };
}

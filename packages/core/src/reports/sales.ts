import { toNumber, type Tx } from "@app/db";
import { eachDay, type DailyMetricsRow, type DateRange } from "@app/shared";
import { num, r2, type Scope } from "./common.js";

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
    if (!x) return { day, netSales: 0, orders: 0, refunds: 0, averageOrderValue: null };
    const beforeRefunds = r2(x.grossSales - x.discounts);
    return {
      day,
      netSales: r2(beforeRefunds - x.refunds),
      orders: x.orders,
      refunds: r2(x.refunds),
      averageOrderValue: x.orders > 0 ? r2(beforeRefunds / x.orders) : null,
    };
  });
}

export async function taxAndShipping(tx: Tx, { ws, storeId }: Scope, r: DateRange) {
  const [row] = await tx.$queryRaw<Array<{ tax: string; shipping: string }>>`
    SELECT COALESCE(SUM(o.total_tax), 0)::text AS tax, COALESCE(SUM(o.total_shipping), 0)::text AS shipping
    FROM orders o
    WHERE o.workspace_id = ${ws} AND o.store_id = ${storeId}
      AND o.cancelled_at IS NULL AND o.local_day BETWEEN ${r.from} AND ${r.to}`;
  return { tax: num(row?.tax), shipping: num(row?.shipping) };
}

/** Best sellers in the range: revenue after line discounts, cancelled orders excluded. */
export async function topProducts(tx: Tx, { ws, storeId }: Scope, range: DateRange) {
  const top = await tx.$queryRaw<Array<{ product_shopify_id: string | null; title: string; revenue: string; units: bigint }>>`
    SELECT li.product_shopify_id, COALESCE(MAX(p.title), MAX(li.title)) AS title,
           SUM(li.price * li.quantity - li.discount)::text AS revenue, SUM(li.quantity) AS units
    FROM order_line_items li
    JOIN orders o ON o.id = li.order_id
    LEFT JOIN products p ON p.workspace_id = ${ws} AND p.store_id = li.store_id AND p.shopify_id = li.product_shopify_id
    WHERE li.workspace_id = ${ws} AND li.store_id = ${storeId}
      AND o.workspace_id = ${ws} AND o.store_id = ${storeId}
      AND o.cancelled_at IS NULL AND o.local_day BETWEEN ${range.from} AND ${range.to}
    GROUP BY li.product_shopify_id
    ORDER BY SUM(li.price * li.quantity - li.discount) DESC
    LIMIT 5`;
  return {
    items: top.map((t) => ({ productId: t.product_shopify_id, title: t.title, revenue: Number(t.revenue), units: Number(t.units) })),
  };
}

import { toNumber, type Tx } from "@app/db";
import { addDays, eachDay, type Comparison, type DailyMetricsRow, type DateRange } from "@app/shared";
import { dayTotals } from "../persist.js";
import { localMoment, r2, type Scope } from "./common.js";

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
    duties: toNumber(x.duties),
    additionalFees: toNumber(x.additionalFees),
    totalSales: toNumber(x.totalSales),
    totalRefunded: toNumber(x.totalRefunded),
    orders: x.orders,
    // A row from before order_value was kept: gross − discounts, as average order value was then.
    orderValue: x.orderValue === null ? r2(toNumber(x.grossSales) - toNumber(x.discounts)) : toNumber(x.orderValue),
    units: x.units,
    ordersWithCustomer: x.ordersWithCustomer,
    returningCustomerOrders: x.returningCustomerOrders,
    refundedOrders: x.refundedOrders,
  }));
}

/**
 * The day rows of dates that may stop at a time of day (`until`: the range picked is still running,
 * and is checked against Shopify's own figures up to that moment). Their last day is then worked
 * out from the orders and sales placed before that moment, by the same query that fills
 * daily_store_metrics, whose rows only ever hold whole days.
 */
export async function comparisonRows(tx: Tx, workspaceId: string, storeId: string, c: Comparison, timeZone: string): Promise<DailyMetricsRow[]> {
  if (!c.until) return dailyRows(tx, workspaceId, storeId, c);
  const whole = c.from < c.to ? await dailyRows(tx, workspaceId, storeId, { from: c.from, to: addDays(c.to, -1) }) : [];
  type Column =
    | "gross_sales"
    | "discounts"
    | "refunds"
    | "shipping"
    | "taxes"
    | "duties"
    | "additional_fees"
    | "total_sales"
    | "total_refunded"
    | "orders"
    | "order_value"
    | "units"
    | "orders_with_customer"
    | "returning_customer_orders"
    | "refunded_orders";
  const part = await tx.$queryRaw<Array<Record<Column | "day", string>>>`
    ${dayTotals({ id: storeId, workspaceId }, [c.to], localMoment(c.to, c.until, timeZone))}
    SELECT day, gross_sales::text, discounts::text, refunds::text, shipping::text, taxes::text, duties::text, additional_fees::text, total_sales::text, total_refunded::text,
           orders::text, order_value::text, units::text, orders_with_customer::text, returning_customer_orders::text, refunded_orders::text
    FROM t`;
  return [
    ...whole,
    ...part.map((x) => ({
      day: x.day,
      grossSales: Number(x.gross_sales),
      discounts: Number(x.discounts),
      refunds: Number(x.refunds),
      shipping: Number(x.shipping),
      taxes: Number(x.taxes),
      duties: Number(x.duties),
      additionalFees: Number(x.additional_fees),
      totalSales: Number(x.total_sales),
      totalRefunded: Number(x.total_refunded),
      orders: Number(x.orders),
      orderValue: Number(x.order_value),
      units: Number(x.units),
      ordersWithCustomer: Number(x.orders_with_customer),
      returningCustomerOrders: Number(x.returning_customer_orders),
      refundedOrders: Number(x.refunded_orders),
    })),
  ];
}

/**
 * Customers who ordered in a range, as Shopify's reports count them: each customer once, however
 * many orders they placed. `returning` are those with an order from a customer whose history
 * already held one (`orders.is_returning_customer`, settled from Shopify's own position of the
 * order), `firstTime` those with their very first purchase in the range; a customer who bought
 * for the first time and again in the same range is in both. The rate is returning ÷ customers
 * (Shopify's "returning customer rate"), null without customers.
 */
export async function customerCounts(tx: Tx, { ws, storeId }: Scope, r: DateRange) {
  // A customer who bought only gift cards isn't one of Shopify's customers for the range.
  const [row] = await tx.$queryRaw<Array<{ customers: number; returning: number; first_time: number }>>`
    SELECT COUNT(DISTINCT customer_key)::int AS customers,
           (COUNT(DISTINCT customer_key) FILTER (WHERE is_returning_customer))::int AS returning,
           (COUNT(DISTINCT customer_key) FILTER (WHERE NOT is_returning_customer))::int AS first_time
    FROM orders
    WHERE workspace_id = ${ws} AND store_id = ${storeId} AND customer_key IS NOT NULL AND NOT gift_card_only
      AND local_day BETWEEN ${r.from} AND ${r.to}`;
  const customers = row?.customers ?? 0;
  const returning = row?.returning ?? 0;
  return { customers, returningCustomers: returning, newCustomers: row?.first_time ?? 0, returningCustomerRate: customers > 0 ? returning / customers : null };
}

/**
 * One point per day of the range. daily_store_metrics only has rows for days with orders or
 * refunds, so the quiet days are filled in as zeros: without them the chart drew "last 30 days"
 * as however many days happened to sell, ending on the last sale rather than on today. Each day
 * carries the lines of its total sales too (shipping, tax, duties, additional fees), from which
 * the store's own calculation (Custom sales, @app/shared/salesCalculation) is drawn day by day.
 */
export function dailySeries(rows: DailyMetricsRow[], r: DateRange) {
  const byDay = new Map(rows.map((x) => [x.day, x]));
  return eachDay(r.from, r.to).map((day) => {
    const x = byDay.get(day);
    if (!x) return { day, grossSales: 0, discounts: 0, netSales: 0, totalSales: 0, shipping: 0, tax: 0, duties: 0, additionalFees: 0, orders: 0, units: 0, refunds: 0, averageOrderValue: null, orderValue: 0, newCustomerOrders: 0 };
    const beforeRefunds = r2(x.grossSales - x.discounts);
    return {
      day,
      // Gross sales less discounts and returns is net sales (the Profit sheet's profit and loss shows each).
      grossSales: r2(x.grossSales),
      discounts: r2(x.discounts),
      netSales: r2(beforeRefunds - x.refunds),
      totalSales: r2(x.totalSales),
      shipping: r2(x.shipping),
      tax: r2(x.taxes),
      duties: r2(x.duties),
      additionalFees: r2(x.additionalFees),
      orders: x.orders,
      units: x.units,
      refunds: r2(x.refunds),
      averageOrderValue: x.orders > 0 ? r2(x.orderValue / x.orders) : null,
      // What average order value divides: the day's orders' items after discounts, before tax (the
      // Profit sheet adds it up over weeks and months, where averaging the averages would be wrong).
      orderValue: r2(x.orderValue),
      // Orders of customers buying for the first time: of the orders with a customer, the ones not returning.
      newCustomerOrders: x.ordersWithCustomer - x.returningCustomerOrders,
    };
  });
}

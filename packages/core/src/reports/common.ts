/**
 * Shared pieces of the dashboard's report queries (see ./overview.ts).
 *
 * Every query filters on workspace_id AND store_id (RLS is the backstop, not the filter) and uses
 * bound parameters only. Sales money is read from Shopify's sales records (order_sales), dated by
 * when each sale happened, so it adds up to the sales overview's net sales; order counts are the
 * orders placed in the range. Money comes back from SQL as text (exact decimals) and is converted
 * with Number at the edge.
 */
import { Prisma } from "@app/db";


/**
 * A sale's value before tax, as recomputeDays reads it (`saleValue` in @app/shared), with the sign
 * Shopify gave it. For a query whose order_sales alias is `s`.
 */
export const SALE_VALUE = Prisma.sql`(s.amount - s.tax)`;

/**
 * Items sold in a sale, as Shopify's sales by product count them: the quantity of an order's sale,
 * less a return's (a refund, a cancellation); the quantity on an edit's own sale counts neither
 * way. For a query whose order_sales alias is `s`. Every place that counts items (the dashboard's
 * top products and vendors, the Inventory section's sales figures) uses this one expression.
 */
export const SALE_UNITS = Prisma.sql`(CASE s.action_type WHEN 'order' THEN ABS(COALESCE(s.quantity, 0)) WHEN 'return' THEN -ABS(COALESCE(s.quantity, 0)) ELSE 0 END)`;

/** The sales of items that come out of stock: product lines, and gift card products sold as goods. */
export const ITEM_SALES = Prisma.sql`s.line_type IN ('product', 'gift_card')`;

/**
 * A store-local wall-clock moment (`day` at `time`, "HH:MM:SS", in the store's zone) as the UTC
 * timestamps the tables hold. Wall-clock, so a comparison across a daylight-saving change still
 * stops at the same time of day.
 */
export const localMoment = (day: string, time: string, timeZone: string) =>
  Prisma.sql`((${day}::date + ${time}::time) AT TIME ZONE ${timeZone}) AT TIME ZONE 'UTC'`;

/** Lines whose value is net sales (MERCHANDISE_LINES in @app/shared). */
export const MERCHANDISE = Prisma.sql`s.line_type IN ('product', 'adjustment')`;

/** Tenant + store being reported on. */
export interface Scope {
  ws: string;
  storeId: string;
}

export const r1 = (n: number) => Math.round(n * 10) / 10;
export const r2 = (n: number) => Math.round(n * 100) / 100;
export const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
export const numOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/** Index of the largest value, or null when everything is zero. First wins on ties. */
export function argMax(values: number[]): number | null {
  let best: number | null = null;
  values.forEach((v, i) => {
    if (v > 0 && (best === null || v > values[best]!)) best = i;
  });
  return best;
}

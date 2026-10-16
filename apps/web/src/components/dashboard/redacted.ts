import type { SalesDay } from "@app/shared/sales";
import type { SalesOverview } from "./types";

// The dashboard's answer leaves out what a member may not see (Team & Access, `redactOverview` in
// @app/shared/access). These read the fields that can be missing, so a page never does arithmetic
// on a figure that isn't there or shows a zero for one it may not know.

/**
 * The day rows as the sales charts take them: a refund or total the member may not see counts as
 * none (these charts only sum net sales).
 */
export const asSalesDays = (series: SalesOverview["series"]): SalesDay[] =>
  series.map((d) => ({ ...d, refunds: d.refunds ?? 0, totalSales: d.totalSales ?? 0 }));

/** Whether the day rows carry refunds ("View refunds"). */
export const showsRefunds = (series: SalesOverview["series"]) => series.some((d) => d.refunds !== undefined);

/** Whether the day rows carry total sales ("View gross sales, discounts, tax and shipping": it holds tax and shipping). */
export const showsTotalSales = (series: SalesOverview["series"]) => series.some((d) => d.totalSales !== undefined);

/** Gross sales, discounts, tax and shipping, when the member may see them ("View gross sales, discounts, tax and shipping"). */
export function breakdownOf(c: SalesOverview["current"]) {
  if (c.grossSales === undefined || c.discounts === undefined) return null;
  return { grossSales: c.grossSales, discounts: c.discounts, tax: c.tax ?? null, shipping: c.shipping ?? null };
}

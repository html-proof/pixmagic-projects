import { MONTH_LINES, type SalesMonth } from "@app/shared/sales";
import { calculationName, customApplied, customSales, type SalesLines } from "@app/shared/salesCalculation";
import type { SalesOverview, YearMonth } from "./types";

/** Change on the period compared with; null without one, as the API's deltas. */
const delta = (now: number, before: number) => (before === 0 ? null : (now - before) / Math.abs(before));

// The dashboard's answer leaves out what a member may not see (Team & Access, `redactOverview` in
// @app/shared/access). These read the fields that can be missing, so a page never does arithmetic
// on a figure that isn't there or shows a zero for one it may not know.

/**
 * The day rows as the sales charts take them: a refund or total the member may not see counts as
 * none (these charts sum net sales, or Custom sales from the day's lines: `dayLinesOf`).
 */
export const asSalesDays = <D extends SalesOverview["series"][number]>(series: D[]) =>
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

/**
 * The lines of total sales for a period (`current` or `previous`), when the member may see them
 * (the same permission as the breakdown). Duties and additional fees are 0 in an answer that
 * predates them: total sales then holds them, and `splitTotal` reports them as not split.
 */
export function salesLinesOf(c: SalesOverview["current"] | SalesOverview["previous"]): SalesLines | null {
  if (!c || c.totalSales === undefined || c.tax === undefined || c.shipping === undefined) return null;
  return { netSales: c.netSales, additionalFees: c.additionalFees ?? 0, duties: c.duties ?? 0, shipping: c.shipping, taxes: c.tax, totalSales: c.totalSales };
}

/** A day of the series as lines (only for a member who may see them: `tax` is there). */
export const dayLinesOf = (d: SalesOverview["series"][number]): Omit<SalesLines, "totalSales"> | null =>
  d.tax === undefined || d.shipping === undefined ? null : { netSales: d.netSales, additionalFees: d.additionalFees ?? 0, duties: d.duties ?? 0, shipping: d.shipping, taxes: d.tax };

/** A month of this year with its lines of total sales, when the member may see them (as `dayLinesOf`). */
export const hasMonthLines = (m: YearMonth): m is SalesMonth => MONTH_LINES.every((k) => m[k] !== undefined);

/**
 * Custom sales as the dashboard shows it next to Shopify's figures: only when the store applies a
 * calculation that differs from Shopify's total sales, and the member may see its lines. Its name
 * goes wherever it shows, so it is never mistaken for Shopify's figure.
 */
export function appliedCustom(s: SalesOverview | undefined) {
  if (!s || !customApplied(s.calculation)) return null;
  const calc = s.calculation!;
  const now = salesLinesOf(s.current);
  if (!now) return null;
  const before = salesLinesOf(s.previous);
  const current = customSales(now, calc.components);
  const previous = before ? customSales(before, calc.components) : null;
  return {
    name: calculationName(calc),
    components: calc.components,
    current,
    previous,
    delta: previous === null ? null : delta(current, previous),
  };
}

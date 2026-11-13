import { outcomeOf, type ProfitLoss } from "@app/shared/profit";
import type { Tone } from "@/components/dashboard/Primitives";

// ---------------------------------------------------------------------------
// Small pieces the Profit & Loss page's sections share.
// ---------------------------------------------------------------------------

/** An ad platform by name, for its spend's row. */
export const PLATFORM_NAME: Record<string, string> = { meta: "Meta", google: "Google" };

/** A profit's tone: good above 0, danger below, none at 0 or when not known. */
export const toneOf = (n: number | null | undefined): Tone | undefined => {
  const o = outcomeOf(n);
  return o === "profit" ? "good" : o === "loss" ? "danger" : undefined;
};

export const TONE_TEXT: Partial<Record<Tone, string>> = { good: "text-good", danger: "text-danger" };

/** Cents added up, null when any isn't known. */
export const sumOf = (...xs: Array<number | null | undefined>) => (xs.some((x) => x === null || x === undefined) ? null : xs.reduce<number>((a, x) => a + Math.round(x! * 100), 0) / 100);

/** A group of costs as the page's ring and tiles show it: the same five everywhere, each its own colour. */
export interface CostGroup {
  key: "products" | "variable" | "fixed" | "advertising" | "other";
  label: string;
  /** null when the figure isn't known (the statement's gaps say why). */
  amount: number | null;
  color: string;
  /** What the group holds, in plain words. */
  help: string;
}

/**
 * Every cost of the dates in five groups that add up to total expenses (`profitAndLoss`): product
 * costs and the other variable costs (together the statement's variable costs), fixed costs,
 * advertising, and what sits below operating profit.
 */
export function costGroups(t: ProfitLoss): CostGroup[] {
  return [
    { key: "products", label: "Product costs", amount: t.grossGaps.length ? null : t.productCosts, color: "var(--violet)", help: "What the items you sold cost you: each item at its cost per item in Shopify." },
    { key: "variable", label: "Other variable costs", amount: t.yours.bySection.variable, color: "var(--viz-day-strong)", help: "Your costs that rise and fall with sales: shipping, packaging, payment fees and the like." },
    { key: "fixed", label: "Fixed costs", amount: t.fixedCosts, color: "var(--rose)", help: "Costs you pay whatever you sell (rent, salaries, software), each day carrying its share." },
    { key: "advertising", label: "Advertising", amount: t.advertising, color: "var(--viz-day)", help: "Your connected ad accounts' spend, plus the advertising you added yourself." },
    { key: "other", label: "Interest, tax and other", amount: t.belowOperating, color: "var(--muted)", help: "Loan interest, income tax, depreciation and the like." },
  ];
}

/** The best and the worst day of the dates by profit, and the average a day; null where a day's profit isn't known. */
export function profitDays(daily: ReadonlyArray<{ day: string; netProfit: number | null }>, total: number | null) {
  const known = daily.filter((d): d is { day: string; netProfit: number } => d.netProfit !== null);
  if (!daily.length || known.length !== daily.length) return { average: null, best: null, worst: null };
  const best = known.reduce((a, d) => (d.netProfit > a.netProfit ? d : a));
  const worst = known.reduce((a, d) => (d.netProfit < a.netProfit ? d : a));
  return { average: total === null ? null : Math.round((total / daily.length) * 100) / 100, best, worst };
}

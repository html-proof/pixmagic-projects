/** Store health rules shared by reports and UI; ratios use fractions, not percentages. */
export type Health = "attention" | "watch" | "good" | "info";

export const HEALTH_ORDER: Record<Health, number> = { attention: 0, watch: 1, good: 2, info: 3 };

/** An unfinished day and missing/non-finite comparisons must never be graded. */
export function trendHealth(delta: number | null, running: boolean): Health {
  if (running || delta === null || !Number.isFinite(delta)) return "info";
  return delta >= 0 ? "good" : delta > -0.1 ? "watch" : "attention";
}

export function refundHealth(rate: number | null): Health {
  if (rate === null || !Number.isFinite(rate)) return "info";
  return rate <= 0.05 ? "good" : rate <= 0.1 ? "watch" : "attention";
}

export function stockHealth(outOfStock: number, lowStock: number): Health {
  return outOfStock > 0 ? "attention" : lowStock > 0 ? "watch" : "good";
}

export function shippingHealth(openOrders: number, oldestOpenDays: number | null): Health {
  return openOrders === 0 ? "good" : (oldestOpenDays ?? 0) > 3 ? "attention" : "watch";
}

export function worstHealth(statuses: readonly Health[]): Health {
  return statuses.reduce<Health>((worst, status) => HEALTH_ORDER[status] < HEALTH_ORDER[worst] ? status : worst, "info");
}

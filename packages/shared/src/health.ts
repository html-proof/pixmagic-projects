/**
 * Health grading for the dashboard: the rules that say whether an area of the store looks good,
 * is one to keep an eye on, or needs attention. Kept deliberately plain so a merchant can predict
 * them (docs/kpis.md, "Business overview"):
 *
 * - a number that should grow: up or level is good, down by less than 10% is one to watch,
 *   down by 10% or more needs attention; nothing to compare with is information only;
 * - refunds: up to 5% of sales is good, up to 10% to watch, more needs attention;
 * - stock: anything sold out needs attention, anything running low is one to watch;
 * - shipping: an order waiting over 3 days needs attention, any waiting is one to watch.
 *
 * Pure and browser-safe: the web app imports it as `@app/shared/health`.
 */

/** A graded status, worst first. */
export type Grade = "attention" | "watch" | "good";
/** A graded status, or `info` for a fact with nothing to grade it against. */
export type Health = Grade | "info";

export const GRADE = {
  /** A number that should grow: a fall of this fraction or more needs attention; a smaller fall is one to watch. */
  trendDrop: 0.1,
  /** Refunds as a share of sales: up to this is good. */
  refundRateGood: 0.05,
  /** Refunds as a share of sales: up to this (and over `refundRateGood`) is one to watch; over it needs attention. */
  refundRateWatch: 0.1,
  /** Shipping: an open order waiting more than this many days needs attention. */
  shippingDays: 3,
  /** Restocking: an item with fewer than this many days of sales left is urgent. */
  coverDays: 7,
  /** Restocking: an item with this many units or fewer left is urgent, whatever it sells. */
  coverUnits: 2,
} as const;

/**
 * A number that should grow, by its change on the period before (a fraction, e.g. -0.04).
 * Nothing to compare with is information only, and so is a period still running (only today
 * picked): it isn't over, so it isn't graded against a whole one.
 */
export const gradeTrend = (change: number | null, running = false): Health =>
  running || change === null ? "info" : change >= 0 ? "good" : change > -GRADE.trendDrop ? "watch" : "attention";

/** Refunds as a share of sales (after discounts). */
export const gradeRefundRate = (rate: number): Grade => (rate <= GRADE.refundRateGood ? "good" : rate <= GRADE.refundRateWatch ? "watch" : "attention");

/** Stock, by how many variants are sold out and how many are running low. */
export const gradeStock = (outOfStock: number, lowStock: number): Grade => (outOfStock > 0 ? "attention" : lowStock > 0 ? "watch" : "good");

/** Whether the oldest order still waiting to ship has waited too long (nothing waiting: no). */
export const shippingIsLate = (oldestOpenDays: number | null): boolean => (oldestOpenDays ?? 0) > GRADE.shippingDays;

/** Shipping, by the orders waiting to ship now and how long the oldest of them has waited. */
export const gradeShipping = (openNow: number, oldestOpenDays: number | null): Grade => (openNow === 0 ? "good" : shippingIsLate(oldestOpenDays) ? "attention" : "watch");

/**
 * One item that is running low: urgent with under a week of sales left (`daysOfCover`, null with
 * no recent sales) or 2 units or fewer; otherwise one to watch.
 */
export const gradeCover = (daysOfCover: number | null, quantity: number): Exclude<Grade, "good"> =>
  (daysOfCover !== null && daysOfCover < GRADE.coverDays) || quantity <= GRADE.coverUnits ? "attention" : "watch";

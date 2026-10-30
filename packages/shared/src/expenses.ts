/**
 * A store's own costs (Settings → Costs, docs/kpis.md "Costs and net profit"): what neither
 * Shopify, its profit report nor the ad platforms can tell bizinsights. Shopify's plan and app
 * bills, staff, rent, shipping labels, payment fees, ads on platforms that aren't connected... The
 * owner enters each one with how often it is paid; bizinsights spreads it over the days it covers
 * and adds up the days of the dates on screen. Nothing here is estimated or read from an outside
 * service: every figure is the merchant's own, and the page says so.
 *
 * Net profit is shown only when every input is known (`netProfit`): Shopify's cost of goods sold,
 * the connected ad accounts' spend, and these costs for dates the owner has said the list is
 * complete for. Otherwise the dashboard shows what is left after the costs it does know, and names
 * what is missing; it never calls that net profit.
 *
 * Money is added up in whole cents where it can be; a cost spread over days is rounded to the cent
 * once, for the dates as a whole.
 */
// Extensionless imports: the web app imports this file directly (@app/shared/expenses).
import { addDays, daysBetweenInclusive, isDay, type DateRange } from "./dates";
import { z } from "./zod";

/** What a cost is for, in the order Settings → Costs offers them. */
export const EXPENSE_CATEGORIES = ["shopify_plan", "shopify_apps", "software", "staff", "rent", "shipping", "payment_fees", "marketing", "other"] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export const EXPENSE_CATEGORY_LABEL: Record<ExpenseCategory, string> = {
  shopify_plan: "Shopify plan",
  shopify_apps: "Shopify apps",
  software: "Other software",
  staff: "Staff and contractors",
  rent: "Rent and utilities",
  shipping: "Shipping and packaging",
  payment_fees: "Payment and transaction fees",
  marketing: "Other marketing",
  other: "Other",
};

/** How often a cost is paid: `once` on its day, the others every week, month or year from it. */
export const EXPENSE_CADENCES = ["once", "weekly", "monthly", "yearly"] as const;
export type ExpenseCadence = (typeof EXPENSE_CADENCES)[number];

export const EXPENSE_CADENCE_LABEL: Record<ExpenseCadence, string> = { once: "Once", weekly: "Every week", monthly: "Every month", yearly: "Every year" };

/** The most costs one store keeps: enough for any shop's bills, few enough to add up on every dashboard answer. */
export const MAX_EXPENSES = 200;
/** The largest single amount taken (in the store's currency). */
export const MAX_EXPENSE_AMOUNT = 100_000_000;

const day = z.string().refine((s) => isDay(s), "Pick a real date (YYYY-MM-DD)");

/** What POST .../expenses and PUT .../expenses/:id take: one cost, whole. */
export const expenseInput = z
  .object({
    name: z.string().trim().min(1, "Give the cost a name").max(80),
    category: z.enum(EXPENSE_CATEGORIES),
    /** In the store's currency, cents at most. */
    amount: z
      .number()
      .min(0)
      .max(MAX_EXPENSE_AMOUNT)
      .refine((n) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6, "Amounts go to the cent at most"),
    cadence: z.enum(EXPENSE_CADENCES),
    /** The store-local day it starts (for `once`, the day it was paid). */
    startsOn: day,
    /** The last day it applies to; null while it goes on. A cost paid once has none. */
    endsOn: day.nullable(),
    note: z.string().trim().max(500).nullable(),
  })
  .strict()
  .refine((x) => x.endsOn === null || x.endsOn >= x.startsOn, { message: "It can't end before it starts", path: ["endsOn"] })
  .refine((x) => x.cadence !== "once" || x.endsOn === null, { message: "A cost paid once has no end date", path: ["endsOn"] });

export type ExpenseInput = z.infer<typeof expenseInput>;

/** What PUT .../expenses/settings takes: from which day the list holds every cost (null: not said). */
export const expenseSettingsInput = z.object({ completeFrom: day.nullable() }).strict();
export type ExpenseSettingsInput = z.infer<typeof expenseSettingsInput>;

/** One cost as the API returns it. */
export interface Expense extends ExpenseInput {
  id: string;
  createdAt: string;
  updatedAt: string;
}

/** The part of a cost this module works with. */
export type ExpenseTerms = Pick<ExpenseInput, "amount" | "cadence" | "startsOn" | "endsOn">;

const daysInMonth = (d: string) => new Date(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)), 0)).getUTCDate();
const daysInYear = (d: string) => (daysInMonth(`${d.slice(0, 4)}-02-01`) === 29 ? 366 : 365);
const monthEnd = (d: string) => `${d.slice(0, 8)}${String(daysInMonth(d)).padStart(2, "0")}`;
const yearEnd = (d: string) => `${d.slice(0, 4)}-12-31`;
const later = (a: string, b: string) => (a > b ? a : b);
const earlier = (a: string, b: string) => (a < b ? a : b);

/**
 * How much of a cost falls in `range`, to the cent:
 *  - `once`: all of it, when its day is in the range;
 *  - `weekly`: a seventh of it for each day it runs in the range;
 *  - `monthly`: for each calendar month, its share of that month's days (a whole month is the whole
 *    amount, whatever the month's length; 10 days of a 30-day month a third);
 *  - `yearly`: the same by calendar year (a leap year has 366 days).
 * Days before it starts or after it ends count nothing.
 */
export function expenseInRange(e: ExpenseTerms, range: DateRange): number {
  if (e.cadence === "once") return e.startsOn >= range.from && e.startsOn <= range.to ? e.amount : 0;
  const from = later(range.from, e.startsOn);
  const to = e.endsOn ? earlier(range.to, e.endsOn) : range.to;
  if (from > to) return 0;
  if (e.cadence === "weekly") return Math.round((e.amount * daysBetweenInclusive(from, to) * 100) / 7) / 100;
  let share = 0;
  for (let start = from; start <= to; ) {
    const end = earlier(e.cadence === "monthly" ? monthEnd(start) : yearEnd(start), to);
    share += daysBetweenInclusive(start, end) / (e.cadence === "monthly" ? daysInMonth(start) : daysInYear(start));
    start = addDays(end, 1);
  }
  return Math.round(e.amount * share * 100) / 100;
}

/** The costs of a range added up: in all, by category (biggest first), and how many costs count. */
export interface ExpenseTotals {
  total: number;
  byCategory: Array<{ category: ExpenseCategory; amount: number }>;
  /** Costs with anything in the range. */
  counted: number;
}

export function expenseTotals(expenses: ReadonlyArray<ExpenseTerms & { category: ExpenseCategory }>, range: DateRange): ExpenseTotals {
  const cents = new Map<ExpenseCategory, number>();
  let counted = 0;
  for (const e of expenses) {
    const c = Math.round(expenseInRange(e, range) * 100);
    if (c === 0) continue;
    counted += 1;
    cents.set(e.category, (cents.get(e.category) ?? 0) + c);
  }
  const byCategory = [...cents].map(([category, c]) => ({ category, amount: c / 100 })).sort((a, b) => b.amount - a.amount || EXPENSE_CATEGORIES.indexOf(a.category) - EXPENSE_CATEGORIES.indexOf(b.category));
  return { total: [...cents.values()].reduce((a, c) => a + c, 0) / 100, byCategory, counted };
}

/**
 * Whether the owner's list holds every cost for all of `range`: they said so from `completeFrom`
 * on, and the range starts on that day or after it.
 */
export const expensesComplete = (completeFrom: string | null, range: DateRange) => completeFrom !== null && range.from >= completeFrom;

/** Why net profit can't be given for the dates, each in a word the dashboard explains. */
export type ProfitGap =
  /** Shopify's cost of goods sold isn't known (its profit report needs access to Shopify's reports). */
  | "product_costs"
  /** Shopify's profit report answered, but no sale in the dates had a cost recorded: its 0 isn't the cost. */
  | "no_cost_recorded"
  /** Some sales have no cost recorded in Shopify, so the cost of goods is short of the truth. */
  | "uncosted_sales"
  /** A connected ad account's spend isn't known for every day, or isn't in the store's currency. */
  | "ad_spend"
  /** The member isn't shown the ad spend, which net profit would give away. */
  | "ads_hidden"
  /** The owner hasn't said the costs list is complete, or not from as early as these dates. */
  | "costs_not_complete";

export interface NetProfitInputs {
  /** What the store kept from its sales: total sales less taxes and duties (net sales + shipping + additional fees). */
  revenue: number;
  /**
   * Shopify's cost of goods sold for the dates; null when not known, "not_recorded" when its profit
   * report answered but no sale had a cost recorded (it counts those at no cost, so its 0 isn't one).
   */
  productCosts: number | null | "not_recorded";
  /** Sales with no cost recorded in Shopify (their cost isn't in productCosts); null when not known. */
  uncosted: number | null;
  /**
   * The connected ad accounts' spend for the dates, in the store's currency: 0 with no account
   * connected (other ad costs are then the owner's costs), null when not known, "hidden" when the
   * member may not see it.
   */
  adSpend: number | null | "hidden";
  /** The owner's costs for the dates (expenseTotals). */
  yourCosts: number;
  /** Whether that list is complete for the dates (expensesComplete). */
  complete: boolean;
}

/**
 * Net profit for the dates: revenue − cost of goods sold − ad spend − the owner's costs, or null
 * with every reason it can't be given. Never a partial figure passed off as net profit.
 */
export function netProfit(i: NetProfitInputs): { value: number | null; gaps: ProfitGap[] } {
  const gaps: ProfitGap[] = [];
  if (i.productCosts === null) gaps.push("product_costs");
  else if (i.productCosts === "not_recorded") gaps.push("no_cost_recorded");
  else if (i.uncosted !== null && i.uncosted > 0) gaps.push("uncosted_sales");
  if (i.adSpend === "hidden") gaps.push("ads_hidden");
  else if (i.adSpend === null) gaps.push("ad_spend");
  if (!i.complete) gaps.push("costs_not_complete");
  if (gaps.length) return { value: null, gaps };
  const cents = Math.round(i.revenue * 100) - Math.round((i.productCosts as number) * 100) - Math.round((i.adSpend as number) * 100) - Math.round(i.yourCosts * 100);
  return { value: cents / 100, gaps };
}

/** Each gap in a sentence, for under the profit card. */
export const PROFIT_GAP_WORDS: Record<ProfitGap, string> = {
  product_costs: "Product costs come from Shopify's profit report, which isn't available for this store yet.",
  no_cost_recorded: "No sale in these dates has a cost recorded in Shopify (each product's cost per item).",
  uncosted_sales: "Some sales have no cost recorded in Shopify, so the cost of goods sold is short.",
  ad_spend: "A connected ad account's spend isn't known for every day of these dates, or isn't in the store's currency.",
  ads_hidden: "Net profit includes the ad spend, which you aren't shown.",
  costs_not_complete: "Your costs list isn't marked complete for these dates (Settings → Costs).",
};

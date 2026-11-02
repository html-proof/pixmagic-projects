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

/**
 * What a cost is for, in the order Settings → Costs offers them: the fixed costs first, then the
 * variable ones, then those below operating profit (EXPENSE_CATEGORY_GROUP).
 */
export const EXPENSE_CATEGORIES = [
  "rent",
  "staff",
  "software",
  "shopify_plan",
  "shopify_apps",
  "internet_phone",
  "insurance",
  "maintenance",
  "other",
  "shipping",
  "packaging",
  "payment_fees",
  "commissions",
  "marketing",
  "other_variable",
  "interest",
  "income_tax",
  "depreciation",
  "other_non_operating",
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export const EXPENSE_CATEGORY_LABEL: Record<ExpenseCategory, string> = {
  rent: "Rent and utilities",
  staff: "Salaries and staff",
  software: "Software subscriptions",
  shopify_plan: "Shopify plan",
  shopify_apps: "Shopify apps",
  internet_phone: "Internet and phone",
  insurance: "Insurance",
  maintenance: "Maintenance contracts",
  other: "Other fixed costs",
  shipping: "Shipping and delivery",
  packaging: "Packaging",
  payment_fees: "Payment and transaction fees",
  commissions: "Sales commissions",
  marketing: "Other marketing",
  other_variable: "Other variable costs",
  interest: "Loan interest",
  income_tax: "Income tax",
  depreciation: "Depreciation",
  other_non_operating: "Other costs below operating profit",
};

/**
 * How a cost counts in the profit figures (docs/kpis.md "Profit and loss"):
 *  - `fixed`: what the store pays whatever it sells (rent, salaries, software, insurance...), kept as
 *    a monthly (or weekly, yearly) cost and spread over the days it covers, never taken off whole
 *    from one day's sales;
 *  - `variable`: what goes up and down with the selling (shipping, packaging, payment fees,
 *    commissions, marketing), beside the product costs and the ad spend;
 *  - `non_operating`: what comes off operating profit to give net profit (loan interest, income tax,
 *    depreciation).
 * Every one of them is the owner's own figure; together they are "your costs".
 */
export const EXPENSE_GROUPS = ["fixed", "variable", "non_operating"] as const;
export type ExpenseGroup = (typeof EXPENSE_GROUPS)[number];

export const EXPENSE_GROUP_LABEL: Record<ExpenseGroup, string> = { fixed: "Fixed costs", variable: "Variable costs", non_operating: "Below operating profit" };

export const EXPENSE_CATEGORY_GROUP: Record<ExpenseCategory, ExpenseGroup> = {
  rent: "fixed",
  staff: "fixed",
  software: "fixed",
  shopify_plan: "fixed",
  shopify_apps: "fixed",
  internet_phone: "fixed",
  insurance: "fixed",
  maintenance: "fixed",
  other: "fixed",
  shipping: "variable",
  packaging: "variable",
  payment_fees: "variable",
  commissions: "variable",
  marketing: "variable",
  other_variable: "variable",
  interest: "non_operating",
  income_tax: "non_operating",
  depreciation: "non_operating",
  other_non_operating: "non_operating",
};

/** The categories of one group, in EXPENSE_CATEGORIES' order. */
export const categoriesOf = (g: ExpenseGroup): ExpenseCategory[] => EXPENSE_CATEGORIES.filter((c) => EXPENSE_CATEGORY_GROUP[c] === g);

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

/**
 * The days a store is open, Monday = 0 … Sunday = 6, as the costs are spread over them
 * (`expenseInRange`); empty: every calendar day.
 */
export const operatingWeekdays = z
  .array(z.number().int().min(0).max(6))
  .max(7)
  .refine((d) => new Set(d).size === d.length, "Give each weekday once")
  // All seven are every day: kept as such, so one choice is never stored two ways.
  .transform((d) => (d.length === 7 ? [] : [...d].sort((a, b) => a - b)));

/**
 * What PUT .../expenses/settings takes, either or both: from which day the list holds every cost
 * (null: not said), and the days the store is open (`operatingWeekdays`). What isn't sent stays.
 */
export const expenseSettingsInput = z
  .object({ completeFrom: day.nullable().optional(), operatingWeekdays: operatingWeekdays.optional() })
  .strict()
  .refine((x) => x.completeFrom !== undefined || x.operatingWeekdays !== undefined, "Nothing to save");
export type ExpenseSettingsInput = z.infer<typeof expenseSettingsInput>;

/** One cost as the API returns it. */
export interface Expense extends ExpenseInput {
  id: string;
  createdAt: string;
  updatedAt: string;
}

/** The part of a cost this module works with. */
export type ExpenseTerms = Pick<ExpenseInput, "amount" | "cadence" | "startsOn" | "endsOn">;

/** The days of `d`'s calendar month: 28, 29, 30 or 31. */
export const daysInMonth = (d: string) => new Date(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)), 0)).getUTCDate();
const monthStart = (d: string) => `${d.slice(0, 8)}01`;
const monthEnd = (d: string) => `${d.slice(0, 8)}${String(daysInMonth(d)).padStart(2, "0")}`;
const yearStart = (d: string) => `${d.slice(0, 4)}-01-01`;
const yearEnd = (d: string) => `${d.slice(0, 4)}-12-31`;
const later = (a: string, b: string) => (a > b ? a : b);
const earlier = (a: string, b: string) => (a < b ? a : b);
/** Monday = 0 … Sunday = 6, as the Profit sheet counts weekdays. */
const weekday = (d: string) => (new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7;
const everyDay = (open: readonly number[]) => open.length === 0 || open.length >= 7;

/** How many days from `from` to `to` (both in) the store is open on: every one of them when `open` is empty. */
export function operatingDaysBetween(from: string, to: string, open: readonly number[] = []): number {
  if (from > to) return 0;
  const n = daysBetweenInclusive(from, to);
  if (everyDay(open)) return n;
  const set = new Set(open);
  const weeks = Math.floor(n / 7);
  let count = weeks * set.size;
  // The days after the whole weeks start on the same weekday as `from`.
  const first = weekday(from);
  for (let i = 0; i < n % 7; i++) if (set.has((first + i) % 7)) count += 1;
  return count;
}

/**
 * How much of a cost falls in `range`, to the cent:
 *  - `once`: all of it, when its day is in the range;
 *  - `weekly`: a seventh of it for each day it runs in the range;
 *  - `monthly`: for each calendar month, its share of that month's days (a whole month is the whole
 *    amount, whatever the month's length: 28, 29, 30 or 31 days; 10 days of a 30-day month a third);
 *  - `yearly`: the same by calendar year (a leap year has 366 days).
 * Days before it starts or after it ends count nothing.
 *
 * `open`: the weekdays the store is open (`operatingWeekdays`). A recurring cost is then spread over
 * the days it is open only: a month's cost over that month's open days, a week's over the open days
 * of a week, a year's over the year's; a closed day carries none of it. A whole month is still the
 * whole amount. Empty: every calendar day.
 */
export function expenseInRange(e: ExpenseTerms, range: DateRange, open: readonly number[] = []): number {
  if (e.cadence === "once") return e.startsOn >= range.from && e.startsOn <= range.to ? e.amount : 0;
  const from = later(range.from, e.startsOn);
  const to = e.endsOn ? earlier(range.to, e.endsOn) : range.to;
  if (from > to) return 0;
  const all = everyDay(open);
  if (e.cadence === "weekly") return Math.round((e.amount * operatingDaysBetween(from, to, open) * 100) / (all ? 7 : new Set(open).size)) / 100;
  let share = 0;
  for (let start = from; start <= to; ) {
    const monthly = e.cadence === "monthly";
    const end = earlier(monthly ? monthEnd(start) : yearEnd(start), to);
    const period = monthly ? [monthStart(start), monthEnd(start)] : [yearStart(start), yearEnd(start)];
    share += operatingDaysBetween(start, end, open) / operatingDaysBetween(period[0]!, period[1]!, open);
    start = addDays(end, 1);
  }
  return Math.round(e.amount * share * 100) / 100;
}

/** The costs of a range added up: in all, by category (biggest first), by group, and how many costs count. */
export interface ExpenseTotals {
  total: number;
  byCategory: Array<{ category: ExpenseCategory; amount: number }>;
  /** Fixed, variable and below-operating-profit costs (EXPENSE_CATEGORY_GROUP), each to the cent. */
  byGroup: Record<ExpenseGroup, number>;
  /** Costs with anything in the range. */
  counted: number;
}

export function expenseTotals(expenses: ReadonlyArray<ExpenseTerms & { category: ExpenseCategory }>, range: DateRange, open: readonly number[] = []): ExpenseTotals {
  const cents = new Map<ExpenseCategory, number>();
  let counted = 0;
  for (const e of expenses) {
    const c = Math.round(expenseInRange(e, range, open) * 100);
    if (c === 0) continue;
    counted += 1;
    cents.set(e.category, (cents.get(e.category) ?? 0) + c);
  }
  return totalsOf(cents, counted);
}

/** Category cents as totals: biggest first, ties in EXPENSE_CATEGORIES' order. */
export function totalsOf(cents: ReadonlyMap<ExpenseCategory, number>, counted: number): ExpenseTotals {
  const byCategory = [...cents]
    .filter(([, c]) => c !== 0)
    .map(([category, c]) => ({ category, amount: c / 100 }))
    .sort((a, b) => b.amount - a.amount || EXPENSE_CATEGORIES.indexOf(a.category) - EXPENSE_CATEGORIES.indexOf(b.category));
  const group = { fixed: 0, variable: 0, non_operating: 0 };
  for (const [category, c] of cents) group[EXPENSE_CATEGORY_GROUP[category] ?? "fixed"] += c;
  return {
    total: [...cents.values()].reduce((a, c) => a + c, 0) / 100,
    byCategory,
    byGroup: { fixed: group.fixed / 100, variable: group.variable / 100, non_operating: group.non_operating / 100 },
    counted,
  };
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
  /** The member isn't shown Shopify's cost of goods sold ("View costs and stock value"), which net profit would give away. */
  | "product_costs_hidden"
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
   * report answered but no sale had a cost recorded (it counts those at no cost, so its 0 isn't one),
   * "hidden" when the member may not see it.
   */
  productCosts: number | null | "not_recorded" | "hidden";
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
  if (i.productCosts === "hidden") gaps.push("product_costs_hidden");
  else if (i.productCosts === null) gaps.push("product_costs");
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
  product_costs_hidden: "Net profit includes Shopify's product costs, which you aren't shown.",
  uncosted_sales: "Some sales have no cost recorded in Shopify, so the cost of goods sold is short.",
  ad_spend: "A connected ad account's spend isn't known for every day of these dates, or isn't in the store's currency.",
  ads_hidden: "Net profit includes the ad spend, which you aren't shown.",
  costs_not_complete: "Your costs list isn't marked complete for these dates (Settings → Costs).",
};

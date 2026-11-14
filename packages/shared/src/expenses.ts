/**
 * A store's own costs (Profit & Loss and Settings → Costs, docs/kpis.md "Costs and net profit"): what
 * neither Shopify, its profit report nor the ad platforms can tell bizinsights. Shopify's plan and app
 * bills, staff, rent, shipping labels, payment fees, ads on platforms that aren't connected... The
 * owner enters each one with how it is worked out and how often it is paid; bizinsights spreads it
 * over the days it covers and adds up the days of the dates on screen. Nothing here is estimated or
 * read from an outside service: every figure is the merchant's own, and the page says so.
 *
 * A cost is worked out one of four ways (`EXPENSE_METHODS`): a fixed amount, paid once or every day,
 * week, fortnight, month, quarter, six months or year (each payment covers the days up to the next
 * one, `occurrences`); a percentage of each day's sales; or an amount per order or per item sold.
 * A recurring payment the owner changed one by one (or skipped) is kept as it was paid (`entries`),
 * so changing the cost later never rewrites a month already reported.
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
 * What a cost is for, in the order the cost form offers them: the fixed costs first, then the
 * variable ones, the advertising ones, then those below operating profit (EXPENSE_CATEGORY_SECTION).
 * The workbook the owner kept before bizinsights (docs/kpis.md "Profit and loss") has a row for each.
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
  "operating",
  "fixed_ads",
  "other",
  "shipping",
  "pick_pack",
  "packaging",
  "payment_fees",
  "merchant_fees",
  "commissions",
  "product_cost_adjustment",
  "other_variable",
  "marketing",
  "ad_spend_adjustment",
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
  operating: "Operating expenses",
  fixed_ads: "Fixed advertising costs",
  other: "Other fixed costs",
  shipping: "Shipping and delivery",
  pick_pack: "Pick, pack and 3PL",
  packaging: "Packaging",
  payment_fees: "Payment and transaction fees",
  merchant_fees: "Merchant fees",
  commissions: "Sales commissions",
  product_cost_adjustment: "Product cost adjustment",
  other_variable: "Other variable costs",
  marketing: "Other paid channels",
  ad_spend_adjustment: "Ad spend adjustment",
  interest: "Loan interest",
  income_tax: "Income tax",
  depreciation: "Depreciation",
  other_non_operating: "Other costs below operating profit",
};

/**
 * Where a cost sits in the profit and loss (docs/kpis.md "Profit and loss"):
 *  - `advertising`: ads paid outside the connected ad accounts (other paid channels) and corrections
 *    to the synced spend, counted with the ad spend;
 *  - `variable`: what goes up and down with the selling (shipping, pick and pack, packaging, payment
 *    and merchant fees, commissions), beside the product costs;
 *  - `fixed`: what the store pays whatever it sells (rent, salaries, software, insurance...), kept as
 *    a monthly (or weekly, yearly...) cost and spread over the days it covers, never taken off whole
 *    from one day's sales;
 *  - `non_operating`: what comes off operating profit to give net profit (loan interest, income tax,
 *    depreciation).
 */
export const EXPENSE_SECTIONS = ["advertising", "variable", "fixed", "non_operating"] as const;
export type ExpenseSection = (typeof EXPENSE_SECTIONS)[number];

export const EXPENSE_SECTION_LABEL: Record<ExpenseSection, string> = { advertising: "Advertising", variable: "Variable costs", fixed: "Fixed costs", non_operating: "Below operating profit" };

export const EXPENSE_CATEGORY_SECTION: Record<ExpenseCategory, ExpenseSection> = {
  rent: "fixed",
  staff: "fixed",
  software: "fixed",
  shopify_plan: "fixed",
  shopify_apps: "fixed",
  internet_phone: "fixed",
  insurance: "fixed",
  maintenance: "fixed",
  operating: "fixed",
  fixed_ads: "fixed",
  other: "fixed",
  shipping: "variable",
  pick_pack: "variable",
  packaging: "variable",
  payment_fees: "variable",
  merchant_fees: "variable",
  commissions: "variable",
  product_cost_adjustment: "variable",
  other_variable: "variable",
  marketing: "advertising",
  ad_spend_adjustment: "advertising",
  interest: "non_operating",
  income_tax: "non_operating",
  depreciation: "non_operating",
  other_non_operating: "non_operating",
};

/**
 * How a cost counts in operating and net profit: advertising is a variable cost (it goes with the
 * selling), the other sections are their own group.
 */
export const EXPENSE_GROUPS = ["fixed", "variable", "non_operating"] as const;
export type ExpenseGroup = (typeof EXPENSE_GROUPS)[number];

export const EXPENSE_GROUP_LABEL: Record<ExpenseGroup, string> = { fixed: "Fixed costs", variable: "Variable costs", non_operating: "Below operating profit" };

export const groupOfSection = (s: ExpenseSection): ExpenseGroup => (s === "advertising" ? "variable" : s);

export const EXPENSE_CATEGORY_GROUP = Object.fromEntries(EXPENSE_CATEGORIES.map((c) => [c, groupOfSection(EXPENSE_CATEGORY_SECTION[c])])) as Record<ExpenseCategory, ExpenseGroup>;

/** The categories of one group, in EXPENSE_CATEGORIES' order. */
export const categoriesOf = (g: ExpenseGroup): ExpenseCategory[] => EXPENSE_CATEGORIES.filter((c) => EXPENSE_CATEGORY_GROUP[c] === g);
/** The categories of one section, in EXPENSE_CATEGORIES' order. */
export const categoriesIn = (s: ExpenseSection): ExpenseCategory[] => EXPENSE_CATEGORIES.filter((c) => EXPENSE_CATEGORY_SECTION[c] === s);

export const isExpenseCategory = (s: string): s is ExpenseCategory => (EXPENSE_CATEGORIES as readonly string[]).includes(s);

/**
 * A category the owner made for their store (rent split out by site, warehouse, a Shopify app they
 * want on a line of its own...), with the section its costs go in. A cost names it `custom:<id>`.
 */
export interface CustomCategory {
  id: string;
  name: string;
  section: ExpenseSection;
}

/** The most categories one store makes: enough for any chart of accounts, few enough for one menu. */
export const MAX_CUSTOM_CATEGORIES = 50;

const CUSTOM_KEY = /^custom:[a-z0-9]{8,40}$/;
export const customCategoryKey = (id: string) => `custom:${id}`;
export const isCustomCategoryKey = (s: string) => CUSTOM_KEY.test(s);
/** The id in `custom:<id>`; null for a built-in category. */
export const customCategoryId = (key: string) => (isCustomCategoryKey(key) ? key.slice(7) : null);

/** The section a category's costs go in; a custom category's own, or null when the store has no such category. */
export function categorySection(key: string, customs: readonly CustomCategory[] = []): ExpenseSection | null {
  if (isExpenseCategory(key)) return EXPENSE_CATEGORY_SECTION[key];
  const id = customCategoryId(key);
  return customs.find((c) => c.id === id)?.section ?? null;
}

/** A category's name as the pages show it. */
export function categoryLabel(key: string, customs: readonly CustomCategory[] = []): string {
  if (isExpenseCategory(key)) return EXPENSE_CATEGORY_LABEL[key];
  const id = customCategoryId(key);
  return customs.find((c) => c.id === id)?.name ?? "Category removed";
}

/** What POST and PUT …/expense-categories take: a name and the section its costs go in. */
export const customCategoryInput = z
  .object({
    name: z.string().trim().min(1, "Give the category a name").max(60),
    section: z.enum(EXPENSE_SECTIONS),
  })
  .strict();
export type CustomCategoryInput = z.infer<typeof customCategoryInput>;

/** How often a cost is paid: `once` on its day, the others every day, week... year from it. */
export const EXPENSE_CADENCES = ["once", "daily", "weekly", "fortnightly", "monthly", "quarterly", "half_yearly", "yearly"] as const;
export type ExpenseCadence = (typeof EXPENSE_CADENCES)[number];
export type RecurringCadence = Exclude<ExpenseCadence, "once">;

export const EXPENSE_CADENCE_LABEL: Record<ExpenseCadence, string> = {
  once: "Once",
  daily: "Every day",
  weekly: "Every week",
  fortnightly: "Every fortnight",
  monthly: "Every month",
  quarterly: "Every quarter",
  half_yearly: "Every six months",
  yearly: "Every year",
};

/** The days or months from one payment to the next: a month keeps the first payment's day of the month. */
const CADENCE_STEP: Record<RecurringCadence, { days: number } | { months: number }> = {
  daily: { days: 1 },
  weekly: { days: 7 },
  fortnightly: { days: 14 },
  monthly: { months: 1 },
  quarterly: { months: 3 },
  half_yearly: { months: 6 },
  yearly: { months: 12 },
};

/**
 * How a cost's amount is worked out:
 *  - `amount`: a sum of money, paid once or every period (`cadence`);
 *  - `percent`: a share of each day's sales (`PERCENT_BASES`), as a payment provider's fee is;
 *  - `per_order`, `per_item`: an amount for each order, or each item sold, that day (a shipping
 *    label, a box).
 * The last three follow the store's sales day by day, from `startsOn` to `endsOn`: they have no cadence.
 */
export const EXPENSE_METHODS = ["amount", "percent", "per_order", "per_item"] as const;
export type ExpenseMethod = (typeof EXPENSE_METHODS)[number];

export const EXPENSE_METHOD_LABEL: Record<ExpenseMethod, string> = { amount: "Fixed amount", percent: "Percentage of sales", per_order: "Amount per order", per_item: "Amount per item sold" };

/**
 * What a percentage is taken of, each day: total sales (what customers paid, tax included: Shopify's
 * "Total sales"), revenue (net sales + shipping and fees charged, before tax) or net sales.
 */
export const PERCENT_BASES = ["total_sales", "revenue", "net_sales"] as const;
export type PercentBase = (typeof PERCENT_BASES)[number];

export const PERCENT_BASE_LABEL: Record<PercentBase, string> = { total_sales: "Total sales (tax included)", revenue: "Revenue (before tax)", net_sales: "Net sales" };

/** The most costs one store keeps: enough for any shop's bills, few enough to add up on every dashboard answer. */
export const MAX_EXPENSES = 200;
/** The largest single amount taken (in the store's currency). */
export const MAX_EXPENSE_AMOUNT = 100_000_000;

const day = z.string().refine((s) => isDay(s), "Pick a real date (YYYY-MM-DD)");
const cents = (n: number) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6;
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .default(null)
    .transform((s) => (s ? s : null));

/**
 * What POST .../expenses and PUT .../expenses/:id take: one cost, whole. The fields added with the
 * Profit & Loss page (description, method, percentBase, currency, vendor, paymentMethod) may be left
 * out, as the cost form before it sent none of them.
 */
export const expenseInput = z
  .object({
    name: z.string().trim().min(1, "Give the cost a name").max(80),
    description: optionalText(500),
    /** A built-in category (EXPENSE_CATEGORIES) or one of the store's own (`custom:<id>`). */
    category: z.string().refine((c) => isExpenseCategory(c) || isCustomCategoryKey(c), "Pick a category"),
    method: z.enum(EXPENSE_METHODS).default("amount"),
    /**
     * In the store's currency, cents at most; for `percent`, the percentage (2.5 is 2.5%). Below 0
     * only for an amount paid once: a refund, a credit, a correction.
     */
    amount: z
      .number()
      .min(-MAX_EXPENSE_AMOUNT)
      .max(MAX_EXPENSE_AMOUNT)
      .refine(cents, "Amounts go to the cent at most"),
    /** What a percentage is of; null for every other method. */
    percentBase: z.enum(PERCENT_BASES).nullable().default(null),
    /** The currency it was entered in: the store's (null: the store's, as before the field). */
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/, "A currency code, like AUD")
      .nullable()
      .default(null),
    /** How often an amount is paid. A percentage or an amount per order or item follows each day's sales: it is kept as `daily`. */
    cadence: z.enum(EXPENSE_CADENCES),
    /** The store-local day it starts (for `once`, the day it was paid). */
    startsOn: day,
    /** The last day it applies to; null while it goes on. A cost paid once has none. */
    endsOn: day.nullable(),
    vendor: optionalText(80),
    paymentMethod: optionalText(40),
    note: optionalText(500),
  })
  .strict()
  .transform((x) => (x.method === "amount" ? x : { ...x, cadence: "daily" as const }))
  .refine((x) => x.endsOn === null || x.endsOn >= x.startsOn, { message: "It can't end before it starts", path: ["endsOn"] })
  .refine((x) => x.cadence !== "once" || x.endsOn === null, { message: "A cost paid once has no end date", path: ["endsOn"] })
  .refine((x) => x.amount >= 0 || (x.method === "amount" && x.cadence === "once"), { message: "Only an amount paid once can be below 0 (a refund or a credit)", path: ["amount"] })
  .refine((x) => x.method !== "percent" || (x.amount > 0 && x.amount <= 100), { message: "A percentage is above 0 and at most 100", path: ["amount"] })
  .refine((x) => (x.method === "percent") === (x.percentBase !== null), { message: "Say what the percentage is of", path: ["percentBase"] });

export type ExpenseInput = z.infer<typeof expenseInput>;
/** What a client sends: the fields added later may be left out. */
export type ExpenseInputSent = z.input<typeof expenseInput>;

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
  /** From which day its payments stopped while it is paused (null: not paused). Recurring amounts only. */
  pausedFrom: string | null;
  /** The cost this one took over from when its terms changed from a payment on (null: none). */
  replacesId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A payment of a recurring cost as it was recorded: changed one by one, or skipped (amount 0). */
export interface ExpensePayment {
  due: string;
  amount: number;
}

/** The part of a cost this module works with. */
export interface ExpenseTerms {
  amount: number;
  cadence: ExpenseCadence;
  startsOn: string;
  endsOn: string | null;
  /** Absent: `amount` (costs saved before the other methods). */
  method?: ExpenseMethod;
  percentBase?: PercentBase | null;
  /** While paused, no payment falls due from this day on. */
  pausedFrom?: string | null;
  /** Payments recorded with another amount than the cost's (or skipped): each replaces the one due that day. */
  payments?: readonly ExpensePayment[];
}

/** A day's sales as the costs that follow them read them (`percent`, `per_order`, `per_item`). */
export interface DayFigures {
  /** What customers paid, tax and duties included. */
  totalSales: number;
  /** Net sales + shipping and fees charged, before tax. */
  revenue: number;
  netSales: number;
  orders: number;
  units: number;
}

/** The days of `d`'s calendar month: 28, 29, 30 or 31. */
export const daysInMonth = (d: string) => new Date(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)), 0)).getUTCDate();
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

/** `months` calendar months after `start`, on its day of the month or the month's last day (31 Jan → 28 Feb). */
function addMonthsKeepingDay(start: string, months: number): string {
  const y = Number(start.slice(0, 4));
  const m = Number(start.slice(5, 7)) - 1 + months;
  const year = y + Math.floor(m / 12);
  const month = ((m % 12) + 12) % 12;
  const first = `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}-01`;
  const dayOfMonth = Math.min(Number(start.slice(8, 10)), daysInMonth(first));
  return `${first.slice(0, 8)}${String(dayOfMonth).padStart(2, "0")}`;
}

/** The day the k-th payment (0: the first) of a recurring cost falls due. */
export function dueDate(startsOn: string, cadence: RecurringCadence, k: number): string {
  const step = CADENCE_STEP[cadence];
  return "days" in step ? addDays(startsOn, step.days * k) : addMonthsKeepingDay(startsOn, step.months * k);
}

/** A payment of a cost: the day it falls due and the days it pays for, up to the next one. */
export interface Occurrence {
  due: string;
  /** The days it counts on: from its due day to the day before the next payment, or the cost's end when that comes first. */
  from: string;
  to: string;
  /** The day before the next payment: the payment pays for every day from `due` to it. */
  periodTo: string;
  /** The payment's amount: the cost's, or a recorded one's (`payments`). */
  amount: number;
  /** True when it is a recorded payment's amount. */
  recorded: boolean;
}

/** The first payment that may cover `from`: a few before it, worked out without walking from the start. */
function firstIndexNear(startsOn: string, cadence: RecurringCadence, from: string): number {
  if (from <= startsOn) return 0;
  const step = CADENCE_STEP[cadence];
  if ("days" in step) return Math.max(0, Math.floor((daysBetweenInclusive(startsOn, from) - 1) / step.days) - 1);
  const months = (Number(from.slice(0, 4)) - Number(startsOn.slice(0, 4))) * 12 + Number(from.slice(5, 7)) - Number(startsOn.slice(5, 7));
  return Math.max(0, Math.floor(months / step.months) - 1);
}

/**
 * The payments of an amount (`method` amount) whose days overlap [from, to], in order: a cost paid
 * once has one, on its day; a recurring one a payment every period from `startsOn` (a month keeps its
 * day of the month), each covering the days to the next one. None falls due after `endsOn`, nor from
 * `pausedFrom` on while it is paused; when the cost ends before the next payment, the last one counts
 * on the days to its end only (16–20 Oct of a weekly cost due on 16 Oct: 5 of that payment's 7 days).
 * A recorded payment (`payments`) keeps its own amount.
 */
export function occurrences(e: ExpenseTerms, from: string, to: string): Occurrence[] {
  if ((e.method ?? "amount") !== "amount" || from > to) return [];
  const recorded = new Map((e.payments ?? []).map((p) => [p.due, p.amount]));
  const paid = (due: string, amount: number) => (recorded.has(due) ? { amount: recorded.get(due)!, recorded: true } : { amount, recorded: false });
  if (e.cadence === "once") return e.startsOn >= from && e.startsOn <= to ? [{ due: e.startsOn, from: e.startsOn, to: e.startsOn, periodTo: e.startsOn, ...paid(e.startsOn, e.amount) }] : [];
  const cadence = e.cadence;
  const out: Occurrence[] = [];
  for (let k = firstIndexNear(e.startsOn, cadence, from); ; k++) {
    const due = dueDate(e.startsOn, cadence, k);
    if (due > to || (e.endsOn && due > e.endsOn) || (e.pausedFrom && due >= e.pausedFrom)) break;
    const last = addDays(dueDate(e.startsOn, cadence, k + 1), -1);
    if (last < from) continue;
    out.push({ due, from: due, to: e.endsOn && e.endsOn < last ? e.endsOn : last, periodTo: last, ...paid(due, e.amount) });
  }
  return out;
}

/** The payments of a recurring amount that have fallen due by `today` (the ones bizinsights records), from its first. */
export function dueOccurrences(e: ExpenseTerms, today: string): Occurrence[] {
  if ((e.method ?? "amount") !== "amount" || e.cadence === "once" || e.startsOn > today) return [];
  return occurrences(e, e.startsOn, today).filter((o) => o.due <= today);
}

/** The next payment after `today` (null: none to come: it is paid once, has ended, or is paused). */
export function nextDue(e: ExpenseTerms, today: string): string | null {
  if ((e.method ?? "amount") !== "amount") return null;
  if (e.cadence === "once") return e.startsOn > today ? e.startsOn : null;
  if (e.pausedFrom) return null;
  const cadence = e.cadence;
  for (let k = firstIndexNear(e.startsOn, cadence, today); k < 100_000; k++) {
    const due = dueDate(e.startsOn, cadence, k);
    if (e.endsOn && due > e.endsOn) return null;
    if (due > today) return due;
  }
  return null;
}

/**
 * The share of `o` that falls in [from, to]: its amount spread over the days it pays for that the
 * store is open (every day when it is open on none of them), counting only its days up to the cost's end.
 */
function occurrenceShare(o: Occurrence, from: string, to: string, open: readonly number[]): number {
  const a = later(o.from, from);
  const b = earlier(o.to, to);
  if (a > b) return 0;
  if (o.from === o.periodTo) return o.amount;
  const openDays = operatingDaysBetween(o.from, o.periodTo, open);
  const days = openDays > 0 ? openDays : daysBetweenInclusive(o.from, o.periodTo);
  const inside = openDays > 0 ? operatingDaysBetween(a, b, open) : daysBetweenInclusive(a, b);
  return (o.amount * inside) / days;
}

/** A day's amount of a cost that follows the sales: never below 0 on a day refunds outweigh sales. */
function rateOn(e: ExpenseTerms, f: DayFigures): number {
  switch (e.method) {
    case "percent":
      return (Math.max(0, f[e.percentBase === "total_sales" ? "totalSales" : e.percentBase === "net_sales" ? "netSales" : "revenue"]) * e.amount) / 100;
    case "per_order":
      return Math.max(0, f.orders) * e.amount;
    case "per_item":
      return Math.max(0, f.units) * e.amount;
    default:
      return 0;
  }
}

/** The calendar months a payment of these cadences is spread over: a month, a quarter, a half year or a year (all from January). */
const CALENDAR_MONTHS: Partial<Record<ExpenseCadence, number>> = { monthly: 1, quarterly: 3, half_yearly: 6, yearly: 12 };

/** The calendar period of `months` months (aligned to January) that `d` is in. */
function calendarBlock(d: string, months: number): { from: string; to: string } {
  const y = d.slice(0, 4);
  const first = Math.floor((Number(d.slice(5, 7)) - 1) / months) * months + 1;
  const from = `${y}-${String(first).padStart(2, "0")}-01`;
  const lastMonth = `${y}-${String(first + months - 1).padStart(2, "0")}-01`;
  return { from, to: `${lastMonth.slice(0, 8)}${String(daysInMonth(lastMonth)).padStart(2, "0")}` };
}

/**
 * How much of a cost falls in `range`, to the cent:
 *  - an amount paid once: all of it, on its day;
 *  - paid every month, quarter, six months or year: for each calendar month (quarter, half year,
 *    year) its share of that period's days, so a whole month is the whole amount, whatever the
 *    month's length (28, 29, 30 or 31 days; 10 days of a 30-day month a third). Each period counts
 *    the payment that falls due in it: a recorded one's own amount (`payments`), none while paused;
 *  - paid every day, week or fortnight: each payment over the days it covers (`occurrences`), a
 *    seventh of a weekly one a day;
 *  - a percentage, or an amount per order or item: each day's own, from the day's sales (`figures`;
 *    a day with none counts nothing).
 * Days before it starts or after it ends count nothing.
 *
 * `open`: the weekdays the store is open (`operatingWeekdays`). A recurring cost is then spread over
 * the days it is open only: a month's cost over that month's open days, a week's over the open days
 * of a week; a closed day carries none of it. A whole month is still the whole amount. Empty: every
 * calendar day.
 */
export function expenseInRange(e: ExpenseTerms, range: DateRange, open: readonly number[] = [], figures?: (day: string) => DayFigures | undefined): number {
  if ((e.method ?? "amount") === "amount") {
    const months = CALENDAR_MONTHS[e.cadence];
    if (!months) {
      const share = occurrences(e, range.from, range.to).reduce((a, o) => a + occurrenceShare(o, range.from, range.to, open), 0);
      return Math.round(share * 100) / 100;
    }
    const from = later(range.from, e.startsOn);
    const to = e.endsOn ? earlier(range.to, e.endsOn) : range.to;
    const recorded = new Map((e.payments ?? []).map((p) => [p.due, p.amount]));
    let share = 0;
    for (let start = from; start <= to; ) {
      const block = calendarBlock(start, months);
      const end = earlier(block.to, to);
      // The payment due in this period: exactly one for a cost paid every `months` months.
      const due = occurrences(e.pausedFrom ? { ...e, pausedFrom: null } : e, block.from, block.to).find((o) => o.due >= block.from && o.due <= block.to)?.due;
      const amount = due && e.pausedFrom && due >= e.pausedFrom ? 0 : due && recorded.has(due) ? recorded.get(due)! : e.amount;
      const days = operatingDaysBetween(block.from, block.to, open);
      share += days > 0 ? (amount * operatingDaysBetween(start, end, open)) / days : 0;
      start = addDays(end, 1);
    }
    return Math.round(share * 100) / 100;
  }
  if (!figures) return 0;
  const from = later(range.from, e.startsOn);
  let to = e.endsOn ? earlier(range.to, e.endsOn) : range.to;
  if (e.pausedFrom) to = earlier(to, addDays(e.pausedFrom, -1));
  let total = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const f = figures(d);
    if (f) total += Math.round(rateOn(e, f) * 100);
  }
  return total / 100;
}

/** A cost as the totals read it: its terms, category, and the section that category goes in (absent: the built-in category's). */
export type CostOfCategory = ExpenseTerms & { category: string; section?: ExpenseSection };

/** The section a cost counts in: its own when given, else its built-in category's; a category no longer there is a fixed cost. */
export const sectionOfCost = (e: { category: string; section?: ExpenseSection }): ExpenseSection => e.section ?? (isExpenseCategory(e.category) ? EXPENSE_CATEGORY_SECTION[e.category] : "fixed");

/** The costs of a range added up: in all, by category (biggest first), by section and group, and how many costs count. */
export interface ExpenseTotals {
  total: number;
  /** A category is a built-in one (EXPENSE_CATEGORIES) or the store's own (`custom:<id>`). */
  byCategory: Array<{ category: string; section: ExpenseSection; amount: number }>;
  /** Fixed, variable and below-operating-profit costs (advertising among the variable ones), each to the cent. */
  byGroup: Record<ExpenseGroup, number>;
  /** Advertising, variable, fixed and below-operating-profit costs, each to the cent. */
  bySection: Record<ExpenseSection, number>;
  /** Costs with anything in the range. */
  counted: number;
}

export function expenseTotals(expenses: readonly CostOfCategory[], range: DateRange, open: readonly number[] = [], figures?: (day: string) => DayFigures | undefined): ExpenseTotals {
  const byCategory = new Map<string, { section: ExpenseSection; cents: number }>();
  let counted = 0;
  for (const e of expenses) {
    const c = Math.round(expenseInRange(e, range, open, figures) * 100);
    if (c === 0) continue;
    counted += 1;
    addCents(byCategory, e, c);
  }
  return totalsOf(byCategory, counted);
}

/** Adds `c` cents of `e` to its category's. */
export function addCents(to: Map<string, { section: ExpenseSection; cents: number }>, e: { category: string; section?: ExpenseSection }, c: number) {
  const was = to.get(e.category);
  to.set(e.category, { section: was?.section ?? sectionOfCost(e), cents: (was?.cents ?? 0) + c });
}

const categoryOrder = (c: string) => {
  const i = (EXPENSE_CATEGORIES as readonly string[]).indexOf(c);
  return i < 0 ? EXPENSE_CATEGORIES.length : i;
};

/** Category cents as totals: biggest first, ties in EXPENSE_CATEGORIES' order (the store's own after them). */
export function totalsOf(cents: ReadonlyMap<string, { section: ExpenseSection; cents: number }>, counted: number): ExpenseTotals {
  const byCategory = [...cents]
    .filter(([, c]) => c.cents !== 0)
    .map(([category, c]) => ({ category, section: c.section, amount: c.cents / 100 }))
    .sort((a, b) => b.amount - a.amount || categoryOrder(a.category) - categoryOrder(b.category) || (a.category < b.category ? -1 : 1));
  const section: Record<ExpenseSection, number> = { advertising: 0, variable: 0, fixed: 0, non_operating: 0 };
  let total = 0;
  for (const c of cents.values()) {
    section[c.section] += c.cents;
    total += c.cents;
  }
  return {
    total: total / 100,
    byCategory,
    byGroup: { fixed: section.fixed / 100, variable: (section.variable + section.advertising) / 100, non_operating: section.non_operating / 100 },
    bySection: { advertising: section.advertising / 100, variable: section.variable / 100, fixed: section.fixed / 100, non_operating: section.non_operating / 100 },
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
  | "ads_hidden";

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
  /** The owner's costs for the dates (expenseTotals): every cost in their list, marked complete or not. */
  yourCosts: number;
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
};

/**
 * The Profit sheet (/sheet; docs/kpis.md "Profit sheet"): every figure bizinsights has for a store,
 * one column per day, week or month, the way an owner would otherwise keep it in a spreadsheet:
 * sales, orders, visits, ad spend, and the ratios between them. The days shown can be narrowed to
 * some weekdays, or to the days of the team's business events (./businessEvents), and the event
 * days can be set against the others.
 *
 * Pure maths over the dashboard's own day-by-day figures (GET …/overview?parts=sheet), so every
 * figure here is one the dashboard already shows, added up over other days. Nothing is estimated:
 *  - a figure the member doesn't see (Team & Access) or the store doesn't have is `undefined`, and
 *    its row is left out;
 *  - a figure that isn't known for one of a period's days (visits before the pixel counted them, a
 *    day an ad account has no figures for) is `null` for the period, shown blank, never as a part.
 * Money is added up in whole cents, so a total doesn't depend on the order of a floating-point sum.
 *
 * With the store's costs (`ProfitSetup`), each column also gets its profit and loss (./profit): the
 * product costs, the owner's variable and fixed costs (a monthly cost spread over its month's days,
 * never taken whole off one day), and gross, operating and net profit.
 */
// Extensionless imports: the web app imports this file directly (@app/shared/sheet).
import type { AdSpendProvider } from "./ads";
import { byStart, eventCovers, eventOverlaps, isBusinessEventKind, type BusinessEvent, type BusinessEventKind } from "./businessEvents";
import { addDays, daysBetweenInclusive } from "./dates";
import { profitAndLoss, type ProfitDay, type ProfitLoss, type ProfitSetup } from "./profit";
import { weekdayOf } from "./sales";

/** One day of the store as the sheet reads it, from the dashboard's answer for the dates. */
export interface SheetDay {
  day: string;
  /** Shopify's total sales and its tax: absent for a member without "View gross sales, discounts, tax, shipping and total sales". */
  totalSales?: number;
  tax?: number;
  netSales: number;
  orders: number;
  /** What the day's orders sold for (items after discounts, before tax): what average order value divides by orders. */
  orderValue: number;
  /** Orders from customers buying for the first time: absent without "View returning vs new customers". */
  newCustomerOrders?: number;
  /** Net items sold. */
  units?: number;
  /** Visits the storefront pixel tracked; null on a day before it counted them, absent when the store has none to show. */
  visits?: number | null;
  /** Ad spend per platform with accounts connected; null on a day its accounts have no figures for. */
  spend: Partial<Record<AdSpendProvider, number | null>>;
  /** The day as its profit is worked out: absent for a member not shown the breakdown and the costs. */
  profit?: ProfitDay;
}

/** A figure added up over some days: `undefined` not seen, `null` not known on every one of them. */
export type SheetFigure = number | null | undefined;

export interface SheetTotals {
  /** How many days were added up. */
  days: number;
  totalSales: SheetFigure;
  tax: SheetFigure;
  netSales: number;
  orders: number;
  orderValue: number;
  newCustomerOrders: SheetFigure;
  units: SheetFigure;
  visits: SheetFigure;
  spend: Partial<Record<AdSpendProvider, number | null>>;
  /** Every platform's spend together: null when one of them lacks a day, undefined with no ad account. */
  adSpend: SheetFigure;
  /** The days' profit and loss (./profit), when the store's costs were given and every day has its figures. */
  profit?: ProfitLoss;
}

const cents = (n: number) => Math.round(n * 100);

function sum(days: readonly SheetDay[], pick: (d: SheetDay) => number | null | undefined, money: boolean): SheetFigure {
  let total = 0;
  for (const d of days) {
    const v = pick(d);
    if (v === undefined) return undefined;
    if (v === null) return null;
    total += money ? cents(v) : v;
  }
  return money ? total / 100 : total;
}

/** The platforms the days have spend for, Meta first. */
function providersOf(days: readonly SheetDay[]): AdSpendProvider[] {
  const seen = new Set<AdSpendProvider>();
  for (const d of days) for (const p of Object.keys(d.spend) as AdSpendProvider[]) seen.add(p);
  return (["meta", "google"] as const).filter((p) => seen.has(p));
}

/**
 * `days` added up. A figure missing on one day is missing for them all (see SheetFigure). With
 * `setup`, their profit and loss too.
 */
export function sheetTotals(days: readonly SheetDay[], setup?: ProfitSetup): SheetTotals {
  const spend: Partial<Record<AdSpendProvider, number | null>> = {};
  for (const p of providersOf(days)) spend[p] = sum(days, (d) => (p in d.spend ? d.spend[p] : null), true) ?? null;
  const platforms = Object.values(spend);
  return {
    days: days.length,
    totalSales: sum(days, (d) => d.totalSales, true),
    tax: sum(days, (d) => d.tax, true),
    netSales: sum(days, (d) => d.netSales, true) ?? 0,
    orders: sum(days, (d) => d.orders, false) ?? 0,
    orderValue: sum(days, (d) => d.orderValue, true) ?? 0,
    newCustomerOrders: sum(days, (d) => d.newCustomerOrders, false),
    units: sum(days, (d) => d.units, false),
    visits: sum(days, (d) => d.visits, false),
    spend,
    adSpend: platforms.length === 0 ? undefined : platforms.some((v) => v === null) ? null : platforms.reduce<number>((a, v) => a + cents(v as number), 0) / 100,
    ...(setup && days.length && days.every((d) => d.profit) ? { profit: profitAndLoss(days.map((d) => d.profit!), setup) } : {}),
  };
}

const ratio = (a: SheetFigure, b: SheetFigure): SheetFigure => (a === undefined || b === undefined ? undefined : a === null || b === null || b === 0 ? null : a / b);
const minus = (a: SheetFigure, b: SheetFigure): SheetFigure => (a === undefined || b === undefined ? undefined : a === null || b === null ? null : (cents(a) - cents(b)) / 100);

// ---------------------------------------------------------------------------
// The rows
// ---------------------------------------------------------------------------

export const SHEET_SECTIONS = ["revenue", "sales", "performance", "advertising", "profit"] as const;
export type SheetSection = (typeof SHEET_SECTIONS)[number];
export const SHEET_SECTION_LABEL: Record<SheetSection, string> = { revenue: "Revenue", sales: "Sales stats", performance: "Store performance", advertising: "Advertising", profit: "Profit and loss" };

/** How a row's figures read: money, a count, a share (0.25 is 25%), a plain number, or a multiple (2.5×). */
export type SheetFormat = "money" | "count" | "percent" | "decimal" | "times";

export interface SheetRow {
  id: string;
  section: SheetSection;
  label: string;
  /** What the figure is and where it comes from, in a sentence. */
  help: string;
  format: SheetFormat;
  /** A total line: drawn heavier. */
  strong?: boolean;
  /** A profit: shown green above 0, red below. */
  signed?: boolean;
  /** Money in the ad accounts' currency rather than the store's (it is the same when spend is set against sales). */
  adCurrency?: boolean;
  /** `rolling`: the 3 days ending on a day column's day (null on other columns, or when those days aren't all there). */
  value: (t: SheetTotals, rolling: SheetTotals | null) => SheetFigure;
}

export const SPEND_LABEL: Record<AdSpendProvider, string> = { meta: "Meta ad spend", google: "Google ad spend" };

/**
 * The sheet's rows, top to bottom. `comparable`: the ad spend is in the store's currency and none
 * of it is the Google Ads demo, the dashboard's condition for setting spend against sales (docs/kpis.md
 * "Ads as share of sales"); without it the ratios of spend to sales, visits and orders are left out.
 * `grain`: the 3-day row is for day columns only. `profit`: the profit and loss rows, with the
 * product costs' rows only for a member shown them (`productCosts`).
 */
export function sheetRows(opts: { comparable: boolean; grain: SheetGrain; providers: readonly AdSpendProvider[]; profit?: { productCosts: boolean } }): SheetRow[] {
  const { comparable, grain, providers } = opts;
  const when = (on: boolean, row: SheetRow): SheetRow[] => (on ? [row] : []);
  const vsSales = (row: SheetRow) => when(comparable, row);
  return [
    {
      id: "total_sales",
      section: "revenue",
      label: "Total sales",
      help: "Shopify's total sales: net sales plus shipping, duties, fees and tax.",
      format: "money",
      strong: true,
      value: (t) => t.totalSales,
    },
    { id: "sales_ex_tax", section: "revenue", label: "Total sales ex tax", help: "Total sales less the tax charged on them.", format: "money", value: (t) => minus(t.totalSales, t.tax) },
    { id: "tax_rate", section: "revenue", label: "Tax", help: "The tax charged, as a share of total sales ex tax.", format: "percent", value: (t) => ratio(t.tax, minus(t.totalSales, t.tax)) },
    {
      id: "net_sales",
      section: "revenue",
      label: "Net sales",
      help: "What items sold for after discounts and returns, before shipping and tax: Shopify's net sales, which every ratio below is worked out on.",
      format: "money",
      strong: true,
      value: (t) => t.netSales,
    },
    { id: "orders", section: "sales", label: "Orders", help: "Orders placed, on the day Shopify processed them (as Shopify's reports count them).", format: "count", value: (t) => t.orders },
    {
      id: "new_customer_orders",
      section: "sales",
      label: "New customer orders",
      help: "Orders from customers buying for the first time. An order with no customer record (some guest checkouts) is neither new nor returning.",
      format: "count",
      value: (t) => t.newCustomerOrders,
    },
    { id: "units", section: "sales", label: "Items sold", help: "Net items sold: items sold less items returned.", format: "count", value: (t) => t.units },
    {
      id: "visits",
      section: "sales",
      label: "Store visits",
      help: "Visits the bizinsights storefront pixel tracked: one shopper on one day, for shoppers who accept analytics tracking. Blank before it counted them.",
      format: "count",
      value: (t) => t.visits,
    },
    { id: "conversion_rate", section: "performance", label: "Conversion rate", help: "Orders ÷ store visits.", format: "percent", value: (t) => ratio(t.orders, t.visits) },
    { id: "new_customer_share", section: "performance", label: "New customer %", help: "New customer orders ÷ orders.", format: "percent", value: (t) => ratio(t.newCustomerOrders, t.orders) },
    { id: "items_per_order", section: "performance", label: "Items per order", help: "Items sold ÷ orders.", format: "decimal", value: (t) => ratio(t.units, t.orders) },
    {
      id: "aov",
      section: "performance",
      label: "Average order value",
      help: "What the orders sold for (items after discounts, before tax) ÷ orders, as Shopify's average order value.",
      format: "money",
      value: (t) => ratio(t.orderValue, t.orders),
    },
    { id: "sales_per_visit", section: "performance", label: "Sales per visit", help: "Net sales ÷ store visits.", format: "money", value: (t) => ratio(t.netSales, t.visits) },
    ...vsSales({ id: "spend_per_visit", section: "performance", label: "Ad spend per visit", help: "Ad spend ÷ store visits (every visit, not only ones from ads).", format: "money", value: (t) => ratio(t.adSpend, t.visits) }),
    ...vsSales({
      id: "spend_per_order",
      section: "performance",
      label: "Ad spend per order",
      help: "Ad spend ÷ every order, whatever brought it: a derived cost, not what an order from an ad cost.",
      format: "money",
      value: (t) => ratio(t.adSpend, t.orders),
    }),
    ...providers.map(
      (p): SheetRow => ({
        id: `spend_${p}`,
        section: "advertising",
        label: SPEND_LABEL[p],
        help: "What the platform charged for the ads of the connected accounts that day, as it reports it.",
        format: "money",
        adCurrency: true,
        value: (t) => (p in t.spend ? t.spend[p] : undefined),
      }),
    ),
    ...when(providers.length > 1, { id: "ad_spend", section: "advertising", label: "Total ad spend", help: "Every connected platform's spend together.", format: "money", strong: true, adCurrency: true, value: (t) => t.adSpend }),
    ...vsSales({
      id: "ads_share",
      section: "advertising",
      label: "Ads as share of sales",
      help: "Ad spend ÷ net sales (the marketing expense ratio): how much of each sale went on ads.",
      format: "percent",
      value: (t) => ratio(t.adSpend, t.netSales),
    }),
    ...when(comparable && grain === "day", {
      id: "ads_share_3d",
      section: "advertising",
      label: "Ads as share of sales, 3 days",
      help: "The same over the day and the two before it, which evens out a day whose sales or spend came late or early.",
      format: "percent",
      value: (_t, r) => (r ? ratio(r.adSpend, r.netSales) : null),
    }),
    ...vsSales({
      id: "mer",
      section: "advertising",
      label: "Sales per unit of ad spend (MER)",
      help: "Net sales ÷ ad spend: every sale the store made, whatever brought it, against everything spent on ads.",
      format: "times",
      value: (t) => ratio(t.netSales, t.adSpend),
    }),
    ...vsSales({
      id: "after_ads",
      section: "advertising",
      label: "Net sales less ad spend",
      help: "Net sales after the ad spend. Not profit: product costs, shipping, fees and your other costs aren't taken off.",
      format: "money",
      strong: true,
      value: (t) => minus(t.netSales, t.adSpend),
    }),
    ...(opts.profit ? profitRows(opts.profit.productCosts) : []),
  ];
}

/** A figure of the column's profit and loss: undefined (row left out) without one, null when it can't be given. */
const pl = (pick: (p: ProfitLoss) => number | null | undefined) => (t: SheetTotals): SheetFigure => (t.profit ? pick(t.profit) : undefined);

/** The profit and loss rows (docs/kpis.md "Profit and loss"), each column's own days. */
function profitRows(productCosts: boolean): SheetRow[] {
  const row = (r: Omit<SheetRow, "section">): SheetRow => ({ section: "profit", ...r });
  return [
    row({ id: "revenue", label: "Revenue", help: "Net sales plus the shipping and fees charged: total sales less tax and duties, what the store kept from its sales before any cost.", format: "money", strong: true, value: pl((p) => p.revenue) }),
    ...(productCosts
      ? [
          row({ id: "product_costs", label: "Product costs", help: "The items sold, returns taken off, at each product's cost per item in Shopify. Blank when a product sold has no cost per item.", format: "money", value: pl((p) => (p.grossGaps.length ? null : p.productCosts)) }),
          row({ id: "gross_profit", label: "Gross profit", help: "Net sales less product costs, as Shopify works out gross profit.", format: "money", strong: true, signed: true, value: pl((p) => p.grossProfit) }),
          row({ id: "gross_margin", label: "Gross margin", help: "Gross profit ÷ net sales.", format: "percent", value: pl((p) => p.grossMargin) }),
        ]
      : []),
    row({ id: "your_variable", label: "Your variable costs", help: "The costs in your list that go up and down with selling (shipping, packaging, payment fees, commissions, other marketing), on the days they cover.", format: "money", value: pl((p) => p.yours.byGroup.variable) }),
    row({ id: "variable_costs", label: "Variable costs", help: "Product costs + ad spend + your variable costs.", format: "money", strong: true, value: pl((p) => p.variableCosts) }),
    row({ id: "fixed_costs", label: "Fixed costs", help: "Your fixed costs' share of these days: a monthly cost ÷ its month's days (or the days you're open), so a day never carries the whole month.", format: "money", value: pl((p) => p.fixedCosts) }),
    row({ id: "operating_profit", label: "Operating profit", help: "Revenue − variable costs − fixed costs. Blank when an input isn't known (the notes below say which).", format: "money", strong: true, signed: true, value: pl((p) => p.operatingProfit) }),
    row({ id: "operating_margin", label: "Operating margin", help: "Operating profit ÷ revenue.", format: "percent", value: pl((p) => p.operatingMargin) }),
    row({ id: "below_operating", label: "Interest, tax, depreciation", help: "The costs in your list below operating profit: loan interest, income tax, depreciation and the like.", format: "money", value: pl((p) => p.belowOperating) }),
    row({ id: "net_profit", label: "Net profit", help: "Operating profit less interest, tax and depreciation: revenue less every cost, each counted once.", format: "money", strong: true, signed: true, value: pl((p) => p.netProfit) }),
    row({ id: "net_margin", label: "Net margin", help: "Net profit ÷ revenue.", format: "percent", value: pl((p) => p.netMargin) }),
  ];
}

// ---------------------------------------------------------------------------
// The columns: days, weeks or months, of the days the filter shows
// ---------------------------------------------------------------------------

export const SHEET_GRAINS = ["day", "week", "month"] as const;
export type SheetGrain = (typeof SHEET_GRAINS)[number];
export const isSheetGrain = (s: string): s is SheetGrain => (SHEET_GRAINS as readonly string[]).includes(s);

/**
 * Which days the events let through: every day, the days with an event (any, of one kind, or one
 * event), or the days without any. As it is written in the page's address (?events=).
 */
export type EventFilter = "all" | "with" | "without" | `kind:${BusinessEventKind}` | `event:${string}`;

const EVENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** `?events=` read back; anything else is every day. */
export function parseEventFilter(s: string | null | undefined): EventFilter {
  if (s === "with" || s === "without") return s;
  if (s?.startsWith("kind:") && isBusinessEventKind(s.slice(5))) return s as EventFilter;
  if (s?.startsWith("event:") && EVENT_ID.test(s.slice(6))) return s as EventFilter;
  return "all";
}

export interface SheetFilter {
  /** The weekdays shown, Monday = 0 … Sunday = 6; empty means all seven. */
  weekdays: readonly number[];
  events: EventFilter;
}

/** Weekdays as the page writes them (?days=): "weekdays", "weekends", or the days' numbers ("0,2,4"). */
export const WEEKDAY_SETS = { weekdays: [0, 1, 2, 3, 4], weekends: [5, 6] } as const;

export function parseWeekdays(s: string | null | undefined): number[] {
  if (!s) return [];
  if (s === "weekdays" || s === "weekends") return [...WEEKDAY_SETS[s]];
  const days = [...new Set(s.split(",").map(Number))].filter((n) => Number.isInteger(n) && n >= 0 && n <= 6).sort();
  return days.length === 7 ? [] : days;
}

export function weekdaysParam(days: readonly number[]): string | null {
  const set = [...new Set(days)].sort();
  if (set.length === 0 || set.length === 7) return null;
  for (const [name, d] of Object.entries(WEEKDAY_SETS)) if (d.length === set.length && d.every((x, i) => x === set[i])) return name;
  return set.join(",");
}

/** Whether `filter` shows `day`, given the store's events. */
export function dayShown(day: string, filter: SheetFilter, events: readonly BusinessEvent[]): boolean {
  if (filter.weekdays.length && !filter.weekdays.includes(weekdayOf(day))) return false;
  const f = filter.events;
  if (f === "all") return true;
  const on = events.filter((e) => eventCovers(e, day));
  if (f === "with") return on.length > 0;
  if (f === "without") return on.length === 0;
  if (f.startsWith("kind:")) return on.some((e) => e.kind === f.slice(5));
  return on.some((e) => e.id === f.slice(6));
}

const weekStart = (day: string) => addDays(day, -weekdayOf(day));
const monthEnd = (day: string) => {
  const last = new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)), 0)).getUTCDate();
  return `${day.slice(0, 8)}${String(last).padStart(2, "0")}`;
};

export interface SheetColumn {
  /** The day, the week's Monday, or the month (YYYY-MM). */
  key: string;
  grain: SheetGrain;
  /** The period's first and last day within the dates picked. */
  from: string;
  to: string;
  /** The days of the period within the dates, and how many of them the filter shows. */
  periodDays: number;
  shownDays: number;
  /** The events running on any day shown, earliest first. */
  events: BusinessEvent[];
  totals: SheetTotals;
  /** Day columns: the day and the two before it, whatever the filter (null when those days aren't all in the dates). */
  rolling: SheetTotals | null;
}

/**
 * The sheet's columns, oldest first: one per day, week (Monday to Sunday) or calendar month that
 * has a day the filter shows. `days` is every day of the dates picked, in order. With `setup`, each
 * column's profit and loss.
 */
export function sheetColumns(days: readonly SheetDay[], events: readonly BusinessEvent[], grain: SheetGrain, filter: SheetFilter, setup?: ProfitSetup): SheetColumn[] {
  if (!days.length) return [];
  const first = days[0]!.day;
  const last = days[days.length - 1]!.day;
  const byDay = new Map(days.map((d) => [d.day, d]));
  const groups = new Map<string, SheetDay[]>();
  for (const d of days) {
    if (!dayShown(d.day, filter, events)) continue;
    const key = grain === "day" ? d.day : grain === "week" ? weekStart(d.day) : d.day.slice(0, 7);
    groups.set(key, [...(groups.get(key) ?? []), d]);
  }
  return [...groups].map(([key, shown]) => {
    const start = grain === "day" ? key : grain === "week" ? key : `${key}-01`;
    const end = grain === "day" ? key : grain === "week" ? addDays(key, 6) : monthEnd(start);
    const from = start < first ? first : start;
    const to = end > last ? last : end;
    const trailing = grain === "day" ? [addDays(key, -2), addDays(key, -1), key].map((d) => byDay.get(d)) : [];
    return {
      key,
      grain,
      from,
      to,
      periodDays: daysBetweenInclusive(from, to),
      shownDays: shown.length,
      events: events.filter((e) => shown.some((d) => eventCovers(e, d.day))).sort(byStart),
      totals: sheetTotals(shown, setup),
      rolling: trailing.length && trailing.every((d) => d !== undefined) ? sheetTotals(trailing as SheetDay[]) : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Event days against the others
// ---------------------------------------------------------------------------

export interface EventSummary {
  event: BusinessEvent;
  /** Its days within the dates picked, added up. */
  totals: SheetTotals;
}

export interface EventComparison {
  /** Each event running within the dates, earliest first. */
  events: EventSummary[];
  /** Every day with an event, and every day without one (null when there is no such day). */
  withEvents: SheetTotals | null;
  withoutEvents: SheetTotals | null;
}

/** The days of the dates picked split by the events on them, the weekday filter applied first. */
export function eventComparison(days: readonly SheetDay[], events: readonly BusinessEvent[], weekdays: readonly number[] = []): EventComparison {
  const shown = days.filter((d) => dayShown(d.day, { weekdays, events: "all" }, events));
  if (!shown.length) return { events: [], withEvents: null, withoutEvents: null };
  const range = { from: shown[0]!.day, to: shown[shown.length - 1]!.day };
  const on = shown.filter((d) => events.some((e) => eventCovers(e, d.day)));
  const off = shown.filter((d) => !events.some((e) => eventCovers(e, d.day)));
  return {
    events: events
      .filter((e) => eventOverlaps(e, range))
      .sort(byStart)
      .flatMap((event) => {
        const its = shown.filter((d) => eventCovers(event, d.day));
        return its.length ? [{ event, totals: sheetTotals(its) }] : [];
      }),
    withEvents: on.length ? sheetTotals(on) : null,
    withoutEvents: off.length ? sheetTotals(off) : null,
  };
}

/** A figure per day of `t` (net sales a day, orders a day): null when unknown, undefined when not seen. */
export const perDay = (n: SheetFigure, t: SheetTotals): SheetFigure => (n === undefined || n === null || t.days === 0 ? n : n / t.days);

/** How much `a` is above (+) or below (−) `b`, as a share of `b`; null when either isn't known or `b` is 0. */
export const changeFrom = (a: SheetFigure, b: SheetFigure): number | null => (a === undefined || b === undefined || a === null || b === null || b === 0 ? null : (a - b) / b);

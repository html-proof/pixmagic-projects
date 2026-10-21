/**
 * The day-by-day and month-by-month sales breakdowns on the dashboard. Pure functions over the
 * daily aggregates, so the API (months) and the web app (days) share one tested definition.
 *
 * Days and months before the store's imported history starts (`historyFrom`, from `historyStart`
 * in ./dates) are "not imported", never zero: Shopify only shares the last 60 days of orders with
 * most apps, and drawing those days as $0 would read as a store that sold nothing.
 *
 * Both measure net sales unless they are given another measure: the store's Custom sales
 * (./salesCalculation), worked out from each day's or month's lines of total sales. Shopify's own
 * figures stay on every day and month whatever is measured.
 */
// Without the ".js" the rest of the package uses: the web app imports this file directly
// (@app/shared/sales), and its bundler doesn't map "./dates.js" to dates.ts.
import { addDays, daysBetweenInclusive } from "./dates";
import { delta, type DailyMetricsRow } from "./kpi";
import { customSales, type ComponentSelection, type SalesLines } from "./salesCalculation";

const r2 = (n: number) => Math.round(n * 100) / 100;
/** The lines of total sales besides net sales, as daily rows hold them. */
const LINE_KEYS = ["additionalFees", "duties", "shipping", "taxes", "totalSales"] as const;
const NOTHING = { netSales: 0, refunds: 0, orders: 0, additionalFees: 0, duties: 0, shipping: 0, taxes: 0, totalSales: 0 };
const linesOf = (x: SalesLines): SalesLines => ({ netSales: x.netSales, additionalFees: x.additionalFees, duties: x.duties, shipping: x.shipping, taxes: x.taxes, totalSales: x.totalSales });
const nextMonth = (month: string) => addDays(`${month}-28`, 7).slice(0, 7);
const prevMonth = (month: string) => addDays(`${month}-01`, -1).slice(0, 7);
const monthEnd = (month: string) => addDays(`${nextMonth(month)}-01`, -1);

/** One day of the dashboard's net sales series (see `dailySeries` in the API). */
export interface SalesDay {
  day: string;
  netSales: number;
  /** Net sales + shipping + taxes + duties and fees (Shopify's "Total sales"). */
  totalSales: number;
  orders: number;
  refunds: number;
  averageOrderValue: number | null;
}

/** Monday = 0 … Sunday = 6, for a YYYY-MM-DD calendar day. */
export function weekdayOf(day: string): number {
  return (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
}

/** Round to a figure people use as a target: 1,530 → 1,500; 2,040 → 2,000; 765 → 750. */
export function niceRound(x: number): number {
  if (!(x > 0)) return 0;
  const step = 10 ** Math.floor(Math.log10(x)) / 2;
  return Math.max(step, Math.round(x / step) * step);
}

/**
 * Sales levels that make a day stand out, from the store's own daily average: a strong day is
 * about one and a half times it, a best day about twice it, both rounded to a figure a merchant
 * would set as a target. Relative, because a fixed dollar line means nothing across stores.
 */
export interface DayTiers {
  strong: number;
  best: number | null;
}

export function dayTiers(average: number | null): DayTiers | null {
  if (average === null || !(average > 0)) return null;
  const strong = niceRound(average * 1.5);
  const best = niceRound(average * 2);
  return { strong, best: best > strong ? best : null };
}

/** 1 = an ordinary day, 2 = strong, 3 = best. */
export function tierOf(netSales: number, tiers: DayTiers | null): 1 | 2 | 3 {
  if (!tiers) return 1;
  if (tiers.best !== null && netSales >= tiers.best) return 3;
  return netSales >= tiers.strong ? 2 : 1;
}

export type DayStatus = "complete" | "today" | "not_imported";

/** Finished days a range needs before its days are graded as ordinary, strong or best. */
export const MIN_TIER_DAYS = 14;

export type BreakdownDay<D extends SalesDay = SalesDay> = D & {
  status: DayStatus;
  /** The day's figure under the measure (net sales unless another is given). */
  value: number;
  /** The measure from the first imported day of the range to the end of this one; null before it. */
  cumulative: number | null;
  tier: 1 | 2 | 3;
};

/** Every figure below is of the measure: net sales unless `dailyBreakdown` was given another. */
export interface DailyBreakdown<D extends SalesDay = SalesDay> {
  days: Array<BreakdownDay<D>>;
  total: number;
  orders: number;
  /** Per finished day (today and days not imported left out); null with none. */
  average: number | null;
  tiers: DayTiers | null;
  best: { day: string; value: number } | null;
  daysWithSales: number;
  /** Imported days, today included. */
  importedDays: number;
  /** The weekday that sells best on average, once the range has two full weeks of finished days. */
  bestWeekday: { weekday: number; average: number } | null;
  /** Calendar months (YYYY-MM) wholly inside the range, finished and imported. */
  fullMonths: string[];
}

/**
 * The days of a range, graded against the store's own average day. `measure` is what each day is
 * measured by: net sales unless the store's Custom sales is given (a day's lines, `customSales`).
 */
export function dailyBreakdown<D extends SalesDay>(
  series: D[],
  today: string,
  historyFrom: string | null,
  measure: (d: D) => number = (d) => d.netSales,
): DailyBreakdown<D> {
  const statusOf = (day: string): DayStatus =>
    historyFrom !== null && day < historyFrom ? "not_imported" : day === today ? "today" : "complete";
  const valued = series.map((d) => ({ d, value: measure(d), status: statusOf(d.day) }));
  const finished = valued.filter((x) => x.status === "complete");
  const average = finished.length ? r2(finished.reduce((a, x) => a + x.value, 0) / finished.length) : null;
  // A week's average is one good day away from another: tiers wait for two weeks of finished days.
  const tiers = finished.length >= MIN_TIER_DAYS ? dayTiers(average) : null;

  let running = 0;
  const days = valued.map(({ d, value, status }): BreakdownDay<D> => {
    if (status !== "not_imported") running = r2(running + value);
    return { ...d, status, value, cumulative: status === "not_imported" ? null : running, tier: tierOf(value, tiers) };
  });
  const imported = days.filter((d) => d.status !== "not_imported");

  let best: DailyBreakdown["best"] = null;
  for (const d of imported) if (d.value > 0 && (!best || d.value > best.value)) best = { day: d.day, value: d.value };

  let bestWeekday: DailyBreakdown["bestWeekday"] = null;
  if (finished.length >= 14) {
    const sum = Array<number>(7).fill(0);
    const count = Array<number>(7).fill(0);
    for (const { d, value } of finished) {
      sum[weekdayOf(d.day)]! += value;
      count[weekdayOf(d.day)]! += 1;
    }
    for (let w = 0; w < 7; w++) {
      if (!count[w]) continue;
      const avg = r2(sum[w]! / count[w]!);
      if (avg > 0 && (!bestWeekday || avg > bestWeekday.average)) bestWeekday = { weekday: w, average: avg };
    }
  }

  const fullMonths: string[] = [];
  if (series.length) {
    const first = series[0]!.day;
    const last = series.at(-1)!.day;
    for (let m = first.slice(0, 7); `${m}-01` <= last; m = nextMonth(m)) {
      const start = `${m}-01`;
      const end = monthEnd(m);
      if (start >= first && end <= last && end < today && (historyFrom === null || start >= historyFrom)) fullMonths.push(m);
    }
  }

  return {
    days,
    total: r2(imported.reduce((a, d) => a + d.value, 0)),
    orders: imported.reduce((a, d) => a + d.orders, 0),
    average,
    tiers,
    best,
    daysWithSales: imported.filter((d) => d.orders > 0).length,
    importedDays: imported.length,
    bestWeekday,
    fullMonths,
  };
}

export type MonthCoverage = "full" | "partial" | "none";

export interface SalesMonth {
  /** YYYY-MM */
  month: string;
  from: string;
  /** The month's last day, or today for the current month. */
  to: string;
  current: boolean;
  /** How much of the month was imported: "partial" when the history starts inside it. */
  coverage: MonthCoverage;
  netSales: number;
  orders: number;
  refunds: number;
  averageOrderValue: number | null;
  /**
   * The other lines of Shopify's total sales (net sales + additional fees + duties + shipping +
   * taxes), so the store's Custom sales can be worked out for the month. Team & Access: they go
   * with "View gross sales, discounts, tax and shipping" (`MONTH_LINES`).
   */
  additionalFees: number;
  duties: number;
  shipping: number;
  taxes: number;
  totalSales: number;
  /**
   * Net sales' change on the month before. The current month is compared with the same days of the
   * month before (1–9 Oct with 1–9 Sep), not with all of it. Null when either side isn't fully imported.
   */
  change: number | null;
  comparedWith: { from: string; to: string } | null;
  /** The lines of total sales for `comparedWith`, so Custom sales has a change of its own; null with it. */
  comparedLines: SalesLines | null;
}

/** A month's fields that hold the lines of total sales (Team & Access: `finance.breakdown`). */
export const MONTH_LINES = ["additionalFees", "duties", "shipping", "taxes", "totalSales", "comparedLines"] as const;
export type MonthLine = (typeof MONTH_LINES)[number];

export interface YearBreakdown {
  year: number;
  months: SalesMonth[];
  total: number;
  orders: number;
}

/**
 * January to the current month of the store's year, from daily rows that reach back to the
 * December before (for January's change).
 */
export function yearBreakdown(rows: DailyMetricsRow[], today: string, historyFrom: string | null): YearBreakdown {
  const sum = (from: string, to: string) => {
    let gross = 0;
    let discounts = 0;
    let refunds = 0;
    let orders = 0;
    let orderValue = 0;
    const lines = { additionalFees: 0, duties: 0, shipping: 0, taxes: 0, totalSales: 0 };
    for (const r of rows) {
      if (r.day < from || r.day > to) continue;
      gross += r.grossSales;
      discounts += r.discounts;
      refunds += r.refunds;
      orders += r.orders;
      orderValue += r.orderValue;
      for (const k of LINE_KEYS) lines[k] += r[k];
    }
    // Rounded to cents before subtracting, as `summarize` does, so totals agree with the tiles.
    const beforeRefunds = r2(r2(gross) - r2(discounts));
    for (const k of LINE_KEYS) lines[k] = r2(lines[k]);
    return { netSales: r2(beforeRefunds - r2(refunds)), refunds: r2(refunds), orders, averageOrderValue: orders > 0 ? r2(r2(orderValue) / orders) : null, ...lines };
  };
  const coverage = (from: string, to: string): MonthCoverage =>
    historyFrom === null || from >= historyFrom ? "full" : to < historyFrom ? "none" : "partial";

  const year = Number(today.slice(0, 4));
  const thisMonth = today.slice(0, 7);
  const months: SalesMonth[] = [];
  for (let m = `${year}-01`; m <= thisMonth; m = nextMonth(m)) {
    const current = m === thisMonth;
    const from = `${m}-01`;
    const to = current ? today : monthEnd(m);
    const cov = coverage(from, to);
    const own = sum(from, to);

    // The month before, whole, or only as many days as this month has had so far.
    const pm = prevMonth(m);
    const pFrom = `${pm}-01`;
    const pEnd = monthEnd(pm);
    const sameDays = addDays(pFrom, daysBetweenInclusive(from, to) - 1);
    const pTo = current && sameDays < pEnd ? sameDays : pEnd;
    const comparable = cov === "full" && coverage(pFrom, pTo) === "full";
    const before = comparable ? sum(pFrom, pTo) : null;
    months.push({
      month: m,
      from,
      to,
      current,
      coverage: cov,
      // A month not imported holds nothing, and the cards draw it as such, never as $0.
      ...(cov === "none" ? { ...NOTHING, averageOrderValue: null } : own),
      change: before ? delta(own.netSales, before.netSales) : null,
      comparedWith: before ? { from: pFrom, to: pTo } : null,
      comparedLines: before ? linesOf(before) : null,
    });
  }
  return {
    year,
    months,
    total: r2(months.reduce((a, m) => a + m.netSales, 0)),
    orders: months.reduce((a, m) => a + m.orders, 0),
  };
}

/** What a month card measures: net sales, or the store's Custom sales from the month's lines. */
export interface MonthMeasure<M> {
  value: (m: M) => number;
  /** Change on the dates the month is compared with (`comparedWith`); null without them. */
  change: (m: M) => number | null;
}

/** Shopify's net sales, as the months carry it. */
export const NET_SALES_MONTHS: MonthMeasure<Pick<SalesMonth, "netSales" | "change">> = { value: (m) => m.netSales, change: (m) => m.change };

/**
 * The store's Custom sales month by month: the lines its calculation counts, added up in cents
 * (`customSales`), and compared on the same lines of the dates the month is compared with.
 */
export function customSalesMonths(selection: ComponentSelection): MonthMeasure<Omit<SalesLines, "totalSales"> & Pick<SalesMonth, "comparedLines">> {
  return {
    value: (m) => customSales(m, selection),
    change: (m) => (m.comparedLines ? delta(customSales(m, selection), customSales(m.comparedLines, selection)) : null),
  };
}

export interface YearFigures {
  /** Each month under the measure, with the year's running total to its end (null while not imported). */
  months: Array<{ month: string; value: number; change: number | null; cumulative: number | null }>;
  total: number;
  /** Per finished, fully imported month; null with none. */
  average: number | null;
  finishedMonths: number;
  best: { month: string; value: number } | null;
}

/** The month card's figures under one measure (`NET_SALES_MONTHS` or `customSalesMonths`). */
export function yearFigures<M extends Pick<SalesMonth, "month" | "current" | "coverage">>(months: M[], measure: MonthMeasure<M>): YearFigures {
  let running = 0;
  const out = months.map((m) => {
    const imported = m.coverage !== "none";
    const value = imported ? measure.value(m) : 0;
    if (imported) running = r2(running + value);
    return { month: m.month, value, change: imported ? measure.change(m) : null, cumulative: imported ? running : null };
  });
  const finished = out.filter((_, i) => !months[i]!.current && months[i]!.coverage === "full");
  let best: YearFigures["best"] = null;
  for (const m of out) if (m.cumulative !== null && m.value > 0 && (!best || m.value > best.value)) best = { month: m.month, value: m.value };
  return {
    months: out,
    total: running,
    average: finished.length ? r2(finished.reduce((a, m) => a + m.value, 0) / finished.length) : null,
    finishedMonths: finished.length,
    best,
  };
}

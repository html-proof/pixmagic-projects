/**
 * The day-by-day and month-by-month sales breakdowns on the dashboard. Pure functions over the
 * daily aggregates, so the API (months) and the web app (days) share one tested definition.
 *
 * Days and months before the store's imported history starts (`historyFrom`, from `historyStart`
 * in ./dates) are "not imported", never zero: Shopify only shares the last 60 days of orders with
 * most apps, and drawing those days as $0 would read as a store that sold nothing.
 */
// Without the ".js" the rest of the package uses: the web app imports this file directly
// (@app/shared/sales), and its bundler doesn't map "./dates.js" to dates.ts.
import { addDays, daysBetweenInclusive } from "./dates";
import { delta, type DailyMetricsRow } from "./kpi";

const r2 = (n: number) => Math.round(n * 100) / 100;
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

export interface BreakdownDay extends SalesDay {
  status: DayStatus;
  /** Net sales from the first imported day of the range to the end of this one; null before it. */
  cumulative: number | null;
  tier: 1 | 2 | 3;
}

export interface DailyBreakdown {
  days: BreakdownDay[];
  total: number;
  orders: number;
  /** Net sales per finished day (today and days not imported left out); null with none. */
  average: number | null;
  tiers: DayTiers | null;
  best: { day: string; netSales: number } | null;
  daysWithSales: number;
  /** Imported days, today included. */
  importedDays: number;
  /** The weekday that sells best on average, once the range has two full weeks of finished days. */
  bestWeekday: { weekday: number; average: number } | null;
  /** Calendar months (YYYY-MM) wholly inside the range, finished and imported. */
  fullMonths: string[];
}

export function dailyBreakdown(series: SalesDay[], today: string, historyFrom: string | null): DailyBreakdown {
  const statusOf = (day: string): DayStatus =>
    historyFrom !== null && day < historyFrom ? "not_imported" : day === today ? "today" : "complete";
  const finished = series.filter((d) => statusOf(d.day) === "complete");
  const average = finished.length ? r2(finished.reduce((a, d) => a + d.netSales, 0) / finished.length) : null;
  // A week's average is one good day away from another: tiers wait for two weeks of finished days.
  const tiers = finished.length >= MIN_TIER_DAYS ? dayTiers(average) : null;

  let running = 0;
  const days = series.map((d): BreakdownDay => {
    const status = statusOf(d.day);
    if (status !== "not_imported") running = r2(running + d.netSales);
    return { ...d, status, cumulative: status === "not_imported" ? null : running, tier: tierOf(d.netSales, tiers) };
  });
  const imported = days.filter((d) => d.status !== "not_imported");

  let best: DailyBreakdown["best"] = null;
  for (const d of imported) if (d.netSales > 0 && (!best || d.netSales > best.netSales)) best = { day: d.day, netSales: d.netSales };

  let bestWeekday: DailyBreakdown["bestWeekday"] = null;
  if (finished.length >= 14) {
    const sum = Array<number>(7).fill(0);
    const count = Array<number>(7).fill(0);
    for (const d of finished) {
      sum[weekdayOf(d.day)]! += d.netSales;
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
    total: r2(imported.reduce((a, d) => a + d.netSales, 0)),
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
   * Change on the month before. The current month is compared with the same days of the month
   * before (1–9 Oct with 1–9 Sep), not with all of it. Null when either side isn't fully imported.
   */
  change: number | null;
  comparedWith: { from: string; to: string } | null;
}

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
    for (const r of rows) {
      if (r.day < from || r.day > to) continue;
      gross += r.grossSales;
      discounts += r.discounts;
      refunds += r.refunds;
      orders += r.orders;
    }
    // Rounded to cents before subtracting, as `summarize` does, so totals agree with the tiles.
    const beforeRefunds = r2(r2(gross) - r2(discounts));
    return { netSales: r2(beforeRefunds - r2(refunds)), refunds: r2(refunds), orders, averageOrderValue: orders > 0 ? r2(beforeRefunds / orders) : null };
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
    months.push({
      month: m,
      from,
      to,
      current,
      coverage: cov,
      ...(cov === "none" ? { netSales: 0, refunds: 0, orders: 0, averageOrderValue: null } : own),
      change: comparable ? delta(own.netSales, sum(pFrom, pTo).netSales) : null,
      comparedWith: comparable ? { from: pFrom, to: pTo } : null,
    });
  }
  return {
    year,
    months,
    total: r2(months.reduce((a, m) => a + m.netSales, 0)),
    orders: months.reduce((a, m) => a + m.orders, 0),
  };
}

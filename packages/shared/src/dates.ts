/** All reporting days are calendar days in the *store's* IANA time zone. */
export function localDay(date: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** The store-local time of day, "HH:MM:SS" on a 24-hour clock. */
export function localTime(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(date);
}

/**
 * The moment a store-local day begins, as a UTC instant: "2026-01-01" in Melbourne (UTC+11) is
 * 2025-12-31T13:00:00Z. Where a daylight-saving change skips midnight, the first moment the day has.
 */
export function startOfLocalDay(day: string, timeZone: string): Date {
  const wanted = Date.parse(`${day}T00:00:00Z`);
  let t = wanted;
  // Shift by the zone's offset at the guess, twice: once more lands right across a DST change.
  for (let i = 0; i < 2; i++) {
    const at = new Date(t);
    t -= Date.parse(`${localDay(at, timeZone)}T${localTime(at, timeZone)}Z`) - wanted;
  }
  return new Date(t);
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * The day every week begins on, everywhere bizinsights reports by the week: Monday (ISO 8601, as
 * `getUTCDay` numbers it: 1). "This week", "Last week" and the weekly charts all count Monday to
 * Sunday, whichever platform the figures come from; Meta and Google offer both, Monday included.
 */
export const WEEK_STARTS_ON = 1;

/** The Monday of the week `day` is in (`WEEK_STARTS_ON`). */
export function weekStart(day: string): string {
  const wd = new Date(`${day}T00:00:00Z`).getUTCDay();
  return addDays(day, -((wd - WEEK_STARTS_ON + 7) % 7));
}

/**
 * How a trend chart groups its days: one column per day, per week (Monday to Sunday,
 * `WEEK_STARTS_ON`) or per calendar month. The same on the dashboard, the Advertising area and the
 * Google Ads analytics page.
 */
export const PERIOD_GRANULARITIES = ["day", "week", "month"] as const;
export type PeriodGranularity = (typeof PERIOD_GRANULARITIES)[number];

/** ISO week label, "2026-W42". */
export function weekKey(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  // ISO weeks: the week with the year's first Thursday is week 1.
  const target = new Date(d.getTime());
  target.setUTCDate(target.getUTCDate() + 3 - ((target.getUTCDay() + 6) % 7));
  const year = target.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(year, 0, 4));
  const week = 1 + Math.round(((target.getTime() - firstThursday.getTime()) / 86_400_000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

const monthStart = (day: string) => `${day.slice(0, 7)}-01`;

/** The periods of [from, to] at `g`: each with its first and last day inside the range. */
export function periodsOf(range: DateRange, g: PeriodGranularity): Array<{ key: string; from: string; to: string }> {
  if (range.from > range.to) return [];
  if (g === "day") return eachDay(range.from, range.to).map((d) => ({ key: d, from: d, to: d }));
  const out: Array<{ key: string; from: string; to: string }> = [];
  let start = range.from;
  while (start <= range.to) {
    const periodStart = g === "week" ? weekStart(start) : monthStart(start);
    const next = g === "week" ? addDays(periodStart, 7) : addDays(monthStart(addDays(periodStart, 31)), 0);
    const end = addDays(next, -1);
    out.push({ key: g === "week" ? weekKey(periodStart) : periodStart.slice(0, 7), from: start, to: end < range.to ? end : range.to });
    start = next;
  }
  return out;
}

export function daysBetweenInclusive(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

/**
 * The dates the dashboard can report on. `6m` and `12m` are the last 6 and 12 months up to today
 * (from the day after the same date 6 or 12 months earlier: 25 Apr – 24 Oct, 25 Oct 2025 – 24 Oct
 * 2026). `wtd` and `lastweek` are calendar weeks, Monday to Sunday (`WEEK_STARTS_ON`). No preset or
 * custom range is longer than 12 months (`latestRangeEnd`).
 */
export const DATE_PRESETS = ["today", "yesterday", "wtd", "lastweek", "7d", "30d", "90d", "6m", "12m", "mtd", "lastmonth", "ytd", "lastyear", "custom"] as const;
export type DatePreset = (typeof DATE_PRESETS)[number];

export interface DateRange {
  from: string;
  to: string;
}

/**
 * The dates a range is compared with: the period just before it (`comparisonDays`). While the
 * range picked is still running (it ends on the store's today), the comparison stops at the same
 * time of day on its last day, as Shopify's
 * Analytics compares "like for like": today until 4:44 pm against yesterday until 4:44 pm, never
 * against the whole of yesterday, which made every day look down until it was nearly over.
 */
export interface Comparison extends DateRange {
  /** Store-local "HH:MM:SS" that the comparison's last day is counted up to; absent: whole days. */
  until?: string;
}

/**
 * The dates asked about. `until`: while they still run (they end on the store's today), the
 * store-local "HH:MM:SS" it is now. Shopify's own report figures for the dates, and ours checked
 * against them, are counted up to that moment of the last day; absent: whole days.
 */
export interface ReportDates {
  range: DateRange;
  until?: string;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar day written YYYY-MM-DD: "2026-02-31" and "2026-13-01" match the shape but aren't. */
export function isDay(s: string | null | undefined): s is string {
  if (!s || !DAY_RE.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
}

/** Every day from `from` to `to`, both included; empty when `from` is after `to`. */
export function eachDay(from: string, to: string): string[] {
  const days: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  return days;
}

/**
 * Earliest day a custom range may include. It also keeps a year that is still being typed from
 * counting as a date: Chrome reports "2026" typed digit by digit as 0002, 0020, 0202, then 2026.
 */
export const MIN_CUSTOM_DAY = "2000-01-01";
/** The most days 12 months can hold (`latestRangeEnd`): the ad reports' own limit. */
export const MAX_CUSTOM_DAYS = 366;
/** The longest range asked about at once, as the dashboard and its downloads take it. */
export const MAX_RANGE_MONTHS = 12;

/** The same calendar day `n` months earlier (a negative `n`: later), or the month's last day when it has none: "2026-08-31", 6 → "2026-02-28". */
export function monthsEarlier(day: string, n: number): string {
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7)) - 1 - n;
  const year = y + Math.floor(m / 12);
  const month = ((m % 12) + 12) % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const d = Math.min(Number(day.slice(8, 10)), last);
  return `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * The last day a range starting on `from` may run to: 12 months, the day before the same date a
 * year later ("2025-03-15" → "2026-03-14", "2024-01-01" → "2024-12-31"). From 29 February the year
 * runs to the 28th: 1 March is the first day it hasn't reached. At most 366 days, in a year
 * holding a 29 February.
 */
export function latestRangeEnd(from: string): string {
  const year = String(Number(from.slice(0, 4)) + 1).padStart(4, "0");
  const next = `${year}${from.slice(4)}`;
  return addDays(isDay(next) ? next : `${year}-03-01`, -1);
}

/**
 * The first store-local day a store has anything from: the day Shopify created it (shop.createdAt,
 * stores.shop_created_at), or an earlier order's day. Orders brought in from another platform keep
 * the day they were processed there, which can be before the store existed on Shopify, and are
 * never left out. Null while neither is known (the store's details not read yet, and no orders).
 */
export function storeStartDay(createdAt: Date | null, timeZone: string, oldestOrderDay: string | null): string | null {
  const created = createdAt ? localDay(createdAt, timeZone) : null;
  if (created === null || oldestOrderDay === null) return created ?? oldestOrderDay;
  return oldestOrderDay < created ? oldestOrderDay : created;
}

/**
 * A calendar year as dates to report on: 1 January to 31 December, or to `today` for the year still
 * running. Twelve months, so any year can be asked about on its own, however long ago.
 */
export function calendarYear(year: number, today: string): DateRange {
  const y = String(year).padStart(4, "0");
  const to = `${y}-12-31`;
  return { from: `${y}-01-01`, to: to > today ? today : to };
}

/** The years from `startDay`'s (MIN_CUSTOM_DAY's when unknown) to `today`'s, newest first: what the year picker offers. */
export function yearsBetween(startDay: string | null, today: string): number[] {
  const first = Number((startDay && startDay >= MIN_CUSTOM_DAY ? startDay : MIN_CUSTOM_DAY).slice(0, 4));
  const years: number[] = [];
  for (let y = Number(today.slice(0, 4)); y >= first; y--) years.push(y);
  return years;
}

/** How early custom dates may start: from `earliest` on (null or absent: MIN_CUSTOM_DAY). */
export interface RangeLimits {
  earliest?: string | null;
}

/**
 * The dashboard's limits for a store whose first day is `start` (`storeStartDay`): custom dates may
 * not start before it once Shopify's creation date is known (`created`), since nothing happened in
 * the store before then. Until it is, `start` is only the first order's day, and a quiet first
 * month before that order is still the store's: no earlier limit than MIN_CUSTOM_DAY is set.
 */
export const storeRangeLimits = (start: string | null, created: boolean): RangeLimits => ({ earliest: created ? start : null });

export type CustomRangeProblem = "incomplete" | "reversed" | "future" | "before_start" | "too_long";

/**
 * Why a custom range can't be reported on, or null when it can. The API refuses these and the
 * dashboard holds off asking for them, so both read this one definition.
 *
 * With `today` (the store's), a range may run past it, because it is reported only up to today
 * (see `clampCustomRange`), but it can't start after it, and its length is counted to today: at
 * most 12 months (`latestRangeEnd`), however far back it starts. `limits` bound how early it may
 * start (RangeLimits).
 */
export function customRangeProblem(r: { from?: string; to?: string }, today?: string, limits: RangeLimits = {}): CustomRangeProblem | null {
  const { from, to } = r;
  if (!isDay(from) || !isDay(to) || from < MIN_CUSTOM_DAY || to < MIN_CUSTOM_DAY) return "incomplete";
  if (from > to) return "reversed";
  if (today && from > today) return "future";
  if (limits.earliest && from < limits.earliest) return "before_start";
  if (clampCustomRange({ from, to }, today).to > latestRangeEnd(from)) return "too_long";
  return null;
}

/**
 * A custom range as reported: ending today at the latest. Days that haven't happened have no
 * sales, so counting them made "1 – 31 Oct" on 9 Oct compare 9 days of trading with the 31 full
 * days before, and the chart end in a run of zeros.
 */
export function clampCustomRange(r: DateRange, today?: string): DateRange {
  return today && r.to > today ? { from: r.from, to: today } : r;
}

const CUSTOM_RANGE_ERROR: Record<CustomRangeProblem, string> = {
  incomplete: "Invalid custom range",
  reversed: "Invalid custom range",
  future: "Range starts after today",
  before_start: "Range starts before the store's first day",
  too_long: "Range too long: pick up to 12 months at a time",
};

/** The same calendar day a year earlier: "2028-02-29" → "2027-02-28". */
export function yearEarlier(day: string): string {
  const year = String(Number(day.slice(0, 4)) - 1).padStart(4, "0");
  const same = `${year}${day.slice(4)}`;
  return isDay(same) ? same : `${year}-02-28`;
}

function presetRange(preset: DatePreset, today: string, custom: DateRange | undefined, limits: RangeLimits): DateRange {
  switch (preset) {
    case "today":
      return { from: today, to: today };
    case "yesterday": {
      const y = addDays(today, -1);
      return { from: y, to: y };
    }
    case "wtd":
      return { from: weekStart(today), to: today };
    case "lastweek": {
      // The whole calendar week before this one, Monday to Sunday.
      const monday = addDays(weekStart(today), -7);
      return { from: monday, to: addDays(monday, 6) };
    }
    case "7d":
      return { from: addDays(today, -6), to: today };
    case "30d":
      return { from: addDays(today, -29), to: today };
    case "90d":
      return { from: addDays(today, -89), to: today };
    case "6m":
      return { from: addDays(monthsEarlier(today, 6), 1), to: today };
    case "12m":
      return { from: addDays(yearEarlier(today), 1), to: today };
    case "mtd":
      return { from: `${today.slice(0, 8)}01`, to: today };
    case "lastmonth": {
      // The whole calendar month before this one.
      const lastDay = addDays(`${today.slice(0, 8)}01`, -1);
      return { from: `${lastDay.slice(0, 8)}01`, to: lastDay };
    }
    case "ytd":
      return { from: `${today.slice(0, 4)}-01-01`, to: today };
    case "lastyear": {
      // The whole calendar year before this one.
      const year = String(Number(today.slice(0, 4)) - 1).padStart(4, "0");
      return { from: `${year}-01-01`, to: `${year}-12-31` };
    }
    case "custom": {
      const problem = customRangeProblem(custom ?? {}, today, limits);
      if (problem) throw new Error(CUSTOM_RANGE_ERROR[problem]);
      return clampCustomRange(custom!, today);
    }
  }
}

/** 1 January to 31 December of one year. */
const isCalendarYear = (r: DateRange) => r.from.endsWith("-01-01") && r.to === `${r.from.slice(0, 4)}-12-31`;

/**
 * The whole days `range` is compared with: the period just before it, as many days, immediately
 * before; this week against the same days of the week before, last month against the whole month
 * before it, a calendar year against the whole year before it. They may reach back before the
 * store's first day (`limits`): the API then says the orders don't reach back to them.
 */
function comparisonDays(range: DateRange, preset: DatePreset): DateRange {
  if (preset === "wtd") {
    // The same days of the week before, Monday on: Monday to Wednesday against Monday to
    // Wednesday, never against the Friday to Sunday just before, whose trade is another kind.
    return { from: addDays(range.from, -7), to: addDays(range.to, -7) };
  }
  if (preset === "lastmonth") {
    // The whole month before, whatever its length.
    const prevLast = addDays(range.from, -1);
    return { from: `${prevLast.slice(0, 8)}01`, to: prevLast };
  }
  if (preset === "lastyear" || isCalendarYear(range)) {
    // The whole year before, leap or not (Last year, or a calendar year picked as custom dates).
    const year = String(Number(range.from.slice(0, 4)) - 1).padStart(4, "0");
    return { from: `${year}-01-01`, to: `${year}-12-31` };
  }
  const len = daysBetweenInclusive(range.from, range.to);
  return { from: addDays(range.from, -len), to: addDays(range.from, -1) };
}

/**
 * The dates a preset reports on in the store's zone, and the period just before them, which they
 * are compared with. Throws, with a message the API answers 400 `invalid_range` with, on custom
 * dates that can't be reported on: longer than 12 months, or (`limits`, the store's
 * `storeRangeLimits`) starting before the store's first day once Shopify's creation date is known.
 */
export function resolvePreset(
  preset: DatePreset,
  now: Date,
  timeZone: string,
  custom?: DateRange,
  limits: RangeLimits = {},
): ReportDates & { previous: Comparison } {
  const today = localDay(now, timeZone);
  const range = presetRange(preset, today, custom, limits);
  const previous = comparisonDays(range, preset);
  if (range.to !== today) return { range, previous };
  // Today isn't over: whatever is set against it is counted up to this moment of its own last day.
  const until = localTime(now, timeZone);
  return { range, until, previous: { ...previous, until } };
}

/** `historyStart` for a store whose whole order history was imported (read_all_orders). */
export const ALL_HISTORY = "1970-01-01";

/**
 * The first store-local day whose Shopify orders were all imported, or null when none are known to
 * be. `importedFrom` is where the store's recorded import window starts (stores.orders_history_from;
 * the epoch for its whole history): the day it falls on was only partly covered, so the day after
 * is the first whole one, unless the window starts at midnight. A store whose import predates that
 * record (null), or that holds an order from before the window, starts at its first imported
 * order's day instead (the earlier of the two). A quiet store's first order can come days after its
 * window starts: those days were imported too, with no orders in them.
 */
export function historyStart(importedFrom: Date | null, timeZone: string, oldestOrderDay: string | null): string | null {
  let from: string | null = null;
  if (importedFrom && importedFrom.getTime() <= 0) from = ALL_HISTORY;
  else if (importedFrom) from = firstWholeDay(importedFrom, timeZone);
  if (from === null || oldestOrderDay === null) return from ?? oldestOrderDay;
  return oldestOrderDay < from ? oldestOrderDay : from;
}

/**
 * The first store-local day counted in full by something that started counting at `since`: the
 * day after the one it started on, which was only partly counted, unless it started at midnight.
 */
export function firstWholeDay(since: Date, timeZone: string): string {
  const day = localDay(since, timeZone);
  return localTime(since, timeZone) === "00:00:00" ? day : addDays(day, 1);
}

/**
 * The first store-local day whose store visits were all counted, or null with none. The web pixel
 * counts from when it was put in place (`pixelInstalledAt`, stores.pixel_installed_at), so that
 * day was only partly counted and the day after is the first whole one. A store with visits from
 * an earlier day (a pixel already in place before bizinsights recorded it), or with no install
 * time recorded, starts at its first visit's day instead.
 */
export function visitsHistoryStart(pixelInstalledAt: Date | null, timeZone: string, oldestVisitDay: string | null): string | null {
  if (!pixelInstalledAt) return oldestVisitDay;
  if (oldestVisitDay !== null && oldestVisitDay < localDay(pixelInstalledAt, timeZone)) return oldestVisitDay;
  return firstWholeDay(pixelInstalledAt, timeZone);
}

/**
 * The first day every counted ad account has its figures from (ad_connections.history_from, each
 * account's own day): the latest of their starts, since a comparison before one account's start
 * would count that account in the dates picked and not in the dates compared with, a rise that
 * never happened. An account with no start yet has no figures stored, so it changes neither
 * period and is left out. Null when no account has a start.
 */
export function adsHistoryStart(starts: Array<string | null>): string | null {
  let latest: string | null = null;
  for (const s of starts) if (s !== null && (latest === null || s > latest)) latest = s;
  return latest;
}

/**
 * Whether the store's imported orders cover the whole comparison (`historyFrom` from
 * `historyStart`). Shopify shares 60 days of orders without read_all_orders, so a comparison
 * reaching back before the import would count a period mostly missing and show a fake drop (or
 * 0%): its changes are left out instead, as the month-by-month view does for months not fully
 * imported.
 */
export function comparisonImported(previous: DateRange, historyFrom: string | null): boolean {
  return historyFrom !== null && previous.from >= historyFrom;
}

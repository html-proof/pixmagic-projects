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

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetweenInclusive(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

/**
 * The dates the dashboard can report on. `wtd` is this week so far (weeks start on Monday, as ISO
 * 8601 counts them), `all` everything from the store's first day (`storeStartDay`) to today.
 */
export const DATE_PRESETS = ["today", "yesterday", "7d", "30d", "90d", "wtd", "mtd", "lastmonth", "ytd", "lastyear", "all", "custom"] as const;
export type DatePreset = (typeof DATE_PRESETS)[number];

export interface DateRange {
  from: string;
  to: string;
}

/**
 * The dates a range is compared with (`COMPARE_MODES`: the period before, the same dates a year
 * earlier, or dates picked). While the range picked is still running (it ends on the
 * store's today), the comparison stops at the same time of day on its last day, as Shopify's
 * Analytics compares "like for like": today until 4:44 pm against yesterday until 4:44 pm, never
 * against the whole of yesterday, which made every day look down until it was nearly over.
 */
export interface Comparison extends DateRange {
  /** Store-local "HH:MM:SS" that the comparison's last day is counted up to; absent: whole days. */
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
export const MAX_CUSTOM_DAYS = 366;

/** The week a day is in starts on its Monday (ISO 8601): "2026-10-25" (a Sunday) → "2026-10-19". */
export function weekStart(day: string): string {
  // getUTCDay counts Sunday as 0.
  return addDays(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7));
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
 * What custom dates may span: from `earliest` on (null or absent: MIN_CUSTOM_DAY), at most
 * `maxDays` long (absent: MAX_CUSTOM_DAYS; null: any length). All time starts at `allFrom`
 * (absent: `earliest`; neither: today alone).
 */
export interface RangeLimits {
  earliest?: string | null;
  maxDays?: number | null;
  allFrom?: string | null;
}

/**
 * The dashboard's limits for a store whose first day is `start` (`storeStartDay`): All time starts
 * on it, and any length after it is a real question ("1 Jan 2023 – 30 Jun 2025"). Custom dates may
 * not start before it once Shopify's creation date is known (`created`): nothing happened in the
 * store before then. Until it is, `start` is only the first order's day, and a quiet first month
 * before that order is still the store's: no earlier limit than 2000 is set.
 */
export const storeRangeLimits = (start: string | null, created: boolean): RangeLimits => ({ earliest: created ? start : null, allFrom: start, maxDays: null });

export type CustomRangeProblem = "incomplete" | "reversed" | "future" | "before_start" | "too_long";

/**
 * Why a custom range can't be reported on, or null when it can. The API refuses these and the
 * dashboard holds off asking for them, so both read this one definition.
 *
 * With `today` (the store's), a range may run past it, because it is reported only up to today
 * (see `clampCustomRange`), but it can't start after it, and its length is counted to today.
 * `limits` bound how early it may start and how long it may be (RangeLimits).
 */
export function customRangeProblem(r: { from?: string; to?: string }, today?: string, limits: RangeLimits = {}): CustomRangeProblem | null {
  const { from, to } = r;
  if (!isDay(from) || !isDay(to) || from < MIN_CUSTOM_DAY || to < MIN_CUSTOM_DAY) return "incomplete";
  if (from > to) return "reversed";
  if (today && from > today) return "future";
  if (limits.earliest && from < limits.earliest) return "before_start";
  const maxDays = limits.maxDays === undefined ? MAX_CUSTOM_DAYS : limits.maxDays;
  if (maxDays !== null && daysBetweenInclusive(from, clampCustomRange({ from, to }, today).to) > maxDays) return "too_long";
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
  too_long: "Range too long",
};

/**
 * What the dates picked are compared with, as Shopify Analytics' second date chip offers:
 * - `previous`: the period just before them (the default): as many days, immediately before; last
 *   month against the whole month before it, last year against the whole year before it.
 * - `year`: the same dates a year earlier (29 February, which most years lack, becomes the 28th).
 * - `custom`: dates the merchant picks (`from`/`to`), under the same rules as a custom range.
 */
export const COMPARE_MODES = ["previous", "year", "custom"] as const;
export type CompareMode = (typeof COMPARE_MODES)[number];
export type CompareChoice = { mode: CompareMode; from?: string; to?: string };

/** The same calendar day a year earlier: "2028-02-29" → "2027-02-28". */
export function yearEarlier(day: string): string {
  const year = String(Number(day.slice(0, 4)) - 1).padStart(4, "0");
  const same = `${year}${day.slice(4)}`;
  return isDay(same) ? same : `${year}-02-28`;
}

const CUSTOM_COMPARISON_ERROR: Record<CustomRangeProblem, string> = {
  incomplete: "Invalid comparison dates",
  reversed: "Invalid comparison dates",
  future: "Comparison starts after today",
  before_start: "Comparison starts before the store's first day",
  too_long: "Comparison too long",
};

function presetRange(preset: DatePreset, today: string, custom: DateRange | undefined, limits: RangeLimits): DateRange {
  switch (preset) {
    case "today":
      return { from: today, to: today };
    case "yesterday": {
      const y = addDays(today, -1);
      return { from: y, to: y };
    }
    case "7d":
      return { from: addDays(today, -6), to: today };
    case "30d":
      return { from: addDays(today, -29), to: today };
    case "90d":
      return { from: addDays(today, -89), to: today };
    case "wtd":
      return { from: weekStart(today), to: today };
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
    case "all": {
      // From the store's first day; today alone while it isn't known yet.
      const start = limits.allFrom === undefined ? limits.earliest : limits.allFrom;
      return { from: start && start < today ? start : today, to: today };
    }
    case "custom": {
      const problem = customRangeProblem(custom ?? {}, today, limits);
      if (problem) throw new Error(CUSTOM_RANGE_ERROR[problem]);
      return clampCustomRange(custom!, today);
    }
  }
}

/** The whole days `range` is compared with (see COMPARE_MODES); throws on custom dates that can't be. */
function comparisonDays(range: DateRange, preset: DatePreset, compare: CompareChoice, today: string, limits: RangeLimits): DateRange {
  switch (compare.mode) {
    case "year":
      return { from: yearEarlier(range.from), to: yearEarlier(range.to) };
    case "custom": {
      const problem = customRangeProblem(compare, today, limits);
      if (problem) throw new Error(CUSTOM_COMPARISON_ERROR[problem]);
      return clampCustomRange({ from: compare.from!, to: compare.to! }, today);
    }
    case "previous": {
      if (preset === "lastmonth") {
        // The whole month before, whatever its length.
        const prevLast = addDays(range.from, -1);
        return { from: `${prevLast.slice(0, 8)}01`, to: prevLast };
      }
      if (preset === "wtd") {
        // The same days of the week before: Monday to Thursday against last Monday to Thursday,
        // never against the Thursday to Sunday just before, a weekend against weekdays.
        return { from: addDays(range.from, -7), to: addDays(range.to, -7) };
      }
      if (preset === "lastyear") {
        // The whole year before, leap or not.
        const year = String(Number(range.from.slice(0, 4)) - 1).padStart(4, "0");
        return { from: `${year}-01-01`, to: `${year}-12-31` };
      }
      const len = daysBetweenInclusive(range.from, range.to);
      return { from: addDays(range.from, -len), to: addDays(range.from, -1) };
    }
  }
}

/**
 * The dates a preset reports on in the store's zone, and what they are compared with (`compare`,
 * the period just before when not given). Throws, with a message the API answers 400
 * `invalid_range` with, on custom dates or comparison dates that can't be reported on.
 *
 * `limits` are the store's (`storeRangeLimits`): All time starts at its first day, and custom
 * dates may not start before it once Shopify's creation date is known. All time is always
 * "compared" with the period just before it, which lies before the store's first day and so holds
 * nothing: its changes come back null, never a comparison with dates the store didn't trade on.
 */
export function resolvePreset(
  preset: DatePreset,
  now: Date,
  timeZone: string,
  custom?: DateRange,
  compare: CompareChoice = { mode: "previous" },
  limits: RangeLimits = {},
): { range: DateRange; previous: Comparison } {
  const today = localDay(now, timeZone);
  const range = presetRange(preset, today, custom, limits);
  const previous = comparisonDays(range, preset, preset === "all" ? { mode: "previous" } : compare, today, limits);
  // Today isn't over: whatever it is compared with is counted up to this moment of its own last day.
  return { range, previous: range.to === today ? { ...previous, until: localTime(now, timeZone) } : previous };
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

/**
 * Charts draw a column (or point) per day up to this many days; a longer range (All time, or
 * custom dates over a year) is drawn a month at a time, where a day's column would be a sliver.
 */
export const DAILY_CHART_MAX_DAYS = 366;

/**
 * Day rows added up a month at a time, for a chart of a range too long to draw day by day
 * (DAILY_CHART_MAX_DAYS). Each month keeps the `day` of its first row (the range's own first day
 * for the month it starts in); each number is the sum of its days', null only when none of them
 * has one (a gap stays a gap, never a 0). Other fields keep the first day's value. Only for figures
 * that add up: a rate is worked out from the month's sums, never added.
 */
export function rowsByMonth<T extends { day: string }>(rows: readonly T[]): T[] {
  const months = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const key = row.day.slice(0, 7);
    const month = months.get(key);
    if (!month) {
      months.set(key, { ...row });
      continue;
    }
    for (const [k, v] of Object.entries(row)) {
      if (k === "day" || typeof v !== "number") continue;
      const sum = month[k];
      month[k] = typeof sum === "number" ? sum + v : v;
    }
  }
  return [...months.values()] as T[];
}

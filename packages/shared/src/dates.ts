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

export const DATE_PRESETS = ["today", "yesterday", "7d", "30d", "90d", "mtd", "lastmonth", "custom"] as const;
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

export type CustomRangeProblem = "incomplete" | "reversed" | "future" | "too_long";

/**
 * Why a custom range can't be reported on, or null when it can. The API refuses these and the
 * dashboard holds off asking for them, so both read this one definition.
 *
 * With `today` (the store's), a range may run past it, because it is reported only up to today
 * (see `clampCustomRange`), but it can't start after it, and its length is counted to today.
 */
export function customRangeProblem(r: { from?: string; to?: string }, today?: string): CustomRangeProblem | null {
  const { from, to } = r;
  if (!isDay(from) || !isDay(to) || from < MIN_CUSTOM_DAY || to < MIN_CUSTOM_DAY) return "incomplete";
  if (from > to) return "reversed";
  if (today && from > today) return "future";
  if (daysBetweenInclusive(from, clampCustomRange({ from, to }, today).to) > MAX_CUSTOM_DAYS) return "too_long";
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
  too_long: "Range too long",
};

/**
 * What the dates picked are compared with, as Shopify Analytics' second date chip offers:
 * - `previous`: the period just before them (the default): as many days, immediately before; last
 *   month against the whole month before it.
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
  too_long: "Comparison too long",
};

function presetRange(preset: DatePreset, today: string, custom?: DateRange): DateRange {
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
    case "mtd":
      return { from: `${today.slice(0, 8)}01`, to: today };
    case "lastmonth": {
      // The whole calendar month before this one.
      const lastDay = addDays(`${today.slice(0, 8)}01`, -1);
      return { from: `${lastDay.slice(0, 8)}01`, to: lastDay };
    }
    case "custom": {
      const problem = customRangeProblem(custom ?? {}, today);
      if (problem) throw new Error(CUSTOM_RANGE_ERROR[problem]);
      return clampCustomRange(custom!, today);
    }
  }
}

/** The whole days `range` is compared with (see COMPARE_MODES); throws on custom dates that can't be. */
function comparisonDays(range: DateRange, preset: DatePreset, compare: CompareChoice, today: string): DateRange {
  switch (compare.mode) {
    case "year":
      return { from: yearEarlier(range.from), to: yearEarlier(range.to) };
    case "custom": {
      const problem = customRangeProblem(compare, today);
      if (problem) throw new Error(CUSTOM_COMPARISON_ERROR[problem]);
      return clampCustomRange({ from: compare.from!, to: compare.to! }, today);
    }
    case "previous": {
      if (preset === "lastmonth") {
        // The whole month before, whatever its length.
        const prevLast = addDays(range.from, -1);
        return { from: `${prevLast.slice(0, 8)}01`, to: prevLast };
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
 */
export function resolvePreset(
  preset: DatePreset,
  now: Date,
  timeZone: string,
  custom?: DateRange,
  compare: CompareChoice = { mode: "previous" },
): { range: DateRange; previous: Comparison } {
  const today = localDay(now, timeZone);
  const range = presetRange(preset, today, custom);
  const previous = comparisonDays(range, preset, compare, today);
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
  else if (importedFrom) {
    const day = localDay(importedFrom, timeZone);
    from = localTime(importedFrom, timeZone) === "00:00:00" ? day : addDays(day, 1);
  }
  if (from === null || oldestOrderDay === null) return from ?? oldestOrderDay;
  return oldestOrderDay < from ? oldestOrderDay : from;
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

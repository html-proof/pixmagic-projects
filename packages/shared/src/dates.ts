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
 * The dates a range is compared with. While the range picked is still running (it ends on the
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

export function resolvePreset(
  preset: DatePreset,
  now: Date,
  timeZone: string,
  custom?: DateRange,
): { range: DateRange; previous: Comparison } {
  const today = localDay(now, timeZone);
  let range: DateRange;
  switch (preset) {
    case "today":
      range = { from: today, to: today };
      break;
    case "yesterday": {
      const y = addDays(today, -1);
      range = { from: y, to: y };
      break;
    }
    case "7d":
      range = { from: addDays(today, -6), to: today };
      break;
    case "30d":
      range = { from: addDays(today, -29), to: today };
      break;
    case "90d":
      range = { from: addDays(today, -89), to: today };
      break;
    case "mtd":
      range = { from: `${today.slice(0, 8)}01`, to: today };
      break;
    case "lastmonth": {
      // The whole calendar month before this one, against the whole month before that.
      const lastDay = addDays(`${today.slice(0, 8)}01`, -1);
      range = { from: `${lastDay.slice(0, 8)}01`, to: lastDay };
      const prevLast = addDays(range.from, -1);
      return { range, previous: { from: `${prevLast.slice(0, 8)}01`, to: prevLast } };
    }
    case "custom": {
      const problem = customRangeProblem(custom ?? {}, today);
      if (problem) throw new Error(CUSTOM_RANGE_ERROR[problem]);
      range = clampCustomRange(custom!, today);
      break;
    }
  }
  const len = daysBetweenInclusive(range.from, range.to);
  const previous = { from: addDays(range.from, -len), to: addDays(range.from, -1) };
  // Today isn't over: the period before is counted up to this moment of its own last day.
  return { range, previous: range.to === today ? { ...previous, until: localTime(now, timeZone) } : previous };
}

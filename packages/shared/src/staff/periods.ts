// Pay cycles, reporting ranges and chart buckets. All days are the organization's local days.
//
// Imported by the UI through `@app/shared/staff`: relative imports stay extensionless.

import { dayDiff, endOfMonth, isCalendarDay, shiftDay, startOfMonth, startOfWeek } from "./time";

export const PAY_CYCLES = ["daily", "weekly", "biweekly", "semimonthly", "monthly"] as const;
export type PayCycle = (typeof PAY_CYCLES)[number];

export const PAY_CYCLE_LABEL: Record<PayCycle, string> = {
  daily: "Daily",
  weekly: "Weekly",
  biweekly: "Every two weeks",
  semimonthly: "Twice a month (1st–15th, 16th–end)",
  monthly: "Monthly",
};

export interface DayRange {
  from: string;
  to: string;
}

const floorDiv = (a: number, b: number) => Math.floor(a / b);

/**
 * The pay period holding `day`. Weekly and two-weekly periods count from `anchor` (any day that
 * starts a period); semi-monthly periods are the 1st–15th and 16th–last; monthly ones are calendar months.
 */
export function periodContaining(day: string, cycle: PayCycle, anchor: string): DayRange {
  switch (cycle) {
    case "daily":
      return { from: day, to: day };
    case "weekly":
    case "biweekly": {
      const len = cycle === "weekly" ? 7 : 14;
      const from = shiftDay(anchor, floorDiv(dayDiff(anchor, day), len) * len);
      return { from, to: shiftDay(from, len - 1) };
    }
    case "semimonthly": {
      const d = Number(day.slice(8, 10));
      return d <= 15 ? { from: startOfMonth(day), to: `${day.slice(0, 8)}15` } : { from: `${day.slice(0, 8)}16`, to: endOfMonth(day) };
    }
    case "monthly":
      return { from: startOfMonth(day), to: endOfMonth(day) };
  }
}

/** The period right after `period`. */
export function nextPeriod(period: DayRange, cycle: PayCycle, anchor: string): DayRange {
  return periodContaining(shiftDay(period.to, 1), cycle, anchor);
}

/** The period right before `period`. */
export function previousPeriod(period: DayRange, cycle: PayCycle, anchor: string): DayRange {
  return periodContaining(shiftDay(period.from, -1), cycle, anchor);
}

/** Whether `range` is exactly one period of `cycle`. */
export function isWholePeriod(range: DayRange, cycle: PayCycle, anchor: string): boolean {
  const p = periodContaining(range.from, cycle, anchor);
  return p.from === range.from && p.to === range.to;
}

// ---------------------------------------------------------------------------------------------
// Reporting ranges
// ---------------------------------------------------------------------------------------------

export const RANGE_PRESETS = ["live", "today", "yesterday", "this_week", "last_week", "this_month", "last_month", "this_year", "last_year", "custom"] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];

export const RANGE_LABEL: Record<RangePreset, string> = {
  live: "Live",
  today: "Today",
  yesterday: "Yesterday",
  this_week: "This week",
  last_week: "Last week",
  this_month: "This month",
  last_month: "Last month",
  this_year: "This year",
  last_year: "Last year",
  custom: "Custom dates",
};

/** Longest custom range the reports accept (a little over three years, so year-on-year fits). */
export const MAX_RANGE_DAYS = 3 * 366 + 31;

export interface ResolvedRange {
  range: DayRange;
  /** The comparable range before it: the same length, or the same elapsed part of the previous week/month/year. */
  previous: DayRange;
  /** The range is still running (ends today), so it is compared with the same elapsed span before it. */
  inProgress: boolean;
}

export class ReportRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportRangeError";
  }
}

/** The day `day` would be in the previous month (31 Mar -> 28/29 Feb). */
function sameDayLastMonth(day: string): string {
  const prevMonthEnd = shiftDay(startOfMonth(day), -1);
  const want = Number(day.slice(8, 10));
  const max = Number(prevMonthEnd.slice(8, 10));
  return `${prevMonthEnd.slice(0, 8)}${String(Math.min(want, max)).padStart(2, "0")}`;
}

function sameDayLastYear(day: string): string {
  const y = Number(day.slice(0, 4)) - 1;
  const md = day.slice(5);
  const candidate = `${y}-${md}`;
  return isCalendarDay(candidate) ? candidate : `${y}-02-28`;
}

/**
 * Resolve a preset against the organization's `today`. "This week/month/year" run to today and are
 * compared with the same elapsed span of the previous one, so a Wednesday is never set against a
 * whole week. Custom ranges are compared with the same number of days just before them.
 */
export function resolveRange(preset: RangePreset, today: string, weekStartsOn: number, custom?: Partial<DayRange>): ResolvedRange {
  const same = (range: DayRange, previous: DayRange, inProgress = false): ResolvedRange => ({ range, previous, inProgress });
  switch (preset) {
    case "live":
    case "today":
      return same({ from: today, to: today }, { from: shiftDay(today, -1), to: shiftDay(today, -1) }, true);
    case "yesterday": {
      const y = shiftDay(today, -1);
      return same({ from: y, to: y }, { from: shiftDay(y, -1), to: shiftDay(y, -1) });
    }
    case "this_week": {
      const from = startOfWeek(today, weekStartsOn);
      const elapsed = dayDiff(from, today);
      return same({ from, to: today }, { from: shiftDay(from, -7), to: shiftDay(from, elapsed - 7) }, true);
    }
    case "last_week": {
      const from = shiftDay(startOfWeek(today, weekStartsOn), -7);
      return same({ from, to: shiftDay(from, 6) }, { from: shiftDay(from, -7), to: shiftDay(from, -1) });
    }
    case "this_month": {
      const from = startOfMonth(today);
      const prevFrom = startOfMonth(shiftDay(from, -1));
      return same({ from, to: today }, { from: prevFrom, to: sameDayLastMonth(today) }, true);
    }
    case "last_month": {
      const to = shiftDay(startOfMonth(today), -1);
      const from = startOfMonth(to);
      const prevTo = shiftDay(from, -1);
      return same({ from, to }, { from: startOfMonth(prevTo), to: prevTo });
    }
    case "this_year": {
      const from = `${today.slice(0, 4)}-01-01`;
      const prevYear = Number(today.slice(0, 4)) - 1;
      return same({ from, to: today }, { from: `${prevYear}-01-01`, to: sameDayLastYear(today) }, true);
    }
    case "last_year": {
      const y = Number(today.slice(0, 4)) - 1;
      return same({ from: `${y}-01-01`, to: `${y}-12-31` }, { from: `${y - 1}-01-01`, to: `${y - 1}-12-31` });
    }
    case "custom": {
      const from = custom?.from;
      const to = custom?.to;
      if (!isCalendarDay(from) || !isCalendarDay(to)) throw new ReportRangeError("Choose a start and an end date");
      if (from > to) throw new ReportRangeError("The start date is after the end date");
      const len = dayDiff(from, to) + 1;
      if (len > MAX_RANGE_DAYS) throw new ReportRangeError("That range is too long. Choose three years or less.");
      return same({ from, to }, { from: shiftDay(from, -len), to: shiftDay(from, -1) }, to >= today);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Chart buckets
// ---------------------------------------------------------------------------------------------

export const GRANULARITIES = ["hour", "day", "week", "month", "quarter", "year"] as const;
export type Granularity = (typeof GRANULARITIES)[number];

/** The bucket a day falls in ("2026-10-12" for a week starting then, "2026-10", "2026-Q4", "2026"). */
export function bucketOf(day: string, granularity: Exclude<Granularity, "hour">, weekStartsOn: number): string {
  switch (granularity) {
    case "day":
      return day;
    case "week":
      return startOfWeek(day, weekStartsOn);
    case "month":
      return day.slice(0, 7);
    case "quarter":
      return `${day.slice(0, 4)}-Q${Math.floor((Number(day.slice(5, 7)) - 1) / 3) + 1}`;
    case "year":
      return day.slice(0, 4);
  }
}

/** Every bucket key from `from` to `to`, in order. Hour buckets are "YYYY-MM-DDTHH". */
export function bucketsBetween(range: DayRange, granularity: Granularity, weekStartsOn: number): string[] {
  const out: string[] = [];
  if (granularity === "hour") {
    for (let d = range.from; d <= range.to; d = shiftDay(d, 1)) {
      for (let h = 0; h < 24; h++) out.push(`${d}T${String(h).padStart(2, "0")}`);
    }
    return out;
  }
  let last = "";
  for (let d = range.from; d <= range.to; d = shiftDay(d, 1)) {
    const b = bucketOf(d, granularity, weekStartsOn);
    if (b !== last) out.push(b);
    last = b;
  }
  return out;
}

/** The most readable bucket size for a range: hours for a day, days for a month, months for a year. */
export function defaultGranularity(range: DayRange): Granularity {
  const days = dayDiff(range.from, range.to) + 1;
  if (days <= 2) return "hour";
  if (days <= 45) return "day";
  if (days <= 190) return "week";
  if (days <= 800) return "month";
  return "quarter";
}

/**
 * Bucket sizes a range can be shown in: hours up to a week and days up to about a year (beyond
 * that a chart has too many bars to read); weeks, months, quarters and years always (a short
 * range is then simply one bucket).
 */
export function allowedGranularities(range: DayRange): Granularity[] {
  const days = dayDiff(range.from, range.to) + 1;
  return GRANULARITIES.filter((g) => (g === "hour" ? days <= 7 : g === "day" ? days <= 400 : true));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A bucket key in words: "14 Oct", "Week of 12 Oct", "Oct 2026", "Q4 2026", "2026", "14 Oct 09:00". */
export function bucketLabel(key: string, granularity: Granularity): string {
  const dm = (day: string) => `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]}`;
  switch (granularity) {
    case "hour":
      return `${dm(key.slice(0, 10))} ${key.slice(11, 13)}:00`;
    case "day":
      return dm(key);
    case "week":
      return `Week of ${dm(key)}`;
    case "month":
      return `${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;
    case "quarter":
      return `${key.slice(5)} ${key.slice(0, 4)}`;
    case "year":
      return key;
  }
}

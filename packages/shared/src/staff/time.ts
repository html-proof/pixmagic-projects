// Time-zone arithmetic for attendance and pay, without a date library.
//
// Instants are epoch milliseconds (or seconds where noted); calendar days are "YYYY-MM-DD" strings
// in an IANA zone. Every rule that says "day", "week" or "hour" means the organization's local one,
// so a shift is split where the organization's calendar turns over, daylight saving included.
//
// Imported by the UI through `@app/shared/staff`: relative imports stay extensionless.

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export interface WallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Whether `tz` is an IANA time zone this runtime knows. */
export function isTimeZone(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

/** The local wall-clock time of instant `ms` in `timeZone`. */
export function wallTime(ms: number, timeZone: string): WallTime {
  const out: WallTime = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
  for (const p of formatter(timeZone).formatToParts(new Date(ms))) {
    if (p.type in out) out[p.type as keyof WallTime] = Number(p.value);
  }
  return out;
}

/** Offset of `timeZone` from UTC at instant `ms`, in minutes (Sydney summer +660, New York winter -300). */
export function tzOffsetMinutes(ms: number, timeZone: string): number {
  const w = wallTime(ms, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000);
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** The local calendar day of instant `ms`. */
export function localDayOf(ms: number, timeZone: string): string {
  const w = wallTime(ms, timeZone);
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}`;
}

/** Local "HH:MM" of instant `ms`. */
export function localTimeOf(ms: number, timeZone: string): string {
  const w = wallTime(ms, timeZone);
  return `${pad(w.hour)}:${pad(w.minute)}`;
}

/** `day` moved by `n` calendar days. */
export function shiftDay(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Days from `a` to `b` (positive when b is later). */
export function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekdayOf(day: string): number {
  return new Date(`${day}T00:00:00Z`).getUTCDay();
}

/** The first day of the week holding `day`, for weeks starting on `weekStartsOn` (0 = Sunday). */
export function startOfWeek(day: string, weekStartsOn: number): string {
  return shiftDay(day, -((weekdayOf(day) - weekStartsOn + 7) % 7));
}

export function startOfMonth(day: string): string {
  return `${day.slice(0, 8)}01`;
}

export function endOfMonth(day: string): string {
  const [y, m] = day.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${day.slice(0, 8)}${pad(last)}`;
}

/** Days from `from` to `to`, both included. */
export function daysInclusive(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = shiftDay(d, 1)) out.push(d);
  return out;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar day written YYYY-MM-DD. */
export function isCalendarDay(s: unknown): s is string {
  if (typeof s !== "string" || !DAY_RE.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
}

/**
 * The instant a local wall-clock time happens in `timeZone`, resolved the way Temporal's
 * "compatible" option does: a time that happens twice (clocks going back) is its first occurrence,
 * and a time that doesn't exist (clocks going forward) is moved forward by the gap, so 02:30 on the
 * day New York springs forward is 03:30.
 */
export function zonedTimeToUtc(day: string, hour: number, minute: number, timeZone: string): number {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const wall = Date.UTC(y, m - 1, d, hour, minute);
  // No real zone changes its offset twice within 30 hours, so these are the offsets before and
  // after any transition near this wall time.
  const before = tzOffsetMinutes(wall - 15 * 3_600_000, timeZone);
  const after = tzOffsetMinutes(wall + 15 * 3_600_000, timeZone);
  const tBefore = wall - before * 60_000;
  if (before === after) return tBefore;
  const tAfter = wall - after * 60_000;
  const matches = (t: number) => {
    const w = wallTime(t, timeZone);
    return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute) === wall;
  };
  const a = matches(tBefore);
  const b = matches(tAfter);
  if (a && b) return Math.min(tBefore, tAfter);
  if (a) return tBefore;
  if (b) return tAfter;
  return tBefore;
}

const dayStarts = new Map<string, number>();

/** The first instant of local `day` in `timeZone` (not always 00:00 where midnight is skipped). */
export function startOfLocalDay(day: string, timeZone: string): number {
  const key = `${timeZone}|${day}`;
  let t = dayStarts.get(key);
  if (t === undefined) {
    t = zonedTimeToUtc(day, 0, 0, timeZone);
    if (dayStarts.size > 20_000) dayStarts.clear();
    dayStarts.set(key, t);
  }
  return t;
}

/** The first instant after local `day` (its end, exclusive). */
export function endOfLocalDay(day: string, timeZone: string): number {
  return startOfLocalDay(shiftDay(day, 1), timeZone);
}

/** Instants [start, end) covering the local days `from`..`to` inclusive. */
export function localRangeToUtc(from: string, to: string, timeZone: string): { start: number; end: number } {
  return { start: startOfLocalDay(from, timeZone), end: endOfLocalDay(to, timeZone) };
}

/** The next local hour boundary strictly after `ms` (zones with :30 and :45 offsets included). */
export function nextLocalHour(ms: number, timeZone: string): number {
  const w = wallTime(ms, timeZone);
  const into = (w.minute * 60 + w.second) * 1000 + (((ms % 1000) + 1000) % 1000);
  return ms - into + 3_600_000;
}

/** Local hour (0-23) of instant `ms`. */
export function localHourOf(ms: number, timeZone: string): number {
  return wallTime(ms, timeZone).hour;
}

/** Whole hours and minutes, for people: 7h 45m, 0h 05m. */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${pad(m)}m`;
}

/** Hours as a decimal with two places, for tables and exports: 7.75. */
export function hoursDecimal(seconds: number): string {
  // Integer arithmetic: hundredths of an hour, rounded half up.
  const hundredths = Math.floor((Math.max(0, seconds) * 100 + 1800) / 3600);
  return `${Math.floor(hundredths / 100)}.${pad(hundredths % 100)}`;
}

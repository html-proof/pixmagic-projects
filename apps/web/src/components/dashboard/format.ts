/** Display helpers shared by the dashboard cards. Money/number/percent formatting lives in lib/api. */

/** "2026-03-08" → "8 Mar 2026" (a calendar day: formatted without shifting time zones). */
export function fmtDay(day: string | null | undefined, opts: { year?: boolean } = {}): string {
  if (!day) return "—";
  const d = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return day;
  return new Intl.DateTimeFormat(undefined, {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    ...(opts.year === false ? {} : { year: "numeric" }),
  }).format(d);
}

/**
 * "1–9 Mar", "28 Feb – 8 Mar", with the year only when the span crosses one (in the viewer's
 * order), or always with `year`: "14 Mar 2026", "1–7 Mar 2026".
 */
export function fmtSpan(from: string, to: string, opts: { year?: boolean } = {}): string {
  const year = opts.year || from.slice(0, 4) !== to.slice(0, 4);
  const f = new Intl.DateTimeFormat(undefined, { timeZone: "UTC", day: "numeric", month: "short", ...(year ? { year: "numeric" } : {}) });
  try {
    return f.formatRange(new Date(`${from}T00:00:00Z`), new Date(`${to}T00:00:00Z`));
  } catch {
    return `${fmtDay(from, { year })} – ${fmtDay(to, { year })}`;
  }
}

/** "Wed" — the short weekday of a calendar day, in the viewer's language. */
export function fmtWeekday(day: string): string {
  return new Intl.DateTimeFormat(undefined, { timeZone: "UTC", weekday: "short" }).format(new Date(`${day}T00:00:00Z`));
}

/** A weekday by its number, Monday = 0 … Sunday = 6 (as `weekdayOf` counts), in the viewer's language: "Monday" / "Mon". */
export function weekdayName(i: number, style: "long" | "short"): string {
  // 2026-01-05 is a Monday.
  return new Intl.DateTimeFormat(undefined, { weekday: style, timeZone: "UTC" }).format(new Date(Date.UTC(2026, 0, 5 + i)));
}

/** The seven weekday names, Monday first. */
export const weekdayNames = (style: "long" | "short"): string[] => Array.from({ length: 7 }, (_, i) => weekdayName(i, style));

/** "Wed, 24 Jun 2026". */
export function fmtLongDay(day: string): string {
  return new Intl.DateTimeFormat(undefined, { timeZone: "UTC", weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(new Date(`${day}T00:00:00Z`));
}

/** "2026-06" → "June" (or "Jun" short, or "June 2026" with the year). */
export function fmtMonth(month: string, opts: { short?: boolean; year?: boolean } = {}): string {
  return new Intl.DateTimeFormat(undefined, { timeZone: "UTC", month: opts.short ? "short" : "long", ...(opts.year ? { year: "numeric" } : {}) }).format(
    new Date(`${month}-01T00:00:00Z`),
  );
}

/** Money without cents, for labels on chart marks: "A$1,751". */
export function fmtMoneyWhole(n: number, currency: string): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency, minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n);
}

/** Money for chart axes: "A$3.2K". */
export function fmtMoneyCompact(n: number, currency: string): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency, notation: "compact", minimumFractionDigits: 0, maximumFractionDigits: 1 }).format(n);
}

/** "8 Mar 2026" for a single day, "1 Mar 2026 – 8 Mar 2026" for a span. */
export function fmtRange(from: string, to: string): string {
  return from === to ? fmtDay(from) : `${fmtDay(from)} – ${fmtDay(to)}`;
}

/** A store-local time of day, "16:44:12" → "4:44 pm" (in the viewer's language). */
export function fmtClock(time: string): string {
  const [h = 0, m = 0] = time.split(":").map(Number);
  return new Intl.DateTimeFormat(undefined, { timeZone: "UTC", hour: "numeric", minute: "2-digit" }).format(new Date(Date.UTC(2026, 0, 1, h, m)));
}

/**
 * The dates the numbers are compared with: "16 Oct 2026 until 4:44 pm" while the dates picked are
 * still running (their comparison stops at the same time of day), otherwise as `fmtRange`.
 */
export function fmtComparison(c: { from: string; to: string; until?: string }): string {
  return c.until ? `${fmtRange(c.from, c.to)} until ${fmtClock(c.until)}` : fmtRange(c.from, c.to);
}

/** An instant shown in the store's time zone, e.g. "8 Mar, 3:30 pm". */
export function fmtDateTime(iso: string, timeZone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone, day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(d);
  } catch {
    return d.toLocaleString();
  }
}

/** "3 minutes ago", "yesterday", … for sync timestamps. */
export function fmtRelative(iso: string | null | undefined, now = Date.now()): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const s = Math.round((t - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const abs = Math.abs(s);
  if (abs < 60) return rtf.format(s, "second");
  if (abs < 3600) return rtf.format(Math.round(s / 60), "minute");
  if (abs < 86_400) return rtf.format(Math.round(s / 3600), "hour");
  return rtf.format(Math.round(s / 86_400), "day");
}

/** Hour of the day (0–23) as a short clock label in the viewer's locale: "3 pm" / "15". */
export function hourLabel(hour: number): string {
  return new Intl.DateTimeFormat(undefined, { timeZone: "UTC", hour: "numeric" }).format(new Date(Date.UTC(2026, 0, 1, hour)));
}

/** One hour of the day as a time range in the viewer's locale: "8:00 – 9:00 pm" / "20:00–21:00". */
export function hourRange(hour: number): string {
  const f = new Intl.DateTimeFormat(undefined, { timeZone: "UTC", hour: "numeric", minute: "2-digit" });
  const start = new Date(Date.UTC(2026, 0, 1, hour));
  const end = new Date(Date.UTC(2026, 0, 1, hour + 1));
  try {
    return f.formatRange(start, end);
  } catch {
    return `${f.format(start)} – ${f.format(end)}`;
  }
}

/** Hours to a friendly duration: "under 1 hour", "18 hours", "2.5 days". */
export function fmtDuration(hours: number | null | undefined): string {
  if (hours === null || hours === undefined) return "—";
  if (hours < 1) return "under 1 hour";
  if (hours < 48) {
    const h = Math.round(hours);
    return `${h} hour${h === 1 ? "" : "s"}`;
  }
  const days = Math.round((hours / 24) * 10) / 10;
  return `${days} days`;
}

/** "partially_fulfilled" → "Partially fulfilled". */
export function humanize(value: string | null | undefined): string {
  if (!value) return "Unknown";
  const s = value.replace(/[_-]+/g, " ").trim().toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export const plural = (n: number, one: string, many = `${one}s`) => `${new Intl.NumberFormat().format(n)} ${n === 1 ? one : many}`;

/** A multiple such as return on ad spend: "3.42×", or `empty` when there is nothing to divide by. */
export const fmtTimes = (n: number | null, empty = "—") => (n === null ? empty : `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(n)}×`);

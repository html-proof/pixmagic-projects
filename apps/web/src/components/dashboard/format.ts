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

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

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetweenInclusive(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

export const DATE_PRESETS = ["today", "yesterday", "7d", "30d", "90d", "mtd", "custom"] as const;
export type DatePreset = (typeof DATE_PRESETS)[number];

export interface DateRange {
  from: string;
  to: string;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function resolvePreset(
  preset: DatePreset,
  now: Date,
  timeZone: string,
  custom?: DateRange,
): { range: DateRange; previous: DateRange } {
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
    case "custom":
      if (!custom || !DAY_RE.test(custom.from) || !DAY_RE.test(custom.to) || custom.from > custom.to) {
        throw new Error("Invalid custom range");
      }
      if (daysBetweenInclusive(custom.from, custom.to) > 366) throw new Error("Range too long");
      range = custom;
      break;
  }
  const len = daysBetweenInclusive(range.from, range.to);
  const previous = { from: addDays(range.from, -len), to: addDays(range.from, -1) };
  return { range, previous };
}

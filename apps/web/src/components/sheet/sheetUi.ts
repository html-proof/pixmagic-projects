import type { BusinessEventKind } from "@app/shared/businessEvents";
import type { SheetColumn, SheetFigure, SheetFormat } from "@app/shared/sheet";
import { fmtDay, fmtMonth, fmtSpan, fmtWeekday } from "@/components/dashboard/format";
import { fmtMoney, fmtNum } from "@/lib/api";

/** Each kind of business event's colour: a chip (tint, text, edge) and a dot. */
export const EVENT_CHIP: Record<BusinessEventKind, string> = {
  sale: "border-rose/30 bg-rose/12 text-rose",
  campaign: "border-info/30 bg-info/12 text-info",
  launch: "border-violet/30 bg-violet/12 text-violet",
  email: "border-accent/30 bg-accent/12 text-accent",
  holiday: "border-warn/30 bg-warn/12 text-warn",
  stock: "border-danger/30 bg-danger/12 text-danger",
  website: "border-good/30 bg-good/12 text-good",
  other: "border-border bg-bg text-muted",
};

export const EVENT_DOT: Record<BusinessEventKind, string> = {
  sale: "bg-rose",
  campaign: "bg-info",
  launch: "bg-violet",
  email: "bg-accent",
  holiday: "bg-warn",
  stock: "bg-danger",
  website: "bg-good",
  other: "bg-muted",
};

const pct = new Intl.NumberFormat(undefined, { style: "percent", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dec = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** A figure as the sheet shows it; "—" when it isn't known (null) or not seen (undefined). */
export function fmtFigure(n: SheetFigure, format: SheetFormat, currency: string): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  switch (format) {
    case "money":
      return fmtMoney(n, currency);
    case "count":
      return fmtNum(n);
    case "percent":
      return pct.format(n);
    case "decimal":
      return dec.format(n);
    case "times":
      return `${dec.format(n)}×`;
  }
}

/** A figure for a spreadsheet: a plain number (cents for money, "12.34%" for a share), empty when not known. */
export function csvFigure(n: SheetFigure, format: SheetFormat): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "";
  if (format === "percent") return `${(n * 100).toFixed(2)}%`;
  if (format === "count") return String(Math.round(n));
  return n.toFixed(2);
}

/** A column's heading: "Tue 1", "1–6 Sep", "Sep 2026". `withMonth` adds the month to a day. */
export function columnLabel(c: Pick<SheetColumn, "grain" | "key" | "from" | "to">, withMonth = false): { top: string; bottom: string } {
  if (c.grain === "day") return { top: fmtWeekday(c.key), bottom: withMonth ? fmtDay(c.key, { year: false }) : String(Number(c.key.slice(8))) };
  if (c.grain === "week") return { top: "Week of", bottom: fmtSpan(c.from, c.to) };
  return { top: c.key.slice(0, 4), bottom: fmtMonth(c.key, { short: true }) };
}

/** A column's dates in words, for a tooltip or a label: "Tue, 1 Sep 2026", "1–6 Sep 2026". */
export function columnDates(c: Pick<SheetColumn, "from" | "to">): string {
  return c.from === c.to ? fmtDay(c.from) : fmtSpan(c.from, c.to, { year: true });
}

/** One CSV field, quoted when it must be; text a spreadsheet would run as a formula is kept as text. */
export function csvField(v: string): string {
  const safe = /^[=+\-@\t\r]/.test(v) && !/^-?\d/.test(v) ? `'${v}` : v;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

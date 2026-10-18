/** Wording the Timesheets screens share: shift times, counts, the locked-hours help, request status. */
import { localDayOf } from "@app/shared/staff";
import { fmtDateTime, fmtTime } from "@/lib/staff";

export const LOCKED_HELP = "These hours are in approved payroll, so they can't be changed. Add an adjustment to the next payroll instead.";

export const REQUEST_STATUS: Record<string, { tone: "warn" | "good" | "danger" | "neutral"; label: string }> = {
  pending: { tone: "warn", label: "Waiting for review" },
  approved: { tone: "good", label: "Approved" },
  rejected: { tone: "danger", label: "Rejected" },
  cancelled: { tone: "neutral", label: "Cancelled" },
};

/** "Tue 14 Oct, 9:00 AM – 5:30 PM" (the end gets its own date when it falls on another day). */
export function fmtRange(start: string | null, end: string | null, tz: string, openText = "still clocked in") {
  if (!start) return "—";
  if (!end) return `${fmtDateTime(start, tz)} – ${openText}`;
  const sameDay = localDayOf(Date.parse(start), tz) === localDayOf(Date.parse(end), tz);
  return `${fmtDateTime(start, tz)} – ${sameDay ? fmtTime(end, tz) : fmtDateTime(end, tz)}`;
}

export const plural = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`);

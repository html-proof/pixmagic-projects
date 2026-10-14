// Attendance vocabulary and rules shared by the API and the UI: statuses, flags, labels.
//
// Imported by the UI through `@app/shared/staff`: relative imports stay extensionless.

import { localDayOf } from "./time";

export const EMPLOYMENT_TYPES = ["full_time", "part_time", "casual", "contract"] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];
export const EMPLOYMENT_TYPE_LABEL: Record<EmploymentType, string> = {
  full_time: "Full-time",
  part_time: "Part-time",
  casual: "Casual",
  contract: "Contract",
};

export const EMPLOYEE_STATUSES = ["active", "on_leave", "inactive"] as const;
export type EmployeeStatus = (typeof EMPLOYEE_STATUSES)[number];
export const EMPLOYEE_STATUS_LABEL: Record<EmployeeStatus, string> = {
  active: "Active",
  on_leave: "On leave",
  inactive: "Deactivated",
};

export const BREAK_KINDS = ["rest", "meal"] as const;
export type BreakKind = (typeof BREAK_KINDS)[number];
export const BREAK_KIND_LABEL: Record<BreakKind, string> = { rest: "Short break", meal: "Meal break" };

export const APPROVAL_STATUSES = ["pending", "approved", "rejected"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];
export const APPROVAL_STATUS_LABEL: Record<ApprovalStatus, string> = { pending: "Waiting for review", approved: "Approved", rejected: "Rejected" };

export const SESSION_FLAGS = [
  "late",
  "early_departure",
  "unscheduled",
  "overnight",
  "stale",
  "long_break",
  "too_many_breaks",
  "corrected",
  "manual",
  "closed_by_manager",
  "holiday",
] as const;
export type SessionFlag = (typeof SESSION_FLAGS)[number];
export const SESSION_FLAG_LABEL: Record<SessionFlag, string> = {
  late: "Late start",
  early_departure: "Left early",
  unscheduled: "Not on the schedule",
  overnight: "Overnight shift",
  stale: "Forgot to clock out?",
  long_break: "Long break",
  too_many_breaks: "More breaks than allowed",
  corrected: "Corrected",
  manual: "Added by a manager",
  closed_by_manager: "Clock-out set by a manager",
  holiday: "Public holiday",
};

/** Flags that need someone to look before the hours can be paid. */
export const REVIEW_FLAGS: readonly SessionFlag[] = ["stale", "long_break", "too_many_breaks"];

export const LIVE_STATUSES = ["working", "on_break", "clocked_out", "absent", "pending_review", "not_in_yet", "off_today", "on_leave"] as const;
export type LiveStatus = (typeof LIVE_STATUSES)[number];
export const LIVE_STATUS_LABEL: Record<LiveStatus, string> = {
  working: "Working",
  on_break: "On break",
  clocked_out: "Clocked out",
  absent: "Absent",
  pending_review: "Pending review",
  not_in_yet: "Not in yet",
  off_today: "Off today",
  on_leave: "On leave",
};

export const CORRECTION_STATUSES = ["pending", "approved", "rejected", "cancelled"] as const;
export type CorrectionStatus = (typeof CORRECTION_STATUSES)[number];

export const PAYROLL_STATUSES = [
  "draft",
  "pending_approval",
  "approved",
  "partially_paid",
  "paid",
  "cancelled",
  "correction_required",
  "payment_failed",
  "reversed",
] as const;
export type PayrollStatus = (typeof PAYROLL_STATUSES)[number];
export const PAYROLL_STATUS_LABEL: Record<PayrollStatus, string> = {
  draft: "Draft",
  pending_approval: "Waiting for approval",
  approved: "Approved",
  partially_paid: "Partly paid",
  paid: "Paid",
  cancelled: "Cancelled",
  correction_required: "Needs changes",
  payment_failed: "Payment failed",
  reversed: "Reversed",
};
/** Statuses whose figures are final (locked) and can be paid. */
export const PAYABLE_STATUSES: readonly PayrollStatus[] = ["approved", "partially_paid", "paid", "payment_failed"];
/** Statuses that can still be recalculated and adjusted. */
export const EDITABLE_STATUSES: readonly PayrollStatus[] = ["draft", "correction_required"];

export const PAYMENT_METHODS = ["bank_transfer", "cash", "cheque", "external_provider", "other"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  bank_transfer: "Bank transfer",
  cash: "Cash",
  cheque: "Cheque",
  external_provider: "Payment provider",
  other: "Other",
};

export const PAYMENT_STATUSES = ["completed", "failed", "reversed"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
export const PAYMENT_STATUS_LABEL: Record<PaymentStatus, string> = { completed: "Recorded", failed: "Failed", reversed: "Reversed" };

/** Days of the week as stored (0 = Sunday). */
export const WEEKDAY_LABEL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export interface BreakRules {
  maxBreaksPerShift: number | null;
  maxBreakMinutes: number | null;
}

export interface FlagInput {
  clockInAt: number;
  clockOutAt: number | null;
  schedule: { startsAt: number; endsAt: number } | null;
  breaks: ReadonlyArray<{ startAt: number; endAt: number | null }>;
  breakRules: BreakRules;
  lateGraceMinutes: number;
  staleAfterHours: number;
  timeZone: string;
  holidays?: ReadonlySet<string>;
  nowMs: number;
}

/** What is unusual about a session, from its times alone (corrections add their own flags). */
export function computeFlags(s: FlagInput): SessionFlag[] {
  const flags: SessionFlag[] = [];
  const grace = s.lateGraceMinutes * 60_000;
  if (s.schedule) {
    if (s.clockInAt > s.schedule.startsAt + grace) flags.push("late");
    if (s.clockOutAt !== null && s.clockOutAt < s.schedule.endsAt - grace) flags.push("early_departure");
  } else {
    flags.push("unscheduled");
  }
  const end = s.clockOutAt ?? s.nowMs;
  if (localDayOf(s.clockInAt, s.timeZone) !== localDayOf(Math.max(s.clockInAt, end - 1), s.timeZone)) flags.push("overnight");
  if (s.clockOutAt === null && s.nowMs - s.clockInAt > s.staleAfterHours * 3_600_000) flags.push("stale");
  if (s.breakRules.maxBreaksPerShift !== null && s.breaks.length > s.breakRules.maxBreaksPerShift) flags.push("too_many_breaks");
  if (s.breakRules.maxBreakMinutes !== null) {
    const limit = s.breakRules.maxBreakMinutes * 60_000;
    if (s.breaks.some((b) => (b.endAt ?? s.nowMs) - b.startAt > limit)) flags.push("long_break");
  }
  if (s.holidays?.has(localDayOf(s.clockInAt, s.timeZone))) flags.push("holiday");
  return flags;
}

/**
 * An employee's status on the live board. `today` lists their sessions that touch the local day,
 * `schedule` their shifts that day.
 */
export function liveStatus(input: {
  employeeStatus: EmployeeStatus;
  openSession: { clockInAt: number; onBreak: boolean } | null;
  closedToday: number;
  needsReview: boolean;
  scheduledToday: ReadonlyArray<{ startsAt: number; endsAt: number }>;
  lateGraceMinutes: number;
  staleAfterHours: number;
  isHoliday: boolean;
  nowMs: number;
}): LiveStatus {
  if (input.openSession) {
    if (input.nowMs - input.openSession.clockInAt > input.staleAfterHours * 3_600_000) return "pending_review";
    return input.openSession.onBreak ? "on_break" : "working";
  }
  if (input.needsReview) return "pending_review";
  if (input.closedToday > 0) return "clocked_out";
  if (input.employeeStatus === "on_leave") return "on_leave";
  if (!input.scheduledToday.length || input.isHoliday) return "off_today";
  const grace = input.lateGraceMinutes * 60_000;
  return input.scheduledToday.some((s) => input.nowMs > s.startsAt + grace) ? "absent" : "not_in_yet";
}

"use client";
import { useMemo } from "react";
import { formatDuration, formatMoney, hoursDecimal, staffAccess, staffCan, type StaffPermission } from "@app/shared/staff";
import { useApp } from "@/components/AppContext";
import { api, ApiError } from "./api";

// ---------------------------------------------------------------------------------------------
// Staff Management in the UI: the API base for the current workspace, what this member may do,
// and the few formatters every staff page uses. Rules live in @app/shared/staff and the API; the
// pages only format and arrange what the API returns.
// ---------------------------------------------------------------------------------------------

/** The current workspace's staff API base and permissions (same matrix the API enforces). */
export function useStaff() {
  const { workspace, me } = useApp();
  return useMemo(() => {
    const access = staffAccess(workspace.role, workspace.staffRole ?? null, workspace.permissions);
    return {
      ws: workspace.id,
      workspaceName: workspace.name,
      base: `/workspaces/${workspace.id}/staff`,
      access,
      can: (p: StaffPermission) => staffCan(access, p),
      userId: me.user.id,
    };
  }, [workspace, me.user.id]);
}

/** A fresh Idempotency-Key for one user action (a click, one submission of a form). */
export function newKey(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
  }
}

/** POST with an Idempotency-Key header. */
export const postIdempotent = <T>(path: string, body: unknown, key: string) => api<T>(path, { method: "POST", body, headers: { "idempotency-key": key } });

/** "7h 45m". */
export const fmtHours = (seconds: number | null | undefined) => (seconds === null || seconds === undefined ? "—" : formatDuration(seconds));
/** "7.75" (for tables people add up). */
export const fmtHoursDec = (seconds: number | null | undefined) => (seconds === null || seconds === undefined ? "—" : hoursDecimal(seconds));
/** Money from the API's decimal strings ("160.00"), formatted without float arithmetic. */
export const fmtMoney = (amount: string | null | undefined, currency: string | null | undefined) => (amount === null || amount === undefined || !currency ? "—" : formatMoney(amount, currency));

/** A time of day in the organization's zone: "9:05 AM". */
export function fmtTime(iso: string | Date | null | undefined, timeZone: string) {
  if (!iso) return "—";
  return new Intl.DateTimeFormat(undefined, { timeZone, hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

/** "Tue 14 Oct, 9:05 AM" in the organization's zone. */
export function fmtDateTime(iso: string | Date | null | undefined, timeZone: string) {
  if (!iso) return "—";
  return new Intl.DateTimeFormat(undefined, { timeZone, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

/** A local day "2026-10-14" as "Tue 14 Oct 2026". */
export function fmtDay(day: string | null | undefined, opts: { weekday?: boolean; year?: boolean } = { weekday: true, year: true }) {
  if (!day) return "—";
  return new Intl.DateTimeFormat(undefined, { timeZone: "UTC", weekday: opts.weekday ? "short" : undefined, day: "numeric", month: "short", year: opts.year ? "numeric" : undefined }).format(new Date(`${day}T00:00:00Z`));
}

export const fmtSpan = (from: string, to: string) => (from === to ? fmtDay(from) : `${fmtDay(from, { weekday: false, year: from.slice(0, 4) !== to.slice(0, 4) })} – ${fmtDay(to, { weekday: false, year: true })}`);

/** An instant as the value of an <input type="datetime-local"> in `timeZone`. */
export function toLocalInput(iso: string | Date | null | undefined, timeZone: string): string {
  if (!iso) return "";
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso));
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}`;
}

/** The value of an <input type="datetime-local"> read as a wall time in `timeZone`, as an ISO instant. */
export function fromLocalInput(value: string, timeZone: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number) as [number, number, number, number, number, number];
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  // Offset of the zone at that wall time (two passes settle daylight-saving edges).
  const offset = (t: number) => {
    const p = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(t));
    const n = (k: string) => Number(p.find((x) => x.type === k)?.value);
    return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second")) - t;
  };
  let t = wall - offset(wall);
  t = wall - offset(t);
  return new Date(t).toISOString();
}

/** Save a file from one of the API's one-time download links, reporting failures as an ApiError. */
export async function downloadFrom(url: string): Promise<void> {
  const res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok) {
    let message = "The download didn't work. Please try again.";
    try {
      message = ((await res.json()) as { message?: string }).message ?? message;
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, "download_failed", message);
  }
  const blob = await res.blob();
  const cd = res.headers.get("content-disposition") ?? "";
  const name = decodeURIComponent(/filename\*=UTF-8''([^;]+)/.exec(cd)?.[1] ?? /filename="([^"]+)"/.exec(cd)?.[1] ?? "download");
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(href), 10_000);
}

/** Ask the API for a download link (one use, five minutes), then save the file. */
export async function exportFile(base: string, payload: unknown) {
  const { url } = await api<{ url: string }>(`${base}/exports`, { method: "POST", body: payload });
  await downloadFrom(url);
}

/** Shared response shapes. */
export interface EmployeeRow {
  id: string;
  employeeNumber: string;
  fullName: string;
  email: string;
  phone: string | null;
  jobTitle: string;
  department: { id: string; name: string } | null;
  employmentType: "full_time" | "part_time" | "casual" | "contract";
  joinedOn: string;
  currency: string;
  standardWeeklyMinutes: number;
  workingDays: number[];
  manager: { userId: string; name: string } | null;
  overtimePolicyId: string | null;
  breakPolicyId: string | null;
  timezone: string;
  status: "active" | "on_leave" | "inactive";
  notes: string | null;
  account: "active" | "invited" | "expired" | "not_invited";
  accountLinkedAt: string | null;
  invitation: { id: string; sentAt: string; expiresAt: string; acceptedAt: string | null; revokedAt: string | null; emailed: boolean; emailFailed: boolean } | null;
  deactivatedAt: string | null;
  deactivationReason: string | null;
  createdAt: string;
  /** Only for those who may see pay. */
  hourlyRate?: string | null;
  rateEffectiveFrom?: string | null;
  payRates?: Array<{ id: string; hourlyRate: string; currency: string; effectiveFrom: string; reason: string | null; createdAt: string }>;
}

export interface StaffConfig {
  settings: {
    timezone: string;
    currency: string;
    payCycle: "daily" | "weekly" | "biweekly" | "semimonthly" | "monthly";
    payCycleAnchor: string;
    weekStartsOn: number;
    invitationExpiryHours: number;
    staleSessionHours: number;
    lateGraceMinutes: number;
    requireApproval: boolean;
    allowEmployeeCorrections: boolean;
    jurisdiction: string | null;
    supportEmail: string | null;
    defaultOvertimePolicyId: string | null;
    defaultBreakPolicyId: string | null;
  };
  departments: Array<{ id: string; name: string; employees: number }>;
  overtimePolicies: Array<{
    id: string;
    name: string;
    dailyThresholdMinutes: number | null;
    weeklyThresholdMinutes: number | null;
    multiplier: string;
    doubleTimeDailyThresholdMinutes: number | null;
    doubleTimeMultiplier: string | null;
    holidayMultiplier: string;
  }>;
  breakPolicies: Array<{ id: string; name: string; restBreaksPaid: boolean; mealBreaksPaid: boolean; maxBreaksPerShift: number | null; maxBreakMinutes: number | null }>;
  holidays: Array<{ id: string; day: string; name: string }>;
  managers: Array<{ userId: string; name: string; email: string; role: string; staffRole: string | null }>;
  access: { permissions: StaffPermission[]; scope: "all" | "assigned" };
}

export interface SessionRow {
  id: string;
  employeeId: string;
  clockInAt: string;
  clockOutAt: string | null;
  open: boolean;
  workedSeconds: number;
  paidBreakSeconds: number;
  unpaidBreakSeconds: number;
  breaks: Array<{ id: string; kind: "rest" | "meal"; paid: boolean; startAt: string; endAt: string | null }>;
  approvalStatus: "pending" | "approved" | "rejected";
  approvedAt: string | null;
  rejectedReason: string | null;
  flags: string[];
  needsReview: boolean;
  locked: boolean;
  revision: number;
  source: string;
  note: string | null;
  day?: string;
  employee?: { id: string; fullName: string; jobTitle: string; employeeNumber: string };
  pendingCorrection?: boolean;
}

/** A page of shifts (GET .../timesheets), as the Timesheets page and an employee's tabs list them. */
export interface TimesheetList {
  timezone: string;
  total: number;
  page: number;
  pageSize: number;
  pendingCorrections: number;
  items: SessionRow[];
}

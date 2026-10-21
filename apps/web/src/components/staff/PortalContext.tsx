"use client";
import { createContext, useContext, useState } from "react";
import type { BreakKind, PaymentMethod, PaymentStatus, PayrollStatus } from "@app/shared/staff";
import type { Me } from "@/components/AppContext";
import { useLiveApi } from "@/lib/api";
import { leaveTo, signOut } from "@/lib/auth";
import type { SessionRow } from "@/lib/staff";

// ---------------------------------------------------------------------------------------------
// The employee portal (/portal): who is signed in, which organization they are looking at, and
// the shapes of the portal's API answers. Employees are not workspace members, so the portal has
// its own shell (app/portal/layout.tsx) instead of AppProvider.
// ---------------------------------------------------------------------------------------------

/** The organization the portal last showed, per device. */
export const PORTAL_WS_KEY = "insights:portal-ws";

export type Employment = NonNullable<Me["employments"]>[number];

export interface PortalCtx {
  me: Me;
  /** The organization (workspace id) the portal shows. */
  ws: string;
  employment: Employment;
  employments: Employment[];
  setWs(id: string): void;
}

const Ctx = createContext<PortalCtx | null>(null);
export const PortalProvider = Ctx.Provider;

export function usePortal(): PortalCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("usePortal outside the portal layout");
  return v;
}

/** Sign this browser out (not the account's other devices) and go to the sign-in page. */
export async function portalSignOut(router: { replace(href: string): void }) {
  leaveTo(await signOut(), router);
}

/**
 * useLiveApi with a way to ask again now: "Try again" after a failed first load, or a refresh
 * right after the employee did something. Asking again changes the question (a throwaway query
 * parameter the API ignores), which is what makes useLiveApi check straight away; what is on
 * screen stays until the new answer lands.
 */
export function useLiveRetry<T>(path: string | null, intervalMs: number) {
  const [n, setN] = useState(0);
  const asked = path && n ? `${path}${path.includes("?") ? "&" : "?"}_r=${n}` : path;
  const live = useLiveApi<T>(asked, intervalMs);
  return { ...live, retry: () => setN((x) => x + 1) };
}

// ---------------------------------------------------------------------------------------------
// API shapes (packages/core/src/staff/attendance.ts, payroll.ts, admin.ts)
// ---------------------------------------------------------------------------------------------

export interface ClockState {
  serverTime: string;
  status: "clocked_out" | "working" | "on_break";
  session: null | {
    id: string;
    clockInAt: string;
    flags: string[];
    workedSeconds: number;
    unpaidBreakSeconds: number;
    paidBreakSeconds: number;
    breaks: Array<{ id: string; kind: BreakKind; paid: boolean; startAt: string; endAt: string | null }>;
    currentBreak: { id: string; kind: BreakKind; paid: boolean; startAt: string } | null;
  };
}

export interface ShiftSummary {
  sessionId: string;
  clockInAt: string;
  clockOutAt: string;
  workedSeconds: number;
  paidBreakSeconds: number;
  unpaidBreakSeconds: number;
  overtimeSeconds: number;
  currency: string;
  estimatedEarnings: string | null;
  rateMissing: boolean;
  flags: string[];
}

export interface ClockResult {
  replayed: boolean;
  sessionId: string | null;
  state: ClockState;
  summary?: ShiftSummary | null;
}

export interface EmployeeDashboard {
  organization: string;
  employee: {
    id: string;
    fullName: string;
    jobTitle: string;
    employeeNumber: string;
    email: string;
    phone: string | null;
    status: "active" | "on_leave" | "inactive";
    currency: string;
    timezone: string;
  };
  timezone: string;
  currency: string;
  allowCorrections: boolean;
  state: ClockState;
  today: { day: string; workedSeconds: number };
  week: { from: string; to: string; workedSeconds: number; overtimeSeconds: number };
  month: { from: string; to: string; workedSeconds: number };
  payPeriod: { from: string; to: string; workedSeconds: number; overtimeSeconds: number; estimatedGross: string; rateMissing: boolean };
  lastShift: { id: string; clockInAt: string; clockOutAt: string; workedSeconds: number; approvalStatus: "pending" | "approved" | "rejected"; flags: string[] } | null;
  upcomingShifts: Array<{ id: string; startsAt: string; endsAt: string; breakMinutes: number; location: string | null; note: string | null }>;
  recentPayments: Array<{ id: string; amount: string; currency: string; paidOn: string; method: PaymentMethod; status: PaymentStatus; periods: Array<{ from: string; to: string }> }>;
  pending: { shifts: number; corrections: number };
  estimateNotice: string;
}

export interface MyShift extends SessionRow {
  day: string;
  corrections: Array<{ id: string; status: "pending" | "approved" | "rejected" | "cancelled"; reason: string; decisionNote: string | null; createdAt: string }>;
}

export interface MyTimesheet {
  timezone: string;
  allowCorrections: boolean;
  items: MyShift[];
}

export interface MyPayItem {
  id: string;
  period: { id: string; from: string; to: string; payDate: string | null; status: PayrollStatus };
  currency: string;
  regularSeconds: number;
  overtimeSeconds: number;
  gross: string;
  otherEarnings: string;
  deductions: string;
  net: string;
  paid: string;
  outstanding: string;
  payments: Array<{ id: string; amount: string; paidOn: string; method: PaymentMethod; status: PaymentStatus }>;
}

export interface MySchedule {
  timezone: string;
  items: Array<{ id: string; day: string; startsAt: string; endsAt: string; breakMinutes: number; plannedSeconds: number; location: string | null; note: string | null }>;
}

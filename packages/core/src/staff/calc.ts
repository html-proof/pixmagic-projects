import type { BreakPolicy, StaffSettings, Tx } from "@app/db";
import {
  allocateWork,
  endOfLocalDay,
  localDayOf,
  nextLocalHour,
  priceWork,
  sessionWork,
  shiftDay,
  startOfLocalDay,
  startOfWeek,
  wallTime,
  type OvertimeRules,
  type PricedWork,
  type RateSpan,
  type WorkChunk,
  type WorkInterval,
} from "@app/shared/staff";
import { decimalString } from "./common.js";
import { holidaySet, overtimeRules } from "./settings.js";

/**
 * Turning attendance rows into hours and estimated pay for any range: the employee dashboard, the
 * live board, analytics and the payroll run all go through here, so they agree.
 */

export interface EmployeeLite {
  id: string;
  fullName: string;
  employeeNumber: string;
  jobTitle: string;
  departmentId: string | null;
  departmentName: string | null;
  managerUserId: string | null;
  currency: string;
  status: string;
  employmentType: string;
  workingDays: number[];
  joinedOn: string;
  deactivatedAt: Date | null;
  userId: string | null;
  rules: OvertimeRules | null;
  breakPolicy: BreakPolicy | null;
  rates: RateSpan[];
}

export interface SessionRow {
  id: string;
  employeeId: string;
  clockInAt: Date;
  clockOutAt: Date | null;
  approvalStatus: string;
  flags: string[];
  revision: number;
  lockedAt: Date | null;
  scheduleId: string | null;
  breaks: Array<{ startAt: Date; endAt: Date | null; paid: boolean; kind: string }>;
}

export interface WorkData {
  settings: StaffSettings;
  employees: Map<string, EmployeeLite>;
  sessions: SessionRow[];
  holidays: Set<string>;
}

export type SessionFilter = "payable" | "estimate";

/**
 * Load everything needed to price work on local days `from`..`to`, starting from the first day of
 * `from`'s week so weekly overtime knows what came earlier that week.
 *  - "estimate": every shift that isn't rejected, open ones included (dashboards, analytics).
 *  - "payable": closed shifts that count for pay: approved ones, or every non-rejected one when
 *    the organization doesn't require approval (the payroll run).
 */
export async function loadWork(
  tx: Tx,
  settings: StaffSettings,
  opts: { from: string; to: string; employeeIds?: string[]; filter: SessionFilter; employeeWhere?: Record<string, unknown> },
): Promise<WorkData> {
  const ws = settings.workspaceId;
  const tz = settings.timezone;
  const loadFrom = startOfWeek(opts.from, settings.weekStartsOn);
  const windowStart = new Date(startOfLocalDay(loadFrom, tz));
  const windowEnd = new Date(endOfLocalDay(opts.to, tz));
  const employeeFilter = { workspaceId: ws, ...(opts.employeeIds ? { id: { in: opts.employeeIds } } : {}), ...(opts.employeeWhere ?? {}) };
  const [employees, sessions, holidays] = await Promise.all([
    tx.employee.findMany({
      where: employeeFilter,
      include: { department: { select: { name: true } }, overtimePolicy: true, breakPolicy: true, payRates: true },
    }),
    tx.attendanceSession.findMany({
      where: {
        workspaceId: ws,
        employee: employeeFilter,
        approvalStatus: opts.filter === "payable" && settings.requireApproval ? "approved" : { not: "rejected" },
        ...(opts.filter === "payable" ? { clockOutAt: { not: null } } : {}),
        clockInAt: { lt: windowEnd },
        OR: [{ clockOutAt: null }, { clockOutAt: { gt: windowStart } }],
      },
      include: { breaks: { select: { startAt: true, endAt: true, paid: true, kind: true } } },
      orderBy: { clockInAt: "asc" },
    }),
    holidaySet(tx, ws, shiftDay(loadFrom, -1), shiftDay(opts.to, 1)),
  ]);
  const map = new Map<string, EmployeeLite>();
  for (const e of employees) {
    map.set(e.id, {
      id: e.id,
      fullName: e.fullName,
      employeeNumber: e.employeeNumber,
      jobTitle: e.jobTitle,
      departmentId: e.departmentId,
      departmentName: e.department?.name ?? null,
      managerUserId: e.managerUserId,
      currency: e.currency,
      status: e.status,
      employmentType: e.employmentType,
      workingDays: e.workingDays,
      joinedOn: e.joinedOn,
      deactivatedAt: e.deactivatedAt,
      userId: e.userId,
      rules: overtimeRules(e.overtimePolicy),
      breakPolicy: e.breakPolicy,
      rates: e.payRates.map((r) => ({ effectiveFrom: r.effectiveFrom, hourlyRate: decimalString(r.hourlyRate)! })),
    });
  }
  return { settings, employees: map, sessions, holidays };
}

export interface EmployeeWork {
  employee: EmployeeLite;
  /** Classified time on days within the range. */
  chunks: WorkChunk[];
  priced: PricedWork;
  paidBreakSeconds: number;
  unpaidBreakSeconds: number;
  /** Shifts that contributed time within the range, with the revision used. */
  sessions: Array<{ id: string; revision: number }>;
}

/** Paid working intervals per employee (open shifts run to now, capped at the stale limit). */
function intervalsByEmployee(data: WorkData, nowMs: number) {
  const cap = data.settings.staleSessionHours * 3600;
  const out = new Map<string, { intervals: WorkInterval[]; breaks: Map<string, { paid: number; unpaid: number; day: string }> }>();
  for (const s of data.sessions) {
    let entry = out.get(s.employeeId);
    if (!entry) out.set(s.employeeId, (entry = { intervals: [], breaks: new Map() }));
    const w = sessionWork(
      { id: s.id, clockInAt: s.clockInAt.getTime(), clockOutAt: s.clockOutAt?.getTime() ?? null },
      s.breaks.map((b) => ({ startAt: b.startAt.getTime(), endAt: b.endAt?.getTime() ?? null, paid: b.paid })),
      nowMs,
      cap,
    );
    entry.intervals.push(...w.intervals);
    entry.breaks.set(s.id, { paid: w.paidBreakSeconds, unpaid: w.unpaidBreakSeconds, day: localDayOf(s.clockInAt.getTime(), data.settings.timezone) });
  }
  return out;
}

/** Hours and estimated pay per employee for local days `from`..`to`. */
export function computeWork(data: WorkData, range: { from: string; to: string }, nowMs: number): Map<string, EmployeeWork> {
  const result = new Map<string, EmployeeWork>();
  const byEmployee = intervalsByEmployee(data, nowMs);
  const revisions = new Map(data.sessions.map((s) => [s.id, s.revision]));
  for (const [employeeId, { intervals, breaks }] of byEmployee) {
    const employee = data.employees.get(employeeId);
    if (!employee) continue;
    const chunks = allocateWork(intervals, {
      timeZone: data.settings.timezone,
      weekStartsOn: data.settings.weekStartsOn,
      rules: employee.rules,
      holidays: data.holidays,
    }).filter((c) => c.day >= range.from && c.day <= range.to);
    let paidBreak = 0;
    let unpaidBreak = 0;
    for (const b of breaks.values()) {
      if (b.day >= range.from && b.day <= range.to) {
        paidBreak += b.paid;
        unpaidBreak += b.unpaid;
      }
    }
    const sessionIds = [...new Set(chunks.map((c) => c.sessionId))];
    result.set(employeeId, {
      employee,
      chunks,
      priced: priceWork(chunks, employee.rates, employee.currency),
      paidBreakSeconds: paidBreak,
      unpaidBreakSeconds: unpaidBreak,
      sessions: sessionIds.map((id) => ({ id, revision: revisions.get(id) ?? 0 })),
    });
  }
  return result;
}

/** Cut chunks at local hour boundaries, for hourly charts. */
export function splitByHour(chunks: readonly WorkChunk[], timeZone: string): Array<WorkChunk & { hour: string }> {
  const out: Array<WorkChunk & { hour: string }> = [];
  for (const c of chunks) {
    let t = c.start;
    while (t < c.end) {
      const next = Math.min(c.end, Math.floor(nextLocalHour(t * 1000, timeZone) / 1000));
      const w = wallTime(t * 1000, timeZone);
      out.push({ ...c, start: t, end: next, seconds: next - t, hour: `${localDayOf(t * 1000, timeZone)}T${String(w.hour).padStart(2, "0")}` });
      t = next;
    }
  }
  return out;
}

/** Price chunks per bucket (each bucket rounded on its own, so bucket totals add up to the KPI). */
export function priceByBucket(
  chunks: ReadonlyArray<WorkChunk & { hour?: string }>,
  rates: readonly RateSpan[],
  currency: string,
  bucketOf: (c: WorkChunk & { hour?: string }) => string,
): Map<string, PricedWork> {
  const groups = new Map<string, WorkChunk[]>();
  for (const c of chunks) {
    const k = bucketOf(c);
    const g = groups.get(k);
    if (g) g.push(c);
    else groups.set(k, [c]);
  }
  const out = new Map<string, PricedWork>();
  for (const [k, g] of groups) out.set(k, priceWork(g, rates, currency));
  return out;
}

/** Seconds of worked time, by category, in a priced result. */
export const workedSeconds = (p: PricedWork) => p.regularSeconds + p.overtimeSeconds + p.doubleTimeSeconds + p.holidaySeconds;

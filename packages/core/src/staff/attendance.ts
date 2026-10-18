import { Prisma, systemDb, withTenant, type AttendanceSession, type BreakPolicy, type Employee, type StaffSettings, type Tx } from "@app/db";
import {
  computeFlags,
  localDayOf,
  minorToString,
  periodContaining,
  priceWork,
  REVIEW_FLAGS,
  sessionWork,
  shiftDay,
  startOfLocalDay,
  startOfMonth,
  startOfWeek,
  type BreakKind,
  type PayCycle,
  type SessionFlag,
} from "@app/shared/staff";
import { logger } from "../logger.js";
import type { FetchLike } from "../shopify.js";
import { audit, raiseAlert, type Mailer } from "../notify.js";
import { assertNotOwnRecord, employeeScope, isFrozenViolation, isUniqueViolation, lockEmployee, notFound, scopedEmployee, serverNow, StaffError, type StaffActor } from "./common.js";
import { computeWork, loadWork, workedSeconds } from "./calc.js";
import { ensureStaffSettings } from "./settings.js";

// ---------------------------------------------------------------------------------------------
// Who the employee is
// ---------------------------------------------------------------------------------------------

/** An employee acting on their own records through the portal. */
export interface EmployeeCtx {
  workspaceId: string;
  employee: Employee;
  userId: string;
  ip?: string;
  userAgent?: string;
}

/** The organizations a signed-in account works for (portal switcher, /me). */
export async function employmentsForUser(userId: string) {
  const rows = await systemDb.employee.findMany({
    where: { userId },
    include: { workspace: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((e) => ({ workspaceId: e.workspaceId, organization: e.workspace.name, employeeId: e.id, fullName: e.fullName, jobTitle: e.jobTitle, status: e.status }));
}

export async function employeeForUser(userId: string, workspaceId: string): Promise<Employee | null> {
  return systemDb.employee.findFirst({ where: { userId, workspaceId } });
}

// ---------------------------------------------------------------------------------------------
// Clock in / out / breaks
// ---------------------------------------------------------------------------------------------

export interface ClockInput {
  /** The client's Idempotency-Key: a retry (or a double tap) with the same key acts once. */
  idempotencyKey?: string | null;
  /** What the device thinks the time is: kept for the audit trail only, never used for pay. */
  clientTime?: Date | null;
  clientTimezone?: string | null;
  source: "web" | "mobile";
  breakKind?: BreakKind;
}

type ClockKind = "clock_in" | "clock_out" | "break_start" | "break_end";

const DEACTIVATED = () => new StaffError(403, "deactivated", "Your employee account has been deactivated. Contact your manager if you think that's a mistake.");

function breakPaid(policy: BreakPolicy | null, kind: BreakKind): boolean {
  if (!policy) return kind === "rest";
  return kind === "rest" ? policy.restBreaksPaid : policy.mealBreaksPaid;
}

/** Flags recomputed from a session's times, keeping the ones only corrections set. */
async function refreshFlags(tx: Tx, settings: StaffSettings, sessionId: string, nowMs: number, extra: SessionFlag[] = []) {
  const s = await tx.attendanceSession.findUniqueOrThrow({ where: { id: sessionId }, include: { breaks: true, schedule: true, employee: { include: { breakPolicy: true } } } });
  const holidays = await tx.staffHoliday.findMany({ where: { workspaceId: s.workspaceId, day: localDayOf(s.clockInAt.getTime(), settings.timezone) } });
  const computed = computeFlags({
    clockInAt: s.clockInAt.getTime(),
    clockOutAt: s.clockOutAt?.getTime() ?? null,
    schedule: s.schedule ? { startsAt: s.schedule.startsAt.getTime(), endsAt: s.schedule.endsAt.getTime() } : null,
    breaks: s.breaks.map((b) => ({ startAt: b.startAt.getTime(), endAt: b.endAt?.getTime() ?? null })),
    breakRules: { maxBreaksPerShift: s.employee.breakPolicy?.maxBreaksPerShift ?? null, maxBreakMinutes: s.employee.breakPolicy?.maxBreakMinutes ?? null },
    lateGraceMinutes: settings.lateGraceMinutes,
    staleAfterHours: settings.staleSessionHours,
    timeZone: settings.timezone,
    holidays: new Set(holidays.map((h) => h.day)),
    nowMs,
  });
  const sticky = s.flags.filter((f) => f === "corrected" || f === "manual" || f === "closed_by_manager");
  const flags = [...new Set([...computed, ...sticky, ...extra])];
  await tx.attendanceSession.update({ where: { id: sessionId }, data: { flags } });
  return flags;
}

/** The shift on the schedule this clock-in belongs to: one that starts within 2 hours or is under way. */
async function matchSchedule(tx: Tx, employeeId: string, now: Date) {
  return tx.shiftSchedule.findFirst({
    where: { employeeId, startsAt: { lte: new Date(now.getTime() + 2 * 3_600_000) }, endsAt: { gte: new Date(now.getTime() - 3_600_000) } },
    orderBy: { startsAt: "asc" },
  });
}

/**
 * One clock action, serialized per employee: the employee row is locked for the transaction, so
 * two requests (two tabs, a double tap, a retry after a dropped connection) run one after the
 * other and the second sees what the first did. The partial unique indexes (one open shift, one
 * open break) back this up in the database itself. The time recorded is always the server's.
 */
async function clockAction(ctx: EmployeeCtx, kind: ClockKind, input: ClockInput) {
  const ws = ctx.workspaceId;
  const settings = await ensureStaffSettings(ws);
  const now = serverNow();
  const eventBase = {
    workspaceId: ws,
    employeeId: ctx.employee.id,
    at: now,
    clientTime: input.clientTime ?? null,
    clientTimezone: input.clientTimezone?.slice(0, 64) ?? null,
    source: input.source,
    actorUserId: ctx.userId,
    ip: ctx.ip?.slice(0, 64) ?? null,
    userAgent: ctx.userAgent?.slice(0, 300) ?? null,
  };
  try {
    return await withTenant(ws, async (tx) => {
      if (!(await lockEmployee(tx, ws, ctx.employee.id))) throw notFound("Your employee record");
      if (input.idempotencyKey) {
        const prior = await tx.attendanceEvent.findUnique({ where: { employeeId_idempotencyKey: { employeeId: ctx.employee.id, idempotencyKey: input.idempotencyKey } } });
        if (prior) {
          if (prior.type !== kind) throw new StaffError(409, "idempotency_conflict", "That request was already used for something else. Refresh and try again.");
          return { replayed: true, sessionId: prior.sessionId };
        }
      }
      const employee = await tx.employee.findUniqueOrThrow({ where: { id: ctx.employee.id }, include: { breakPolicy: true } });
      if (employee.status === "inactive") throw DEACTIVATED();
      const open = await tx.attendanceSession.findFirst({ where: { employeeId: employee.id, clockOutAt: null }, include: { breaks: { where: { endAt: null } } } });
      const event = (sessionId: string, type: string, extra: Partial<Prisma.AttendanceEventUncheckedCreateInput> = {}) =>
        tx.attendanceEvent.create({ data: { ...eventBase, sessionId, type, idempotencyKey: input.idempotencyKey ?? null, ...extra } });

      if (kind === "clock_in") {
        if (employee.status === "on_leave") throw new StaffError(409, "on_leave", "You're marked as on leave. Ask your manager if you need to work today.");
        if (open) throw new StaffError(409, "already_clocked_in", "You're already clocked in.", { sessionId: open.id });
        const schedule = await matchSchedule(tx, employee.id, now);
        const session = await tx.attendanceSession.create({
          data: {
            workspaceId: ws,
            employeeId: employee.id,
            scheduleId: schedule?.id ?? null,
            clockInAt: now,
            clockInSource: input.source,
            timezone: input.clientTimezone && input.clientTimezone.length <= 64 ? input.clientTimezone : employee.timezone,
          },
        });
        await event(session.id, "clock_in");
        await refreshFlags(tx, settings, session.id, now.getTime());
        return { replayed: false, sessionId: session.id };
      }

      if (!open) throw new StaffError(409, "not_clocked_in", "You're not clocked in.");
      const openBreak = open.breaks[0] ?? null;

      if (kind === "clock_out") {
        if (openBreak) {
          await tx.breakSession.update({ where: { id: openBreak.id }, data: { endAt: now } });
          await tx.attendanceEvent.create({ data: { ...eventBase, sessionId: open.id, type: "break_end", note: "Ended by clocking out" } });
        }
        await tx.attendanceSession.update({ where: { id: open.id }, data: { clockOutAt: now, clockOutSource: input.source } });
        await event(open.id, "clock_out");
        await refreshFlags(tx, settings, open.id, now.getTime());
        return { replayed: false, sessionId: open.id };
      }

      if (kind === "break_start") {
        if (openBreak) throw new StaffError(409, "already_on_break", "You're already on a break.");
        const policy = employee.breakPolicy;
        if (policy?.maxBreaksPerShift != null) {
          const taken = await tx.breakSession.count({ where: { sessionId: open.id } });
          if (taken >= policy.maxBreaksPerShift) {
            throw new StaffError(409, "break_limit", `You've already taken ${taken} ${taken === 1 ? "break" : "breaks"} this shift, the most your break policy allows.`);
          }
        }
        const kindOfBreak = input.breakKind ?? "rest";
        await tx.breakSession.create({
          data: { workspaceId: ws, sessionId: open.id, employeeId: employee.id, startAt: now, kind: kindOfBreak, paid: breakPaid(policy, kindOfBreak) },
        });
        await event(open.id, "break_start", { note: kindOfBreak });
        return { replayed: false, sessionId: open.id };
      }

      // break_end
      if (!openBreak) throw new StaffError(409, "not_on_break", "You're not on a break.");
      await tx.breakSession.update({ where: { id: openBreak.id }, data: { endAt: now } });
      await event(open.id, "break_end");
      await refreshFlags(tx, settings, open.id, now.getTime());
      return { replayed: false, sessionId: open.id };
    });
  } catch (err) {
    // The database's own guard against a duplicate open shift or break, if two requests ever got
    // past the lock (they can't, but the index is what makes that a guarantee).
    if (isUniqueViolation(err, "one_open")) {
      throw new StaffError(409, kind === "clock_in" ? "already_clocked_in" : "already_on_break", kind === "clock_in" ? "You're already clocked in." : "You're already on a break.");
    }
    if (isUniqueViolation(err, "idempotency")) throw new StaffError(409, "duplicate_request", "That request was already received. Refresh to see where things stand.");
    throw err;
  }
}

export async function clockIn(ctx: EmployeeCtx, input: ClockInput) {
  const r = await clockAction(ctx, "clock_in", input);
  return { ...r, state: await attendanceState(ctx) };
}

export async function clockOut(ctx: EmployeeCtx, input: ClockInput) {
  const r = await clockAction(ctx, "clock_out", input);
  const state = await attendanceState(ctx);
  return { ...r, state, summary: r.sessionId ? await shiftSummary(ctx, r.sessionId) : null };
}

export async function startBreak(ctx: EmployeeCtx, input: ClockInput) {
  const r = await clockAction(ctx, "break_start", input);
  return { ...r, state: await attendanceState(ctx) };
}

export async function endBreak(ctx: EmployeeCtx, input: ClockInput) {
  const r = await clockAction(ctx, "break_end", input);
  return { ...r, state: await attendanceState(ctx) };
}

/**
 * Where the employee stands right now, from the server's records: the timer on screen is drawn from
 * `clockInAt` and `serverTime`, so it survives refreshes, other devices and a wrong device clock.
 */
export async function attendanceState(ctx: EmployeeCtx) {
  const ws = ctx.workspaceId;
  const now = serverNow();
  return withTenant(ws, async (tx) => {
    const open = await tx.attendanceSession.findFirst({
      where: { workspaceId: ws, employeeId: ctx.employee.id, clockOutAt: null },
      include: { breaks: { orderBy: { startAt: "asc" } } },
    });
    if (!open) return { serverTime: now, status: "clocked_out" as const, session: null };
    const w = sessionWork(
      { id: open.id, clockInAt: open.clockInAt.getTime(), clockOutAt: null },
      open.breaks.map((b) => ({ startAt: b.startAt.getTime(), endAt: b.endAt?.getTime() ?? null, paid: b.paid })),
      now.getTime(),
    );
    const onBreak = open.breaks.find((b) => !b.endAt) ?? null;
    return {
      serverTime: now,
      status: onBreak ? ("on_break" as const) : ("working" as const),
      session: {
        id: open.id,
        clockInAt: open.clockInAt,
        flags: open.flags,
        workedSeconds: w.workedSeconds,
        unpaidBreakSeconds: w.unpaidBreakSeconds,
        paidBreakSeconds: w.paidBreakSeconds,
        breaks: open.breaks.map((b) => ({ id: b.id, kind: b.kind, paid: b.paid, startAt: b.startAt, endAt: b.endAt })),
        currentBreak: onBreak ? { id: onBreak.id, kind: onBreak.kind, paid: onBreak.paid, startAt: onBreak.startAt } : null,
      },
    };
  });
}

/** What the employee sees after clocking out: time, breaks and (their own) estimated earnings. */
async function shiftSummary(ctx: EmployeeCtx, sessionId: string) {
  const settings = await ensureStaffSettings(ctx.workspaceId);
  return withTenant(ctx.workspaceId, async (tx) => {
    const s = await tx.attendanceSession.findFirst({ where: { id: sessionId, employeeId: ctx.employee.id }, include: { breaks: true } });
    if (!s || !s.clockOutAt) return null;
    const day = localDayOf(s.clockInAt.getTime(), settings.timezone);
    const endDay = localDayOf(s.clockOutAt.getTime() - 1, settings.timezone);
    const data = await loadWork(tx, settings, { from: day, to: endDay, employeeIds: [ctx.employee.id], filter: "estimate" });
    const work = computeWork(data, { from: day, to: endDay }, Date.now()).get(ctx.employee.id);
    const own = work ? work.chunks.filter((c) => c.sessionId === s.id) : [];
    const priced = work ? priceWork(own, work.employee.rates, work.employee.currency) : null;
    const w = sessionWork(
      { id: s.id, clockInAt: s.clockInAt.getTime(), clockOutAt: s.clockOutAt.getTime() },
      s.breaks.map((b) => ({ startAt: b.startAt.getTime(), endAt: b.endAt?.getTime() ?? null, paid: b.paid })),
      Date.now(),
    );
    return {
      sessionId: s.id,
      clockInAt: s.clockInAt,
      clockOutAt: s.clockOutAt,
      workedSeconds: w.workedSeconds,
      paidBreakSeconds: w.paidBreakSeconds,
      unpaidBreakSeconds: w.unpaidBreakSeconds,
      overtimeSeconds: priced ? priced.overtimeSeconds + priced.doubleTimeSeconds : 0,
      currency: ctx.employee.currency,
      estimatedEarnings: priced ? minorToString(priced.grossMinor, ctx.employee.currency) : null,
      rateMissing: !work?.employee.rates.length || !!priced?.unpricedSeconds,
      flags: s.flags,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// The employee dashboard
// ---------------------------------------------------------------------------------------------

export async function employeeDashboard(ctx: EmployeeCtx) {
  const ws = ctx.workspaceId;
  const settings = await ensureStaffSettings(ws);
  const now = serverNow();
  const tz = settings.timezone;
  const today = localDayOf(now.getTime(), tz);
  const weekFrom = startOfWeek(today, settings.weekStartsOn);
  const monthFrom = startOfMonth(today);
  const period = periodContaining(today, settings.payCycle as PayCycle, settings.payCycleAnchor);
  const from = [weekFrom, monthFrom, period.from].sort()[0]!;
  const [state, workspace] = await Promise.all([attendanceState(ctx), systemDb.workspace.findUnique({ where: { id: ws }, select: { name: true } })]);
  const body = await withTenant(ws, async (tx) => {
    const data = await loadWork(tx, settings, { from, to: today, employeeIds: [ctx.employee.id], filter: "estimate" });
    const all = computeWork(data, { from, to: today }, now.getTime()).get(ctx.employee.id);
    const sum = (f: string, t: string) => {
      const chunks = (all?.chunks ?? []).filter((c) => c.day >= f && c.day <= t);
      const s = { worked: 0, overtime: 0 };
      for (const c of chunks) {
        s.worked += c.seconds;
        if (c.category === "overtime" || c.category === "double_time") s.overtime += c.seconds;
      }
      return s;
    };
    const periodChunks = (all?.chunks ?? []).filter((c) => c.day >= period.from && c.day <= period.to);
    const periodPriced = all ? priceWork(periodChunks, all.employee.rates, all.employee.currency) : null;
    const [lastShift, upcoming, payments, pendingShifts, pendingCorrections] = await Promise.all([
      tx.attendanceSession.findFirst({
        where: { workspaceId: ws, employeeId: ctx.employee.id, clockOutAt: { not: null } },
        orderBy: { clockOutAt: "desc" },
        include: { breaks: true },
      }),
      tx.shiftSchedule.findMany({
        where: { workspaceId: ws, employeeId: ctx.employee.id, endsAt: { gte: now } },
        orderBy: { startsAt: "asc" },
        take: 5,
      }),
      tx.payrollPayment.findMany({
        where: { workspaceId: ws, employeeId: ctx.employee.id },
        orderBy: [{ paidOn: "desc" }, { createdAt: "desc" }],
        take: 5,
        include: { allocations: { include: { item: { include: { period: { select: { startDate: true, endDate: true } } } } } } },
      }),
      tx.attendanceSession.count({ where: { workspaceId: ws, employeeId: ctx.employee.id, approvalStatus: "pending", clockOutAt: { not: null } } }),
      tx.timesheetAdjustment.count({ where: { workspaceId: ws, employeeId: ctx.employee.id, status: "pending" } }),
    ]);
    const lastW = lastShift
      ? sessionWork(
          { id: lastShift.id, clockInAt: lastShift.clockInAt.getTime(), clockOutAt: lastShift.clockOutAt!.getTime() },
          lastShift.breaks.map((b) => ({ startAt: b.startAt.getTime(), endAt: b.endAt?.getTime() ?? null, paid: b.paid })),
          now.getTime(),
        )
      : null;
    const cur = ctx.employee.currency;
    return {
      today: { day: today, workedSeconds: sum(today, today).worked },
      week: { from: weekFrom, to: today, workedSeconds: sum(weekFrom, today).worked, overtimeSeconds: sum(weekFrom, today).overtime },
      month: { from: monthFrom, to: today, workedSeconds: sum(monthFrom, today).worked },
      payPeriod: {
        from: period.from,
        to: period.to,
        workedSeconds: periodPriced ? workedSeconds(periodPriced) : 0,
        overtimeSeconds: periodPriced ? periodPriced.overtimeSeconds + periodPriced.doubleTimeSeconds : 0,
        estimatedGross: periodPriced ? minorToString(periodPriced.grossMinor, cur) : minorToString(0n, cur),
        rateMissing: !data.employees.get(ctx.employee.id)?.rates.length || !!periodPriced?.unpricedSeconds,
      },
      lastShift: lastShift
        ? { id: lastShift.id, clockInAt: lastShift.clockInAt, clockOutAt: lastShift.clockOutAt, workedSeconds: lastW!.workedSeconds, approvalStatus: lastShift.approvalStatus, flags: lastShift.flags }
        : null,
      upcomingShifts: upcoming.map((s) => ({ id: s.id, startsAt: s.startsAt, endsAt: s.endsAt, breakMinutes: s.breakMinutes, location: s.location, note: s.note })),
      recentPayments: payments.map((p) => ({
        id: p.id,
        amount: minorToString(p.amountMinor, p.currency),
        currency: p.currency,
        paidOn: p.paidOn,
        method: p.method,
        status: p.status,
        periods: p.allocations.map((a) => ({ from: a.item.period.startDate, to: a.item.period.endDate })),
      })),
      pending: { shifts: pendingShifts, corrections: pendingCorrections },
    };
  });
  return {
    organization: workspace?.name ?? "",
    employee: {
      id: ctx.employee.id,
      fullName: ctx.employee.fullName,
      jobTitle: ctx.employee.jobTitle,
      employeeNumber: ctx.employee.employeeNumber,
      email: ctx.employee.email,
      phone: ctx.employee.phone,
      status: ctx.employee.status,
      currency: ctx.employee.currency,
      timezone: ctx.employee.timezone,
    },
    timezone: tz,
    currency: ctx.employee.currency,
    allowCorrections: settings.allowEmployeeCorrections,
    state,
    ...body,
    /** Labels the figures: no statutory tax or deductions are calculated. */
    estimateNotice: "Estimated gross pay from your recorded hours. Your final pay may differ after approvals, taxes and deductions.",
  };
}

// ---------------------------------------------------------------------------------------------
// Timesheets
// ---------------------------------------------------------------------------------------------

type SessionWithBreaks = AttendanceSession & { breaks: Array<{ id: string; startAt: Date; endAt: Date | null; kind: string; paid: boolean }> };

export function sessionView(s: SessionWithBreaks, nowMs: number, extra: Record<string, unknown> = {}) {
  const w = sessionWork(
    { id: s.id, clockInAt: s.clockInAt.getTime(), clockOutAt: s.clockOutAt?.getTime() ?? null },
    s.breaks.map((b) => ({ startAt: b.startAt.getTime(), endAt: b.endAt?.getTime() ?? null, paid: b.paid })),
    nowMs,
  );
  return {
    id: s.id,
    employeeId: s.employeeId,
    clockInAt: s.clockInAt,
    clockOutAt: s.clockOutAt,
    open: !s.clockOutAt,
    workedSeconds: w.workedSeconds,
    paidBreakSeconds: w.paidBreakSeconds,
    unpaidBreakSeconds: w.unpaidBreakSeconds,
    breaks: s.breaks.map((b) => ({ id: b.id, kind: b.kind, paid: b.paid, startAt: b.startAt, endAt: b.endAt })),
    approvalStatus: s.approvalStatus,
    approvedAt: s.approvedAt,
    rejectedReason: s.rejectedReason,
    flags: s.flags,
    needsReview: !s.clockOutAt || s.flags.some((f) => (REVIEW_FLAGS as readonly string[]).includes(f)),
    locked: !!s.lockedAt,
    revision: s.revision,
    source: s.clockInSource,
    note: s.note,
    ...extra,
  };
}

export interface TimesheetFilters {
  from: string;
  to: string;
  employeeId?: string;
  departmentId?: string;
  status?: "pending" | "approved" | "rejected" | "open" | "needs_review";
  page: number;
  pageSize: number;
}

export async function listTimesheets(actor: StaffActor, f: TimesheetFilters) {
  const settings = await ensureStaffSettings(actor.workspaceId);
  const tz = settings.timezone;
  const start = new Date(startOfLocalDay(f.from, tz));
  const end = new Date(startOfLocalDay(shiftDay(f.to, 1), tz));
  const where: Prisma.AttendanceSessionWhereInput = {
    workspaceId: actor.workspaceId,
    employee: { ...employeeScope(actor), ...(f.departmentId ? { departmentId: f.departmentId } : {}) },
    clockInAt: { gte: start, lt: end },
    ...(f.employeeId ? { employeeId: f.employeeId } : {}),
  };
  if (f.status === "open") where.clockOutAt = null;
  else if (f.status === "needs_review") where.OR = [{ clockOutAt: null }, { flags: { hasSome: [...REVIEW_FLAGS] } }];
  else if (f.status) Object.assign(where, { approvalStatus: f.status, clockOutAt: { not: null } });
  const nowMs = Date.now();
  return withTenant(actor.workspaceId, async (tx) => {
    const [total, rows, pendingCorrections] = await Promise.all([
      tx.attendanceSession.count({ where }),
      tx.attendanceSession.findMany({
        where,
        orderBy: [{ clockInAt: "desc" }, { id: "asc" }],
        skip: (f.page - 1) * f.pageSize,
        take: f.pageSize,
        include: { breaks: true, employee: { select: { id: true, fullName: true, jobTitle: true, employeeNumber: true } }, adjustments: { where: { status: "pending" }, select: { id: true } } },
      }),
      tx.timesheetAdjustment.count({ where: { workspaceId: actor.workspaceId, status: "pending", employee: employeeScope(actor) } }),
    ]);
    return {
      timezone: tz,
      total,
      page: f.page,
      pageSize: f.pageSize,
      pendingCorrections,
      items: rows.map((s) =>
        sessionView(s, nowMs, {
          employee: { id: s.employee.id, fullName: s.employee.fullName, jobTitle: s.employee.jobTitle, employeeNumber: s.employee.employeeNumber },
          pendingCorrection: s.adjustments.length > 0,
          day: localDayOf(s.clockInAt.getTime(), tz),
        }),
      ),
    };
  });
}

/** One shift with its breaks, its full event history and its corrections. */
export async function getSession(actor: StaffActor, sessionId: string) {
  return withTenant(actor.workspaceId, async (tx) => {
    const s = await tx.attendanceSession.findFirst({
      where: { id: sessionId, workspaceId: actor.workspaceId, employee: employeeScope(actor) },
      include: {
        breaks: { orderBy: { startAt: "asc" } },
        employee: { select: { id: true, fullName: true, jobTitle: true, employeeNumber: true, timezone: true } },
        events: { orderBy: { at: "asc" } },
        adjustments: { orderBy: { createdAt: "desc" } },
        approvals: { orderBy: { createdAt: "desc" } },
        schedule: true,
      },
    });
    if (!s) throw notFound("That shift");
    const userIds = [...new Set([...s.events.map((e) => e.actorUserId), ...s.adjustments.flatMap((a) => [a.requestedByUserId, a.decidedByUserId]), ...s.approvals.map((a) => a.actorUserId)].filter(Boolean))] as string[];
    const users = await systemDb.user.findMany({ where: { id: { in: userIds } }, select: { id: true, displayName: true, email: true } });
    const name = (id: string | null) => (id ? (users.find((u) => u.id === id)?.displayName ?? users.find((u) => u.id === id)?.email ?? "Someone") : "bizinsights");
    return sessionView(s, Date.now(), {
      employee: s.employee,
      schedule: s.schedule ? { id: s.schedule.id, startsAt: s.schedule.startsAt, endsAt: s.schedule.endsAt } : null,
      events: s.events.map((e) => ({ id: e.id, type: e.type, at: e.at, clientTime: e.clientTime, source: e.source, actor: name(e.actorUserId), before: e.before, after: e.after, note: e.note })),
      corrections: s.adjustments.map((a) => ({
        id: a.id,
        status: a.status,
        byEmployee: a.byEmployee,
        requestedBy: name(a.requestedByUserId),
        proposedClockInAt: a.proposedClockInAt,
        proposedClockOutAt: a.proposedClockOutAt,
        reason: a.reason,
        decidedBy: a.decidedByUserId ? name(a.decidedByUserId) : null,
        decidedAt: a.decidedAt,
        decisionNote: a.decisionNote,
        createdAt: a.createdAt,
      })),
      approvals: s.approvals.map((a) => ({ id: a.id, action: a.action, by: name(a.actorUserId), note: a.note, at: a.createdAt })),
    });
  });
}

/** The employee's own shifts. */
export async function myTimesheet(ctx: EmployeeCtx, range: { from: string; to: string }) {
  const settings = await ensureStaffSettings(ctx.workspaceId);
  const tz = settings.timezone;
  const nowMs = Date.now();
  return withTenant(ctx.workspaceId, async (tx) => {
    const rows = await tx.attendanceSession.findMany({
      where: {
        workspaceId: ctx.workspaceId,
        employeeId: ctx.employee.id,
        clockInAt: { gte: new Date(startOfLocalDay(range.from, tz)), lt: new Date(startOfLocalDay(shiftDay(range.to, 1), tz)) },
      },
      orderBy: { clockInAt: "desc" },
      take: 400,
      include: { breaks: true, adjustments: { orderBy: { createdAt: "desc" }, take: 3 } },
    });
    return {
      timezone: tz,
      allowCorrections: settings.allowEmployeeCorrections,
      items: rows.map((s) =>
        sessionView(s, nowMs, {
          day: localDayOf(s.clockInAt.getTime(), tz),
          corrections: s.adjustments.map((a) => ({ id: a.id, status: a.status, reason: a.reason, decisionNote: a.decisionNote, createdAt: a.createdAt })),
        }),
      ),
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Corrections
// ---------------------------------------------------------------------------------------------

export interface CorrectionTimes {
  clockInAt: Date;
  clockOutAt: Date | null;
  breaks?: Array<{ startAt: Date; endAt: Date; kind: BreakKind }>;
}

const MAX_SHIFT_MS = 24 * 3_600_000;

function validateTimes(t: CorrectionTimes, now: Date, allowOpen: boolean) {
  const skew = 5 * 60_000;
  if (t.clockInAt.getTime() > now.getTime() + skew) throw new StaffError(400, "future_time", "The start time can't be in the future.");
  if (!t.clockOutAt && !allowOpen) throw new StaffError(400, "missing_end", "Enter when the shift ended.");
  if (t.clockOutAt) {
    if (t.clockOutAt.getTime() > now.getTime() + skew) throw new StaffError(400, "future_time", "The end time can't be in the future.");
    if (t.clockOutAt <= t.clockInAt) throw new StaffError(400, "end_before_start", "The shift has to end after it starts.");
    if (t.clockOutAt.getTime() - t.clockInAt.getTime() > MAX_SHIFT_MS) throw new StaffError(400, "too_long", "A shift can't be longer than 24 hours. Split it into two shifts.");
  }
  const end = t.clockOutAt ?? now;
  const breaks = [...(t.breaks ?? [])].sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
  let last = t.clockInAt.getTime();
  for (const b of breaks) {
    if (b.endAt <= b.startAt) throw new StaffError(400, "break_times", "Each break has to end after it starts.");
    if (b.startAt.getTime() < last || b.endAt.getTime() > end.getTime()) throw new StaffError(400, "break_times", "Breaks have to fall inside the shift and not overlap.");
    last = b.endAt.getTime();
  }
}

/** Refuse times that overlap another of the employee's shifts (hours are never counted twice). */
async function assertNoOverlap(tx: Tx, employeeId: string, t: CorrectionTimes, exceptSessionId: string | null) {
  const end = t.clockOutAt ?? new Date(8.64e15);
  const clash = await tx.attendanceSession.findFirst({
    where: {
      employeeId,
      approvalStatus: { not: "rejected" },
      ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}),
      clockInAt: { lt: end },
      OR: [{ clockOutAt: null }, { clockOutAt: { gt: t.clockInAt } }],
    },
  });
  if (clash) throw new StaffError(409, "overlap", "Those times overlap another shift for this employee. Change that shift first.");
}

/**
 * Refuse a change that would put hours on a day an approved (locked) payroll already covers: they
 * would never be paid. Those go into the next payroll as an adjustment instead.
 */
async function assertNotInLockedPeriod(tx: Tx, workspaceId: string, timezone: string, start: Date, end: Date | null) {
  const from = localDayOf(start.getTime(), timezone);
  const to = localDayOf(Math.max(start.getTime(), (end ?? start).getTime() - 1), timezone);
  const locked = await tx.payrollPeriod.findFirst({ where: { workspaceId, lockedAt: { not: null }, startDate: { lte: to }, endDate: { gte: from } } });
  if (locked) {
    throw new StaffError(409, "period_locked", `Pay for ${locked.startDate} to ${locked.endDate} is already approved, so hours on those days can't change. Add an adjustment to the next payroll instead.`);
  }
}

const snapshot = (s: { clockInAt: Date; clockOutAt: Date | null }, breaks: Array<{ startAt: Date; endAt: Date | null; kind: string }>) => ({
  clockInAt: s.clockInAt.toISOString(),
  clockOutAt: s.clockOutAt?.toISOString() ?? null,
  breaks: breaks.map((b) => ({ startAt: b.startAt.toISOString(), endAt: b.endAt?.toISOString() ?? null, kind: b.kind })),
});

/** Apply corrected times to a shift inside `tx` (revision-audited: before/after go in the event). */
async function applyTimes(
  tx: Tx,
  settings: StaffSettings,
  session: AttendanceSession,
  t: CorrectionTimes,
  actor: { userId: string; ip?: string },
  opts: { note: string | null; approve: boolean; extraFlags: SessionFlag[] },
) {
  if (session.lockedAt) throw new StaffError(409, "locked", "This shift is in approved payroll, so it can't be changed. Add an adjustment to the next payroll instead.");
  const now = serverNow();
  validateTimes(t, now, !session.clockOutAt && !t.clockOutAt);
  await assertNoOverlap(tx, session.employeeId, t, session.id);
  await assertNotInLockedPeriod(tx, session.workspaceId, settings.timezone, session.clockInAt, session.clockOutAt ?? now);
  await assertNotInLockedPeriod(tx, session.workspaceId, settings.timezone, t.clockInAt, t.clockOutAt ?? now);
  const before = await tx.breakSession.findMany({ where: { sessionId: session.id }, orderBy: { startAt: "asc" } });
  const employee = await tx.employee.findUniqueOrThrow({ where: { id: session.employeeId }, include: { breakPolicy: true } });
  if (t.breaks) {
    await tx.breakSession.deleteMany({ where: { sessionId: session.id } });
    if (t.breaks.length) {
      await tx.breakSession.createMany({
        data: t.breaks.map((b) => ({ workspaceId: session.workspaceId, sessionId: session.id, employeeId: session.employeeId, startAt: b.startAt, endAt: b.endAt, kind: b.kind, paid: breakPaid(employee.breakPolicy, b.kind) })),
      });
    }
  } else if (t.clockOutAt) {
    // Breaks still open at the new end, or running past it, end with the shift.
    await tx.breakSession.updateMany({ where: { sessionId: session.id, OR: [{ endAt: null }, { endAt: { gt: t.clockOutAt } }] }, data: { endAt: t.clockOutAt } });
  }
  const updated = await tx.attendanceSession.update({
    where: { id: session.id },
    data: {
      clockInAt: t.clockInAt,
      clockOutAt: t.clockOutAt,
      ...(t.clockOutAt && !session.clockOutAt ? { clockOutSource: "admin" } : {}),
      revision: { increment: 1 },
      note: opts.note ?? session.note,
      ...(opts.approve ? { approvalStatus: "approved", approvedAt: now, approvedByUserId: actor.userId, rejectedReason: null } : {}),
    },
  });
  const after = await tx.breakSession.findMany({ where: { sessionId: session.id }, orderBy: { startAt: "asc" } });
  await refreshFlags(tx, settings, session.id, now.getTime(), ["corrected", ...opts.extraFlags]);
  await tx.attendanceEvent.create({
    data: {
      workspaceId: session.workspaceId,
      employeeId: session.employeeId,
      sessionId: session.id,
      type: "correction",
      at: now,
      source: "admin",
      actorUserId: actor.userId,
      ip: actor.ip ?? null,
      before: snapshot(session, before),
      after: snapshot(updated, after),
      note: opts.note,
    },
  });
  if (opts.approve) {
    await tx.timesheetApproval.create({ data: { workspaceId: session.workspaceId, sessionId: session.id, action: "approved", revision: updated.revision, actorUserId: actor.userId, note: "Approved with a correction" } });
  }
  return updated;
}

function frozen(err: unknown): never {
  if (isFrozenViolation(err)) throw new StaffError(409, "locked", "This shift is in approved payroll, so it can't be changed. Add an adjustment to the next payroll instead.");
  throw err;
}

/** A manager corrects a shift directly (applied and approved at once, with a full before/after record). */
export async function editSession(actor: StaffActor, sessionId: string, input: CorrectionTimes & { note: string }) {
  const settings = await ensureStaffSettings(actor.workspaceId);
  const result = await withTenant(actor.workspaceId, async (tx) => {
    const s = await tx.attendanceSession.findFirst({ where: { id: sessionId, workspaceId: actor.workspaceId, employee: employeeScope(actor) }, include: { employee: { select: { userId: true } } } });
    if (!s) throw notFound("That shift");
    assertNotOwnRecord(actor, s.employee.userId, "correct shifts");
    await lockEmployee(tx, actor.workspaceId, s.employeeId);
    const updated = await applyTimes(tx, settings, s, input, actor, { note: input.note, approve: !!input.clockOutAt, extraFlags: !s.clockOutAt && input.clockOutAt ? ["closed_by_manager"] : [] });
    await tx.timesheetAdjustment.create({
      data: {
        workspaceId: actor.workspaceId,
        employeeId: s.employeeId,
        sessionId: s.id,
        requestedByUserId: actor.userId,
        byEmployee: false,
        proposedClockInAt: input.clockInAt,
        proposedClockOutAt: input.clockOutAt,
        proposedBreaks: input.breaks ? (input.breaks.map((b) => ({ startAt: b.startAt.toISOString(), endAt: b.endAt.toISOString(), kind: b.kind })) as Prisma.InputJsonValue) : Prisma.JsonNull,
        reason: input.note,
        status: "approved",
        decidedByUserId: actor.userId,
        decidedAt: new Date(),
      },
    });
    // A pending request from the employee for this shift is answered by this edit.
    await tx.timesheetAdjustment.updateMany({
      where: { sessionId: s.id, status: "pending" },
      data: { status: "rejected", decidedByUserId: actor.userId, decidedAt: new Date(), decisionNote: "Replaced by a manager's correction" },
    });
    return updated;
  }).catch(frozen);
  await audit({ workspaceId: actor.workspaceId, actorUserId: actor.userId, action: "staff.shift_corrected", targetType: "employee", targetId: result.employeeId, metadata: { sessionId }, ip: actor.ip });
  return getSession(actor, sessionId);
}

/** A manager adds a shift that was never clocked (forgotten clock-in). */
export async function addManualSession(actor: StaffActor, employeeId: string, input: CorrectionTimes & { note: string }) {
  if (!input.clockOutAt) throw new StaffError(400, "missing_end", "Enter when the shift ended.");
  const settings = await ensureStaffSettings(actor.workspaceId);
  const now = serverNow();
  validateTimes(input, now, false);
  const session = await withTenant(actor.workspaceId, async (tx) => {
    const e = await scopedEmployee(tx, actor, employeeId);
    assertNotOwnRecord(actor, e.userId, "add shifts");
    await lockEmployee(tx, actor.workspaceId, e.id);
    await assertNoOverlap(tx, e.id, input, null);
    await assertNotInLockedPeriod(tx, actor.workspaceId, settings.timezone, input.clockInAt, input.clockOutAt);
    const employee = await tx.employee.findUniqueOrThrow({ where: { id: e.id }, include: { breakPolicy: true } });
    const s = await tx.attendanceSession.create({
      data: {
        workspaceId: actor.workspaceId,
        employeeId: e.id,
        clockInAt: input.clockInAt,
        clockOutAt: input.clockOutAt,
        clockInSource: "admin",
        clockOutSource: "admin",
        timezone: e.timezone,
        approvalStatus: "approved",
        approvedAt: now,
        approvedByUserId: actor.userId,
        note: input.note,
        flags: ["manual"],
      },
    });
    if (input.breaks?.length) {
      await tx.breakSession.createMany({
        data: input.breaks.map((b) => ({ workspaceId: actor.workspaceId, sessionId: s.id, employeeId: e.id, startAt: b.startAt, endAt: b.endAt, kind: b.kind, paid: breakPaid(employee.breakPolicy, b.kind) })),
      });
    }
    await refreshFlags(tx, settings, s.id, now.getTime(), ["manual"]);
    await tx.attendanceEvent.create({
      data: { workspaceId: actor.workspaceId, employeeId: e.id, sessionId: s.id, type: "manual_entry", at: now, source: "admin", actorUserId: actor.userId, ip: actor.ip ?? null, after: snapshot(s, input.breaks ?? []), note: input.note },
    });
    await tx.timesheetAdjustment.create({
      data: { workspaceId: actor.workspaceId, employeeId: e.id, sessionId: s.id, requestedByUserId: actor.userId, proposedClockInAt: input.clockInAt, proposedClockOutAt: input.clockOutAt, reason: input.note, status: "approved", decidedByUserId: actor.userId, decidedAt: now },
    });
    await tx.timesheetApproval.create({ data: { workspaceId: actor.workspaceId, sessionId: s.id, action: "approved", revision: 0, actorUserId: actor.userId, note: "Added by a manager" } });
    return s;
  });
  await audit({ workspaceId: actor.workspaceId, actorUserId: actor.userId, action: "staff.shift_added", targetType: "employee", targetId: employeeId, metadata: { sessionId: session.id }, ip: actor.ip });
  return getSession(actor, session.id);
}

/** The employee asks for a shift to be corrected (or a missed one added). A manager decides. */
export async function requestCorrection(ctx: EmployeeCtx, input: { sessionId: string | null; clockInAt: Date; clockOutAt: Date | null; reason: string }) {
  const settings = await ensureStaffSettings(ctx.workspaceId);
  if (!settings.allowEmployeeCorrections) throw new StaffError(403, "corrections_off", "Your organization doesn't take correction requests here. Ask your manager.");
  if (ctx.employee.status === "inactive") throw DEACTIVATED();
  const now = serverNow();
  validateTimes(input, now, !!input.sessionId);
  const adj = await withTenant(ctx.workspaceId, async (tx) => {
    if (input.sessionId) {
      const s = await tx.attendanceSession.findFirst({ where: { id: input.sessionId, employeeId: ctx.employee.id } });
      if (!s) throw notFound("That shift");
      if (s.lockedAt) throw new StaffError(409, "locked", "This shift has already been paid in an approved payroll. Ask your manager about an adjustment.");
      const pending = await tx.timesheetAdjustment.count({ where: { sessionId: s.id, status: "pending" } });
      if (pending) throw new StaffError(409, "already_requested", "You've already asked for a change to this shift. Your manager will review it.");
    }
    await assertNoOverlap(tx, ctx.employee.id, input, input.sessionId);
    await assertNotInLockedPeriod(tx, ctx.workspaceId, settings.timezone, input.clockInAt, input.clockOutAt);
    return tx.timesheetAdjustment.create({
      data: {
        workspaceId: ctx.workspaceId,
        employeeId: ctx.employee.id,
        sessionId: input.sessionId,
        requestedByUserId: ctx.userId,
        byEmployee: true,
        proposedClockInAt: input.clockInAt,
        proposedClockOutAt: input.clockOutAt,
        reason: input.reason,
      },
    });
  });
  await audit({ workspaceId: ctx.workspaceId, actorUserId: ctx.userId, action: "staff.correction_requested", targetType: "employee", targetId: ctx.employee.id, metadata: { adjustmentId: adj.id } });
  return { id: adj.id, status: adj.status };
}

export async function listCorrections(actor: StaffActor, status: "pending" | "all") {
  return withTenant(actor.workspaceId, async (tx) => {
    const rows = await tx.timesheetAdjustment.findMany({
      where: { workspaceId: actor.workspaceId, employee: employeeScope(actor), ...(status === "pending" ? { status: "pending" } : {}) },
      include: { employee: { select: { id: true, fullName: true, jobTitle: true } }, session: { select: { id: true, clockInAt: true, clockOutAt: true } } },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    return rows.map((a) => ({
      id: a.id,
      employee: a.employee,
      session: a.session,
      byEmployee: a.byEmployee,
      proposedClockInAt: a.proposedClockInAt,
      proposedClockOutAt: a.proposedClockOutAt,
      reason: a.reason,
      status: a.status,
      decisionNote: a.decisionNote,
      createdAt: a.createdAt,
    }));
  });
}

/** Approve (apply) or reject an employee's correction request. */
export async function decideCorrection(actor: StaffActor, adjustmentId: string, decision: { approve: boolean; note: string | null }) {
  const settings = await ensureStaffSettings(actor.workspaceId);
  const out = await withTenant(actor.workspaceId, async (tx) => {
    const a = await tx.timesheetAdjustment.findFirst({ where: { id: adjustmentId, workspaceId: actor.workspaceId, employee: employeeScope(actor) }, include: { employee: { select: { userId: true } } } });
    if (!a) throw notFound("That request");
    if (decision.approve) assertNotOwnRecord(actor, a.employee.userId, "approve time corrections");
    if (a.status !== "pending") throw new StaffError(409, "already_decided", "Someone has already dealt with this request.");
    await lockEmployee(tx, actor.workspaceId, a.employeeId);
    const now = serverNow();
    let sessionId = a.sessionId;
    if (decision.approve) {
      const times = { clockInAt: a.proposedClockInAt!, clockOutAt: a.proposedClockOutAt };
      if (a.sessionId) {
        const s = await tx.attendanceSession.findUniqueOrThrow({ where: { id: a.sessionId } });
        await applyTimes(tx, settings, s, times, actor, { note: `Employee's request: ${a.reason}`, approve: !!times.clockOutAt, extraFlags: [] });
      } else {
        if (!times.clockOutAt) throw new StaffError(400, "missing_end", "The request has no end time, so it can't be added as a shift.");
        validateTimes(times, now, false);
        await assertNoOverlap(tx, a.employeeId, times, null);
        await assertNotInLockedPeriod(tx, actor.workspaceId, settings.timezone, times.clockInAt, times.clockOutAt);
        const e = await tx.employee.findUniqueOrThrow({ where: { id: a.employeeId } });
        const s = await tx.attendanceSession.create({
          data: {
            workspaceId: actor.workspaceId,
            employeeId: a.employeeId,
            clockInAt: times.clockInAt,
            clockOutAt: times.clockOutAt,
            clockInSource: "admin",
            clockOutSource: "admin",
            timezone: e.timezone,
            approvalStatus: "approved",
            approvedAt: now,
            approvedByUserId: actor.userId,
            note: a.reason,
            flags: ["manual"],
          },
        });
        sessionId = s.id;
        await refreshFlags(tx, settings, s.id, now.getTime(), ["manual"]);
        await tx.attendanceEvent.create({ data: { workspaceId: actor.workspaceId, employeeId: a.employeeId, sessionId: s.id, type: "manual_entry", at: now, source: "admin", actorUserId: actor.userId, note: a.reason } });
        await tx.timesheetApproval.create({ data: { workspaceId: actor.workspaceId, sessionId: s.id, action: "approved", revision: 0, actorUserId: actor.userId, note: "Missed shift added on request" } });
      }
    }
    await tx.timesheetAdjustment.update({
      where: { id: a.id },
      data: { status: decision.approve ? "approved" : "rejected", decidedByUserId: actor.userId, decidedAt: now, decisionNote: decision.note, sessionId },
    });
    return { employeeId: a.employeeId, sessionId };
  }).catch(frozen);
  await audit({
    workspaceId: actor.workspaceId,
    actorUserId: actor.userId,
    action: decision.approve ? "staff.correction_approved" : "staff.correction_rejected",
    targetType: "employee",
    targetId: out.employeeId,
    metadata: { adjustmentId },
    ip: actor.ip,
  });
  return { ok: true, sessionId: out.sessionId };
}

// ---------------------------------------------------------------------------------------------
// Approving hours
// ---------------------------------------------------------------------------------------------

export async function approveSessions(actor: StaffActor, sessionIds: string[], note: string | null) {
  const now = serverNow();
  const settings = await ensureStaffSettings(actor.workspaceId);
  const approved = await withTenant(actor.workspaceId, async (tx) => {
    const rows = await tx.attendanceSession.findMany({ where: { id: { in: sessionIds }, workspaceId: actor.workspaceId, employee: employeeScope(actor) } });
    if (rows.length !== sessionIds.length) throw notFound("One of those shifts");
    const own = await tx.employee.findFirst({ where: { workspaceId: actor.workspaceId, id: { in: [...new Set(rows.map((s) => s.employeeId))] }, userId: actor.userId }, select: { userId: true } });
    assertNotOwnRecord(actor, own?.userId, "approve hours");
    const open = rows.find((s) => !s.clockOutAt);
    if (open) throw new StaffError(409, "open_shift", "A shift that hasn't ended can't be approved. Set its clock-out time first.");
    const locked = rows.find((s) => s.lockedAt);
    if (locked) throw new StaffError(409, "locked", "One of those shifts is already in approved payroll.");
    const todo = rows.filter((s) => s.approvalStatus !== "approved");
    for (const s of todo) await assertNotInLockedPeriod(tx, actor.workspaceId, settings.timezone, s.clockInAt, s.clockOutAt);
    for (const s of todo) {
      await tx.attendanceSession.update({ where: { id: s.id }, data: { approvalStatus: "approved", approvedAt: now, approvedByUserId: actor.userId, rejectedReason: null } });
      await tx.timesheetApproval.create({ data: { workspaceId: actor.workspaceId, sessionId: s.id, action: "approved", revision: s.revision, actorUserId: actor.userId, note } });
      await tx.attendanceEvent.create({ data: { workspaceId: actor.workspaceId, employeeId: s.employeeId, sessionId: s.id, type: "approval", at: now, source: "admin", actorUserId: actor.userId, note } });
    }
    return todo;
  }).catch(frozen);
  // One entry per employee, so each one's Audit History shows the approval of their own shifts.
  const byEmployee = new Map<string, string[]>();
  for (const s of approved) byEmployee.set(s.employeeId, [...(byEmployee.get(s.employeeId) ?? []), s.id]);
  for (const [employeeId, ids] of byEmployee) {
    await audit({ workspaceId: actor.workspaceId, actorUserId: actor.userId, action: "staff.hours_approved", targetType: "employee", targetId: employeeId, metadata: { count: ids.length, sessionIds: ids.slice(0, 50) }, ip: actor.ip });
  }
  return { approved: approved.length };
}

export async function rejectSession(actor: StaffActor, sessionId: string, reason: string) {
  const now = serverNow();
  const s = await withTenant(actor.workspaceId, async (tx) => {
    const s = await tx.attendanceSession.findFirst({ where: { id: sessionId, workspaceId: actor.workspaceId, employee: employeeScope(actor) } });
    if (!s) throw notFound("That shift");
    if (!s.clockOutAt) throw new StaffError(409, "open_shift", "A shift that hasn't ended can't be rejected. Set its clock-out time first.");
    if (s.lockedAt) throw new StaffError(409, "locked", "This shift is already in approved payroll.");
    await tx.attendanceSession.update({ where: { id: s.id }, data: { approvalStatus: "rejected", rejectedReason: reason, approvedAt: null, approvedByUserId: null } });
    await tx.timesheetApproval.create({ data: { workspaceId: actor.workspaceId, sessionId: s.id, action: "rejected", revision: s.revision, actorUserId: actor.userId, note: reason } });
    await tx.attendanceEvent.create({ data: { workspaceId: actor.workspaceId, employeeId: s.employeeId, sessionId: s.id, type: "rejection", at: now, source: "admin", actorUserId: actor.userId, note: reason } });
    return s;
  }).catch(frozen);
  await audit({ workspaceId: actor.workspaceId, actorUserId: actor.userId, action: "staff.hours_rejected", targetType: "employee", targetId: s.employeeId, metadata: { sessionId }, ip: actor.ip });
  return { ok: true };
}

export async function reopenSession(actor: StaffActor, sessionId: string) {
  const now = serverNow();
  const settings = await ensureStaffSettings(actor.workspaceId);
  const reopened = await withTenant(actor.workspaceId, async (tx) => {
    const s = await tx.attendanceSession.findFirst({ where: { id: sessionId, workspaceId: actor.workspaceId, employee: employeeScope(actor) } });
    if (!s) throw notFound("That shift");
    if (s.lockedAt) throw new StaffError(409, "locked", "This shift is already in approved payroll.");
    await assertNotInLockedPeriod(tx, actor.workspaceId, settings.timezone, s.clockInAt, s.clockOutAt);
    if (s.approvalStatus === "pending") return null;
    await tx.attendanceSession.update({ where: { id: s.id }, data: { approvalStatus: "pending", approvedAt: null, approvedByUserId: null, rejectedReason: null } });
    await tx.timesheetApproval.create({ data: { workspaceId: actor.workspaceId, sessionId: s.id, action: "reopened", revision: s.revision, actorUserId: actor.userId } });
    await tx.attendanceEvent.create({ data: { workspaceId: actor.workspaceId, employeeId: s.employeeId, sessionId: s.id, type: "reopen", at: now, source: "admin", actorUserId: actor.userId } });
    return s.employeeId;
  }).catch(frozen);
  if (reopened) await audit({ workspaceId: actor.workspaceId, actorUserId: actor.userId, action: "staff.hours_reopened", targetType: "employee", targetId: reopened, metadata: { sessionId }, ip: actor.ip });
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// Forgotten clock-outs
// ---------------------------------------------------------------------------------------------

/**
 * Cron sweep: shifts open longer than the organization's limit are flagged "forgot to clock
 * out?" and its owners and admins alerted once per shift. Paid time already stops growing at the
 * limit (see sessionWork's cap); a manager sets the real clock-out time to resolve it.
 */
export async function flagStaleSessions(mailer: Mailer, fetchImpl?: FetchLike): Promise<number> {
  const rows = await systemDb.$queryRaw<Array<{ id: string; workspace_id: string; flags: string[] }>>`
    SELECT s.id, s.workspace_id, s.flags
      FROM attendance_sessions s
      JOIN organization_payroll_settings st ON st.workspace_id = s.workspace_id
     WHERE s.clock_out_at IS NULL
       AND s.stale_alerted_at IS NULL
       AND s.clock_in_at < now() - make_interval(hours => st.stale_session_hours)
     LIMIT 500`;
  const byWorkspace = new Map<string, number>();
  for (const r of rows) {
    const n = await systemDb.attendanceSession.updateMany({
      where: { id: r.id, staleAlertedAt: null, clockOutAt: null },
      data: { staleAlertedAt: new Date(), flags: [...new Set([...r.flags, "stale"])] },
    });
    if (n.count) byWorkspace.set(r.workspace_id, (byWorkspace.get(r.workspace_id) ?? 0) + 1);
  }
  for (const [workspaceId, count] of byWorkspace) {
    // The app shows this message as is (@app/shared/alerts): keep error text out of it.
    await raiseAlert(
      {
        workspaceId,
        severity: "warning",
        code: "staff_open_shifts",
        message: `${count} ${count === 1 ? "shift has" : "shifts have"} been open longer than expected. Someone may have forgotten to clock out: review them in Staff → Timesheets.`,
      },
      mailer,
      fetchImpl,
    ).catch((err: unknown) => logger.error({ err, workspaceId }, "open-shift alert failed"));
  }
  return rows.length;
}

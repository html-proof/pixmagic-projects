import { withTenant, type Prisma } from "@app/db";
import {
  bucketLabel,
  bucketOf,
  bucketsBetween,
  defaultGranularity,
  allowedGranularities,
  endOfLocalDay,
  formatScaled,
  liveStatus,
  localDayOf,
  minorToString,
  PAYABLE_STATUSES,
  parseDecimal,
  priceWork,
  RATE_SCALE,
  rateOn,
  REVIEW_FLAGS,
  resolveRange,
  roundDiv,
  sessionWork,
  shiftDay,
  startOfLocalDay,
  staffCan,
  type DayRange,
  type Granularity,
  type LiveStatus,
  type RangePreset,
  type WorkChunk,
} from "@app/shared/staff";
import { decimalString, displayRate, employeeScope, type StaffActor } from "./common.js";
import { computeWork, loadWork, priceByBucket, splitByHour, workedSeconds, type EmployeeWork } from "./calc.js";
import { ensureStaffSettings } from "./settings.js";

// ---------------------------------------------------------------------------------------------
// Live attendance board
// ---------------------------------------------------------------------------------------------

export interface LiveFilters {
  q?: string;
  departmentId?: string;
  jobTitle?: string;
  managerUserId?: string;
  status?: LiveStatus;
}

export async function liveBoard(actor: StaffActor, f: LiveFilters) {
  const settings = await ensureStaffSettings(actor.workspaceId);
  const tz = settings.timezone;
  const now = new Date();
  const nowMs = now.getTime();
  const today = localDayOf(nowMs, tz);
  const dayStart = new Date(startOfLocalDay(today, tz));
  const dayEnd = new Date(endOfLocalDay(today, tz));
  const pay = staffCan(actor.access, "pay:view");
  // Scope ANDed with the filters: a supervisor's `managerUserId` scope must not be replaceable by the filter.
  const where: Prisma.EmployeeWhereInput = {
    AND: [
      employeeScope(actor),
      {
        status: { not: "inactive" },
        ...(f.departmentId ? { departmentId: f.departmentId } : {}),
        ...(f.jobTitle ? { jobTitle: { equals: f.jobTitle, mode: "insensitive" as const } } : {}),
        ...(f.managerUserId ? { managerUserId: f.managerUserId } : {}),
        ...(f.q ? { OR: [{ fullName: { contains: f.q, mode: "insensitive" as const } }, { employeeNumber: { contains: f.q, mode: "insensitive" as const } }] } : {}),
      },
    ],
  };
  return withTenant(actor.workspaceId, async (tx) => {
    const [employees, sessions, schedules, corrections, holiday, data] = await Promise.all([
      tx.employee.findMany({ where, include: { department: { select: { name: true } } }, orderBy: { fullName: "asc" } }),
      tx.attendanceSession.findMany({
        where: { workspaceId: actor.workspaceId, employee: where, approvalStatus: { not: "rejected" }, OR: [{ clockOutAt: null }, { clockInAt: { lt: dayEnd }, clockOutAt: { gt: dayStart } }] },
        include: { breaks: true },
        orderBy: { clockInAt: "asc" },
      }),
      tx.shiftSchedule.findMany({ where: { workspaceId: actor.workspaceId, employee: where, startsAt: { lt: dayEnd }, endsAt: { gt: dayStart } } }),
      tx.timesheetAdjustment.groupBy({ by: ["employeeId"], where: { workspaceId: actor.workspaceId, status: "pending", employee: where }, _count: true }),
      tx.staffHoliday.findFirst({ where: { workspaceId: actor.workspaceId, day: today } }),
      loadWork(tx, settings, { from: today, to: today, filter: "estimate", employeeWhere: where }),
    ]);
    const work = computeWork(data, { from: today, to: today }, nowMs);
    const pendingBy = new Map(corrections.map((c) => [c.employeeId, c._count]));
    const rows = employees.map((e) => {
      const mine = sessions.filter((s) => s.employeeId === e.id);
      const open = mine.find((s) => !s.clockOutAt) ?? null;
      const openBreak = open?.breaks.find((b) => !b.endAt) ?? null;
      const today_ = mine.filter((s) => s.clockInAt < dayEnd && (s.clockOutAt === null || s.clockOutAt > dayStart));
      const closed = today_.filter((s) => s.clockOutAt);
      let breakSeconds = 0;
      for (const s of today_) {
        breakSeconds += sessionWork(
          { id: s.id, clockInAt: s.clockInAt.getTime(), clockOutAt: s.clockOutAt?.getTime() ?? null },
          s.breaks.map((b) => ({ startAt: b.startAt.getTime(), endAt: b.endAt?.getTime() ?? null, paid: b.paid })),
          nowMs,
        ).unpaidBreakSeconds;
      }
      const w = work.get(e.id);
      const needsReview = (pendingBy.get(e.id) ?? 0) > 0 || today_.some((s) => s.flags.some((fl) => (REVIEW_FLAGS as readonly string[]).includes(fl)));
      const status = liveStatus({
        employeeStatus: e.status as "active" | "on_leave",
        openSession: open ? { clockInAt: open.clockInAt.getTime(), onBreak: !!openBreak } : null,
        closedToday: closed.length,
        needsReview,
        scheduledToday: schedules.filter((s) => s.employeeId === e.id).map((s) => ({ startsAt: s.startsAt.getTime(), endsAt: s.endsAt.getTime() })),
        lateGraceMinutes: settings.lateGraceMinutes,
        staleAfterHours: settings.staleSessionHours,
        isHoliday: !!holiday,
        nowMs,
      });
      return {
        employee: { id: e.id, fullName: e.fullName, employeeNumber: e.employeeNumber, jobTitle: e.jobTitle, department: e.department?.name ?? null, managerUserId: e.managerUserId },
        status,
        clockInAt: open?.clockInAt ?? today_[0]?.clockInAt ?? null,
        clockOutAt: open ? null : (closed[closed.length - 1]?.clockOutAt ?? null),
        openSessionId: open?.id ?? null,
        onBreakSince: openBreak?.startAt ?? null,
        breakSeconds,
        workedSeconds: w ? workedSeconds(w.priced) : 0,
        overtimeSeconds: w ? w.priced.overtimeSeconds + w.priced.doubleTimeSeconds : 0,
        lateToday: today_.some((s) => s.flags.includes("late")),
        scheduled: schedules.some((s) => s.employeeId === e.id),
        pendingCorrections: pendingBy.get(e.id) ?? 0,
        ...(pay ? { currency: e.currency, estimatedEarnings: w ? minorToString(w.priced.grossMinor, e.currency) : minorToString(0n, e.currency), rateMissing: !!w?.priced.unpricedSeconds } : {}),
      };
    });
    const count = (s: LiveStatus) => rows.filter((r) => r.status === s).length;
    const costByCurrency: Record<string, bigint> = {};
    if (pay) for (const w of work.values()) costByCurrency[w.employee.currency] = (costByCurrency[w.employee.currency] ?? 0n) + w.priced.grossMinor;
    const filtered = f.status ? rows.filter((r) => r.status === f.status) : rows;
    return {
      serverTime: now,
      timezone: tz,
      day: today,
      holiday: holiday ? { name: holiday.name } : null,
      kpis: {
        totalEmployees: rows.length,
        working: count("working"),
        onBreak: count("on_break"),
        clockedOut: count("clocked_out"),
        scheduledToday: rows.filter((r) => r.scheduled).length,
        absent: count("absent"),
        pendingReview: count("pending_review"),
        pendingCorrections: [...pendingBy.values()].reduce((a, b) => a + b, 0),
        workedSecondsToday: rows.reduce((a, r) => a + r.workedSeconds, 0),
        ...(pay
          ? {
              currency: settings.currency,
              estimatedCostToday: minorToString(costByCurrency[settings.currency] ?? 0n, settings.currency),
              otherCurrencies: Object.entries(costByCurrency)
                .filter(([c, v]) => c !== settings.currency && v > 0n)
                .map(([c, v]) => ({ currency: c, amount: minorToString(v, c) })),
            }
          : {}),
      },
      rows: filtered,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// KPI cards
// ---------------------------------------------------------------------------------------------

interface Sum {
  worked: number;
  regular: number;
  overtime: number;
  gross: bigint;
  employees: Set<string>;
}

function sumChunks(work: Map<string, EmployeeWork>, range: DayRange, currency: string, cutoff?: { day: string; untilSec: number }): Sum {
  const out: Sum = { worked: 0, regular: 0, overtime: 0, gross: 0n, employees: new Set() };
  for (const [id, w] of work) {
    let chunks = w.chunks.filter((c) => c.day >= range.from && c.day <= range.to);
    if (cutoff) {
      chunks = chunks
        .filter((c) => c.day !== cutoff.day || c.start < cutoff.untilSec)
        .map((c) => (c.day === cutoff.day && c.end > cutoff.untilSec ? { ...c, end: cutoff.untilSec, seconds: cutoff.untilSec - c.start } : c));
    }
    if (!chunks.length) continue;
    const p = priceWork(chunks, w.employee.rates, w.employee.currency);
    out.worked += workedSeconds(p);
    out.regular += p.regularSeconds + p.holidaySeconds;
    out.overtime += p.overtimeSeconds + p.doubleTimeSeconds;
    if (w.employee.currency === currency) out.gross += p.grossMinor;
    out.employees.add(id);
  }
  return out;
}

const change = (cur: number | bigint, prev: number | bigint | null): number | null => {
  if (prev === null) return null;
  const p = Number(prev);
  if (p === 0) return null;
  return (Number(cur) - p) / Math.abs(p);
};

export interface Kpi {
  key: string;
  label: string;
  unit: "hours" | "money" | "count" | "rate";
  value: number | string | null;
  previous: number | string | null;
  change: number | null;
  /** Plain-language explanation of the figure. */
  help: string;
  compareLabel: string | null;
}

export async function staffKpis(actor: StaffActor, input: { preset: RangePreset; from?: string; to?: string }) {
  const settings = await ensureStaffSettings(actor.workspaceId);
  const tz = settings.timezone;
  const now = new Date();
  const nowMs = now.getTime();
  const today = localDayOf(nowMs, tz);
  const ws = settings.weekStartsOn;
  const cur = settings.currency;
  const pay = staffCan(actor.access, "pay:view");
  const sel = resolveRange(input.preset, today, ws, { from: input.from, to: input.to });
  const t = resolveRange("today", today, ws);
  const wk = resolveRange("this_week", today, ws);
  const mo = resolveRange("this_month", today, ws);
  const yr = resolveRange("this_year", today, ws);
  const earliest = [sel.previous.from, yr.previous.from, wk.previous.from, mo.previous.from].sort()[0]!;
  const latest = [sel.range.to, today].sort().reverse()[0]!;
  // Today against yesterday up to the same time of day.
  const elapsed = Math.floor((nowMs - startOfLocalDay(today, tz)) / 1000);
  const yesterdayCut = { day: t.previous.from, untilSec: Math.floor(startOfLocalDay(t.previous.from, tz) / 1000) + elapsed };

  return withTenant(actor.workspaceId, async (tx) => {
    const scope = employeeScope(actor);
    const data = await loadWork(tx, settings, { from: earliest, to: latest, filter: "estimate", employeeWhere: scope });
    const work = computeWork(data, { from: earliest, to: latest }, nowMs);
    const s = (r: DayRange, cut?: { day: string; untilSec: number }) => sumChunks(work, r, cur, cut);
    const [sToday, sYesterday, sWeek, sPrevWeek, sMonth, sPrevMonth, sYear, sPrevYear, sSel, sPrevSel] = [
      s(t.range),
      s(t.previous, yesterdayCut),
      s(wk.range),
      s(wk.previous),
      s(mo.range),
      s(mo.previous),
      s(yr.range),
      s(yr.previous),
      s(sel.range),
      s(sel.previous),
    ];
    const allEmployees = [...data.employees.values()];
    const onBooks = (day: string) => allEmployees.filter((e) => e.joinedOn <= day && (e.status !== "inactive" || (e.deactivatedAt && localDayOf(e.deactivatedAt.getTime(), tz) > day))).length;
    const [open, pendingShifts, pendingCorrections, pendingPayroll, payments, prevPayments, owed] = await Promise.all([
      tx.attendanceSession.count({ where: { workspaceId: actor.workspaceId, clockOutAt: null, employee: scope } }),
      tx.attendanceSession.count({ where: { workspaceId: actor.workspaceId, approvalStatus: "pending", clockOutAt: { not: null }, employee: scope } }),
      tx.timesheetAdjustment.count({ where: { workspaceId: actor.workspaceId, status: "pending", employee: scope } }),
      pay ? tx.payrollPeriod.count({ where: { workspaceId: actor.workspaceId, status: "pending_approval" } }) : Promise.resolve(0),
      pay ? tx.payrollPayment.aggregate({ where: { workspaceId: actor.workspaceId, status: "completed", currency: cur, paidOn: { gte: sel.range.from, lte: sel.range.to } }, _sum: { amountMinor: true } }) : null,
      pay ? tx.payrollPayment.aggregate({ where: { workspaceId: actor.workspaceId, status: "completed", currency: cur, paidOn: { gte: sel.previous.from, lte: sel.previous.to } }, _sum: { amountMinor: true } }) : null,
      pay ? tx.payrollItem.findMany({ where: { workspaceId: actor.workspaceId, currency: cur, period: { status: { in: [...PAYABLE_STATUSES] } } }, select: { netMinor: true, paidMinor: true } }) : [],
    ]);
    const outstanding = owed.reduce((a, i) => a + (i.netMinor > i.paidMinor ? i.netMinor - i.paidMinor : 0n), 0n);
    const avgRate = (day: string) => {
      const rates = allEmployees
        .filter((e) => e.currency === cur && e.joinedOn <= day && e.status !== "inactive")
        .map((e) => rateOn(e.rates, day))
        .filter((r): r is string => r !== null);
      if (!rates.length) return null;
      // Mean of exact decimals: summed as scaled integers and divided once.
      const total = rates.reduce((a, r) => a + parseDecimal(r, RATE_SCALE), 0n);
      return displayRate(formatScaled(roundDiv(total, BigInt(rates.length)), RATE_SCALE), cur);
    };
    const money = (v: bigint) => minorToString(v, cur);
    const selLabel = sel.inProgress ? "vs the same part of the previous period" : "vs the previous period";
    const kpis: Kpi[] = [
      { key: "total_staff", label: "Total staff", unit: "count", value: onBooks(sel.range.to), previous: onBooks(sel.previous.to), change: change(onBooks(sel.range.to), onBooks(sel.previous.to)), help: "Everyone on your books on the last day of the range (active or on leave).", compareLabel: "vs the end of the previous period" },
      { key: "active_staff", label: "Active staff", unit: "count", value: sSel.employees.size, previous: sPrevSel.employees.size, change: change(sSel.employees.size, sPrevSel.employees.size), help: "People who worked at least one shift in this range.", compareLabel: selLabel },
      { key: "working_now", label: "Working now", unit: "count", value: open, previous: null, change: null, help: "Clocked in right now (including anyone on a break).", compareLabel: null },
      { key: "hours_today", label: "Hours today", unit: "hours", value: sToday.worked, previous: sYesterday.worked, change: change(sToday.worked, sYesterday.worked), help: "Paid time worked today so far, including shifts still running.", compareLabel: "vs yesterday at this time" },
      { key: "hours_week", label: "Hours this week", unit: "hours", value: sWeek.worked, previous: sPrevWeek.worked, change: change(sWeek.worked, sPrevWeek.worked), help: "Paid time worked since the start of the week.", compareLabel: "vs the same days last week" },
      { key: "hours_month", label: "Hours this month", unit: "hours", value: sMonth.worked, previous: sPrevMonth.worked, change: change(sMonth.worked, sPrevMonth.worked), help: "Paid time worked since the 1st.", compareLabel: "vs the same days last month" },
      { key: "regular_hours", label: "Regular hours", unit: "hours", value: sSel.regular, previous: sPrevSel.regular, change: change(sSel.regular, sPrevSel.regular), help: "Hours paid at the normal rate in this range.", compareLabel: selLabel },
      { key: "overtime_hours", label: "Overtime hours", unit: "hours", value: sSel.overtime, previous: sPrevSel.overtime, change: change(sSel.overtime, sPrevSel.overtime), help: "Hours past your overtime thresholds in this range.", compareLabel: selLabel },
      { key: "pending_approvals", label: "Waiting for approval", unit: "count", value: pendingShifts + pendingCorrections + pendingPayroll, previous: null, change: null, help: `${pendingShifts} shifts, ${pendingCorrections} change requests${pay ? ` and ${pendingPayroll} payroll runs` : ""} need someone to review them.`, compareLabel: null },
    ];
    if (pay) {
      const paid = payments?._sum.amountMinor ?? 0n;
      const prevPaid = prevPayments?._sum.amountMinor ?? 0n;
      const ar = avgRate(sel.range.to);
      const pr = avgRate(sel.previous.to);
      kpis.push(
        { key: "cost_today", label: "Payroll cost today", unit: "money", value: money(sToday.gross), previous: money(sYesterday.gross), change: change(sToday.gross, sYesterday.gross), help: "Estimated wages earned today from recorded hours and pay rates.", compareLabel: "vs yesterday at this time" },
        { key: "cost_week", label: "Payroll cost this week", unit: "money", value: money(sWeek.gross), previous: money(sPrevWeek.gross), change: change(sWeek.gross, sPrevWeek.gross), help: "Estimated wages earned since the start of the week.", compareLabel: "vs the same days last week" },
        { key: "cost_month", label: "Payroll cost this month", unit: "money", value: money(sMonth.gross), previous: money(sPrevMonth.gross), change: change(sMonth.gross, sPrevMonth.gross), help: "Estimated wages earned since the 1st.", compareLabel: "vs the same days last month" },
        { key: "cost_year", label: "Payroll cost this year", unit: "money", value: money(sYear.gross), previous: money(sPrevYear.gross), change: change(sYear.gross, sPrevYear.gross), help: "Estimated wages earned since 1 January.", compareLabel: "vs the same days last year" },
        { key: "amount_paid", label: "Amount paid", unit: "money", value: money(paid), previous: money(prevPaid), change: change(paid, prevPaid), help: "Payments recorded with a payment date in this range.", compareLabel: selLabel },
        { key: "outstanding", label: "Still to pay", unit: "money", value: money(outstanding), previous: null, change: null, help: "Approved payroll not yet paid, across all periods.", compareLabel: null },
        { key: "average_rate", label: "Average hourly rate", unit: "rate", value: ar, previous: pr, change: ar && pr ? change(Number(ar), Number(pr)) : null, help: "The average base pay rate of your staff on the last day of the range.", compareLabel: "vs the end of the previous period" },
      );
    }
    const otherCurrencies = [...new Set(allEmployees.filter((e) => e.currency !== cur).map((e) => e.currency))];
    return {
      asOf: now,
      timezone: tz,
      currency: pay ? cur : null,
      range: sel.range,
      previous: sel.previous,
      inProgress: sel.inProgress,
      kpis,
      notes: [
        ...(pay ? ["Costs are estimates of gross wages from recorded hours. They don't include tax or other employer costs."] : []),
        ...(pay && otherCurrencies.length ? [`Money figures are in ${cur}. Staff paid in ${otherCurrencies.join(", ")} are counted in hours only.`] : []),
      ],
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------------------------

export async function staffTrends(actor: StaffActor, input: { preset: RangePreset; from?: string; to?: string; granularity?: Granularity }) {
  const settings = await ensureStaffSettings(actor.workspaceId);
  const tz = settings.timezone;
  const now = new Date();
  const nowMs = now.getTime();
  const today = localDayOf(nowMs, tz);
  const cur = settings.currency;
  const pay = staffCan(actor.access, "pay:view");
  const { range } = resolveRange(input.preset, today, settings.weekStartsOn, { from: input.from, to: input.to });
  const allowed = allowedGranularities(range);
  const g: Granularity = input.granularity && allowed.includes(input.granularity) ? input.granularity : defaultGranularity(range);
  const keys = bucketsBetween(range, g, settings.weekStartsOn);
  const keyOf = (c: WorkChunk & { hour?: string }) => (g === "hour" ? c.hour! : bucketOf(c.day, g, settings.weekStartsOn));
  const dayKey = (day: string) => (g === "hour" ? `${day}T00` : bucketOf(day, g, settings.weekStartsOn));

  return withTenant(actor.workspaceId, async (tx) => {
    const scope = employeeScope(actor);
    const data = await loadWork(tx, settings, { from: range.from, to: range.to, filter: "estimate", employeeWhere: scope });
    const work = computeWork(data, range, nowMs);
    const hours = new Map(keys.map((k) => [k, { regular: 0, overtime: 0, regularCost: 0n, overtimeCost: 0n }]));
    const perEmployee: Array<{ id: string; fullName: string; department: string | null; seconds: number; overtimeSeconds: number; gross: bigint; currency: string }> = [];
    for (const w of work.values()) {
      const chunks = g === "hour" ? splitByHour(w.chunks, tz) : w.chunks;
      const byBucket = priceByBucket(chunks, w.employee.rates, w.employee.currency, keyOf);
      const total = { seconds: 0, overtime: 0, gross: 0n };
      for (const [k, p] of byBucket) {
        const h = hours.get(k);
        if (!h) continue;
        h.regular += p.regularSeconds + p.holidaySeconds;
        h.overtime += p.overtimeSeconds + p.doubleTimeSeconds;
        if (w.employee.currency === cur) {
          const otCost = p.lines.filter((l) => l.category === "overtime" || l.category === "double_time").reduce((a, l) => a + l.amountMinor, 0n);
          h.overtimeCost += otCost;
          h.regularCost += p.grossMinor - otCost;
        }
        total.seconds += workedSeconds(p);
        total.overtime += p.overtimeSeconds + p.doubleTimeSeconds;
        total.gross += p.grossMinor;
      }
      if (total.seconds > 0) {
        perEmployee.push({
          id: w.employee.id,
          fullName: w.employee.fullName,
          department: w.employee.departmentName,
          seconds: total.seconds,
          overtimeSeconds: total.overtime,
          gross: total.gross,
          currency: w.employee.currency,
        });
      }
    }

    // Attendance per local day: present, absent (scheduled but no shift), late, on leave.
    const start = new Date(startOfLocalDay(range.from, tz));
    const end = new Date(endOfLocalDay(range.to, tz));
    const [schedules, sessions, holidays] = await Promise.all([
      tx.shiftSchedule.findMany({ where: { workspaceId: actor.workspaceId, employee: scope, startsAt: { gte: start, lt: end } }, select: { employeeId: true, startsAt: true } }),
      tx.attendanceSession.findMany({ where: { workspaceId: actor.workspaceId, employee: scope, approvalStatus: { not: "rejected" }, clockInAt: { gte: start, lt: end } }, select: { employeeId: true, clockInAt: true, flags: true } }),
      tx.staffHoliday.findMany({ where: { workspaceId: actor.workspaceId, day: { gte: range.from, lte: range.to } }, select: { day: true } }),
    ]);
    const holidaySet = new Set(holidays.map((h) => h.day));
    const present = new Map<string, Set<string>>();
    const late = new Map<string, number>();
    for (const s of sessions) {
      const day = localDayOf(s.clockInAt.getTime(), tz);
      (present.get(day) ?? present.set(day, new Set()).get(day)!).add(s.employeeId);
      if (s.flags.includes("late")) late.set(day, (late.get(day) ?? 0) + 1);
    }
    const scheduled = new Map<string, Set<string>>();
    for (const s of schedules) {
      const day = localDayOf(s.startsAt.getTime(), tz);
      (scheduled.get(day) ?? scheduled.set(day, new Set()).get(day)!).add(s.employeeId);
    }
    const attendanceKeys = g === "hour" ? bucketsBetween(range, "day", settings.weekStartsOn) : keys;
    const attendance = new Map(attendanceKeys.map((k) => [k, { present: 0, absent: 0, late: 0, unscheduled: 0 }]));
    for (let d = range.from; d <= range.to && d <= today; d = shiftDay(d, 1)) {
      const k = g === "hour" ? d : dayKey(d);
      const a = attendance.get(k);
      if (!a) continue;
      const p = present.get(d) ?? new Set();
      const sch = scheduled.get(d) ?? new Set();
      a.present += p.size;
      a.late += late.get(d) ?? 0;
      if (!holidaySet.has(d) && d < today) for (const id of sch) if (!p.has(id)) a.absent += 1;
      for (const id of p) if (!sch.has(id)) a.unscheduled += 1;
    }

    // Paid vs owed: payments by payment date; approved payroll by the period's last day.
    const paidVsOwed = new Map(keys.map((k) => [k, { paid: 0n, owed: 0n, outstanding: 0n }]));
    if (pay) {
      const [payments, items] = await Promise.all([
        tx.payrollPayment.findMany({ where: { workspaceId: actor.workspaceId, status: "completed", currency: cur, paidOn: { gte: range.from, lte: range.to }, employee: scope }, select: { paidOn: true, amountMinor: true } }),
        tx.payrollItem.findMany({
          where: { workspaceId: actor.workspaceId, currency: cur, employee: scope, period: { status: { in: [...PAYABLE_STATUSES] }, endDate: { gte: range.from, lte: range.to } } },
          select: { netMinor: true, paidMinor: true, period: { select: { endDate: true } } },
        }),
      ]);
      for (const p of payments) {
        const b = paidVsOwed.get(g === "hour" ? `${p.paidOn}T00` : dayKey(p.paidOn));
        if (b) b.paid += p.amountMinor;
      }
      for (const i of items) {
        const b = paidVsOwed.get(g === "hour" ? `${i.period.endDate}T00` : dayKey(i.period.endDate));
        if (!b) continue;
        b.owed += i.netMinor;
        b.outstanding += i.netMinor > i.paidMinor ? i.netMinor - i.paidMinor : 0n;
      }
    }

    const money = (v: bigint) => minorToString(v, cur);
    perEmployee.sort((a, b) => (b.gross > a.gross ? 1 : b.gross < a.gross ? -1 : b.seconds - a.seconds));
    return {
      asOf: now,
      timezone: tz,
      currency: pay ? cur : null,
      range,
      granularity: g,
      allowedGranularities: allowed,
      buckets: keys.map((k) => {
        const h = hours.get(k)!;
        const p = paidVsOwed.get(k)!;
        return {
          key: k,
          label: bucketLabel(k, g),
          regularSeconds: h.regular,
          overtimeSeconds: h.overtime,
          ...(pay
            ? { regularCost: money(h.regularCost), overtimeCost: money(h.overtimeCost), cost: money(h.regularCost + h.overtimeCost), paid: money(p.paid), owed: money(p.owed), outstanding: money(p.outstanding) }
            : {}),
        };
      }),
      attendance: attendanceKeys.map((k) => ({ key: k, label: bucketLabel(k, g === "hour" ? "day" : g), ...attendance.get(k)! })),
      employees: perEmployee.slice(0, 25).map((e) => ({
        id: e.id,
        fullName: e.fullName,
        department: e.department,
        seconds: e.seconds,
        overtimeSeconds: e.overtimeSeconds,
        ...(pay ? { currency: e.currency, cost: minorToString(e.gross, e.currency) } : {}),
      })),
      notes: pay ? ["Costs are estimated gross wages from recorded hours at each day's pay rate, in " + cur + "."] : [],
    };
  });
}

/** Current base rate per employee (for the employee list and reports). */
export function rateString(rates: Array<{ effectiveFrom: string; hourlyRate: Prisma.Decimal; currency: string }>, day: string) {
  const r = [...rates].filter((x) => x.effectiveFrom <= day).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
  return r ? displayRate(decimalString(r.hourlyRate)!, r.currency) : null;
}

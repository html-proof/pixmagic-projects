import { Prisma, systemDb, withTenant, type PayrollItem, type PayrollPeriod, type StaffSettings, type Tx } from "@app/db";
import {
  dayDiff,
  EDITABLE_STATUSES,
  endOfLocalDay,
  isCalendarDay,
  localDayOf,
  minorToString,
  nextPeriod,
  PAYABLE_STATUSES,
  periodContaining,
  previousPeriod,
  startOfLocalDay,
  toMinor,
  trimDecimal,
  type PayCategory,
  type PayCycle,
  type PayrollStatus,
} from "@app/shared/staff";
import { audit } from "../notify.js";
import { advisoryLock, displayRate, notFound, serverNow, StaffError, type StaffActor } from "./common.js";
import { computeWork, loadWork } from "./calc.js";
import { ensureStaffSettings } from "./settings.js";

/**
 * Payroll runs. A period is calculated from closed shifts that count for pay (approved ones when the
 * organization requires approval), priced at the rates in force on each day, plus authorized
 * adjustments. Draft -> Pending approval -> Approved (locked: figures frozen, shifts locked) ->
 * Partly paid / Paid as payments are recorded. Figures are estimates of gross pay: no statutory
 * tax is calculated (docs/staff.md).
 */

const MAX_PERIOD_DAYS = 62;

export interface StoredLine {
  category: PayCategory;
  hourlyRate: string;
  multiplier: string;
  seconds: number;
  amountMinor: string;
}

interface ComputedItem {
  employeeId: string;
  currency: string;
  regularSeconds: number;
  overtimeSeconds: number;
  doubleTimeSeconds: number;
  holidaySeconds: number;
  paidBreakSeconds: number;
  unpaidBreakSeconds: number;
  unpricedSeconds: number;
  grossMinor: bigint;
  otherEarningsMinor: bigint;
  deductionsMinor: bigint;
  netMinor: bigint;
  lines: StoredLine[];
  sessions: Array<{ id: string; revision: number }>;
  warnings: string[];
}

async function computeItems(tx: Tx, settings: StaffSettings, period: PayrollPeriod): Promise<Map<string, ComputedItem>> {
  const range = { from: period.startDate, to: period.endDate };
  const data = await loadWork(tx, settings, { ...range, filter: "payable" });
  const work = computeWork(data, range, Date.now());
  const adjustments = await tx.payrollAdjustment.findMany({ where: { periodId: period.id, removedAt: null } });
  const out = new Map<string, ComputedItem>();
  const ensure = (employeeId: string, currency: string): ComputedItem => {
    let it = out.get(employeeId);
    if (!it) {
      it = {
        employeeId,
        currency,
        regularSeconds: 0,
        overtimeSeconds: 0,
        doubleTimeSeconds: 0,
        holidaySeconds: 0,
        paidBreakSeconds: 0,
        unpaidBreakSeconds: 0,
        unpricedSeconds: 0,
        grossMinor: 0n,
        otherEarningsMinor: 0n,
        deductionsMinor: 0n,
        netMinor: 0n,
        lines: [],
        sessions: [],
        warnings: [],
      };
      out.set(employeeId, it);
    }
    return it;
  };
  for (const [employeeId, w] of work) {
    if (!w.chunks.length) continue;
    const it = ensure(employeeId, w.employee.currency);
    it.regularSeconds = w.priced.regularSeconds;
    it.overtimeSeconds = w.priced.overtimeSeconds;
    it.doubleTimeSeconds = w.priced.doubleTimeSeconds;
    it.holidaySeconds = w.priced.holidaySeconds;
    it.paidBreakSeconds = w.paidBreakSeconds;
    it.unpaidBreakSeconds = w.unpaidBreakSeconds;
    it.unpricedSeconds = w.priced.unpricedSeconds;
    it.grossMinor = w.priced.grossMinor;
    it.lines = w.priced.lines.map((l) => ({ category: l.category, hourlyRate: l.hourlyRate, multiplier: l.multiplier, seconds: l.seconds, amountMinor: l.amountMinor.toString() }));
    it.sessions = w.sessions.sort((a, b) => a.id.localeCompare(b.id));
    if (w.priced.unpricedSeconds) it.warnings.push("missing_rate");
  }
  if (adjustments.length) {
    const employees = await tx.employee.findMany({ where: { id: { in: [...new Set(adjustments.map((a) => a.employeeId))] } }, select: { id: true, currency: true } });
    const currencyOf = new Map(employees.map((e) => [e.id, e.currency]));
    for (const a of adjustments) {
      const it = ensure(a.employeeId, currencyOf.get(a.employeeId) ?? settings.currency);
      if (a.kind === "earning") it.otherEarningsMinor += a.amountMinor;
      else it.deductionsMinor += a.amountMinor;
    }
  }
  for (const it of out.values()) {
    it.netMinor = it.grossMinor + it.otherEarningsMinor - it.deductionsMinor;
    if (it.netMinor < 0n) it.warnings.push("negative_net");
  }
  return out;
}

/** What would make approving this payroll wrong right now. */
export async function periodIssues(tx: Tx, settings: StaffSettings, period: Pick<PayrollPeriod, "id" | "workspaceId" | "startDate" | "endDate">) {
  const tz = settings.timezone;
  const start = new Date(startOfLocalDay(period.startDate, tz));
  const end = new Date(endOfLocalDay(period.endDate, tz));
  const overlap: Prisma.AttendanceSessionWhereInput = {
    workspaceId: period.workspaceId,
    clockInAt: { lt: end },
    OR: [{ clockOutAt: null }, { clockOutAt: { gt: start } }],
  };
  const [open, pending, corrections, items] = await Promise.all([
    tx.attendanceSession.findMany({ where: { ...overlap, clockOutAt: null }, include: { employee: { select: { fullName: true } } }, take: 50 }),
    settings.requireApproval
      ? tx.attendanceSession.findMany({ where: { workspaceId: period.workspaceId, clockInAt: { lt: end }, clockOutAt: { gt: start }, approvalStatus: "pending" }, include: { employee: { select: { fullName: true } } }, take: 500 })
      : Promise.resolve([]),
    tx.timesheetAdjustment.findMany({
      where: {
        workspaceId: period.workspaceId,
        status: "pending",
        OR: [{ session: { clockInAt: { lt: end }, clockOutAt: { gt: start } } }, { sessionId: null, proposedClockInAt: { gte: start, lt: end } }],
      },
      include: { employee: { select: { fullName: true } } },
      take: 200,
    }),
    tx.payrollItem.findMany({ where: { periodId: period.id }, include: { employee: { select: { fullName: true } } } }),
  ]);
  const names = (rows: Array<{ employee: { fullName: string } }>) => [...new Set(rows.map((r) => r.employee.fullName))].slice(0, 8);
  const issues: Array<{ code: string; message: string; count: number; employees: string[] }> = [];
  if (open.length) issues.push({ code: "open_shifts", message: "Shifts in this period haven't been clocked out. Set their end times in Timesheets.", count: open.length, employees: names(open) });
  if (pending.length) issues.push({ code: "unapproved_hours", message: "Hours in this period are waiting for approval. Approve or reject them in Timesheets.", count: pending.length, employees: names(pending) });
  if (corrections.length) issues.push({ code: "pending_corrections", message: "Employees asked for changes to shifts in this period. Approve or reject the requests first.", count: corrections.length, employees: names(corrections) });
  const unpriced = items.filter((i) => i.unpricedSeconds > 0);
  if (unpriced.length) issues.push({ code: "missing_rates", message: "Some worked time has no pay rate for its day. Add a pay rate for these employees, then recalculate.", count: unpriced.length, employees: names(unpriced) });
  const negative = items.filter((i) => i.netMinor < 0n);
  if (negative.length) issues.push({ code: "negative_net", message: "Deductions are larger than earnings for some employees. Check the adjustments.", count: negative.length, employees: names(negative) });
  return issues;
}

const fingerprint = (i: Pick<ComputedItem, "grossMinor" | "otherEarningsMinor" | "deductionsMinor" | "netMinor" | "regularSeconds" | "overtimeSeconds" | "doubleTimeSeconds" | "holidaySeconds" | "sessions">) =>
  [i.grossMinor, i.otherEarningsMinor, i.deductionsMinor, i.netMinor, i.regularSeconds, i.overtimeSeconds, i.doubleTimeSeconds, i.holidaySeconds, JSON.stringify(i.sessions)].join("|");

function storedFingerprint(i: PayrollItem) {
  const sessions = (i.sessions as Array<{ id: string; revision: number }> | null) ?? [];
  return fingerprint({ ...i, sessions: [...sessions].sort((a, b) => a.id.localeCompare(b.id)) });
}

async function writeItems(tx: Tx, period: PayrollPeriod, items: Map<string, ComputedItem>) {
  const existing = await tx.payrollItem.findMany({ where: { periodId: period.id }, select: { id: true, employeeId: true } });
  const keep = new Set(items.keys());
  const stale = existing.filter((e) => !keep.has(e.employeeId)).map((e) => e.id);
  if (stale.length) await tx.payrollItem.deleteMany({ where: { id: { in: stale } } });
  for (const it of items.values()) {
    const data = {
      currency: it.currency,
      regularSeconds: it.regularSeconds,
      overtimeSeconds: it.overtimeSeconds,
      doubleTimeSeconds: it.doubleTimeSeconds,
      holidaySeconds: it.holidaySeconds,
      paidBreakSeconds: it.paidBreakSeconds,
      unpaidBreakSeconds: it.unpaidBreakSeconds,
      unpricedSeconds: it.unpricedSeconds,
      grossMinor: it.grossMinor,
      otherEarningsMinor: it.otherEarningsMinor,
      deductionsMinor: it.deductionsMinor,
      netMinor: it.netMinor,
      lines: it.lines as unknown as Prisma.InputJsonValue,
      sessions: it.sessions as unknown as Prisma.InputJsonValue,
      warnings: it.warnings,
    };
    await tx.payrollItem.upsert({
      where: { periodId_employeeId: { periodId: period.id, employeeId: it.employeeId } },
      create: { workspaceId: period.workspaceId, periodId: period.id, employeeId: it.employeeId, ...data },
      update: data,
    });
  }
}

async function loadPeriod(tx: Tx, actor: StaffActor, periodId: string) {
  const p = await tx.payrollPeriod.findFirst({ where: { id: periodId, workspaceId: actor.workspaceId } });
  if (!p) throw notFound("That pay period");
  return p;
}

const isEditable = (s: string) => (EDITABLE_STATUSES as readonly string[]).includes(s);
const isPayable = (s: string) => (PAYABLE_STATUSES as readonly string[]).includes(s);

async function recalc(tx: Tx, settings: StaffSettings, period: PayrollPeriod, actor: StaffActor) {
  const items = await computeItems(tx, settings, period);
  await writeItems(tx, period, items);
  const updated = await tx.payrollPeriod.update({
    where: { id: period.id },
    data: { version: { increment: 1 }, calculatedAt: serverNow(), calculatedByUserId: actor.userId },
  });
  await tx.payrollApproval.create({ data: { workspaceId: period.workspaceId, periodId: period.id, action: "calculated", version: updated.version, actorUserId: actor.userId } });
  return updated;
}

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

type Totals = Record<string, { gross: string; otherEarnings: string; deductions: string; net: string; paid: string; outstanding: string }>;

function totalsOf(items: Array<Pick<PayrollItem, "currency" | "grossMinor" | "otherEarningsMinor" | "deductionsMinor" | "netMinor" | "paidMinor">>): Totals {
  const acc = new Map<string, { g: bigint; o: bigint; d: bigint; n: bigint; p: bigint }>();
  for (const i of items) {
    const a = acc.get(i.currency) ?? { g: 0n, o: 0n, d: 0n, n: 0n, p: 0n };
    a.g += i.grossMinor;
    a.o += i.otherEarningsMinor;
    a.d += i.deductionsMinor;
    a.n += i.netMinor;
    a.p += i.paidMinor;
    acc.set(i.currency, a);
  }
  const out: Totals = {};
  for (const [c, a] of acc) {
    const outstanding = a.n - a.p > 0n ? a.n - a.p : 0n;
    out[c] = { gross: minorToString(a.g, c), otherEarnings: minorToString(a.o, c), deductions: minorToString(a.d, c), net: minorToString(a.n, c), paid: minorToString(a.p, c), outstanding: minorToString(outstanding, c) };
  }
  return out;
}

export function periodSummary(p: PayrollPeriod, items: Array<Pick<PayrollItem, "currency" | "grossMinor" | "otherEarningsMinor" | "deductionsMinor" | "netMinor" | "paidMinor" | "regularSeconds" | "overtimeSeconds" | "doubleTimeSeconds" | "holidaySeconds" | "paidBreakSeconds" | "unpaidBreakSeconds">>) {
  const hours = items.reduce(
    (a, i) => ({
      regularSeconds: a.regularSeconds + i.regularSeconds + i.holidaySeconds,
      overtimeSeconds: a.overtimeSeconds + i.overtimeSeconds + i.doubleTimeSeconds,
      breakSeconds: a.breakSeconds + i.paidBreakSeconds + i.unpaidBreakSeconds,
    }),
    { regularSeconds: 0, overtimeSeconds: 0, breakSeconds: 0 },
  );
  return {
    id: p.id,
    startDate: p.startDate,
    endDate: p.endDate,
    payDate: p.payDate,
    payCycle: p.payCycle,
    status: p.status as PayrollStatus,
    version: p.version,
    calculatedAt: p.calculatedAt,
    submittedAt: p.submittedAt,
    approvedAt: p.approvedAt,
    locked: !!p.lockedAt,
    notes: p.notes,
    employees: items.length,
    ...hours,
    totals: totalsOf(items),
  };
}

export async function listPeriods(actor: StaffActor, opts: { status?: string; page: number; pageSize: number }) {
  return withTenant(actor.workspaceId, async (tx) => {
    const where: Prisma.PayrollPeriodWhereInput = { workspaceId: actor.workspaceId, ...(opts.status ? { status: opts.status } : {}) };
    const [total, periods] = await Promise.all([
      tx.payrollPeriod.count({ where }),
      tx.payrollPeriod.findMany({ where, orderBy: [{ startDate: "desc" }, { createdAt: "desc" }], skip: (opts.page - 1) * opts.pageSize, take: opts.pageSize, include: { items: true } }),
    ]);
    return { total, page: opts.page, pageSize: opts.pageSize, items: periods.map((p) => periodSummary(p, p.items)) };
  });
}

/** The periods the payroll page offers to create: the last finished one, the current one, and the next un-run one. */
export async function suggestPeriods(actor: StaffActor) {
  const settings = await ensureStaffSettings(actor.workspaceId);
  const today = localDayOf(Date.now(), settings.timezone);
  const cycle = settings.payCycle as PayCycle;
  const current = periodContaining(today, cycle, settings.payCycleAnchor);
  const previous = previousPeriod(current, cycle, settings.payCycleAnchor);
  const latest = await withTenant(actor.workspaceId, (tx) =>
    tx.payrollPeriod.findFirst({ where: { workspaceId: actor.workspaceId, status: { notIn: ["cancelled", "reversed"] } }, orderBy: { endDate: "desc" } }),
  );
  const next = latest ? nextPeriod({ from: latest.startDate, to: latest.endDate }, cycle, settings.payCycleAnchor) : previous;
  return { payCycle: cycle, today, current, previous, next, lastRun: latest ? { from: latest.startDate, to: latest.endDate, status: latest.status } : null };
}

export async function getPeriod(actor: StaffActor, periodId: string) {
  const settings = await ensureStaffSettings(actor.workspaceId);
  return withTenant(actor.workspaceId, async (tx) => {
    const p = await tx.payrollPeriod.findFirst({
      where: { id: periodId, workspaceId: actor.workspaceId },
      include: {
        items: { include: { employee: { select: { id: true, fullName: true, employeeNumber: true, jobTitle: true, department: { select: { name: true } } } } }, orderBy: { employee: { fullName: "asc" } } },
        adjustments: { where: { removedAt: null }, orderBy: { createdAt: "asc" } },
        approvals: { orderBy: { createdAt: "desc" } },
      },
    });
    if (!p) throw notFound("That pay period");
    const issues = isEditable(p.status) || p.status === "pending_approval" ? await periodIssues(tx, settings, p) : [];
    const userIds = [...new Set([...p.approvals.map((a) => a.actorUserId), ...p.adjustments.map((a) => a.createdByUserId)].filter(Boolean))] as string[];
    const users = await systemDb.user.findMany({ where: { id: { in: userIds } }, select: { id: true, displayName: true, email: true } });
    const name = (id: string | null) => (id ? (users.find((u) => u.id === id)?.displayName ?? users.find((u) => u.id === id)?.email ?? "Someone") : "Insights");
    const failed = await tx.payrollPayment.findMany({ where: { workspaceId: actor.workspaceId, status: "failed", allocations: { some: { item: { periodId: p.id } } } }, select: { employeeId: true } });
    const failedFor = new Set(failed.map((f) => f.employeeId));
    return {
      ...periodSummary(p, p.items),
      timezone: p.timezone,
      issues,
      items: p.items.map((i) => {
        const outstanding = i.netMinor - i.paidMinor > 0n ? i.netMinor - i.paidMinor : 0n;
        return {
          id: i.id,
          employee: { id: i.employee.id, fullName: i.employee.fullName, employeeNumber: i.employee.employeeNumber, jobTitle: i.employee.jobTitle, department: i.employee.department?.name ?? null },
          currency: i.currency,
          regularSeconds: i.regularSeconds,
          overtimeSeconds: i.overtimeSeconds,
          doubleTimeSeconds: i.doubleTimeSeconds,
          holidaySeconds: i.holidaySeconds,
          paidBreakSeconds: i.paidBreakSeconds,
          unpaidBreakSeconds: i.unpaidBreakSeconds,
          unpricedSeconds: i.unpricedSeconds,
          gross: minorToString(i.grossMinor, i.currency),
          otherEarnings: minorToString(i.otherEarningsMinor, i.currency),
          deductions: minorToString(i.deductionsMinor, i.currency),
          net: minorToString(i.netMinor, i.currency),
          paid: minorToString(i.paidMinor, i.currency),
          outstanding: minorToString(outstanding, i.currency),
          paymentStatus: i.netMinor <= 0n ? "nothing_owed" : i.paidMinor >= i.netMinor ? "paid" : i.paidMinor > 0n ? "partially_paid" : failedFor.has(i.employeeId) ? "failed" : "unpaid",
          lines: ((i.lines as unknown as StoredLine[]) ?? []).map((l) => ({
            category: l.category,
            hourlyRate: displayRate(l.hourlyRate, i.currency),
            multiplier: trimDecimal(l.multiplier),
            seconds: l.seconds,
            amount: minorToString(BigInt(l.amountMinor), i.currency),
          })),
          warnings: i.warnings,
          shifts: ((i.sessions as Array<{ id: string }> | null) ?? []).length,
        };
      }),
      adjustments: p.adjustments.map((a) => {
        const item = p.items.find((i) => i.employeeId === a.employeeId);
        const currency = item?.currency ?? settings.currency;
        return { id: a.id, employeeId: a.employeeId, kind: a.kind, label: a.label, amount: minorToString(a.amountMinor, currency), currency, reason: a.reason, createdBy: name(a.createdByUserId), createdAt: a.createdAt };
      }),
      history: p.approvals.map((a) => ({ id: a.id, action: a.action, version: a.version, by: name(a.actorUserId), comment: a.comment, at: a.createdAt })),
      estimateNotice: "Gross pay is calculated from approved hours and pay rates. Insights doesn't calculate tax or statutory deductions; net pay is gross plus the earnings and deductions you add.",
    };
  });
}

// ---------------------------------------------------------------------------------------------
// The workflow
// ---------------------------------------------------------------------------------------------

export async function createPeriod(actor: StaffActor, input: { startDate: string; endDate: string; payDate?: string | null; notes?: string | null }) {
  const settings = await ensureStaffSettings(actor.workspaceId);
  if (!isCalendarDay(input.startDate) || !isCalendarDay(input.endDate)) throw new StaffError(400, "invalid_date", "Choose the period's first and last day.");
  if (input.startDate > input.endDate) throw new StaffError(400, "invalid_date", "The period has to end on or after the day it starts.");
  if (dayDiff(input.startDate, input.endDate) + 1 > MAX_PERIOD_DAYS) throw new StaffError(400, "too_long", `A pay period can be at most ${MAX_PERIOD_DAYS} days.`);
  if (input.payDate && !isCalendarDay(input.payDate)) throw new StaffError(400, "invalid_date", "Choose a valid pay date.");
  const today = localDayOf(Date.now(), settings.timezone);
  if (input.startDate > today) throw new StaffError(400, "future_period", "A pay period can't start in the future.");
  const period = await withTenant(actor.workspaceId, async (tx) => {
    await advisoryLock(tx, `payroll:${actor.workspaceId}`);
    const overlap = await tx.payrollPeriod.findFirst({
      where: { workspaceId: actor.workspaceId, status: { notIn: ["cancelled", "reversed"] }, startDate: { lte: input.endDate }, endDate: { gte: input.startDate } },
    });
    if (overlap) {
      throw new StaffError(409, "overlap", `That overlaps the pay period ${overlap.startDate} to ${overlap.endDate}. Each day can only be in one live payroll, so hours are never paid twice.`, { periodId: overlap.id });
    }
    const p = await tx.payrollPeriod.create({
      data: {
        workspaceId: actor.workspaceId,
        startDate: input.startDate,
        endDate: input.endDate,
        payDate: input.payDate ?? null,
        payCycle: settings.payCycle,
        timezone: settings.timezone,
        notes: input.notes ?? null,
        createdByUserId: actor.userId,
      },
    });
    return recalc(tx, settings, p, actor);
  });
  await audit({ workspaceId: actor.workspaceId, actorUserId: actor.userId, action: "payroll.period_created", targetType: "payroll_period", targetId: period.id, metadata: { from: period.startDate, to: period.endDate }, ip: actor.ip });
  return getPeriod(actor, period.id);
}

export async function calculatePeriod(actor: StaffActor, periodId: string) {
  const settings = await ensureStaffSettings(actor.workspaceId);
  await withTenant(actor.workspaceId, async (tx) => {
    await advisoryLock(tx, `payroll:${actor.workspaceId}`);
    const p = await loadPeriod(tx, actor, periodId);
    if (!isEditable(p.status)) throw new StaffError(409, "not_editable", "This payroll is no longer a draft, so it can't be recalculated.");
    await recalc(tx, settings, p, actor);
  });
  await audit({ workspaceId: actor.workspaceId, actorUserId: actor.userId, action: "payroll.calculated", targetType: "payroll_period", targetId: periodId, ip: actor.ip });
  return getPeriod(actor, periodId);
}

export async function submitPeriod(actor: StaffActor, periodId: string, comment: string | null) {
  const settings = await ensureStaffSettings(actor.workspaceId);
  await withTenant(actor.workspaceId, async (tx) => {
    await advisoryLock(tx, `payroll:${actor.workspaceId}`);
    const p = await loadPeriod(tx, actor, periodId);
    if (!isEditable(p.status)) throw new StaffError(409, "not_editable", "Only a draft payroll can be sent for approval.");
    // Approving locks the period's days, so it has to be over: a shift clocked later on one of them would never be paid.
    if (p.endDate >= localDayOf(Date.now(), settings.timezone)) {
      throw new StaffError(409, "period_not_over", `This pay period runs until ${p.endDate}. You can send it for approval once it has ended.`);
    }
    const updated = await recalc(tx, settings, p, actor);
    const issues = await periodIssues(tx, settings, p);
    if (issues.length) throw new StaffError(409, "blocking_issues", "Sort out these things before sending the payroll for approval.", { issues });
    const items = await tx.payrollItem.count({ where: { periodId } });
    if (!items) throw new StaffError(409, "empty", "There's nothing to pay in this period: no approved hours or adjustments.");
    await tx.payrollPeriod.update({ where: { id: periodId }, data: { status: "pending_approval", submittedAt: serverNow(), submittedByUserId: actor.userId } });
    await tx.payrollApproval.create({ data: { workspaceId: actor.workspaceId, periodId, action: "submitted", version: updated.version, actorUserId: actor.userId, comment } });
  });
  await audit({ workspaceId: actor.workspaceId, actorUserId: actor.userId, action: "payroll.submitted", targetType: "payroll_period", targetId: periodId, ip: actor.ip });
  return getPeriod(actor, periodId);
}

/**
 * Approve and lock. `version` must be the one the approver reviewed, and the figures are
 * recalculated from the database at this moment: if any hours, rates or adjustments changed since
 * they were calculated, nothing is approved and the payroll has to be reviewed again.
 */
export async function approvePeriod(actor: StaffActor, periodId: string, version: number, comment: string | null) {
  const settings = await ensureStaffSettings(actor.workspaceId);
  const now = serverNow();
  await withTenant(actor.workspaceId, async (tx) => {
    await advisoryLock(tx, `payroll:${actor.workspaceId}`);
    const p = await loadPeriod(tx, actor, periodId);
    if (p.status !== "pending_approval") throw new StaffError(409, "not_pending", "Only a payroll waiting for approval can be approved. Send it for approval first.");
    if (p.version !== version) throw new StaffError(409, "stale_version", "The payroll was recalculated after you opened it. Review the new figures, then approve.");
    const issues = await periodIssues(tx, settings, p);
    if (issues.length) throw new StaffError(409, "blocking_issues", "Hours changed after this payroll was submitted. Sort these out first.", { issues });
    const fresh = await computeItems(tx, settings, p);
    const stored = await tx.payrollItem.findMany({ where: { periodId } });
    const same = stored.length === fresh.size && stored.every((s) => {
      const f = fresh.get(s.employeeId);
      return f && fingerprint(f) === storedFingerprint(s);
    });
    if (!same) {
      await tx.payrollPeriod.update({ where: { id: periodId }, data: { status: "correction_required" } });
      await tx.payrollApproval.create({ data: { workspaceId: actor.workspaceId, periodId, action: "rejected", version: p.version, actorUserId: actor.userId, comment: "Hours or rates changed after calculation; recalculate and review again." } });
      return;
    }
    await tx.payrollPeriod.update({ where: { id: periodId }, data: { status: "approved", approvedAt: now, approvedByUserId: actor.userId, lockedAt: now } });
    const sessionIds = stored.flatMap((s) => ((s.sessions as Array<{ id: string }> | null) ?? []).map((x) => x.id));
    if (sessionIds.length) await tx.attendanceSession.updateMany({ where: { id: { in: sessionIds }, workspaceId: actor.workspaceId, lockedAt: null }, data: { lockedAt: now } });
    await tx.payrollApproval.create({ data: { workspaceId: actor.workspaceId, periodId, action: "approved", version: p.version, actorUserId: actor.userId, comment } });
  });
  const after = await getPeriod(actor, periodId);
  if (after.status === "correction_required") {
    throw new StaffError(409, "figures_changed", "Hours, rates or adjustments changed after this payroll was calculated, so it wasn't approved. It's back in draft: recalculate and review it again.");
  }
  await audit({ workspaceId: actor.workspaceId, actorUserId: actor.userId, action: "payroll.approved", targetType: "payroll_period", targetId: periodId, metadata: { version }, ip: actor.ip });
  return after;
}

export async function rejectPeriod(actor: StaffActor, periodId: string, comment: string) {
  await withTenant(actor.workspaceId, async (tx) => {
    const p = await loadPeriod(tx, actor, periodId);
    if (p.status !== "pending_approval") throw new StaffError(409, "not_pending", "Only a payroll waiting for approval can be sent back.");
    await tx.payrollPeriod.update({ where: { id: periodId }, data: { status: "correction_required" } });
    await tx.payrollApproval.create({ data: { workspaceId: actor.workspaceId, periodId, action: "rejected", version: p.version, actorUserId: actor.userId, comment } });
  });
  await audit({ workspaceId: actor.workspaceId, actorUserId: actor.userId, action: "payroll.rejected", targetType: "payroll_period", targetId: periodId, ip: actor.ip });
  return getPeriod(actor, periodId);
}

export async function cancelPeriod(actor: StaffActor, periodId: string, comment: string | null) {
  await withTenant(actor.workspaceId, async (tx) => {
    const p = await loadPeriod(tx, actor, periodId);
    if (!isEditable(p.status) && p.status !== "pending_approval") throw new StaffError(409, "not_cancellable", "Approved payroll can't be cancelled. Reverse it instead (only possible before any payment is recorded).");
    await tx.payrollPeriod.update({ where: { id: periodId }, data: { status: "cancelled", cancelledAt: serverNow() } });
    await tx.payrollApproval.create({ data: { workspaceId: actor.workspaceId, periodId, action: "cancelled", version: p.version, actorUserId: actor.userId, comment } });
  });
  await audit({ workspaceId: actor.workspaceId, actorUserId: actor.userId, action: "payroll.cancelled", targetType: "payroll_period", targetId: periodId, ip: actor.ip });
  return getPeriod(actor, periodId);
}

/** Undo an approval that hasn't been paid from: the shifts unlock and the days can be run again. */
export async function reversePeriod(actor: StaffActor, periodId: string, comment: string) {
  await withTenant(actor.workspaceId, async (tx) => {
    await advisoryLock(tx, `payroll:${actor.workspaceId}`);
    const p = await loadPeriod(tx, actor, periodId);
    if (!isPayable(p.status)) throw new StaffError(409, "not_reversible", "Only approved payroll can be reversed.");
    const paid = await tx.paymentAllocation.count({ where: { item: { periodId }, payment: { status: "completed" } } });
    if (paid) throw new StaffError(409, "has_payments", "Payments are recorded against this payroll. Reverse those payments first.");
    await tx.payrollPeriod.update({ where: { id: periodId }, data: { status: "reversed", lockedAt: null } });
    const items = await tx.payrollItem.findMany({ where: { periodId }, select: { sessions: true } });
    const ids = items.flatMap((i) => ((i.sessions as Array<{ id: string }> | null) ?? []).map((s) => s.id));
    for (const id of ids) {
      const stillLocked = await tx.$queryRaw<Array<{ n: bigint }>>`
        SELECT count(*) AS n FROM payroll_items i JOIN payroll_periods pp ON pp.id = i.period_id
         WHERE pp.locked_at IS NOT NULL AND pp.id <> ${periodId} AND i.sessions @> ${JSON.stringify([{ id }])}::jsonb`;
      if (!Number(stillLocked[0]?.n ?? 0)) await tx.attendanceSession.updateMany({ where: { id, workspaceId: actor.workspaceId }, data: { lockedAt: null } });
    }
    await tx.payrollApproval.create({ data: { workspaceId: actor.workspaceId, periodId, action: "reversed", version: p.version, actorUserId: actor.userId, comment } });
  });
  await audit({ workspaceId: actor.workspaceId, actorUserId: actor.userId, action: "payroll.reversed", targetType: "payroll_period", targetId: periodId, metadata: { comment }, ip: actor.ip });
  return getPeriod(actor, periodId);
}

// ---------------------------------------------------------------------------------------------
// Adjustments
// ---------------------------------------------------------------------------------------------

export async function addAdjustment(actor: StaffActor, periodId: string, input: { employeeId: string; kind: "earning" | "deduction"; label: string; amount: string; reason?: string | null }) {
  const settings = await ensureStaffSettings(actor.workspaceId);
  await withTenant(actor.workspaceId, async (tx) => {
    await advisoryLock(tx, `payroll:${actor.workspaceId}`);
    const p = await loadPeriod(tx, actor, periodId);
    if (!isEditable(p.status)) throw new StaffError(409, "not_editable", "Adjustments can only be added while the payroll is a draft.");
    const e = await tx.employee.findFirst({ where: { id: input.employeeId, workspaceId: actor.workspaceId } });
    if (!e) throw notFound("That employee");
    let amountMinor: bigint;
    try {
      amountMinor = toMinor(input.amount, e.currency);
    } catch {
      throw new StaffError(400, "invalid_amount", `Enter the amount in ${e.currency}, like 50 or 50.00.`);
    }
    if (amountMinor <= 0n) throw new StaffError(400, "invalid_amount", "The amount has to be more than zero.");
    await tx.payrollAdjustment.create({
      data: { workspaceId: actor.workspaceId, periodId, employeeId: e.id, kind: input.kind, label: input.label, amountMinor, reason: input.reason ?? null, createdByUserId: actor.userId },
    });
    await recalc(tx, settings, p, actor);
  });
  await audit({ workspaceId: actor.workspaceId, actorUserId: actor.userId, action: "payroll.adjustment_added", targetType: "employee", targetId: input.employeeId, metadata: { periodId, kind: input.kind, label: input.label }, ip: actor.ip });
  return getPeriod(actor, periodId);
}

export async function removeAdjustment(actor: StaffActor, periodId: string, adjustmentId: string) {
  const settings = await ensureStaffSettings(actor.workspaceId);
  let employeeId = "";
  await withTenant(actor.workspaceId, async (tx) => {
    await advisoryLock(tx, `payroll:${actor.workspaceId}`);
    const p = await loadPeriod(tx, actor, periodId);
    if (!isEditable(p.status)) throw new StaffError(409, "not_editable", "Adjustments can only be removed while the payroll is a draft.");
    const a = await tx.payrollAdjustment.findFirst({ where: { id: adjustmentId, periodId, removedAt: null } });
    if (!a) throw notFound("That adjustment");
    employeeId = a.employeeId;
    await tx.payrollAdjustment.update({ where: { id: a.id }, data: { removedAt: serverNow(), removedByUserId: actor.userId } });
    await recalc(tx, settings, p, actor);
  });
  await audit({ workspaceId: actor.workspaceId, actorUserId: actor.userId, action: "payroll.adjustment_removed", targetType: "employee", targetId: employeeId, metadata: { periodId }, ip: actor.ip });
  return getPeriod(actor, periodId);
}

/** Re-derive a payable period's status from what has been paid (inside the payment's transaction). */
export async function refreshPeriodStatus(tx: Tx, periodId: string) {
  const p = await tx.payrollPeriod.findUnique({ where: { id: periodId } });
  if (!p || !isPayable(p.status)) return;
  const items = await tx.payrollItem.findMany({ where: { periodId }, select: { netMinor: true, paidMinor: true } });
  const owed = items.filter((i) => i.netMinor > 0n);
  const anyPaid = items.some((i) => i.paidMinor > 0n);
  let status: PayrollStatus;
  if (owed.length && owed.every((i) => i.paidMinor >= i.netMinor)) status = "paid";
  else if (anyPaid) status = "partially_paid";
  else {
    const failed = await tx.payrollPayment.count({ where: { status: "failed", allocations: { some: { item: { periodId } } } } });
    status = failed ? "payment_failed" : "approved";
  }
  if (status !== p.status) await tx.payrollPeriod.update({ where: { id: periodId }, data: { status } });
}

/** Employees' own pay history: approved periods only (drafts are never shown to employees). */
export async function myPay(employeeId: string, workspaceId: string) {
  return withTenant(workspaceId, async (tx) => {
    const items = await tx.payrollItem.findMany({
      where: { workspaceId, employeeId, period: { status: { in: [...PAYABLE_STATUSES] } } },
      include: { period: true, allocations: { include: { payment: true } } },
      orderBy: { period: { startDate: "desc" } },
      take: 100,
    });
    return items.map((i) => ({
      id: i.id,
      period: { id: i.period.id, from: i.period.startDate, to: i.period.endDate, payDate: i.period.payDate, status: i.period.status },
      currency: i.currency,
      regularSeconds: i.regularSeconds + i.holidaySeconds,
      overtimeSeconds: i.overtimeSeconds + i.doubleTimeSeconds,
      gross: minorToString(i.grossMinor, i.currency),
      otherEarnings: minorToString(i.otherEarningsMinor, i.currency),
      deductions: minorToString(i.deductionsMinor, i.currency),
      net: minorToString(i.netMinor, i.currency),
      paid: minorToString(i.paidMinor, i.currency),
      outstanding: minorToString(i.netMinor > i.paidMinor ? i.netMinor - i.paidMinor : 0n, i.currency),
      payments: i.allocations.map((a) => ({ id: a.payment.id, amount: minorToString(a.amountMinor, i.currency), paidOn: a.payment.paidOn, method: a.payment.method, status: a.payment.status })),
    }));
  });
}

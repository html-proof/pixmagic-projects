import { Prisma, systemDb, withTenant } from "@app/db";
import {
  isCalendarDay,
  isCurrencyCode,
  isDecimal,
  isTimeZone,
  localDayOf,
  MULTIPLIER_SCALE,
  PAY_CYCLES,
  shiftDay,
  startOfLocalDay,
  zonedTimeToUtc,
  type PayCycle,
} from "@app/shared/staff";
import { audit } from "../notify.js";
import { employeeScope, isUniqueViolation, notFound, scopedEmployee, StaffError, type StaffActor } from "./common.js";
import { breakPolicyView, ensureStaffSettings, overtimePolicyView, settingsView } from "./settings.js";

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------

export interface SettingsPatch {
  timezone?: string;
  currency?: string;
  payCycle?: PayCycle;
  payCycleAnchor?: string;
  weekStartsOn?: number;
  invitationExpiryHours?: number;
  staleSessionHours?: number;
  lateGraceMinutes?: number;
  requireApproval?: boolean;
  allowEmployeeCorrections?: boolean;
  jurisdiction?: string | null;
  supportEmail?: string | null;
  defaultOvertimePolicyId?: string | null;
  defaultBreakPolicyId?: string | null;
}

export async function getStaffConfig(actor: StaffActor) {
  const s = await ensureStaffSettings(actor.workspaceId);
  return withTenant(actor.workspaceId, async (tx) => {
    const [departments, overtime, breaks, holidays] = await Promise.all([
      tx.department.findMany({ where: { workspaceId: actor.workspaceId }, orderBy: { name: "asc" }, include: { _count: { select: { employees: true } } } }),
      tx.overtimePolicy.findMany({ where: { workspaceId: actor.workspaceId }, orderBy: { name: "asc" } }),
      tx.breakPolicy.findMany({ where: { workspaceId: actor.workspaceId }, orderBy: { name: "asc" } }),
      tx.staffHoliday.findMany({ where: { workspaceId: actor.workspaceId, day: { gte: shiftDay(localDayOf(Date.now(), s.timezone), -400) } }, orderBy: { day: "asc" } }),
    ]);
    return {
      settings: settingsView(s),
      departments: departments.map((d) => ({ id: d.id, name: d.name, employees: d._count.employees })),
      overtimePolicies: overtime.map(overtimePolicyView),
      breakPolicies: breaks.map(breakPolicyView),
      holidays: holidays.map((h) => ({ id: h.id, day: h.day, name: h.name })),
    };
  });
}

export async function updateStaffSettings(actor: StaffActor, patch: SettingsPatch) {
  await ensureStaffSettings(actor.workspaceId);
  if (patch.timezone !== undefined && !isTimeZone(patch.timezone)) throw new StaffError(400, "invalid_timezone", "Choose a time zone from the list.");
  if (patch.currency !== undefined && !isCurrencyCode(patch.currency)) throw new StaffError(400, "invalid_currency", "Choose a currency from the list.");
  if (patch.payCycle !== undefined && !PAY_CYCLES.includes(patch.payCycle)) throw new StaffError(400, "invalid_cycle", "Choose how often you pay.");
  if (patch.payCycleAnchor !== undefined && !isCalendarDay(patch.payCycleAnchor)) throw new StaffError(400, "invalid_date", "Choose the day a pay period starts.");
  await withTenant(actor.workspaceId, async (tx) => {
    if (patch.defaultOvertimePolicyId && !(await tx.overtimePolicy.count({ where: { id: patch.defaultOvertimePolicyId, workspaceId: actor.workspaceId } }))) throw notFound("That overtime policy");
    if (patch.defaultBreakPolicyId && !(await tx.breakPolicy.count({ where: { id: patch.defaultBreakPolicyId, workspaceId: actor.workspaceId } }))) throw notFound("That break policy");
    if (patch.timezone !== undefined || patch.payCycle !== undefined || patch.payCycleAnchor !== undefined || patch.weekStartsOn !== undefined) {
      const live = await tx.payrollPeriod.count({ where: { workspaceId: actor.workspaceId, status: { in: ["draft", "pending_approval", "correction_required"] } } });
      if (live) throw new StaffError(409, "payroll_in_progress", "Finish or cancel the payroll in progress before changing the time zone, week start or pay cycle.");
    }
    await tx.staffSettings.update({ where: { workspaceId: actor.workspaceId }, data: { ...patch, updatedByUserId: actor.userId } });
  });
  await audit({ workspaceId: actor.workspaceId, actorUserId: actor.userId, action: "staff.settings_updated", metadata: { fields: Object.keys(patch) }, ip: actor.ip });
  return getStaffConfig(actor);
}

// ---------------------------------------------------------------------------------------------
// Departments
// ---------------------------------------------------------------------------------------------

export async function createDepartment(actor: StaffActor, name: string) {
  try {
    const d = await withTenant(actor.workspaceId, (tx) => tx.department.create({ data: { workspaceId: actor.workspaceId, name: name.trim() } }));
    return { id: d.id, name: d.name, employees: 0 };
  } catch (err) {
    if (isUniqueViolation(err)) throw new StaffError(409, "exists", "There's already a department with that name.");
    throw err;
  }
}

export async function renameDepartment(actor: StaffActor, id: string, name: string) {
  try {
    const n = await withTenant(actor.workspaceId, (tx) => tx.department.updateMany({ where: { id, workspaceId: actor.workspaceId }, data: { name: name.trim() } }));
    if (!n.count) throw notFound("That department");
  } catch (err) {
    if (isUniqueViolation(err)) throw new StaffError(409, "exists", "There's already a department with that name.");
    throw err;
  }
  return { ok: true };
}

export async function deleteDepartment(actor: StaffActor, id: string) {
  const n = await withTenant(actor.workspaceId, (tx) => tx.department.deleteMany({ where: { id, workspaceId: actor.workspaceId } }));
  if (!n.count) throw notFound("That department");
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// Overtime and break policies
// ---------------------------------------------------------------------------------------------

export interface OvertimePolicyInput {
  name: string;
  dailyThresholdMinutes: number | null;
  weeklyThresholdMinutes: number | null;
  multiplier: string;
  doubleTimeDailyThresholdMinutes: number | null;
  doubleTimeMultiplier: string | null;
  holidayMultiplier: string;
}

function checkMultiplier(v: string | null, label: string) {
  if (v === null) return;
  if (!isDecimal(v, MULTIPLIER_SCALE) || Number(v) < 1 || Number(v) > 10) throw new StaffError(400, "invalid_multiplier", `${label} has to be a number from 1 to 10, like 1.5.`);
}

function checkOvertime(p: OvertimePolicyInput) {
  checkMultiplier(p.multiplier, "The overtime rate");
  checkMultiplier(p.doubleTimeMultiplier, "The double-time rate");
  checkMultiplier(p.holidayMultiplier, "The holiday rate");
  if ((p.doubleTimeDailyThresholdMinutes === null) !== (p.doubleTimeMultiplier === null)) {
    throw new StaffError(400, "invalid_policy", "Give double time both an hours threshold and a rate, or neither.");
  }
  if (p.doubleTimeDailyThresholdMinutes !== null && p.dailyThresholdMinutes !== null && p.doubleTimeDailyThresholdMinutes <= p.dailyThresholdMinutes) {
    throw new StaffError(400, "invalid_policy", "Double time has to start after daily overtime does.");
  }
}

export async function saveOvertimePolicy(actor: StaffActor, id: string | null, input: OvertimePolicyInput) {
  checkOvertime(input);
  const data = {
    name: input.name.trim(),
    dailyThresholdMinutes: input.dailyThresholdMinutes,
    weeklyThresholdMinutes: input.weeklyThresholdMinutes,
    multiplier: new Prisma.Decimal(input.multiplier),
    doubleTimeDailyThresholdMinutes: input.doubleTimeDailyThresholdMinutes,
    doubleTimeMultiplier: input.doubleTimeMultiplier === null ? null : new Prisma.Decimal(input.doubleTimeMultiplier),
    holidayMultiplier: new Prisma.Decimal(input.holidayMultiplier),
  };
  try {
    const p = await withTenant(actor.workspaceId, async (tx) => {
      if (!id) return tx.overtimePolicy.create({ data: { workspaceId: actor.workspaceId, ...data } });
      const existing = await tx.overtimePolicy.findFirst({ where: { id, workspaceId: actor.workspaceId } });
      if (!existing) throw notFound("That overtime policy");
      return tx.overtimePolicy.update({ where: { id }, data });
    });
    await audit({ workspaceId: actor.workspaceId, actorUserId: actor.userId, action: id ? "staff.overtime_policy_updated" : "staff.overtime_policy_created", targetType: "overtime_policy", targetId: p.id, metadata: { ...input }, ip: actor.ip });
    return overtimePolicyView(p);
  } catch (err) {
    if (isUniqueViolation(err)) throw new StaffError(409, "exists", "There's already a policy with that name.");
    throw err;
  }
}

export async function deleteOvertimePolicy(actor: StaffActor, id: string) {
  await withTenant(actor.workspaceId, async (tx) => {
    const n = await tx.overtimePolicy.deleteMany({ where: { id, workspaceId: actor.workspaceId } });
    if (!n.count) throw notFound("That overtime policy");
    await tx.staffSettings.updateMany({ where: { workspaceId: actor.workspaceId, defaultOvertimePolicyId: id }, data: { defaultOvertimePolicyId: null } });
  });
  await audit({ workspaceId: actor.workspaceId, actorUserId: actor.userId, action: "staff.overtime_policy_deleted", targetType: "overtime_policy", targetId: id, ip: actor.ip });
  return { ok: true };
}

export interface BreakPolicyInput {
  name: string;
  restBreaksPaid: boolean;
  mealBreaksPaid: boolean;
  maxBreaksPerShift: number | null;
  maxBreakMinutes: number | null;
}

export async function saveBreakPolicy(actor: StaffActor, id: string | null, input: BreakPolicyInput) {
  const data = { ...input, name: input.name.trim() };
  try {
    const p = await withTenant(actor.workspaceId, async (tx) => {
      if (!id) return tx.breakPolicy.create({ data: { workspaceId: actor.workspaceId, ...data } });
      const existing = await tx.breakPolicy.findFirst({ where: { id, workspaceId: actor.workspaceId } });
      if (!existing) throw notFound("That break policy");
      return tx.breakPolicy.update({ where: { id }, data });
    });
    await audit({ workspaceId: actor.workspaceId, actorUserId: actor.userId, action: id ? "staff.break_policy_updated" : "staff.break_policy_created", targetType: "break_policy", targetId: p.id, metadata: { ...input }, ip: actor.ip });
    return breakPolicyView(p);
  } catch (err) {
    if (isUniqueViolation(err)) throw new StaffError(409, "exists", "There's already a policy with that name.");
    throw err;
  }
}

export async function deleteBreakPolicy(actor: StaffActor, id: string) {
  await withTenant(actor.workspaceId, async (tx) => {
    const n = await tx.breakPolicy.deleteMany({ where: { id, workspaceId: actor.workspaceId } });
    if (!n.count) throw notFound("That break policy");
    await tx.staffSettings.updateMany({ where: { workspaceId: actor.workspaceId, defaultBreakPolicyId: id }, data: { defaultBreakPolicyId: null } });
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// Holidays
// ---------------------------------------------------------------------------------------------

export async function addHoliday(actor: StaffActor, day: string, name: string) {
  if (!isCalendarDay(day)) throw new StaffError(400, "invalid_date", "Choose the holiday's date.");
  try {
    const h = await withTenant(actor.workspaceId, async (tx) => {
      const locked = await tx.payrollPeriod.findFirst({ where: { workspaceId: actor.workspaceId, lockedAt: { not: null }, startDate: { lte: day }, endDate: { gte: day } } });
      if (locked) throw new StaffError(409, "period_locked", "Payroll for that day is already approved, so its holiday pay can't change.");
      return tx.staffHoliday.create({ data: { workspaceId: actor.workspaceId, day, name: name.trim() } });
    });
    await audit({ workspaceId: actor.workspaceId, actorUserId: actor.userId, action: "staff.holiday_added", metadata: { day, name }, ip: actor.ip });
    return { id: h.id, day: h.day, name: h.name };
  } catch (err) {
    if (isUniqueViolation(err)) throw new StaffError(409, "exists", "That day is already a holiday.");
    throw err;
  }
}

export async function deleteHoliday(actor: StaffActor, id: string) {
  await withTenant(actor.workspaceId, async (tx) => {
    const h = await tx.staffHoliday.findFirst({ where: { id, workspaceId: actor.workspaceId } });
    if (!h) throw notFound("That holiday");
    const locked = await tx.payrollPeriod.findFirst({ where: { workspaceId: actor.workspaceId, lockedAt: { not: null }, startDate: { lte: h.day }, endDate: { gte: h.day } } });
    if (locked) throw new StaffError(409, "period_locked", "Payroll for that day is already approved, so its holiday pay can't change.");
    await tx.staffHoliday.delete({ where: { id } });
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// Shift schedules
// ---------------------------------------------------------------------------------------------

export interface ShiftScheduleInput {
  employeeId: string;
  /** Local day and wall-clock times in the organization's zone; an end before the start means overnight. */
  day: string;
  startTime: string;
  endTime: string;
  breakMinutes: number;
  location?: string | null;
  note?: string | null;
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function scheduleTimes(input: Pick<ShiftScheduleInput, "day" | "startTime" | "endTime">, tz: string) {
  const a = TIME_RE.exec(input.startTime);
  const b = TIME_RE.exec(input.endTime);
  if (!isCalendarDay(input.day) || !a || !b) throw new StaffError(400, "invalid_time", "Choose a day and start and end times.");
  const startsAt = new Date(zonedTimeToUtc(input.day, Number(a[1]), Number(a[2]), tz));
  const endDay = input.endTime <= input.startTime ? shiftDay(input.day, 1) : input.day;
  const endsAt = new Date(zonedTimeToUtc(endDay, Number(b[1]), Number(b[2]), tz));
  if (endsAt.getTime() - startsAt.getTime() > 24 * 3_600_000) throw new StaffError(400, "too_long", "A shift can't be longer than 24 hours.");
  return { startsAt, endsAt };
}

function scheduleView(s: { id: string; employeeId: string; startsAt: Date; endsAt: Date; breakMinutes: number; location: string | null; note: string | null; employee?: { fullName: string; jobTitle: string } }, tz: string) {
  return {
    id: s.id,
    employeeId: s.employeeId,
    employee: s.employee ? { fullName: s.employee.fullName, jobTitle: s.employee.jobTitle } : undefined,
    day: localDayOf(s.startsAt.getTime(), tz),
    startsAt: s.startsAt,
    endsAt: s.endsAt,
    breakMinutes: s.breakMinutes,
    plannedSeconds: Math.max(0, Math.round((s.endsAt.getTime() - s.startsAt.getTime()) / 1000) - s.breakMinutes * 60),
    location: s.location,
    note: s.note,
  };
}

export async function listSchedules(actor: StaffActor, f: { from: string; to: string; employeeId?: string; departmentId?: string }) {
  const s = await ensureStaffSettings(actor.workspaceId);
  const start = new Date(startOfLocalDay(f.from, s.timezone));
  const end = new Date(startOfLocalDay(shiftDay(f.to, 1), s.timezone));
  return withTenant(actor.workspaceId, async (tx) => {
    const rows = await tx.shiftSchedule.findMany({
      where: {
        workspaceId: actor.workspaceId,
        employee: { ...employeeScope(actor), ...(f.departmentId ? { departmentId: f.departmentId } : {}) },
        ...(f.employeeId ? { employeeId: f.employeeId } : {}),
        startsAt: { lt: end },
        endsAt: { gt: start },
      },
      include: { employee: { select: { fullName: true, jobTitle: true } } },
      orderBy: { startsAt: "asc" },
      take: 2000,
    });
    return { timezone: s.timezone, items: rows.map((r) => scheduleView(r, s.timezone)) };
  });
}

async function assertNoScheduleOverlap(tx: Prisma.TransactionClient, employeeId: string, startsAt: Date, endsAt: Date, except?: string) {
  const clash = await tx.shiftSchedule.findFirst({ where: { employeeId, startsAt: { lt: endsAt }, endsAt: { gt: startsAt }, ...(except ? { id: { not: except } } : {}) } });
  if (clash) throw new StaffError(409, "overlap", "That overlaps another scheduled shift for this employee.");
}

export async function createSchedule(actor: StaffActor, input: ShiftScheduleInput & { repeatDays?: number[]; repeatUntil?: string | null }) {
  const s = await ensureStaffSettings(actor.workspaceId);
  const days = [input.day];
  if (input.repeatDays?.length && input.repeatUntil) {
    if (!isCalendarDay(input.repeatUntil) || input.repeatUntil < input.day) throw new StaffError(400, "invalid_date", "Choose when the repeat ends.");
    for (let d = shiftDay(input.day, 1); d <= input.repeatUntil && days.length < 120; d = shiftDay(d, 1)) {
      if (input.repeatDays.includes(new Date(`${d}T00:00:00Z`).getUTCDay())) days.push(d);
    }
  }
  const created = await withTenant(actor.workspaceId, async (tx) => {
    const e = await scopedEmployee(tx, actor, input.employeeId);
    if (e.status === "inactive") throw new StaffError(409, "inactive", "This employee is deactivated.");
    const out = [];
    for (const day of days) {
      const t = scheduleTimes({ ...input, day }, s.timezone);
      await assertNoScheduleOverlap(tx, e.id, t.startsAt, t.endsAt);
      out.push(
        await tx.shiftSchedule.create({
          data: { workspaceId: actor.workspaceId, employeeId: e.id, ...t, breakMinutes: input.breakMinutes, location: input.location ?? null, note: input.note ?? null, createdByUserId: actor.userId },
        }),
      );
    }
    return out;
  });
  await audit({ workspaceId: actor.workspaceId, actorUserId: actor.userId, action: "staff.schedule_created", targetType: "employee", targetId: input.employeeId, metadata: { shifts: created.length }, ip: actor.ip });
  return { items: created.map((c) => scheduleView(c, s.timezone)) };
}

export async function updateSchedule(actor: StaffActor, id: string, input: Omit<ShiftScheduleInput, "employeeId">) {
  const s = await ensureStaffSettings(actor.workspaceId);
  const row = await withTenant(actor.workspaceId, async (tx) => {
    const existing = await tx.shiftSchedule.findFirst({ where: { id, workspaceId: actor.workspaceId, employee: employeeScope(actor) } });
    if (!existing) throw notFound("That shift");
    const t = scheduleTimes(input, s.timezone);
    await assertNoScheduleOverlap(tx, existing.employeeId, t.startsAt, t.endsAt, id);
    return tx.shiftSchedule.update({ where: { id }, data: { ...t, breakMinutes: input.breakMinutes, location: input.location ?? null, note: input.note ?? null } });
  });
  return scheduleView(row, s.timezone);
}

export async function deleteSchedule(actor: StaffActor, id: string) {
  const n = await withTenant(actor.workspaceId, (tx) => tx.shiftSchedule.deleteMany({ where: { id, workspaceId: actor.workspaceId, employee: employeeScope(actor) } }));
  if (!n.count) throw notFound("That shift");
  return { ok: true };
}

/** The employee's own upcoming and recent scheduled shifts. */
export async function mySchedule(workspaceId: string, employeeId: string, from: string, to: string) {
  const s = await ensureStaffSettings(workspaceId);
  const rows = await systemDb.shiftSchedule.findMany({
    where: { workspaceId, employeeId, startsAt: { lt: new Date(startOfLocalDay(shiftDay(to, 1), s.timezone)) }, endsAt: { gt: new Date(startOfLocalDay(from, s.timezone)) } },
    orderBy: { startsAt: "asc" },
    take: 500,
  });
  return { timezone: s.timezone, items: rows.map((r) => scheduleView(r, s.timezone)) };
}

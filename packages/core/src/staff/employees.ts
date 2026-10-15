import { Prisma, systemDb, withTenant, type Department, type Employee, type PayRate, type Tx, type User } from "@app/db";
import {
  isCalendarDay,
  isCurrencyCode,
  isTimeZone,
  localDayOf,
  parseDecimal,
  RATE_SCALE,
  staffCan,
  type EmployeeStatus,
  type EmploymentType,
} from "@app/shared/staff";
import { audit } from "../notify.js";
import { assertNotOwnRecord, decimalString, displayRate, employeeScope, isUniqueViolation, notFound, scopedEmployee, serverNow, StaffError, type StaffActor } from "./common.js";
import { ensureStaffSettings } from "./settings.js";

export interface EmployeeInput {
  fullName: string;
  email: string;
  phone?: string | null;
  jobTitle: string;
  departmentId?: string | null;
  /** Create (or reuse) a department by name instead of picking one. */
  departmentName?: string | null;
  employmentType: EmploymentType;
  joinedOn: string;
  hourlyRate?: string | null;
  currency?: string | null;
  standardWeeklyMinutes: number;
  workingDays: number[];
  managerUserId?: string | null;
  overtimePolicyId?: string | null;
  breakPolicyId?: string | null;
  timezone?: string | null;
  status?: Exclude<EmployeeStatus, "inactive">;
  notes?: string | null;
}

type EmployeeRow = Employee & {
  department: Department | null;
  manager: Pick<User, "id" | "displayName" | "email"> | null;
  payRates?: PayRate[];
  invitations?: Array<{ id: string; createdAt: Date; expiresAt: Date; acceptedAt: Date | null; revokedAt: Date | null; emailed: boolean; emailError: string | null }>;
};

/** Where an employee's account stands: never invited, invited (pending/expired), or signed up. */
export function accountState(e: Pick<Employee, "userId">, invitation?: { expiresAt: Date; acceptedAt: Date | null; revokedAt: Date | null } | null) {
  if (e.userId) return "active" as const;
  if (!invitation || invitation.revokedAt) return "not_invited" as const;
  if (invitation.acceptedAt) return "active" as const;
  return invitation.expiresAt.getTime() < Date.now() ? ("expired" as const) : ("invited" as const);
}

/** The rate in force today (or the earliest future one when none has started). */
export function currentRate(rates: PayRate[], today: string): PayRate | null {
  const started = rates.filter((r) => r.effectiveFrom <= today).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
  return started[0] ?? null;
}

/** An employee as the API returns it. Pay fields only for those allowed to see pay. */
export function employeeView(e: EmployeeRow, opts: { pay: boolean; today: string }) {
  const rate = e.payRates ? currentRate(e.payRates, opts.today) : null;
  const latestInvite = e.invitations?.[0] ?? null;
  return {
    id: e.id,
    employeeNumber: e.employeeNumber,
    fullName: e.fullName,
    email: e.email,
    phone: e.phone,
    jobTitle: e.jobTitle,
    department: e.department ? { id: e.department.id, name: e.department.name } : null,
    employmentType: e.employmentType as EmploymentType,
    joinedOn: e.joinedOn,
    currency: e.currency,
    standardWeeklyMinutes: e.standardWeeklyMinutes,
    workingDays: e.workingDays,
    manager: e.manager ? { userId: e.manager.id, name: e.manager.displayName ?? e.manager.email } : null,
    overtimePolicyId: e.overtimePolicyId,
    breakPolicyId: e.breakPolicyId,
    timezone: e.timezone,
    status: e.status as EmployeeStatus,
    notes: e.notes,
    account: accountState(e, latestInvite),
    accountLinkedAt: e.accountLinkedAt,
    invitation: latestInvite
      ? { id: latestInvite.id, sentAt: latestInvite.createdAt, expiresAt: latestInvite.expiresAt, acceptedAt: latestInvite.acceptedAt, revokedAt: latestInvite.revokedAt, emailed: latestInvite.emailed, emailFailed: !!latestInvite.emailError }
      : null,
    deactivatedAt: e.deactivatedAt,
    deactivationReason: e.deactivationReason,
    createdAt: e.createdAt,
    ...(opts.pay
      ? {
          hourlyRate: rate ? displayRate(decimalString(rate.hourlyRate)!, rate.currency) : null,
          rateEffectiveFrom: rate?.effectiveFrom ?? null,
        }
      : {}),
  };
}

const EMPLOYEE_INCLUDE = {
  department: true,
  manager: { select: { id: true, displayName: true, email: true } },
  invitations: {
    orderBy: { createdAt: "desc" as const },
    take: 1,
    select: { id: true, createdAt: true, expiresAt: true, acceptedAt: true, revokedAt: true, emailed: true, emailError: true },
  },
} satisfies Prisma.EmployeeInclude;

export interface EmployeeFilters {
  q?: string;
  status?: EmployeeStatus | "all";
  departmentId?: string;
  employmentType?: EmploymentType;
  managerUserId?: string;
  jobTitle?: string;
  account?: "active" | "invited" | "not_invited";
  page: number;
  pageSize: number;
  sort?: "name" | "number" | "joined" | "created";
}

export async function listEmployees(actor: StaffActor, f: EmployeeFilters) {
  const settings = await ensureStaffSettings(actor.workspaceId);
  const today = localDayOf(Date.now(), settings.timezone);
  const where: Prisma.EmployeeWhereInput = {};
  if (f.status && f.status !== "all") where.status = f.status;
  else if (!f.status) where.status = { not: "inactive" };
  if (f.departmentId) where.departmentId = f.departmentId;
  if (f.employmentType) where.employmentType = f.employmentType;
  if (f.managerUserId) where.managerUserId = f.managerUserId;
  if (f.jobTitle) where.jobTitle = { equals: f.jobTitle, mode: "insensitive" };
  if (f.account === "active") where.userId = { not: null };
  if (f.account === "invited") Object.assign(where, { userId: null, invitations: { some: { acceptedAt: null, revokedAt: null } } });
  if (f.account === "not_invited") Object.assign(where, { userId: null, invitations: { none: { acceptedAt: null, revokedAt: null } } });
  if (f.q) {
    const q = f.q.trim();
    where.OR = [
      { fullName: { contains: q, mode: "insensitive" } },
      { email: { contains: q, mode: "insensitive" } },
      { employeeNumber: { contains: q, mode: "insensitive" } },
      { jobTitle: { contains: q, mode: "insensitive" } },
    ];
  }
  const orderBy: Prisma.EmployeeOrderByWithRelationInput =
    f.sort === "number" ? { employeeNumber: "asc" } : f.sort === "joined" ? { joinedOn: "desc" } : f.sort === "created" ? { createdAt: "desc" } : { fullName: "asc" };
  // The actor's scope is ANDed with the filters, never merged into them: a supervisor's scope is
  // `managerUserId: <themselves>`, which a `managerUserId` filter would otherwise replace.
  const scoped: Prisma.EmployeeWhereInput = { AND: [employeeScope(actor), where] };
  const pay = staffCan(actor.access, "pay:view");
  return withTenant(actor.workspaceId, async (tx) => {
    const [total, rows] = await Promise.all([
      tx.employee.count({ where: scoped }),
      tx.employee.findMany({
        where: scoped,
        orderBy: [orderBy, { id: "asc" }],
        skip: (f.page - 1) * f.pageSize,
        take: f.pageSize,
        include: { ...EMPLOYEE_INCLUDE, ...(pay ? { payRates: true } : {}) },
      }),
    ]);
    return { items: rows.map((e) => employeeView(e, { pay, today })), total, page: f.page, pageSize: f.pageSize };
  });
}

export async function getEmployee(actor: StaffActor, id: string) {
  const settings = await ensureStaffSettings(actor.workspaceId);
  const today = localDayOf(Date.now(), settings.timezone);
  const pay = staffCan(actor.access, "pay:view");
  return withTenant(actor.workspaceId, async (tx) => {
    const e = await tx.employee.findFirst({
      where: { ...employeeScope(actor), id },
      include: { ...EMPLOYEE_INCLUDE, payRates: { orderBy: { effectiveFrom: "desc" } } },
    });
    if (!e) throw notFound("That employee");
    const view = employeeView(e, { pay, today });
    return {
      ...view,
      ...(pay
        ? {
            payRates: e.payRates.map((r) => ({
              id: r.id,
              hourlyRate: displayRate(decimalString(r.hourlyRate)!, r.currency),
              currency: r.currency,
              effectiveFrom: r.effectiveFrom,
              reason: r.reason,
              createdAt: r.createdAt,
            })),
          }
        : {}),
    };
  });
}

async function validateRefs(tx: Tx, ws: string, input: Partial<EmployeeInput>) {
  if (input.departmentId) {
    const d = await tx.department.findFirst({ where: { id: input.departmentId, workspaceId: ws } });
    if (!d) throw new StaffError(400, "invalid_department", "Choose a department from the list.");
  }
  if (input.managerUserId) {
    const m = await systemDb.membership.findUnique({ where: { workspaceId_userId: { workspaceId: ws, userId: input.managerUserId } } });
    if (!m) throw new StaffError(400, "invalid_manager", "The manager has to be a member of this workspace.");
  }
  if (input.overtimePolicyId) {
    const p = await tx.overtimePolicy.findFirst({ where: { id: input.overtimePolicyId, workspaceId: ws } });
    if (!p) throw new StaffError(400, "invalid_policy", "Choose an overtime policy from the list.");
  }
  if (input.breakPolicyId) {
    const p = await tx.breakPolicy.findFirst({ where: { id: input.breakPolicyId, workspaceId: ws } });
    if (!p) throw new StaffError(400, "invalid_policy", "Choose a break policy from the list.");
  }
  if (input.timezone && !isTimeZone(input.timezone)) throw new StaffError(400, "invalid_timezone", "Choose a time zone from the list.");
  if (input.currency && !isCurrencyCode(input.currency)) throw new StaffError(400, "invalid_currency", "Choose a currency from the list.");
  if (input.joinedOn !== undefined && !isCalendarDay(input.joinedOn)) throw new StaffError(400, "invalid_date", "Enter the joining date.");
  if (input.workingDays && (new Set(input.workingDays).size !== input.workingDays.length || input.workingDays.some((d) => d < 0 || d > 6))) {
    throw new StaffError(400, "invalid_days", "Choose the working days again.");
  }
}

async function departmentFor(tx: Tx, ws: string, input: Partial<EmployeeInput>): Promise<string | null | undefined> {
  if (input.departmentName?.trim()) {
    const name = input.departmentName.trim().slice(0, 80);
    const d = await tx.department.upsert({ where: { workspaceId_name: { workspaceId: ws, name } }, create: { workspaceId: ws, name }, update: {} });
    return d.id;
  }
  return input.departmentId;
}

/**
 * Overtime and break policies and the pay currency decide what someone is paid, so setting them to
 * anything but what they already are (or, for a new employee, the organization's defaults) needs
 * `pay:manage`. HR managers have `staff:manage` only: they edit people, not pay.
 */
function assertPayFieldsAllowed(
  actor: StaffActor,
  input: Partial<Pick<EmployeeInput, "overtimePolicyId" | "breakPolicyId" | "currency">>,
  current: { overtimePolicyId: string | null; breakPolicyId: string | null; currency: string },
) {
  if (staffCan(actor.access, "pay:manage")) return;
  const changes =
    (input.overtimePolicyId !== undefined && (input.overtimePolicyId ?? null) !== current.overtimePolicyId) ||
    (input.breakPolicyId !== undefined && (input.breakPolicyId ?? null) !== current.breakPolicyId) ||
    (!!input.currency && input.currency !== current.currency);
  if (changes) throw new StaffError(403, "forbidden", "Only payroll managers, admins and owners can change overtime, break policies or the pay currency.");
}

export async function createEmployee(actor: StaffActor, input: EmployeeInput) {
  const settings = await ensureStaffSettings(actor.workspaceId);
  const ws = actor.workspaceId;
  if (input.hourlyRate && !staffCan(actor.access, "pay:manage")) {
    throw new StaffError(403, "forbidden", "Only payroll managers, admins and owners can set pay rates.");
  }
  assertPayFieldsAllowed(actor, input, {
    overtimePolicyId: settings.defaultOvertimePolicyId ?? null,
    breakPolicyId: settings.defaultBreakPolicyId ?? null,
    currency: settings.currency,
  });
  const currency = input.currency ?? settings.currency;
  if (input.hourlyRate) {
    try {
      parseDecimal(input.hourlyRate, RATE_SCALE);
    } catch {
      throw new StaffError(400, "invalid_rate", "Enter the hourly rate as a number, like 20 or 20.50.");
    }
  }
  const employee = await withTenant(ws, async (tx) => {
    await validateRefs(tx, ws, input);
    const departmentId = await departmentFor(tx, ws, input);
    const counter = await tx.$queryRaw<Array<{ n: number }>>`
      UPDATE organization_payroll_settings SET next_employee_number = next_employee_number + 1
      WHERE workspace_id = ${ws} RETURNING next_employee_number - 1 AS n`;
    const n = Number(counter[0]!.n);
    const employeeNumber = `EMP-${String(n).padStart(4, "0")}`;
    try {
      const e = await tx.employee.create({
        data: {
          workspaceId: ws,
          employeeNumber,
          fullName: input.fullName.trim(),
          email: input.email.trim().toLowerCase(),
          phone: input.phone?.trim() || null,
          jobTitle: input.jobTitle.trim(),
          departmentId: departmentId ?? null,
          employmentType: input.employmentType,
          joinedOn: input.joinedOn,
          currency,
          standardWeeklyMinutes: input.standardWeeklyMinutes,
          workingDays: [...input.workingDays].sort(),
          managerUserId: input.managerUserId ?? null,
          overtimePolicyId: input.overtimePolicyId === undefined ? settings.defaultOvertimePolicyId : input.overtimePolicyId,
          breakPolicyId: input.breakPolicyId === undefined ? settings.defaultBreakPolicyId : input.breakPolicyId,
          timezone: input.timezone ?? settings.timezone,
          status: input.status ?? "active",
          notes: input.notes?.trim() || null,
          createdByUserId: actor.userId,
        },
      });
      if (input.hourlyRate) {
        await tx.payRate.create({
          data: { workspaceId: ws, employeeId: e.id, hourlyRate: new Prisma.Decimal(input.hourlyRate), currency, effectiveFrom: input.joinedOn, reason: "Starting rate", createdByUserId: actor.userId },
        });
      }
      return e;
    } catch (err) {
      if (isUniqueViolation(err, "email")) throw new StaffError(409, "email_taken", "An employee with that email address already exists in this organization.");
      throw err;
    }
  });
  await audit({
    workspaceId: ws,
    actorUserId: actor.userId,
    action: "staff.employee_created",
    targetType: "employee",
    targetId: employee.id,
    metadata: { employeeNumber: employee.employeeNumber, rateSet: !!input.hourlyRate },
    ip: actor.ip,
  });
  return getEmployee(actor, employee.id);
}

export async function updateEmployee(actor: StaffActor, id: string, patch: Partial<Omit<EmployeeInput, "hourlyRate">>) {
  const ws = actor.workspaceId;
  const changed = await withTenant(ws, async (tx) => {
    const e = await scopedEmployee(tx, actor, id);
    if (e.status === "inactive" && patch.status) throw new StaffError(409, "inactive", "Reactivate this employee before changing their status.");
    assertPayFieldsAllowed(actor, patch, e);
    if (patch.overtimePolicyId !== undefined || patch.breakPolicyId !== undefined) assertNotOwnRecord(actor, e.userId, "change overtime or break policies");
    if (patch.managerUserId && patch.managerUserId === e.userId) throw new StaffError(400, "own_manager", "An employee can't be their own manager: their hours would be approved by themselves.");
    await validateRefs(tx, ws, patch);
    if (patch.email && patch.email.toLowerCase() !== e.email && e.userId) {
      throw new StaffError(409, "email_locked", "This employee already has an account. They sign in with the email address they registered with.");
    }
    if (patch.currency && patch.currency !== e.currency) {
      const paid = await tx.payrollItem.count({ where: { employeeId: id, workspaceId: ws } });
      if (paid) throw new StaffError(409, "currency_locked", "This employee already has payroll in their current currency, so it can't be changed.");
    }
    const departmentId = await departmentFor(tx, ws, patch);
    const data: Prisma.EmployeeUpdateInput = {};
    if (patch.fullName !== undefined) data.fullName = patch.fullName.trim();
    if (patch.email !== undefined) data.email = patch.email.trim().toLowerCase();
    if (patch.phone !== undefined) data.phone = patch.phone?.trim() || null;
    if (patch.jobTitle !== undefined) data.jobTitle = patch.jobTitle.trim();
    if (departmentId !== undefined) data.department = departmentId ? { connect: { id: departmentId } } : { disconnect: true };
    if (patch.employmentType !== undefined) data.employmentType = patch.employmentType;
    if (patch.joinedOn !== undefined) data.joinedOn = patch.joinedOn;
    if (patch.currency) data.currency = patch.currency;
    if (patch.standardWeeklyMinutes !== undefined) data.standardWeeklyMinutes = patch.standardWeeklyMinutes;
    if (patch.workingDays !== undefined) data.workingDays = [...patch.workingDays].sort();
    if (patch.managerUserId !== undefined) data.manager = patch.managerUserId ? { connect: { id: patch.managerUserId } } : { disconnect: true };
    if (patch.overtimePolicyId !== undefined) data.overtimePolicy = patch.overtimePolicyId ? { connect: { id: patch.overtimePolicyId } } : { disconnect: true };
    if (patch.breakPolicyId !== undefined) data.breakPolicy = patch.breakPolicyId ? { connect: { id: patch.breakPolicyId } } : { disconnect: true };
    if (patch.timezone) data.timezone = patch.timezone;
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.notes !== undefined) data.notes = patch.notes?.trim() || null;
    try {
      await tx.employee.update({ where: { id }, data });
    } catch (err) {
      if (isUniqueViolation(err, "email")) throw new StaffError(409, "email_taken", "An employee with that email address already exists in this organization.");
      throw err;
    }
    // Invitations already sent went to the old address: withdraw them, so only the new inbox can claim the record.
    if (data.email !== undefined && data.email !== e.email) {
      await tx.employeeInvitation.updateMany({ where: { workspaceId: ws, employeeId: id, acceptedAt: null, revokedAt: null }, data: { revokedAt: serverNow() } });
    }
    return Object.keys(data);
  });
  await audit({ workspaceId: ws, actorUserId: actor.userId, action: "staff.employee_updated", targetType: "employee", targetId: id, metadata: { fields: changed }, ip: actor.ip });
  return getEmployee(actor, id);
}

/**
 * Deactivate: the employee can no longer clock in or use the portal's actions, any open shift is
 * closed now (flagged for review), and unused invitations stop working. Records stay for payroll.
 */
export async function deactivateEmployee(actor: StaffActor, id: string, reason: string | null) {
  const ws = actor.workspaceId;
  const now = serverNow();
  await withTenant(ws, async (tx) => {
    const e = await scopedEmployee(tx, actor, id);
    if (e.status === "inactive") throw new StaffError(409, "already_inactive", "This employee is already deactivated.");
    await tx.$queryRaw`SELECT id FROM employees WHERE id = ${id} AND workspace_id = ${ws} FOR UPDATE`;
    const open = await tx.attendanceSession.findFirst({ where: { employeeId: id, workspaceId: ws, clockOutAt: null } });
    if (open) {
      await tx.breakSession.updateMany({ where: { sessionId: open.id, endAt: null }, data: { endAt: now } });
      await tx.attendanceSession.update({
        where: { id: open.id },
        data: { clockOutAt: now, clockOutSource: "system", flags: [...new Set([...open.flags, "closed_by_manager"])], revision: { increment: 1 } },
      });
      await tx.attendanceEvent.create({
        data: { workspaceId: ws, employeeId: id, sessionId: open.id, type: "deactivation_close", at: now, source: "system", actorUserId: actor.userId, note: "Shift closed because the employee was deactivated" },
      });
    }
    await tx.employeeInvitation.updateMany({ where: { employeeId: id, acceptedAt: null, revokedAt: null }, data: { revokedAt: now, revokedByUserId: actor.userId } });
    await tx.employee.update({ where: { id }, data: { status: "inactive", deactivatedAt: now, deactivatedByUserId: actor.userId, deactivationReason: reason } });
  });
  await audit({ workspaceId: ws, actorUserId: actor.userId, action: "staff.employee_deactivated", targetType: "employee", targetId: id, metadata: { reason }, ip: actor.ip });
  return getEmployee(actor, id);
}

export async function reactivateEmployee(actor: StaffActor, id: string) {
  const ws = actor.workspaceId;
  await withTenant(ws, async (tx) => {
    const e = await scopedEmployee(tx, actor, id);
    if (e.status !== "inactive") throw new StaffError(409, "not_inactive", "This employee is already active.");
    await tx.employee.update({ where: { id }, data: { status: "active", deactivatedAt: null, deactivatedByUserId: null, deactivationReason: null } });
  });
  await audit({ workspaceId: ws, actorUserId: actor.userId, action: "staff.employee_reactivated", targetType: "employee", targetId: id, ip: actor.ip });
  return getEmployee(actor, id);
}

/**
 * Add an hourly rate effective from a local day. Rates are history: a new one never edits an
 * old one, and it may not start on a day an approved payroll has already paid (that pay is final;
 * a correction belongs in the next payroll as an adjustment).
 */
export async function setPayRate(actor: StaffActor, employeeId: string, input: { hourlyRate: string; effectiveFrom: string; reason?: string | null }) {
  const ws = actor.workspaceId;
  let rate: Prisma.Decimal;
  try {
    parseDecimal(input.hourlyRate, RATE_SCALE);
    rate = new Prisma.Decimal(input.hourlyRate);
  } catch {
    throw new StaffError(400, "invalid_rate", "Enter the hourly rate as a number with up to 4 decimal places, like 20 or 20.50.");
  }
  if (!isCalendarDay(input.effectiveFrom)) throw new StaffError(400, "invalid_date", "Choose the day the rate starts.");
  const created = await withTenant(ws, async (tx) => {
    const e = await scopedEmployee(tx, actor, employeeId);
    assertNotOwnRecord(actor, e.userId, "set the pay rate");
    const locked = await tx.payrollItem.findFirst({
      where: { workspaceId: ws, employeeId, period: { lockedAt: { not: null }, endDate: { gte: input.effectiveFrom } } },
      include: { period: { select: { startDate: true, endDate: true } } },
    });
    if (locked) {
      throw new StaffError(
        409,
        "period_locked",
        `Pay up to ${locked.period.endDate} has already been approved. Start the new rate after that, or add an adjustment to the next payroll.`,
      );
    }
    try {
      return await tx.payRate.create({
        data: { workspaceId: ws, employeeId, hourlyRate: rate, currency: e.currency, effectiveFrom: input.effectiveFrom, reason: input.reason?.trim() || null, createdByUserId: actor.userId },
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new StaffError(409, "rate_exists", "A rate already starts on that day. Choose another day.");
      throw err;
    }
  });
  await audit({
    workspaceId: ws,
    actorUserId: actor.userId,
    action: "staff.pay_rate_set",
    targetType: "employee",
    targetId: employeeId,
    metadata: { effectiveFrom: created.effectiveFrom, hourlyRate: created.hourlyRate.toFixed(RATE_SCALE), currency: created.currency },
    ip: actor.ip,
  });
  return getEmployee(actor, employeeId);
}

/** Delete a rate that hasn't started paying anything approved yet (a typo). */
export async function deletePayRate(actor: StaffActor, employeeId: string, rateId: string) {
  const ws = actor.workspaceId;
  const removed = await withTenant(ws, async (tx) => {
    const e = await scopedEmployee(tx, actor, employeeId);
    assertNotOwnRecord(actor, e.userId, "change the pay rate");
    const r = await tx.payRate.findFirst({ where: { id: rateId, employeeId, workspaceId: ws } });
    if (!r) throw notFound("That rate");
    const locked = await tx.payrollItem.count({ where: { workspaceId: ws, employeeId, period: { lockedAt: { not: null }, endDate: { gte: r.effectiveFrom } } } });
    if (locked) throw new StaffError(409, "period_locked", "Approved payroll already used this rate, so it stays in the history.");
    await tx.payRate.delete({ where: { id: r.id } });
    return r;
  });
  // The row is gone, so this entry is the only record of what was deleted.
  await audit({
    workspaceId: ws,
    actorUserId: actor.userId,
    action: "staff.pay_rate_deleted",
    targetType: "employee",
    targetId: employeeId,
    metadata: { effectiveFrom: removed.effectiveFrom, hourlyRate: removed.hourlyRate.toFixed(RATE_SCALE), currency: removed.currency },
    ip: actor.ip,
  });
  return getEmployee(actor, employeeId);
}

/** Members who can be assigned as an employee's manager. */
export async function managerOptions(workspaceId: string) {
  const members = await systemDb.membership.findMany({ where: { workspaceId }, include: { user: { select: { id: true, displayName: true, email: true } } }, orderBy: { createdAt: "asc" } });
  return members.map((m) => ({ userId: m.user.id, name: m.user.displayName ?? m.user.email, email: m.user.email, role: m.role, staffRole: m.staffRole }));
}

/** The employee's audit trail: changes to their record and their pay. */
export async function employeeAudit(actor: StaffActor, employeeId: string) {
  return withTenant(actor.workspaceId, async (tx) => {
    await scopedEmployee(tx, actor, employeeId);
    const rows = await tx.auditLog.findMany({
      where: { workspaceId: actor.workspaceId, targetType: "employee", targetId: employeeId },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    const actors = await systemDb.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.actorUserId).filter(Boolean))] as string[] } }, select: { id: true, email: true, displayName: true } });
    const byId = new Map(actors.map((a) => [a.id, a.displayName ?? a.email]));
    const pay = staffCan(actor.access, "pay:view");
    return rows
      .filter((r) => pay || !/pay_rate|payroll|payment/.test(r.action))
      .map((r) => ({ id: r.id, action: r.action, actor: r.actorUserId ? (byId.get(r.actorUserId) ?? "A former member") : "bizinsights", metadata: r.metadata, at: r.createdAt }));
  });
}

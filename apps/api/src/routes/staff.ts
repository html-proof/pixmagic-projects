import { z } from "zod";
import { systemDb } from "@app/db";
import {
  addHoliday,
  createDepartment,
  createEmployee,
  createInvitation,
  createSchedule,
  deactivateEmployee,
  deleteBreakPolicy,
  deleteDepartment,
  deleteHoliday,
  deleteOvertimePolicy,
  deletePayRate,
  deleteSchedule,
  employeeAudit,
  getEmployee,
  getStaffConfig,
  listEmployees,
  listInvitations,
  listSchedules,
  managerOptions,
  reactivateEmployee,
  renameDepartment,
  revokeInvitation,
  saveBreakPolicy,
  saveOvertimePolicy,
  setPayRate,
  updateEmployee,
  updateSchedule,
  updateStaffSettings,
} from "@app/core";
import { EMPLOYEE_STATUSES, EMPLOYMENT_TYPES, PAY_CYCLES, staffAccess } from "@app/shared/staff";
import { ACCESS_REVOKED, body, HttpError, requireUser, type Deps } from "../context.js";
import type { App } from "../app.js";
import { limit, LIMITS } from "../rateLimit.js";
import { daySchema, idSchema, pageSchema, requireStaff } from "../staffAccess.js";

const BASE = "/workspaces/:ws/staff";

const nullableText = (max: number) => z.string().trim().max(max).nullish();

const employeeFields = {
  fullName: z.string().trim().min(1, "Enter the employee's name").max(120),
  email: z.string().trim().email("Enter a valid email address").max(254),
  phone: z
    .string()
    .trim()
    .max(40)
    .regex(/^[+0-9 ().-]*$/, "Use digits, spaces and + ( ) - only")
    .nullish(),
  jobTitle: z.string().trim().min(1, "Enter the job title").max(80),
  departmentId: idSchema.nullish(),
  departmentName: nullableText(80),
  employmentType: z.enum(EMPLOYMENT_TYPES),
  joinedOn: daySchema,
  currency: z.string().regex(/^[A-Z]{3}$/).nullish(),
  standardWeeklyMinutes: z.number().int().min(0).max(10_080),
  workingDays: z.array(z.number().int().min(0).max(6)).max(7),
  managerUserId: idSchema.nullish(),
  overtimePolicyId: idSchema.nullish(),
  breakPolicyId: idSchema.nullish(),
  timezone: z.string().max(64).nullish(),
  status: z.enum(["active", "on_leave"]).optional(),
  notes: z.string().trim().max(2000).nullish(),
};
const rateField = z
  .string()
  .trim()
  .regex(/^\d{1,9}(\.\d{1,4})?$/, "Enter the hourly rate like 20 or 20.50");

const createSchema = z.object({ ...employeeFields, hourlyRate: rateField.nullish() });
const patchSchema = z.object(employeeFields).partial();

const overtimeSchema = z.object({
  name: z.string().trim().min(1).max(80),
  dailyThresholdMinutes: z.number().int().min(1).max(1440).nullable(),
  weeklyThresholdMinutes: z.number().int().min(1).max(10_080).nullable(),
  multiplier: z.string().trim().max(10),
  doubleTimeDailyThresholdMinutes: z.number().int().min(1).max(1440).nullable(),
  doubleTimeMultiplier: z.string().trim().max(10).nullable(),
  holidayMultiplier: z.string().trim().max(10),
});

const breakSchema = z.object({
  name: z.string().trim().min(1).max(80),
  restBreaksPaid: z.boolean(),
  mealBreaksPaid: z.boolean(),
  maxBreaksPerShift: z.number().int().min(1).max(20).nullable(),
  maxBreakMinutes: z.number().int().min(1).max(600).nullable(),
});

const settingsSchema = z
  .object({
    timezone: z.string().max(64),
    currency: z.string().regex(/^[A-Z]{3}$/),
    payCycle: z.enum(PAY_CYCLES),
    payCycleAnchor: daySchema,
    weekStartsOn: z.number().int().min(0).max(6),
    invitationExpiryHours: z.number().int().min(1).max(24 * 14),
    staleSessionHours: z.number().int().min(4).max(48),
    lateGraceMinutes: z.number().int().min(0).max(120),
    requireApproval: z.boolean(),
    allowEmployeeCorrections: z.boolean(),
    jurisdiction: z.string().trim().max(40).nullable(),
    supportEmail: z.string().trim().email().max(254).nullable(),
    defaultOvertimePolicyId: idSchema.nullable(),
    defaultBreakPolicyId: idSchema.nullable(),
  })
  .partial();

const scheduleFields = {
  day: daySchema,
  startTime: z.string().regex(/^\d{2}:\d{2}$/),
  endTime: z.string().regex(/^\d{2}:\d{2}$/),
  breakMinutes: z.number().int().min(0).max(600).default(0),
  location: nullableText(120),
  note: nullableText(500),
};

export function staffRoutes(app: App, deps: Deps) {
  /** What the signed-in member may do here (the UI uses it to decide what to show). */
  app.get(`${BASE}/access`, async (c) => {
    const { ws } = c.req.param();
    const user = await requireUser(c, deps);
    const m = await systemDb.membership.findUnique({ where: { workspaceId_userId: { workspaceId: ws, userId: user.id } } });
    if (!m) throw new HttpError(404, "Not found", "not_found");
    if (m.revokedAt) throw new HttpError(403, "Your access to this workspace has been revoked.", ACCESS_REVOKED);
    const a = staffAccess(m.role, m.staffRole, m.permissions);
    return c.json({ permissions: a.permissions, scope: a.scope, staffRole: a.staffRole, role: m.role });
  });

  // ---------------- Configuration ----------------
  app.get(`${BASE}/config`, async (c) => {
    const actor = await requireStaff(c, deps, c.req.param("ws"), "staff:view");
    const [config, managers] = await Promise.all([getStaffConfig(actor), managerOptions(actor.workspaceId)]);
    return c.json({ ...config, managers, access: { permissions: actor.access.permissions, scope: actor.access.scope } });
  });

  app.put(`${BASE}/settings`, async (c) => {
    const actor = await requireStaff(c, deps, c.req.param("ws"), "staff:settings");
    const patch = settingsSchema.parse(await body(c));
    return c.json(await updateStaffSettings(actor, patch));
  });

  app.post(`${BASE}/departments`, async (c) => {
    const actor = await requireStaff(c, deps, c.req.param("ws"), "staff:manage");
    const { name } = z.object({ name: z.string().trim().min(1).max(80) }).parse(await body(c));
    return c.json(await createDepartment(actor, name));
  });
  app.patch(`${BASE}/departments/:id`, async (c) => {
    const actor = await requireStaff(c, deps, c.req.param("ws"), "staff:manage");
    const { name } = z.object({ name: z.string().trim().min(1).max(80) }).parse(await body(c));
    return c.json(await renameDepartment(actor, c.req.param("id"), name));
  });
  app.delete(`${BASE}/departments/:id`, async (c) => {
    const actor = await requireStaff(c, deps, c.req.param("ws"), "staff:manage");
    return c.json(await deleteDepartment(actor, c.req.param("id")));
  });

  app.post(`${BASE}/overtime-policies`, async (c) => {
    const actor = await requireStaff(c, deps, c.req.param("ws"), "pay:manage");
    return c.json(await saveOvertimePolicy(actor, null, overtimeSchema.parse(await body(c))));
  });
  app.put(`${BASE}/overtime-policies/:id`, async (c) => {
    const actor = await requireStaff(c, deps, c.req.param("ws"), "pay:manage");
    return c.json(await saveOvertimePolicy(actor, c.req.param("id"), overtimeSchema.parse(await body(c))));
  });
  app.delete(`${BASE}/overtime-policies/:id`, async (c) => {
    const actor = await requireStaff(c, deps, c.req.param("ws"), "pay:manage");
    return c.json(await deleteOvertimePolicy(actor, c.req.param("id")));
  });

  app.post(`${BASE}/break-policies`, async (c) => {
    const actor = await requireStaff(c, deps, c.req.param("ws"), "pay:manage");
    return c.json(await saveBreakPolicy(actor, null, breakSchema.parse(await body(c))));
  });
  app.put(`${BASE}/break-policies/:id`, async (c) => {
    const actor = await requireStaff(c, deps, c.req.param("ws"), "pay:manage");
    return c.json(await saveBreakPolicy(actor, c.req.param("id"), breakSchema.parse(await body(c))));
  });
  app.delete(`${BASE}/break-policies/:id`, async (c) => {
    const actor = await requireStaff(c, deps, c.req.param("ws"), "pay:manage");
    return c.json(await deleteBreakPolicy(actor, c.req.param("id")));
  });

  app.post(`${BASE}/holidays`, async (c) => {
    const actor = await requireStaff(c, deps, c.req.param("ws"), "staff:settings");
    const { day, name } = z.object({ day: daySchema, name: z.string().trim().min(1).max(80) }).parse(await body(c));
    return c.json(await addHoliday(actor, day, name));
  });
  app.delete(`${BASE}/holidays/:id`, async (c) => {
    const actor = await requireStaff(c, deps, c.req.param("ws"), "staff:settings");
    return c.json(await deleteHoliday(actor, c.req.param("id")));
  });

  // ---------------- Employees ----------------
  app.get(`${BASE}/employees`, async (c) => {
    const actor = await requireStaff(c, deps, c.req.param("ws"), "staff:view");
    const q = pageSchema
      .extend({
        q: z.string().max(100).optional(),
        status: z.enum([...EMPLOYEE_STATUSES, "all"]).optional(),
        departmentId: idSchema.optional(),
        employmentType: z.enum(EMPLOYMENT_TYPES).optional(),
        managerUserId: idSchema.optional(),
        jobTitle: z.string().max(80).optional(),
        account: z.enum(["active", "invited", "not_invited"]).optional(),
        sort: z.enum(["name", "number", "joined", "created"]).optional(),
      })
      .parse(c.req.query());
    return c.json(await listEmployees(actor, q));
  });

  app.post(`${BASE}/employees`, async (c) => {
    const actor = await requireStaff(c, deps, c.req.param("ws"), "staff:manage");
    const input = createSchema.parse(await body(c));
    const employee = await createEmployee(actor, input);
    return c.json({ employee }, 201);
  });

  app.get(`${BASE}/employees/:id`, async (c) => {
    const actor = await requireStaff(c, deps, c.req.param("ws"), "staff:view");
    return c.json({ employee: await getEmployee(actor, c.req.param("id")) });
  });

  app.patch(`${BASE}/employees/:id`, async (c) => {
    const actor = await requireStaff(c, deps, c.req.param("ws"), "staff:manage");
    const patch = patchSchema.parse(await body(c));
    return c.json({ employee: await updateEmployee(actor, c.req.param("id"), patch) });
  });

  app.post(`${BASE}/employees/:id/deactivate`, async (c) => {
    const actor = await requireStaff(c, deps, c.req.param("ws"), "staff:manage");
    const { reason } = z.object({ reason: z.string().trim().max(300).nullish() }).parse(await body(c));
    return c.json({ employee: await deactivateEmployee(actor, c.req.param("id"), reason ?? null) });
  });

  app.post(`${BASE}/employees/:id/reactivate`, async (c) => {
    const actor = await requireStaff(c, deps, c.req.param("ws"), "staff:manage");
    return c.json({ employee: await reactivateEmployee(actor, c.req.param("id")) });
  });

  app.post(`${BASE}/employees/:id/pay-rates`, async (c) => {
    const actor = await requireStaff(c, deps, c.req.param("ws"), "pay:manage");
    const input = z.object({ hourlyRate: rateField, effectiveFrom: daySchema, reason: nullableText(200) }).parse(await body(c));
    return c.json({ employee: await setPayRate(actor, c.req.param("id"), input) });
  });

  app.delete(`${BASE}/employees/:id/pay-rates/:rateId`, async (c) => {
    const actor = await requireStaff(c, deps, c.req.param("ws"), "pay:manage");
    return c.json({ employee: await deletePayRate(actor, c.req.param("id"), c.req.param("rateId")) });
  });

  app.get(`${BASE}/employees/:id/audit`, async (c) => {
    const actor = await requireStaff(c, deps, c.req.param("ws"), "staff:view");
    return c.json({ items: await employeeAudit(actor, c.req.param("id")) });
  });

  // ---------------- Invitations ----------------
  app.post(`${BASE}/employees/:id/invitations`, async (c) => {
    const actor = await requireStaff(c, deps, c.req.param("ws"), "staff:manage");
    const { delivery } = z.object({ delivery: z.enum(["email", "link"]).default("email") }).parse(await body(c));
    // Each one may send an email from our domain: one workspace (or one person) can't turn it into a spam relay.
    await limit(deps.coord, `rl:staff-invite:${actor.workspaceId}`, LIMITS.invitations);
    if (delivery === "email") await limit(deps.coord, `rl:invite-user:${actor.userId}`, LIMITS.invitationsPerUser);
    return c.json(await createInvitation(actor, c.req.param("id"), delivery, deps.mailer));
  });

  app.post(`${BASE}/employees/:id/invitations/revoke`, async (c) => {
    const actor = await requireStaff(c, deps, c.req.param("ws"), "staff:manage");
    return c.json(await revokeInvitation(actor, c.req.param("id")));
  });

  app.get(`${BASE}/invitations`, async (c) => {
    const actor = await requireStaff(c, deps, c.req.param("ws"), "staff:view");
    const { status } = z.object({ status: z.enum(["open", "all"]).default("open") }).parse(c.req.query());
    return c.json({ items: await listInvitations(actor, status) });
  });

  // ---------------- Shift schedules ----------------
  app.get(`${BASE}/schedules`, async (c) => {
    const actor = await requireStaff(c, deps, c.req.param("ws"), "staff:view");
    const q = z.object({ from: daySchema, to: daySchema, employeeId: idSchema.optional(), departmentId: idSchema.optional() }).parse(c.req.query());
    if (q.from > q.to) throw new HttpError(400, "The start date is after the end date", "validation");
    return c.json(await listSchedules(actor, q));
  });

  app.post(`${BASE}/schedules`, async (c) => {
    const actor = await requireStaff(c, deps, c.req.param("ws"), "staff:manage");
    const input = z
      .object({ employeeId: idSchema, ...scheduleFields, repeatDays: z.array(z.number().int().min(0).max(6)).max(7).optional(), repeatUntil: daySchema.nullish() })
      .parse(await body(c));
    return c.json(await createSchedule(actor, input), 201);
  });

  app.put(`${BASE}/schedules/:id`, async (c) => {
    const actor = await requireStaff(c, deps, c.req.param("ws"), "staff:manage");
    return c.json(await updateSchedule(actor, c.req.param("id"), z.object(scheduleFields).parse(await body(c))));
  });

  app.delete(`${BASE}/schedules/:id`, async (c) => {
    const actor = await requireStaff(c, deps, c.req.param("ws"), "staff:manage");
    return c.json(await deleteSchedule(actor, c.req.param("id")));
  });
}


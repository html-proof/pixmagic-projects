import { z } from "zod";
import { addManualSession, approveSessions, decideCorrection, editSession, getSession, listCorrections, listTimesheets, liveBoard, rejectSession, reopenSession } from "@app/core";
import { BREAK_KINDS, LIVE_STATUSES } from "@app/shared/staff";
import { body, HttpError, type Deps } from "../context.js";
import type { App } from "../app.js";
import { daySchema, idSchema, instantSchema, pageSchema, requireStaff } from "../staffAccess.js";

const BASE = "/workspaces/:ws/staff";

const timesSchema = z.object({
  clockInAt: instantSchema,
  clockOutAt: instantSchema.nullable(),
  breaks: z.array(z.object({ startAt: instantSchema, endAt: instantSchema, kind: z.enum(BREAK_KINDS) })).max(20).optional(),
  note: z.string().trim().min(3, "Say why the times are being changed").max(500),
});

/** Live attendance, timesheets, corrections and approvals (admin side). */
export function staffAttendanceRoutes(app: App, deps: Deps) {
  app.get(`${BASE}/attendance/live`, async (c) => {
    const actor = await requireStaff(c, deps, c.req.param("ws"), "attendance:view");
    const f = z
      .object({ q: z.string().max(100).optional(), departmentId: idSchema.optional(), jobTitle: z.string().max(80).optional(), managerUserId: idSchema.optional(), status: z.enum(LIVE_STATUSES).optional() })
      .parse(c.req.query());
    return c.json(await liveBoard(actor, f));
  });

  app.get(`${BASE}/timesheets`, async (c) => {
    const actor = await requireStaff(c, deps, c.req.param("ws"), "attendance:view");
    const f = pageSchema
      .extend({
        from: daySchema,
        to: daySchema,
        employeeId: idSchema.optional(),
        departmentId: idSchema.optional(),
        status: z.enum(["pending", "approved", "rejected", "open", "needs_review"]).optional(),
      })
      .parse(c.req.query());
    if (f.from > f.to) throw new HttpError(400, "The start date is after the end date", "validation");
    return c.json(await listTimesheets(actor, f));
  });

  app.get(`${BASE}/timesheets/:sessionId`, async (c) => {
    const actor = await requireStaff(c, deps, c.req.param("ws"), "attendance:view");
    return c.json({ session: await getSession(actor, c.req.param("sessionId")) });
  });

  /** A manager's direct correction (applied at once; before/after kept in the shift's history). */
  app.post(`${BASE}/timesheets/:sessionId/corrections`, async (c) => {
    const actor = await requireStaff(c, deps, c.req.param("ws"), "attendance:manage");
    const input = timesSchema.parse(await body(c));
    return c.json({ session: await editSession(actor, c.req.param("sessionId"), input) });
  });

  /** Add a shift that was never clocked (forgotten clock-in). */
  app.post(`${BASE}/employees/:id/shifts`, async (c) => {
    const actor = await requireStaff(c, deps, c.req.param("ws"), "attendance:manage");
    const input = timesSchema.parse(await body(c));
    return c.json({ session: await addManualSession(actor, c.req.param("id"), input) }, 201);
  });

  app.post(`${BASE}/timesheets/approve`, async (c) => {
    const actor = await requireStaff(c, deps, c.req.param("ws"), "attendance:manage");
    const { sessionIds, note } = z.object({ sessionIds: z.array(idSchema).min(1).max(500), note: z.string().trim().max(300).nullish() }).parse(await body(c));
    return c.json(await approveSessions(actor, [...new Set(sessionIds)], note ?? null));
  });

  app.post(`${BASE}/timesheets/:sessionId/approve`, async (c) => {
    const actor = await requireStaff(c, deps, c.req.param("ws"), "attendance:manage");
    return c.json(await approveSessions(actor, [c.req.param("sessionId")], null));
  });

  app.post(`${BASE}/timesheets/:sessionId/reject`, async (c) => {
    const actor = await requireStaff(c, deps, c.req.param("ws"), "attendance:manage");
    const { reason } = z.object({ reason: z.string().trim().min(3, "Say why the hours are rejected").max(300) }).parse(await body(c));
    return c.json(await rejectSession(actor, c.req.param("sessionId"), reason));
  });

  app.post(`${BASE}/timesheets/:sessionId/reopen`, async (c) => {
    const actor = await requireStaff(c, deps, c.req.param("ws"), "attendance:manage");
    return c.json(await reopenSession(actor, c.req.param("sessionId")));
  });

  app.get(`${BASE}/corrections`, async (c) => {
    const actor = await requireStaff(c, deps, c.req.param("ws"), "attendance:view");
    const { status } = z.object({ status: z.enum(["pending", "all"]).default("pending") }).parse(c.req.query());
    return c.json({ items: await listCorrections(actor, status) });
  });

  app.post(`${BASE}/corrections/:id/approve`, async (c) => {
    const actor = await requireStaff(c, deps, c.req.param("ws"), "attendance:manage");
    const { note } = z.object({ note: z.string().trim().max(300).nullish() }).parse(await body(c));
    return c.json(await decideCorrection(actor, c.req.param("id"), { approve: true, note: note ?? null }));
  });

  app.post(`${BASE}/corrections/:id/reject`, async (c) => {
    const actor = await requireStaff(c, deps, c.req.param("ws"), "attendance:manage");
    const { note } = z.object({ note: z.string().trim().min(3, "Say why the request is rejected").max(300) }).parse(await body(c));
    return c.json(await decideCorrection(actor, c.req.param("id"), { approve: false, note }));
  });
}

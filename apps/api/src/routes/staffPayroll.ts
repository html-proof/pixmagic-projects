import { z } from "zod";
import {
  addAdjustment,
  approvePeriod,
  calculatePeriod,
  cancelPeriod,
  changePaymentStatus,
  createPeriod,
  getPeriod,
  listPayments,
  listPeriods,
  payableItems,
  recordPayment,
  rejectPeriod,
  removeAdjustment,
  reversePeriod,
  submitPeriod,
  suggestPeriods,
} from "@app/core";
import { PAYMENT_METHODS, PAYMENT_STATUSES, PAYROLL_STATUSES } from "@app/shared/staff";
import { body, type Deps } from "../context.js";
import type { App } from "../app.js";
import { daySchema, idempotencyKey, idSchema, pageSchema, requireStaff } from "../staffAccess.js";

const BASE = "/workspaces/:ws/staff/payroll";
const comment = (min = 0) => z.object({ comment: min ? z.string().trim().min(min, "Add a short note").max(500) : z.string().trim().max(500).nullish() });
const amount = z.string().trim().regex(/^\d{1,12}(\.\d{1,3})?$/, "Enter an amount like 160 or 160.00");

/** Pay periods, adjustments, the approval workflow and payment records. */
export function staffPayrollRoutes(app: App, deps: Deps) {
  app.get(`${BASE}/periods`, async (c) => {
    const actor = await requireStaff(c, deps, c.req.param("ws"), "pay:view");
    const q = pageSchema.extend({ status: z.enum(PAYROLL_STATUSES).optional() }).parse(c.req.query());
    return c.json(await listPeriods(actor, q));
  });

  app.get(`${BASE}/suggestions`, async (c) => {
    const actor = await requireStaff(c, deps, c.req.param("ws"), "pay:view");
    return c.json(await suggestPeriods(actor));
  });

  app.post(`${BASE}/periods`, async (c) => {
    const actor = await requireStaff(c, deps, c.req.param("ws"), "payroll:manage");
    const input = z.object({ startDate: daySchema, endDate: daySchema, payDate: daySchema.nullish(), notes: z.string().trim().max(500).nullish() }).parse(await body(c));
    return c.json({ period: await createPeriod(actor, input) }, 201);
  });

  app.get(`${BASE}/periods/:id`, async (c) => {
    const actor = await requireStaff(c, deps, c.req.param("ws"), "pay:view");
    return c.json({ period: await getPeriod(actor, c.req.param("id")) });
  });

  app.post(`${BASE}/periods/:id/calculate`, async (c) => {
    const actor = await requireStaff(c, deps, c.req.param("ws"), "payroll:manage");
    return c.json({ period: await calculatePeriod(actor, c.req.param("id")) });
  });

  app.post(`${BASE}/periods/:id/submit`, async (c) => {
    const actor = await requireStaff(c, deps, c.req.param("ws"), "payroll:manage");
    const { comment: note } = comment().parse(await body(c));
    return c.json({ period: await submitPeriod(actor, c.req.param("id"), note ?? null) });
  });

  app.post(`${BASE}/periods/:id/approve`, async (c) => {
    const actor = await requireStaff(c, deps, c.req.param("ws"), "payroll:approve");
    const input = z.object({ version: z.number().int().min(0), comment: z.string().trim().max(500).nullish() }).parse(await body(c));
    return c.json({ period: await approvePeriod(actor, c.req.param("id"), input.version, input.comment ?? null) });
  });

  app.post(`${BASE}/periods/:id/reject`, async (c) => {
    const actor = await requireStaff(c, deps, c.req.param("ws"), "payroll:approve");
    const { comment: note } = comment(3).parse(await body(c));
    return c.json({ period: await rejectPeriod(actor, c.req.param("id"), note!) });
  });

  app.post(`${BASE}/periods/:id/cancel`, async (c) => {
    const actor = await requireStaff(c, deps, c.req.param("ws"), "payroll:approve");
    const { comment: note } = comment().parse(await body(c));
    return c.json({ period: await cancelPeriod(actor, c.req.param("id"), note ?? null) });
  });

  app.post(`${BASE}/periods/:id/reverse`, async (c) => {
    const actor = await requireStaff(c, deps, c.req.param("ws"), "payroll:approve");
    const { comment: note } = comment(3).parse(await body(c));
    return c.json({ period: await reversePeriod(actor, c.req.param("id"), note!) });
  });

  app.post(`${BASE}/periods/:id/adjustments`, async (c) => {
    const actor = await requireStaff(c, deps, c.req.param("ws"), "payroll:manage");
    const input = z
      .object({ employeeId: idSchema, kind: z.enum(["earning", "deduction"]), label: z.string().trim().min(1, "Name the adjustment").max(80), amount, reason: z.string().trim().max(300).nullish() })
      .parse(await body(c));
    return c.json({ period: await addAdjustment(actor, c.req.param("id"), input) });
  });

  app.delete(`${BASE}/periods/:id/adjustments/:adjustmentId`, async (c) => {
    const actor = await requireStaff(c, deps, c.req.param("ws"), "payroll:manage");
    return c.json({ period: await removeAdjustment(actor, c.req.param("id"), c.req.param("adjustmentId")) });
  });

  // ---------------- Payments ----------------
  app.get(`${BASE}/payments`, async (c) => {
    const actor = await requireStaff(c, deps, c.req.param("ws"), "pay:view");
    const q = pageSchema
      .extend({
        employeeId: idSchema.optional(),
        periodId: idSchema.optional(),
        from: daySchema.optional(),
        to: daySchema.optional(),
        status: z.enum(PAYMENT_STATUSES).optional(),
        method: z.enum(PAYMENT_METHODS).optional(),
      })
      .parse(c.req.query());
    return c.json(await listPayments(actor, q));
  });

  app.get(`${BASE}/payable`, async (c) => {
    const actor = await requireStaff(c, deps, c.req.param("ws"), "payments:manage");
    const { employeeId } = z.object({ employeeId: idSchema.optional() }).parse(c.req.query());
    return c.json({ items: await payableItems(actor, employeeId) });
  });

  /** Record a payment. Idempotency-Key is required: the same form sent twice records one payment. */
  app.post(`${BASE}/payments`, async (c) => {
    const actor = await requireStaff(c, deps, c.req.param("ws"), "payments:manage");
    const key = idempotencyKey(c, true)!;
    const input = z
      .object({
        employeeId: idSchema,
        payrollItemId: idSchema,
        amount,
        paidOn: daySchema,
        method: z.enum(PAYMENT_METHODS),
        reference: z.string().trim().max(120).nullish(),
        remarks: z.string().trim().max(500).nullish(),
        confirmDuplicate: z.boolean().optional(),
      })
      .parse(await body(c));
    const result = await recordPayment(actor, { ...input, idempotencyKey: key });
    return c.json(result, result.replayed ? 200 : 201);
  });

  app.post(`${BASE}/payments/:id/fail`, async (c) => {
    const actor = await requireStaff(c, deps, c.req.param("ws"), "payments:manage");
    const { comment: reason } = comment(3).parse(await body(c));
    return c.json({ payment: await changePaymentStatus(actor, c.req.param("id"), "failed", reason!) });
  });

  app.post(`${BASE}/payments/:id/reverse`, async (c) => {
    const actor = await requireStaff(c, deps, c.req.param("ws"), "payments:manage");
    const { comment: reason } = comment(3).parse(await body(c));
    return c.json({ payment: await changePaymentStatus(actor, c.req.param("id"), "reversed", reason!) });
  });
}

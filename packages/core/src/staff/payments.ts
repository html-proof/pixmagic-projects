import { Prisma, systemDb, withTenant, type PayrollPayment, type Tx } from "@app/db";
import { isCalendarDay, localDayOf, minorToString, PAYABLE_STATUSES, shiftDay, toMinor, type PaymentMethod, type PaymentStatus } from "@app/shared/staff";
import { audit } from "../notify.js";
import { employeeScope, isUniqueViolation, notFound, serverNow, StaffError, type StaffActor } from "./common.js";
import { refreshPeriodStatus } from "./payroll.js";
import { ensureStaffSettings } from "./settings.js";

/**
 * Payment records. Recording a payment says money was paid outside Insights (a bank transfer, cash,
 * a cheque, a payroll provider); Insights moves no money and connects to no payment provider.
 *
 * Duplicates are stopped three ways: the form's Idempotency-Key (the same submission twice records
 * one payment), the outstanding balance (an item can't be paid past what it owes, checked with the
 * item row locked), and a same-day-same-amount check that has to be confirmed. A transaction
 * reference is unique per employee and method.
 */

export interface PaymentInput {
  employeeId: string;
  payrollItemId: string;
  amount: string;
  paidOn: string;
  method: PaymentMethod;
  reference?: string | null;
  remarks?: string | null;
  idempotencyKey: string;
  confirmDuplicate?: boolean;
}

type PaymentRow = PayrollPayment & {
  employee?: { id: string; fullName: string; employeeNumber: string } | null;
  allocations: Array<{ amountMinor: bigint; payrollItemId: string; item: { id: string; netMinor: bigint; paidMinor: bigint; currency: string; period: { id: string; startDate: string; endDate: string; status: string } } }>;
};

export function paymentView(p: PaymentRow, names?: Map<string, string>) {
  return {
    id: p.id,
    employee: p.employee ? { id: p.employee.id, fullName: p.employee.fullName, employeeNumber: p.employee.employeeNumber } : { id: p.employeeId },
    amount: minorToString(p.amountMinor, p.currency),
    currency: p.currency,
    paidOn: p.paidOn,
    method: p.method as PaymentMethod,
    reference: p.reference,
    remarks: p.remarks,
    status: p.status as PaymentStatus,
    statusReason: p.statusReason,
    recordedBy: p.recordedByUserId ? (names?.get(p.recordedByUserId) ?? null) : null,
    recordedAt: p.createdAt,
    allocations: p.allocations.map((a) => ({
      payrollItemId: a.payrollItemId,
      amount: minorToString(a.amountMinor, p.currency),
      period: { id: a.item.period.id, from: a.item.period.startDate, to: a.item.period.endDate, status: a.item.period.status },
      itemNet: minorToString(a.item.netMinor, a.item.currency),
      itemOutstanding: minorToString(a.item.netMinor > a.item.paidMinor ? a.item.netMinor - a.item.paidMinor : 0n, a.item.currency),
    })),
  };
}

const PAYMENT_INCLUDE = {
  employee: { select: { id: true, fullName: true, employeeNumber: true } },
  allocations: { include: { item: { select: { id: true, netMinor: true, paidMinor: true, currency: true, period: { select: { id: true, startDate: true, endDate: true, status: true } } } } } },
} satisfies Prisma.PayrollPaymentInclude;

async function lockItem(tx: Tx, workspaceId: string, itemId: string) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM payroll_items WHERE id = ${itemId} AND workspace_id = ${workspaceId} FOR UPDATE`;
  return rows.length === 1;
}

export async function recordPayment(actor: StaffActor, input: PaymentInput) {
  const settings = await ensureStaffSettings(actor.workspaceId);
  const today = localDayOf(Date.now(), settings.timezone);
  if (!isCalendarDay(input.paidOn) || input.paidOn < "2000-01-01") throw new StaffError(400, "invalid_date", "Choose the day the payment was made.");
  if (input.paidOn > shiftDay(today, 1)) throw new StaffError(400, "future_date", "A payment can't be recorded for a future date. Record it once it's been made.");
  const ws = actor.workspaceId;
  const reference = input.reference?.trim() || null;
  try {
    const result = await withTenant(ws, async (tx) => {
      const prior = await tx.payrollPayment.findUnique({ where: { workspaceId_idempotencyKey: { workspaceId: ws, idempotencyKey: input.idempotencyKey } }, include: PAYMENT_INCLUDE });
      if (prior) {
        const sameRequest = prior.employeeId === input.employeeId && prior.allocations.some((a) => a.payrollItemId === input.payrollItemId);
        if (!sameRequest) throw new StaffError(409, "idempotency_conflict", "This form was already used for a different payment. Reload the page and try again.");
        return { payment: prior, replayed: true };
      }
      if (!(await lockItem(tx, ws, input.payrollItemId))) throw notFound("That payroll item");
      const item = await tx.payrollItem.findUniqueOrThrow({ where: { id: input.payrollItemId }, include: { period: true, employee: { select: { id: true, workspaceId: true } } } });
      if (item.employeeId !== input.employeeId) throw new StaffError(400, "wrong_employee", "That pay period entry belongs to someone else.");
      const inScope = await tx.employee.count({ where: { ...employeeScope(actor), id: item.employeeId } });
      if (!inScope) throw notFound("That employee");
      if (!(PAYABLE_STATUSES as readonly string[]).includes(item.period.status)) {
        throw new StaffError(409, "not_approved", "This payroll hasn't been approved yet. Approve it before recording payments.");
      }
      let amountMinor: bigint;
      try {
        amountMinor = toMinor(input.amount, item.currency);
      } catch {
        throw new StaffError(400, "invalid_amount", `Enter the amount in ${item.currency}, like 160 or 160.00.`);
      }
      if (amountMinor <= 0n) throw new StaffError(400, "invalid_amount", "The amount has to be more than zero.");
      const outstanding = item.netMinor - item.paidMinor;
      if (outstanding <= 0n) throw new StaffError(409, "already_paid", "This pay is already fully paid.");
      if (amountMinor > outstanding) {
        throw new StaffError(409, "overpayment", `That's more than the ${minorToString(outstanding, item.currency)} ${item.currency} still owed for this period.`, { outstanding: minorToString(outstanding, item.currency) });
      }
      if (!input.confirmDuplicate) {
        const twin = await tx.paymentAllocation.findFirst({
          where: { payrollItemId: item.id, amountMinor, payment: { status: "completed", paidOn: input.paidOn } },
          include: { payment: true },
        });
        if (twin) {
          throw new StaffError(409, "possible_duplicate", `A payment of ${minorToString(amountMinor, item.currency)} ${item.currency} on ${input.paidOn} is already recorded for this period. Record it anyway only if it's a separate payment.`, {
            paymentId: twin.paymentId,
          });
        }
      }
      const payment = await tx.payrollPayment.create({
        data: {
          workspaceId: ws,
          employeeId: item.employeeId,
          currency: item.currency,
          amountMinor,
          paidOn: input.paidOn,
          method: input.method,
          reference,
          remarks: input.remarks?.trim() || null,
          idempotencyKey: input.idempotencyKey,
          recordedByUserId: actor.userId,
          allocations: { create: { workspaceId: ws, payrollItemId: item.id, amountMinor } },
        },
        include: PAYMENT_INCLUDE,
      });
      await tx.payrollItem.update({ where: { id: item.id }, data: { paidMinor: { increment: amountMinor } } });
      await refreshPeriodStatus(tx, item.periodId);
      const fresh = await tx.payrollPayment.findUniqueOrThrow({ where: { id: payment.id }, include: PAYMENT_INCLUDE });
      return { payment: fresh, replayed: false };
    });
    if (!result.replayed) {
      await audit({
        workspaceId: ws,
        actorUserId: actor.userId,
        action: "payroll.payment_recorded",
        targetType: "employee",
        targetId: input.employeeId,
        metadata: { paymentId: result.payment.id, amount: minorToString(result.payment.amountMinor, result.payment.currency), currency: result.payment.currency, method: input.method },
        ip: actor.ip,
      });
    }
    return { payment: paymentView(result.payment), replayed: result.replayed };
  } catch (err) {
    if (isUniqueViolation(err, "one_reference")) throw new StaffError(409, "duplicate_reference", "A payment with that transaction reference is already recorded for this employee.");
    if (isUniqueViolation(err, "idempotency_key")) {
      // Two submissions of the same form raced: the other one recorded it.
      const prior = await systemDb.payrollPayment.findUnique({ where: { workspaceId_idempotencyKey: { workspaceId: ws, idempotencyKey: input.idempotencyKey } }, include: PAYMENT_INCLUDE });
      if (prior) return { payment: paymentView(prior), replayed: true };
    }
    throw err;
  }
}

/** Mark a recorded payment as failed (it bounced) or reversed (recorded by mistake / refunded). */
export async function changePaymentStatus(actor: StaffActor, paymentId: string, to: "failed" | "reversed", reason: string) {
  const ws = actor.workspaceId;
  const now = serverNow();
  const p = await withTenant(ws, async (tx) => {
    const p = await tx.payrollPayment.findFirst({ where: { id: paymentId, workspaceId: ws, employee: employeeScope(actor) }, include: { allocations: true } });
    if (!p) throw notFound("That payment");
    if (p.status !== "completed") throw new StaffError(409, "not_completed", `This payment is already marked ${p.status}.`);
    for (const a of p.allocations) {
      await lockItem(tx, ws, a.payrollItemId);
      await tx.payrollItem.update({ where: { id: a.payrollItemId }, data: { paidMinor: { decrement: a.amountMinor } } });
    }
    await tx.payrollPayment.update({
      where: { id: p.id },
      data: { status: to, statusReason: reason, statusChangedByUserId: actor.userId, ...(to === "failed" ? { failedAt: now } : { reversedAt: now }) },
    });
    const periods = await tx.payrollItem.findMany({ where: { id: { in: p.allocations.map((a) => a.payrollItemId) } }, select: { periodId: true } });
    for (const { periodId } of periods) await refreshPeriodStatus(tx, periodId);
    return tx.payrollPayment.findUniqueOrThrow({ where: { id: p.id }, include: PAYMENT_INCLUDE });
  });
  await audit({ workspaceId: ws, actorUserId: actor.userId, action: to === "failed" ? "payroll.payment_failed" : "payroll.payment_reversed", targetType: "employee", targetId: p.employeeId, metadata: { paymentId, reason }, ip: actor.ip });
  return paymentView(p);
}

export interface PaymentFilters {
  employeeId?: string;
  periodId?: string;
  from?: string;
  to?: string;
  status?: PaymentStatus;
  method?: PaymentMethod;
  page: number;
  pageSize: number;
}

export async function listPayments(actor: StaffActor, f: PaymentFilters) {
  const ws = actor.workspaceId;
  const where: Prisma.PayrollPaymentWhereInput = {
    workspaceId: ws,
    employee: employeeScope(actor),
    ...(f.employeeId ? { employeeId: f.employeeId } : {}),
    ...(f.periodId ? { allocations: { some: { item: { periodId: f.periodId } } } } : {}),
    ...(f.status ? { status: f.status } : {}),
    ...(f.method ? { method: f.method } : {}),
    ...(f.from || f.to ? { paidOn: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: f.to } : {}) } } : {}),
  };
  return withTenant(ws, async (tx) => {
    const [total, rows, sums] = await Promise.all([
      tx.payrollPayment.count({ where }),
      tx.payrollPayment.findMany({ where, include: PAYMENT_INCLUDE, orderBy: [{ paidOn: "desc" }, { createdAt: "desc" }], skip: (f.page - 1) * f.pageSize, take: f.pageSize }),
      tx.payrollPayment.groupBy({ by: ["currency", "status"], where, _sum: { amountMinor: true }, _count: true }),
    ]);
    const users = await systemDb.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.recordedByUserId).filter(Boolean))] as string[] } }, select: { id: true, displayName: true, email: true } });
    const names = new Map(users.map((u) => [u.id, u.displayName ?? u.email]));
    return {
      total,
      page: f.page,
      pageSize: f.pageSize,
      totals: sums.map((s) => ({ currency: s.currency, status: s.status, count: s._count, amount: minorToString(s._sum.amountMinor ?? 0n, s.currency) })),
      items: rows.map((r) => paymentView(r, names)),
    };
  });
}

/** Pay items with money still owed, for the "Record payment" form's picker. */
export async function payableItems(actor: StaffActor, employeeId?: string) {
  return withTenant(actor.workspaceId, async (tx) => {
    const items = await tx.payrollItem.findMany({
      where: { workspaceId: actor.workspaceId, period: { status: { in: [...PAYABLE_STATUSES] } }, employee: employeeScope(actor), ...(employeeId ? { employeeId } : {}) },
      include: { period: { select: { id: true, startDate: true, endDate: true, status: true } }, employee: { select: { id: true, fullName: true, employeeNumber: true } } },
      orderBy: [{ period: { startDate: "desc" } }],
      take: 500,
    });
    return items
      .filter((i) => i.netMinor > i.paidMinor)
      .map((i) => ({
        id: i.id,
        employee: i.employee,
        period: { id: i.period.id, from: i.period.startDate, to: i.period.endDate, status: i.period.status },
        currency: i.currency,
        net: minorToString(i.netMinor, i.currency),
        paid: minorToString(i.paidMinor, i.currency),
        outstanding: minorToString(i.netMinor - i.paidMinor, i.currency),
      }));
  });
}

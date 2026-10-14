import { systemDb, withTenant, type Prisma } from "@app/db";
import {
  bucketOf,
  formatDuration,
  hoursDecimal,
  localDayOf,
  minorToString,
  PAY_CATEGORY_LABEL,
  PAYABLE_STATUSES,
  PAYMENT_METHOD_LABEL,
  PAYMENT_STATUS_LABEL,
  PAYROLL_STATUS_LABEL,
  resolveRange,
  sessionWork,
  staffCan,
  startOfLocalDay,
  endOfLocalDay,
  trimDecimal,
  type DayRange,
  type PaymentMethod,
  type PaymentStatus,
  type PayrollStatus,
  type RangePreset,
} from "@app/shared/staff";
import { displayRate, employeeScope, notFound, StaffError, type StaffActor } from "./common.js";
import { computeWork, loadWork, priceByBucket, workedSeconds } from "./calc.js";
import { PdfDoc, toCsv, toXlsx, type XlsxCell } from "./files.js";
import type { StoredLine } from "./payroll.js";
import { ensureStaffSettings } from "./settings.js";

/**
 * Reports: one table builder for the Reports page and every export, so a CSV, a spreadsheet and the
 * screen always say the same thing. Everything is computed from the database at request time.
 */

export const REPORT_TYPES = ["attendance", "payroll", "payments"] as const;
export type ReportType = (typeof REPORT_TYPES)[number];
export const REPORT_GROUPS = ["employee", "department", "position", "day", "week", "month", "year", "period", "method", "status"] as const;
export type ReportGroup = (typeof REPORT_GROUPS)[number];

const VALID_GROUPS: Record<ReportType, ReportGroup[]> = {
  attendance: ["employee", "department", "position", "day", "week", "month", "year"],
  payroll: ["employee", "department", "position", "period", "month", "year", "status"],
  payments: ["employee", "department", "method", "status", "day", "week", "month", "year"],
};

export type ColumnKind = "text" | "hours" | "money" | "count";
export interface ReportColumn {
  key: string;
  label: string;
  kind: ColumnKind;
}
export type ReportValue = string | number | null;
export interface ReportTable {
  title: string;
  subtitle: string;
  range: DayRange;
  columns: ReportColumn[];
  rows: Array<Record<string, ReportValue>>;
  totals: Record<string, ReportValue> | null;
  notes: string[];
}

export interface ReportInput {
  type: ReportType;
  groupBy: ReportGroup;
  preset: RangePreset;
  from?: string;
  to?: string;
  periodId?: string;
  employeeId?: string;
  departmentId?: string;
  paymentStatus?: PaymentStatus;
}

const MAX_ROWS = 5000;

export async function buildReport(actor: StaffActor, input: ReportInput): Promise<ReportTable> {
  if (!VALID_GROUPS[input.type].includes(input.groupBy)) throw new StaffError(400, "invalid_group", `A ${input.type} report can't be grouped by ${input.groupBy}.`);
  const pay = staffCan(actor.access, "pay:view");
  if ((input.type === "payroll" || input.type === "payments") && !pay) throw new StaffError(403, "forbidden", "Pay reports are for payroll managers, admins and owners.");
  const settings = await ensureStaffSettings(actor.workspaceId);
  const today = localDayOf(Date.now(), settings.timezone);
  const { range } = resolveRange(input.preset, today, settings.weekStartsOn, { from: input.from, to: input.to });
  const tz = settings.timezone;
  const cur = settings.currency;
  const groupLabel: Record<ReportGroup, string> = {
    employee: "Employee",
    department: "Department",
    position: "Position",
    day: "Day",
    week: "Week starting",
    month: "Month",
    year: "Year",
    period: "Pay period",
    method: "Payment method",
    status: "Status",
  };
  const timeKey = (day: string, g: ReportGroup) => (g === "day" || g === "week" || g === "month" || g === "year" ? bucketOf(day, g, settings.weekStartsOn) : null);
  const scope: Prisma.EmployeeWhereInput = { ...employeeScope(actor), ...(input.employeeId ? { id: input.employeeId } : {}), ...(input.departmentId ? { departmentId: input.departmentId } : {}) };

  return withTenant(actor.workspaceId, async (tx): Promise<ReportTable> => {
    if (input.type === "attendance") {
      const data = await loadWork(tx, settings, { ...range, filter: "estimate", employeeWhere: scope });
      const work = computeWork(data, range, Date.now());
      const start = new Date(startOfLocalDay(range.from, tz));
      const end = new Date(endOfLocalDay(range.to, tz));
      const sessions = await tx.attendanceSession.findMany({
        where: { workspaceId: actor.workspaceId, employee: scope, approvalStatus: { not: "rejected" }, clockInAt: { gte: start, lt: end } },
        include: { breaks: true },
      });
      type Acc = { label: string; currency: string | null; shifts: number; worked: number; regular: number; overtime: number; unpaidBreak: number; late: number; gross: bigint };
      const groups = new Map<string, Acc>();
      const keyFor = (empId: string, day: string): [string, string] => {
        const e = data.employees.get(empId);
        const t = timeKey(day, input.groupBy);
        if (t) return [t, t];
        if (input.groupBy === "employee") return [empId, e ? `${e.fullName} (${e.employeeNumber})` : empId];
        if (input.groupBy === "department") return [e?.departmentId ?? "-", e?.departmentName ?? "No department"];
        return [(e?.jobTitle ?? "").toLowerCase(), e?.jobTitle ?? "-"];
      };
      const acc = (k: string, label: string, currency: string | null) => {
        let a = groups.get(k);
        if (!a) groups.set(k, (a = { label, currency, shifts: 0, worked: 0, regular: 0, overtime: 0, unpaidBreak: 0, late: 0, gross: 0n }));
        return a;
      };
      for (const w of work.values()) {
        const byKey = priceByBucket(w.chunks, w.employee.rates, w.employee.currency, (c) => keyFor(w.employee.id, c.day).join("\u0000"));
        for (const [k, p] of byKey) {
          const [key, label] = k.split("\u0000") as [string, string];
          const a = acc(key, label, w.employee.currency);
          a.worked += workedSeconds(p);
          a.regular += p.regularSeconds + p.holidaySeconds;
          a.overtime += p.overtimeSeconds + p.doubleTimeSeconds;
          if (w.employee.currency === cur) a.gross += p.grossMinor;
        }
      }
      for (const s of sessions) {
        const day = localDayOf(s.clockInAt.getTime(), tz);
        const [key, label] = keyFor(s.employeeId, day);
        const a = acc(key, label, null);
        a.shifts += 1;
        if (s.flags.includes("late")) a.late += 1;
        a.unpaidBreak += sessionWork(
          { id: s.id, clockInAt: s.clockInAt.getTime(), clockOutAt: s.clockOutAt?.getTime() ?? null },
          s.breaks.map((b) => ({ startAt: b.startAt.getTime(), endAt: b.endAt?.getTime() ?? null, paid: b.paid })),
          Date.now(),
        ).unpaidBreakSeconds;
      }
      const rows = [...groups.values()].sort((a, b) => a.label.localeCompare(b.label)).slice(0, MAX_ROWS);
      const columns: ReportColumn[] = [
        { key: "group", label: groupLabel[input.groupBy], kind: "text" },
        { key: "shifts", label: "Shifts", kind: "count" },
        { key: "worked", label: "Hours worked", kind: "hours" },
        { key: "regular", label: "Regular hours", kind: "hours" },
        { key: "overtime", label: "Overtime hours", kind: "hours" },
        { key: "unpaidBreak", label: "Unpaid breaks", kind: "hours" },
        { key: "late", label: "Late starts", kind: "count" },
        ...(pay ? [{ key: "gross", label: `Estimated wages (${cur})`, kind: "money" as const }] : []),
      ];
      const sum = (f: (a: Acc) => number) => rows.reduce((t, a) => t + f(a), 0);
      return {
        title: "Attendance report",
        subtitle: `${range.from} to ${range.to} · times in ${tz}`,
        range,
        columns,
        rows: rows.map((a) => ({ group: a.label, shifts: a.shifts, worked: a.worked, regular: a.regular, overtime: a.overtime, unpaidBreak: a.unpaidBreak, late: a.late, ...(pay ? { gross: minorToString(a.gross, cur) } : {}) })),
        totals: { group: "Total", shifts: sum((a) => a.shifts), worked: sum((a) => a.worked), regular: sum((a) => a.regular), overtime: sum((a) => a.overtime), unpaidBreak: sum((a) => a.unpaidBreak), late: sum((a) => a.late), ...(pay ? { gross: minorToString(rows.reduce((t, a) => t + a.gross, 0n), cur) } : {}) },
        notes: [
          "Hours come from clock-in and clock-out records (rejected shifts excluded, shifts still running counted up to now).",
          ...(pay ? [`Estimated wages use each day's pay rate and your overtime rules, in ${cur}; staff paid in other currencies count in hours only.`] : []),
        ],
      };
    }

    if (input.type === "payroll") {
      const items = await tx.payrollItem.findMany({
        where: {
          workspaceId: actor.workspaceId,
          employee: scope,
          period: input.periodId ? { id: input.periodId } : { status: { notIn: ["cancelled", "reversed"] }, endDate: { gte: range.from, lte: range.to } },
        },
        include: { period: true, employee: { include: { department: { select: { name: true } } } } },
      });
      type Acc = { label: string; currency: string; regular: number; overtime: number; gross: bigint; other: bigint; deductions: bigint; net: bigint; paid: bigint; approved: boolean };
      const groups = new Map<string, Acc>();
      for (const i of items) {
        const statusLabel = PAYROLL_STATUS_LABEL[i.period.status as PayrollStatus] ?? i.period.status;
        const t = timeKey(i.period.endDate, input.groupBy);
        const [k, label] =
          t
            ? [t, t]
            : input.groupBy === "employee"
              ? [i.employeeId, `${i.employee.fullName} (${i.employee.employeeNumber})`]
              : input.groupBy === "department"
                ? [i.employee.departmentId ?? "-", i.employee.department?.name ?? "No department"]
                : input.groupBy === "position"
                  ? [i.employee.jobTitle.toLowerCase(), i.employee.jobTitle]
                  : input.groupBy === "period"
                    ? [i.periodId, `${i.period.startDate} to ${i.period.endDate} (${statusLabel})`]
                    : [i.period.status, statusLabel];
        const key = `${k}|${i.currency}`;
        let a = groups.get(key);
        if (!a) groups.set(key, (a = { label, currency: i.currency, regular: 0, overtime: 0, gross: 0n, other: 0n, deductions: 0n, net: 0n, paid: 0n, approved: true }));
        a.regular += i.regularSeconds + i.holidaySeconds;
        a.overtime += i.overtimeSeconds + i.doubleTimeSeconds;
        a.gross += i.grossMinor;
        a.other += i.otherEarningsMinor;
        a.deductions += i.deductionsMinor;
        a.net += i.netMinor;
        a.paid += i.paidMinor;
        if (!(PAYABLE_STATUSES as readonly string[]).includes(i.period.status)) a.approved = false;
      }
      const rows = [...groups.values()].sort((a, b) => a.label.localeCompare(b.label) || a.currency.localeCompare(b.currency)).slice(0, MAX_ROWS);
      const currencies = [...new Set(rows.map((r) => r.currency))];
      const one = currencies.length <= 1 ? (currencies[0] ?? cur) : null;
      const m = (v: bigint, c: string) => minorToString(v, c);
      return {
        title: "Payroll report",
        subtitle: input.periodId ? "One pay period" : `Pay periods ending ${range.from} to ${range.to}`,
        range,
        columns: [
          { key: "group", label: groupLabel[input.groupBy], kind: "text" },
          { key: "currency", label: "Currency", kind: "text" },
          { key: "regular", label: "Regular hours", kind: "hours" },
          { key: "overtime", label: "Overtime hours", kind: "hours" },
          { key: "gross", label: "Gross", kind: "money" },
          { key: "other", label: "Other earnings", kind: "money" },
          { key: "deductions", label: "Deductions", kind: "money" },
          { key: "net", label: "Net (estimated)", kind: "money" },
          { key: "paid", label: "Paid", kind: "money" },
          { key: "outstanding", label: "Outstanding", kind: "money" },
          { key: "approved", label: "Approved", kind: "text" },
        ],
        rows: rows.map((a) => ({
          group: a.label,
          currency: a.currency,
          regular: a.regular,
          overtime: a.overtime,
          gross: m(a.gross, a.currency),
          other: m(a.other, a.currency),
          deductions: m(a.deductions, a.currency),
          net: m(a.net, a.currency),
          paid: m(a.paid, a.currency),
          outstanding: m(a.net > a.paid ? a.net - a.paid : 0n, a.currency),
          approved: a.approved ? "Yes" : "No (draft)",
        })),
        totals: one
          ? {
              group: "Total",
              currency: one,
              regular: rows.reduce((t, a) => t + a.regular, 0),
              overtime: rows.reduce((t, a) => t + a.overtime, 0),
              gross: m(rows.reduce((t, a) => t + a.gross, 0n), one),
              other: m(rows.reduce((t, a) => t + a.other, 0n), one),
              deductions: m(rows.reduce((t, a) => t + a.deductions, 0n), one),
              net: m(rows.reduce((t, a) => t + a.net, 0n), one),
              paid: m(rows.reduce((t, a) => t + a.paid, 0n), one),
              outstanding: m(rows.reduce((t, a) => t + (a.net > a.paid ? a.net - a.paid : 0n), 0n), one),
              approved: "",
            }
          : null,
        notes: [
          "Net pay is gross pay plus other earnings minus the deductions you added. Insights doesn't calculate tax or statutory deductions.",
          "Draft payroll is included and marked; only approved payroll is final.",
        ],
      };
    }

    // payments
    const payments = await tx.payrollPayment.findMany({
      where: {
        workspaceId: actor.workspaceId,
        employee: scope,
        paidOn: { gte: range.from, lte: range.to },
        ...(input.paymentStatus ? { status: input.paymentStatus } : {}),
        ...(input.periodId ? { allocations: { some: { item: { periodId: input.periodId } } } } : {}),
      },
      include: { employee: { include: { department: { select: { name: true } } } } },
    });
    type Acc = { label: string; currency: string; count: number; amount: bigint };
    const groups = new Map<string, Acc>();
    for (const p of payments) {
      const t = timeKey(p.paidOn, input.groupBy);
      const [k, label] = t
        ? [t, t]
        : input.groupBy === "employee"
          ? [p.employeeId, `${p.employee.fullName} (${p.employee.employeeNumber})`]
          : input.groupBy === "department"
            ? [p.employee.departmentId ?? "-", p.employee.department?.name ?? "No department"]
            : input.groupBy === "method"
              ? [p.method, PAYMENT_METHOD_LABEL[p.method as PaymentMethod] ?? p.method]
              : [p.status, PAYMENT_STATUS_LABEL[p.status as PaymentStatus] ?? p.status];
      const key = `${k}|${p.currency}`;
      let a = groups.get(key);
      if (!a) groups.set(key, (a = { label, currency: p.currency, count: 0, amount: 0n }));
      a.count += 1;
      a.amount += p.amountMinor;
    }
    const rows = [...groups.values()].sort((a, b) => a.label.localeCompare(b.label)).slice(0, MAX_ROWS);
    const currencies = [...new Set(rows.map((r) => r.currency))];
    const one = currencies.length <= 1 ? (currencies[0] ?? cur) : null;
    return {
      title: "Payments report",
      subtitle: `Payments dated ${range.from} to ${range.to}${input.paymentStatus ? ` · ${PAYMENT_STATUS_LABEL[input.paymentStatus]}` : ""}`,
      range,
      columns: [
        { key: "group", label: groupLabel[input.groupBy], kind: "text" },
        { key: "currency", label: "Currency", kind: "text" },
        { key: "count", label: "Payments", kind: "count" },
        { key: "amount", label: "Amount", kind: "money" },
      ],
      rows: rows.map((a) => ({ group: a.label, currency: a.currency, count: a.count, amount: minorToString(a.amount, a.currency) })),
      totals: one ? { group: "Total", currency: one, count: rows.reduce((t, a) => t + a.count, 0), amount: minorToString(rows.reduce((t, a) => t + a.amount, 0n), one) } : null,
      notes: ["Recorded payments only: Insights doesn't move money. Failed and reversed payments are included unless you filter them out."],
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------------

export type ExportFormat = "csv" | "xlsx" | "pdf";

const CONTENT_TYPE: Record<ExportFormat, string> = {
  csv: "text/csv; charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
};

export interface ExportFile {
  filename: string;
  contentType: string;
  body: Uint8Array;
}

const cellText = (v: ReportValue, kind: ColumnKind) => (v === null ? "" : kind === "hours" ? hoursDecimal(Number(v)) : String(v));

export function reportFile(table: ReportTable, format: ExportFormat, organization: string): ExportFile {
  const slug = table.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-$/, "");
  const base = `${slug}_${table.range.from}_${table.range.to}`;
  const header = table.columns.map((c) => (c.kind === "hours" ? `${c.label} (h)` : c.label));
  const allRows = table.totals ? [...table.rows, table.totals] : table.rows;
  if (format === "csv") {
    return { filename: `${base}.csv`, contentType: CONTENT_TYPE.csv, body: toCsv(header, allRows.map((r) => table.columns.map((c) => cellText(r[c.key] ?? null, c.kind)))) };
  }
  if (format === "xlsx") {
    const rows: XlsxCell[][] = allRows.map((r) =>
      table.columns.map((c) => {
        const v = r[c.key];
        if (v === null || v === undefined || v === "") return { t: "empty" };
        if (c.kind === "hours") return { t: "number", v: hoursDecimal(Number(v)) };
        if (c.kind === "money" || c.kind === "count") return { t: "number", v: String(v) };
        return { t: "text", v: String(v) };
      }),
    );
    return { filename: `${base}.xlsx`, contentType: CONTENT_TYPE.xlsx, body: toXlsx(table.title, [`${organization} — ${table.title}`, table.subtitle], header, rows) };
  }
  const doc = new PdfDoc();
  doc.text(doc.margin, doc.y, organization, { size: 9, color: [0.18, 0.44, 0.31], bold: true });
  doc.y -= 18;
  doc.text(doc.margin, doc.y, table.title, { size: 16, bold: true });
  doc.y -= 16;
  doc.text(doc.margin, doc.y, table.subtitle, { size: 9, color: [0.42, 0.42, 0.39] });
  doc.y -= 22;
  const usable = doc.width - 2 * doc.margin;
  const first = Math.min(170, usable * 0.32);
  const rest = (usable - first) / Math.max(1, table.columns.length - 1);
  doc.table(
    table.columns.map((c, i) => ({ label: c.kind === "hours" ? `${c.label} (h)` : c.label, width: i === 0 ? first : rest, numeric: c.kind !== "text" })),
    allRows.map((r) => table.columns.map((c) => cellText(r[c.key] ?? null, c.kind))),
    { size: table.columns.length > 8 ? 7 : 8.5, boldLast: !!table.totals },
  );
  doc.y -= 10;
  for (const n of table.notes) doc.paragraph(n, { size: 8, color: [0.42, 0.42, 0.39] });
  return { filename: `${base}.pdf`, contentType: CONTENT_TYPE.pdf, body: doc.toBytes({ title: `${organization} — ${table.title}` }) };
}

/** A payslip for one employee and pay period (approved payroll only, unless a manager previews a draft). */
export async function payslip(workspaceId: string, itemId: string, opts: { employeeId?: string; scope?: Prisma.EmployeeWhereInput; allowDraft: boolean }): Promise<ExportFile> {
  const settings = await ensureStaffSettings(workspaceId);
  const item = await withTenant(workspaceId, (tx) =>
    tx.payrollItem.findFirst({
      where: { id: itemId, workspaceId, ...(opts.employeeId ? { employeeId: opts.employeeId } : {}), ...(opts.scope ? { employee: opts.scope } : {}) },
      include: {
        period: true,
        employee: { include: { department: { select: { name: true } } } },
        allocations: { include: { payment: true } },
      },
    }),
  );
  if (!item) throw notFound("That payslip");
  const approved = (PAYABLE_STATUSES as readonly string[]).includes(item.period.status);
  if (!approved && !opts.allowDraft) throw notFound("That payslip");
  const [workspace, adjustments] = await Promise.all([
    systemDb.workspace.findUnique({ where: { id: workspaceId }, select: { name: true } }),
    systemDb.payrollAdjustment.findMany({ where: { periodId: item.periodId, employeeId: item.employeeId, removedAt: null }, orderBy: { createdAt: "asc" } }),
  ]);
  const c = item.currency;
  const m = (v: bigint) => `${minorToString(v, c)} ${c}`;
  const doc = new PdfDoc();
  const left = doc.margin;
  const right = doc.width - doc.margin;
  doc.text(left, doc.y, workspace?.name ?? "", { size: 10, bold: true, color: [0.18, 0.44, 0.31] });
  doc.text(right, doc.y, approved ? "PAYSLIP" : "DRAFT — NOT APPROVED", { size: 10, bold: true, align: "right", color: approved ? [0.1, 0.1, 0.09] : [0.7, 0.14, 0.09] });
  doc.y -= 24;
  doc.text(left, doc.y, item.employee.fullName, { size: 16, bold: true });
  doc.y -= 16;
  doc.text(left, doc.y, `${item.employee.jobTitle}${item.employee.department ? ` · ${item.employee.department.name}` : ""} · ${item.employee.employeeNumber}`, { size: 9, color: [0.42, 0.42, 0.39] });
  doc.y -= 22;
  const facts: Array<[string, string]> = [
    ["Pay period", `${item.period.startDate} to ${item.period.endDate}`],
    ["Pay date", item.period.payDate ?? "Not set"],
    ["Status", PAYROLL_STATUS_LABEL[item.period.status as PayrollStatus] ?? item.period.status],
    ["Time zone", item.period.timezone],
    ...(settings.jurisdiction ? ([["Region", settings.jurisdiction]] as Array<[string, string]>) : []),
  ];
  for (const [k, v] of facts) {
    doc.text(left, doc.y, k, { size: 9, color: [0.42, 0.42, 0.39] });
    doc.text(left + 110, doc.y, v, { size: 9 });
    doc.y -= 13;
  }
  doc.y -= 10;
  doc.text(left, doc.y, "Earnings", { size: 11, bold: true });
  doc.y -= 16;
  const lines = (item.lines as unknown as StoredLine[]) ?? [];
  const earnRows = lines.map((l) => [
    PAY_CATEGORY_LABEL[l.category],
    hoursDecimal(l.seconds),
    `${displayRate(l.hourlyRate, c)}`,
    `${trimDecimal(l.multiplier)}x`,
    minorToString(BigInt(l.amountMinor), c),
  ]);
  for (const a of adjustments.filter((x) => x.kind === "earning")) earnRows.push([a.label, "", "", "", minorToString(a.amountMinor, c)]);
  earnRows.push(["Total earnings", hoursDecimal(item.regularSeconds + item.overtimeSeconds + item.doubleTimeSeconds + item.holidaySeconds), "", "", minorToString(item.grossMinor + item.otherEarningsMinor, c)]);
  doc.table(
    [
      { label: "Description", width: 190 },
      { label: "Hours", width: 70, numeric: true },
      { label: `Rate (${c})`, width: 80, numeric: true },
      { label: "Multiplier", width: 70, numeric: true },
      { label: `Amount (${c})`, width: 89, numeric: true },
    ],
    earnRows,
    { boldLast: true },
  );
  const deductions = adjustments.filter((x) => x.kind === "deduction");
  if (deductions.length) {
    doc.y -= 10;
    doc.text(left, doc.y, "Deductions", { size: 11, bold: true });
    doc.y -= 16;
    doc.table(
      [
        { label: "Description", width: 410 },
        { label: `Amount (${c})`, width: 89, numeric: true },
      ],
      [...deductions.map((d) => [d.label, minorToString(d.amountMinor, c)]), ["Total deductions", minorToString(item.deductionsMinor, c)]],
      { boldLast: true },
    );
  }
  doc.y -= 12;
  doc.ensure(60);
  doc.rect(left, doc.y - 30, right - left, 40, [0.95, 0.97, 0.95]);
  doc.text(left + 10, doc.y - 6, "Net pay (estimated)", { size: 11, bold: true });
  doc.text(right - 10, doc.y - 6, m(item.netMinor), { size: 13, bold: true, align: "right" });
  doc.text(left + 10, doc.y - 21, `Paid ${m(item.paidMinor)} · Outstanding ${m(item.netMinor > item.paidMinor ? item.netMinor - item.paidMinor : 0n)}`, { size: 8.5, color: [0.42, 0.42, 0.39] });
  doc.y -= 52;
  const payments = item.allocations.filter((a) => a.payment.status === "completed");
  if (payments.length) {
    doc.text(left, doc.y, "Payments", { size: 11, bold: true });
    doc.y -= 16;
    doc.table(
      [
        { label: "Date", width: 90 },
        { label: "Method", width: 120 },
        { label: "Reference", width: 200 },
        { label: `Amount (${c})`, width: 89, numeric: true },
      ],
      payments.map((a) => [a.payment.paidOn, PAYMENT_METHOD_LABEL[a.payment.method as PaymentMethod] ?? a.payment.method, a.payment.reference ?? "", minorToString(a.amountMinor, c)]),
    );
    doc.y -= 8;
  }
  doc.paragraph(
    `Hours worked: ${formatDuration(item.regularSeconds + item.overtimeSeconds + item.doubleTimeSeconds + item.holidaySeconds)} (unpaid breaks ${formatDuration(item.unpaidBreakSeconds)} not included). ` +
      "Gross pay is calculated from approved clock-in records at the pay rate in force on each day. No income tax, social security or other statutory deductions have been calculated by Insights; check your final pay with your employer.",
    { size: 8, color: [0.42, 0.42, 0.39] },
  );
  const name = item.employee.fullName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return {
    filename: `payslip_${name}_${item.period.startDate}_${item.period.endDate}.pdf`,
    contentType: CONTENT_TYPE.pdf,
    body: doc.toBytes({ title: `Payslip — ${item.employee.fullName} — ${item.period.startDate} to ${item.period.endDate}` }),
  };
}

/** A statement of an employee's pay and payments over a range (PDF). */
export async function employeeStatement(actor: StaffActor, employeeId: string, input: { preset: RangePreset; from?: string; to?: string }): Promise<ExportFile> {
  const settings = await ensureStaffSettings(actor.workspaceId);
  const today = localDayOf(Date.now(), settings.timezone);
  const { range } = resolveRange(input.preset, today, settings.weekStartsOn, { from: input.from, to: input.to });
  const data = await withTenant(actor.workspaceId, async (tx) => {
    const e = await tx.employee.findFirst({ where: { ...employeeScope(actor), id: employeeId } });
    if (!e) throw notFound("That employee");
    const [items, payments] = await Promise.all([
      tx.payrollItem.findMany({ where: { employeeId, workspaceId: actor.workspaceId, period: { status: { in: [...PAYABLE_STATUSES] }, endDate: { gte: range.from, lte: range.to } } }, include: { period: true }, orderBy: { period: { startDate: "asc" } } }),
      tx.payrollPayment.findMany({ where: { employeeId, workspaceId: actor.workspaceId, paidOn: { gte: range.from, lte: range.to } }, orderBy: { paidOn: "asc" } }),
    ]);
    return { e, items, payments };
  });
  const workspace = await systemDb.workspace.findUnique({ where: { id: actor.workspaceId }, select: { name: true } });
  const c = data.e.currency;
  const doc = new PdfDoc();
  doc.text(doc.margin, doc.y, workspace?.name ?? "", { size: 10, bold: true, color: [0.18, 0.44, 0.31] });
  doc.y -= 22;
  doc.text(doc.margin, doc.y, `Payment statement — ${data.e.fullName}`, { size: 15, bold: true });
  doc.y -= 15;
  doc.text(doc.margin, doc.y, `${data.e.employeeNumber} · ${range.from} to ${range.to}`, { size: 9, color: [0.42, 0.42, 0.39] });
  doc.y -= 24;
  doc.text(doc.margin, doc.y, "Approved pay", { size: 11, bold: true });
  doc.y -= 16;
  let net = 0n;
  let paid = 0n;
  doc.table(
    [
      { label: "Pay period", width: 150 },
      { label: "Hours", width: 60, numeric: true },
      { label: `Gross (${c})`, width: 75, numeric: true },
      { label: `Net (${c})`, width: 75, numeric: true },
      { label: `Paid (${c})`, width: 70, numeric: true },
      { label: `Outstanding (${c})`, width: 69, numeric: true },
    ],
    [
      ...data.items.map((i) => {
        net += i.netMinor;
        paid += i.paidMinor;
        return [
          `${i.period.startDate} to ${i.period.endDate}`,
          hoursDecimal(i.regularSeconds + i.overtimeSeconds + i.doubleTimeSeconds + i.holidaySeconds),
          minorToString(i.grossMinor, c),
          minorToString(i.netMinor, c),
          minorToString(i.paidMinor, c),
          minorToString(i.netMinor > i.paidMinor ? i.netMinor - i.paidMinor : 0n, c),
        ];
      }),
      ["Total", "", "", minorToString(net, c), minorToString(paid, c), minorToString(net > paid ? net - paid : 0n, c)],
    ],
    { boldLast: true },
  );
  doc.y -= 12;
  doc.text(doc.margin, doc.y, "Payments recorded", { size: 11, bold: true });
  doc.y -= 16;
  doc.table(
    [
      { label: "Date", width: 80 },
      { label: "Method", width: 110 },
      { label: "Reference", width: 160 },
      { label: "Status", width: 70 },
      { label: `Amount (${c})`, width: 79, numeric: true },
    ],
    data.payments.map((p) => [p.paidOn, PAYMENT_METHOD_LABEL[p.method as PaymentMethod] ?? p.method, p.reference ?? "", PAYMENT_STATUS_LABEL[p.status as PaymentStatus] ?? p.status, minorToString(p.amountMinor, p.currency)]),
  );
  doc.y -= 8;
  doc.paragraph("Net pay is an estimate: gross pay from approved hours plus the earnings and deductions your employer added. Insights doesn't calculate tax.", { size: 8, color: [0.42, 0.42, 0.39] });
  const name = data.e.fullName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return { filename: `statement_${name}_${range.from}_${range.to}.pdf`, contentType: CONTENT_TYPE.pdf, body: doc.toBytes({ title: `Payment statement — ${data.e.fullName}` }) };
}


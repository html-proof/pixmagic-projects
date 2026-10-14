"use client";
import { ChevronDown, ChevronRight, Lock } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Fragment, Suspense, useCallback, useId, useMemo, useState, type FormEvent } from "react";
import {
  EDITABLE_STATUSES,
  PAY_CATEGORY_LABEL,
  PAY_CYCLE_LABEL,
  PAYABLE_STATUSES,
  toMinor,
  type PayCategory,
  type PayCycle,
  type PayrollStatus,
} from "@app/shared/staff";
import { Badge, type Tone } from "@/components/dashboard/primitives";
import { LoadError } from "@/components/LoadError";
import { RecordPaymentModal } from "@/components/staff/RecordPayment";
import { EstimateNote, Field, Figure, Modal, PayrollBadge, Table, Td, Th } from "@/components/staff/ui";
import { Alert, EmptyState } from "@/components/ui";
import { ConfirmDialog, PageHeader, Skeleton, useAction, useToast } from "@/components/whatsapp/common";
import { actionError, api, ApiError, useApi } from "@/lib/api";
import { exportFile, fmtDateTime, fmtDay, fmtHoursDec, fmtMoney, fmtSpan, useStaff, type EmployeeRow } from "@/lib/staff";

// ---------------------------------------------------------------------------------------------
// One pay run: its figures per employee, what stands in the way of approving it, the approval
// workflow, earnings and deductions, payments, payslips and exports.
// ---------------------------------------------------------------------------------------------

type MoneyTotals = { gross: string; otherEarnings: string; deductions: string; net: string; paid: string; outstanding: string };

interface PayLine {
  category: PayCategory;
  hourlyRate: string;
  multiplier: string;
  seconds: number;
  amount: string;
}

type ItemPaymentStatus = "nothing_owed" | "paid" | "partially_paid" | "failed" | "unpaid";

interface Item {
  id: string;
  employee: { id: string; fullName: string; employeeNumber: string; jobTitle: string; department: string | null };
  currency: string;
  regularSeconds: number;
  overtimeSeconds: number;
  doubleTimeSeconds: number;
  holidaySeconds: number;
  paidBreakSeconds: number;
  unpaidBreakSeconds: number;
  unpricedSeconds: number;
  gross: string;
  otherEarnings: string;
  deductions: string;
  net: string;
  paid: string;
  outstanding: string;
  paymentStatus: ItemPaymentStatus;
  lines: PayLine[];
  warnings: string[];
  shifts: number;
}

interface Adjustment {
  id: string;
  employeeId: string;
  kind: "earning" | "deduction";
  label: string;
  amount: string;
  currency: string;
  reason: string | null;
  createdBy: string;
  createdAt: string;
}

interface Issue {
  code: string;
  message: string;
  count: number;
  employees: string[];
}

interface Period {
  id: string;
  startDate: string;
  endDate: string;
  payDate: string | null;
  payCycle: PayCycle;
  status: PayrollStatus;
  version: number;
  calculatedAt: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  locked: boolean;
  notes: string | null;
  employees: number;
  regularSeconds: number;
  overtimeSeconds: number;
  breakSeconds: number;
  totals: Record<string, MoneyTotals>;
  timezone: string;
  issues: Issue[];
  items: Item[];
  adjustments: Adjustment[];
  history: Array<{ id: string; action: string; version: number; by: string; comment: string | null; at: string }>;
  estimateNotice: string;
}

type Flow = "submit" | "approve" | "reject" | "cancel" | "reverse";

const FLOW: Record<Flow, { title: string; confirm: string; body: string; comment: string; required: boolean; danger: boolean; what: string; done: string }> = {
  submit: {
    title: "Send for approval?",
    confirm: "Send for approval",
    body: "Insights recalculates the figures with the latest hours first. Someone who may approve payroll then checks and approves them.",
    comment: "Note for the approver (optional)",
    required: false,
    danger: false,
    what: "send the payroll for approval",
    done: "Sent for approval.",
  },
  approve: {
    title: "Approve this payroll?",
    confirm: "Approve payroll",
    body: "Approving locks the hours and the figures for this period: its shifts can't be edited and the amounts won't change. Payments can then be recorded and payslips downloaded. If anything changed since the figures were calculated, nothing is approved and the payroll goes back for review.",
    comment: "Comment (optional)",
    required: false,
    danger: false,
    what: "approve the payroll",
    done: "Payroll approved. The hours and figures are now locked.",
  },
  reject: {
    title: "Send back for changes?",
    confirm: "Send back",
    body: "The payroll goes back to draft so the hours or adjustments can be corrected and the figures recalculated.",
    comment: "What needs to change",
    required: true,
    danger: true,
    what: "send the payroll back",
    done: "Sent back for changes.",
  },
  cancel: {
    title: "Cancel this pay run?",
    confirm: "Cancel pay run",
    body: "Nothing can be paid from a cancelled pay run, and its days can be included in a new one.",
    comment: "Reason (optional)",
    required: false,
    danger: true,
    what: "cancel the pay run",
    done: "Pay run cancelled.",
  },
  reverse: {
    title: "Reverse the approval?",
    confirm: "Reverse approval",
    body: "The figures are unlocked and the shifts can be edited again; the days can then be run again in a new pay run. This is only possible while no payments are recorded against it.",
    comment: "Reason",
    required: true,
    danger: true,
    what: "reverse the approval",
    done: "Approval reversed. The hours are unlocked.",
  },
};

const HISTORY_LABEL: Record<string, string> = {
  calculated: "Calculated",
  submitted: "Sent for approval",
  approved: "Approved",
  rejected: "Sent back for changes",
  cancelled: "Cancelled",
  reversed: "Approval reversed",
};
const PAYMENT_STATUS: Record<ItemPaymentStatus, { tone: Tone; label: string }> = {
  nothing_owed: { tone: "neutral", label: "Nothing owed" },
  paid: { tone: "good", label: "Paid" },
  partially_paid: { tone: "warn", label: "Partly paid" },
  failed: { tone: "danger", label: "Payment failed" },
  unpaid: { tone: "neutral", label: "Not paid yet" },
};
const WARNING_LABEL: Record<string, string> = {
  missing_rate: "No pay rate for some days",
  negative_net: "Deductions are more than earnings",
};

const AMOUNT_RE = /^\d{1,12}(\.\d{1,3})?$/;
const isZero = (amount: string) => /^0*(\.0*)?$/.test(amount);
const hours = (seconds: number) => `${fmtHoursDec(seconds)} h`;

export default function PayPeriodPage() {
  return (
    <Suspense fallback={<Skeleton lines={6} />}>
      <PayPeriod />
    </Suspense>
  );
}

function PayPeriod() {
  const periodId = useSearchParams().get("id") ?? "";
  const { base, can } = useStaff();
  const toast = useToast();
  const { busy, run } = useAction();
  const q = useApi<{ period: Period }>(periodId ? `${base}/payroll/periods/${encodeURIComponent(periodId)}` : null);
  const p = q.data?.period ?? null;

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<{ kind: "error" | "info"; text: string; issues?: Issue[] } | null>(null);

  // Workflow confirmation (with its comment).
  const [flow, setFlow] = useState<Flow | null>(null);
  const [comment, setComment] = useState("");
  const [commentError, setCommentError] = useState<string | null>(null);
  const [flowBusy, setFlowBusy] = useState(false);
  const closeFlow = useCallback(() => {
    setFlow(null);
    setCommentError(null);
  }, []);
  const openFlow = (f: Flow) => {
    setComment("");
    setCommentError(null);
    setFlow(f);
  };

  const [adding, setAdding] = useState(false);
  const closeAdding = useCallback(() => setAdding(false), []);
  const [removing, setRemoving] = useState<Adjustment | null>(null);
  const closeRemoving = useCallback(() => setRemoving(null), []);
  const [paying, setPaying] = useState<{ employeeId: string; payrollItemId: string } | null>(null);
  const closePaying = useCallback(() => setPaying(null), []);

  const names = useMemo(() => new Map((p?.items ?? []).map((i) => [i.employee.id, i.employee.fullName])), [p]);

  if (!periodId) {
    return (
      <EmptyState
        title="No pay run chosen"
        body="Open a pay run from the Payroll page to see its figures."
        action={
          <Link className="btn-secondary" href="/staff/payroll">
            Go to Payroll
          </Link>
        }
      />
    );
  }
  if (q.error && !p) {
    if (q.error instanceof ApiError && q.error.status === 404) {
      return (
        <EmptyState
          title="Pay run not found"
          body="This pay run doesn't exist in this workspace. The link may be wrong, or you may have switched workspace."
          action={
            <Link className="btn-secondary" href="/staff/payroll">
              Go to Payroll
            </Link>
          }
        />
      );
    }
    return <LoadError what="this pay run" error={q.error} onRetry={() => void q.reload()} busy={q.loading} />;
  }
  if (!p) return <Skeleton lines={8} />;

  const tz = p.timezone;
  const editable = (EDITABLE_STATUSES as readonly string[]).includes(p.status);
  const payable = (PAYABLE_STATUSES as readonly string[]).includes(p.status);
  const nothingPaid = Object.values(p.totals).every((t) => isZero(t.paid));
  const manage = can("payroll:manage");
  const approve = can("payroll:approve");
  const exportOk = can("staff:export");
  const pay = can("payments:manage");
  const base_ = `${base}/payroll/periods/${encodeURIComponent(p.id)}`;
  const label = fmtSpan(p.startDate, p.endDate);

  const recalc = () =>
    run("calc", "recalculate the payroll", async () => {
      const r = await api<{ period: Period }>(`${base_}/calculate`, { method: "POST" });
      q.setData(r);
      setNotice(null);
      return "Recalculated with the latest hours, pay rates and adjustments.";
    });

  async function confirmFlow() {
    if (!flow || flowBusy) return;
    const f = FLOW[flow];
    const c = comment.trim();
    if (f.required && c.length < 3) return setCommentError("Add a short note (at least a few words).");
    if (c.length > 500) return setCommentError("Keep it under 500 characters.");
    setFlowBusy(true);
    setCommentError(null);
    try {
      const body = flow === "approve" ? { version: p!.version, comment: c || null } : { comment: c || null };
      const r = await api<{ period: Period }>(`${base_}/${flow}`, { method: "POST", body });
      q.setData(r);
      setNotice(null);
      closeFlow();
      toast("success", f.done);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        // The payroll changed under us (stale version, new figures, new issues): show why and the
        // latest state, instead of leaving the old figures on screen.
        const issues = (e.data.detail as { issues?: Issue[] } | undefined)?.issues;
        setNotice({ kind: e.code === "blocking_issues" ? "error" : "info", text: e.message, issues });
        closeFlow();
        void q.reload();
      } else {
        setCommentError(actionError(e, f.what));
      }
    } finally {
      setFlowBusy(false);
    }
  }

  const removeAdjustment = () =>
    removing &&
    run(`rm:${removing.id}`, "remove the adjustment", async () => {
      const r = await api<{ period: Period }>(`${base_}/adjustments/${encodeURIComponent(removing.id)}`, { method: "DELETE" });
      q.setData(r);
      setRemoving(null);
      return `Removed “${removing.label}”.`;
    });

  const exportReport = (format: "csv" | "xlsx" | "pdf") =>
    run(`export:${format}`, "download the report", async () => {
      await exportFile(base, { kind: "report", format, report: { type: "payroll", groupBy: "employee", preset: "custom", from: p.startDate, to: p.endDate, periodId: p.id } });
    });
  const payslip = (item: Item) =>
    run(`slip:${item.id}`, "download the payslip", async () => {
      await exportFile(base, { kind: "payslip", itemId: item.id });
    });

  const toggle = (itemId: string) =>
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });

  const issueLink = (i: Issue): { href: string; text: string } | null => {
    const range = `from=${p.startDate}&to=${p.endDate}`;
    switch (i.code) {
      case "open_shifts":
        return { href: `/staff/timesheets?status=open&${range}`, text: "Set the clock-out times" };
      case "unapproved_hours":
        return { href: `/staff/timesheets?status=pending&${range}`, text: "Review the hours" };
      case "pending_corrections":
        return { href: "/staff/timesheets?tab=requests", text: "Review the requests" };
      case "missing_rates":
        return { href: "/staff/employees", text: "Open employees" };
      case "negative_net":
        return { href: "#adjustments", text: "Check the adjustments" };
      default:
        return null;
    }
  };

  const actions = (
    <>
      {editable && manage && (
        <>
          <button type="button" className="btn-secondary" disabled={busy !== null} onClick={() => void recalc()}>
            {busy === "calc" ? "Recalculating…" : "Recalculate"}
          </button>
          <button type="button" className="btn-primary" disabled={busy !== null} onClick={() => openFlow("submit")}>
            Send for approval
          </button>
        </>
      )}
      {p.status === "pending_approval" && approve && (
        <>
          <button type="button" className="btn-primary" onClick={() => openFlow("approve")}>
            Approve payroll
          </button>
          <button type="button" className="btn-secondary" onClick={() => openFlow("reject")}>
            Send back
          </button>
        </>
      )}
      {(editable || p.status === "pending_approval") && approve && (
        <button type="button" className="btn-danger" onClick={() => openFlow("cancel")}>
          Cancel pay run
        </button>
      )}
      {payable && nothingPaid && approve && (
        <button type="button" className="btn-danger" onClick={() => openFlow("reverse")}>
          Reverse approval
        </button>
      )}
    </>
  );

  const currencies = Object.entries(p.totals);
  const colSpan = 11;

  return (
    <>
      <Link href="/staff/payroll" className="inline-block text-sm text-muted hover:text-text">
        ← All pay runs
      </Link>
      <PageHeader
        title={`Pay run: ${label}`}
        sub={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <PayrollBadge status={p.status} />
            {p.locked && (
              <span className="inline-flex items-center gap-1 text-xs">
                <Lock aria-hidden size={12} /> Hours and figures locked
              </span>
            )}
            <span>{PAY_CYCLE_LABEL[p.payCycle] ?? p.payCycle}</span>
            {p.payDate && <span>Pay date {fmtDay(p.payDate)}</span>}
            <span>Version {p.version}</span>
            {p.calculatedAt && <span>Calculated {fmtDateTime(p.calculatedAt, tz)}</span>}
          </span>
        }
        actions={actions}
      />
      {p.notes && <p className="text-sm text-muted">Note: {p.notes}</p>}

      {notice && (
        <Alert kind={notice.kind}>
          <span className="block">{notice.text}</span>
          {notice.issues && notice.issues.length > 0 && (
            <ul className="mt-1 list-disc pl-5">
              {notice.issues.map((i) => (
                <li key={i.code}>
                  {i.message} ({i.count}){i.employees.length ? `: ${i.employees.join(", ")}` : ""}
                </li>
              ))}
            </ul>
          )}
        </Alert>
      )}

      {p.issues.length > 0 && (
        <section className="card animate-rise border-warn/60" aria-label="Issues to sort out">
          <h2 className="font-semibold">Sort these out before approval</h2>
          <p className="mt-0.5 text-xs text-muted">The payroll can&apos;t be sent for approval or approved while these are open.</p>
          <ul className="mt-3 space-y-2">
            {p.issues.map((i) => {
              const link = issueLink(i);
              return (
                <li key={i.code} className="rounded-lg border border-border bg-bg/50 px-3 py-2 text-sm">
                  <p>
                    <span className="font-medium">{i.message}</span> <span className="text-muted">({i.count})</span>
                  </p>
                  {i.employees.length > 0 && (
                    <p className="text-xs text-muted">
                      {i.employees.join(", ")}
                      {i.count > i.employees.length ? " and others" : ""}
                    </p>
                  )}
                  {link && (
                    <Link className="mt-1 inline-block text-sm text-accent underline-offset-2 hover:underline" href={link.href}>
                      {link.text}
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section className="card animate-rise" aria-label="Totals">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Figure label="Employees" value={new Intl.NumberFormat().format(p.employees)} />
          <Figure label="Regular hours" value={hours(p.regularSeconds)} />
          <Figure label="Overtime hours" value={hours(p.overtimeSeconds)} />
          <Figure label="Break hours" value={hours(p.breakSeconds)} />
        </div>
        {currencies.map(([c, t]) => (
          <div key={c} className="mt-4">
            {currencies.length > 1 && <p className="mb-2 text-xs font-medium text-muted">In {c}</p>}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <Figure label="Gross pay" value={fmtMoney(t.gross, c)} />
              <Figure label="Other earnings" value={fmtMoney(t.otherEarnings, c)} />
              <Figure label="Deductions" value={fmtMoney(t.deductions, c)} />
              <Figure label="Net pay (estimated)" value={fmtMoney(t.net, c)} />
              <Figure label="Paid" value={fmtMoney(t.paid, c)} />
              <Figure label="Outstanding" value={fmtMoney(t.outstanding, c)} />
            </div>
          </div>
        ))}
        <div className="mt-4">
          <EstimateNote>{p.estimateNotice}</EstimateNote>
        </div>
      </section>

      <section className="card animate-rise" aria-labelledby="pay-items">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h2 id="pay-items" className="font-semibold">
            Pay per employee
          </h2>
          {exportOk && (
            <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Download this pay run">
              <span className="text-xs text-muted">Download:</span>
              {(
                [
                  ["csv", "CSV"],
                  ["xlsx", "Excel"],
                  ["pdf", "PDF"],
                ] as const
              ).map(([f, l]) => (
                <button key={f} type="button" className="btn-secondary px-3 py-1" disabled={busy !== null} onClick={() => void exportReport(f)}>
                  {busy === `export:${f}` ? "Preparing…" : l}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="mt-4">
          {!p.items.length ? (
            <EmptyState
              title="Nothing to pay in this period yet"
              body={
                editable
                  ? "No approved hours or adjustments fall in these dates. Approve hours in Timesheets, then recalculate."
                  : "This pay run has no pay entries."
              }
            />
          ) : (
            <Table label="Pay per employee">
              <thead>
                <tr>
                  <Th className="w-8">
                    <span className="sr-only">Details</span>
                  </Th>
                  <Th>Employee</Th>
                  <Th right>Regular</Th>
                  <Th right>Overtime</Th>
                  <Th right>Gross</Th>
                  <Th right>Other</Th>
                  <Th right>Deductions</Th>
                  <Th right>Net</Th>
                  <Th right>Paid</Th>
                  <Th right>Outstanding</Th>
                  <Th>Payment</Th>
                </tr>
              </thead>
              <tbody>
                {p.items.map((i) => {
                  const open = expanded.has(i.id);
                  const adjustments = p.adjustments.filter((a) => a.employeeId === i.employee.id);
                  const st = PAYMENT_STATUS[i.paymentStatus] ?? { tone: "neutral" as Tone, label: i.paymentStatus };
                  return (
                    <Fragment key={i.id}>
                      <tr>
                        <Td>
                          <button type="button" className="text-muted hover:text-text" aria-expanded={open} aria-controls={`item-${i.id}`} onClick={() => toggle(i.id)}>
                            {open ? <ChevronDown aria-hidden size={16} /> : <ChevronRight aria-hidden size={16} />}
                            <span className="sr-only">
                              {open ? "Hide" : "Show"} details for {i.employee.fullName}
                            </span>
                          </button>
                        </Td>
                        <Td>
                          <p className="font-medium">{i.employee.fullName}</p>
                          <p className="text-xs text-muted">
                            {i.employee.employeeNumber}
                            {i.employee.jobTitle ? ` · ${i.employee.jobTitle}` : ""}
                          </p>
                          {i.warnings.length > 0 && (
                            <p className="mt-0.5 text-[11px] text-warn">{i.warnings.map((w) => WARNING_LABEL[w] ?? w).join(" · ")}</p>
                          )}
                        </Td>
                        <Td right>{fmtHoursDec(i.regularSeconds + i.holidaySeconds)}</Td>
                        <Td right>{fmtHoursDec(i.overtimeSeconds + i.doubleTimeSeconds)}</Td>
                        <Td right>{fmtMoney(i.gross, i.currency)}</Td>
                        <Td right>{fmtMoney(i.otherEarnings, i.currency)}</Td>
                        <Td right>{fmtMoney(i.deductions, i.currency)}</Td>
                        <Td right className="font-medium">
                          {fmtMoney(i.net, i.currency)}
                        </Td>
                        <Td right>{fmtMoney(i.paid, i.currency)}</Td>
                        <Td right>{fmtMoney(i.outstanding, i.currency)}</Td>
                        <Td>
                          <span className="flex flex-col items-start gap-1.5">
                            {payable ? <Badge tone={st.tone}>{st.label}</Badge> : <span className="text-xs text-muted">Not approved yet</span>}
                            {payable && pay && !isZero(i.outstanding) && (
                              <button type="button" className="text-sm text-accent underline-offset-2 hover:underline" onClick={() => setPaying({ employeeId: i.employee.id, payrollItemId: i.id })}>
                                Record payment<span className="sr-only"> for {i.employee.fullName}</span>
                              </button>
                            )}
                            {exportOk && (
                              <button type="button" className="whitespace-nowrap text-sm text-accent underline-offset-2 hover:underline disabled:opacity-50" disabled={busy !== null} onClick={() => void payslip(i)}>
                                {busy === `slip:${i.id}` ? "Preparing…" : payable ? "Payslip (PDF)" : "Preview payslip"}
                                <span className="sr-only"> for {i.employee.fullName}</span>
                              </button>
                            )}
                          </span>
                        </Td>
                      </tr>
                      {open && (
                        <tr id={`item-${i.id}`}>
                          <td colSpan={colSpan} className="border-b border-border/70 bg-bg/50 px-3 py-3">
                            <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
                              <div className="min-w-0">
                                <p className="text-xs font-medium text-muted">How the gross pay adds up ({i.shifts === 1 ? "1 shift" : `${i.shifts} shifts`})</p>
                                {i.lines.length ? (
                                  <table className="mt-1 w-full text-sm">
                                    <thead>
                                      <tr className="text-xs text-muted">
                                        <th scope="col" className="py-1 text-left font-medium">
                                          Pay type
                                        </th>
                                        <th scope="col" className="py-1 text-right font-medium">
                                          Hours
                                        </th>
                                        <th scope="col" className="py-1 text-right font-medium">
                                          Rate
                                        </th>
                                        <th scope="col" className="py-1 text-right font-medium">
                                          Multiplier
                                        </th>
                                        <th scope="col" className="py-1 text-right font-medium">
                                          Amount
                                        </th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {i.lines.map((l, n) => (
                                        <tr key={n} className="border-t border-border/60">
                                          <td className="py-1">{PAY_CATEGORY_LABEL[l.category] ?? l.category}</td>
                                          <td className="py-1 text-right tabular-nums">{fmtHoursDec(l.seconds)}</td>
                                          <td className="py-1 text-right tabular-nums">{fmtMoney(l.hourlyRate, i.currency)}/h</td>
                                          <td className="py-1 text-right tabular-nums">{l.multiplier}×</td>
                                          <td className="py-1 text-right tabular-nums">{fmtMoney(l.amount, i.currency)}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                ) : (
                                  <p className="mt-1 text-xs text-muted">No paid hours in this period.</p>
                                )}
                                {i.unpricedSeconds > 0 && (
                                  <p className="mt-2 text-xs text-warn">{fmtHoursDec(i.unpricedSeconds)} hours have no pay rate for their day and aren&apos;t included. Add a pay rate, then recalculate.</p>
                                )}
                                <p className="mt-2 text-xs text-muted">
                                  Breaks: {fmtHoursDec(i.unpaidBreakSeconds)} h unpaid, {fmtHoursDec(i.paidBreakSeconds)} h paid ·{" "}
                                  <Link className="text-accent underline-offset-2 hover:underline" href={`/staff/timesheets?employeeId=${encodeURIComponent(i.employee.id)}&from=${p.startDate}&to=${p.endDate}`}>
                                    See shifts
                                  </Link>
                                </p>
                              </div>
                              <div className="min-w-0">
                                <p className="text-xs font-medium text-muted">Earnings and deductions</p>
                                {adjustments.length ? (
                                  <ul className="mt-1 space-y-1 text-sm">
                                    {adjustments.map((a) => (
                                      <li key={a.id} className="flex items-start justify-between gap-2">
                                        <span className="min-w-0">
                                          {a.label}
                                          {a.reason && <span className="block text-xs text-muted">{a.reason}</span>}
                                        </span>
                                        <span className={`whitespace-nowrap tabular-nums ${a.kind === "deduction" ? "text-danger" : ""}`}>
                                          {a.kind === "deduction" ? "−" : "+"}
                                          {fmtMoney(a.amount, a.currency)}
                                        </span>
                                      </li>
                                    ))}
                                  </ul>
                                ) : (
                                  <p className="mt-1 text-xs text-muted">None.</p>
                                )}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </Table>
          )}
        </div>
      </section>

      <section id="adjustments" className="card animate-rise scroll-mt-24" aria-labelledby="adj-h">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 id="adj-h" className="font-semibold">
              Earnings and deductions
            </h2>
            <p className="mt-0.5 text-xs text-muted">Bonuses, allowances, advances or other amounts added to or taken off pay for this period.</p>
          </div>
          {editable && manage && (
            <button type="button" className="btn-secondary" onClick={() => setAdding(true)}>
              Add earning or deduction
            </button>
          )}
        </div>
        {!p.adjustments.length ? (
          <p className="mt-3 text-sm text-muted">None for this pay run.</p>
        ) : (
          <ul className="mt-3 divide-y divide-border">
            {p.adjustments.map((a) => (
              <li key={a.id} className="flex flex-wrap items-start justify-between gap-3 py-2.5 text-sm">
                <div className="min-w-0">
                  <p>
                    <span className="font-medium">{a.label}</span> <span className="text-muted">· {names.get(a.employeeId) ?? "Employee"}</span>
                  </p>
                  <p className="text-xs text-muted">
                    {a.kind === "earning" ? "Earning" : "Deduction"} · added by {a.createdBy} {fmtDateTime(a.createdAt, tz)}
                    {a.reason ? ` · ${a.reason}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <span className={`tabular-nums ${a.kind === "deduction" ? "text-danger" : ""}`}>
                    {a.kind === "deduction" ? "−" : "+"}
                    {fmtMoney(a.amount, a.currency)}
                  </span>
                  {editable && manage && (
                    <button type="button" className="text-sm text-muted underline-offset-2 hover:text-danger hover:underline" onClick={() => setRemoving(a)}>
                      Remove<span className="sr-only"> {a.label}</span>
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {!editable && p.status !== "cancelled" && p.status !== "reversed" && (
          <p className="mt-2 text-xs text-muted">Earnings and deductions can only be changed while the payroll is a draft or has been sent back.</p>
        )}
      </section>

      <section className="card animate-rise" aria-labelledby="hist-h">
        <h2 id="hist-h" className="font-semibold">
          History
        </h2>
        {!p.history.length ? (
          <p className="mt-3 text-sm text-muted">Nothing yet.</p>
        ) : (
          <ol className="mt-3 space-y-2 text-sm">
            {p.history.map((h) => (
              <li key={h.id} className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span>
                  <span className="font-medium">{HISTORY_LABEL[h.action] ?? h.action}</span> by {h.by}
                  <span className="text-muted"> · version {h.version}</span>
                  {h.comment && <span className="block text-xs text-muted">“{h.comment}”</span>}
                </span>
                <span className="text-xs text-muted">{fmtDateTime(h.at, tz)}</span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <ConfirmDialog
        open={flow !== null}
        title={flow ? FLOW[flow].title : ""}
        confirmLabel={flow ? FLOW[flow].confirm : ""}
        danger={flow ? FLOW[flow].danger : false}
        busy={flowBusy}
        onConfirm={() => void confirmFlow()}
        onCancel={closeFlow}
      >
        {flow && (
          <>
            <p>
              <span className="font-medium text-text">{label}</span> · {FLOW[flow].body}
            </p>
            <label className="block">
              <span className="label text-text">
                {FLOW[flow].comment}
                {FLOW[flow].required && <span className="text-danger"> *</span>}
              </span>
              <textarea className="input min-h-[4.5rem]" maxLength={500} value={comment} onChange={(e) => setComment(e.target.value)} />
            </label>
            {commentError && <p className="text-xs text-danger">{commentError}</p>}
          </>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={removing !== null}
        title="Remove this adjustment?"
        confirmLabel="Remove"
        danger
        busy={busy !== null && busy.startsWith("rm:")}
        onConfirm={() => void removeAdjustment()}
        onCancel={closeRemoving}
      >
        {removing && (
          <p>
            “{removing.label}” ({removing.kind === "deduction" ? "−" : "+"}
            {fmtMoney(removing.amount, removing.currency)}) for {names.get(removing.employeeId) ?? "this employee"}. The figures are recalculated without it.
          </p>
        )}
      </ConfirmDialog>

      {adding && (
        <AdjustmentModal
          base={base}
          periodPath={base_}
          items={p.items}
          onClose={closeAdding}
          onDone={(period, msg) => {
            q.setData({ period });
            setAdding(false);
            toast("success", msg);
          }}
        />
      )}

      <RecordPaymentModal
        open={paying !== null}
        onClose={closePaying}
        base={base}
        preset={paying ?? undefined}
        onRecorded={(payment, replayed) => {
          toast("success", replayed ? "That payment was already recorded." : `Payment of ${fmtMoney(payment.amount, payment.currency)} recorded.`);
          void q.reload();
        }}
      />
    </>
  );
}

function AdjustmentModal({
  base,
  periodPath,
  items,
  onClose,
  onDone,
}: {
  base: string;
  periodPath: string;
  items: Item[];
  onClose: () => void;
  onDone: (period: Period, msg: string) => void;
}) {
  const id = useId();
  // Anyone can be given an earning or deduction, not only people with hours in this period.
  const employees = useApi<{ items: EmployeeRow[] }>(`${base}/employees?pageSize=200&sort=name`);
  const inRun = useMemo(() => items.map((i) => ({ id: i.employee.id, name: i.employee.fullName, number: i.employee.employeeNumber, currency: i.currency })), [items]);
  const others = useMemo(() => {
    const have = new Set(inRun.map((e) => e.id));
    return (employees.data?.items ?? []).filter((e) => !have.has(e.id)).map((e) => ({ id: e.id, name: e.fullName, number: e.employeeNumber, currency: e.currency }));
  }, [employees.data, inRun]);

  const [employeeId, setEmployeeId] = useState("");
  const [kind, setKind] = useState<"earning" | "deduction">("earning");
  const [labelText, setLabelText] = useState("");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const chosen = inRun.find((e) => e.id === employeeId) ?? others.find((e) => e.id === employeeId) ?? null;

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (busy) return;
    const e: Record<string, string> = {};
    if (!chosen) e.employee = "Choose who this is for.";
    if (!labelText.trim()) e.label = "Name it, for example “Bonus” or “Advance repayment”.";
    else if (labelText.trim().length > 80) e.label = "Keep the name under 80 characters.";
    const a = amount.trim();
    if (!a) e.amount = "Enter the amount.";
    else if (!AMOUNT_RE.test(a)) e.amount = "Enter an amount like 50 or 50.00.";
    else if (chosen) {
      try {
        if (toMinor(a, chosen.currency) <= 0n) e.amount = "The amount has to be more than zero.";
      } catch {
        e.amount = `Enter the amount in ${chosen.currency}, like 50 or 50.00.`;
      }
    }
    if (reason.trim().length > 300) e.reason = "Keep the reason under 300 characters.";
    setErrors(e);
    if (Object.keys(e).length || !chosen) return;
    setBusy(true);
    setProblem(null);
    try {
      const r = await api<{ period: Period }>(`${periodPath}/adjustments`, {
        method: "POST",
        body: { employeeId: chosen.id, kind, label: labelText.trim(), amount: a, reason: reason.trim() || null },
      });
      onDone(r.period, `${kind === "earning" ? "Earning" : "Deduction"} added for ${chosen.name}. The figures are recalculated.`);
    } catch (err) {
      setProblem(actionError(err, "add the adjustment"));
      setBusy(false);
    }
  };

  return (
    <Modal open title="Add earning or deduction" onClose={onClose}>
      <form className="space-y-3" onSubmit={submit} noValidate>
        <Field label="Employee" htmlFor={`${id}-emp`} error={errors.employee} required hint={employees.error && !employees.data ? "Only people already in this pay run are listed: the employee list couldn't be loaded." : undefined}>
          <select id={`${id}-emp`} className="input" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
            <option value="">Choose an employee…</option>
            {inRun.length > 0 && (
              <optgroup label="In this pay run">
                {inRun.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name} ({e.number})
                  </option>
                ))}
              </optgroup>
            )}
            {others.length > 0 && (
              <optgroup label="Other employees">
                {others.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name} ({e.number})
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </Field>
        <fieldset>
          <legend className="label">Type</legend>
          <div className="flex flex-wrap gap-4 text-sm">
            <label className="inline-flex items-center gap-2">
              <input type="radio" name={`${id}-kind`} className="accent-[var(--accent)]" checked={kind === "earning"} onChange={() => setKind("earning")} />
              Earning (added to pay)
            </label>
            <label className="inline-flex items-center gap-2">
              <input type="radio" name={`${id}-kind`} className="accent-[var(--accent)]" checked={kind === "deduction"} onChange={() => setKind("deduction")} />
              Deduction (taken off pay)
            </label>
          </div>
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" htmlFor={`${id}-label`} error={errors.label} required>
            <input id={`${id}-label`} className="input" maxLength={80} placeholder={kind === "earning" ? "Bonus" : "Advance repayment"} value={labelText} onChange={(e) => setLabelText(e.target.value)} />
          </Field>
          <Field label={chosen ? `Amount (${chosen.currency})` : "Amount"} htmlFor={`${id}-amount`} error={errors.amount} required>
            <input id={`${id}-amount`} className="input" inputMode="decimal" autoComplete="off" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
        </div>
        <Field label="Reason" htmlFor={`${id}-reason`} error={errors.reason} hint="Optional. Kept with this pay run's records.">
          <textarea id={`${id}-reason`} className="input min-h-[4rem]" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        {problem && <Alert>{problem}</Alert>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? "Adding…" : "Add"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

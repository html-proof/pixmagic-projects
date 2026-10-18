"use client";
import { Lock } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useMemo, useState } from "react";
import { EDITABLE_STATUSES, PAY_CYCLE_LABEL, PAYABLE_STATUSES } from "@app/shared/staff";
import { LoadError } from "@/components/LoadError";
import { RecordPaymentModal } from "@/components/staff/RecordPayment";
import { PayrollBadge } from "@/components/staff/ui";
import { Alert, EmptyState } from "@/components/ui";
import { ConfirmDialog, PageHeader, Skeleton, useAction, useToast } from "@/components/AppUi";
import { actionError, api, ApiError, useApi } from "@/lib/api";
import { exportFile, fmtDateTime, fmtDay, fmtMoney, fmtSpan, useStaff } from "@/lib/staff";
import { type Adjustment, type Flow, FLOW, type Issue, isZero, type Item, type Period } from "@/components/staff/payroll/payRun";
import { AdjustmentModal } from "@/components/staff/payroll/AdjustmentModal";
import { AdjustmentsPanel, IssuesPanel, PayItems, PayRunHistory, TotalsPanel } from "@/components/staff/payroll/PayRunSections";

// One pay run: its figures per employee, what stands in the way of approving it, the approval
// workflow, earnings and deductions, payments, payslips and exports.

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

      <IssuesPanel period={p} />

      <TotalsPanel period={p} />

      <PayItems
        period={p}
        editable={editable}
        payable={payable}
        canPay={pay}
        canExport={exportOk}
        busy={busy}
        onExport={exportReport}
        onPayslip={payslip}
        onPay={setPaying}
      />

      <AdjustmentsPanel period={p} editable={editable} manage={manage} names={names} onAdd={() => setAdding(true)} onRemove={setRemoving} />

      <PayRunHistory period={p} />

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

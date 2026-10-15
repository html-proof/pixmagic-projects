"use client";
import { useState } from "react";
import { PAYMENT_METHOD_LABEL } from "@app/shared/staff";
import { LoadError } from "@/components/LoadError";
import { usePortal, type MyPayItem } from "@/components/staff/PortalContext";
import { EstimateNote, PaymentBadge, PayrollBadge } from "@/components/staff/ui";
import { EmptyState } from "@/components/ui";
import { Skeleton, useToast } from "@/components/AppUi";
import { actionError, api, useApi } from "@/lib/api";
import { downloadFrom, fmtDay, fmtHours, fmtMoney, fmtSpan } from "@/lib/staff";

// ---------------------------------------------------------------------------------------------
// The employee's pay: approved pay periods only (drafts never show here), what was earned, what
// has been paid and what is still owed, and the payslip for each.
// ---------------------------------------------------------------------------------------------

export default function PortalPay() {
  const { ws } = usePortal();
  const toast = useToast();
  const q = useApi<{ currency: string; items: MyPayItem[] }>(`/employee/${ws}/pay`);
  const [downloading, setDownloading] = useState<string | null>(null);

  async function download(itemId: string) {
    setDownloading(itemId);
    try {
      const { url } = await api<{ url: string }>(`/employee/${ws}/payslips/${itemId}/download`, { method: "POST" });
      await downloadFrom(url);
    } catch (e) {
      toast("error", actionError(e, "download your payslip"));
    } finally {
      setDownloading(null);
    }
  }

  return (
    <>
      <section className="card animate-rise">
        <h1 className="text-xl font-semibold">Pay</h1>
        <p className="mt-1 text-sm text-muted">Your approved pay periods, what has been paid so far, and your payslips.</p>
      </section>

      {q.error && !q.data ? (
        <LoadError what="your pay" error={q.error} onRetry={() => void q.reload()} busy={q.loading} />
      ) : !q.data ? (
        <Skeleton lines={5} />
      ) : q.data.items.length === 0 ? (
        <EmptyState
          title="No payslips yet"
          body="Payslips appear here once your manager approves a payroll that includes your hours. Until then, your dashboard shows an estimate of what you've earned this pay period."
        />
      ) : (
        <>
          <ul className="space-y-3" aria-label="Pay periods">
            {q.data.items.map((i) => (
              <PayCard key={i.id} i={i} busy={downloading === i.id} disabled={downloading !== null} onDownload={() => void download(i.id)} />
            ))}
          </ul>
          <EstimateNote>
            Net pay is your gross pay plus other earnings, minus the deductions your employer added. Insights doesn&apos;t calculate tax or statutory deductions, so your
            employer&apos;s final figures may differ.
          </EstimateNote>
        </>
      )}
    </>
  );
}

function Row({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <dt className="text-muted">{label}</dt>
      <dd className={`tabular-nums ${strong ? "font-semibold" : ""}`}>{value}</dd>
    </div>
  );
}

function PayCard({ i, busy, disabled, onDownload }: { i: MyPayItem; busy: boolean; disabled: boolean; onDownload: () => void }) {
  const m = (v: string) => fmtMoney(v, i.currency);
  const owing = Number(i.outstanding) > 0;
  return (
    <li className="card !p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold">{fmtSpan(i.period.from, i.period.to)}</p>
          <p className="text-sm text-muted">{i.period.payDate ? `Pay date ${fmtDay(i.period.payDate)}` : "No pay date set"}</p>
        </div>
        <PayrollBadge status={i.period.status} />
      </div>

      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <dl className="text-sm">
          <Row label="Regular hours" value={fmtHours(i.regularSeconds)} />
          <Row label="Overtime hours" value={fmtHours(i.overtimeSeconds)} />
          <Row label="Gross pay" value={m(i.gross)} />
          <Row label="Other earnings" value={m(i.otherEarnings)} />
          <Row label="Deductions" value={Number(i.deductions) > 0 ? `− ${m(i.deductions)}` : m(i.deductions)} />
          <div className="mt-1 border-t border-border pt-1">
            <Row label="Net pay (estimated)" value={m(i.net)} strong />
          </div>
        </dl>
        <div className="text-sm">
          <dl>
            <Row label="Paid" value={m(i.paid)} />
            <Row label="Still to be paid" value={m(i.outstanding)} strong={owing} />
          </dl>
          {i.payments.length > 0 ? (
            <ul className="mt-2 space-y-1.5 border-t border-border pt-2" aria-label="Payments">
              {i.payments.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-muted">
                    {fmtDay(p.paidOn)} · {PAYMENT_METHOD_LABEL[p.method] ?? p.method}
                  </span>
                  <span className="inline-flex items-center gap-2">
                    <span className="tabular-nums">{m(p.amount)}</span>
                    <PaymentBadge status={p.status} />
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 border-t border-border pt-2 text-xs text-muted">No payment recorded for this period yet.</p>
          )}
        </div>
      </div>

      <div className="mt-4">
        <button type="button" className="btn-secondary min-h-11 w-full sm:w-auto" onClick={onDownload} disabled={disabled}>
          {busy ? "Preparing…" : "Download payslip"}
        </button>
      </div>
    </li>
  );
}

"use client";
import Link from "next/link";
import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { PAYMENT_METHOD_LABEL, PAYMENT_METHODS, PAYMENT_STATUS_LABEL, PAYMENT_STATUSES, type PaymentMethod, type PaymentStatus } from "@app/shared/staff";
import { Empty } from "@/components/dashboard/Primitives";
import { LoadError } from "@/components/LoadError";
import { RecordPaymentModal, type PaymentView } from "@/components/staff/RecordPayment";
import { Field, Modal, Pagination, PaymentBadge, Table, Td, Th } from "@/components/staff/ui";
import { Alert, EmptyState } from "@/components/ui";
import { PageHeader, Skeleton, useToast } from "@/components/AppUi";
import { actionError, api, useApi } from "@/lib/api";
import { fmtDateTime, fmtDay, fmtMoney, fmtSpan, useStaff, type EmployeeRow, type StaffConfig } from "@/lib/staff";

// ---------------------------------------------------------------------------------------------
// Payment history: every payment recorded against approved payroll, with totals, and marking a
// payment as failed or reversed. Recording a payment moves no money; it keeps track of what was
// paid outside bizinsights.
// ---------------------------------------------------------------------------------------------

interface PaymentList {
  total: number;
  page: number;
  pageSize: number;
  totals: Array<{ currency: string; status: PaymentStatus; count: number; amount: string }>;
  items: PaymentView[];
}

const PAGE_SIZE = 25;

export default function PaymentsPage() {
  const id = useId();
  const toast = useToast();
  const { base, can } = useStaff();
  const manage = can("payments:manage");
  const config = useApi<StaffConfig>(`${base}/config`);
  const employees = useApi<{ items: EmployeeRow[] }>(`${base}/employees?pageSize=200&status=all&sort=name`);
  const tz = config.data?.settings.timezone ?? "UTC";

  const [filters, setFilters] = useState({ employeeId: "", from: "", to: "", status: "" as PaymentStatus | "", method: "" as PaymentMethod | "" });
  const [page, setPage] = useState(1);
  const set = (patch: Partial<typeof filters>) => {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(1);
  };
  const rangeBad = !!filters.from && !!filters.to && filters.from > filters.to;
  const qs = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
  for (const [k, v] of Object.entries(filters)) if (v) qs.set(k, v);
  const list = useApi<PaymentList>(rangeBad ? null : `${base}/payroll/payments?${qs.toString()}`);
  const [shown, setShown] = useState<PaymentList | null>(null);
  useEffect(() => {
    if (list.data) setShown(list.data);
  }, [list.data]);

  const [recording, setRecording] = useState(false);
  const closeRecording = useCallback(() => setRecording(false), []);
  const [changing, setChanging] = useState<{ payment: PaymentView; to: "fail" | "reverse" } | null>(null);
  const closeChanging = useCallback(() => setChanging(null), []);

  const filtered = !!(filters.employeeId || filters.from || filters.to || filters.status || filters.method);
  const rows = shown?.items ?? [];

  // Totals per currency, one line per status.
  const byCurrency = new Map<string, PaymentList["totals"]>();
  for (const t of shown?.totals ?? []) byCurrency.set(t.currency, [...(byCurrency.get(t.currency) ?? []), t]);

  return (
    <>
      <PageHeader
        title="Payment history"
        sub="Payments recorded against approved payroll. Recording a payment doesn't send money: it keeps track of what you've paid through your bank or provider."
        actions={
          manage ? (
            <button type="button" className="btn-primary" onClick={() => setRecording(true)}>
              Record payment
            </button>
          ) : undefined
        }
      />

      <section className="card animate-rise" aria-labelledby={`${id}-h`}>
        <h2 id={`${id}-h`} className="sr-only">
          Payments
        </h2>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5" role="search" aria-label="Filter payments">
          <label className="min-w-0">
            <span className="label text-xs text-muted">Employee</span>
            <select className="input" value={filters.employeeId} onChange={(e) => set({ employeeId: e.target.value })}>
              <option value="">Everyone</option>
              {(employees.data?.items ?? []).map((e) => (
                <option key={e.id} value={e.id}>
                  {e.fullName}
                  {e.status === "inactive" ? " (deactivated)" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="min-w-0">
            <span className="label text-xs text-muted">Paid from</span>
            <input type="date" className="input" value={filters.from} max={filters.to || undefined} onChange={(e) => set({ from: e.target.value })} />
          </label>
          <label className="min-w-0">
            <span className="label text-xs text-muted">Paid until</span>
            <input type="date" className="input" value={filters.to} min={filters.from || undefined} onChange={(e) => set({ to: e.target.value })} />
          </label>
          <label className="min-w-0">
            <span className="label text-xs text-muted">Status</span>
            <select className="input" value={filters.status} onChange={(e) => set({ status: e.target.value as PaymentStatus | "" })}>
              <option value="">Any status</option>
              {PAYMENT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {PAYMENT_STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </label>
          <label className="min-w-0">
            <span className="label text-xs text-muted">Method</span>
            <select className="input" value={filters.method} onChange={(e) => set({ method: e.target.value as PaymentMethod | "" })}>
              <option value="">Any method</option>
              {PAYMENT_METHODS.map((m) => (
                <option key={m} value={m}>
                  {PAYMENT_METHOD_LABEL[m]}
                </option>
              ))}
            </select>
          </label>
        </div>
        {rangeBad && <p className="mt-2 text-xs text-danger">Choose a start date on or before the end date.</p>}
        {filtered && (
          <button
            type="button"
            className="mt-2 text-sm text-accent underline-offset-2 hover:underline"
            onClick={() => {
              setFilters({ employeeId: "", from: "", to: "", status: "", method: "" });
              setPage(1);
            }}
          >
            Clear filters
          </button>
        )}

        {byCurrency.size > 0 && (
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label="Totals">
            {[...byCurrency.entries()].map(([currency, lines]) => (
              <div key={currency} className="rounded-lg border border-border bg-surface p-3">
                <p className="text-xs text-muted">{filtered ? "Matching payments" : "All payments"} in {currency}</p>
                <ul className="mt-1 space-y-0.5 text-sm">
                  {[...lines]
                    .sort((a, b) => PAYMENT_STATUSES.indexOf(a.status) - PAYMENT_STATUSES.indexOf(b.status))
                    .map((t) => (
                      <li key={t.status} className="flex items-baseline justify-between gap-3">
                        <span>
                          {PAYMENT_STATUS_LABEL[t.status] ?? t.status} <span className="text-xs text-muted">({new Intl.NumberFormat().format(t.count)})</span>
                        </span>
                        <span className={`tabular-nums ${t.status === "completed" ? "text-lg font-semibold" : "text-muted"}`}>{fmtMoney(t.amount, currency)}</span>
                      </li>
                    ))}
                </ul>
              </div>
            ))}
          </div>
        )}

        <div className="mt-4">
          {list.error && !list.data ? (
            <LoadError what="the payment history" error={list.error} onRetry={() => void list.reload()} busy={list.loading} />
          ) : rangeBad ? null : !shown ? (
            <Skeleton lines={4} />
          ) : !rows.length ? (
            filtered ? (
              <Empty>No payments match these filters.</Empty>
            ) : (
              <EmptyState
                title="No payments recorded yet"
                body="Once a payroll is approved and you've paid people through your bank or provider, record the payments here to keep track of what's still owed."
                action={
                  <Link className="btn-secondary" href="/staff/payroll">
                    Go to Payroll
                  </Link>
                }
              />
            )
          ) : (
            <div className={list.loading ? "opacity-60 transition-opacity" : "transition-opacity"} aria-busy={list.loading}>
              <Table label="Payments">
                <thead>
                  <tr>
                    <Th>Date</Th>
                    <Th>Employee</Th>
                    <Th>Pay period</Th>
                    <Th right>Amount</Th>
                    <Th>Method</Th>
                    <Th>Reference</Th>
                    <Th>Status</Th>
                    <Th>Recorded by</Th>
                    <Th right>Outstanding after</Th>
                    {manage && <Th>Actions</Th>}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((p) => (
                    <tr key={p.id}>
                      <Td className="whitespace-nowrap">{fmtDay(p.paidOn, { weekday: false, year: true })}</Td>
                      <Td>
                        <p className="font-medium">{p.employee.fullName ?? "Employee"}</p>
                        {p.employee.employeeNumber && <p className="text-xs text-muted">{p.employee.employeeNumber}</p>}
                      </Td>
                      <Td>
                        {p.allocations.length ? (
                          p.allocations.map((a) => (
                            <Link
                              key={a.payrollItemId}
                              className="block whitespace-nowrap text-accent underline-offset-2 hover:underline"
                              href={`/staff/payroll/period?id=${encodeURIComponent(a.period.id)}`}
                            >
                              {fmtSpan(a.period.from, a.period.to)}
                            </Link>
                          ))
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </Td>
                      <Td right className="whitespace-nowrap font-medium">
                        {fmtMoney(p.amount, p.currency)}
                      </Td>
                      <Td className="whitespace-nowrap">{PAYMENT_METHOD_LABEL[p.method] ?? p.method}</Td>
                      <Td>
                        {p.reference ? <span className="break-all">{p.reference}</span> : <span className="text-muted">—</span>}
                        {p.remarks && <p className="max-w-[16rem] text-xs text-muted">{p.remarks}</p>}
                      </Td>
                      <Td>
                        <PaymentBadge status={p.status} />
                        {p.status !== "completed" && p.statusReason && <p className="mt-1 max-w-[14rem] text-xs text-muted">“{p.statusReason}”</p>}
                      </Td>
                      <Td>
                        <p>{p.recordedBy ?? <span className="text-muted">—</span>}</p>
                        <p className="whitespace-nowrap text-xs text-muted">{fmtDateTime(p.recordedAt, tz)}</p>
                      </Td>
                      <Td right className="whitespace-nowrap">
                        {p.allocations.length ? (
                          p.allocations.map((a) => (
                            <span key={a.payrollItemId} className="block">
                              {fmtMoney(a.itemOutstanding, p.currency)}
                            </span>
                          ))
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </Td>
                      {manage && (
                        <Td className="whitespace-nowrap">
                          {p.status === "completed" ? (
                            <span className="flex flex-col items-start gap-1">
                              <button type="button" className="text-sm text-accent underline-offset-2 hover:underline" onClick={() => setChanging({ payment: p, to: "fail" })}>
                                Mark failed<span className="sr-only"> (payment of {fmtMoney(p.amount, p.currency)} to {p.employee.fullName})</span>
                              </button>
                              <button type="button" className="text-sm text-accent underline-offset-2 hover:underline" onClick={() => setChanging({ payment: p, to: "reverse" })}>
                                Reverse<span className="sr-only"> (payment of {fmtMoney(p.amount, p.currency)} to {p.employee.fullName})</span>
                              </button>
                            </span>
                          ) : (
                            <span className="text-xs text-muted">—</span>
                          )}
                        </Td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </Table>
              <p className="mt-2 text-xs text-muted">Outstanding after shows what is still owed for that pay period now.</p>
              <Pagination page={shown.page} pageSize={shown.pageSize} total={shown.total} onPage={setPage} />
            </div>
          )}
        </div>
      </section>

      <RecordPaymentModal
        open={recording}
        onClose={closeRecording}
        base={base}
        onRecorded={(payment, replayed) => {
          toast("success", replayed ? "That payment was already recorded." : `Payment of ${fmtMoney(payment.amount, payment.currency)} recorded.`);
          void list.reload();
        }}
      />

      {changing && (
        <StatusModal
          base={base}
          payment={changing.payment}
          to={changing.to}
          onClose={closeChanging}
          onDone={(msg) => {
            toast("success", msg);
            setChanging(null);
            void list.reload();
          }}
        />
      )}
    </>
  );
}

function StatusModal({ base, payment, to, onClose, onDone }: { base: string; payment: PaymentView; to: "fail" | "reverse"; onClose: () => void; onDone: (msg: string) => void }) {
  const id = useId();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fail = to === "fail";
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const r = reason.trim();
    if (r.length < 3) return setError("Add a short reason (at least a few words).");
    if (r.length > 500) return setError("Keep the reason under 500 characters.");
    setError(null);
    setBusy(true);
    setProblem(null);
    try {
      await api(`${base}/payroll/payments/${encodeURIComponent(payment.id)}/${to}`, { method: "POST", body: { comment: r } });
      onDone(fail ? "Payment marked as failed. The amount is owed again." : "Payment reversed. The amount is owed again.");
    } catch (err) {
      setProblem(actionError(err, fail ? "mark the payment as failed" : "reverse the payment"));
      setBusy(false);
    }
  };
  return (
    <Modal open title={fail ? "Mark payment as failed" : "Reverse payment"} onClose={onClose}>
      <form className="space-y-3" onSubmit={submit} noValidate>
        <p className="text-sm text-muted">
          {fmtMoney(payment.amount, payment.currency)} to {payment.employee.fullName ?? "this employee"} on {fmtDay(payment.paidOn, { weekday: false, year: true })}.{" "}
          {fail
            ? "Use this when the payment didn't go through (it bounced or was returned)."
            : "Use this when the payment was recorded by mistake or the money came back."}{" "}
          The amount goes back to what&apos;s owed for the pay period. The record stays in the history.
        </p>
        <Field label="Reason" htmlFor={`${id}-r`} error={error} required>
          <textarea id={`${id}-r`} className="input min-h-[4.5rem]" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        {problem && <Alert>{problem}</Alert>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn-danger" disabled={busy}>
            {busy ? "Saving…" : fail ? "Mark as failed" : "Reverse payment"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

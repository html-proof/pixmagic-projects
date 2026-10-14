"use client";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { localDayOf, PAYMENT_METHOD_LABEL, PAYMENT_METHODS, shiftDay, toMinor, type PaymentMethod, type PaymentStatus } from "@app/shared/staff";
import { Alert } from "@/components/ui";
import { LoadError } from "@/components/LoadError";
import { actionError, ApiError, useApi } from "@/lib/api";
import { fmtMoney, fmtSpan, newKey, postIdempotent, type StaffConfig } from "@/lib/staff";
import { Field, Modal } from "./ui";

// ---------------------------------------------------------------------------------------------
// "Record payment": says money was paid outside Insights (bank, cash, a payroll provider) against
// one employee's approved pay for one period. One Idempotency-Key per opening of the form, so a
// double click or a retry after a lost answer records one payment, never two.
// ---------------------------------------------------------------------------------------------

/** A pay entry with money still owed (GET payroll/payable). */
export interface PayableItem {
  id: string;
  employee: { id: string; fullName: string; employeeNumber: string };
  period: { id: string; from: string; to: string; status: string };
  currency: string;
  net: string;
  paid: string;
  outstanding: string;
}

/** A recorded payment, as the payments API returns it. */
export interface PaymentView {
  id: string;
  employee: { id: string; fullName?: string; employeeNumber?: string };
  amount: string;
  currency: string;
  paidOn: string;
  method: PaymentMethod;
  reference: string | null;
  remarks: string | null;
  status: PaymentStatus;
  statusReason: string | null;
  recordedBy: string | null;
  recordedAt: string;
  allocations: Array<{
    payrollItemId: string;
    amount: string;
    period: { id: string; from: string; to: string; status: string };
    itemNet: string;
    itemOutstanding: string;
  }>;
}

const AMOUNT_RE = /^\d{1,12}(\.\d{1,3})?$/;

type Problem = { code: string; message: string } | null;

interface Props {
  open: boolean;
  onClose: () => void;
  onRecorded: (payment: PaymentView, replayed: boolean) => void;
  base: string;
  preset?: { employeeId: string; payrollItemId: string };
}

/** The form mounts fresh each time it opens: new key, empty fields, nothing left from last time. */
export function RecordPaymentModal(props: Props) {
  return props.open ? <RecordPaymentForm {...props} /> : null;
}

function RecordPaymentForm({ onClose, onRecorded, base, preset }: Props) {
  const id = useId();
  // The Modal re-runs its focus effect whenever onClose changes; keep the one it sees stable.
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });
  const close = useCallback(() => closeRef.current(), []);

  const presetEmployee = preset?.employeeId ?? "";
  const presetItem = preset?.payrollItemId ?? "";
  const payable = useApi<{ items: PayableItem[] }>(`${base}/payroll/payable${presetEmployee ? `?employeeId=${encodeURIComponent(presetEmployee)}` : ""}`);
  const config = useApi<StaffConfig>(`${base}/config`);
  const tz = config.data?.settings.timezone ?? null;
  const today = tz ? localDayOf(Date.now(), tz) : null;

  // One key per opening of the form; a confirmed possible duplicate gets its own (see send()).
  const [key] = useState(newKey);
  const [dupKey, setDupKey] = useState<string | null>(null);
  const [employeeId, setEmployeeId] = useState(presetEmployee);
  const [itemId, setItemId] = useState(presetItem);
  const [amount, setAmount] = useState("");
  const [paidOn, setPaidOn] = useState("");
  const [method, setMethod] = useState<PaymentMethod>("bank_transfer");
  const [reference, setReference] = useState("");
  const [remarks, setRemarks] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<Problem>(null);
  const [busy, setBusy] = useState(false);

  const items = useMemo(() => payable.data?.items ?? [], [payable.data]);
  const employees = useMemo(() => {
    const seen = new Map<string, PayableItem["employee"]>();
    for (const i of items) if (!seen.has(i.employee.id)) seen.set(i.employee.id, i.employee);
    return [...seen.values()].sort((a, b) => a.fullName.localeCompare(b.fullName));
  }, [items]);
  const mine = useMemo(() => (employeeId ? items.filter((i) => i.employee.id === employeeId) : []), [items, employeeId]);
  const item = items.find((i) => i.id === itemId) ?? null;

  // Prefill what's still owed once the chosen entry has loaded, and today's date in the org's
  // zone once that is known; never over something the user has typed.
  const itemOutstanding = item?.outstanding ?? null;
  useEffect(() => {
    if (itemOutstanding !== null) setAmount((a) => a || itemOutstanding);
  }, [itemId, itemOutstanding]);
  useEffect(() => {
    if (today) setPaidOn((p) => p || today);
  }, [today]);
  // One employee with one entry: choose it for them.
  useEffect(() => {
    if (!employeeId && employees.length === 1) setEmployeeId(employees[0]!.id);
  }, [employeeId, employees]);
  useEffect(() => {
    if (employeeId && !itemId && mine.length === 1) {
      setItemId(mine[0]!.id);
      setAmount(mine[0]!.outstanding);
    }
  }, [employeeId, itemId, mine]);

  const chooseEmployee = (v: string) => {
    setEmployeeId(v);
    setItemId("");
    setAmount("");
    setProblem(null);
  };
  const chooseItem = (v: string) => {
    setItemId(v);
    setAmount(items.find((i) => i.id === v)?.outstanding ?? "");
    setProblem(null);
  };

  function validate(): Record<string, string> {
    const e: Record<string, string> = {};
    if (!employeeId) e.employee = "Choose who was paid.";
    if (!item) e.item = "Choose the pay period this payment is for.";
    const a = amount.trim();
    if (!a) e.amount = "Enter the amount paid.";
    else if (!AMOUNT_RE.test(a)) e.amount = "Enter an amount like 160 or 160.00.";
    else if (item) {
      try {
        const minor = toMinor(a, item.currency);
        if (minor <= 0n) e.amount = "The amount has to be more than zero.";
        else if (minor > toMinor(item.outstanding, item.currency)) e.amount = `That's more than the ${fmtMoney(item.outstanding, item.currency)} still owed for this period.`;
      } catch {
        e.amount = `Enter the amount in ${item.currency}, like 160 or 160.00.`;
      }
    }
    if (!paidOn) e.paidOn = "Choose the day the payment was made.";
    else if (today && paidOn > shiftDay(today, 1)) e.paidOn = "A payment can't be recorded for a future date. Record it once it's been made.";
    if (reference.trim().length > 120) e.reference = "Keep the reference under 120 characters.";
    if (remarks.trim().length > 500) e.remarks = "Keep the remarks under 500 characters.";
    return e;
  }

  async function send(confirmDuplicate: boolean) {
    if (busy || !item) return;
    const e = validate();
    setErrors(e);
    if (Object.keys(e).length) return;
    const useKey = confirmDuplicate && dupKey ? dupKey : key;
    setBusy(true);
    setProblem(null);
    try {
      const res = await postIdempotent<{ payment: PaymentView; replayed: boolean }>(
        `${base}/payroll/payments`,
        {
          employeeId: item.employee.id,
          payrollItemId: item.id,
          amount: amount.trim(),
          paidOn,
          method,
          reference: reference.trim() || null,
          remarks: remarks.trim() || null,
          ...(confirmDuplicate ? { confirmDuplicate: true } : {}),
        },
        useKey,
      );
      onRecorded(res.payment, res.replayed);
      close();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // "Record it anyway" is a new, deliberate submission: it gets its own key, made once so a
        // double click on it still records one payment.
        if (err.code === "possible_duplicate") setDupKey((k) => k ?? newKey());
        if (err.code === "duplicate_reference") setErrors((x) => ({ ...x, reference: err.message }));
        setProblem({ code: err.code, message: err.message });
        if (err.code === "overpayment" || err.code === "already_paid") void payable.reload();
      } else {
        setProblem({ code: "error", message: actionError(err, "record the payment") });
      }
    } finally {
      setBusy(false);
    }
  }

  const onSubmit = (ev: FormEvent) => {
    ev.preventDefault();
    void send(false);
  };

  const loading = (payable.loading && !payable.data) || (config.loading && !config.data);
  const presetMissing = !!presetItem && !!payable.data && !items.some((i) => i.id === presetItem);

  return (
    <Modal open title="Record payment" onClose={close} wide>
      {payable.error && !payable.data ? (
        <LoadError what="what's waiting to be paid" error={payable.error} onRetry={() => void payable.reload()} busy={payable.loading} />
      ) : config.error && !config.data ? (
        <LoadError what="your payroll settings" error={config.error} onRetry={() => void config.reload()} busy={config.loading} />
      ) : loading ? (
        <div className="space-y-3" aria-busy="true" aria-label="Loading">
          <div className="skeleton h-9" />
          <div className="skeleton h-9" />
          <div className="skeleton h-9 w-2/3" />
        </div>
      ) : !items.length ? (
        <div className="space-y-3">
          <Alert kind="info">
            {presetMissing || presetEmployee
              ? "Nothing is waiting to be paid for this employee. Either their pay for this period is already fully recorded, or the payroll hasn't been approved yet."
              : "Nothing is waiting to be paid. Payments can be recorded once a payroll is approved and money is still owed."}
          </Alert>
          <div className="flex justify-end">
            <button type="button" className="btn-secondary" onClick={close}>
              Close
            </button>
          </div>
        </div>
      ) : (
        <form className="space-y-4" onSubmit={onSubmit} noValidate>
          {presetMissing && <Alert kind="info">That pay entry has nothing left to pay. Choose another one below, or close this form.</Alert>}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Employee" htmlFor={`${id}-emp`} error={errors.employee} required>
              <select id={`${id}-emp`} className="input" value={employeeId} onChange={(e) => chooseEmployee(e.target.value)} disabled={!!presetEmployee}>
                <option value="">Choose an employee…</option>
                {employees.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.fullName} ({e.employeeNumber})
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Pay period" htmlFor={`${id}-item`} error={errors.item} required>
              <select id={`${id}-item`} className="input" value={itemId} onChange={(e) => chooseItem(e.target.value)} disabled={!employeeId}>
                <option value="">{employeeId ? "Choose a pay period…" : "Choose an employee first"}</option>
                {mine.map((i) => (
                  <option key={i.id} value={i.id}>
                    {fmtSpan(i.period.from, i.period.to)} · {fmtMoney(i.outstanding, i.currency)} owed
                  </option>
                ))}
              </select>
            </Field>
          </div>

          {item && (
            <dl className="grid grid-cols-3 gap-2 rounded-lg border border-border bg-bg px-3 py-2 text-sm">
              <div>
                <dt className="text-xs text-muted">Net pay (estimated)</dt>
                <dd className="font-medium tabular-nums">{fmtMoney(item.net, item.currency)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Already paid</dt>
                <dd className="font-medium tabular-nums">{fmtMoney(item.paid, item.currency)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Still owed</dt>
                <dd className="font-semibold tabular-nums">{fmtMoney(item.outstanding, item.currency)}</dd>
              </div>
            </dl>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={item ? `Amount paid (${item.currency})` : "Amount paid"} htmlFor={`${id}-amount`} error={errors.amount} required>
              <div className="flex gap-2">
                <input
                  id={`${id}-amount`}
                  className="input"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="0.00"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  disabled={!item}
                />
                {item && (
                  <button type="button" className="btn-secondary shrink-0 px-3" onClick={() => setAmount(item.outstanding)} disabled={amount.trim() === item.outstanding}>
                    Pay remaining balance
                  </button>
                )}
              </div>
            </Field>
            <Field label="Payment date" htmlFor={`${id}-date`} error={errors.paidOn} required>
              <input id={`${id}-date`} type="date" className="input" value={paidOn} max={today ?? undefined} onChange={(e) => setPaidOn(e.target.value)} />
            </Field>
            <Field label="Payment method" htmlFor={`${id}-method`} required>
              <select id={`${id}-method`} className="input" value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
                {PAYMENT_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {PAYMENT_METHOD_LABEL[m]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Transaction reference" htmlFor={`${id}-ref`} error={errors.reference} hint="Optional: the bank or provider's reference, so the payment can be matched later.">
              <input id={`${id}-ref`} className="input" maxLength={120} autoComplete="off" value={reference} onChange={(e) => setReference(e.target.value)} />
            </Field>
          </div>
          <Field label="Remarks" htmlFor={`${id}-remarks`} error={errors.remarks} hint="Optional.">
            <textarea id={`${id}-remarks`} className="input min-h-[4.5rem]" maxLength={500} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
          </Field>

          {problem && (
            <Alert kind={problem.code === "possible_duplicate" ? "info" : "error"}>
              <span className="block">{problem.message}</span>
              {problem.code === "possible_duplicate" && (
                <button type="button" className="btn-secondary mt-2" onClick={() => void send(true)} disabled={busy}>
                  {busy ? "Recording…" : "Record it anyway"}
                </button>
              )}
            </Alert>
          )}

          <p className="text-xs text-muted">Recording a payment doesn&apos;t send money. Record it after you&apos;ve paid through your bank or provider.</p>

          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" className="btn-secondary" onClick={close} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className="btn-primary" disabled={busy || !item}>
              {busy ? "Recording…" : "Record payment"}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

"use client";
/** Adding an earning or a deduction to a pay run, for anyone in it or any other employee. */
import { useId, useMemo, useState, type FormEvent } from "react";
import { toMinor } from "@app/shared/staff";
import { Field, Modal } from "@/components/staff/ui";
import { Alert } from "@/components/ui";
import { actionError, api, useApi } from "@/lib/api";
import type { EmployeeRow } from "@/lib/staff";
import { AMOUNT_RE, type Item, type Period } from "@/components/staff/payroll/payRun";

export function AdjustmentModal({
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

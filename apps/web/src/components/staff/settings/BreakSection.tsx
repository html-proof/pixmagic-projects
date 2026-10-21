"use client";
/** Break policies: the breaks employees take and which of them are paid. */
import { useCallback, useId, useState, type FormEvent } from "react";
import { Panel } from "@/components/dashboard/Primitives";
import { Alert } from "@/components/ui";
import { ConfirmDialog, useAction, useToast } from "@/components/AppUi";
import { Field, Modal } from "@/components/staff/ui";
import { actionError, api } from "@/lib/api";
import { useStaff, type StaffConfig } from "@/lib/staff";
import { intIn, ReadOnlyNote, Toggle } from "@/components/staff/settings/SettingsUi";

const enc = encodeURIComponent;

type BreakPolicy = StaffConfig["breakPolicies"][number];

function breakSummary(p: BreakPolicy) {
  const parts = [`Short breaks ${p.restBreaksPaid ? "paid" : "unpaid"}`, `meal breaks ${p.mealBreaksPaid ? "paid" : "unpaid"}`];
  if (p.maxBreaksPerShift !== null) parts.push(`up to ${p.maxBreaksPerShift} ${p.maxBreaksPerShift === 1 ? "break" : "breaks"} a shift`);
  if (p.maxBreakMinutes !== null) parts.push(`up to ${p.maxBreakMinutes} min each`);
  return parts.join(", ");
}

export function BreakSection({ config, onChanged }: { config: StaffConfig; onChanged: () => void }) {
  const { base, can } = useStaff();
  const { busy, run } = useAction();
  const editable = can("pay:manage");
  const [editing, setEditing] = useState<{ policy: BreakPolicy | null } | null>(null);
  const [removing, setRemoving] = useState<BreakPolicy | null>(null);
  const closeEdit = useCallback(() => setEditing(null), []);
  const closeRemove = useCallback(() => setRemoving(null), []);

  const remove = () =>
    run("remove", "delete the break policy", async () => {
      if (!removing) return;
      await api(`${base}/break-policies/${enc(removing.id)}`, { method: "DELETE" });
      setRemoving(null);
      onChanged();
      return `${removing.name} deleted.`;
    });

  return (
    <Panel
      id="staff-breaks"
      title="Break policies"
      help="Which breaks are paid, and the limits that flag a shift for review."
      aside={
        editable && (
          <button type="button" className="btn-secondary" onClick={() => setEditing({ policy: null })}>
            Add break policy
          </button>
        )
      }
    >
      {!editable && <ReadOnlyNote>Only owners, admins and payroll managers can change break policies.</ReadOnlyNote>}
      {config.breakPolicies.length === 0 ? (
        <p className="text-sm text-muted">No break policies. Without one, short breaks are paid and meal breaks are unpaid.</p>
      ) : (
        <ul className="divide-y divide-border">
          {config.breakPolicies.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 font-medium">
                  {p.name}
                  {config.settings.defaultBreakPolicyId === p.id && <span className="rounded-full bg-border/60 px-2 py-0.5 text-[11px] font-normal text-muted">Default for new employees</span>}
                </p>
                <p className="text-sm text-muted">{breakSummary(p)}</p>
              </div>
              {editable && (
                <div className="flex gap-3 text-sm">
                  <button type="button" className="text-accent underline-offset-2 hover:underline" onClick={() => setEditing({ policy: p })} aria-label={`Edit ${p.name}`}>
                    Edit
                  </button>
                  <button type="button" className="text-muted underline-offset-2 hover:text-danger hover:underline" onClick={() => setRemoving(p)} aria-label={`Delete ${p.name}`}>
                    Delete
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <Modal open={!!editing} title={editing?.policy ? `Edit ${editing.policy.name}` : "Add break policy"} onClose={closeEdit}>
        {editing && (
          <BreakForm
            key={editing.policy?.id ?? "new"}
            policy={editing.policy}
            onSaved={() => {
              setEditing(null);
              onChanged();
            }}
            onCancel={closeEdit}
          />
        )}
      </Modal>
      <ConfirmDialog open={!!removing} title={`Delete ${removing?.name ?? "this policy"}?`} confirmLabel="Delete policy" danger busy={busy === "remove"} onConfirm={() => void remove()} onCancel={closeRemove}>
        <p>Employees on this policy will have none: short breaks paid, meal breaks unpaid, no limits. Breaks already recorded keep whether they were paid.</p>
      </ConfirmDialog>
    </Panel>
  );
}

function BreakForm({ policy, onSaved, onCancel }: { policy: BreakPolicy | null; onSaved: () => void; onCancel: () => void }) {
  const { base } = useStaff();
  const toast = useToast();
  const uid = useId();
  const [name, setName] = useState(policy?.name ?? "");
  const [restPaid, setRestPaid] = useState(policy?.restBreaksPaid ?? true);
  const [mealPaid, setMealPaid] = useState(policy?.mealBreaksPaid ?? false);
  const [maxBreaks, setMaxBreaks] = useState(policy?.maxBreaksPerShift == null ? "" : String(policy.maxBreaksPerShift));
  const [maxMinutes, setMaxMinutes] = useState(policy?.maxBreakMinutes == null ? "" : String(policy.maxBreakMinutes));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setProblem(null);
    const found: Record<string, string> = {};
    if (!name.trim()) found.name = "Give the policy a name, like Standard breaks.";
    else if (name.trim().length > 80) found.name = "Keep the name under 80 characters.";
    if (maxBreaks.trim() && !intIn(maxBreaks, 1, 20)) found.maxBreaks = "Enter a whole number from 1 to 20, or leave it empty.";
    if (maxMinutes.trim() && !intIn(maxMinutes, 1, 600)) found.maxMinutes = "Enter whole minutes from 1 to 600, or leave it empty.";
    setErrors(found);
    if (Object.keys(found).length) return;
    const body = {
      name: name.trim(),
      restBreaksPaid: restPaid,
      mealBreaksPaid: mealPaid,
      maxBreaksPerShift: maxBreaks.trim() ? Number(maxBreaks) : null,
      maxBreakMinutes: maxMinutes.trim() ? Number(maxMinutes) : null,
    };
    setBusy(true);
    try {
      if (policy) await api(`${base}/break-policies/${enc(policy.id)}`, { method: "PUT", body });
      else await api(`${base}/break-policies`, { method: "POST", body });
      toast("success", policy ? "Break policy saved." : "Break policy added.");
      onSaved();
    } catch (err) {
      setProblem(actionError(err, "save the break policy"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="space-y-4">
      <Field label="Policy name" htmlFor={`${uid}-name`} error={errors.name} required>
        <input id={`${uid}-name`} className="input" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} aria-invalid={!!errors.name} />
      </Field>
      <div className="space-y-3">
        <Toggle id={`${uid}-rest`} checked={restPaid} onChange={setRestPaid} label="Short breaks are paid" hint="Short rest breaks count as worked time." />
        <Toggle id={`${uid}-meal`} checked={mealPaid} onChange={setMealPaid} label="Meal breaks are paid" hint="Meal breaks count as worked time." />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Most breaks in one shift (optional)" htmlFor={`${uid}-max`} error={errors.maxBreaks} hint="More than this flags the shift for review.">
          <input id={`${uid}-max`} type="number" inputMode="numeric" min={1} max={20} className="input" value={maxBreaks} onChange={(e) => setMaxBreaks(e.target.value)} aria-invalid={!!errors.maxBreaks} />
        </Field>
        <Field label="Longest break in minutes (optional)" htmlFor={`${uid}-minutes`} error={errors.maxMinutes} hint="A longer break flags the shift for review.">
          <input id={`${uid}-minutes`} type="number" inputMode="numeric" min={1} max={600} className="input" value={maxMinutes} onChange={(e) => setMaxMinutes(e.target.value)} aria-invalid={!!errors.maxMinutes} />
        </Field>
      </div>
      <p className="text-xs text-muted">Limits don&apos;t stop anyone taking a break: they mark the shift so a manager can check it.</p>
      {problem && <Alert>{problem}</Alert>}
      <div className="flex flex-wrap gap-2">
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? "Saving…" : policy ? "Save policy" : "Add policy"}
        </button>
        <button type="button" className="btn-secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}

"use client";
/** Overtime policies: when overtime starts and how it is paid. */
import { useCallback, useId, useState, type FormEvent } from "react";
import { Panel } from "@/components/dashboard/Primitives";
import { Alert } from "@/components/ui";
import { ConfirmDialog, useAction, useToast } from "@/components/AppUi";
import { Field, Modal } from "@/components/staff/ui";
import { minutesToHours } from "@/components/staff/EmployeeForm";
import { actionError, api } from "@/lib/api";
import { useStaff, type StaffConfig } from "@/lib/staff";
import { ReadOnlyNote } from "@/components/staff/settings/SettingsUi";

const enc = encodeURIComponent;

type OvertimePolicy = StaffConfig["overtimePolicies"][number];

const MULT_RE = /^\d{1,2}(\.\d{1,4})?$/;

const hrs = (m: number) => `${minutesToHours(m)} h`;

function overtimeSummary(p: OvertimePolicy) {
  const parts: string[] = [];
  const when = [p.dailyThresholdMinutes !== null ? `${hrs(p.dailyThresholdMinutes)} a day` : null, p.weeklyThresholdMinutes !== null ? `${hrs(p.weeklyThresholdMinutes)} a week` : null].filter(Boolean);
  parts.push(when.length ? `Overtime after ${when.join(" or ")} at ${p.multiplier}×` : "No overtime");
  if (p.doubleTimeDailyThresholdMinutes !== null && p.doubleTimeMultiplier) parts.push(`double time after ${hrs(p.doubleTimeDailyThresholdMinutes)} a day at ${p.doubleTimeMultiplier}×`);
  parts.push(Number(p.holidayMultiplier) > 1 ? `public holidays at ${p.holidayMultiplier}×` : "no public holiday rate");
  return parts.join("; ");
}

interface OvertimeDraft {
  name: string;
  daily: string;
  weekly: string;
  multiplier: string;
  dtHours: string;
  dtMultiplier: string;
  holiday: string;
}

const PRESETS: ReadonlyArray<{ label: string; draft: Omit<OvertimeDraft, "name"> }> = [
  { label: "No overtime", draft: { daily: "", weekly: "", multiplier: "1", dtHours: "", dtMultiplier: "", holiday: "1" } },
  { label: "Over 40 h a week at 1.5×", draft: { daily: "", weekly: "40", multiplier: "1.5", dtHours: "", dtMultiplier: "", holiday: "1" } },
  { label: "Over 38 h a week at 1.5×", draft: { daily: "", weekly: "38", multiplier: "1.5", dtHours: "", dtMultiplier: "", holiday: "1" } },
  { label: "Over 8 h a day at 1.5×, over 12 h at 2×", draft: { daily: "8", weekly: "", multiplier: "1.5", dtHours: "12", dtMultiplier: "2", holiday: "1" } },
];

const overtimeDraftOf = (p: OvertimePolicy | null): OvertimeDraft =>
  p
    ? {
        name: p.name,
        daily: p.dailyThresholdMinutes === null ? "" : minutesToHours(p.dailyThresholdMinutes),
        weekly: p.weeklyThresholdMinutes === null ? "" : minutesToHours(p.weeklyThresholdMinutes),
        multiplier: p.multiplier,
        dtHours: p.doubleTimeDailyThresholdMinutes === null ? "" : minutesToHours(p.doubleTimeDailyThresholdMinutes),
        dtMultiplier: p.doubleTimeMultiplier ?? "",
        holiday: p.holidayMultiplier,
      }
    : { name: "", daily: "", weekly: "", multiplier: "1.5", dtHours: "", dtMultiplier: "", holiday: "1" };

export function OvertimeSection({ config, onChanged }: { config: StaffConfig; onChanged: () => void }) {
  const { base, can } = useStaff();
  const { busy, run } = useAction();
  const editable = can("pay:manage");
  const [editing, setEditing] = useState<{ policy: OvertimePolicy | null } | null>(null);
  const [removing, setRemoving] = useState<OvertimePolicy | null>(null);
  const closeEdit = useCallback(() => setEditing(null), []);
  const closeRemove = useCallback(() => setRemoving(null), []);

  const remove = () =>
    run("remove", "delete the overtime policy", async () => {
      if (!removing) return;
      await api(`${base}/overtime-policies/${enc(removing.id)}`, { method: "DELETE" });
      setRemoving(null);
      onChanged();
      return `${removing.name} deleted.`;
    });

  return (
    <Panel
      id="staff-overtime"
      title="Overtime policies"
      help="How hours beyond the usual are paid. Each employee follows one policy, or none."
      aside={
        editable && (
          <button type="button" className="btn-secondary" onClick={() => setEditing({ policy: null })}>
            Add overtime policy
          </button>
        )
      }
    >
      {!editable && <ReadOnlyNote>Only owners, admins and payroll managers can change overtime policies.</ReadOnlyNote>}
      <p className="mb-3 text-xs text-muted">Overtime rules differ by country, state and industry agreement. bizinsights doesn&apos;t choose them for you: set up the rules that apply to your business.</p>
      {config.overtimePolicies.length === 0 ? (
        <p className="text-sm text-muted">No overtime policies yet, so all hours are paid at the normal rate.</p>
      ) : (
        <ul className="divide-y divide-border">
          {config.overtimePolicies.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 font-medium">
                  {p.name}
                  {config.settings.defaultOvertimePolicyId === p.id && <span className="rounded-full bg-border/60 px-2 py-0.5 text-[11px] font-normal text-muted">Default for new employees</span>}
                </p>
                <p className="text-sm text-muted">{overtimeSummary(p)}</p>
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
      <Modal open={!!editing} title={editing?.policy ? `Edit ${editing.policy.name}` : "Add overtime policy"} onClose={closeEdit} wide>
        {editing && (
          <OvertimeForm
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
        <p>Employees on this policy will have no overtime until you choose another for them. Payroll that&apos;s already approved doesn&apos;t change.</p>
      </ConfirmDialog>
    </Panel>
  );
}

function OvertimeForm({ policy, onSaved, onCancel }: { policy: OvertimePolicy | null; onSaved: () => void; onCancel: () => void }) {
  const { base } = useStaff();
  const toast = useToast();
  const uid = useId();
  const id = (k: string) => `${uid}-${k}`;
  const [d, setD] = useState<OvertimeDraft>(() => overtimeDraftOf(policy));
  const [errors, setErrors] = useState<Partial<Record<keyof OvertimeDraft, string>>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof OvertimeDraft, v: string) => {
    setD((x) => ({ ...x, [k]: v }));
    if (errors[k]) setErrors((e) => ({ ...e, [k]: undefined }));
  };
  const applyPreset = (p: (typeof PRESETS)[number]) => {
    setD((x) => ({ ...p.draft, name: !x.name.trim() || PRESETS.some((q) => q.label === x.name) ? p.label : x.name }));
    setErrors({});
  };

  const hoursOk = (v: string, max: number) => v.trim() === "" || (Number.isFinite(Number(v)) && Math.round(Number(v) * 60) >= 1 && Number(v) <= max);
  const multOk = (v: string) => MULT_RE.test(v.trim()) && Number(v) >= 1 && Number(v) <= 10;
  const minutes = (v: string) => (v.trim() === "" ? null : Math.round(Number(v) * 60));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setProblem(null);
    const found: Partial<Record<keyof OvertimeDraft, string>> = {};
    if (!d.name.trim()) found.name = "Give the policy a name, like Standard overtime.";
    else if (d.name.trim().length > 80) found.name = "Keep the name under 80 characters.";
    if (!hoursOk(d.daily, 24)) found.daily = "Enter hours from 0.25 to 24, or leave it empty.";
    if (!hoursOk(d.weekly, 168)) found.weekly = "Enter hours from 0.25 to 168, or leave it empty.";
    if (!multOk(d.multiplier)) found.multiplier = "Enter a rate from 1 to 10, like 1.5.";
    if (!hoursOk(d.dtHours, 24)) found.dtHours = "Enter hours from 0.25 to 24, or leave it empty.";
    if (d.dtMultiplier.trim() && !multOk(d.dtMultiplier)) found.dtMultiplier = "Enter a rate from 1 to 10, like 2.";
    if (!found.dtHours && !found.dtMultiplier && !!d.dtHours.trim() !== !!d.dtMultiplier.trim()) {
      found[d.dtHours.trim() ? "dtMultiplier" : "dtHours"] = "Give double time both hours and a rate, or leave both empty.";
    }
    if (!found.dtHours && !found.daily && d.dtHours.trim() && d.daily.trim() && Number(d.dtHours) <= Number(d.daily)) found.dtHours = "Double time has to start after daily overtime does.";
    if (!multOk(d.holiday)) found.holiday = "Enter a rate from 1 to 10. Use 1 for no public holiday rate.";
    setErrors(found);
    const first = Object.keys(found)[0];
    if (first) {
      document.getElementById(id(first))?.focus();
      return;
    }
    const body = {
      name: d.name.trim(),
      dailyThresholdMinutes: minutes(d.daily),
      weeklyThresholdMinutes: minutes(d.weekly),
      multiplier: d.multiplier.trim(),
      doubleTimeDailyThresholdMinutes: minutes(d.dtHours),
      doubleTimeMultiplier: d.dtMultiplier.trim() || null,
      holidayMultiplier: d.holiday.trim(),
    };
    setBusy(true);
    try {
      if (policy) await api(`${base}/overtime-policies/${enc(policy.id)}`, { method: "PUT", body });
      else await api(`${base}/overtime-policies`, { method: "POST", body });
      toast("success", policy ? "Overtime policy saved." : "Overtime policy added.");
      onSaved();
    } catch (err) {
      setProblem(actionError(err, "save the overtime policy"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="space-y-5">
      <div className="space-y-2">
        <p className="label">Start from a common rule</p>
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <button key={p.label} type="button" className="btn-secondary px-3 py-1.5 text-xs" onClick={() => applyPreset(p)}>
              {p.label}
            </button>
          ))}
        </div>
        <Alert kind="info">
          These only fill in the form. Overtime rules differ by country, state and industry agreement, so check which rules apply to your business before you save. bizinsights uses exactly what you set here.
        </Alert>
      </div>
      <Field label="Policy name" htmlFor={id("name")} error={errors.name} required>
        <input id={id("name")} className="input" maxLength={80} value={d.name} onChange={(e) => set("name", e.target.value)} aria-invalid={!!errors.name} />
      </Field>
      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold">Overtime</legend>
        <p className="text-xs text-muted">Leave an hours box empty to switch that rule off. With neither, there&apos;s no overtime.</p>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="After this many hours in a day" htmlFor={id("daily")} error={errors.daily}>
            <input id={id("daily")} type="number" inputMode="decimal" step="any" min={0} max={24} className="input" value={d.daily} onChange={(e) => set("daily", e.target.value)} aria-invalid={!!errors.daily} />
          </Field>
          <Field label="After this many hours in a week" htmlFor={id("weekly")} error={errors.weekly}>
            <input id={id("weekly")} type="number" inputMode="decimal" step="any" min={0} max={168} className="input" value={d.weekly} onChange={(e) => set("weekly", e.target.value)} aria-invalid={!!errors.weekly} />
          </Field>
          <Field label="Overtime rate (× normal pay)" htmlFor={id("multiplier")} error={errors.multiplier} required>
            <input id={id("multiplier")} className="input" inputMode="decimal" value={d.multiplier} onChange={(e) => set("multiplier", e.target.value)} aria-invalid={!!errors.multiplier} />
          </Field>
        </div>
      </fieldset>
      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold">Double time (optional)</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="After this many hours in a day" htmlFor={id("dtHours")} error={errors.dtHours}>
            <input id={id("dtHours")} type="number" inputMode="decimal" step="any" min={0} max={24} className="input" value={d.dtHours} onChange={(e) => set("dtHours", e.target.value)} aria-invalid={!!errors.dtHours} />
          </Field>
          <Field label="Double-time rate (× normal pay)" htmlFor={id("dtMultiplier")} error={errors.dtMultiplier}>
            <input id={id("dtMultiplier")} className="input" inputMode="decimal" value={d.dtMultiplier} placeholder="e.g. 2" onChange={(e) => set("dtMultiplier", e.target.value)} aria-invalid={!!errors.dtMultiplier} />
          </Field>
        </div>
      </fieldset>
      <Field label="Public holiday rate (× normal pay)" htmlFor={id("holiday")} error={errors.holiday} required hint="For hours worked on the public holidays listed below. Use 1 for no extra pay.">
        <input id={id("holiday")} className="input sm:max-w-48" inputMode="decimal" value={d.holiday} onChange={(e) => set("holiday", e.target.value)} aria-invalid={!!errors.holiday} />
      </Field>
      {policy && <p className="text-xs text-muted">Changes apply to payroll calculated from now on. Approved payroll doesn&apos;t change.</p>}
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

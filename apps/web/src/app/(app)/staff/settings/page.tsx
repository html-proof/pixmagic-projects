"use client";
import { useCallback, useId, useState, type FormEvent, type ReactNode } from "react";
import { isCalendarDay, isCurrencyCode, isTimeZone, localDayOf, PAY_CYCLE_LABEL, PAY_CYCLES, periodContaining, WEEKDAY_LABEL, type PayCycle } from "@app/shared/staff";
import { Panel } from "@/components/dashboard/Primitives";
import { LoadError } from "@/components/LoadError";
import { Alert } from "@/components/ui";
import { ConfirmDialog, PageHeader, Skeleton, useAction, useToast } from "@/components/AppUi";
import { Field, Modal } from "@/components/staff/ui";
import { CurrencySelect, minutesToHours, TimeZoneInput } from "@/components/staff/EmployeeForm";
import { actionError, api, useApi } from "@/lib/api";
import { fmtDay, fmtSpan, useStaff, type StaffConfig } from "@/lib/staff";

// ---------------------------------------------------------------------------------------------
// Staff settings: the organization's time zone, currency and pay cycle; departments; overtime and
// break policies; public holidays. Each section saves on its own and is read-only for people who
// may not change it (the API checks the same permissions).
// ---------------------------------------------------------------------------------------------

type Settings = StaffConfig["settings"];
type OvertimePolicy = StaffConfig["overtimePolicies"][number];
type BreakPolicy = StaffConfig["breakPolicies"][number];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MULT_RE = /^\d{1,2}(\.\d{1,4})?$/;
const enc = encodeURIComponent;

export default function StaffSettingsPage() {
  const { base } = useStaff();
  const config = useApi<StaffConfig>(`${base}/config`);
  if (config.error) return <LoadError what="staff settings" error={config.error} onRetry={() => void config.reload()} busy={config.loading} />;
  if (!config.data) return <Skeleton lines={8} />;
  const cfg = config.data;
  const reload = () => void config.reload();
  return (
    <>
      <PageHeader title="Staff settings" sub="How your organization records time and pays staff. Each section saves on its own." />
      <GeneralSection key={`${base}|${JSON.stringify(cfg.settings)}`} config={cfg} onSaved={config.setData} />
      <DepartmentsSection config={cfg} onChanged={reload} />
      <OvertimeSection config={cfg} onChanged={reload} />
      <BreakSection config={cfg} onChanged={reload} />
      <HolidaysSection config={cfg} onChanged={reload} />
    </>
  );
}

function ReadOnlyNote({ children }: { children: ReactNode }) {
  return <p className="mb-3 rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted">{children}</p>;
}

// ---------------------------------------------------------------------------------------------
// General and pay cycle
// ---------------------------------------------------------------------------------------------

interface GeneralDraft {
  timezone: string;
  currency: string;
  payCycle: PayCycle;
  payCycleAnchor: string;
  weekStartsOn: number;
  invitationExpiryHours: string;
  staleSessionHours: string;
  lateGraceMinutes: string;
  requireApproval: boolean;
  allowEmployeeCorrections: boolean;
  jurisdiction: string;
  supportEmail: string;
  defaultOvertimePolicyId: string;
  defaultBreakPolicyId: string;
}

const draftOf = (s: Settings): GeneralDraft => ({
  timezone: s.timezone,
  currency: s.currency,
  payCycle: s.payCycle,
  payCycleAnchor: s.payCycleAnchor,
  weekStartsOn: s.weekStartsOn,
  invitationExpiryHours: String(s.invitationExpiryHours),
  staleSessionHours: String(s.staleSessionHours),
  lateGraceMinutes: String(s.lateGraceMinutes),
  requireApproval: s.requireApproval,
  allowEmployeeCorrections: s.allowEmployeeCorrections,
  jurisdiction: s.jurisdiction ?? "",
  supportEmail: s.supportEmail ?? "",
  defaultOvertimePolicyId: s.defaultOvertimePolicyId ?? "",
  defaultBreakPolicyId: s.defaultBreakPolicyId ?? "",
});

const intIn = (v: string, min: number, max: number) => /^\d+$/.test(v.trim()) && Number(v) >= min && Number(v) <= max;

function GeneralSection({ config, onSaved }: { config: StaffConfig; onSaved: (c: StaffConfig) => void }) {
  const { base, can } = useStaff();
  const toast = useToast();
  const uid = useId();
  const id = (k: string) => `${uid}-${k}`;
  const editable = can("staff:settings");
  const saved = config.settings;
  const [d, setD] = useState<GeneralDraft>(() => draftOf(saved));
  const [errors, setErrors] = useState<Partial<Record<keyof GeneralDraft, string>>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof GeneralDraft>(k: K, v: GeneralDraft[K]) => {
    setD((x) => ({ ...x, [k]: v }));
    if (errors[k]) setErrors((e) => ({ ...e, [k]: undefined }));
  };
  const usesAnchor = d.payCycle === "weekly" || d.payCycle === "biweekly";

  // Only what changed: the API refuses some changes while a payroll is in progress, even to the same value.
  const patch: Record<string, unknown> = {};
  if (d.timezone.trim() !== saved.timezone) patch.timezone = d.timezone.trim();
  if (d.currency !== saved.currency) patch.currency = d.currency;
  if (d.payCycle !== saved.payCycle) patch.payCycle = d.payCycle;
  if (usesAnchor && d.payCycleAnchor !== saved.payCycleAnchor) patch.payCycleAnchor = d.payCycleAnchor;
  if (d.weekStartsOn !== saved.weekStartsOn) patch.weekStartsOn = d.weekStartsOn;
  if (d.invitationExpiryHours.trim() !== String(saved.invitationExpiryHours)) patch.invitationExpiryHours = Number(d.invitationExpiryHours);
  if (d.staleSessionHours.trim() !== String(saved.staleSessionHours)) patch.staleSessionHours = Number(d.staleSessionHours);
  if (d.lateGraceMinutes.trim() !== String(saved.lateGraceMinutes)) patch.lateGraceMinutes = Number(d.lateGraceMinutes);
  if (d.requireApproval !== saved.requireApproval) patch.requireApproval = d.requireApproval;
  if (d.allowEmployeeCorrections !== saved.allowEmployeeCorrections) patch.allowEmployeeCorrections = d.allowEmployeeCorrections;
  if ((d.jurisdiction.trim() || null) !== saved.jurisdiction) patch.jurisdiction = d.jurisdiction.trim() || null;
  if ((d.supportEmail.trim() || null) !== saved.supportEmail) patch.supportEmail = d.supportEmail.trim() || null;
  if ((d.defaultOvertimePolicyId || null) !== saved.defaultOvertimePolicyId) patch.defaultOvertimePolicyId = d.defaultOvertimePolicyId || null;
  if ((d.defaultBreakPolicyId || null) !== saved.defaultBreakPolicyId) patch.defaultBreakPolicyId = d.defaultBreakPolicyId || null;
  const dirty = Object.keys(patch).length > 0;

  const today = localDayOf(Date.now(), isTimeZone(d.timezone.trim()) ? d.timezone.trim() : saved.timezone);
  const current = usesAnchor && !isCalendarDay(d.payCycleAnchor) ? null : periodContaining(today, d.payCycle, d.payCycleAnchor);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setProblem(null);
    const found: Partial<Record<keyof GeneralDraft, string>> = {};
    if (!isTimeZone(d.timezone.trim())) found.timezone = "Choose a time zone from the list, like Australia/Sydney.";
    if (!isCurrencyCode(d.currency)) found.currency = "Choose a currency from the list.";
    if (usesAnchor && !isCalendarDay(d.payCycleAnchor)) found.payCycleAnchor = "Choose a day a pay period starts on.";
    if (!intIn(d.invitationExpiryHours, 1, 336)) found.invitationExpiryHours = "Enter whole hours from 1 to 336 (two weeks).";
    if (!intIn(d.staleSessionHours, 4, 48)) found.staleSessionHours = "Enter whole hours from 4 to 48.";
    if (!intIn(d.lateGraceMinutes, 0, 120)) found.lateGraceMinutes = "Enter whole minutes from 0 to 120.";
    if (d.jurisdiction.trim().length > 40) found.jurisdiction = "Keep the region label under 40 characters.";
    if (d.supportEmail.trim() && (!EMAIL_RE.test(d.supportEmail.trim()) || d.supportEmail.trim().length > 254)) found.supportEmail = "That doesn't look like an email address.";
    setErrors(found);
    const first = Object.keys(found)[0];
    if (first) {
      document.getElementById(id(first))?.focus();
      return;
    }
    if (!dirty) return;
    setBusy(true);
    try {
      const next = await api<StaffConfig>(`${base}/settings`, { method: "PUT", body: patch });
      toast("success", "Settings saved.");
      onSaved({ ...config, ...next });
    } catch (err) {
      setProblem(actionError(err, "save the settings"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel id="staff-general" title="General and pay cycle" help="Your organization's time zone, currency and pay periods, and how attendance is handled.">
      {!editable && <ReadOnlyNote>Only owners and admins can change these settings.</ReadOnlyNote>}
      <form onSubmit={(e) => void submit(e)} noValidate>
        <fieldset disabled={!editable || busy} className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Time zone" htmlFor={id("timezone")} error={errors.timezone} hint="Days, weeks and pay periods follow this time zone. Can't change while a payroll is in progress.">
              <TimeZoneInput id={id("timezone")} value={d.timezone} onChange={(v) => set("timezone", v)} invalid={!!errors.timezone} />
            </Field>
            <Field label="Currency" htmlFor={id("currency")} error={errors.currency} hint="Used for new employees and for totals in reports.">
              <CurrencySelect id={id("currency")} value={d.currency} onChange={(v) => set("currency", v)} />
            </Field>
            <Field label="Pay cycle" htmlFor={id("payCycle")} hint="How often you pay staff. Can't change while a payroll is in progress.">
              <select id={id("payCycle")} className="input" value={d.payCycle} onChange={(e) => set("payCycle", e.target.value as PayCycle)}>
                {PAY_CYCLES.map((c) => (
                  <option key={c} value={c}>
                    {PAY_CYCLE_LABEL[c]}
                  </option>
                ))}
              </select>
            </Field>
            {usesAnchor ? (
              <Field label="A day a pay period starts" htmlFor={id("payCycleAnchor")} error={errors.payCycleAnchor} hint={`Any past or future start day. Periods repeat every ${d.payCycle === "weekly" ? "week" : "two weeks"} from it.`}>
                <input id={id("payCycleAnchor")} type="date" className="input" value={d.payCycleAnchor} onChange={(e) => set("payCycleAnchor", e.target.value)} aria-invalid={!!errors.payCycleAnchor} />
              </Field>
            ) : (
              <div className="text-sm text-muted sm:pt-7">
                {d.payCycle === "semimonthly" ? "Periods run from the 1st to the 15th and the 16th to the end of each month." : d.payCycle === "monthly" ? "Periods are calendar months." : "Each day is its own pay period."}
              </div>
            )}
            <Field label="Week starts on" htmlFor={id("weekStartsOn")} hint="For weekly overtime, the schedule and reports.">
              <select id={id("weekStartsOn")} className="input" value={d.weekStartsOn} onChange={(e) => set("weekStartsOn", Number(e.target.value))}>
                {WEEKDAY_LABEL.map((l, i) => (
                  <option key={l} value={i}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
            {current && (
              <div className="rounded-lg border border-border bg-bg px-3 py-2 text-sm sm:self-end">
                <p className="text-xs text-muted">Current pay period with these settings</p>
                <p className="font-medium">{fmtSpan(current.from, current.to)}</p>
              </div>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Invitations expire after (hours)" htmlFor={id("invitationExpiryHours")} error={errors.invitationExpiryHours} hint="1 to 336. New invitations only.">
              <input id={id("invitationExpiryHours")} type="number" inputMode="numeric" min={1} max={336} className="input" value={d.invitationExpiryHours} onChange={(e) => set("invitationExpiryHours", e.target.value)} aria-invalid={!!errors.invitationExpiryHours} />
            </Field>
            <Field label="Forgot to clock out after (hours)" htmlFor={id("staleSessionHours")} error={errors.staleSessionHours} hint="A shift still open this long is flagged for review, and its pay stops growing.">
              <input id={id("staleSessionHours")} type="number" inputMode="numeric" min={4} max={48} className="input" value={d.staleSessionHours} onChange={(e) => set("staleSessionHours", e.target.value)} aria-invalid={!!errors.staleSessionHours} />
            </Field>
            <Field label="Late start grace (minutes)" htmlFor={id("lateGraceMinutes")} error={errors.lateGraceMinutes} hint="Clocking in within this time after a scheduled start isn't counted as late.">
              <input id={id("lateGraceMinutes")} type="number" inputMode="numeric" min={0} max={120} className="input" value={d.lateGraceMinutes} onChange={(e) => set("lateGraceMinutes", e.target.value)} aria-invalid={!!errors.lateGraceMinutes} />
            </Field>
          </div>

          <div className="space-y-3">
            <Toggle id={id("requireApproval")} checked={d.requireApproval} onChange={(v) => set("requireApproval", v)} label="Require approval before payroll" hint="Only approved hours are paid. Turn off to pay recorded hours without approving each shift." />
            <Toggle
              id={id("allowEmployeeCorrections")}
              checked={d.allowEmployeeCorrections}
              onChange={(v) => set("allowEmployeeCorrections", v)}
              label="Allow employees to request corrections"
              hint="Employees can ask for a shift's times to be fixed from their account. A manager approves or rejects each request."
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Region label (optional)"
              htmlFor={id("jurisdiction")}
              error={errors.jurisdiction}
              hint="For your records, like NSW, Australia. bizinsights doesn't apply any region's employment laws, awards or tax rules: you set the overtime and break rules below."
            >
              <input id={id("jurisdiction")} className="input" maxLength={40} value={d.jurisdiction} onChange={(e) => set("jurisdiction", e.target.value)} aria-invalid={!!errors.jurisdiction} />
            </Field>
            <Field label="Support email (optional)" htmlFor={id("supportEmail")} error={errors.supportEmail} hint="Shown to employees in invitations as who to contact. Without one, the person sending the invitation is shown.">
              <input id={id("supportEmail")} type="email" className="input" maxLength={254} value={d.supportEmail} onChange={(e) => set("supportEmail", e.target.value)} aria-invalid={!!errors.supportEmail} />
            </Field>
            <Field label="Default overtime policy" htmlFor={id("defaultOvertimePolicyId")} hint="Chosen for new employees. Existing employees keep theirs.">
              <select id={id("defaultOvertimePolicyId")} className="input" value={d.defaultOvertimePolicyId} onChange={(e) => set("defaultOvertimePolicyId", e.target.value)}>
                <option value="">No overtime</option>
                {config.overtimePolicies.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Default break policy" htmlFor={id("defaultBreakPolicyId")} hint="Chosen for new employees. Existing employees keep theirs.">
              <select id={id("defaultBreakPolicyId")} className="input" value={d.defaultBreakPolicyId} onChange={(e) => set("defaultBreakPolicyId", e.target.value)}>
                <option value="">None (short breaks paid, meal breaks unpaid)</option>
                {config.breakPolicies.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </fieldset>
        {problem && (
          <div className="mt-4">
            <Alert>{problem}</Alert>
          </div>
        )}
        {editable && (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button type="submit" className="btn-primary" disabled={!dirty || busy}>
              {busy ? "Saving…" : "Save settings"}
            </button>
            {dirty && (
              <button
                type="button"
                className="btn-secondary"
                disabled={busy}
                onClick={() => {
                  setD(draftOf(saved));
                  setErrors({});
                  setProblem(null);
                }}
              >
                Discard changes
              </button>
            )}
          </div>
        )}
      </form>
    </Panel>
  );
}

function Toggle({ id, checked, onChange, label, hint }: { id: string; checked: boolean; onChange: (v: boolean) => void; label: string; hint: string }) {
  return (
    <div className="flex items-start gap-3">
      <input id={id} type="checkbox" role="switch" className="mt-1 h-4 w-4 accent-[var(--accent)]" checked={checked} onChange={(e) => onChange(e.target.checked)} aria-describedby={`${id}-hint`} />
      <div>
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        <p id={`${id}-hint`} className="text-xs text-muted">
          {hint}
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Departments
// ---------------------------------------------------------------------------------------------

function DepartmentsSection({ config, onChanged }: { config: StaffConfig; onChanged: () => void }) {
  const { base, can } = useStaff();
  const { busy, run } = useAction();
  const uid = useId();
  const editable = can("staff:manage");
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<StaffConfig["departments"][number] | null>(null);
  const closeRemove = useCallback(() => setRemoving(null), []);
  const taken = (n: string, except?: string) => config.departments.some((d) => d.id !== except && d.name.trim().toLowerCase() === n.trim().toLowerCase());

  const add = (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return setNameError("Enter a name for the department.");
    if (n.length > 80) return setNameError("Keep the name under 80 characters.");
    if (taken(n)) return setNameError("There's already a department with that name.");
    setNameError(null);
    void run("add", "add the department", async () => {
      await api(`${base}/departments`, { method: "POST", body: { name: n } });
      setName("");
      onChanged();
      return `${n} added.`;
    });
  };

  const rename = (e: FormEvent) => {
    e.preventDefault();
    if (!renaming) return;
    const n = renaming.name.trim();
    if (!n) return setRenameError("Enter a name for the department.");
    if (n.length > 80) return setRenameError("Keep the name under 80 characters.");
    if (taken(n, renaming.id)) return setRenameError("There's already a department with that name.");
    setRenameError(null);
    void run(`rename:${renaming.id}`, "rename the department", async () => {
      await api(`${base}/departments/${enc(renaming.id)}`, { method: "PATCH", body: { name: n } });
      setRenaming(null);
      onChanged();
      return "Department renamed.";
    });
  };

  const remove = () =>
    run("remove", "delete the department", async () => {
      if (!removing) return;
      await api(`${base}/departments/${enc(removing.id)}`, { method: "DELETE" });
      setRemoving(null);
      onChanged();
      return `${removing.name} deleted.`;
    });

  return (
    <Panel id="staff-departments" title="Departments" help="Group employees for filters, schedules and reports.">
      {!editable && <ReadOnlyNote>Only owners, admins and HR managers can change departments.</ReadOnlyNote>}
      {config.departments.length === 0 ? (
        <p className="text-sm text-muted">No departments yet.{editable ? " Add one below, or type a new one when adding an employee." : ""}</p>
      ) : (
        <ul className="divide-y divide-border">
          {config.departments.map((dpt) => (
            <li key={dpt.id} className="py-2.5">
              {renaming?.id === dpt.id ? (
                <form onSubmit={rename} noValidate className="flex flex-wrap items-start gap-2">
                  <div className="min-w-48 flex-1">
                    <label htmlFor={`${uid}-rename`} className="sr-only">
                      New name for {dpt.name}
                    </label>
                    <input id={`${uid}-rename`} className="input" autoFocus maxLength={80} value={renaming.name} onChange={(e) => setRenaming({ id: dpt.id, name: e.target.value })} aria-invalid={!!renameError} />
                    {renameError && <p className="mt-1 text-xs text-danger">{renameError}</p>}
                  </div>
                  <button type="submit" className="btn-primary" disabled={busy !== null}>
                    {busy === `rename:${dpt.id}` ? "Saving…" : "Save"}
                  </button>
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={busy !== null}
                    onClick={() => {
                      setRenaming(null);
                      setRenameError(null);
                    }}
                  >
                    Cancel
                  </button>
                </form>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="min-w-0">
                    <span className="font-medium">{dpt.name}</span>
                    <span className="text-sm text-muted">
                      {" "}
                      · {dpt.employees} {dpt.employees === 1 ? "employee" : "employees"}
                    </span>
                  </p>
                  {editable && (
                    <div className="flex gap-3 text-sm">
                      <button type="button" className="text-accent underline-offset-2 hover:underline" onClick={() => setRenaming({ id: dpt.id, name: dpt.name })} aria-label={`Rename ${dpt.name}`}>
                        Rename
                      </button>
                      <button type="button" className="text-muted underline-offset-2 hover:text-danger hover:underline" onClick={() => setRemoving(dpt)} aria-label={`Delete ${dpt.name}`}>
                        Delete
                      </button>
                    </div>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {editable && (
        <form onSubmit={add} noValidate className="mt-4 flex flex-wrap items-start gap-2 border-t border-border pt-4">
          <div className="min-w-48 flex-1">
            <label htmlFor={`${uid}-new`} className="label">
              New department
            </label>
            <input id={`${uid}-new`} className="input" maxLength={80} value={name} placeholder="e.g. Kitchen" onChange={(e) => {
                setName(e.target.value);
                setNameError(null);
              }}
              aria-invalid={!!nameError}
            />
            {nameError && <p className="mt-1 text-xs text-danger">{nameError}</p>}
          </div>
          <button type="submit" className="btn-secondary sm:mt-6" disabled={busy !== null}>
            {busy === "add" ? "Adding…" : "Add department"}
          </button>
        </form>
      )}
      <ConfirmDialog open={!!removing} title={`Delete ${removing?.name ?? "this department"}?`} confirmLabel="Delete department" danger busy={busy === "remove"} onConfirm={() => void remove()} onCancel={closeRemove}>
        <p>
          {removing && removing.employees > 0
            ? `The ${removing.employees} ${removing.employees === 1 ? "employee" : "employees"} in it will be left without a department. Nothing else about them changes.`
            : "No employees are in it."}
        </p>
      </ConfirmDialog>
    </Panel>
  );
}

// ---------------------------------------------------------------------------------------------
// Overtime policies
// ---------------------------------------------------------------------------------------------

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

function OvertimeSection({ config, onChanged }: { config: StaffConfig; onChanged: () => void }) {
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

// ---------------------------------------------------------------------------------------------
// Break policies
// ---------------------------------------------------------------------------------------------

function breakSummary(p: BreakPolicy) {
  const parts = [`Short breaks ${p.restBreaksPaid ? "paid" : "unpaid"}`, `meal breaks ${p.mealBreaksPaid ? "paid" : "unpaid"}`];
  if (p.maxBreaksPerShift !== null) parts.push(`up to ${p.maxBreaksPerShift} ${p.maxBreaksPerShift === 1 ? "break" : "breaks"} a shift`);
  if (p.maxBreakMinutes !== null) parts.push(`up to ${p.maxBreakMinutes} min each`);
  return parts.join(", ");
}

function BreakSection({ config, onChanged }: { config: StaffConfig; onChanged: () => void }) {
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

// ---------------------------------------------------------------------------------------------
// Public holidays
// ---------------------------------------------------------------------------------------------

function HolidaysSection({ config, onChanged }: { config: StaffConfig; onChanged: () => void }) {
  const { base, can } = useStaff();
  const { busy, run } = useAction();
  const uid = useId();
  const editable = can("staff:settings");
  const today = localDayOf(Date.now(), config.settings.timezone);
  const [day, setDay] = useState("");
  const [name, setName] = useState("");
  const [errors, setErrors] = useState<{ day?: string; name?: string }>({});
  const [removing, setRemoving] = useState<StaffConfig["holidays"][number] | null>(null);
  const closeRemove = useCallback(() => setRemoving(null), []);
  const upcoming = config.holidays.filter((h) => h.day >= today);
  const past = config.holidays.filter((h) => h.day < today).reverse();

  const add = (e: FormEvent) => {
    e.preventDefault();
    const found: typeof errors = {};
    if (!isCalendarDay(day)) found.day = "Choose the holiday's date.";
    else if (config.holidays.some((h) => h.day === day)) found.day = "That day is already a holiday.";
    if (!name.trim()) found.name = "Name the holiday, like New Year's Day.";
    else if (name.trim().length > 80) found.name = "Keep the name under 80 characters.";
    setErrors(found);
    if (Object.keys(found).length) return;
    void run("add", "add the holiday", async () => {
      await api(`${base}/holidays`, { method: "POST", body: { day, name: name.trim() } });
      setDay("");
      setName("");
      onChanged();
      return `${name.trim()} added.`;
    });
  };

  const remove = () =>
    run("remove", "remove the holiday", async () => {
      if (!removing) return;
      await api(`${base}/holidays/${enc(removing.id)}`, { method: "DELETE" });
      setRemoving(null);
      onChanged();
      return `${removing.name} removed.`;
    });

  const list = (items: StaffConfig["holidays"]) => (
    <ul className="divide-y divide-border">
      {items.map((h) => (
        <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
          <p className="min-w-0">
            <span className="font-medium">{h.name}</span>
            <span className="text-sm text-muted"> · {fmtDay(h.day)}</span>
          </p>
          {editable && (
            <button type="button" className="text-sm text-muted underline-offset-2 hover:text-danger hover:underline" onClick={() => setRemoving(h)} aria-label={`Remove ${h.name} on ${fmtDay(h.day)}`}>
              Remove
            </button>
          )}
        </li>
      ))}
    </ul>
  );

  return (
    <Panel id="staff-holidays" title="Public holidays" help="On these days nobody is marked absent, and hours are paid at the holiday rate of the employee's overtime policy (if it has one).">
      {!editable && <ReadOnlyNote>Only owners and admins can change public holidays.</ReadOnlyNote>}
      {config.holidays.length === 0 ? (
        <p className="text-sm text-muted">No public holidays added. Add the ones your business observes; bizinsights doesn&apos;t add any by itself.</p>
      ) : (
        <div className="space-y-4">
          <div>
            <h3 className="text-sm font-semibold">Upcoming</h3>
            {upcoming.length ? list(upcoming) : <p className="py-2 text-sm text-muted">None coming up.</p>}
          </div>
          {past.length > 0 && (
            <details>
              <summary className="cursor-pointer text-sm font-semibold">Past ({past.length})</summary>
              {list(past)}
            </details>
          )}
        </div>
      )}
      {editable && (
        <form onSubmit={add} noValidate className="mt-4 grid gap-3 border-t border-border pt-4 sm:grid-cols-[12rem_1fr_auto] sm:items-start">
          <Field label="Date" htmlFor={`${uid}-day`} error={errors.day}>
            <input id={`${uid}-day`} type="date" className="input" value={day} onChange={(e) => setDay(e.target.value)} aria-invalid={!!errors.day} />
          </Field>
          <Field label="Holiday name" htmlFor={`${uid}-name`} error={errors.name}>
            <input id={`${uid}-name`} className="input" maxLength={80} value={name} placeholder="e.g. New Year's Day" onChange={(e) => setName(e.target.value)} aria-invalid={!!errors.name} />
          </Field>
          <button type="submit" className="btn-secondary sm:mt-6" disabled={busy !== null}>
            {busy === "add" ? "Adding…" : "Add holiday"}
          </button>
        </form>
      )}
      <ConfirmDialog open={!!removing} title={`Remove ${removing?.name ?? "this holiday"}?`} confirmLabel="Remove holiday" danger busy={busy === "remove"} onConfirm={() => void remove()} onCancel={closeRemove}>
        <p>{removing ? `${fmtDay(removing.day)} becomes a normal working day for pay and attendance. Days in approved payroll can't be changed.` : ""}</p>
      </ConfirmDialog>
    </Panel>
  );
}

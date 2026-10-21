"use client";
/** General and pay cycle: time zone, currency, pay periods, and how attendance is handled (approval, corrections, lateness). */
import { useId, useState, type FormEvent } from "react";
import { isCalendarDay, isCurrencyCode, isTimeZone, localDayOf, PAY_CYCLE_LABEL, PAY_CYCLES, periodContaining, WEEKDAY_LABEL, type PayCycle } from "@app/shared/staff";
import { Panel } from "@/components/dashboard/Primitives";
import { Alert } from "@/components/ui";
import { useToast } from "@/components/AppUi";
import { Field } from "@/components/staff/ui";
import { CurrencySelect, TimeZoneInput } from "@/components/staff/EmployeeForm";
import { actionError, api } from "@/lib/api";
import { fmtSpan, useStaff, type StaffConfig } from "@/lib/staff";
import { intIn, ReadOnlyNote, Toggle } from "@/components/staff/settings/SettingsUi";

type Settings = StaffConfig["settings"];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

export function GeneralSection({ config, onSaved }: { config: StaffConfig; onSaved: (c: StaffConfig) => void }) {
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

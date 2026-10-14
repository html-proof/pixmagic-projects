"use client";
import { useId, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { EMPLOYMENT_TYPE_LABEL, EMPLOYMENT_TYPES, isCalendarDay, isCurrencyCode, isTimeZone, localDayOf, WEEKDAY_LABEL, WEEKDAY_SHORT, type EmploymentType } from "@app/shared/staff";
import { Alert } from "@/components/ui";
import { Field } from "@/components/staff/ui";
import { actionError, api, ApiError } from "@/lib/api";
import { fmtDateTime, useStaff, type EmployeeRow, type StaffConfig } from "@/lib/staff";

// ---------------------------------------------------------------------------------------------
// The employee form (add and edit), and the small pieces the employee pages share: invitation
// links, the time zone and currency pickers, and rate/hours formatting. Rules stay in the API:
// the form checks what it can so people get a friendly message before sending, then shows the
// server's own message for anything else.
// ---------------------------------------------------------------------------------------------

/** What the API takes to add (POST) or change (PATCH) an employee. */
export interface EmployeePayload {
  fullName?: string;
  email?: string;
  phone?: string | null;
  jobTitle?: string;
  departmentId?: string | null;
  departmentName?: string | null;
  employmentType?: EmploymentType;
  joinedOn?: string;
  hourlyRate?: string | null;
  currency?: string;
  standardWeeklyMinutes?: number;
  workingDays?: number[];
  managerUserId?: string | null;
  overtimePolicyId?: string | null;
  breakPolicyId?: string | null;
  timezone?: string;
  status?: "active" | "on_leave";
  notes?: string | null;
}

interface Draft {
  fullName: string;
  email: string;
  phone: string;
  jobTitle: string;
  department: string;
  employmentType: EmploymentType;
  joinedOn: string;
  hourlyRate: string;
  currency: string;
  weeklyHours: string;
  workingDays: number[];
  managerUserId: string;
  overtimePolicyId: string;
  breakPolicyId: string;
  timezone: string;
  status: "active" | "on_leave";
  notes: string;
}
type Errors = Partial<Record<keyof Draft, string>>;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[+0-9 ().-]*$/;
const RATE_RE = /^\d{1,9}(\.\d{1,4})?$/;

/** 2250 minutes -> "37.5". */
export const minutesToHours = (minutes: number) => String(Math.round((minutes / 60) * 100) / 100);

/** "37.5 h a week" (0 means not set: the hours vary). */
export const fmtWeeklyHours = (minutes: number) => (minutes > 0 ? `${minutesToHours(minutes)} h a week` : "Not set (hours vary)");

/** An hourly rate from the API ("20.375") as money per hour, keeping every decimal it has. */
export function fmtRate(rate: string | null | undefined, currency: string | null | undefined) {
  if (rate === null || rate === undefined || !currency) return "—";
  const places = rate.split(".")[1]?.length ?? 0;
  try {
    return `${new Intl.NumberFormat(undefined, { style: "currency", currency, minimumFractionDigits: places, maximumFractionDigits: places }).format(rate as unknown as number)}/h`;
  } catch {
    return `${rate} ${currency}/h`;
  }
}

/** Working days in the organization's week order: "Mon, Tue, Wed". */
export function fmtWorkingDays(days: number[], weekStartsOn: number) {
  if (!days.length) return "None set";
  return weekOrder(weekStartsOn)
    .filter((d) => days.includes(d))
    .map((d) => WEEKDAY_SHORT[d])
    .join(", ");
}

/** 0..6 starting from `weekStartsOn`. */
export const weekOrder = (weekStartsOn: number) => Array.from({ length: 7 }, (_, i) => (weekStartsOn + i) % 7);

function initialDraft(config: StaffConfig, employee: EmployeeRow | null | undefined): Draft {
  const s = config.settings;
  if (!employee) {
    return {
      fullName: "",
      email: "",
      phone: "",
      jobTitle: "",
      department: "",
      employmentType: "full_time",
      joinedOn: localDayOf(Date.now(), s.timezone),
      hourlyRate: "",
      currency: s.currency,
      weeklyHours: "",
      workingDays: [1, 2, 3, 4, 5],
      managerUserId: "",
      overtimePolicyId: s.defaultOvertimePolicyId ?? "",
      breakPolicyId: s.defaultBreakPolicyId ?? "",
      timezone: s.timezone,
      status: "active",
      notes: "",
    };
  }
  return {
    fullName: employee.fullName,
    email: employee.email,
    phone: employee.phone ?? "",
    jobTitle: employee.jobTitle,
    department: employee.department?.name ?? "",
    employmentType: employee.employmentType,
    joinedOn: employee.joinedOn,
    hourlyRate: "",
    currency: employee.currency,
    weeklyHours: employee.standardWeeklyMinutes > 0 ? minutesToHours(employee.standardWeeklyMinutes) : "",
    workingDays: [...employee.workingDays],
    managerUserId: employee.manager?.userId ?? "",
    overtimePolicyId: employee.overtimePolicyId ?? "",
    breakPolicyId: employee.breakPolicyId ?? "",
    timezone: employee.timezone,
    status: employee.status === "on_leave" ? "on_leave" : "active",
    notes: employee.notes ?? "",
  };
}

function validate(d: Draft, withRate: boolean): Errors {
  const e: Errors = {};
  if (!d.fullName.trim()) e.fullName = "Enter the employee's full name.";
  else if (d.fullName.trim().length > 120) e.fullName = "Keep the name under 120 characters.";
  if (!d.email.trim()) e.email = "Enter the email address the invitation goes to.";
  else if (!EMAIL_RE.test(d.email.trim()) || d.email.trim().length > 254) e.email = "That doesn't look like an email address. Check it and try again.";
  if (d.phone.trim().length > 40 || !PHONE_RE.test(d.phone.trim())) e.phone = "Use digits, spaces and + ( ) - only.";
  if (!d.jobTitle.trim()) e.jobTitle = "Enter their job title or position, like Barista or Store manager.";
  else if (d.jobTitle.trim().length > 80) e.jobTitle = "Keep the job title under 80 characters.";
  if (d.department.trim().length > 80) e.department = "Keep the department name under 80 characters.";
  if (!isCalendarDay(d.joinedOn)) e.joinedOn = "Choose the day they started (or will start).";
  if (withRate && d.hourlyRate.trim() && !RATE_RE.test(d.hourlyRate.trim())) e.hourlyRate = "Enter the rate as a number, like 20 or 20.50 (no currency sign).";
  if (!isCurrencyCode(d.currency)) e.currency = "Choose a currency from the list.";
  const hours = Number(d.weeklyHours);
  if (d.weeklyHours.trim() !== "" && (!Number.isFinite(hours) || hours < 0 || hours > 168)) e.weeklyHours = "Enter a number of hours from 0 to 168, like 38 or 37.5, or leave it empty.";
  if (!isTimeZone(d.timezone.trim())) e.timezone = "Choose a time zone from the list, like Australia/Sydney.";
  if (d.notes.length > 2000) e.notes = "Keep notes under 2,000 characters.";
  return e;
}

/** Department typed or picked: an existing one by id, a new one by name, or none. */
function departmentPayload(value: string, config: StaffConfig): Pick<EmployeePayload, "departmentId" | "departmentName"> {
  const name = value.trim();
  if (!name) return { departmentId: null };
  const match = config.departments.find((d) => d.name.trim().toLowerCase() === name.toLowerCase());
  return match ? { departmentId: match.id } : { departmentName: name };
}

function toPayload(d: Draft, config: StaffConfig, withRate: boolean): EmployeePayload {
  return {
    fullName: d.fullName.trim(),
    email: d.email.trim(),
    phone: d.phone.trim() || null,
    jobTitle: d.jobTitle.trim(),
    ...departmentPayload(d.department, config),
    employmentType: d.employmentType,
    joinedOn: d.joinedOn,
    ...(withRate ? { hourlyRate: d.hourlyRate.trim() || null } : {}),
    currency: d.currency,
    // Empty means the hours vary (stored as 0).
    standardWeeklyMinutes: d.weeklyHours.trim() === "" ? 0 : Math.round(Number(d.weeklyHours) * 60),
    workingDays: [...d.workingDays].sort((a, b) => a - b),
    managerUserId: d.managerUserId || null,
    overtimePolicyId: d.overtimePolicyId || null,
    breakPolicyId: d.breakPolicyId || null,
    timezone: d.timezone.trim(),
    status: d.status,
    notes: d.notes.trim() || null,
  };
}

/** Only what changed, so the employee's history says exactly what was edited. */
function changesFrom(employee: EmployeeRow, next: EmployeePayload): EmployeePayload {
  const out: EmployeePayload = {};
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  if (!same(next.fullName, employee.fullName)) out.fullName = next.fullName;
  if (next.email?.toLowerCase() !== employee.email.toLowerCase()) out.email = next.email;
  if (!same(next.phone, employee.phone)) out.phone = next.phone;
  if (!same(next.jobTitle, employee.jobTitle)) out.jobTitle = next.jobTitle;
  if (next.departmentName) out.departmentName = next.departmentName;
  else if (!same(next.departmentId, employee.department?.id)) out.departmentId = next.departmentId;
  if (next.employmentType !== employee.employmentType) out.employmentType = next.employmentType;
  if (next.joinedOn !== employee.joinedOn) out.joinedOn = next.joinedOn;
  if (next.currency !== employee.currency) out.currency = next.currency;
  if (next.standardWeeklyMinutes !== employee.standardWeeklyMinutes) out.standardWeeklyMinutes = next.standardWeeklyMinutes;
  if (!same(next.workingDays, [...employee.workingDays].sort((a, b) => a - b))) out.workingDays = next.workingDays;
  if (!same(next.managerUserId, employee.manager?.userId)) out.managerUserId = next.managerUserId;
  if (!same(next.overtimePolicyId, employee.overtimePolicyId)) out.overtimePolicyId = next.overtimePolicyId;
  if (!same(next.breakPolicyId, employee.breakPolicyId)) out.breakPolicyId = next.breakPolicyId;
  if (next.timezone !== employee.timezone) out.timezone = next.timezone;
  // A deactivated employee's status changes only by reactivating them.
  if (employee.status !== "inactive" && next.status !== employee.status) out.status = next.status;
  if (!same(next.notes, employee.notes)) out.notes = next.notes;
  return out;
}

/** Server errors that belong to one field, shown under it instead of at the top. */
const FIELD_OF_CODE: Record<string, keyof Draft> = {
  email_taken: "email",
  email_locked: "email",
  invalid_department: "department",
  invalid_timezone: "timezone",
  invalid_currency: "currency",
  currency_locked: "currency",
  invalid_rate: "hourlyRate",
  invalid_date: "joinedOn",
  invalid_days: "workingDays",
  invalid_manager: "managerUserId",
};

/**
 * Add or edit an employee. `employee` given means edit: only changed fields are sent, and the
 * hourly rate is left out (rates are a dated history, changed from the employee's page).
 */
export function EmployeeForm({
  config,
  employee,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  config: StaffConfig;
  employee?: EmployeeRow | null;
  submitLabel: string;
  onSubmit: (payload: EmployeePayload) => Promise<void>;
  onCancel?: () => void;
}) {
  const { can } = useStaff();
  const editing = !!employee;
  const withRate = !editing && can("pay:manage");
  const [draft, setDraft] = useState<Draft>(() => initialDraft(config, employee));
  const [errors, setErrors] = useState<Errors>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const uid = useId();
  const id = (k: string) => `${uid}-${k}`;
  const deptListId = id("dept-list");

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    setDraft((d) => ({ ...d, [k]: v }));
    if (errors[k]) setErrors((e) => ({ ...e, [k]: undefined }));
  };

  const deptName = draft.department.trim();
  const newDepartment = !!deptName && !config.departments.some((d) => d.name.trim().toLowerCase() === deptName.toLowerCase());
  const inactive = employee?.status === "inactive";

  async function submit(e: FormEvent) {
    e.preventDefault();
    setProblem(null);
    const found = validate(draft, withRate);
    setErrors(found);
    const first = Object.keys(found)[0];
    if (first) {
      document.getElementById(id(first))?.focus();
      return;
    }
    const full = toPayload(draft, config, withRate);
    const payload = employee ? changesFrom(employee, full) : full;
    if (employee && !Object.keys(payload).length) {
      setProblem("Nothing has changed yet. Edit a field, then save.");
      return;
    }
    setBusy(true);
    try {
      await onSubmit(payload);
    } catch (err) {
      const field = err instanceof ApiError ? FIELD_OF_CODE[err.code] : undefined;
      if (field) {
        setErrors((x) => ({ ...x, [field]: err instanceof Error ? err.message : String(err) }));
        document.getElementById(id(field))?.focus();
      } else {
        setProblem(actionError(err, "save the employee"));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="space-y-6" aria-label={editing ? "Edit employee" : "Add employee"}>
      <p className="rounded-lg border border-border bg-bg px-3 py-2 text-sm text-muted">
        {employee ? (
          <>
            Employee ID: <span className="font-medium text-text">{employee.employeeNumber}</span>
          </>
        ) : (
          "Employee ID will be generated automatically"
        )}
      </p>

      <Section title="Personal details">
        <Field label="Full name" htmlFor={id("fullName")} error={errors.fullName}>
          <input id={id("fullName")} className="input" value={draft.fullName} maxLength={120} autoComplete="off" onChange={(e) => set("fullName", e.target.value)} aria-invalid={!!errors.fullName} aria-required />
        </Field>
        <Field
          label="Email address"
          htmlFor={id("email")}
          error={errors.email}
          hint={employee?.account === "active" ? "They already have an account, so this can't change: they sign in with this address." : "Their invitation is sent here, and they sign in with it."}
        >
          <input
            id={id("email")}
            type="email"
            className="input"
            value={draft.email}
            maxLength={254}
            autoComplete="off"
            disabled={employee?.account === "active"}
            onChange={(e) => set("email", e.target.value)}
            aria-invalid={!!errors.email}
            aria-required
          />
        </Field>
        <Field label="Phone number (optional)" htmlFor={id("phone")} error={errors.phone}>
          <input id={id("phone")} type="tel" className="input" value={draft.phone} maxLength={40} autoComplete="off" onChange={(e) => set("phone", e.target.value)} aria-invalid={!!errors.phone} />
        </Field>
      </Section>

      <Section title="Job">
        <Field label="Job title / position" htmlFor={id("jobTitle")} error={errors.jobTitle}>
          <input id={id("jobTitle")} className="input" value={draft.jobTitle} maxLength={80} onChange={(e) => set("jobTitle", e.target.value)} aria-invalid={!!errors.jobTitle} aria-required />
        </Field>
        <Field
          label="Department"
          htmlFor={id("department")}
          error={errors.department}
          hint={newDepartment ? `"${deptName}" is new: it will be added as a department when you save.` : config.departments.length ? "Pick one from the list, type a new name, or leave it empty." : "Type a name to create your first department, or leave it empty."}
        >
          <input
            id={id("department")}
            className="input"
            list={deptListId}
            value={draft.department}
            maxLength={80}
            autoComplete="off"
            placeholder={config.departments.length ? "Choose or type a department" : "e.g. Kitchen"}
            onChange={(e) => set("department", e.target.value)}
            aria-invalid={!!errors.department}
          />
          <datalist id={deptListId}>
            {config.departments.map((d) => (
              <option key={d.id} value={d.name} />
            ))}
          </datalist>
        </Field>
        <Field label="Employment type" htmlFor={id("employmentType")}>
          <select id={id("employmentType")} className="input" value={draft.employmentType} onChange={(e) => set("employmentType", e.target.value as EmploymentType)}>
            {EMPLOYMENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {EMPLOYMENT_TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Joining date" htmlFor={id("joinedOn")} error={errors.joinedOn}>
          <input id={id("joinedOn")} type="date" className="input" value={draft.joinedOn} onChange={(e) => set("joinedOn", e.target.value)} aria-invalid={!!errors.joinedOn} aria-required />
        </Field>
        <Field label="Employment status" htmlFor={id("status")} hint={inactive ? "Deactivated. Reactivate them from their page to change this." : "People on leave aren't counted as absent when they don't clock in."}>
          <select id={id("status")} className="input" value={inactive ? "inactive" : draft.status} disabled={inactive} onChange={(e) => set("status", e.target.value as Draft["status"])}>
            {inactive && <option value="inactive">Deactivated</option>}
            <option value="active">Active</option>
            <option value="on_leave">On leave</option>
          </select>
        </Field>
        <Field label="Assigned manager" htmlFor={id("managerUserId")} error={errors.managerUserId} hint="Supervisors only see the people assigned to them.">
          <select id={id("managerUserId")} className="input" value={draft.managerUserId} onChange={(e) => set("managerUserId", e.target.value)}>
            <option value="">No manager</option>
            {employee?.manager && !config.managers.some((m) => m.userId === employee.manager?.userId) && <option value={employee.manager.userId}>{employee.manager.name} (no longer a member)</option>}
            {config.managers.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.name}
                {m.name !== m.email ? ` (${m.email})` : ""}
              </option>
            ))}
          </select>
        </Field>
      </Section>

      <Section title="Pay and hours">
        {withRate && (
          <Field label="Hourly rate" htmlFor={id("hourlyRate")} error={errors.hourlyRate} hint="Optional. It applies from the joining date; you can change it any time later.">
            <input
              id={id("hourlyRate")}
              className="input"
              inputMode="decimal"
              value={draft.hourlyRate}
              placeholder="e.g. 25.50"
              onChange={(e) => set("hourlyRate", e.target.value)}
              aria-invalid={!!errors.hourlyRate}
            />
          </Field>
        )}
        {editing && can("pay:view") && (
          <div className="rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted sm:col-span-2">
            Hourly rates are kept as a dated history. Change them with <span className="font-medium text-text">Change pay rate</span> on the employee&apos;s Overview.
          </div>
        )}
        <Field label="Currency" htmlFor={id("currency")} error={errors.currency} hint={editing ? "Can't change once they've been included in a payroll." : "The currency they're paid in."}>
          <CurrencySelect id={id("currency")} value={draft.currency} onChange={(v) => set("currency", v)} />
        </Field>
        <Field label="Standard weekly hours" htmlFor={id("weeklyHours")} error={errors.weeklyHours} hint="Their usual hours a week, like 38 or 37.5. Leave empty if it varies.">
          <input
            id={id("weeklyHours")}
            type="number"
            className="input"
            inputMode="decimal"
            min={0}
            max={168}
            step="any"
            value={draft.weeklyHours}
            onChange={(e) => set("weeklyHours", e.target.value)}
            aria-invalid={!!errors.weeklyHours}
          />
        </Field>
        <div className="sm:col-span-2">
          <WeekdayPicker
            id={id("workingDays")}
            legend="Working days"
            value={draft.workingDays}
            weekStartsOn={config.settings.weekStartsOn}
            onChange={(v) => set("workingDays", v)}
            hint="The days they normally work."
            error={errors.workingDays}
          />
        </div>
        <Field label="Overtime policy" htmlFor={id("overtimePolicyId")} hint={config.overtimePolicies.length ? "How hours beyond the usual are paid." : "No overtime policies yet: add them in Staff settings."}>
          <select id={id("overtimePolicyId")} className="input" value={draft.overtimePolicyId} onChange={(e) => set("overtimePolicyId", e.target.value)}>
            <option value="">No overtime</option>
            {config.overtimePolicies.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Break policy" htmlFor={id("breakPolicyId")} hint="Which breaks are paid, and how many and how long they can be.">
          <select id={id("breakPolicyId")} className="input" value={draft.breakPolicyId} onChange={(e) => set("breakPolicyId", e.target.value)}>
            <option value="">None (short breaks paid, meal breaks unpaid)</option>
            {config.breakPolicies.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Time zone" htmlFor={id("timezone")} error={errors.timezone} hint="Where they work. Start typing a city, like Sydney or London.">
          <TimeZoneInput id={id("timezone")} value={draft.timezone} onChange={(v) => set("timezone", v)} invalid={!!errors.timezone} />
        </Field>
      </Section>

      <Section title="Notes">
        <div className="sm:col-span-2">
          <Field label="Notes (optional)" htmlFor={id("notes")} error={errors.notes} hint="Only managers see these.">
            <textarea id={id("notes")} className="input min-h-20" value={draft.notes} maxLength={2000} onChange={(e) => set("notes", e.target.value)} aria-invalid={!!errors.notes} />
          </Field>
        </div>
      </Section>

      {problem && <Alert>{problem}</Alert>}
      {Object.values(errors).some(Boolean) && <p className="text-sm text-danger">Some details need another look. They&apos;re marked above.</p>}

      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? "Saving…" : submitLabel}
        </button>
        {onCancel && (
          <button type="button" className="btn-secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="space-y-3">
      <legend className="mb-2 text-sm font-semibold">{title}</legend>
      <div className="grid gap-4 sm:grid-cols-2">{children}</div>
    </fieldset>
  );
}

/** Seven day chips (0 = Sunday), in the organization's week order. */
export function WeekdayPicker({
  id,
  legend,
  value,
  weekStartsOn,
  onChange,
  hint,
  error,
  disabled = false,
}: {
  id?: string;
  legend: string;
  value: number[];
  weekStartsOn: number;
  onChange: (days: number[]) => void;
  hint?: string;
  error?: string;
  disabled?: boolean;
}) {
  return (
    <fieldset id={id} tabIndex={-1} disabled={disabled}>
      <legend className="label">{legend}</legend>
      <div className="flex flex-wrap gap-2">
        {weekOrder(weekStartsOn).map((d) => {
          const on = value.includes(d);
          return (
            <button
              key={d}
              type="button"
              aria-pressed={on}
              aria-label={WEEKDAY_LABEL[d]}
              onClick={() => onChange(on ? value.filter((x) => x !== d) : [...value, d].sort((a, b) => a - b))}
              className={`min-w-12 rounded-full border px-3 py-1.5 text-sm transition disabled:opacity-50 ${on ? "border-accent bg-accent text-accent-ink" : "border-border bg-surface text-muted hover:text-text"}`}
            >
              {WEEKDAY_SHORT[d]}
            </button>
          );
        })}
      </div>
      {error ? <p className="mt-1 text-xs text-danger">{error}</p> : hint ? <p className="mt-1 text-xs text-muted">{hint}</p> : null}
    </fieldset>
  );
}

let zoneCache: string[] | null = null;
/** IANA zones this browser knows ("UTC" included: browsers' lists leave it out). */
export function timeZones(): string[] {
  if (zoneCache) return zoneCache;
  let known: string[] = [];
  try {
    known = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  } catch {
    known = [];
  }
  zoneCache = [...new Set(["UTC", ...known])];
  return zoneCache;
}

/** A time zone: type to search the browser's list, or type any IANA name. */
export function TimeZoneInput({ id, value, onChange, invalid = false, disabled = false }: { id: string; value: string; onChange: (v: string) => void; invalid?: boolean; disabled?: boolean }) {
  const listId = `${id}-list`;
  const zones = useMemo(() => timeZones(), []);
  return (
    <>
      <input id={id} className="input" list={zones.length > 1 ? listId : undefined} value={value} maxLength={64} autoComplete="off" spellCheck={false} disabled={disabled} onChange={(e) => onChange(e.target.value)} aria-invalid={invalid} placeholder="e.g. Australia/Sydney" />
      {zones.length > 1 && (
        <datalist id={listId}>
          {zones.map((z) => (
            <option key={z} value={z} />
          ))}
        </datalist>
      )}
    </>
  );
}

let currencyCache: Array<{ code: string; name: string }> | null = null;
function currencies(): Array<{ code: string; name: string }> {
  if (currencyCache) return currencyCache;
  let codes: string[] = [];
  try {
    codes = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("currency") : [];
  } catch {
    codes = [];
  }
  let names: Intl.DisplayNames | null = null;
  try {
    names = new Intl.DisplayNames(undefined, { type: "currency" });
  } catch {
    names = null;
  }
  currencyCache = codes.filter(isCurrencyCode).map((code) => ({ code, name: names?.of(code) ?? code }));
  return currencyCache;
}

/** A currency: the browser's list when it has one, otherwise a three-letter code. */
export function CurrencySelect({ id, value, onChange, disabled = false }: { id: string; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const list = useMemo(() => currencies(), []);
  if (!list.length) {
    return <input id={id} className="input uppercase" value={value} maxLength={3} disabled={disabled} onChange={(e) => onChange(e.target.value.toUpperCase())} placeholder="e.g. AUD" autoComplete="off" />;
  }
  const options = list.some((c) => c.code === value) || !value ? list : [{ code: value, name: value }, ...list];
  return (
    <select id={id} className="input" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      {options.map((c) => (
        <option key={c.code} value={c.code}>
          {c.code} — {c.name}
        </option>
      ))}
    </select>
  );
}

// ---------------------------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------------------------

/** POST .../invitations answer. `url` only when the inviter is meant to have the link. */
export interface InviteResult {
  invitationId: string;
  emailed: boolean;
  expiresAt: string;
  url?: string;
}

/** A link the inviter now holds, and why they have it. */
export interface SharedLink {
  url: string;
  expiresAt: string;
  why: "copied" | "copy" | "email_failed";
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Email an invitation, or make a link to share (copied to the clipboard when the browser allows).
 * Returns the link to show when there is one: asked for, or the email didn't go out.
 */
export async function inviteEmployee(base: string, employeeId: string, delivery: "email" | "link"): Promise<{ result: InviteResult; link: SharedLink | null }> {
  const result = await api<InviteResult>(`${base}/employees/${employeeId}/invitations`, { method: "POST", body: { delivery } });
  if (!result.url) return { result, link: null };
  if (delivery === "email") return { result, link: { url: result.url, expiresAt: result.expiresAt, why: "email_failed" } };
  const copied = await copyText(result.url);
  return { result, link: { url: result.url, expiresAt: result.expiresAt, why: copied ? "copied" : "copy" } };
}

/** The invitation link the inviter now holds, with what it does and doesn't do. */
export function InvitationLinkPanel({ link, name, timeZone, onDismiss }: { link: SharedLink; name: string; timeZone: string; onDismiss?: () => void }) {
  const uid = useId();
  const [copied, setCopied] = useState(link.why === "copied");
  const title = link.why === "email_failed" ? "The invitation email didn't go out" : link.why === "copied" ? "Invitation link copied" : "Invitation link ready";
  return (
    <div className={`rounded-lg border px-4 py-3 ${link.why === "email_failed" ? "border-warn/60" : "border-border"} bg-bg/60`} role="status">
      <div className="flex items-start justify-between gap-3">
        <p className="font-medium">{title}</p>
        {onDismiss && (
          <button type="button" className="text-sm text-muted hover:text-text" onClick={onDismiss} aria-label="Hide the invitation link">
            ×
          </button>
        )}
      </div>
      <p className="mt-1 text-sm text-muted">
        {link.why === "email_failed"
          ? `We couldn't send the email just now. The invitation is ready, so you can share this link with ${name} yourself (for example by text message), or try sending the email again later.`
          : link.why === "copied"
            ? `It's on your clipboard. Send it to ${name} yourself, for example by text message.`
            : `Copy the link below and send it to ${name} yourself, for example by text message.`}
      </p>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <label htmlFor={`${uid}-url`} className="sr-only">
          Invitation link
        </label>
        <input id={`${uid}-url`} className="input font-mono text-xs" readOnly value={link.url} onFocus={(e) => e.currentTarget.select()} />
        <button
          type="button"
          className="btn-secondary shrink-0"
          onClick={() => {
            void copyText(link.url).then((ok) => setCopied(ok));
          }}
        >
          {copied ? "Copied" : "Copy link"}
        </button>
      </div>
      <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-muted">
        <li>The link works once and expires {fmtDateTime(link.expiresAt, timeZone)}.</li>
        <li>Sending another invitation or making a new link replaces this one, so only the newest link works.</li>
        <li>Because you&apos;re sharing it yourself, {name} will need to confirm their email address after creating the account.</li>
        <li>Don&apos;t post it anywhere public: anyone with the link could set up the account.</li>
      </ul>
    </div>
  );
}

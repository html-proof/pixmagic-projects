"use client";
/** The Overview tab: details, today's attendance, pay rates and recent activity. */
import { useCallback, useId, useState, type FormEvent, type ReactNode } from "react";
import { EMPLOYMENT_TYPE_LABEL, isCalendarDay, localDayOf, type LiveStatus } from "@app/shared/staff";
import { Panel } from "@/components/dashboard/Primitives";
import { Alert } from "@/components/ui";
import { ConfirmDialog, useAction, useToast } from "@/components/AppUi";
import { Field, LiveBadge, Modal } from "@/components/staff/ui";
import { fmtRate, fmtWeeklyHours, fmtWorkingDays } from "@/components/staff/EmployeeForm";
import { actionError, api, friendlyError, useLiveApi } from "@/lib/api";
import { fmtDateTime, fmtDay, fmtHours, fmtMoney, fmtTime, useStaff, type EmployeeRow, type StaffConfig } from "@/lib/staff";
import { RecentActivity } from "@/components/staff/employee/AuditTab";

const enc = encodeURIComponent;

interface LiveRow {
  employee: { id: string; fullName: string; employeeNumber: string };
  status: LiveStatus;
  clockInAt: string | null;
  clockOutAt: string | null;
  onBreakSince: string | null;
  breakSeconds: number;
  workedSeconds: number;
  overtimeSeconds: number;
  lateToday: boolean;
  scheduled: boolean;
  pendingCorrections: number;
  currency?: string;
  estimatedEarnings?: string;
  rateMissing?: boolean;
}
interface LiveBoard {
  day: string;
  holiday: { name: string } | null;
  rows: LiveRow[];
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-0.5 break-words text-sm">{children}</dd>
    </div>
  );
}

export function OverviewTab({ employee, config, onChanged, onShowAudit }: { employee: EmployeeRow; config: StaffConfig; onChanged: (e: EmployeeRow) => void; onShowAudit: () => void }) {
  const { can } = useStaff();
  const s = config.settings;
  const overtime = config.overtimePolicies.find((p) => p.id === employee.overtimePolicyId);
  const breaks = config.breakPolicies.find((p) => p.id === employee.breakPolicyId);
  const showPay = can("pay:view") && "hourlyRate" in employee;
  return (
    <div className="space-y-5">
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Panel id="employee-details" title="Details">
            <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
              <Detail label="Employee ID">{employee.employeeNumber}</Detail>
              <Detail label="Email address">{employee.email}</Detail>
              <Detail label="Phone number">{employee.phone || <span className="text-muted">Not given</span>}</Detail>
              <Detail label="Job title / position">{employee.jobTitle}</Detail>
              <Detail label="Department">{employee.department?.name ?? <span className="text-muted">None</span>}</Detail>
              <Detail label="Employment type">{EMPLOYMENT_TYPE_LABEL[employee.employmentType]}</Detail>
              <Detail label="Joining date">{fmtDay(employee.joinedOn)}</Detail>
              <Detail label="Assigned manager">{employee.manager?.name ?? <span className="text-muted">No manager</span>}</Detail>
              <Detail label="Standard weekly hours">{fmtWeeklyHours(employee.standardWeeklyMinutes)}</Detail>
              <Detail label="Working days">{fmtWorkingDays(employee.workingDays, s.weekStartsOn)}</Detail>
              <Detail label="Overtime policy">{overtime?.name ?? "No overtime"}</Detail>
              <Detail label="Break policy">{breaks?.name ?? "None (short breaks paid, meal breaks unpaid)"}</Detail>
              <Detail label="Time zone">{employee.timezone}</Detail>
              <Detail label="Currency">{employee.currency}</Detail>
              {employee.accountLinkedAt && <Detail label="Account set up">{fmtDateTime(employee.accountLinkedAt, s.timezone)}</Detail>}
              <Detail label="Added">{fmtDateTime(employee.createdAt, s.timezone)}</Detail>
              {employee.notes && (
                <div className="sm:col-span-2">
                  <Detail label="Notes">
                    <span className="whitespace-pre-wrap">{employee.notes}</span>
                  </Detail>
                </div>
              )}
            </dl>
          </Panel>
        </div>
        <div className="space-y-5">
          {can("attendance:view") && <TodayCard employee={employee} config={config} />}
          {showPay && (
            <Panel id="employee-rate" title="Hourly rate">
              {employee.hourlyRate ? (
                <>
                  <p className="text-2xl font-semibold tabular-nums">{fmtRate(employee.hourlyRate, employee.currency)}</p>
                  {employee.rateEffectiveFrom && <p className="mt-1 text-xs text-muted">Since {fmtDay(employee.rateEffectiveFrom)}</p>}
                </>
              ) : (
                <p className="text-sm text-muted">No pay rate in force yet. Hours worked without a rate aren&apos;t paid until one is set.</p>
              )}
            </Panel>
          )}
        </div>
      </div>
      {showPay && <PayRatesCard employee={employee} config={config} onChanged={onChanged} />}
      <RecentActivity employee={employee} config={config} onShowAll={onShowAudit} />
    </div>
  );
}

function TodayCard({ employee, config }: { employee: EmployeeRow; config: StaffConfig }) {
  const { base } = useStaff();
  const tz = config.settings.timezone;
  const live = useLiveApi<LiveBoard>(employee.status === "inactive" ? null : `${base}/attendance/live?q=${enc(employee.employeeNumber)}`, 60_000);
  const row = live.data?.rows.find((r) => r.employee.id === employee.id) ?? null;
  return (
    <Panel id="employee-today" title="Today" help={live.data?.holiday ? `Public holiday: ${live.data.holiday.name}` : undefined}>
      {employee.status === "inactive" ? (
        <p className="text-sm text-muted">Deactivated employees can&apos;t clock in.</p>
      ) : live.error && !live.data ? (
        <p className="text-sm text-muted">We couldn&apos;t load today&apos;s attendance. {friendlyError(live.error)}</p>
      ) : !live.data ? (
        <div className="skeleton h-16" aria-busy="true" aria-label="Loading" />
      ) : !row ? (
        <p className="text-sm text-muted">No attendance to show for today.</p>
      ) : (
        <div className="space-y-3">
          <LiveBadge status={row.status} />
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <Detail label="Clocked in">{row.clockInAt ? fmtTime(row.clockInAt, tz) : "—"}</Detail>
            <Detail label="Clocked out">{row.clockOutAt ? fmtTime(row.clockOutAt, tz) : row.clockInAt ? "Still working" : "—"}</Detail>
            <Detail label="Worked today">{fmtHours(row.workedSeconds)}</Detail>
            <Detail label="Unpaid breaks">{fmtHours(row.breakSeconds)}</Detail>
            {row.overtimeSeconds > 0 && <Detail label="Overtime">{fmtHours(row.overtimeSeconds)}</Detail>}
            {row.onBreakSince && <Detail label="On break since">{fmtTime(row.onBreakSince, tz)}</Detail>}
            {row.estimatedEarnings !== undefined && <Detail label="Estimated earnings today">{fmtMoney(row.estimatedEarnings, row.currency)}</Detail>}
          </dl>
          {row.lateToday && <p className="text-xs text-warn">Started late today.</p>}
          {row.pendingCorrections > 0 && <p className="text-xs text-warn">{row.pendingCorrections === 1 ? "1 correction request is" : `${row.pendingCorrections} correction requests are`} waiting for review.</p>}
          {row.rateMissing && <p className="text-xs text-warn">Some of today&apos;s hours have no pay rate, so they aren&apos;t in the estimate.</p>}
          {row.estimatedEarnings !== undefined && <p className="text-[11px] text-muted">Estimated gross pay from recorded hours, before approval, tax and deductions.</p>}
        </div>
      )}
    </Panel>
  );
}

const RATE_RE = /^\d{1,9}(\.\d{1,4})?$/;

function PayRatesCard({ employee, config, onChanged }: { employee: EmployeeRow; config: StaffConfig; onChanged: (e: EmployeeRow) => void }) {
  const { base, can } = useStaff();
  const { busy, run } = useAction();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const closeAdd = useCallback(() => setAdding(false), []);
  const closeRemove = useCallback(() => setRemoving(null), []);
  const today = localDayOf(Date.now(), config.settings.timezone);
  const rates = employee.payRates ?? [];
  const manage = can("pay:manage");
  const target = rates.find((r) => r.id === removing) ?? null;

  const remove = () =>
    run("remove", "remove the pay rate", async () => {
      if (!target) return;
      const { employee: next } = await api<{ employee: EmployeeRow }>(`${base}/employees/${enc(employee.id)}/pay-rates/${enc(target.id)}`, { method: "DELETE" });
      onChanged(next);
      setRemoving(null);
      return "Pay rate removed.";
    });

  return (
    <Panel
      id="employee-pay-rates"
      title="Pay rates"
      help="Each rate applies from its start day until the next one starts. Approved payroll never changes."
      aside={
        manage && (
          <button type="button" className="btn-secondary" onClick={() => setAdding(true)}>
            Change pay rate
          </button>
        )
      }
    >
      {rates.length === 0 ? (
        <p className="text-sm text-muted">No pay rates yet.{manage ? " Use Change pay rate to set their hourly rate." : ""}</p>
      ) : (
        <ul className="divide-y divide-border">
          {rates.map((r) => {
            const current = r.effectiveFrom === employee.rateEffectiveFrom;
            const future = r.effectiveFrom > today;
            return (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 font-medium tabular-nums">
                    {fmtRate(r.hourlyRate, r.currency)}
                    {current && <span className="rounded-full bg-good/12 px-2 py-0.5 text-[11px] font-normal text-good">Current</span>}
                    {future && <span className="rounded-full bg-border/60 px-2 py-0.5 text-[11px] font-normal text-muted">Upcoming</span>}
                  </p>
                  <p className="text-xs text-muted">
                    From {fmtDay(r.effectiveFrom)}
                    {r.reason ? ` · ${r.reason}` : ""}
                  </p>
                </div>
                {manage && (
                  <button type="button" className="text-sm text-muted underline-offset-2 hover:text-danger hover:underline" onClick={() => setRemoving(r.id)}>
                    Remove
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <Modal open={adding} title="Change pay rate" onClose={closeAdd}>
        <PayRateForm
          key={String(adding)}
          employee={employee}
          today={today}
          onSaved={(e) => {
            setAdding(false);
            onChanged(e);
          }}
          onCancel={closeAdd}
        />
      </Modal>
      <ConfirmDialog open={!!target} title="Remove this pay rate?" confirmLabel="Remove rate" danger busy={busy === "remove"} onConfirm={() => void remove()} onCancel={closeRemove}>
        {target && (
          <p>
            {fmtRate(target.hourlyRate, target.currency)} from {fmtDay(target.effectiveFrom)}. Use this for a rate entered by mistake: hours on those days will use the rate before it. A rate that approved payroll has already used can&apos;t be removed.
          </p>
        )}
      </ConfirmDialog>
    </Panel>
  );
}

function PayRateForm({ employee, today, onSaved, onCancel }: { employee: EmployeeRow; today: string; onSaved: (e: EmployeeRow) => void; onCancel: () => void }) {
  const { base } = useStaff();
  const toast = useToast();
  const uid = useId();
  const [rate, setRate] = useState("");
  const [from, setFrom] = useState(today);
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<{ rate?: string; from?: string; reason?: string }>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setProblem(null);
    const found: typeof errors = {};
    if (!RATE_RE.test(rate.trim())) found.rate = "Enter the rate as a number, like 25 or 25.50 (no currency sign).";
    if (!isCalendarDay(from)) found.from = "Choose the day the new rate starts.";
    if (reason.length > 200) found.reason = "Keep the reason under 200 characters.";
    setErrors(found);
    if (Object.keys(found).length) return;
    setBusy(true);
    try {
      const { employee: next } = await api<{ employee: EmployeeRow }>(`${base}/employees/${enc(employee.id)}/pay-rates`, {
        method: "POST",
        body: { hourlyRate: rate.trim(), effectiveFrom: from, reason: reason.trim() || null },
      });
      toast("success", "Pay rate saved.");
      onSaved(next);
    } catch (err) {
      setProblem(actionError(err, "save the pay rate"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="space-y-4">
      <p className="text-sm text-muted">
        The new rate is used for hours worked from the day it starts. Earlier hours keep the rate that applied then, and payroll that&apos;s already approved never changes. To correct pay that&apos;s
        already approved, add an adjustment to the next payroll.
      </p>
      <Field label={`New hourly rate (${employee.currency})`} htmlFor={`${uid}-rate`} error={errors.rate} required>
        <input id={`${uid}-rate`} className="input" inputMode="decimal" value={rate} placeholder="e.g. 27.50" onChange={(e) => setRate(e.target.value)} aria-invalid={!!errors.rate} />
      </Field>
      <Field label="Starts on" htmlFor={`${uid}-from`} error={errors.from} required hint="Can be in the past (back pay in the next payroll) or the future.">
        <input id={`${uid}-from`} type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} aria-invalid={!!errors.from} />
      </Field>
      <Field label="Reason (optional)" htmlFor={`${uid}-reason`} error={errors.reason} hint="For example: Annual review, or New position.">
        <input id={`${uid}-reason`} className="input" maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      {problem && <Alert>{problem}</Alert>}
      <div className="flex flex-wrap gap-2">
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? "Saving…" : "Save pay rate"}
        </button>
        <button type="button" className="btn-secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}

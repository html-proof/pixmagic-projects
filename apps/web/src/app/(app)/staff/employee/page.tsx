"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useId, useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  BREAK_KIND_LABEL,
  BREAK_KINDS,
  daysInclusive,
  EMPLOYMENT_TYPE_LABEL,
  endOfMonth,
  isCalendarDay,
  localDayOf,
  PAYMENT_METHOD_LABEL,
  resolveRange,
  shiftDay,
  startOfMonth,
  startOfWeek,
  WEEKDAY_SHORT,
  type BreakKind,
  type LiveStatus,
  type PaymentMethod,
  type PaymentStatus,
  type RangePreset,
} from "@app/shared/staff";
import { Panel } from "@/components/dashboard/primitives";
import { LoadError } from "@/components/LoadError";
import { Alert, EmptyState } from "@/components/ui";
import { ConfirmDialog, Skeleton, useAction, useToast } from "@/components/whatsapp/common";
import {
  AccountBadge,
  ApprovalBadge,
  EmployeeStatusBadge,
  EstimateNote,
  Field,
  Figure,
  Flags,
  LiveBadge,
  Modal,
  Pagination,
  PaymentBadge,
  RangeFilter,
  rangeReady,
  Table,
  Tabs,
  Td,
  Th,
  type RangeValue,
} from "@/components/staff/ui";
import { EmployeeForm, fmtRate, fmtWeeklyHours, fmtWorkingDays, InvitationLinkPanel, inviteEmployee, weekOrder, type EmployeePayload, type SharedLink } from "@/components/staff/EmployeeForm";
import { actionError, api, ApiError, friendlyError, useApi, useLiveApi } from "@/lib/api";
import { exportFile, fmtDateTime, fmtDay, fmtHours, fmtHoursDec, fmtMoney, fmtSpan, fmtTime, fromLocalInput, toLocalInput, useStaff, type EmployeeRow, type SessionRow, type StaffConfig } from "@/lib/staff";

// ---------------------------------------------------------------------------------------------
// One employee: who they are, what they're doing now, their hours, pay and history. Everything
// comes from the API; this page only arranges it. Tabs the member may not see aren't offered.
// ---------------------------------------------------------------------------------------------

type TabId = "overview" | "attendance" | "timesheets" | "payroll" | "payments" | "schedule" | "audit";
const TAB_LABEL: Record<TabId, string> = {
  overview: "Overview",
  attendance: "Attendance",
  timesheets: "Timesheets",
  payroll: "Payroll",
  payments: "Payment History",
  schedule: "Schedule",
  audit: "Audit History",
};

interface TimesheetList {
  timezone: string;
  total: number;
  page: number;
  pageSize: number;
  pendingCorrections: number;
  items: SessionRow[];
}

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

interface ScheduleItem {
  id: string;
  employeeId: string;
  day: string;
  startsAt: string;
  endsAt: string;
  breakMinutes: number;
  plannedSeconds: number;
  location: string | null;
  note: string | null;
}

interface AuditItem {
  id: string;
  action: string;
  actor: string;
  metadata: Record<string, unknown> | null;
  at: string;
}

interface PaymentItem {
  id: string;
  amount: string;
  currency: string;
  paidOn: string;
  method: PaymentMethod;
  reference: string | null;
  remarks: string | null;
  status: PaymentStatus;
  statusReason: string | null;
  recordedBy: string | null;
  allocations: Array<{ payrollItemId: string; amount: string; period: { id: string; from: string; to: string; status: string }; itemNet: string; itemOutstanding: string }>;
}
interface PaymentList {
  total: number;
  page: number;
  pageSize: number;
  totals: Array<{ currency: string; status: PaymentStatus; count: number; amount: string }>;
  items: PaymentItem[];
}

interface ReportTable {
  columns: Array<{ key: string; label: string; kind: "text" | "hours" | "money" | "count" }>;
  rows: Array<Record<string, string | number | null>>;
  totals: Record<string, string | number | null> | null;
  notes: string[];
}

const enc = encodeURIComponent;

export default function EmployeePage() {
  return (
    <Suspense fallback={<Skeleton lines={6} />}>
      <EmployeeDetail />
    </Suspense>
  );
}

function EmployeeDetail() {
  const params = useSearchParams();
  const router = useRouter();
  const id = params.get("id") ?? "";
  const { base, can } = useStaff();
  const emp = useApi<{ employee: EmployeeRow }>(id ? `${base}/employees/${enc(id)}` : null);
  const config = useApi<StaffConfig>(`${base}/config`);
  // Bumped after every change, so the history shown with it is asked for again.
  const [version, setVersion] = useState(0);

  const tabs = useMemo(() => {
    const out: Array<readonly [TabId, string]> = [["overview", TAB_LABEL.overview]];
    if (can("attendance:view")) out.push(["attendance", TAB_LABEL.attendance], ["timesheets", TAB_LABEL.timesheets]);
    if (can("pay:view")) out.push(["payroll", TAB_LABEL.payroll], ["payments", TAB_LABEL.payments]);
    out.push(["schedule", TAB_LABEL.schedule], ["audit", TAB_LABEL.audit]);
    return out;
  }, [can]);
  const asked = params.get("tab") as TabId | null;
  const tab: TabId = asked && tabs.some(([t]) => t === asked) ? asked : "overview";
  const setTab = (t: TabId) => router.replace(`/staff/employee?id=${enc(id)}${t === "overview" ? "" : `&tab=${t}`}`, { scroll: false });

  const { setData, reload } = emp;
  const changed = useCallback(
    (employee: EmployeeRow) => {
      setData({ employee });
      setVersion((v) => v + 1);
    },
    [setData],
  );
  const refresh = useCallback(async () => {
    await reload();
    setVersion((v) => v + 1);
  }, [reload]);

  if (!id) {
    return (
      <EmptyState
        title="Choose an employee"
        body="Open someone from the employee list to see their details, hours and pay."
        action={
          <Link href="/staff/employees" className="btn-secondary">
            All employees
          </Link>
        }
      />
    );
  }
  if (emp.error instanceof ApiError && emp.error.status === 404) {
    return (
      <EmptyState
        title="We couldn't find that employee"
        body="They may be in another workspace, or assigned to a different manager. Check the employee list."
        action={
          <Link href="/staff/employees" className="btn-secondary">
            All employees
          </Link>
        }
      />
    );
  }
  if (emp.error) return <LoadError what="this employee" error={emp.error} onRetry={() => void emp.reload()} busy={emp.loading} />;
  if (config.error) return <LoadError what="your staff settings" error={config.error} onRetry={() => void config.reload()} busy={config.loading} />;
  if (!emp.data || !config.data) return <Skeleton lines={8} />;

  const employee = emp.data.employee;
  const cfg = config.data;
  return (
    <>
      <EmployeeHeader employee={employee} config={cfg} onChanged={changed} onRefresh={refresh} onConfigStale={() => void config.reload()} />
      <section className="card animate-rise">
        <Tabs tabs={tabs} value={tab} onChange={setTab} label="Employee sections" />
        <div className="mt-5" role="tabpanel" aria-label={TAB_LABEL[tab]}>
          {tab === "overview" && <OverviewTab key={version} employee={employee} config={cfg} onChanged={changed} onShowAudit={() => setTab("audit")} />}
          {tab === "attendance" && <AttendanceTab employee={employee} config={cfg} />}
          {tab === "timesheets" && <TimesheetsTab employee={employee} config={cfg} />}
          {tab === "payroll" && <PayrollTab employee={employee} config={cfg} />}
          {tab === "payments" && <PaymentsTab employee={employee} config={cfg} />}
          {tab === "schedule" && <ScheduleTab employee={employee} config={cfg} />}
          {tab === "audit" && <AuditTab key={version} employee={employee} config={cfg} />}
        </div>
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Header and its actions
// ---------------------------------------------------------------------------------------------

function EmployeeHeader({
  employee,
  config,
  onChanged,
  onRefresh,
  onConfigStale,
}: {
  employee: EmployeeRow;
  config: StaffConfig;
  onChanged: (e: EmployeeRow) => void;
  onRefresh: () => Promise<void>;
  onConfigStale: () => void;
}) {
  const { base, can } = useStaff();
  const toast = useToast();
  const { busy, run } = useAction();
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState<null | "deactivate" | "reactivate" | "revoke">(null);
  const [reason, setReason] = useState("");
  const [link, setLink] = useState<SharedLink | null>(null);
  const closeEdit = useCallback(() => setEditing(false), []);
  const closeConfirm = useCallback(() => setConfirm(null), []);
  const uid = useId();
  const tz = config.settings.timezone;
  const manage = can("staff:manage");
  const inactive = employee.status === "inactive";
  const canInvite = manage && !inactive && employee.account !== "active";
  const firstName = employee.fullName.split(/\s+/)[0] || employee.fullName;
  const url = `${base}/employees/${enc(employee.id)}`;

  const save = async (payload: EmployeePayload) => {
    const { employee: next } = await api<{ employee: EmployeeRow }>(url, { method: "PATCH", body: payload });
    onChanged(next);
    if (payload.departmentName) onConfigStale();
    setEditing(false);
    toast("success", "Changes saved.");
  };

  const invite = (delivery: "email" | "link") =>
    run(delivery, delivery === "email" ? "send the invitation" : "create the invitation link", async () => {
      const { result, link: shared } = await inviteEmployee(base, employee.id, delivery);
      setLink(shared);
      await onRefresh();
      if (delivery === "email") return result.emailed ? `Invitation sent to ${employee.email}. It expires ${fmtDateTime(result.expiresAt, tz)}.` : undefined;
      return shared?.why === "copied" ? "Invitation link copied." : undefined;
    });

  const act = (kind: "deactivate" | "reactivate" | "revoke") =>
    run(kind, kind === "deactivate" ? "deactivate this employee" : kind === "reactivate" ? "reactivate this employee" : "revoke the invitation", async () => {
      if (kind === "revoke") {
        await api(`${url}/invitations/revoke`, { method: "POST", body: {} });
        setLink(null);
        await onRefresh();
        setConfirm(null);
        return "Invitation revoked. The link no longer works.";
      }
      const { employee: next } = await api<{ employee: EmployeeRow }>(`${url}/${kind}`, { method: "POST", body: kind === "deactivate" ? { reason: reason.trim() || null } : {} });
      onChanged(next);
      setConfirm(null);
      setReason("");
      if (kind === "deactivate") setLink(null);
      return kind === "deactivate" ? `${employee.fullName} is deactivated.` : `${employee.fullName} is active again.`;
    });

  const inv = employee.invitation;
  return (
    <section className="card animate-rise">
      <Link href="/staff/employees" className="text-xs text-muted hover:text-text">
        ← All employees
      </Link>
      <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold">{employee.fullName}</h1>
          <p className="mt-0.5 text-sm text-muted">
            <span className="font-medium text-text">{employee.employeeNumber}</span> · {employee.jobTitle}
            {employee.department ? ` · ${employee.department.name}` : ""}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <EmployeeStatusBadge status={employee.status} />
            <AccountBadge account={employee.account} />
          </div>
          {inactive && (
            <p className="mt-2 text-xs text-muted">
              Deactivated {employee.deactivatedAt ? fmtDateTime(employee.deactivatedAt, tz) : ""}
              {employee.deactivationReason ? `: ${employee.deactivationReason}` : "."} Their records are kept.
            </p>
          )}
          {!inactive && employee.account !== "active" && inv && !inv.acceptedAt && !inv.revokedAt && (
            <p className="mt-2 text-xs text-muted">
              Invitation {inv.emailed ? "emailed" : "link made"} {fmtDateTime(inv.sentAt, tz)} ·{" "}
              {employee.account === "expired" ? `expired ${fmtDateTime(inv.expiresAt, tz)}` : `expires ${fmtDateTime(inv.expiresAt, tz)}`}
              {inv.emailFailed && <span className="text-warn"> · the email didn&apos;t go out</span>}
            </p>
          )}
        </div>
        {manage && (
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-secondary" onClick={() => setEditing(true)}>
              Edit
            </button>
            {canInvite && (
              <>
                <button type="button" className="btn-secondary" disabled={busy !== null} onClick={() => void invite("email")}>
                  {busy === "email" ? "Sending…" : employee.account === "not_invited" ? "Send invitation" : "Resend invitation"}
                </button>
                <button type="button" className="btn-secondary" disabled={busy !== null} onClick={() => void invite("link")}>
                  {busy === "link" ? "Creating link…" : "Copy invitation link"}
                </button>
              </>
            )}
            {manage && !inactive && employee.account === "invited" && (
              <button type="button" className="btn-secondary" disabled={busy !== null} onClick={() => setConfirm("revoke")}>
                Revoke invitation
              </button>
            )}
            {inactive ? (
              <button type="button" className="btn-primary" disabled={busy !== null} onClick={() => setConfirm("reactivate")}>
                Reactivate
              </button>
            ) : (
              <button type="button" className="btn-danger" disabled={busy !== null} onClick={() => setConfirm("deactivate")}>
                Deactivate
              </button>
            )}
          </div>
        )}
      </div>
      {link && (
        <div className="mt-4">
          <InvitationLinkPanel key={link.url} link={link} name={firstName} timeZone={tz} onDismiss={() => setLink(null)} />
        </div>
      )}

      <Modal open={editing} title={`Edit ${employee.fullName}`} onClose={closeEdit} wide>
        <EmployeeForm key={`${employee.id}-${editing}`} config={config} employee={employee} submitLabel="Save changes" onSubmit={save} onCancel={closeEdit} />
      </Modal>

      <ConfirmDialog
        open={confirm === "deactivate"}
        title={`Deactivate ${employee.fullName}?`}
        confirmLabel="Deactivate"
        danger
        busy={busy === "deactivate"}
        onConfirm={() => void act("deactivate")}
        onCancel={closeConfirm}
      >
        <p>They won&apos;t be able to clock in, and any invitation they haven&apos;t used stops working.</p>
        <p>If they&apos;re clocked in right now, that shift is closed at this moment and flagged for you to check.</p>
        <p>Their hours, payroll and payment records are kept, and you can reactivate them later.</p>
        <div className="pt-1">
          <label htmlFor={`${uid}-reason`} className="label text-text">
            Reason (optional)
          </label>
          <textarea id={`${uid}-reason`} className="input min-h-16" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: Left the business" />
        </div>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === "reactivate"}
        title={`Reactivate ${employee.fullName}?`}
        confirmLabel="Reactivate"
        busy={busy === "reactivate"}
        onConfirm={() => void act("reactivate")}
        onCancel={closeConfirm}
      >
        <p>They&apos;ll be able to clock in again.</p>
        {employee.account !== "active" && <p>They don&apos;t have an account yet: send them a new invitation once they&apos;re active.</p>}
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === "revoke"}
        title="Revoke the invitation?"
        confirmLabel="Revoke invitation"
        danger
        busy={busy === "revoke"}
        onConfirm={() => void act("revoke")}
        onCancel={closeConfirm}
      >
        <p>The link {firstName} was sent stops working straight away. You can send a new invitation at any time.</p>
      </ConfirmDialog>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------------------------

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-0.5 break-words text-sm">{children}</dd>
    </div>
  );
}

function OverviewTab({ employee, config, onChanged, onShowAudit }: { employee: EmployeeRow; config: StaffConfig; onChanged: (e: EmployeeRow) => void; onShowAudit: () => void }) {
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

// ---------------------------------------------------------------------------------------------
// History (recent activity on the Overview, all of it on Audit History)
// ---------------------------------------------------------------------------------------------

const ACTION_LABEL: Record<string, string> = {
  "staff.employee_created": "Employee added",
  "staff.employee_updated": "Details changed",
  "staff.employee_deactivated": "Deactivated",
  "staff.employee_reactivated": "Reactivated",
  "staff.pay_rate_set": "Pay rate changed",
  "staff.pay_rate_deleted": "Pay rate removed",
  "staff.invitation_sent": "Invitation emailed",
  "staff.invitation_link_created": "Invitation link created",
  "staff.invitation_revoked": "Invitation revoked",
  "staff.account_activated": "Employee account set up",
  "staff.schedule_created": "Shifts scheduled",
  "staff.shift_added": "Missing shift added",
  "staff.shift_corrected": "Shift corrected",
  "staff.hours_rejected": "Hours rejected",
  "staff.hours_approved": "Hours approved",
  "staff.correction_requested": "Correction requested",
  "staff.correction_approved": "Correction approved",
  "staff.correction_rejected": "Correction rejected",
  "payroll.payment_recorded": "Payment recorded",
  "payroll.payment_failed": "Payment marked as failed",
  "payroll.payment_reversed": "Payment reversed",
};

const FIELD_LABEL: Record<string, string> = {
  fullName: "name",
  email: "email address",
  phone: "phone number",
  jobTitle: "job title",
  department: "department",
  employmentType: "employment type",
  joinedOn: "joining date",
  currency: "currency",
  standardWeeklyMinutes: "weekly hours",
  workingDays: "working days",
  manager: "manager",
  overtimePolicy: "overtime policy",
  breakPolicy: "break policy",
  timezone: "time zone",
  status: "status",
  notes: "notes",
};

/** "staff.something_new" -> "Something new". */
function humanize(action: string) {
  const tail = action.split(".").pop() ?? action;
  const words = tail.replace(/_/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : action;
}

const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : null);

function auditDetail(a: AuditItem, tz: string): string | null {
  const m = a.metadata ?? {};
  switch (a.action) {
    case "staff.employee_created":
      return [str(m.employeeNumber) && `Employee ID ${str(m.employeeNumber)}`, m.rateSet ? "with a starting pay rate" : null].filter(Boolean).join(", ") || null;
    case "staff.employee_updated": {
      const fields = Array.isArray(m.fields) ? (m.fields as unknown[]).map((f) => FIELD_LABEL[String(f)] ?? String(f)) : [];
      return fields.length ? `Changed: ${fields.join(", ")}` : null;
    }
    case "staff.employee_deactivated":
      return str(m.reason) ? `Reason: ${str(m.reason)}` : null;
    case "staff.pay_rate_set":
      return str(m.effectiveFrom) ? `Starts ${fmtDay(str(m.effectiveFrom))}` : null;
    case "staff.invitation_sent":
      if (m.emailed === false) return "The email didn't go out, so the link was shown instead.";
      return str(m.expiresAt) ? `Expires ${fmtDateTime(str(m.expiresAt), tz)}` : null;
    case "staff.invitation_link_created":
      return str(m.expiresAt) ? `Expires ${fmtDateTime(str(m.expiresAt), tz)}` : null;
    case "staff.schedule_created": {
      const n = Number(m.shifts);
      return Number.isFinite(n) && n > 0 ? `${n} ${n === 1 ? "shift" : "shifts"}` : null;
    }
    case "payroll.payment_recorded": {
      const method = str(m.method);
      return [str(m.amount) && fmtMoney(str(m.amount), str(m.currency)), method && `by ${(PAYMENT_METHOD_LABEL[method as PaymentMethod] ?? method).toLowerCase()}`].filter(Boolean).join(" ") || null;
    }
    case "payroll.payment_failed":
    case "payroll.payment_reversed":
      return str(m.reason) ? `Reason: ${str(m.reason)}` : null;
    default:
      return null;
  }
}

function AuditList({ items, tz }: { items: AuditItem[]; tz: string }) {
  return (
    <ol className="space-y-0">
      {items.map((a) => {
        const detail = auditDetail(a, tz);
        return (
          <li key={a.id} className="relative border-l border-border py-2 pl-4">
            <span aria-hidden className="absolute -left-[5px] top-3.5 h-2.5 w-2.5 rounded-full border-2 border-surface bg-accent" />
            <p className="text-sm font-medium">{ACTION_LABEL[a.action] ?? humanize(a.action)}</p>
            {detail && <p className="text-sm text-muted">{detail}</p>}
            <p className="text-xs text-muted">
              {a.actor} · {fmtDateTime(a.at, tz)}
            </p>
          </li>
        );
      })}
    </ol>
  );
}

function RecentActivity({ employee, config, onShowAll }: { employee: EmployeeRow; config: StaffConfig; onShowAll: () => void }) {
  const { base } = useStaff();
  const audit = useApi<{ items: AuditItem[] }>(`${base}/employees/${enc(employee.id)}/audit`);
  return (
    <Panel
      id="employee-recent"
      title="Recent activity"
      aside={
        audit.data && audit.data.items.length > 5 ? (
          <button type="button" className="text-sm text-accent underline-offset-2 hover:underline" onClick={onShowAll}>
            See all
          </button>
        ) : undefined
      }
    >
      {audit.error ? (
        <LoadError what="recent activity" error={audit.error} onRetry={() => void audit.reload()} busy={audit.loading} />
      ) : !audit.data ? (
        <div className="skeleton h-12" aria-busy="true" aria-label="Loading" />
      ) : audit.data.items.length === 0 ? (
        <p className="text-sm text-muted">Nothing yet.</p>
      ) : (
        <AuditList items={audit.data.items.slice(0, 5)} tz={config.settings.timezone} />
      )}
    </Panel>
  );
}

function AuditTab({ employee, config }: { employee: EmployeeRow; config: StaffConfig }) {
  const { base, can } = useStaff();
  const audit = useApi<{ items: AuditItem[] }>(`${base}/employees/${enc(employee.id)}/audit`);
  if (audit.error) return <LoadError what="the audit history" error={audit.error} onRetry={() => void audit.reload()} busy={audit.loading} />;
  if (!audit.data) return <div className="skeleton h-24" aria-busy="true" aria-label="Loading" />;
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        Every change to {employee.fullName}&apos;s record{can("pay:view") ? " and pay" : ""}, newest first, with who made it. Times are in {config.settings.timezone}.
      </p>
      {audit.data.items.length === 0 ? <p className="text-sm text-muted">Nothing recorded yet.</p> : <AuditList items={audit.data.items} tz={config.settings.timezone} />}
      {audit.data.items.length >= 200 && <p className="text-xs text-muted">Showing the latest 200 entries.</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Attendance: a month calendar of worked hours, the shifts, and adding a missed shift
// ---------------------------------------------------------------------------------------------

const monthLabel = (month: string) => new Intl.DateTimeFormat(undefined, { timeZone: "UTC", month: "long", year: "numeric" }).format(new Date(`${month}T00:00:00Z`));

function AttendanceTab({ employee, config }: { employee: EmployeeRow; config: StaffConfig }) {
  const { base, can } = useStaff();
  const tz = config.settings.timezone;
  const today = localDayOf(Date.now(), tz);
  const [month, setMonth] = useState(startOfMonth(today));
  const [adding, setAdding] = useState(false);
  const closeAdd = useCallback(() => setAdding(false), []);
  const from = month;
  const to = endOfMonth(month);
  const ts = useApi<TimesheetList>(`${base}/timesheets?from=${from}&to=${to}&employeeId=${enc(employee.id)}&pageSize=200`);

  const byDay = useMemo(() => {
    const m = new Map<string, { seconds: number; shifts: number; review: boolean }>();
    for (const s of ts.data?.items ?? []) {
      const day = s.day ?? localDayOf(new Date(s.clockInAt).getTime(), tz);
      const cur = m.get(day) ?? { seconds: 0, shifts: 0, review: false };
      cur.seconds += s.workedSeconds;
      cur.shifts += 1;
      cur.review = cur.review || s.needsReview;
      m.set(day, cur);
    }
    return m;
  }, [ts.data, tz]);

  const gridStart = startOfWeek(from, config.settings.weekStartsOn);
  const gridEnd = shiftDay(startOfWeek(to, config.settings.weekStartsOn), 6);
  const days = daysInclusive(gridStart, gridEnd);
  const weeks: string[][] = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));
  const items = ts.data?.items ?? [];
  const total = items.reduce((a, s) => a + s.workedSeconds, 0);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button type="button" className="btn-secondary px-3" onClick={() => setMonth(startOfMonth(shiftDay(month, -1)))} aria-label="Previous month">
            ‹
          </button>
          <h2 className="min-w-36 text-center font-semibold" aria-live="polite">
            {monthLabel(month)}
          </h2>
          <button type="button" className="btn-secondary px-3" onClick={() => setMonth(shiftDay(endOfMonth(month), 1))} aria-label="Next month" disabled={month >= startOfMonth(today)}>
            ›
          </button>
          {month !== startOfMonth(today) && (
            <button type="button" className="text-sm text-accent underline-offset-2 hover:underline" onClick={() => setMonth(startOfMonth(today))}>
              This month
            </button>
          )}
        </div>
        {can("attendance:manage") && employee.status !== "inactive" && (
          <button type="button" className="btn-secondary" onClick={() => setAdding(true)}>
            Add missing shift
          </button>
        )}
      </div>

      {ts.error ? (
        <LoadError what="attendance for this month" error={ts.error} onRetry={() => void ts.reload()} busy={ts.loading} />
      ) : !ts.data ? (
        <div className="skeleton h-64" aria-busy="true" aria-label="Loading" />
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3">
            <Figure label="Hours worked" value={fmtHours(total)} />
            <Figure label="Shifts" value={new Intl.NumberFormat().format(items.length)} />
            <Figure label="Days worked" value={new Intl.NumberFormat().format(byDay.size)} />
          </div>
          <table className="w-full table-fixed border-collapse text-sm" aria-label={`Hours worked in ${monthLabel(month)}`}>
            <thead>
              <tr>
                {weekOrder(config.settings.weekStartsOn).map((d) => (
                  <th key={d} scope="col" className="pb-1 text-center text-xs font-medium text-muted">
                    {WEEKDAY_SHORT[d]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {weeks.map((w) => (
                <tr key={w[0]}>
                  {w.map((d) => {
                    const info = byDay.get(d);
                    const inMonth = d >= from && d <= to;
                    const label = `${fmtDay(d)}: ${info ? `${fmtHours(info.seconds)} worked over ${info.shifts} ${info.shifts === 1 ? "shift" : "shifts"}` : "no hours"}`;
                    return (
                      <td key={d} className="p-0.5 align-top">
                        <div
                          title={label}
                          aria-label={label}
                          className={`flex h-14 flex-col rounded-md border p-1 sm:h-16 sm:p-1.5 ${!inMonth ? "bg-bg opacity-50" : info ? "bg-accent/10" : "bg-surface"} ${d === today ? "border-accent" : "border-border"}`}
                        >
                          <span className={`text-[11px] ${d === today ? "font-semibold text-accent" : "text-muted"}`}>{Number(d.slice(8, 10))}</span>
                          {info && (
                            <span className="mt-auto text-xs font-medium tabular-nums sm:text-sm">
                              {fmtHoursDec(info.seconds)}
                              <span className="text-[10px] font-normal text-muted"> h</span>
                              {info.review && <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-warn align-middle" aria-hidden />}
                            </span>
                          )}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-xs text-muted">
            Hours are counted on the day a shift started, in {tz}. <span className="inline-block h-1.5 w-1.5 rounded-full bg-warn align-middle" aria-hidden /> marks a day with a shift to check.
          </p>
          {ts.data.total > items.length && <Alert kind="info">Showing the first {items.length} of {ts.data.total} shifts this month. Open Timesheets to see them all.</Alert>}

          <div>
            <h3 className="mb-2 text-sm font-semibold">Shifts</h3>
            {items.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted">No shifts recorded in {monthLabel(month)}.</p>
            ) : (
              <ShiftTable items={items} tz={tz} />
            )}
          </div>
        </>
      )}

      <Modal open={adding} title="Add missing shift" onClose={closeAdd} wide>
        <AddShiftForm
          key={String(adding)}
          employee={employee}
          config={config}
          onSaved={(day) => {
            setAdding(false);
            const m = startOfMonth(day);
            if (m !== month) setMonth(m);
            else void ts.reload();
          }}
          onCancel={closeAdd}
        />
      </Modal>
    </div>
  );
}

function ShiftTable({ items, tz }: { items: SessionRow[]; tz: string }) {
  return (
    <Table label="Shifts">
      <thead>
        <tr>
          <Th>Day</Th>
          <Th>Clock in</Th>
          <Th>Clock out</Th>
          <Th>Breaks</Th>
          <Th right>Worked</Th>
          <Th>Status</Th>
          <Th>Notes</Th>
        </tr>
      </thead>
      <tbody>
        {items.map((s) => (
          <tr key={s.id}>
            <Td className="whitespace-nowrap">{fmtDay(s.day ?? localDayOf(new Date(s.clockInAt).getTime(), tz), { weekday: true, year: false })}</Td>
            <Td className="whitespace-nowrap">{fmtTime(s.clockInAt, tz)}</Td>
            <Td className="whitespace-nowrap">{s.clockOutAt ? fmtTime(s.clockOutAt, tz) : <span className="text-warn">Still clocked in</span>}</Td>
            <Td>
              {s.breaks.length === 0 ? (
                <span className="text-muted">None</span>
              ) : (
                <ul className="space-y-0.5 text-xs">
                  {s.breaks.map((b) => (
                    <li key={b.id} className="whitespace-nowrap">
                      {BREAK_KIND_LABEL[b.kind]} {fmtTime(b.startAt, tz)}–{b.endAt ? fmtTime(b.endAt, tz) : "now"}
                      <span className="text-muted"> ({b.paid ? "paid" : "unpaid"})</span>
                    </li>
                  ))}
                </ul>
              )}
            </Td>
            <Td right>{fmtHours(s.workedSeconds)}</Td>
            <Td>{s.open ? <span className="text-xs text-muted">In progress</span> : <ApprovalBadge status={s.approvalStatus} />}</Td>
            <Td>
              <div className="flex flex-col gap-1">
                <Flags flags={s.flags} />
                {s.pendingCorrection && <span className="w-fit rounded-full bg-warn/12 px-2 py-0.5 text-[11px] text-warn">Correction requested</span>}
                {s.rejectedReason && <span className="text-xs text-danger">Rejected: {s.rejectedReason}</span>}
                {s.note && <span className="text-xs text-muted">{s.note}</span>}
              </div>
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

interface BreakDraft {
  key: number;
  kind: BreakKind;
  start: string;
  end: string;
}

const SKEW_MS = 5 * 60_000;

function AddShiftForm({ employee, config, onSaved, onCancel }: { employee: EmployeeRow; config: StaffConfig; onSaved: (day: string) => void; onCancel: () => void }) {
  const { base } = useStaff();
  const toast = useToast();
  const uid = useId();
  const tz = config.settings.timezone;
  const [nowInput] = useState(() => toLocalInput(new Date(), tz));
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [breaks, setBreaks] = useState<BreakDraft[]>([]);
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [seq, setSeq] = useState(1);

  const addBreak = () => {
    setBreaks((b) => [...b, { key: seq, kind: "rest", start: "", end: "" }]);
    setSeq((n) => n + 1);
  };
  const setBreak = (key: number, patch: Partial<BreakDraft>) => setBreaks((b) => b.map((x) => (x.key === key ? { ...x, ...patch } : x)));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setProblem(null);
    const found: Record<string, string> = {};
    const startAt = fromLocalInput(start, tz);
    const endAt = fromLocalInput(end, tz);
    const now = Date.now();
    if (!startAt) found.start = "Enter when the shift started.";
    else if (Date.parse(startAt) > now + SKEW_MS) found.start = "The start can't be in the future.";
    if (!endAt) found.end = "Enter when the shift ended.";
    else if (Date.parse(endAt) > now + SKEW_MS) found.end = "The end can't be in the future.";
    if (startAt && endAt && !found.start && !found.end) {
      const len = Date.parse(endAt) - Date.parse(startAt);
      if (len <= 0) found.end = "The shift has to end after it starts.";
      else if (len > 24 * 3_600_000) found.end = "A shift can't be longer than 24 hours. Add it as two shifts.";
    }
    const outBreaks: Array<{ startAt: string; endAt: string; kind: BreakKind }> = [];
    for (const b of breaks) {
      const bs = fromLocalInput(b.start, tz);
      const be = fromLocalInput(b.end, tz);
      if (!bs || !be) {
        found[`b${b.key}`] = "Enter when this break started and ended, or remove it.";
        continue;
      }
      if (Date.parse(be) <= Date.parse(bs)) found[`b${b.key}`] = "The break has to end after it starts.";
      else if (startAt && endAt && (Date.parse(bs) < Date.parse(startAt) || Date.parse(be) > Date.parse(endAt))) found[`b${b.key}`] = "The break has to be inside the shift.";
      else outBreaks.push({ startAt: bs, endAt: be, kind: b.kind });
    }
    const sorted = [...outBreaks].sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
    if (sorted.some((b, i) => i > 0 && Date.parse(b.startAt) < Date.parse(sorted[i - 1]!.endAt))) found.breaks = "Breaks can't overlap each other.";
    if (note.trim().length < 3) found.note = "Say why this shift is being added, for example: Forgot to clock in.";
    setErrors(found);
    if (Object.keys(found).length || !startAt || !endAt) return;
    setBusy(true);
    try {
      await api(`${base}/employees/${enc(employee.id)}/shifts`, {
        method: "POST",
        body: { clockInAt: startAt, clockOutAt: endAt, ...(sorted.length ? { breaks: sorted } : {}), note: note.trim() },
      });
      toast("success", "Shift added.");
      onSaved(localDayOf(Date.parse(startAt), tz));
    } catch (err) {
      setProblem(actionError(err, "add the shift"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="space-y-4">
      <p className="text-sm text-muted">
        For a shift {employee.fullName} worked but didn&apos;t clock. Times are in {tz}. It&apos;s saved as approved and marked &ldquo;Added by a manager&rdquo;.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Started" htmlFor={`${uid}-start`} error={errors.start} required>
          <input id={`${uid}-start`} type="datetime-local" className="input" max={nowInput} value={start} onChange={(e) => setStart(e.target.value)} aria-invalid={!!errors.start} />
        </Field>
        <Field label="Ended" htmlFor={`${uid}-end`} error={errors.end} required>
          <input id={`${uid}-end`} type="datetime-local" className="input" max={nowInput} min={start || undefined} value={end} onChange={(e) => setEnd(e.target.value)} aria-invalid={!!errors.end} />
        </Field>
      </div>

      <fieldset className="space-y-2">
        <legend className="label">Breaks (optional)</legend>
        {breaks.length === 0 && <p className="text-xs text-muted">No breaks. Add any breaks taken during the shift so unpaid time is taken off.</p>}
        {breaks.map((b, i) => (
          <div key={b.key} className="rounded-lg border border-border p-3">
            <div className="grid gap-3 sm:grid-cols-[10rem_1fr_1fr]">
              <div>
                <label className="label text-xs" htmlFor={`${uid}-bk${b.key}`}>
                  Break {i + 1} type
                </label>
                <select id={`${uid}-bk${b.key}`} className="input" value={b.kind} onChange={(e) => setBreak(b.key, { kind: e.target.value as BreakKind })}>
                  {BREAK_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {BREAK_KIND_LABEL[k]}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label text-xs" htmlFor={`${uid}-bs${b.key}`}>
                  Break {i + 1} started
                </label>
                <input id={`${uid}-bs${b.key}`} type="datetime-local" className="input" min={start || undefined} max={end || nowInput} value={b.start} onChange={(e) => setBreak(b.key, { start: e.target.value })} />
              </div>
              <div>
                <label className="label text-xs" htmlFor={`${uid}-be${b.key}`}>
                  Break {i + 1} ended
                </label>
                <input id={`${uid}-be${b.key}`} type="datetime-local" className="input" min={b.start || start || undefined} max={end || nowInput} value={b.end} onChange={(e) => setBreak(b.key, { end: e.target.value })} />
              </div>
            </div>
            <div className="mt-2 flex items-center justify-between gap-2">
              {errors[`b${b.key}`] ? <p className="text-xs text-danger">{errors[`b${b.key}`]}</p> : <span />}
              <button type="button" className="text-xs text-muted underline-offset-2 hover:text-danger hover:underline" onClick={() => setBreaks((x) => x.filter((y) => y.key !== b.key))}>
                Remove break {i + 1}
              </button>
            </div>
          </div>
        ))}
        {errors.breaks && <p className="text-xs text-danger">{errors.breaks}</p>}
        {breaks.length < 20 && (
          <button type="button" className="btn-secondary px-3 py-1.5" onClick={addBreak}>
            Add a break
          </button>
        )}
      </fieldset>

      <Field label="Reason" htmlFor={`${uid}-note`} error={errors.note} required hint="Kept with the shift's history.">
        <textarea id={`${uid}-note`} className="input min-h-16" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="For example: Forgot to clock in; confirmed with the roster." aria-invalid={!!errors.note} />
      </Field>
      {problem && <Alert>{problem}</Alert>}
      <div className="flex flex-wrap gap-2">
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? "Adding…" : "Add shift"}
        </button>
        <button type="button" className="btn-secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------
// Timesheets
// ---------------------------------------------------------------------------------------------

const TIMESHEET_PRESETS: readonly RangePreset[] = ["this_week", "last_week", "this_month", "last_month", "this_year", "last_year", "custom"];
const TIMESHEET_PAGE = 50;

function TimesheetsTab({ employee, config }: { employee: EmployeeRow; config: StaffConfig }) {
  const { base } = useStaff();
  const tz = config.settings.timezone;
  const today = localDayOf(Date.now(), tz);
  const [range, setRange] = useState<RangeValue>({ preset: "this_month", from: startOfMonth(today), to: today });
  const [paging, setPaging] = useState({ key: "", page: 1 });

  let resolved: { from: string; to: string } | null = null;
  let rangeProblem: string | null = null;
  if (rangeReady(range)) {
    try {
      resolved = resolveRange(range.preset, today, config.settings.weekStartsOn, { from: range.from, to: range.to }).range;
    } catch (e) {
      rangeProblem = (e as Error).message;
    }
  }
  const key = resolved ? `${resolved.from}|${resolved.to}` : "";
  const page = paging.key === key ? paging.page : 1;
  const ts = useApi<TimesheetList>(resolved ? `${base}/timesheets?from=${resolved.from}&to=${resolved.to}&employeeId=${enc(employee.id)}&page=${page}&pageSize=${TIMESHEET_PAGE}` : null);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <RangeFilter value={range} onChange={setRange} presets={TIMESHEET_PRESETS} />
        <Link href={`/staff/timesheets?employeeId=${enc(employee.id)}`} className="btn-secondary">
          Open in Timesheets
        </Link>
      </div>
      {rangeProblem && <Alert>{rangeProblem}</Alert>}
      {ts.error ? (
        <LoadError what="timesheets" error={ts.error} onRetry={() => void ts.reload()} busy={ts.loading} />
      ) : !resolved ? null : !ts.data ? (
        <div className="skeleton h-40" aria-busy="true" aria-label="Loading" />
      ) : ts.data.items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted">No shifts in {fmtSpan(resolved.from, resolved.to)}.</p>
      ) : (
        <>
          <p className="text-sm text-muted">
            {fmtSpan(resolved.from, resolved.to)} · approve, reject or correct hours in Timesheets.
          </p>
          <Table label="Timesheet">
            <thead>
              <tr>
                <Th>Day</Th>
                <Th>Hours</Th>
                <Th right>Worked</Th>
                <Th right>Unpaid breaks</Th>
                <Th>Approval</Th>
                <Th>Flags</Th>
              </tr>
            </thead>
            <tbody>
              {ts.data.items.map((s) => (
                <tr key={s.id}>
                  <Td className="whitespace-nowrap">{fmtDay(s.day ?? localDayOf(new Date(s.clockInAt).getTime(), tz))}</Td>
                  <Td className="whitespace-nowrap">
                    {fmtTime(s.clockInAt, tz)}–{s.clockOutAt ? fmtTime(s.clockOutAt, tz) : "now"}
                  </Td>
                  <Td right>{fmtHours(s.workedSeconds)}</Td>
                  <Td right>{s.unpaidBreakSeconds ? fmtHours(s.unpaidBreakSeconds) : "—"}</Td>
                  <Td>
                    {s.open ? <span className="text-xs text-muted">In progress</span> : <ApprovalBadge status={s.approvalStatus} />}
                    {s.locked && <p className="mt-1 text-[11px] text-muted">In approved payroll</p>}
                  </Td>
                  <Td>
                    <div className="flex flex-col gap-1">
                      <Flags flags={s.flags} />
                      {s.pendingCorrection && <span className="w-fit rounded-full bg-warn/12 px-2 py-0.5 text-[11px] text-warn">Correction requested</span>}
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <Pagination page={ts.data.page} pageSize={ts.data.pageSize} total={ts.data.total} onPage={(p) => setPaging({ key, page: p })} />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Payroll (by pay period) and payment history
// ---------------------------------------------------------------------------------------------

/** Longest custom report range is a little over three years; this stays inside it with a month ahead. */
const PAYROLL_LOOKBACK_DAYS = 3 * 365;
const PERIOD_RE = /^(\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})(?: \((.+)\))?$/;

function reportCell(kind: ReportTable["columns"][number]["kind"], v: string | number | null | undefined, currency: string | null) {
  if (v === null || v === undefined || v === "") return "—";
  if (kind === "hours") return fmtHours(Number(v));
  if (kind === "money") return fmtMoney(String(v), currency);
  if (kind === "count") return new Intl.NumberFormat().format(Number(v));
  return String(v);
}

function PayrollTab({ employee, config }: { employee: EmployeeRow; config: StaffConfig }) {
  const { base } = useStaff();
  const today = localDayOf(Date.now(), config.settings.timezone);
  // Periods are found by their end day: look a month ahead so a period still running is included.
  const to = shiftDay(today, 31);
  const earliest = shiftDay(today, -PAYROLL_LOOKBACK_DAYS);
  const from = employee.joinedOn > to ? to : employee.joinedOn < earliest ? earliest : employee.joinedOn;
  const q = new URLSearchParams({ type: "payroll", groupBy: "period", preset: "custom", from, to, employeeId: employee.id });
  const report = useApi<ReportTable>(`${base}/reports?${q.toString()}`);

  if (report.error) return <LoadError what="this employee's payroll" error={report.error} onRetry={() => void report.reload()} busy={report.loading} />;
  if (!report.data) return <div className="skeleton h-40" aria-busy="true" aria-label="Loading" />;
  const r = report.data;
  const rows = [...r.rows].reverse();
  const currencies = new Set(rows.map((x) => String(x.currency ?? "")));
  const columns = r.columns.filter((c) => c.key !== "group" && !(c.key === "currency" && currencies.size <= 1));
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">
          Pay periods ending {fmtSpan(from, to)}{employee.joinedOn < earliest ? " (the last three years)" : ""}, newest first.
        </p>
        <Link href="/staff/payroll" className="btn-secondary">
          Open Payroll
        </Link>
      </div>
      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted">{employee.fullName} hasn&apos;t been included in a payroll yet.</p>
      ) : (
        <Table label="Payroll by pay period">
          <thead>
            <tr>
              <Th>Pay period</Th>
              {columns.map((c) => (
                <Th key={c.key} right={c.kind !== "text"}>
                  {c.label}
                </Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const label = String(row.group ?? "");
              const m = PERIOD_RE.exec(label);
              const cur = String(row.currency ?? employee.currency);
              return (
                <tr key={`${label}-${i}`}>
                  <Td className="whitespace-nowrap">
                    {m ? (
                      <>
                        <span className="font-medium">{fmtSpan(m[1]!, m[2]!)}</span>
                        {m[3] && <p className="text-xs text-muted">{m[3]}</p>}
                      </>
                    ) : (
                      label
                    )}
                  </Td>
                  {columns.map((c) => (
                    <Td key={c.key} right={c.kind !== "text"} className={c.key === "outstanding" && row.outstanding && Number(row.outstanding) > 0 ? "font-medium text-warn" : ""}>
                      {reportCell(c.kind, row[c.key], cur)}
                    </Td>
                  ))}
                </tr>
              );
            })}
          </tbody>
          {r.totals && rows.length > 1 && (
            <tfoot>
              <tr className="font-semibold">
                <Td>Total</Td>
                {columns.map((c) => (
                  <Td key={c.key} right={c.kind !== "text"}>
                    {c.key === "approved" ? "" : reportCell(c.kind, r.totals?.[c.key], String(r.totals?.currency ?? employee.currency))}
                  </Td>
                ))}
              </tr>
            </tfoot>
          )}
        </Table>
      )}
      {r.notes.length > 0 && (
        <ul className="list-disc space-y-1 pl-5 text-xs text-muted">
          {r.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      <EstimateNote />
    </div>
  );
}

const PAYMENTS_PAGE = 100;

function PaymentsTab({ employee, config }: { employee: EmployeeRow; config: StaffConfig }) {
  const { base, can } = useStaff();
  const { busy, run } = useAction();
  const [page, setPage] = useState(1);
  const list = useApi<PaymentList>(`${base}/payroll/payments?employeeId=${enc(employee.id)}&page=${page}&pageSize=${PAYMENTS_PAGE}`);
  const download = () =>
    run("statement", "download the statement", async () => {
      await exportFile(base, { kind: "statement", employeeId: employee.id, preset: "this_year" });
      return "Statement downloaded.";
    });
  const paid = (list.data?.totals ?? []).filter((t) => t.status === "completed");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-3">
          {paid.map((t) => (
            <Figure key={t.currency} label={`Paid (${t.count} ${t.count === 1 ? "payment" : "payments"})`} value={fmtMoney(t.amount, t.currency)} />
          ))}
        </div>
        {can("staff:export") && (
          <button type="button" className="btn-secondary" disabled={busy !== null} onClick={() => void download()}>
            {busy === "statement" ? "Preparing…" : "Download statement (PDF)"}
          </button>
        )}
      </div>
      {list.error ? (
        <LoadError what="payment history" error={list.error} onRetry={() => void list.reload()} busy={list.loading} />
      ) : !list.data ? (
        <div className="skeleton h-40" aria-busy="true" aria-label="Loading" />
      ) : list.data.items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted">No payments recorded for {employee.fullName} yet. Payments are recorded from approved payroll.</p>
      ) : (
        <>
          <Table label="Payment history">
            <thead>
              <tr>
                <Th>Paid on</Th>
                <Th>Pay period</Th>
                <Th right>Amount</Th>
                <Th>Method</Th>
                <Th>Reference</Th>
                <Th>Status</Th>
                <Th right>Still owed</Th>
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((p) => (
                <tr key={p.id}>
                  <Td className="whitespace-nowrap">{fmtDay(p.paidOn)}</Td>
                  <Td className="whitespace-nowrap">
                    {p.allocations.map((a) => (
                      <p key={a.payrollItemId}>{fmtSpan(a.period.from, a.period.to)}</p>
                    ))}
                  </Td>
                  <Td right>{fmtMoney(p.amount, p.currency)}</Td>
                  <Td>{PAYMENT_METHOD_LABEL[p.method] ?? p.method}</Td>
                  <Td>
                    {p.reference ?? <span className="text-muted">—</span>}
                    {p.remarks && <p className="text-xs text-muted">{p.remarks}</p>}
                  </Td>
                  <Td>
                    <PaymentBadge status={p.status} />
                    {p.statusReason && <p className="mt-1 text-xs text-muted">{p.statusReason}</p>}
                  </Td>
                  <Td right>
                    {p.allocations.map((a) => (
                      <p key={a.payrollItemId} className={Number(a.itemOutstanding) > 0 ? "text-warn" : "text-muted"}>
                        {fmtMoney(a.itemOutstanding, p.currency)}
                      </p>
                    ))}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <Pagination page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPage={setPage} />
          <p className="text-xs text-muted">&ldquo;Still owed&rdquo; is what remains unpaid on that pay period now, after every payment recorded against it. Dates are in {config.settings.timezone}.</p>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Schedule: the next four weeks
// ---------------------------------------------------------------------------------------------

function ScheduleTab({ employee, config }: { employee: EmployeeRow; config: StaffConfig }) {
  const { base } = useStaff();
  const tz = config.settings.timezone;
  const today = localDayOf(Date.now(), tz);
  const to = shiftDay(today, 27);
  const list = useApi<{ timezone: string; items: ScheduleItem[] }>(`${base}/schedules?from=${today}&to=${to}&employeeId=${enc(employee.id)}`);

  const byDay = useMemo(() => {
    const m = new Map<string, ScheduleItem[]>();
    for (const s of list.data?.items ?? []) m.set(s.day, [...(m.get(s.day) ?? []), s]);
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [list.data]);
  const planned = (list.data?.items ?? []).reduce((a, s) => a + s.plannedSeconds, 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">
          Scheduled shifts {fmtSpan(today, to)}
          {list.data && list.data.items.length > 0 ? ` · ${fmtHours(planned)} planned` : ""}. Times in {tz}.
        </p>
        <Link href="/staff/schedules" className="btn-secondary">
          Open shift schedules
        </Link>
      </div>
      {list.error ? (
        <LoadError what="the schedule" error={list.error} onRetry={() => void list.reload()} busy={list.loading} />
      ) : !list.data ? (
        <div className="skeleton h-32" aria-busy="true" aria-label="Loading" />
      ) : byDay.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted">No shifts scheduled for {employee.fullName} in the next four weeks.</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {byDay.map(([day, shifts]) => (
            <li key={day} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-start sm:gap-6">
              <p className={`w-40 shrink-0 text-sm font-medium ${day === today ? "text-accent" : ""}`}>
                {day === today ? "Today · " : ""}
                {fmtDay(day, { weekday: true, year: false })}
              </p>
              <ul className="min-w-0 flex-1 space-y-1">
                {shifts.map((s) => (
                  <li key={s.id} className="text-sm">
                    <span className="font-medium tabular-nums">
                      {fmtTime(s.startsAt, tz)}–{fmtTime(s.endsAt, tz)}
                    </span>
                    {localDayOf(new Date(s.endsAt).getTime() - 1, tz) !== s.day && <span className="text-xs text-muted"> (ends next day)</span>}
                    <span className="text-muted">
                      {" "}
                      · {fmtHours(s.plannedSeconds)}
                      {s.breakMinutes ? ` · ${s.breakMinutes} min unpaid break` : ""}
                      {s.location ? ` · ${s.location}` : ""}
                    </span>
                    {s.note && <p className="text-xs text-muted">{s.note}</p>}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

"use client";
/** History: recent activity on the Overview, all of it on the Audit History tab. */
import { PAYMENT_METHOD_LABEL, type PaymentMethod } from "@app/shared/staff";
import { Panel } from "@/components/dashboard/Primitives";
import { LoadError } from "@/components/LoadError";
import { useApi } from "@/lib/api";
import { fmtDateTime, fmtDay, fmtMoney, useStaff, type EmployeeRow, type StaffConfig } from "@/lib/staff";

const enc = encodeURIComponent;

interface AuditItem {
  id: string;
  action: string;
  actor: string;
  metadata: Record<string, unknown> | null;
  at: string;
}

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

export function RecentActivity({ employee, config, onShowAll }: { employee: EmployeeRow; config: StaffConfig; onShowAll: () => void }) {
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

export function AuditTab({ employee, config }: { employee: EmployeeRow; config: StaffConfig }) {
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

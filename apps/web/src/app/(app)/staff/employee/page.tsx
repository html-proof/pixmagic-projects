"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useMemo, useState } from "react";
import { LoadError } from "@/components/LoadError";
import { EmptyState } from "@/components/ui";
import { Skeleton } from "@/components/AppUi";
import { Tabs } from "@/components/staff/ui";
import { ApiError, useApi } from "@/lib/api";
import { useStaff, type EmployeeRow, type StaffConfig } from "@/lib/staff";
import { EmployeeHeader } from "@/components/staff/employee/EmployeeHeader";
import { OverviewTab } from "@/components/staff/employee/OverviewTab";
import { AuditTab } from "@/components/staff/employee/AuditTab";
import { AttendanceTab } from "@/components/staff/employee/AttendanceTab";
import { TimesheetsTab } from "@/components/staff/employee/TimesheetsTab";
import { PayrollTab } from "@/components/staff/employee/PayrollTab";
import { PaymentsTab } from "@/components/staff/employee/PaymentsTab";
import { ScheduleTab } from "@/components/staff/employee/ScheduleTab";

// One employee: who they are, what they're doing now, their hours, pay and history. Everything
// comes from the API; this page only arranges it. Tabs the member may not see aren't offered.

const enc = encodeURIComponent;

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

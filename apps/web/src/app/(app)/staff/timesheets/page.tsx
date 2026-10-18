"use client";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { LoadError } from "@/components/LoadError";
import { Tabs } from "@/components/staff/ui";
import { PageHeader, Skeleton } from "@/components/AppUi";
import { useApi } from "@/lib/api";
import { useStaff, type StaffConfig } from "@/lib/staff";
import { Shifts } from "@/components/staff/timesheets/ShiftsTab";
import { Requests } from "@/components/staff/timesheets/RequestsTab";

// Timesheets: every shift in a date range, approving, rejecting and correcting hours, setting a
// forgotten clock-out, adding a missed shift, and employees' change requests. Times are shown and
// entered in the organization's time zone.

type Tab = "shifts" | "requests";

export default function TimesheetsPage() {
  return (
    <Suspense fallback={<Skeleton lines={6} />}>
      <Timesheets />
    </Suspense>
  );
}

function Timesheets() {
  const sp = useSearchParams();
  const { base, can } = useStaff();
  const config = useApi<StaffConfig>(`${base}/config`);
  const [tab, setTab] = useState<Tab>(sp.get("tab") === "requests" ? "requests" : "shifts");
  const [pending, setPending] = useState<number | null>(null);
  // Bumped when a change request is decided, so the shift list shows the new times.
  const [bump, setBump] = useState(0);

  const header = (
    <PageHeader
      title="Timesheets"
      sub="Check, correct and approve the hours your team worked. Approved hours go into payroll."
    />
  );
  if (config.error && !config.data) {
    return (
      <>
        {header}
        <LoadError what="your staff settings" error={config.error} onRetry={() => void config.reload()} busy={config.loading} />
      </>
    );
  }
  if (!config.data) {
    return (
      <>
        {header}
        <Skeleton lines={6} />
      </>
    );
  }
  const tz = config.data.settings.timezone;
  return (
    <>
      {header}
      <Tabs<Tab>
        label="Timesheets"
        value={tab}
        onChange={setTab}
        tabs={[
          ["shifts", "Shifts"],
          ["requests", pending ? `Change requests (${pending})` : "Change requests"],
        ]}
      />
      <div hidden={tab !== "shifts"}>
        <Shifts
          base={base}
          tz={tz}
          config={config.data}
          manage={can("attendance:manage")}
          initial={{ employeeId: sp.get("employeeId"), status: sp.get("status"), from: sp.get("from"), to: sp.get("to") }}
          onPending={setPending}
          bump={bump}
        />
      </div>
      <div hidden={tab !== "requests"}>
        <Requests base={base} tz={tz} manage={can("attendance:manage")} onPending={setPending} onChanged={() => setBump((b) => b + 1)} />
      </div>
    </>
  );
}

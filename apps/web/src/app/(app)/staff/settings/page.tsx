"use client";
import { LoadError } from "@/components/LoadError";
import { PageHeader, Skeleton } from "@/components/AppUi";
import { useApi } from "@/lib/api";
import { useStaff, type StaffConfig } from "@/lib/staff";
import { GeneralSection } from "@/components/staff/settings/GeneralSection";
import { DepartmentsSection } from "@/components/staff/settings/DepartmentsSection";
import { OvertimeSection } from "@/components/staff/settings/OvertimeSection";
import { BreakSection } from "@/components/staff/settings/BreakSection";
import { HolidaysSection } from "@/components/staff/settings/HolidaysSection";

// Staff settings: the organization's time zone, currency and pay cycle; departments; overtime and
// break policies; public holidays. Each section saves on its own and is read-only for people who
// may not change it (the API checks the same permissions).

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

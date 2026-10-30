"use client";
import { useState } from "react";
import { useApp } from "@/components/AppContext";
import { CsvButton } from "@/components/dashboard/ReportDownload";
import { saveApiFile } from "@/lib/download";

/**
 * The page's sections as downloads (GET …/analytics/export?part=, GOOGLE_ANALYTICS_PARTS in core's
 * reports/adsExport.ts): each only where the page shows it, the campaigns and recommendations with
 * "View campaigns", the demo store with the demo.
 */
const PARTS: Array<{ id: string; label: string; campaigns?: boolean; demo?: boolean }> = [
  { id: "overview", label: "Overview" },
  { id: "campaigns", label: "Campaigns", campaigns: true },
  { id: "days", label: "Spending and conversions by day" },
  { id: "weeks", label: "Spending and conversions by week" },
  { id: "months", label: "Spending and conversions by month" },
  { id: "devices", label: "Devices" },
  { id: "audience", label: "Audience" },
  { id: "recommendations", label: "Recommendations", campaigns: true },
  { id: "combined", label: "Demo store and ad spend", demo: true },
];

/** A section picked and its CSV, for the dates and account on screen; for whoever may export reports. */
export function AnalyticsDownload({ base, query, campaigns, demo, disabled }: { base: string; query: string; campaigns: boolean; demo: boolean; disabled: boolean }) {
  const { allowed } = useApp();
  const [part, setPart] = useState("overview");
  if (!allowed("reports.export")) return null;
  const parts = PARTS.filter((p) => (!p.campaigns || campaigns) && (!p.demo || demo));
  const picked = parts.some((p) => p.id === part) ? part : "overview";
  return (
    <span className="inline-flex flex-wrap items-center gap-2 print:hidden">
      <label className="flex items-center gap-2 text-xs text-muted">
        Section
        <select className="input h-9 w-auto py-0 text-sm" value={picked} onChange={(e) => setPart(e.target.value)} data-testid="ga-csv-part">
          {parts.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      <CsvButton download={() => saveApiFile(`${base}/analytics/export?${query}&part=${picked}`)} disabled={disabled} tall testid="ga-csv" />
    </span>
  );
}

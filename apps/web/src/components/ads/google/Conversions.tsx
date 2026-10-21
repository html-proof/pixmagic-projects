"use client";
import { useState } from "react";
import type { CampaignAnalytics, ConversionDay } from "@app/shared/adsAnalytics";
import { ChartChoice } from "@/components/dashboard/Primitives";
import { LineChart } from "@/components/dashboard/LineChart";
import { fmtMoneyCompact, fmtSpan } from "@/components/dashboard/format";
import { fmtNum, fmtPct } from "@/lib/api";
import { Quiet, Section, figureWriters } from "./ui";

type Metric = "conversions" | "conversionRate" | "conversionValue" | "costPerConversion";
const METRICS: Array<[Metric, string]> = [
  ["conversions", "Daily conversions"],
  ["conversionRate", "Conversion rate"],
  ["conversionValue", "Conversion value"],
  ["costPerConversion", "Cost per conversion"],
];

/** Section 4: one conversion figure drawn over the days, and the campaigns that convert most. */
export function ConversionsSection({ series, top, currency, demo, today, range }: { series: ConversionDay[]; top: CampaignAnalytics[] | null; currency: string; demo: boolean; today: string; range: { from: string; to: string } }) {
  const [metric, setMetric] = useState<Metric>("conversions");
  const w = figureWriters(currency);
  const kind = metric === "conversionValue" || metric === "costPerConversion" ? "money" : metric === "conversionRate" ? "rate" : "count";
  const format = kind === "money" ? (v: number) => w.money(v) : kind === "rate" ? (v: number) => fmtPct(v) : fmtNum;
  const fmtAxis = kind === "money" ? (v: number, step: number) => (step < 1 ? w.money(v) : fmtMoneyCompact(v, currency)) : kind === "rate" ? (v: number) => fmtPct(v) : (v: number) => new Intl.NumberFormat(undefined, { notation: "compact" }).format(v);
  const values = series.map((d) => d[metric]);
  const empty = values.every((v) => v === null || v === 0);
  const title = METRICS.find(([m]) => m === metric)![1];
  return (
    <Section id="conversions" title="Conversion analytics" help={`${fmtSpan(range.from, range.to)}. A rate on a day without clicks, or a cost on a day without conversions, is left out rather than drawn as 0.`} demo={demo} aside={<ChartChoice label="Conversion figure" value={metric} options={METRICS} onChange={setMetric} />}>
      <div data-testid="ga-conversion-chart" data-metric={metric}>
        {series.length < 2 ? (
          <Quiet>Pick two days or more to draw conversions over time.</Quiet>
        ) : empty ? (
          <Quiet>No conversions in these dates.</Quiet>
        ) : (
          <LineChart days={series.map((d) => d.day)} series={[{ key: metric, label: title, color: "var(--viz-cat-2)", values }]} format={format} fmtAxis={fmtAxis} label={`${title} per day, ${fmtSpan(range.from, range.to)}`} today={today} integer={kind === "count"} />
        )}
      </div>
      {top && (
        <div className="mt-4">
          <h3 className="text-sm font-semibold">Top converting campaigns</h3>
          {top.length === 0 ? (
            <p className="mt-1 text-sm text-muted">No campaign converted in these dates.</p>
          ) : (
            <div className="-mx-1 mt-2 overflow-x-auto">
              <table className="w-full min-w-[36rem] text-sm" data-testid="ga-top-converting">
                <thead className="text-left text-xs text-muted">
                  <tr>
                    <th className="px-1 pb-2 font-normal">Campaign</th>
                    <th className="px-1 pb-2 text-right font-normal">Conversions</th>
                    <th className="px-1 pb-2 text-right font-normal">Conv. rate</th>
                    <th className="px-1 pb-2 text-right font-normal">Conv. value</th>
                    <th className="px-1 pb-2 text-right font-normal">Cost / conv.</th>
                    <th className="px-1 pb-2 text-right font-normal">ROAS</th>
                  </tr>
                </thead>
                <tbody>
                  {top.map((c) => (
                    <tr key={c.id} className="border-t border-border">
                      <td className="px-1 py-2 font-medium">{c.name}</td>
                      <td className="px-1 py-2 text-right tabular-nums">{w.num(c.conversions)}</td>
                      <td className="px-1 py-2 text-right tabular-nums">{w.pct(c.conversionRate)}</td>
                      <td className="px-1 py-2 text-right tabular-nums">{w.money(c.conversionValue)}</td>
                      <td className="px-1 py-2 text-right tabular-nums">{w.money(c.costPerConversion)}</td>
                      <td className="px-1 py-2 text-right tabular-nums">{w.times(c.roas)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </Section>
  );
}

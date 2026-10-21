"use client";
import { useState } from "react";
import { type AdsGranularity, type AdsPeriod, type CampaignAnalytics } from "@app/shared/adsAnalytics";
import { ColumnsWithTotal, type Column } from "@/components/dashboard/ColumnsWithTotal";
import { fmtDay, fmtMonth, fmtMoneyCompact, fmtMoneyWhole, fmtSpan, fmtWeekday } from "@/components/dashboard/format";
import { Quiet, Section, figureWriters } from "./ui";

const GRANULARITY: Array<{ id: AdsGranularity; label: string }> = [
  { id: "day", label: "Daily" },
  { id: "week", label: "Weekly" },
  { id: "month", label: "Monthly" },
];

/** A period's tick on the spending chart. */
function tickOf(p: AdsPeriod, g: AdsGranularity, n: number, today: string): Column["tick"] {
  if (g === "day") return { top: n <= 31 ? String(Number(p.from.slice(8))) : fmtDay(p.from, { year: false }), bottom: p.from === today ? "Today" : fmtWeekday(p.from), strong: p.from === today, major: n <= 31 || p.from.endsWith("-01") };
  if (g === "week") return { top: fmtDay(p.from, { year: false }), bottom: "week", major: true };
  return { top: fmtMonth(p.from.slice(0, 7), { short: true }), major: true };
}

/** Section 3: spend per day, week or month with the running total, the trend, and each campaign's spend against its budget. */
export function SpendingSection({ series, campaigns, currency, demo, today, range }: { series: { day: AdsPeriod[]; week: AdsPeriod[]; month: AdsPeriod[] }; campaigns: CampaignAnalytics[] | null; currency: string; demo: boolean; today: string; range: { from: string; to: string } }) {
  const [g, setG] = useState<AdsGranularity>("day");
  const w = figureWriters(currency);
  const periods = series[g];
  const max = Math.max(0, ...periods.map((p) => p.spend));
  let running = 0;
  const columns: Column[] = periods.map((p) => {
    running = Math.round((running + p.spend) * 100) / 100;
    const current = p.to >= today;
    return { key: p.key, value: p.spend, fill: p.spend === max && max > 0 ? "var(--viz-tier-3)" : "var(--viz-tier-2)", faded: current, running, tick: tickOf(p, g, periods.length, today), label: p.spend ? fmtMoneyWhole(p.spend, currency) : undefined, keepLabel: p.spend === max && max > 0 };
  });
  const total = periods.reduce((a, p) => a + p.spend, 0);
  // The trend: the range's second half against its first.
  const days = series.day;
  const mid = Math.floor(days.length / 2);
  const first = days.slice(0, mid).reduce((a, d) => a + d.spend, 0);
  const second = days.slice(mid).reduce((a, d) => a + d.spend, 0);
  const trend = mid > 0 && first > 0 ? (second - first) / first : null;
  const budgets = (campaigns ?? []).filter((c) => c.budget !== null);
  return (
    <Section
      id="spending"
      title="Spending analytics"
      help={`${fmtSpan(range.from, range.to)}, in ${currency}. The running total below the columns; a period still running is drawn lighter.`}
      demo={demo}
      aside={
        <div role="tablist" aria-label="Spending by" className="inline-flex rounded-lg border border-border p-0.5">
          {GRANULARITY.map((o) => (
            <button key={o.id} type="button" role="tab" aria-selected={g === o.id} className={`rounded-md px-3 py-1 text-xs ${g === o.id ? "bg-surface font-semibold shadow-sm" : "text-muted"}`} onClick={() => setG(o.id)} data-testid={`ga-spend-${o.id}`}>
              {o.label}
            </button>
          ))}
        </div>
      }
    >
      <p className="text-2xl font-semibold tabular-nums" data-testid="ga-spend-total">
        {w.money(total)}
      </p>
      {total === 0 ? (
        <Quiet>No spend in these dates.</Quiet>
      ) : (
        <div data-testid="ga-spend-chart" data-granularity={g}>
          <ColumnsWithTotal
            columns={columns}
            label={`Ad spend per ${g}, ${fmtSpan(range.from, range.to)}, with the running total below`}
            fmtAxis={(v) => fmtMoneyCompact(v, currency)}
            runningLabel="Spent so far"
            fmtRunning={(v) => fmtMoneyWhole(v, currency)}
            tooltip={(i) => {
              const p = periods[i]!;
              return (
                <>
                  <div className="text-muted">{g === "day" ? fmtDay(p.from) : fmtSpan(p.from, p.to)}</div>
                  <div className="mt-0.5 text-sm font-semibold tabular-nums">{w.money(p.spend)} spent</div>
                  <div className="text-muted">
                    {w.num(p.clicks)} clicks · {w.num(p.conversions)} conversions
                  </div>
                </>
              );
            }}
            describe={(i) => {
              const p = periods[i]!;
              return `${g === "day" ? fmtDay(p.from) : fmtSpan(p.from, p.to)}: ${w.money(p.spend)} spent, ${w.num(p.clicks)} clicks, ${w.num(p.conversions)} conversions.`;
            }}
            missingLabel="No data"
          />
        </div>
      )}
      <p className="mt-3 text-sm" data-testid="ga-spend-trend">
        <span className="font-medium">Spending trend: </span>
        {trend === null
          ? "not enough days to compare the two halves of these dates."
          : `the second half of these dates ${trend >= 0 ? "spent" : "spent"} ${w.pct(Math.abs(trend))} ${trend >= 0 ? "more" : "less"} than the first (${w.money(first)} → ${w.money(second)}).`}
      </p>
      {campaigns && (
        <div className="mt-4">
          <h3 className="text-sm font-semibold">Campaign budget comparison</h3>
          <p className="text-xs text-muted">Each campaign&apos;s daily budget over the days it ran in these dates, against what it spent.</p>
          {budgets.length === 0 ? (
            <p className="mt-2 text-sm text-muted">No campaign budgets are known for this account.</p>
          ) : (
            <div className="-mx-1 mt-2 overflow-x-auto">
              <table className="w-full min-w-[40rem] text-sm" data-testid="ga-budget-table">
                <thead className="text-left text-xs text-muted">
                  <tr>
                    <th className="px-1 pb-2 font-normal">Campaign</th>
                    <th className="px-1 pb-2 text-right font-normal">Daily budget</th>
                    <th className="px-1 pb-2 text-right font-normal">Days run</th>
                    <th className="px-1 pb-2 text-right font-normal">Budget for the dates</th>
                    <th className="px-1 pb-2 text-right font-normal">Spent</th>
                    <th className="px-1 pb-2 font-normal">Used</th>
                  </tr>
                </thead>
                <tbody>
                  {budgets.map((c) => (
                    <tr key={c.id} className="border-t border-border">
                      <td className="px-1 py-2 font-medium">{c.name}</td>
                      <td className="px-1 py-2 text-right tabular-nums">{w.money(c.dailyBudget)}</td>
                      <td className="px-1 py-2 text-right tabular-nums">{c.activeDays}</td>
                      <td className="px-1 py-2 text-right tabular-nums">{w.money(c.budget)}</td>
                      <td className="px-1 py-2 text-right tabular-nums">{w.money(c.spend)}</td>
                      <td className="px-1 py-2">
                        <span className="flex items-center gap-2">
                          <span className="h-2 w-24 overflow-hidden rounded-full bg-border/60" aria-hidden>
                            <span className={`block h-full rounded-full ${(c.budgetUse ?? 0) > 1 ? "bg-warn" : "bg-[var(--viz-cat-2)]"}`} style={{ width: `${Math.min(100, (c.budgetUse ?? 0) * 100)}%` }} />
                          </span>
                          <span className="tabular-nums text-xs text-muted">{w.pct(c.budgetUse)}</span>
                        </span>
                      </td>
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

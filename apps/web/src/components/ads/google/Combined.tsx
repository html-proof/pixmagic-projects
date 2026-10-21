"use client";
import type { AdsPeriod, CampaignAnalytics } from "@app/shared/adsAnalytics";
import type { DemoStoreDay, DemoStoreTotals } from "@app/shared/adsDemo";
import { LineChart, type LineSeries } from "@/components/dashboard/LineChart";
import { Stat } from "@/components/dashboard/Primitives";
import { fmtMoneyCompact, fmtSpan, fmtTimes } from "@/components/dashboard/format";
import { fmtNum } from "@/lib/api";
import { DemoDataBadge, Quiet, Section, figureWriters } from "./ui";

/**
 * The combined demonstration: the demo's spend next to a simulated store (modeled attribution), as a
 * real account's spend sits next to the real store on the dashboard. Only ever simulated figures on
 * both sides; every chart says so.
 */
export function CombinedSection({ days, totals, note, campaigns, daily, currency, today, range }: { days: DemoStoreDay[]; totals: DemoStoreTotals; note: string; campaigns: CampaignAnalytics[] | null; daily: AdsPeriod[]; currency: string; today: string; range: { from: string; to: string } }) {
  const w = figureWriters(currency);
  const dates = days.map((d) => d.day);
  const money = (v: number) => w.money(v);
  const axis = (v: number, step: number) => (step < 1 ? w.money(v) : fmtMoneyCompact(v, currency));
  const compact = (v: number) => new Intl.NumberFormat(undefined, { notation: "compact" }).format(v);
  const chart = (series: LineSeries[], format: (v: number) => string, fmtAxis: (v: number, step: number) => string, label: string, integer = false) =>
    days.length < 2 ? <Quiet>Pick two days or more to draw this over time.</Quiet> : series.every((s) => s.values.every((v) => v === null || v === 0)) ? <Quiet>Nothing in these dates.</Quiet> : <LineChart days={dates} series={series} format={format} fmtAxis={fmtAxis} label={label} today={today} integer={integer} />;
  const span = fmtSpan(range.from, range.to);
  const roas = daily.map((d) => d.roas);
  return (
    <Section id="combined" title="Demo store: advertising next to sales (simulated)" help={note} demo>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="ga-combined-totals">
        <Stat label="Demo store revenue (net sales)" value={w.money(totals.netSales)} note="Simulated" />
        <Stat label="Google Ads spend (demo)" value={w.money(totals.spend)} note="Simulated" />
        <Stat label="Advertising conversions (modeled)" value={fmtNum(totals.adOrders)} note={`of ${fmtNum(totals.orders)} store orders (${w.pct(totals.adOrderShare)})`} />
        <Stat label="Advertising conversion value" value={w.money(totals.adSales)} note="Modeled attribution" />
        <Stat label="ROAS" value={w.times(totals.roas)} note="Conversion value ÷ spend" />
        <Stat label="Customer acquisition cost" value={w.money(totals.cac)} note="Spend ÷ attributed orders" />
        <Stat label="Marketing efficiency (MER)" value={w.times(totals.mer)} note="Net sales ÷ spend" />
        <Stat label="Ads as share of sales" value={w.pct(totals.shareOfSales)} note="Spend ÷ net sales" />
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div className="min-w-0 rounded-lg border border-border p-3" data-testid="ga-combined-spend-vs-revenue">
          <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
            Advertising spend vs revenue <DemoDataBadge />
          </h3>
          {chart(
            [
              { key: "revenue", label: "Demo store net sales", color: "var(--viz-cat-1)", values: days.map((d) => d.netSales) },
              { key: "spend", label: "Google Ads spend (demo)", color: "var(--viz-cat-2)", values: days.map((d) => d.spend) },
            ],
            money,
            axis,
            `Demo spend and demo store revenue per day, ${span}`,
          )}
        </div>
        <div className="min-w-0 rounded-lg border border-border p-3" data-testid="ga-combined-conversions-vs-orders">
          <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
            Campaign conversions vs orders <DemoDataBadge />
          </h3>
          {chart(
            [
              { key: "orders", label: "Demo store orders", color: "var(--viz-cat-1)", values: days.map((d) => d.orders) },
              { key: "adOrders", label: "Orders credited to the demo ads (modeled)", color: "var(--viz-cat-2)", values: days.map((d) => d.adOrders) },
            ],
            fmtNum,
            compact,
            `Demo store orders and orders credited to ads per day, ${span}`,
            true,
          )}
        </div>
        <div className="min-w-0 rounded-lg border border-border p-3" data-testid="ga-combined-roas">
          <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
            Advertising ROAS trend <DemoDataBadge />
          </h3>
          {chart([{ key: "roas", label: "ROAS (demo)", color: "var(--viz-cat-2)", values: roas }], (v) => fmtTimes(v), (v) => fmtTimes(v), `Demo ROAS per day, ${span}`)}
        </div>
        <div className="min-w-0 rounded-lg border border-border p-3" data-testid="ga-combined-performance">
          <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
            Marketing performance over time <DemoDataBadge />
          </h3>
          {chart(
            [
              { key: "spend", label: "Spend (demo)", color: "var(--viz-cat-2)", values: days.map((d) => d.spend) },
              { key: "adSales", label: "Attributed conversion value (modeled)", color: "var(--viz-cat-3)", values: days.map((d) => d.adSales) },
              { key: "netSales", label: "Demo store net sales", color: "var(--viz-cat-1)", values: days.map((d) => d.netSales) },
            ],
            money,
            axis,
            `Demo spend, attributed value and store sales per day, ${span}`,
          )}
        </div>
      </div>
      {campaigns && (
        <div className="mt-4">
          <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
            Campaign spend vs attributed conversion value <DemoDataBadge />
          </h3>
          <div className="-mx-1 overflow-x-auto">
            <table className="w-full min-w-[36rem] text-sm" data-testid="ga-combined-campaigns">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="px-1 pb-2 font-normal">Campaign</th>
                  <th className="px-1 pb-2 text-right font-normal">Spend</th>
                  <th className="px-1 pb-2 text-right font-normal">Attributed conversion value (modeled)</th>
                  <th className="px-1 pb-2 text-right font-normal">Conversions</th>
                  <th className="px-1 pb-2 text-right font-normal">ROAS</th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map((c) => (
                  <tr key={c.id} className="border-t border-border">
                    <td className="px-1 py-2 font-medium">{c.name}</td>
                    <td className="px-1 py-2 text-right tabular-nums">{w.money(c.spend)}</td>
                    <td className="px-1 py-2 text-right tabular-nums">{w.money(c.conversionValue)}</td>
                    <td className="px-1 py-2 text-right tabular-nums">{w.num(c.conversions)}</td>
                    <td className="px-1 py-2 text-right tabular-nums">{w.times(c.roas)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <p className="mt-3 text-xs text-muted">
        Modeled attribution: the demo campaigns credit a part of the store&apos;s orders to themselves (their own count), never all of them; the rest of the demo store&apos;s orders are
        organic. None of this is your Shopify store&apos;s data.
      </p>
    </Section>
  );
}

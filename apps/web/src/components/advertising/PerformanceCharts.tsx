"use client";
import { useState } from "react";
import { BarChart3, PieChart } from "lucide-react";
import { groupSeries, type AdSeriesDay } from "@app/shared/ads";
import { periodsOf, type PeriodGranularity } from "@app/shared/dates";
import { fmtMoney, fmtPct } from "@/lib/api";
import { UNAVAILABLE } from "@/components/dashboard/AdsCommon";
import { shownFigures, upToWords } from "@/components/dashboard/adFigures";
import { Donut } from "@/components/dashboard/Charts";
import { fmtMoneyCompact, fmtMoneyWhole, fmtPeriod, fmtRange, periodChoices } from "@/components/dashboard/format";
import { LineChart } from "@/components/dashboard/LineChart";
import { ChartChoice } from "@/components/dashboard/Primitives";
import type { AdsModule, Overview } from "@/components/dashboard/types";
import { AdCard, EmptyNote } from "./AdCard";
import { PLATFORM, PLATFORM_COLOR } from "./AdvertisingUi";

// ---------------------------------------------------------------------------
// The Advertising overview's charts: what was spent against the purchase value the platforms credit to
// their ads, period by period, with ROAS on its own scale under them (never a second axis); and how the
// spend splits between the platforms. Every figure is the ad module's; a day a platform has no figures
// for is a gap, never a 0.
// ---------------------------------------------------------------------------

const SPEND = "var(--viz-running)";
const VALUE = "var(--viz-cat-3)";
const ROAS = "var(--viz-day)";

/**
 * Spend and purchase value per day, week or month (`groupSeries`: a week or month missing any day's
 * figures is left blank), and ROAS worked out from each period's sums.
 */
export function PerformanceOverview({ a, ov }: { a: AdsModule; ov: Overview }) {
  const [pickedBy, setBy] = useState<PeriodGranularity>("day");
  const choices = periodChoices(ov.range);
  const by = choices.some(([g]) => g === pickedBy) ? pickedBy : "day";
  const points: AdSeriesDay[] = by === "day" ? a.series : groupSeries(a.series, ov.range, by);
  const days = points.map((d) => d.day);
  const periods = by === "day" ? undefined : periodsOf(ov.range, by).map((p) => ({ tick: fmtPeriod(p, by, "tick"), long: fmtPeriod(p, by, "long") }));
  const money = (v: number) => fmtMoney(v, a.currency);
  const axis = (v: number, step: number) => (step < 1 ? fmtMoney(v, a.currency) : fmtMoneyCompact(v, a.currency));
  const spend = points.map((d) => d.spend);
  const value = points.map((d) => d.purchaseValue);
  const roas = points.map((d) => (d.spend && d.purchaseValue !== null ? d.purchaseValue / d.spend : null));
  const span = fmtRange(ov.range.from, ov.range.to);
  const title = `Ad spend and purchase value per ${by}`;
  const unread = spend.every((v) => v === null);
  const quiet = !unread && spend.every((v) => v === null || v === 0) && value.every((v) => v === null || v === 0);
  const gaps = spend.some((v) => v === null) ? (by === "day" ? " Days a platform has no figures for yet are left blank." : ` A ${by} missing any day's figures is left blank.`) : "";
  return (
    <AdCard
      id="ads-money-chart"
      title="Performance overview"
      sub={`${title}, ${span}, in ${a.currency}. Purchase value is the platforms' own count.${by === "week" ? " Weeks run Monday to Sunday." : ""}${gaps}`}
      icon={BarChart3}
      action={choices.length > 1 ? <ChartChoice<PeriodGranularity> label="Ad charts group" value={by} onChange={setBy} options={choices} /> : undefined}
    >
      {unread ? (
        <EmptyNote>No figures for these dates yet: see the figures above for why.</EmptyNote>
      ) : quiet ? (
        <EmptyNote>No ad activity in these dates.</EmptyNote>
      ) : (
        <>
          <LineChart
            days={days}
            series={[
              { key: "spend", label: "Ad spend", color: SPEND, values: spend },
              { key: "value", label: "Purchase value (platforms')", color: VALUE, values: value },
            ]}
            bars
            format={money}
            fmtAxis={axis}
            label={`${title}, ${span}`}
            today={by === "day" ? ov.today : undefined}
            periods={periods}
            height={200}
          />
          <div className="mt-1" data-testid="ads-roas-chart">
            <p className="text-xs text-muted">ROAS per {by}: purchase value ÷ spend</p>
            <LineChart
              days={days}
              series={[{ key: "roas", label: "ROAS", color: ROAS, values: roas }]}
              format={(v) => `${v.toFixed(2)}×`}
              fmtAxis={(v) => `${Number(v.toFixed(1))}×`}
              label={`ROAS per ${by}, ${span}`}
              today={by === "day" ? ov.today : undefined}
              periods={periods}
              height={110}
              area
            />
          </div>
        </>
      )}
    </AdCard>
  );
}

/** How the spend splits between the platforms: a ring, the total in the middle, each platform named with its amount and share. */
export function PlatformShare({ a }: { a: AdsModule }) {
  const { totals } = shownFigures(a);
  const rows = a.byProvider.map((p) => ({ p, t: shownFigures(p) }));
  const total = totals?.spend ?? null;
  const money = (n: number) => fmtMoney(n, a.currency);
  return (
    <AdCard id="ads-platform-share" title="Platform performance" sub={`Where the spend went, in ${a.currency}.`} icon={PieChart} tint="violet">
      {total === null ? (
        <EmptyNote>{UNAVAILABLE}: some days of the spend haven&apos;t been read yet.</EmptyNote>
      ) : (
        <div className="flex flex-1 flex-col items-center gap-4 @sm:flex-row">
          <Donut
            size={150}
            thickness={20}
            label={`Ad spend by platform: ${rows.map(({ p, t }) => `${PLATFORM[p.provider].name} ${t.totals ? money(t.totals.spend) : UNAVAILABLE}`).join(", ")}`}
            slices={rows.filter(({ t }) => t.totals).map(({ p, t }) => ({ key: p.provider, label: PLATFORM[p.provider].name, value: t.totals!.spend, color: PLATFORM_COLOR[p.provider] }))}
          >
            <span className="text-lg font-bold tabular-nums">{fmtMoneyCompact(total, a.currency)}</span>
            <span className="text-[11px] text-muted">Total spend</span>
          </Donut>
          <ul className="w-full min-w-0 flex-1 space-y-3">
            {rows.map(({ p, t }) => {
              const P = PLATFORM[p.provider];
              return (
                <li key={p.provider} className="min-w-0" data-testid={`ads-share-${p.provider}`}>
                  <p className="flex items-center gap-2 text-sm">
                    <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: PLATFORM_COLOR[p.provider] }} />
                    <P.Icon size={14} />
                    <span className="min-w-0 flex-1 truncate">{P.name}</span>
                    <span className="text-xs tabular-nums text-muted">{t.totals && total > 0 ? fmtPct(t.totals.spend / total) : "—"}</span>
                  </p>
                  <p className="pl-[18px] text-sm font-semibold tabular-nums">{t.totals ? money(t.totals.spend) : UNAVAILABLE}</p>
                  {t.through && <p className="pl-[18px] text-[11px] text-muted">{upToWords(t.through)}</p>}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {a.byProvider.length === 1 && <p className="mt-3 text-xs text-muted">One platform spending: connect the other to see them side by side.</p>}
      {total !== null && total > 0 && a.sales && (
        <p className="mt-3 text-xs text-muted">
          Ads were {fmtPct(a.sales.shareOfSales)} of your Shopify net sales: {fmtMoneyWhole(1, a.currency)} of ads for every {fmtMoney(a.sales.salesPerSpend === null ? null : a.sales.salesPerSpend, a.currency)} sold.
        </p>
      )}
    </AdCard>
  );
}

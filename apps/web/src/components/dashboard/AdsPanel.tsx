"use client";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { groupSeries, type AdSeriesDay, type AdTotals } from "@app/shared/ads";
import { periodsOf, type PeriodGranularity } from "@app/shared/dates";
import { useApp } from "@/components/AppContext";
import { GoogleIcon, MetaIcon } from "@/components/BrandIcons";
import { fmtMoney, fmtNum, fmtPct } from "@/lib/api";
import {
  AccountStatus,
  accountGroups,
  AdStatusNotes,
  BEING_READ,
  ChangeNote,
  ComparedLine,
  dailyMoneyColumns,
  missingReason,
  missingReasons,
  runningWords,
  throughLabel,
  timeZoneNote,
  UNAVAILABLE,
} from "./AdsCommon";
import { shownFigures, upToWords } from "./adFigures";
import { noEarlierData } from "./DateRange";
import { DemoChip } from "./Advertising";
import { Alert } from "@/components/ui";
import { fmtDay, fmtLongDay, fmtMoneyCompact, fmtMoneyWhole, fmtPeriod, fmtRange, fmtSpan, fmtTimes, periodChoices, plural } from "./format";
import { Icon } from "./Icons";
import { GoogleReportPanel } from "./GoogleReport";
import { LineChart, type LineSeries } from "./LineChart";
import { MetaReportPanel } from "./MetaReport";
import { B, comparedOnWholeDays } from "./Narrative";
import { ChartChoice, Delta, NeutralDelta, Panel, Stat } from "./Primitives";
import { ColumnsWithTotal } from "./ColumnsWithTotal";
import type { AdsModule, Overview } from "./types";

// ---------------------------------------------------------------------------
// The Ads details (the Advertising area's Meta Ads and Google Ads pages): what connected Meta and
// Google ad accounts spent, and what they say it brought.
// Figures exist only for days every counted account has stored; a gap is "Unavailable" with its
// reason, never 0. Purchases are purchases only: Google's other conversions are named as such.
// ---------------------------------------------------------------------------

const PLATFORM: Record<"meta" | "google", { name: string; Icon: (p: { size?: number }) => ReactNode }> = {
  meta: { name: "Meta", Icon: MetaIcon },
  google: { name: "Google Ads", Icon: GoogleIcon },
};

/** A figure some days don't have yet (older days being read again from the platform). */
const known = (v: number | null, show: (n: number) => string) => (v === null ? BEING_READ : show(v));

function SpendChart({ a, ov }: { a: AdsModule; ov: Overview }) {
  const money = (n: number) => fmtMoney(n, a.currency);
  const columns = dailyMoneyColumns(a.series, (d) => d.spend, ov.today, a.currency);
  return (
    <ColumnsWithTotal
      columns={columns}
      label={`Ad spend per day, ${fmtSpan(ov.range.from, ov.range.to)}, with the running total below`}
      fmtAxis={(v) => fmtMoneyCompact(v, a.currency)}
      runningLabel="Spent so far"
      fmtRunning={(v) => fmtMoneyWhole(v, a.currency)}
      tooltip={(i) => {
        const d = a.series[i]!;
        return (
          <>
            <div className="text-muted">{fmtLongDay(d.day)}{d.day === ov.today ? " · today so far" : ""}</div>
            {d.spend === null ? (
              <div className="mt-0.5 text-sm font-semibold">No figures for this day yet</div>
            ) : (
              <>
                <div className="mt-0.5 text-sm font-semibold tabular-nums">{money(d.spend)} spent</div>
                <div className="text-muted">
                  {d.linkClicks === null ? "link clicks being re-read" : plural(d.linkClicks, "link click")} · {plural(d.impressions ?? 0, "impression")}
                </div>
                {(d.purchases ?? 0) > 0 && <div className="text-muted">{fmtNum(d.purchases)} purchases (platforms&apos; count)</div>}
              </>
            )}
          </>
        );
      }}
      describe={(i) => {
        const d = a.series[i]!;
        if (d.spend === null) return `${fmtLongDay(d.day)}: no figures for this day yet.`;
        return `${fmtLongDay(d.day)}: ${money(d.spend)} spent, ${d.linkClicks === null ? "link clicks being re-read" : `${fmtNum(d.linkClicks)} link clicks`}, ${d.purchases === null ? "purchases being re-read" : `${fmtNum(d.purchases)} purchases`}.`;
      }}
      missingLabel="No data"
    />
  );
}

/**
 * The figures at a glance: for the whole range (or the days so far), or, when that's unavailable,
 * for the days every account has (`partial`: no changes then).
 */
function Glance({ a, t, ov, partial }: { a: AdsModule; t: AdTotals; ov: Overview; partial: boolean }) {
  const money = (n: number) => fmtMoney(n, a.currency);
  // Changes belong to the whole range only.
  const change = (value: number | null, neutral = false) => (partial ? undefined : <ChangeNote fig={a} value={value} ov={ov} neutral={neutral} />);
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Stat label="Ad spend" value={money(t.spend)} note={change(a.deltas.spend, true)} />
      <Stat label="Link clicks" value={known(t.linkClicks, fmtNum)} note={change(a.deltas.linkClicks)} />
      <Stat label="Purchases (platforms' count)" value={known(t.purchases, fmtNum)} note={change(a.deltas.purchases)} />
      <Stat label="Return on ad spend (platforms' own)" value={t.purchases === null ? BEING_READ : fmtTimes(t.roas)} note={change(a.deltas.roas)} />
      <Stat label="Purchase value (platforms' count)" value={known(t.purchaseValue, money)} />
      <Stat label="Cost per purchase" value={t.purchases === null ? BEING_READ : t.costPerPurchase !== null ? money(t.costPerPurchase) : "—"} />
      <Stat label="Cost per click" value={t.linkClicks === null ? BEING_READ : t.cpc !== null ? money(t.cpc) : "—"} note="Spend ÷ link clicks" />
      <Stat label="Click-through rate" value={t.linkClicks === null ? BEING_READ : fmtPct(t.ctr)} note={`${fmtNum(t.impressions)} impressions`} />
      <Stat label="Cost per 1,000 impressions" value={t.cpm !== null ? money(t.cpm) : "—"} />
      {/* Every day of the range only: the store's sales include the days still to come in. Not for one platform or account (the Advertising pages). */}
      {a.current && a.shareOfSales !== null && <Stat label="Ads as share of sales" value={fmtPct(a.shareOfSales)} note="Ad spend ÷ your net sales" />}
      {t.leads > 0 && <Stat label="Leads" value={fmtNum(t.leads)} />}
    </div>
  );
}

/** Each platform keeps its colour on every chart (the Advertising section's). */
const PLATFORM_COLOR: Record<"meta" | "google", string> = { meta: "var(--viz-cat-1)", google: "var(--viz-cat-2)" };

// ---------------------------------------------------------------------------
// The store's own sales next to the ad spend: Shopify's net sales and orders for the same dates,
// and two ways of crediting a sale to ads kept apart: what each platform counts for itself, and
// what Shopify's record of the visit behind each order says.
// ---------------------------------------------------------------------------

export function SalesVsSpend({ a, ov }: { a: AdsModule; ov: Overview }) {
  const s = a.sales;
  if (!s) return null;
  const money = (n: number) => fmtMoney(n, a.currency);
  const one = fmtMoneyWhole(1, a.currency);
  const label = s.previous && a.compared ? `vs ${fmtSpan(a.compared.previous.from, a.compared.previous.to)}` : null;
  /** The change against the dates compared with, and the figure before; without a comparison, what the figure is. */
  const change = (d: number | null, kind: "neutral" | "good" | "cost", fallback: string, before: string | null) =>
    label ? (
      <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
        {kind === "neutral" ? <NeutralDelta value={d} label={label} /> : <Delta value={d} invert={kind === "cost"} label={label} />}
        {before !== null && <span>before: {before}</span>}
      </span>
    ) : (
      fallback
    );
  const p = s.previous;
  const sourced = a.sourced ?? null;
  return (
    <Panel
      id="d-ads-vs-sales"
      title="Next to your Shopify sales"
      help={`Your store's own figures for ${fmtRange(ov.range.from, ov.range.to)}, set against everything spent on ads, in ${a.currency}. ${label ? "Changes compare whole dates with whole dates." : "Changes show once the dates picked are over."}`}
    >
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5" data-testid="ads-vs-sales">
        <Stat label="Net sales (Shopify)" value={money(s.netSales)} note={change(s.deltas.netSales, "good", "Every sale, whatever brought it", p ? money(p.netSales) : null)} />
        <Stat label="Orders (Shopify)" value={fmtNum(s.orders)} note={change(s.deltas.orders, "good", "Every order, whatever brought it", p ? fmtNum(p.orders) : null)} />
        <Stat label={`Sales per ${one} of ads (MER)`} value={fmtTimes(s.salesPerSpend)} note={change(s.deltas.salesPerSpend, "good", "Net sales ÷ ad spend", p ? fmtTimes(p.salesPerSpend) : null)} />
        <Stat label="Ads as share of sales" value={fmtPct(s.shareOfSales)} note="Ad spend ÷ net sales" />
        <Stat
          label="Cost per Shopify order"
          value={s.costPerOrder === null ? "—" : money(s.costPerOrder)}
          note={change(s.deltas.costPerOrder, "cost", "Ad spend ÷ every order, whatever brought it", p ? (p.costPerOrder === null ? "—" : money(p.costPerOrder)) : null)}
        />
      </div>
      <p className="mt-3 text-xs text-muted">
        Sales per {one} of ads (the marketing efficiency ratio) counts every sale your store made, not only the ones the platforms credit to their ads: it is your store&apos;s own measure, and
        it is not the same thing as a platform&apos;s ROAS. Cost per order is likewise spent ÷ every order, not what an order from an ad cost.
      </p>
      {sourced && sourced.length > 0 && (
        <div className="mt-4" data-testid="ads-attribution">
          <p className="text-sm font-medium">Two ways to credit a sale to ads</p>
          <p className="mt-0.5 text-xs text-muted">
            Each platform counts the purchases its own tracking links to its ads (its attribution window and setting). Shopify records the visit that ended in each order instead: an order
            whose last visit came from a Facebook or Instagram ad is credited to Meta here, from a Google or YouTube ad to Google Ads. Neither is the whole truth: a platform can claim a sale
            that would have happened anyway, and Shopify sees only the last visit. Together they bracket it.
          </p>
          <div className="-mx-1 mt-3 overflow-x-auto">
            <table className="w-full min-w-[60rem] text-sm">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="px-1 pb-2 font-normal">Platform</th>
                  <th className="px-1 pb-2 text-right font-normal">Spend</th>
                  <th className="px-1 pb-2 text-right font-normal">Purchases (platform&apos;s count)</th>
                  <th className="px-1 pb-2 text-right font-normal">Purchase value (platform&apos;s count)</th>
                  <th className="px-1 pb-2 text-right font-normal">ROAS (platform&apos;s own)</th>
                  <th className="px-1 pb-2 text-right font-normal">Orders from its ads (Shopify&apos;s visit record)</th>
                  <th className="px-1 pb-2 text-right font-normal">Net sales from those orders</th>
                  <th className="px-1 pb-2 text-right font-normal">Sales per {one} (Shopify&apos;s record)</th>
                </tr>
              </thead>
              <tbody>
                {a.byProvider.map((p) => {
                  const P = PLATFORM[p.provider];
                  const t = shownFigures(p).totals;
                  const src = sourced.find((x) => x.provider === p.provider);
                  return (
                    <tr key={p.provider} className="border-t border-border" data-testid={`ads-attribution-${p.provider}`}>
                      <td className="px-1 py-2">
                        <span className="inline-flex items-center gap-2 font-medium">
                          <P.Icon size={16} />
                          {P.name}
                        </span>
                      </td>
                      <td className="px-1 py-2 text-right tabular-nums">{t ? money(t.spend) : UNAVAILABLE}</td>
                      <td className="px-1 py-2 text-right tabular-nums">{t ? known(t.purchases, fmtNum) : UNAVAILABLE}</td>
                      <td className="px-1 py-2 text-right tabular-nums">{t ? known(t.purchaseValue, money) : UNAVAILABLE}</td>
                      <td className="px-1 py-2 text-right tabular-nums">{t ? (t.purchases === null ? BEING_READ : fmtTimes(t.roas)) : UNAVAILABLE}</td>
                      <td className="px-1 py-2 text-right tabular-nums">{src ? fmtNum(src.orders) : "—"}</td>
                      <td className="px-1 py-2 text-right tabular-nums">{src ? money(src.sales) : "—"}</td>
                      <td className="px-1 py-2 text-right tabular-nums">{src ? fmtTimes(src.salesPerSpend) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-muted">
            Shopify&apos;s record needs the ad&apos;s link to be tagged (utm_medium such as cpc or paid, or a click id); an ad whose link carries no tag counts as an unpaid visit from that
            platform, under Analytics → Traffic. Orders are counted on the day they happened, in your store&apos;s time zone; the platforms count purchases on the day of the click, in the ad
            account&apos;s.
          </p>
        </div>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// One figure over the days, one line per platform: spend, what the platforms credit (purchases,
// their value, ROAS), clicks and impressions, and the rates worked out per day. A day a platform
// has no figures for is a gap, never a 0; a rate on a day without ads (no impressions, no clicks)
// is left out too.
// ---------------------------------------------------------------------------

type TrendMetric = "spend" | "purchaseValue" | "purchases" | "roas" | "linkClicks" | "impressions" | "ctr" | "cpc" | "cpm";
const TREND_METRICS: Array<[TrendMetric, string]> = [
  ["spend", "Ad spend"],
  ["purchaseValue", "Purchase value (platforms' count)"],
  ["purchases", "Purchases (platforms' count)"],
  ["roas", "ROAS (platforms' own)"],
  ["linkClicks", "Link clicks"],
  ["impressions", "Impressions"],
  ["ctr", "Click-through rate"],
  ["cpc", "Cost per click"],
  ["cpm", "Cost per 1,000 impressions"],
];

/** The figure of one day, or null when the day is missing, or (a rate) nothing ran that day. */
export function trendValue(d: AdSeriesDay, m: TrendMetric): number | null {
  const over = (a: number | null, b: number | null, scale = 1) => (a === null || b === null || b <= 0 ? null : (a * scale) / b);
  switch (m) {
    case "spend":
      return d.spend;
    case "purchaseValue":
      return d.purchaseValue;
    case "purchases":
      return d.purchases;
    case "linkClicks":
      return d.linkClicks;
    case "impressions":
      return d.impressions;
    case "ctr":
      return over(d.linkClicks, d.impressions);
    case "cpc":
      return over(d.spend, d.linkClicks);
    case "cpm":
      return over(d.spend, d.impressions, 1000);
    case "roas":
      return over(d.purchaseValue, d.spend);
  }
}

function PerformanceTrend({ a, ov }: { a: AdsModule; ov: Overview }) {
  const [metric, setMetric] = useState<TrendMetric>("spend");
  const [pickedBy, setBy] = useState<PeriodGranularity>("day");
  if (a.series.length < 2) return null;
  const choices = periodChoices(ov.range);
  const by = choices.some(([g]) => g === pickedBy) ? pickedBy : "day";
  // A week's or month's rate is worked out from its sums (`trendValue` on the added-up period), never averaged.
  const group = (s: AdSeriesDay[]) => (by === "day" ? s : groupSeries(s, ov.range, by));
  const money = (v: number) => fmtMoney(v, a.currency);
  const axisMoney = (v: number, step: number) => (step < 1 ? fmtMoney(v, a.currency) : fmtMoneyCompact(v, a.currency));
  const compact = (v: number) => new Intl.NumberFormat(undefined, { notation: "compact" }).format(v);
  const kind = metric === "spend" || metric === "purchaseValue" || metric === "cpc" || metric === "cpm" ? "money" : metric === "ctr" ? "rate" : metric === "roas" ? "times" : "count";
  const format = kind === "money" ? money : kind === "rate" ? (v: number) => fmtPct(v) : kind === "times" ? (v: number) => fmtTimes(v) : fmtNum;
  const fmtAxis = kind === "money" ? axisMoney : kind === "rate" ? (v: number) => fmtPct(v) : kind === "times" ? (v: number) => fmtTimes(v) : (v: number) => compact(v);
  const series: LineSeries[] = a.seriesByProvider.map((s) => ({ key: s.provider, label: PLATFORM[s.provider].name, color: PLATFORM_COLOR[s.provider], values: group(s.series).map((d) => trendValue(d, metric)) }));
  const points = by === "day" ? a.series : groupSeries(a.series, ov.range, by);
  const days = points.map((d) => d.day);
  const periods = by === "day" ? undefined : periodsOf(ov.range, by).map((p) => ({ tick: fmtPeriod(p, by, "tick"), long: fmtPeriod(p, by, "long") }));
  const per = by;
  const title = TREND_METRICS.find(([m]) => m === metric)![1];
  const empty = series.every((s) => s.values.every((v) => v === null));
  return (
    <Panel
      id="d-ads-trend"
      title="Over the days"
      help={`${fmtSpan(ov.range.from, ov.range.to)}, by platform${by === "week" ? ", in weeks from Monday to Sunday" : by === "month" ? ", in calendar months" : ""}. ${by === "day" ? "Days" : `A ${per} with any day`} a platform has no figures for ${by === "day" ? "are" : "is"} left blank, not drawn as 0${kind === "money" || kind === "count" ? "" : `; so is a rate on a ${per} its ads didn't run`}.`}
      aside={
        <div className="flex flex-wrap gap-2">
          {choices.length > 1 && <ChartChoice<PeriodGranularity> label="Trend groups" value={by} onChange={setBy} options={choices} />}
          <ChartChoice label="Figure" value={metric} options={TREND_METRICS} onChange={setMetric} />
        </div>
      }
    >
      <div data-testid="ads-trend" data-metric={metric}>
        {empty ? (
          <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted">No figures for this in these dates yet.</p>
        ) : (
          <LineChart days={days} series={series} format={format} fmtAxis={fmtAxis} label={`${title} per ${per} by platform, ${fmtSpan(ov.range.from, ov.range.to)}`} today={by === "day" ? ov.today : undefined} integer={kind === "count"} periods={periods} />
        )}
      </div>
      {(metric === "purchases" || metric === "purchaseValue" || metric === "roas") && (
        <p className="mt-2 text-xs text-muted">Each platform&apos;s own count of what its ads brought, credited to the day of the click; the platforms keep revising recent days as late conversions come in.</p>
      )}
    </Panel>
  );
}

export function AdsDetail({ ov }: { ov: Overview }) {
  const { allowed } = useApp();
  const a = ov.modules.ads!;
  // The whole range, or while only days not over yet are missing, the days so far (up to `upTo`).
  const { totals: c, through: upTo } = shownFigures(a);
  const money = (n: number) => fmtMoney(n, a.currency);
  const { left } = accountGroups(a.accounts);
  const counted = a.accounts.filter((acc) => acc.counted);
  const reasons = missingReasons(counted, ov.range);
  const spendOf = (p: (typeof a.byProvider)[number]) => shownFigures(p).totals?.spend ?? null;
  // Split by platform only when each platform's figure covers the same days as the total.
  const sameDays = a.byProvider.every((p) => (shownFigures(p).through ?? ov.range.to) === (upTo ?? ov.range.to));
  const split = c && sameDays && a.byProvider.length > 1 ? a.byProvider.map((p) => `${PLATFORM[p.provider].name} ${spendOf(p) === null ? UNAVAILABLE.toLowerCase() : money(spendOf(p)!)}`).join(", ") : null;
  const googleP = a.byProvider.find((p) => p.provider === "google");
  const google = googleP ? shownFigures(googleP).totals : null;
  const missing = a.notCompared === "no_history" ? noEarlierData(a.historyFrom, "ads") : null;
  const on = comparedOnWholeDays(ov);
  const through = throughLabel(a, ov);
  const change = (d: number | null) =>
    a.notCompared === "running"
      ? `, ${runningWords(ov)}: nothing to compare yet`
      : a.notCompared === "no_history"
        ? ", with no earlier data to compare"
        : a.notCompared === "incomplete" || d === null
          ? ""
          : d === 0
            ? `, the same as ${on}${through === "vs before" ? "" : ` (${through})`}`
            : `, ${d > 0 ? "up" : "down"} ${fmtPct(Math.abs(d))} on ${on}${through === "vs before" ? "" : ` (${through}: whole days only)`}`;
  const shown = c ?? a.partial?.totals ?? null;
  const reports = a.campaigns !== undefined;
  const readable = a.accounts.filter((acc) => acc.status !== "reconnect" && acc.status !== "permission");

  return (
    <>
      <AdStatusNotes accounts={a.accounts} manage={allowed("integrations.manage")} />
      {a.demo && (
        <Alert kind="info">
          <span className="inline-flex flex-wrap items-center gap-2" data-testid="ads-demo-note">
            <DemoChip />
            <span>
              The Google Ads demo&apos;s simulated figures are among these accounts. They are generated by bizinsights, not read from Google, and aren&apos;t set against your store&apos;s own
              sales here.{" "}
              <Link className="font-medium underline" href="/advertising/google/analytics">
                Open the Google Ads analytics page
              </Link>{" "}
              to see the demo next to a simulated store.
            </span>
          </span>
        </Alert>
      )}
      <div className="card flex items-start gap-3 border-accent/30 bg-accent/5">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/12 text-accent">
          <Icon name="sparkle" className="h-4 w-4" />
        </span>
        <div className="min-w-0 space-y-1 text-sm leading-relaxed">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">In short</p>
          {!c && (
            <p>
              These dates&apos; ad figures aren&apos;t complete, so no total is shown for them. {reasons.join(" ")}
              {a.partial ? (
                <>
                  {" "}
                  Every account has {fmtSpan(a.partial.from, a.partial.to)}: <B>{money(a.partial.totals.spend)}</B> spent then.
                </>
              ) : null}{" "}
              <Link className="text-accent underline" href="/settings/ads">
                Check the accounts in Settings
              </Link>
              .
            </p>
          )}
          {c && (
            <>
              <p>
                {upTo ? <>Up to {fmtDay(upTo, { year: false })}, you</> : "You"} spent <B>{money(c.spend)}</B> on ads{split ? <> ({split})</> : null}
                {change(a.deltas.spend)}.
              </p>
              {upTo && reasons.length > 0 && <p className="text-muted">{reasons.join(" ")}</p>}
              <p>
                {c.linkClicks === null ? (
                  <>Their link clicks for some of these days are still being read again from the platforms</>
                ) : (
                  <>
                    They brought <B>{plural(c.linkClicks, "link click")}</B>
                    {c.cpc !== null ? <>, about {money(c.cpc)} each</> : null}
                  </>
                )}
                {c.purchases === null ? (
                  <>; their purchases for some of these days are still being read again, so none are counted yet.</>
                ) : c.purchases > 0 ? (
                  <>
                    , and by the platforms&apos; own count <B>{fmtNum(c.purchases)} purchases</B> worth {c.purchaseValue === null ? "an amount still being read" : money(c.purchaseValue)}: <B>{fmtTimes(c.roas)}</B>{" "}
                    what you spent.
                  </>
                ) : (
                  <>, and no purchases the platforms credit to them.</>
                )}
              </p>
              {google && google.conversions > 0 && (
                <p>
                  Google Ads also counts <B>{fmtNum(google.conversions)} conversions</B> in all: every conversion action it&apos;s set to count (purchases, and
                  also leads, sign-ups or calls), so they&apos;re shown apart from purchases.
                </p>
              )}
              {a.shareOfSales !== null && (
                <p>
                  Ads cost <B>{fmtPct(a.shareOfSales)}</B> of your store&apos;s net sales in these dates.
                </p>
              )}
              {c.leads > 0 && <p>{plural(c.leads, "lead")} from lead forms too.</p>}
            </>
          )}
          {timeZoneNote(counted) && <p className="text-muted">{timeZoneNote(counted)}</p>}
          {left.length > 0 && (
            <p className="text-muted">
              Not added in: {left.map((acc) => `${acc.name ?? acc.accountId} (${acc.currency ?? "currency not known yet"})`).join(", ")}, because they&apos;re in another currency.
            </p>
          )}
        </div>
      </div>

      <Panel
        id="d-ads-glance"
        title="At a glance"
        help={
          <>
            {upTo
              ? `${fmtRange(ov.range.from, upTo)}, the days so far`
              : c || !a.partial
                ? fmtRange(ov.range.from, ov.range.to)
                : `${fmtRange(a.partial.from, a.partial.to)} only, the days every account has`}
            .{" "}
            {a.compared && !(!c && a.partial) ? (
              <>
                <ComparedLine fig={a} show={(t) => money(t.spend)} what="spend" />.{" "}
              </>
            ) : null}
            {missing ? `${missing} ` : ""}In {a.currency}.
          </>
        }
      >
        {shown ? (
          <Glance a={a} t={shown} ov={ov} partial={!c} />
        ) : (
          <div className="space-y-1 text-sm text-muted">
            <p className="text-xl font-semibold text-text">{UNAVAILABLE}</p>
            {reasons.map((r) => (
              <p key={r}>{r}</p>
            ))}
          </div>
        )}
      </Panel>

      <SalesVsSpend a={a} ov={ov} />

      {a.series.length > 1 && (
        <section className="card animate-rise min-w-0" data-testid="ads-daily">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">{fmtSpan(ov.range.from, ov.range.to)} · Ad spend per day</p>
          <p className="mt-1 text-3xl font-semibold">{c ? money(c.spend) : UNAVAILABLE}</p>
          {upTo && <p className="text-xs text-muted">Spent {upToWords(upTo)}. Days with no figures yet are marked, not drawn as $0.</p>}
          {!c && <p className="text-xs text-muted">Days with no figures yet are marked, not drawn as $0.</p>}
          <ColumnsLegend />
          <SpendChart a={a} ov={ov} />
        </section>
      )}

      <PerformanceTrend a={a} ov={ov} />

      <Panel id="d-ads-platforms" title="By platform" help="Each platform's own numbers for these dates. Purchases are purchases only; Google Ads' conversions count every conversion action.">
        <div className="-mx-1 overflow-x-auto">
          <table className="w-full min-w-[52rem] text-sm">
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="px-1 pb-2 font-normal">Platform</th>
                <th className="px-1 pb-2 text-right font-normal">Spend</th>
                <th className="px-1 pb-2 text-right font-normal">Link clicks</th>
                <th className="px-1 pb-2 text-right font-normal">Purchases</th>
                <th className="px-1 pb-2 text-right font-normal">Purchase value</th>
                <th className="px-1 pb-2 text-right font-normal">ROAS (platform&apos;s own)</th>
                <th className="px-1 pb-2 text-right font-normal">Per purchase</th>
                <th className="px-1 pb-2 text-right font-normal">Conversions (all conversion actions)</th>
                <th className="px-1 pb-2 text-right font-normal">Per conversion</th>
              </tr>
            </thead>
            <tbody>
              {a.byProvider.map((p) => {
                const P = PLATFORM[p.provider];
                const { totals: t, through: pUpTo } = shownFigures(p);
                const why = t ? null : a.accounts.filter((acc) => acc.counted && acc.provider === p.provider).map((acc) => missingReason(acc, ov.range)).filter(Boolean).join(" ");
                return (
                  <tr key={p.provider} className="border-t border-border">
                    <td className="px-1 py-2">
                      <span className="inline-flex items-center gap-2 font-medium">
                        <P.Icon size={16} />
                        {P.name}
                      </span>
                      {pUpTo && <span className="block text-xs text-muted">{upToWords(pUpTo)}</span>}
                    </td>
                    {t ? (
                      <>
                        <td className="px-1 py-2 text-right tabular-nums">{money(t.spend)}</td>
                        <td className="px-1 py-2 text-right tabular-nums">{known(t.linkClicks, fmtNum)}</td>
                        <td className="px-1 py-2 text-right tabular-nums">{known(t.purchases, fmtNum)}</td>
                        <td className="px-1 py-2 text-right tabular-nums">{known(t.purchaseValue, money)}</td>
                        <td className="px-1 py-2 text-right tabular-nums">{t.purchases === null ? BEING_READ : fmtTimes(t.roas)}</td>
                        <td className="px-1 py-2 text-right tabular-nums">{t.purchases === null ? BEING_READ : t.costPerPurchase !== null ? money(t.costPerPurchase) : "—"}</td>
                        <td className="px-1 py-2 text-right tabular-nums">{p.provider === "google" ? fmtNum(t.conversions) : "—"}</td>
                        <td className="px-1 py-2 text-right tabular-nums">{p.provider === "google" && t.costPerConversion !== null ? money(t.costPerConversion) : "—"}</td>
                      </>
                    ) : (
                      <td colSpan={8} className="px-1 py-2 text-right text-xs text-muted">
                        {UNAVAILABLE}
                        {why ? `: ${why}` : ""}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>

      {a.campaigns && (
        <Panel
          id="d-ads-campaigns"
          title="Campaigns"
          help="The campaigns that spent most in these dates."
          aside={
            a.campaigns.length > 0 && (
              <Link className="text-xs text-accent underline" href="/advertising/campaigns">
                Compare every campaign
              </Link>
            )
          }
        >
          {a.campaigns.length === 0 ? (
            <p className="text-sm text-muted">{c ? "No campaign spent anything in these dates." : "No campaign figures for these dates yet."}</p>
          ) : (
            <div className="-mx-1 overflow-x-auto">
              <table className="w-full min-w-[34rem] text-sm">
                <thead className="text-left text-xs text-muted">
                  <tr>
                    <th className="px-1 pb-2 font-normal">Campaign</th>
                    <th className="px-1 pb-2 text-right font-normal">Spend</th>
                    <th className="px-1 pb-2 text-right font-normal">Link clicks</th>
                    <th className="px-1 pb-2 text-right font-normal">Click-through rate</th>
                    <th className="px-1 pb-2 text-right font-normal">Purchases</th>
                    <th className="px-1 pb-2 text-right font-normal">ROAS</th>
                  </tr>
                </thead>
                <tbody>
                  {a.campaigns.slice(0, 10).map((cmp) => {
                    const P = PLATFORM[cmp.provider];
                    return (
                      <tr key={`${cmp.provider}:${cmp.accountId}:${cmp.campaignId}`} className="border-t border-border">
                        <td className="px-1 py-2">
                          <span className="inline-flex items-center gap-2">
                            <P.Icon size={14} />
                            <span className="font-medium">{cmp.name}</span>
                          </span>
                          {cmp.complete === false && <span className="block text-xs text-muted">Its account&apos;s figures stop before these dates end</span>}
                        </td>
                        <td className="px-1 py-2 text-right tabular-nums">{money(cmp.spend)}</td>
                        <td className="px-1 py-2 text-right tabular-nums">{known(cmp.linkClicks, fmtNum)}</td>
                        <td className="px-1 py-2 text-right tabular-nums">{cmp.linkClicks === null ? BEING_READ : fmtPct(cmp.ctr)}</td>
                        <td className="px-1 py-2 text-right tabular-nums">{known(cmp.purchases, fmtNum)}</td>
                        <td className="px-1 py-2 text-right tabular-nums">{cmp.purchases === null ? BEING_READ : fmtTimes(cmp.roas)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      )}

      {/* The live reports need "View campaigns" (Team & Access): the server leaves campaigns out without it. */}
      {reports && readable.some((acc) => acc.provider === "google") && <GoogleReportPanel ov={ov} accounts={readable} />}
      {reports && readable.some((acc) => acc.provider === "meta") && <MetaReportPanel ov={ov} accounts={readable} />}

      <Panel
        id="d-ads-accounts"
        title="Ad accounts"
        help="Read-only. Turn accounts on or off, reconnect or disconnect them in Settings."
        aside={
          <span className="flex flex-wrap items-center gap-3">
            {a.accounts.some((acc) => acc.provider === "google") && (
              <Link className="text-xs text-accent underline" href="/advertising/google/analytics" data-testid="open-google-ads-analytics">
                Google Ads analytics
              </Link>
            )}
            <Link className="text-xs text-accent underline" href="/settings/ads">
              Manage ad accounts
            </Link>
          </span>
        }
      >
        <ul className="divide-y divide-border">
          {a.accounts.map((acc) => {
            const P = PLATFORM[acc.provider];
            return (
              <li key={acc.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <span className="inline-flex items-center gap-2">
                  <P.Icon size={16} />
                  <span className="font-medium">{acc.name ?? acc.accountId}</span>
                  {acc.demo && <DemoChip small />}
                  <span className="text-xs text-muted">
                    {acc.accountId}
                    {acc.currency ? ` · ${acc.currency}` : ""}
                    {acc.otherTimeZone && acc.timezone ? ` · days in ${acc.timezone}` : ""}
                  </span>
                </span>
                <AccountStatus acc={acc} />
              </li>
            );
          })}
        </ul>
        <p className="mt-3 text-xs text-muted">
          Purchases and their value are what Meta and Google each credit to their own ads (for Google, its conversion actions of the Purchase category). A sale can be
          counted by both, and the numbers won&apos;t match your Shopify orders exactly; your store&apos;s own sales are on the Sales page.
        </p>
      </Panel>
    </>
  );
}

function ColumnsLegend() {
  return (
    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
      <span className="inline-flex items-center gap-1.5"><span aria-hidden className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: "var(--viz-tier-2)" }} />Spend</span>
      <span className="inline-flex items-center gap-1.5"><span aria-hidden className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: "var(--viz-tier-3)" }} />Biggest day</span>
      <span className="inline-flex items-center gap-1.5"><span aria-hidden className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: "var(--border)", opacity: 0.6 }} />Weekend</span>
    </div>
  );
}

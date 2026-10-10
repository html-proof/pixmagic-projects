"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import { GoogleIcon, MetaIcon } from "@/components/BrandIcons";
import { Alert } from "@/components/ui";
import { fmtMoney, fmtNum, fmtPct } from "@/lib/api";
import { fmtMoneyCompact, fmtRange, plural } from "./format";
import { Icon } from "./icons";
import { LineChart, type LineSeries } from "./lineChart";
import { Delta, Stat } from "./primitives";
import type { Topic } from "./topics";
import type { AdsenseModule, AdsModule, Overview } from "./types";

// ---------------------------------------------------------------------------
// Advertising on the main dashboard: what connected ad platforms report for the dates picked.
// Money out (Meta Ads, Google Ads spend) and money in (Google AdSense earnings) are kept apart in
// every number; the only things compared across platforms are the ones that mean the same thing
// everywhere (ads shown, clicks, click rate). Nothing here is made up: a figure a platform
// doesn't report is "N/A".
// ---------------------------------------------------------------------------

type Provider = "meta" | "google" | "adsense";

/** Each platform keeps its colour on every chart (colour follows the platform, never its rank). */
const PLATFORM: Record<Provider, { name: string; Icon: (p: { size?: number }) => ReactNode; color: string }> = {
  meta: { name: "Meta Ads", Icon: MetaIcon, color: "var(--viz-cat-1)" },
  google: { name: "Google Ads", Icon: GoogleIcon, color: "var(--viz-cat-2)" },
  adsense: { name: "Google AdSense", Icon: GoogleIcon, color: "var(--viz-cat-3)" },
};

const NA = "N/A";
const ratio = (a: number, b: number) => (b > 0 ? a / b : null);
const times = (n: number | null) => (n === null ? NA : `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(n)}×`);

interface Account {
  id: string;
  provider: Provider;
  accountId: string;
  name: string | null;
  status: string;
  lastSyncedAt: string | null;
}

/** A change with no good or bad direction (spending more isn't good or bad by itself). */
function Neutral({ value }: { value: number | null }) {
  if (value === null) return <span className="text-xs text-muted">nothing to compare with</span>;
  return (
    <span className="inline-flex w-fit items-center gap-1 rounded-full bg-border/60 px-2 py-0.5 text-xs text-muted">
      {value > 0 ? "▲" : value < 0 ? "▼" : "■"} {fmtPct(Math.abs(value))} <span className="opacity-80">vs before</span>
    </span>
  );
}

function SectionHeading({ manage }: { manage: boolean }) {
  return (
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
      <h2 id="ads-h" className="flex items-center gap-2 font-semibold">
        <Icon name="megaphone" className="h-5 w-5 text-accent" />
        Advertising
      </h2>
      {manage && (
        <Link href="/settings/ads" className="text-sm text-accent underline-offset-2 hover:underline">
          Manage integrations
        </Link>
      )}
    </div>
  );
}

function PlatformChip({ p }: { p: Provider }) {
  const P = PLATFORM[p];
  return (
    <span className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-white px-2 py-1 text-xs font-medium text-[#1b1b18]">
      <P.Icon size={14} />
      {P.name}
    </span>
  );
}

/** Nothing connected yet: one clear way in, for the people who can connect. */
function Onboarding({ hiddenOnly, offer }: { hiddenOnly: boolean; offer: Provider[] }) {
  return (
    <section aria-labelledby="ads-h" data-testid="ads-onboarding">
      <SectionHeading manage={false} />
      <div className="card flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="font-medium">{hiddenOnly ? "Your ad accounts are hidden from the dashboard" : "See your advertising next to your sales"}</p>
          <p className="mt-1 text-sm text-muted">
            {hiddenOnly
              ? "Every connected ad account is switched off for the dashboard. Turn on the ones that belong to this store to see their numbers here."
              : "Connect Meta Ads or Google Ads to see what you spend and what it brings, and Google AdSense to see what your site earns from ads. Access is read-only: Insights never changes your ads."}
          </p>
          {!hiddenOnly && offer.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {offer.map((p) => (
                <PlatformChip key={p} p={p} />
              ))}
            </div>
          )}
        </div>
        <Link className="btn-primary shrink-0 self-start sm:self-center" href="/settings/ads" data-testid="connect-advertising">
          {hiddenOnly ? "Manage ad accounts" : "Connect advertising accounts"}
        </Link>
      </div>
    </section>
  );
}

/** What's wrong or still loading, per account, in words. */
function StatusNotes({ accounts, manage }: { accounts: Account[]; manage: boolean }) {
  const name = (a: Account) => `${a.name ?? a.accountId} (${PLATFORM[a.provider].name})`;
  const fetching = accounts.filter((a) => a.status === "active" && !a.lastSyncedAt);
  const ended = accounts.filter((a) => a.status === "reconnect");
  const failing = accounts.filter((a) => a.status === "error");
  if (!fetching.length && !ended.length && !failing.length) return null;
  return (
    <div className="mb-3 space-y-2">
      {fetching.length > 0 && (
        <Alert kind="info">
          <span className="inline-flex items-center gap-2">
            <span aria-hidden className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
            Fetching the last 90 days from {fetching.map(name).join(", ")}. The numbers below fill in within a few minutes; this page updates by itself.
          </span>
        </Alert>
      )}
      {ended.length > 0 && (
        <Alert>
          Access has ended for {ended.map(name).join(", ")}, so {ended.length === 1 ? "its" : "their"} numbers have stopped updating.{" "}
          {manage ? (
            <Link className="font-medium underline" href="/settings/ads">Reconnect in Settings</Link>
          ) : (
            "Ask a workspace owner or admin to reconnect."
          )}
        </Alert>
      )}
      {failing.length > 0 && (
        <Alert kind="info">
          The last update didn&apos;t work for {failing.map(name).join(", ")}. We&apos;ll keep trying; the numbers below are from the last good update.{" "}
          {manage && <Link className="underline" href="/settings/ads">See details</Link>}
        </Alert>
      )}
    </div>
  );
}

function GroupCard({ title, sub, onOpen, children, testid }: { title: ReactNode; sub: ReactNode; onOpen: () => void; children: ReactNode; testid: string }) {
  return (
    <div className="card min-w-0" data-testid={testid}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-semibold">{title}</h3>
          <p className="text-xs text-muted">{sub}</p>
        </div>
        <button type="button" className="text-xs text-accent underline-offset-2 hover:underline" onClick={onOpen}>
          See details
        </button>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">{children}</div>
    </div>
  );
}

function SpendKpis({ a, onOpen }: { a: AdsModule; onOpen: () => void }) {
  const c = a.current;
  const money = (n: number | null) => (n === null ? NA : fmtMoney(n, a.currency));
  const names = a.byProvider.map((p) => PLATFORM[p.provider].name).join(" and ") || "Meta Ads and Google Ads";
  return (
    <GroupCard title="Ad spend" sub={`Money you paid ${names}, in ${a.currency}`} onOpen={onOpen} testid="ads-spend">
      <Stat label="Ad spend" value={money(c.spend)} note={<Neutral value={a.deltas.spend} />} />
      <Stat label="Impressions" value={fmtNum(c.impressions)} note="Times your ads were shown" />
      <Stat label="Clicks" value={fmtNum(c.clicks)} note={<Delta value={a.deltas.clicks} label="vs before" />} />
      <Stat label="Click-through rate" value={c.ctr === null ? NA : fmtPct(c.ctr)} note="Clicks ÷ impressions" />
      <Stat label="Cost per click" value={money(c.cpc)} />
      <Stat label="Cost per 1,000 impressions" value={money(c.cpm)} />
      <Stat label="Conversions" value={fmtNum(c.conversions)} note={<Delta value={a.deltas.conversions} label="vs before" />} />
      <Stat label="Conversion value" value={money(c.conversionValue)} note={`Return on ad spend ${times(c.roas)}`} />
    </GroupCard>
  );
}

function EarningsKpis({ a, onOpen }: { a: AdsenseModule; onOpen: () => void }) {
  const c = a.current;
  const money = (n: number | null) => (n === null ? NA : fmtMoney(n, a.currency));
  return (
    <GroupCard title="Ad earnings" sub={`Money Google AdSense pays you for ads on your site, in ${a.currency}`} onOpen={onOpen} testid="ads-earnings">
      <Stat label="Estimated earnings" value={money(c.earnings)} note={<Delta value={a.deltas.earnings} label="vs before" />} />
      <Stat label="Page views" value={fmtNum(c.pageViews)} note={<Delta value={a.deltas.pageViews} label="vs before" />} />
      <Stat label="Impressions" value={fmtNum(c.impressions)} note="Ads shown on your site" />
      <Stat label="Clicks" value={fmtNum(c.clicks)} note={<Delta value={a.deltas.clicks} label="vs before" />} />
      <Stat label="Click-through rate" value={c.ctr === null ? NA : fmtPct(c.ctr)} note="Clicks ÷ impressions" />
      <Stat label="Earnings per click" value={money(c.perClick)} />
      <Stat label="Page RPM" value={money(c.pageRpm)} note="Earnings per 1,000 page views" />
      <Stat label="Impression RPM" value={money(ratio(c.earnings * 1000, c.impressions))} note="Earnings per 1,000 impressions" />
    </GroupCard>
  );
}

function ChartCard({ title, sub, children, testid }: { title: string; sub?: string; children: ReactNode; testid: string }) {
  return (
    <div className="card min-w-0" data-testid={testid}>
      <h3 className="font-semibold">{title}</h3>
      {sub && <p className="mb-3 text-xs text-muted">{sub}</p>}
      {!sub && <div className="mb-3" />}
      {children}
    </div>
  );
}

/** The series for one measure, one line per platform, in platform order. */
function perPlatform(ov: Overview, pick: (p: Provider) => number[] | null): LineSeries[] {
  return (["meta", "google", "adsense"] as Provider[])
    .map((p) => ({ p, values: pick(p) }))
    .filter((x): x is { p: Provider; values: number[] } => x.values !== null)
    .map(({ p, values }) => ({ key: p, label: PLATFORM[p].name, color: PLATFORM[p].color, values }));
}

function Trends({ ov, fetching }: { ov: Overview; fetching: boolean }) {
  const ads = ov.modules.ads;
  const sense = ov.modules.adsense;
  const days = (ads?.series ?? sense?.series ?? []).map((d) => d.day);
  const byP = (p: "meta" | "google") => ads?.seriesByProvider.find((s) => s.provider === p)?.series ?? null;
  const sameMoney = !ads || !sense || ads.currency === sense.currency;
  const spendSeries = perPlatform(ov, (p) => (p === "adsense" ? null : (byP(p)?.map((d) => d.spend) ?? null))).map((s) => ({ ...s, label: `${s.label} spend` }));
  const earnSeries: LineSeries[] = sense ? [{ key: "adsense", label: "AdSense earnings", color: PLATFORM.adsense.color, values: sense.series.map((d) => d.earnings) }] : [];
  const impressions = perPlatform(ov, (p) => (p === "adsense" ? (sense?.series.map((d) => d.impressions) ?? null) : (byP(p)?.map((d) => d.impressions) ?? null)));
  const clicks = perPlatform(ov, (p) => (p === "adsense" ? (sense?.series.map((d) => d.clicks) ?? null) : (byP(p)?.map((d) => d.clicks) ?? null)));
  const quiet = (s: LineSeries[]) => s.every((x) => x.values.every((v) => v === 0));

  const plot = (series: LineSeries[], format: (v: number) => string, fmtAxis: (v: number, step: number) => string, label: string, integer = false) =>
    fetching && quiet(series) ? (
      <div className="skeleton h-40" aria-hidden="true" />
    ) : quiet(series) ? (
      <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted">No ad activity in these dates.</p>
    ) : (
      <LineChart days={days} series={series} format={format} fmtAxis={fmtAxis} label={label} today={ov.today} integer={integer} />
    );

  const moneyCur = ads?.currency ?? sense?.currency ?? "USD";
  const money = (cur: string) => (v: number) => fmtMoney(v, cur);
  // Whole amounts are short; gridlines less than a unit apart (a quiet AdSense day) need the cents.
  const axis = (cur: string) => (v: number, step: number) => (step < 1 ? fmtMoney(v, cur) : fmtMoneyCompact(v, cur));
  const count = (v: number) => new Intl.NumberFormat(undefined, { notation: "compact" }).format(v);
  const span = fmtRange(ov.range.from, ov.range.to);

  return (
    <div className="mt-4 space-y-4">
      {sameMoney ? (
        <ChartCard
          title={ads && sense ? "Ad spend and ad earnings per day" : ads ? "Ad spend per day" : "Ad earnings per day"}
          sub={`${span}, in ${moneyCur}.${ads && sense ? " Spend is money you paid; earnings are money paid to you." : ""}`}
          testid="ads-money-chart"
        >
          {plot([...spendSeries, ...earnSeries], money(moneyCur), axis(moneyCur), `Ad spend and earnings per day, ${span}`)}
        </ChartCard>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <ChartCard title="Ad spend per day" sub={`${span}, in ${ads!.currency}.`} testid="ads-money-chart">
            {plot(spendSeries, money(ads!.currency), axis(ads!.currency), `Ad spend per day, ${span}`)}
          </ChartCard>
          <ChartCard title="Ad earnings per day" sub={`${span}, in ${sense!.currency}.`} testid="ads-earnings-chart">
            {plot(earnSeries, money(sense!.currency), axis(sense!.currency), `Ad earnings per day, ${span}`)}
          </ChartCard>
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard title="Impressions per day" sub="Times ads were shown, by platform." testid="ads-impressions-chart">
          {plot(impressions, fmtNum, count, `Impressions per day by platform, ${span}`, true)}
        </ChartCard>
        <ChartCard title="Clicks per day" sub="Clicks on those ads, by platform." testid="ads-clicks-chart">
          {plot(clicks, fmtNum, count, `Clicks per day by platform, ${span}`, true)}
        </ChartCard>
      </div>
    </div>
  );
}

/** Platforms side by side, on the measures that mean the same thing on each. */
function Comparison({ ov }: { ov: Overview }) {
  const ads = ov.modules.ads;
  const sense = ov.modules.adsense;
  const rows: Array<{ p: Provider; money: string; kind: "spent" | "earned"; impressions: number; clicks: number; ctr: number | null; perClick: string; per1000: string; conversions: string }> = [];
  for (const b of ads?.byProvider ?? []) {
    const cur = ads!.currency;
    rows.push({
      p: b.provider,
      money: fmtMoney(b.spend, cur),
      kind: "spent",
      impressions: b.impressions,
      clicks: b.clicks,
      ctr: b.ctr,
      perClick: b.cpc === null ? NA : fmtMoney(b.cpc, cur),
      per1000: b.cpm === null ? NA : fmtMoney(b.cpm, cur),
      conversions: fmtNum(b.conversions),
    });
  }
  if (sense) {
    const c = sense.current;
    const rpm = ratio(c.earnings * 1000, c.impressions);
    rows.push({
      p: "adsense",
      money: fmtMoney(c.earnings, sense.currency),
      kind: "earned",
      impressions: c.impressions,
      clicks: c.clicks,
      ctr: c.ctr,
      perClick: c.perClick === null ? NA : fmtMoney(c.perClick, sense.currency),
      per1000: rpm === null ? NA : fmtMoney(rpm, sense.currency),
      conversions: NA,
    });
  }
  if (rows.length < 2) return null;
  return (
    <div className="card mt-4 min-w-0" data-testid="ads-comparison">
      <h3 className="font-semibold">By platform</h3>
      <p className="text-xs text-muted">Each platform&apos;s own numbers for these dates. Spent is money you paid; earned is money paid to you.</p>
      <div className="-mx-1 mt-3 overflow-x-auto">
        <table className="w-full min-w-[40rem] text-sm">
          <thead className="text-left text-xs text-muted">
            <tr>
              <th className="px-1 pb-2 font-normal">Platform</th>
              <th className="px-1 pb-2 text-right font-normal">Money</th>
              <th className="px-1 pb-2 text-right font-normal">Impressions</th>
              <th className="px-1 pb-2 text-right font-normal">Clicks</th>
              <th className="px-1 pb-2 text-right font-normal">Click-through rate</th>
              <th className="px-1 pb-2 text-right font-normal">Per click</th>
              <th className="px-1 pb-2 text-right font-normal">Per 1,000 impressions</th>
              <th className="px-1 pb-2 text-right font-normal">Conversions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const P = PLATFORM[r.p];
              return (
                <tr key={r.p} className="border-t border-border">
                  <td className="px-1 py-2">
                    <span className="inline-flex items-center gap-2 font-medium">
                      <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: P.color }} />
                      <P.Icon size={16} />
                      {P.name}
                    </span>
                  </td>
                  <td className="px-1 py-2 text-right tabular-nums">
                    {r.money} <span className="text-xs text-muted">{r.kind}</span>
                  </td>
                  <td className="px-1 py-2 text-right tabular-nums">{fmtNum(r.impressions)}</td>
                  <td className="px-1 py-2 text-right tabular-nums">{fmtNum(r.clicks)}</td>
                  <td className="px-1 py-2 text-right tabular-nums">{r.ctr === null ? NA : fmtPct(r.ctr)}</td>
                  <td className="px-1 py-2 text-right tabular-nums">{r.perClick} <span className="text-xs text-muted">{r.kind === "spent" ? "cost" : "earned"}</span></td>
                  <td className="px-1 py-2 text-right tabular-nums">{r.per1000} <span className="text-xs text-muted">{r.kind === "spent" ? "cost" : "earned"}</span></td>
                  <td className="px-1 py-2 text-right tabular-nums">{r.conversions}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-muted">
        Conversions are each ad platform&apos;s own count and can overlap; AdSense doesn&apos;t report them. Your store&apos;s own sales are above.
      </p>
    </div>
  );
}

/** The platforms this server can connect, in the order they're offered. */
const offered = (ov: Overview) => (["meta", "adsense", "google"] as Provider[]).filter((p) => ov.modules.ad_configured?.[p]);

/** A quiet way to add the platforms that aren't connected yet, without getting in the way. */
function ConnectMore({ ov }: { ov: Overview }) {
  const n = ov.modules.ad_connections;
  const missing = offered(ov).filter((p) => !n || n[p] === 0);
  if (!missing.length) return null;
  return (
    <p className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted" data-testid="ads-connect-more">
      Connect more:
      {missing.map((p) => (
        <Link key={p} href="/settings/ads" className="rounded-lg border border-border px-2 py-0.5 hover:border-accent hover:text-text">
          {PLATFORM[p].name}
        </Link>
      ))}
    </p>
  );
}

export function AdvertisingSection({ ov, manage, onOpen }: { ov: Overview; manage: boolean; onOpen: (t: Topic) => void }) {
  const ads = ov.modules.ads;
  const sense = ov.modules.adsense;
  if (!ads && !sense) {
    const n = ov.modules.ad_connections;
    const hiddenOnly = !!n && n.meta + n.google + n.adsense > 0 && n.hidden > 0;
    // Never offer a way in that can't work: with no platform set up on this server, say nothing.
    if (!manage || (!hiddenOnly && offered(ov).length === 0)) return null;
    return <Onboarding hiddenOnly={hiddenOnly} offer={offered(ov)} />;
  }
  const accounts: Account[] = [...(ads?.accounts ?? []), ...(sense?.accounts ?? [])].map((a) => ({
    id: a.id,
    provider: a.provider as Provider,
    accountId: a.accountId,
    name: a.name,
    status: a.status,
    lastSyncedAt: a.lastSyncedAt,
  }));
  const fetching = accounts.some((a) => a.status === "active" && !a.lastSyncedAt);
  const left = [...(ads?.accounts ?? []), ...(sense?.accounts ?? [])].filter((a) => !a.counted);
  return (
    <section aria-labelledby="ads-h" data-testid="advertising">
      <SectionHeading manage={manage} />
      <StatusNotes accounts={accounts} manage={manage} />
      <div className="grid gap-4">
        {ads && <SpendKpis a={ads} onOpen={() => onOpen("ads")} />}
        {sense && <EarningsKpis a={sense} onOpen={() => onOpen("adsense")} />}
      </div>
      <Trends ov={ov} fetching={fetching} />
      <Comparison ov={ov} />
      {left.length > 0 && (
        <p className="mt-2 text-xs text-muted">
          Not added in: {left.map((a) => `${a.name ?? a.accountId} (${a.currency})`).join(", ")}, because {left.length === 1 ? "it's" : "they're"} in another currency.
        </p>
      )}
      {manage && <ConnectMore ov={ov} />}
      <p className="mt-1 text-xs text-muted">{plural(accounts.length, "account")} connected · numbers refresh every hour.</p>
    </section>
  );
}

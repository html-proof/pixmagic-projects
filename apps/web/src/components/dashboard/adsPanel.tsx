"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import { weekdayOf } from "@app/shared/sales";
import { GoogleIcon, MetaIcon } from "@/components/BrandIcons";
import { fmtMoney, fmtNum, fmtPct } from "@/lib/api";
import { fmtDay, fmtLongDay, fmtMoneyCompact, fmtMoneyWhole, fmtRange, fmtRelative, fmtSpan, fmtWeekday, plural } from "./format";
import { Icon } from "./icons";
import { GoogleReportPanel } from "./googleReport";
import { MetaReportPanel } from "./metaReport";
import { Delta, Panel, Stat } from "./primitives";
import { ColumnsWithTotal, type Column } from "./salesBreakdown";
import type { AdsModule, Overview } from "./types";

// ---------------------------------------------------------------------------
// The Ads panel: what connected Meta and Google ad accounts spent, and what they say it brought.
// ---------------------------------------------------------------------------

const PLATFORM: Record<"meta" | "google", { name: string; Icon: (p: { size?: number }) => ReactNode }> = {
  meta: { name: "Meta", Icon: MetaIcon },
  google: { name: "Google Ads", Icon: GoogleIcon },
};

const B = ({ children }: { children: ReactNode }) => <strong className="font-semibold">{children}</strong>;
const x = (n: number | null) => (n === null ? "—" : `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(n)}×`);
const changeWords = (d: number | null) => (d === null ? "" : d === 0 ? ", the same as the period before" : `, ${d > 0 ? "up" : "down"} ${fmtPct(Math.abs(d))} on the period before`);

/** A change with no "good" direction (spending more isn't good or bad by itself). */
function Neutral({ value }: { value: number | null }) {
  if (value === null) return <span className="text-xs text-muted">nothing to compare with</span>;
  return (
    <span className="inline-flex w-fit items-center gap-1 rounded-full bg-border/60 px-2 py-0.5 text-xs text-muted">
      {value > 0 ? "▲" : value < 0 ? "▼" : "■"} {fmtPct(Math.abs(value))} <span className="opacity-80">vs before</span>
    </span>
  );
}

function SpendChart({ a, ov }: { a: AdsModule; ov: Overview }) {
  const money = (n: number) => fmtMoney(n, a.currency);
  const n = a.series.length;
  const max = Math.max(0, ...a.series.map((d) => d.spend));
  let running = 0;
  const columns: Column[] = a.series.map((d) => {
    running = Math.round((running + d.spend) * 100) / 100;
    const weekend = weekdayOf(d.day) >= 5;
    const today = d.day === ov.today;
    return {
      key: d.day,
      value: d.spend,
      fill: d.spend === max && max > 0 ? "var(--viz-tier-3)" : "var(--viz-tier-2)",
      faded: today,
      shaded: weekend,
      running,
      tick: {
        top: n <= 31 ? String(Number(d.day.slice(8))) : fmtDay(d.day, { year: false }),
        bottom: today ? "Today" : fmtWeekday(d.day),
        strong: weekend || today,
        major: n <= 31 || (n <= 120 ? weekdayOf(d.day) === 0 : d.day.endsWith("-01")),
      },
      label: d.spend ? fmtMoneyWhole(d.spend, a.currency) : undefined,
      keepLabel: d.spend === max && max > 0,
    };
  });
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
            <div className="mt-0.5 text-sm font-semibold tabular-nums">{money(d.spend)} spent</div>
            <div className="text-muted">{plural(d.clicks, "click")} · {plural(d.impressions, "view")}</div>
            {d.conversions > 0 && <div className="text-muted">{fmtNum(d.conversions)} purchases (platforms&apos; count)</div>}
          </>
        );
      }}
      describe={(i) => {
        const d = a.series[i]!;
        return `${fmtLongDay(d.day)}: ${money(d.spend)} spent, ${fmtNum(d.clicks)} clicks, ${fmtNum(d.conversions)} purchases.`;
      }}
      missingLabel="No data"
    />
  );
}

export function AdsDetail({ ov }: { ov: Overview }) {
  const a = ov.modules.ads!;
  const c = a.current;
  const money = (n: number) => fmtMoney(n, a.currency);
  const left = a.accounts.filter((acc) => !acc.counted);
  // Never synced: still fetching while the account is fine; stuck if its first sync failed.
  const waiting = a.accounts.filter((acc) => acc.counted && !acc.lastSyncedAt && acc.status === "active");
  const failing = a.accounts.filter((acc) => acc.counted && !acc.lastSyncedAt && acc.status !== "active");
  const split = a.byProvider.length > 1 ? a.byProvider.map((p) => `${PLATFORM[p.provider].name} ${money(p.spend)}`).join(", ") : null;

  return (
    <>
      <div className="card flex items-start gap-3 border-accent/30 bg-accent/5">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/12 text-accent">
          <Icon name="sparkle" className="h-4 w-4" />
        </span>
        <div className="min-w-0 space-y-1 text-sm leading-relaxed">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">In short</p>
          {failing.length > 0 && c.spend === 0 ? (
            <p>
              We couldn&apos;t read {failing.length === 1 ? "an ad account" : "some ad accounts"} yet.{" "}
              <Link className="text-accent underline" href="/settings/ads">Check them in Settings</Link>: they may need reconnecting.
            </p>
          ) : waiting.length > 0 && c.spend === 0 ? (
            <p>Your ad accounts are being read for the first time. Numbers appear here within a few minutes.</p>
          ) : (
            <>
              <p>
                You spent <B>{money(c.spend)}</B> on ads{split ? <> ({split})</> : null}{changeWords(a.deltas.spend)}.
              </p>
              <p>
                They brought <B>{plural(c.clicks, "click")}</B>{c.cpc !== null ? <>, about {money(c.cpc)} each</> : null}
                {c.conversions > 0 ? (
                  <>
                    , and by the platforms&apos; own count <B>{fmtNum(c.conversions)} purchases</B> worth {money(c.conversionValue)}: <B>{x(c.roas)}</B> what you spent.
                  </>
                ) : (
                  <>, and no purchases the platforms could attribute.</>
                )}
              </p>
              {a.shareOfSales !== null && (
                <p>
                  Ads cost <B>{fmtPct(a.shareOfSales)}</B> of your store&apos;s net sales in these dates.
                </p>
              )}
              {c.leads > 0 && <p>{plural(c.leads, "lead")} from lead forms too.</p>}
            </>
          )}
          {left.length > 0 && (
            <p className="text-muted">
              Not added in: {left.map((acc) => `${acc.name ?? acc.accountId} (${acc.currency})`).join(", ")}, because they&apos;re in another currency.
            </p>
          )}
        </div>
      </div>

      <Panel id="d-ads-glance" title="At a glance" help={`${fmtRange(ov.range.from, ov.range.to)}, against ${fmtRange(ov.previous.from, ov.previous.to)}. In ${a.currency}.`}>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Ad spend" value={money(c.spend)} note={<Neutral value={a.deltas.spend} />} />
          <Stat label="Clicks" value={fmtNum(c.clicks)} note={<Delta value={a.deltas.clicks} label="vs before" />} />
          <Stat label="Purchases (platforms' count)" value={fmtNum(c.conversions)} note={<Delta value={a.deltas.conversions} label="vs before" />} />
          <Stat label="Return on ad spend" value={x(c.roas)} note={<Delta value={a.deltas.roas} label="vs before" />} />
          <Stat label="Sales value (platforms' count)" value={money(c.conversionValue)} />
          <Stat label="Cost per purchase" value={c.costPerConversion !== null ? money(c.costPerConversion) : "—"} />
          <Stat label="Cost per click" value={c.cpc !== null ? money(c.cpc) : "—"} />
          <Stat label="Click-through rate" value={fmtPct(c.ctr)} note={`${fmtNum(c.impressions)} views`} />
          <Stat label="Cost per 1,000 views" value={c.cpm !== null ? money(c.cpm) : "—"} />
          <Stat label="Ads as share of sales" value={fmtPct(a.shareOfSales)} note="Ad spend ÷ your net sales" />
          {c.leads > 0 && <Stat label="Leads" value={fmtNum(c.leads)} />}
        </div>
      </Panel>

      {a.series.length > 1 && (
        <section className="card animate-rise min-w-0" data-testid="ads-daily">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">{fmtSpan(ov.range.from, ov.range.to)} · Ad spend per day</p>
          <p className="mt-1 text-3xl font-semibold">{money(c.spend)}</p>
          <ColumnsLegend />
          <SpendChart a={a} ov={ov} />
        </section>
      )}

      <Panel id="d-ads-platforms" title="By platform" help="Each platform's own numbers for these dates.">
        <div className="-mx-1 overflow-x-auto">
          <table className="w-full min-w-[34rem] text-sm">
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="px-1 pb-2 font-normal">Platform</th>
                <th className="px-1 pb-2 text-right font-normal">Spend</th>
                <th className="px-1 pb-2 text-right font-normal">Clicks</th>
                <th className="px-1 pb-2 text-right font-normal">Purchases</th>
                <th className="px-1 pb-2 text-right font-normal">Sales value</th>
                <th className="px-1 pb-2 text-right font-normal">Return</th>
                <th className="px-1 pb-2 text-right font-normal">Per purchase</th>
              </tr>
            </thead>
            <tbody>
              {a.byProvider.map((p) => {
                const P = PLATFORM[p.provider];
                return (
                  <tr key={p.provider} className="border-t border-border">
                    <td className="px-1 py-2"><span className="inline-flex items-center gap-2 font-medium"><P.Icon size={16} />{P.name}</span></td>
                    <td className="px-1 py-2 text-right tabular-nums">{money(p.spend)}</td>
                    <td className="px-1 py-2 text-right tabular-nums">{fmtNum(p.clicks)}</td>
                    <td className="px-1 py-2 text-right tabular-nums">{fmtNum(p.conversions)}</td>
                    <td className="px-1 py-2 text-right tabular-nums">{money(p.conversionValue)}</td>
                    <td className="px-1 py-2 text-right tabular-nums">{x(p.roas)}</td>
                    <td className="px-1 py-2 text-right tabular-nums">{p.costPerConversion !== null ? money(p.costPerConversion) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel id="d-ads-campaigns" title="Campaigns" help="The campaigns that spent most in these dates.">
        {a.campaigns.length === 0 ? (
          <p className="text-sm text-muted">No campaign spent anything in these dates.</p>
        ) : (
          <div className="-mx-1 overflow-x-auto">
            <table className="w-full min-w-[34rem] text-sm">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="px-1 pb-2 font-normal">Campaign</th>
                  <th className="px-1 pb-2 text-right font-normal">Spend</th>
                  <th className="px-1 pb-2 text-right font-normal">Clicks</th>
                  <th className="px-1 pb-2 text-right font-normal">Click rate</th>
                  <th className="px-1 pb-2 text-right font-normal">Purchases</th>
                  <th className="px-1 pb-2 text-right font-normal">Return</th>
                </tr>
              </thead>
              <tbody>
                {a.campaigns.map((cmp) => {
                  const P = PLATFORM[cmp.provider];
                  return (
                    <tr key={`${cmp.provider}:${cmp.accountId}:${cmp.campaignId}`} className="border-t border-border">
                      <td className="px-1 py-2">
                        <span className="inline-flex items-center gap-2"><P.Icon size={14} /><span className="font-medium">{cmp.name}</span></span>
                      </td>
                      <td className="px-1 py-2 text-right tabular-nums">{money(cmp.spend)}</td>
                      <td className="px-1 py-2 text-right tabular-nums">{fmtNum(cmp.clicks)}</td>
                      <td className="px-1 py-2 text-right tabular-nums">{fmtPct(cmp.ctr)}</td>
                      <td className="px-1 py-2 text-right tabular-nums">{fmtNum(cmp.conversions)}</td>
                      <td className="px-1 py-2 text-right tabular-nums">{x(cmp.roas)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {a.accounts.some((acc) => acc.provider === "google" && acc.status !== "reconnect") && <GoogleReportPanel ov={ov} accounts={a.accounts.filter((acc) => acc.status !== "reconnect")} />}
      {a.accounts.some((acc) => acc.provider === "meta" && acc.status !== "reconnect") && <MetaReportPanel ov={ov} accounts={a.accounts.filter((acc) => acc.status !== "reconnect")} />}

      <Panel id="d-ads-accounts" title="Ad accounts" help="Read-only. Turn accounts on or off, reconnect or disconnect them in Settings." aside={<Link className="text-xs text-accent underline" href="/settings/ads">Manage ad accounts</Link>}>
        <ul className="divide-y divide-border">
          {a.accounts.map((acc) => {
            const P = PLATFORM[acc.provider];
            return (
              <li key={acc.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <span className="inline-flex items-center gap-2"><P.Icon size={16} /><span className="font-medium">{acc.name ?? acc.accountId}</span><span className="text-xs text-muted">{acc.accountId}{acc.currency ? ` · ${acc.currency}` : ""}</span></span>
                <span className={`text-xs ${acc.status === "reconnect" ? "text-danger" : acc.status === "error" ? "text-warn" : "text-muted"}`}>
                  {acc.status === "reconnect" ? "Needs reconnecting" : acc.status === "error" ? "Sync problem" : acc.lastSyncedAt ? `Synced ${fmtRelative(acc.lastSyncedAt)}` : "Fetching history…"}
                </span>
              </li>
            );
          })}
        </ul>
        <p className="mt-3 text-xs text-muted">
          Purchases and their value are what Meta and Google each count for their own ads. A sale can be counted by both, and the numbers won&apos;t match your
          Shopify orders exactly; your store&apos;s own sales are on the Sales page.
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

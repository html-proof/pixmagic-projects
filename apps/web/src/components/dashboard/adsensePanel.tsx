"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import { weekdayOf } from "@app/shared/sales";
import { GoogleIcon } from "@/components/BrandIcons";
import { fmtMoney, fmtNum, fmtPct } from "@/lib/api";
import { fmtDay, fmtLongDay, fmtMoneyCompact, fmtMoneyWhole, fmtRange, fmtRelative, fmtSpan, fmtWeekday, plural } from "./format";
import { Icon } from "./icons";
import { Delta, Panel, Stat } from "./primitives";
import { ColumnsWithTotal, type Column } from "./salesBreakdown";
import type { AdsenseModule, Overview } from "./types";

// ---------------------------------------------------------------------------
// The Ad earnings panel: what connected Google AdSense accounts earned from ads shown on the site.
// The opposite of the Ads panel (money spent): the two are never added together.
// ---------------------------------------------------------------------------

const B = ({ children }: { children: ReactNode }) => <strong className="font-semibold">{children}</strong>;
const changeWords = (d: number | null) => (d === null ? "" : d === 0 ? ", the same as the period before" : `, ${d > 0 ? "up" : "down"} ${fmtPct(Math.abs(d))} on the period before`);
/** AdSense says "" when a report isn't split by site. */
const siteName = (s: string) => s || "All sites";

function EarningsChart({ a, ov }: { a: AdsenseModule; ov: Overview }) {
  const money = (n: number) => fmtMoney(n, a.currency);
  const n = a.series.length;
  const max = Math.max(0, ...a.series.map((d) => d.earnings));
  let running = 0;
  const columns: Column[] = a.series.map((d) => {
    running = Math.round((running + d.earnings) * 100) / 100;
    const weekend = weekdayOf(d.day) >= 5;
    const today = d.day === ov.today;
    return {
      key: d.day,
      value: d.earnings,
      fill: d.earnings === max && max > 0 ? "var(--viz-tier-3)" : "var(--viz-tier-2)",
      faded: today,
      shaded: weekend,
      running,
      tick: {
        top: n <= 31 ? String(Number(d.day.slice(8))) : fmtDay(d.day, { year: false }),
        bottom: today ? "Today" : fmtWeekday(d.day),
        strong: weekend || today,
        major: n <= 31 || (n <= 120 ? weekdayOf(d.day) === 0 : d.day.endsWith("-01")),
      },
      label: d.earnings ? fmtMoneyWhole(d.earnings, a.currency) : undefined,
      keepLabel: d.earnings === max && max > 0,
    };
  });
  return (
    <ColumnsWithTotal
      columns={columns}
      label={`AdSense earnings per day, ${fmtSpan(ov.range.from, ov.range.to)}, with the running total below`}
      fmtAxis={(v) => fmtMoneyCompact(v, a.currency)}
      runningLabel="Earned so far"
      fmtRunning={(v) => fmtMoneyWhole(v, a.currency)}
      tooltip={(i) => {
        const d = a.series[i]!;
        return (
          <>
            <div className="text-muted">{fmtLongDay(d.day)}{d.day === ov.today ? " · today so far" : ""}</div>
            <div className="mt-0.5 text-sm font-semibold tabular-nums">{money(d.earnings)} earned</div>
            <div className="text-muted">{plural(d.pageViews, "page view")} · {plural(d.clicks, "ad click")}</div>
          </>
        );
      }}
      describe={(i) => {
        const d = a.series[i]!;
        return `${fmtLongDay(d.day)}: ${money(d.earnings)} earned from ${fmtNum(d.pageViews)} page views and ${fmtNum(d.clicks)} ad clicks.`;
      }}
      missingLabel="No data"
    />
  );
}

export function AdsenseDetail({ ov }: { ov: Overview }) {
  const a = ov.modules.adsense!;
  const c = a.current;
  const money = (n: number) => fmtMoney(n, a.currency);
  const left = a.accounts.filter((acc) => !acc.counted);
  // Never synced: still fetching while the account is fine; stuck if its first sync failed.
  const waiting = a.accounts.filter((acc) => acc.counted && !acc.lastSyncedAt && acc.status === "active");
  const failing = a.accounts.filter((acc) => acc.counted && !acc.lastSyncedAt && acc.status !== "active");
  const empty = c.earnings === 0 && c.pageViews === 0;
  const bySite = a.sites.length > 1 || (a.sites.length === 1 && a.sites[0]!.site !== "");

  return (
    <>
      <div className="card flex items-start gap-3 border-accent/30 bg-accent/5">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/12 text-accent">
          <Icon name="sparkle" className="h-4 w-4" />
        </span>
        <div className="min-w-0 space-y-1 text-sm leading-relaxed">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">In short</p>
          {failing.length > 0 && empty ? (
            <p>
              We couldn&apos;t read your AdSense account yet. <Link className="text-accent underline" href="/settings/ads">Check it in Settings</Link>: it may need
              reconnecting.
            </p>
          ) : waiting.length > 0 && empty ? (
            <p>Your AdSense account is being read for the first time. Numbers appear here within a few minutes.</p>
          ) : (
            <>
              <p>
                Ads shown on your site earned <B>{money(c.earnings)}</B>{changeWords(a.deltas.earnings)}.
              </p>
              <p>
                That came from <B>{plural(c.pageViews, "page view")}</B>
                {c.pageRpm !== null ? <>, about <B>{money(c.pageRpm)}</B> for every 1,000 views</> : null}, and {plural(c.clicks, "click")} on the ads.
              </p>
              {a.vsSales !== null && c.earnings > 0 && (
                <p>
                  That&apos;s <B>{fmtPct(a.vsSales)}</B> on top of your store&apos;s net sales in these dates.
                </p>
              )}
            </>
          )}
          {left.length > 0 && (
            <p className="text-muted">
              Not added in: {left.map((acc) => `${acc.name ?? acc.accountId} (${acc.currency})`).join(", ")}, because they&apos;re in another currency.
            </p>
          )}
        </div>
      </div>

      <Panel id="d-adsense-glance" title="At a glance" help={`${fmtRange(ov.range.from, ov.range.to)}, against ${fmtRange(ov.previous.from, ov.previous.to)}. In ${a.currency}.`}>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Estimated earnings" value={money(c.earnings)} note={<Delta value={a.deltas.earnings} label="vs before" />} />
          <Stat label="Page views" value={fmtNum(c.pageViews)} note={<Delta value={a.deltas.pageViews} label="vs before" />} />
          <Stat label="Earnings per 1,000 views" value={c.pageRpm !== null ? money(c.pageRpm) : "—"} note={<Delta value={a.deltas.pageRpm} label="vs before" />} />
          <Stat label="Ad clicks" value={fmtNum(c.clicks)} note={<Delta value={a.deltas.clicks} label="vs before" />} />
          <Stat label="Ads shown" value={fmtNum(c.impressions)} />
          <Stat label="Click rate" value={fmtPct(c.ctr)} note="Clicks ÷ ads shown" />
          <Stat label="Earnings per click" value={c.perClick !== null ? money(c.perClick) : "—"} />
          <Stat label="Next to your sales" value={fmtPct(a.vsSales)} note="Ad earnings ÷ your net sales" />
        </div>
      </Panel>

      {a.series.length > 1 && (
        <section className="card animate-rise min-w-0" data-testid="adsense-daily">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">{fmtSpan(ov.range.from, ov.range.to)} · Earnings per day</p>
          <p className="mt-1 text-3xl font-semibold">{money(c.earnings)}</p>
          <EarningsChart a={a} ov={ov} />
        </section>
      )}

      {bySite && (
        <Panel id="d-adsense-sites" title="By site" help="Where the ads were shown, biggest earner first.">
          <div className="-mx-1 overflow-x-auto">
            <table className="w-full min-w-[30rem] text-sm">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="px-1 pb-2 font-normal">Site</th>
                  <th className="px-1 pb-2 text-right font-normal">Earnings</th>
                  <th className="px-1 pb-2 text-right font-normal">Page views</th>
                  <th className="px-1 pb-2 text-right font-normal">Per 1,000 views</th>
                  <th className="px-1 pb-2 text-right font-normal">Clicks</th>
                </tr>
              </thead>
              <tbody>
                {a.sites.map((s) => (
                  <tr key={s.site} className="border-t border-border">
                    <td className="px-1 py-2 font-medium">{siteName(s.site)}</td>
                    <td className="px-1 py-2 text-right tabular-nums">{money(s.earnings)}</td>
                    <td className="px-1 py-2 text-right tabular-nums">{fmtNum(s.pageViews)}</td>
                    <td className="px-1 py-2 text-right tabular-nums">{s.pageRpm !== null ? money(s.pageRpm) : "—"}</td>
                    <td className="px-1 py-2 text-right tabular-nums">{fmtNum(s.clicks)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      <Panel id="d-adsense-accounts" title="AdSense accounts" help="Read-only. Turn accounts on or off, reconnect or disconnect them in Settings." aside={<Link className="text-xs text-accent underline" href="/settings/ads">Manage ad accounts</Link>}>
        <ul className="divide-y divide-border">
          {a.accounts.map((acc) => (
            <li key={acc.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
              <span className="inline-flex items-center gap-2"><GoogleIcon size={16} /><span className="font-medium">{acc.name ?? acc.accountId}</span><span className="text-xs text-muted">{acc.accountId}{acc.currency ? ` · ${acc.currency}` : ""}</span></span>
              <span className={`text-xs ${acc.status === "reconnect" ? "text-danger" : acc.status === "error" ? "text-warn" : "text-muted"}`}>
                {acc.status === "reconnect" ? "Needs reconnecting" : acc.status === "error" ? "Sync problem" : acc.lastSyncedAt ? `Synced ${fmtRelative(acc.lastSyncedAt)}` : "Fetching history…"}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-muted">
          These are AdSense&apos;s estimated earnings: it finalizes each month&apos;s total after the month ends, so recent days can still change a little. They&apos;re
          money paid to you, kept apart from what you spend on ads.
        </p>
      </Panel>
    </>
  );
}

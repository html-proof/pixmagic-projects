"use client";
import Link from "next/link";
import { useState } from "react";
import { adsenseFinalThrough, type AdsenseReportLevel, type AdsenseTotals } from "@app/shared/ads";
import { useApp } from "@/components/AppContext";
import { GoogleIcon } from "@/components/BrandIcons";
import { LoadError } from "@/components/LoadError";
import { ApiError, fmtMoney, fmtNum, fmtPct, useApi } from "@/lib/api";
import {
  AccountStatus,
  accountGroups,
  ADSENSE_DEFINITIONS,
  ADSENSE_REPORT_DEFINITIONS,
  AdStatusNotes,
  dailyMoneyColumns,
  Definitions,
  earningsLabel,
  EarningsState,
  missingReasons,
  timeZoneNote,
  UNAVAILABLE,
} from "./AdsCommon";
import { shownFigures, upToWords } from "./adFigures";
import { fmtDay, fmtLongDay, fmtMoneyCompact, fmtMoneyWhole, fmtRange, fmtSpan, plural } from "./format";
import { Icon } from "./Icons";
import { B } from "./Narrative";
import { Panel, Stat } from "./Primitives";
import { ColumnsWithTotal } from "./ColumnsWithTotal";
import type { AdAccount, AdsenseModule, AdsenseReportAnswer, Overview } from "./types";

// ---------------------------------------------------------------------------
// The Ad earnings panel: what connected Google AdSense accounts estimate the ads on the store's
// sites earned. The opposite of the Ads panel (money spent): the two are never added together.
// Only the sites chosen as the store's count; days AdSense wasn't read for are missing, never $0.
// ---------------------------------------------------------------------------

/** AdSense says "" when a report isn't split by site. */
const siteName = (s: string) => s || "All sites";

function EarningsChart({ a, ov }: { a: AdsenseModule; ov: Overview }) {
  const money = (n: number) => fmtMoney(n, a.currency);
  const columns = dailyMoneyColumns(a.series, (d) => d.earnings, ov.today, a.currency);
  // A day on or before the one every account's figures are final up to is AdSense's final figure.
  const kind = (day: string) => (a.finalThrough && day <= a.finalThrough ? "final" : "estimated");
  return (
    <ColumnsWithTotal
      columns={columns}
      label={`AdSense estimated earnings per day, ${fmtSpan(ov.range.from, ov.range.to)}, with the running total below`}
      fmtAxis={(v) => fmtMoneyCompact(v, a.currency)}
      runningLabel="Estimated so far"
      fmtRunning={(v) => fmtMoneyWhole(v, a.currency)}
      tooltip={(i) => {
        const d = a.series[i]!;
        return (
          <>
            <div className="text-muted">{fmtLongDay(d.day)}{d.day === ov.today ? " · today so far" : ""}</div>
            {d.earnings === null ? (
              <div className="mt-0.5 text-sm font-semibold">No figures for this day yet</div>
            ) : (
              <>
                <div className="mt-0.5 text-sm font-semibold tabular-nums">
                  {money(d.earnings)} {kind(d.day)}
                </div>
                <div className="text-muted">{plural(d.pageViews ?? 0, "page view")} · {plural(d.clicks ?? 0, "ad click")}</div>
              </>
            )}
          </>
        );
      }}
      describe={(i) => {
        const d = a.series[i]!;
        if (d.earnings === null) return `${fmtLongDay(d.day)}: no figures for this day yet.`;
        return `${fmtLongDay(d.day)}: ${money(d.earnings)} ${kind(d.day)} from ${fmtNum(d.pageViews)} page views and ${fmtNum(d.clicks)} ad clicks.`;
      }}
      missingLabel="No data"
    />
  );
}

function Glance({ a, t }: { a: AdsenseModule; t: AdsenseTotals }) {
  const money = (n: number) => fmtMoney(n, a.currency);
  const rpm = t.impressions > 0 ? (t.earnings * 1000) / t.impressions : null;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Stat label={earningsLabel(a.final)} value={money(t.earnings)} />
      <Stat label="Page views" value={fmtNum(t.pageViews)} />
      <Stat label="Page RPM" value={t.pageRpm !== null ? money(t.pageRpm) : "—"} note="Earnings per 1,000 page views" />
      <Stat label="Clicks" value={fmtNum(t.clicks)} />
      <Stat label="Impressions" value={fmtNum(t.impressions)} note="Ad requests that delivered at least one ad" />
      <Stat label="Click-through rate" value={fmtPct(t.ctr)} note="Clicks ÷ impressions" />
      <Stat label="Earnings per click" value={t.perClick !== null ? money(t.perClick) : "—"} />
      <Stat label="Impression RPM" value={rpm !== null ? money(rpm) : "—"} note="Earnings per 1,000 impressions" />
      {/* Every day of the range only: the store's sales include the days still to come in. */}
      {a.current && <Stat label="Next to your sales" value={fmtPct(a.vsSales)} note="Estimated earnings ÷ your net sales" />}
    </div>
  );
}

const REPORT_LEVELS: Array<{ id: Extract<AdsenseReportLevel, "country" | "platform" | "ad_unit">; label: string; one: string; note: string }> = [
  { id: "country", label: "By country", one: "Country", note: "Countries are where the visitors who saw the ads were." },
  { id: "platform", label: "By device type", one: "Device type", note: "Device types are AdSense's own: computers, high-end phones, tablets and others." },
  { id: "ad_unit", label: "By ad unit", one: "Ad unit", note: "Ad units are named as in your AdSense account." },
];

/**
 * One AdSense account split by country, device type or ad unit, asked of AdSense for exactly the
 * dates picked (GET .../ads/adsense/report), with AdSense's ad requests, coverage and Active View
 * viewability beside the earnings (read for this report only and cached briefly, never stored with the
 * days; "—" when AdSense won't give them for the split). Read-only, and only for members who may see
 * the other live reports ("View campaigns" in Team & Access).
 */
function AdsenseReportTables({ ov, accounts, currency }: { ov: Overview; accounts: AdAccount[]; currency: string }) {
  const { workspace } = useApp();
  const [connection, setConnection] = useState(accounts[0]?.id ?? "");
  const [level, setLevel] = useState<(typeof REPORT_LEVELS)[number]["id"]>("country");
  const chosen = accounts.find((a) => a.id === connection) ?? accounts[0];
  const qs = chosen ? new URLSearchParams({ connection: chosen.id, level, from: ov.range.from, to: ov.range.to }) : null;
  const report = useApi<AdsenseReportAnswer>(qs ? `/workspaces/${workspace.id}/stores/${ov.store.id}/ads/adsense/report?${qs}` : null);
  if (!chosen) return null;
  const r = report.data?.report;
  const money = (n: number | null) => (n === null ? "—" : fmtMoney(n, r?.currency ?? chosen.currency ?? currency));
  const notThere = report.error instanceof ApiError && report.error.status === 404;
  const shownLevel = REPORT_LEVELS.find((l) => l.id === (r?.level ?? level));
  const one = shownLevel?.one ?? "Split";
  // The report is limited to the store's chosen sites, as every other AdSense figure here (empty: every site).
  const sites = r?.sites ?? chosen.sites ?? [];
  // Read from AdSense on the account's `today`: final for the months AdSense had finalized by then.
  const finalThrough = report.data ? adsenseFinalThrough(report.data.today) : null;
  const final = r ? finalThrough !== null && r.until <= finalThrough : undefined;
  return (
    <Panel
      id="d-adsense-report"
      title="Where the earnings came from"
      help={`${fmtRange(ov.range.from, ov.range.to)}, straight from AdSense (days in the account's time zone). ${final ? "Final earnings." : "Estimated earnings."} Read-only.`}
      aside={
        accounts.length > 1 ? (
          <label className="flex items-center gap-2 text-xs text-muted">
            AdSense account
            <select className="input h-8 py-0 text-sm" value={chosen.id} onChange={(e) => setConnection(e.target.value)} data-testid="adsense-report-account">
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name ?? a.accountId}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span className="text-xs text-muted">{chosen.name ?? chosen.accountId}</span>
        )
      }
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div role="tablist" aria-label="Split by" className="inline-flex flex-wrap rounded-lg border border-border p-0.5">
          {REPORT_LEVELS.map((l) => (
            <button
              key={l.id}
              type="button"
              role="tab"
              aria-selected={level === l.id}
              className={`rounded-md px-3 py-1 text-sm ${level === l.id ? "bg-surface font-semibold shadow-sm" : "text-muted"}`}
              onClick={() => setLevel(l.id)}
              data-testid={`adsense-report-${l.id}`}
            >
              {l.label}
            </button>
          ))}
        </div>
        <EarningsState final={final} />
      </div>
      {notThere ? (
        <p className="text-sm text-muted">This split isn&apos;t available for this account yet.</p>
      ) : report.error && !r ? (
        <LoadError what="the AdSense breakdown" error={report.error} onRetry={() => void report.reload()} busy={report.loading} />
      ) : !r ? (
        <div className="skeleton h-40" aria-hidden="true" />
      ) : (
        <>
          <div className={`-mx-1 overflow-x-auto ${report.loading ? "opacity-60" : ""}`} aria-busy={report.loading}>
            <table className="w-full min-w-[58rem] text-sm" data-testid="adsense-report-table">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="px-2 pb-2 font-normal">{one}</th>
                  <th className="px-2 pb-2 text-right font-normal">{earningsLabel(final)}</th>
                  <th className="px-2 pb-2 text-right font-normal">Page views</th>
                  <th className="px-2 pb-2 text-right font-normal">Page RPM</th>
                  <th className="px-2 pb-2 text-right font-normal">Ad requests</th>
                  <th className="px-2 pb-2 text-right font-normal">Coverage</th>
                  <th className="px-2 pb-2 text-right font-normal">Impressions</th>
                  <th className="px-2 pb-2 text-right font-normal">Active View viewable</th>
                  <th className="px-2 pb-2 text-right font-normal">Clicks</th>
                  <th className="px-2 pb-2 text-right font-normal">Click-through rate</th>
                </tr>
              </thead>
              <tbody>
                {[{ id: "__total", name: sites.length ? "This store's sites" : "Whole account", ...r.totals }, ...r.rows].map((row) => (
                  <tr key={row.id} className={`border-t border-border ${row.id === "__total" ? "bg-surface font-medium" : ""}`}>
                    <td className="max-w-[16rem] truncate px-2 py-2" title={row.name}>
                      {row.name}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">{money(row.earnings)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{fmtNum(row.pageViews)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{money(row.pageRpm)}</td>
                    {/* Ad requests, coverage and viewability: "—" when AdSense didn't send them (or an older answer). */}
                    <td className="px-2 py-2 text-right tabular-nums">{fmtNum(row.adRequests)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{fmtPct(row.coverage)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{fmtNum(row.impressions)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{fmtPct(row.viewability)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{fmtNum(row.clicks)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{row.ctr === null ? "—" : fmtPct(row.ctr)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {r.rows.length === 0 && <p className="mt-2 text-sm text-muted">AdSense has no earnings to split for these dates.</p>}
          {r.truncated && <p className="mt-2 text-xs text-muted">Showing the {r.rows.length} that earned most.</p>}
          <p className="mt-2 text-xs text-muted">
            {shownLevel ? `${shownLevel.note} ` : ""}
            {sites.length ? `Only the sites chosen as this store's: ${sites.join(", ")}.` : "Every site on the account counts as this store's."}
          </p>
          <Definitions items={ADSENSE_REPORT_DEFINITIONS} title="What the report's other figures mean" />
        </>
      )}
    </Panel>
  );
}

export function AdsenseDetail({ ov }: { ov: Overview }) {
  const { allowed } = useApp();
  const a = ov.modules.adsense!;
  // The whole range, or while only days not over yet are missing, the days so far (up to `upTo`).
  const { totals: c, through: upTo } = shownFigures(a);
  const money = (n: number) => fmtMoney(n, a.currency);
  const { left } = accountGroups(a.accounts);
  const counted = a.accounts.filter((acc) => acc.counted);
  const reasons = missingReasons(counted, ov.range);
  const bySite = a.sites.length > 1 || (a.sites.length === 1 && a.sites[0]!.site !== "");
  const shown = c ?? a.partial?.totals ?? null;
  const readable = counted.filter((acc) => acc.status !== "reconnect" && acc.status !== "permission");

  return (
    <>
      <AdStatusNotes accounts={a.accounts} manage={allowed("integrations.manage")} />
      <div className="card flex items-start gap-3 border-accent/30 bg-accent/5">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/12 text-accent">
          <Icon name="sparkle" className="h-4 w-4" />
        </span>
        <div className="min-w-0 space-y-1 text-sm leading-relaxed">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">In short</p>
          {!c ? (
            <p>
              These dates&apos; AdSense figures aren&apos;t complete, so no total is shown for them. {reasons.join(" ")}
              {a.partial ? (
                <>
                  {" "}
                  For {fmtSpan(a.partial.from, a.partial.to)}, {a.final ? "AdSense's final figure is" : "AdSense estimates"} <B>{money(a.partial.totals.earnings)}</B>.
                </>
              ) : null}{" "}
              <Link className="text-accent underline" href="/settings/ads">
                Check it in Settings
              </Link>
              .
            </p>
          ) : (
            <>
              <p>
                {a.final ? "The ads on your site earned" : "AdSense estimates the ads on your site earned"} <B>{money(c.earnings)}</B>
                {upTo ? <> up to {fmtDay(upTo, { year: false })}</> : null}.{a.final ? " AdSense has finalized these figures." : ""}
              </p>
              {upTo && reasons.length > 0 && <p className="text-muted">{reasons.join(" ")}</p>}
              <p>
                That came from <B>{plural(c.pageViews, "page view")}</B>
                {c.pageRpm !== null ? (
                  <>
                    , about <B>{money(c.pageRpm)}</B> for every 1,000 page views
                  </>
                ) : null}
                , and {plural(c.clicks, "click")} on the ads.
              </p>
              {a.vsSales !== null && c.earnings > 0 && (
                <p>
                  That&apos;s <B>{fmtPct(a.vsSales)}</B> on top of your store&apos;s net sales in these dates.
                </p>
              )}
            </>
          )}
          {timeZoneNote(counted) && <p className="text-muted">{timeZoneNote(counted)}</p>}
          {(a.sitesLeftOut?.length ?? 0) > 0 && (
            <p className="text-muted">
              Not counted: {a.sitesLeftOut!.map((s) => `${siteName(s.site)} (${money(s.earnings)})`).join(", ")}, other sites on the same AdSense account that
              aren&apos;t chosen as this store&apos;s.
            </p>
          )}
          {left.length > 0 && (
            <p className="text-muted">
              Not added in: {left.map((acc) => `${acc.name ?? acc.accountId} (${acc.currency ?? "currency not known yet"})`).join(", ")}, because they&apos;re in another currency.
            </p>
          )}
        </div>
      </div>

      <Panel
        id="d-adsense-glance"
        title="At a glance"
        aside={shown ? <EarningsState final={a.final} /> : undefined}
        help={
          <>
            {upTo
              ? `${fmtRange(ov.range.from, upTo)}, the days so far`
              : c || !a.partial
                ? fmtRange(ov.range.from, ov.range.to)
                : `${fmtRange(a.partial.from, a.partial.to)} only, the days every account has`}
            . In {a.currency}.
          </>
        }
      >
        {shown ? (
          <Glance a={a} t={shown} />
        ) : (
          <div className="space-y-1 text-sm text-muted">
            <p className="text-xl font-semibold text-text">{UNAVAILABLE}</p>
            {reasons.map((r) => (
              <p key={r}>{r}</p>
            ))}
          </div>
        )}
        <Definitions items={ADSENSE_DEFINITIONS} />
      </Panel>

      {a.series.length > 1 && (
        <section className="card animate-rise min-w-0" data-testid="adsense-daily">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">
            {fmtSpan(ov.range.from, ov.range.to)} · {a.final ? "Earnings per day" : "Estimated earnings per day"}
          </p>
          <p className="mt-1 text-3xl font-semibold">{c ? money(c.earnings) : UNAVAILABLE}</p>
          {upTo && <p className="text-xs text-muted">Estimated {upToWords(upTo)}. Days with no figures yet are marked, not drawn as $0.</p>}
          {c && !upTo && a.finalThrough && a.finalThrough >= ov.range.from && !a.final && (
            <p className="text-xs text-muted">Final up to {fmtDay(a.finalThrough, { year: false })}; the days after are AdSense&apos;s estimate.</p>
          )}
          {!c && <p className="text-xs text-muted">Days with no figures yet are marked, not drawn as $0.</p>}
          <EarningsChart a={a} ov={ov} />
        </section>
      )}

      {bySite && (
        <Panel id="d-adsense-sites" title="By site" help="The store's sites the ads were shown on, biggest earner first.">
          <div className="-mx-1 overflow-x-auto">
            <table className="w-full min-w-[30rem] text-sm">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="px-1 pb-2 font-normal">Site</th>
                  <th className="px-1 pb-2 text-right font-normal">{earningsLabel(a.final)}</th>
                  <th className="px-1 pb-2 text-right font-normal">Page views</th>
                  <th className="px-1 pb-2 text-right font-normal">Page RPM</th>
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
          {!c && <p className="mt-2 text-xs text-muted">Only the days AdSense has been read for.</p>}
        </Panel>
      )}

      {/* The live breakdown needs what the other live reports need ("View campaigns" in Team & Access). */}
      {allowed("marketing.campaigns") && readable.length > 0 && <AdsenseReportTables ov={ov} accounts={readable} currency={a.currency} />}

      <Panel id="d-adsense-accounts" title="AdSense accounts" help="Read-only. Turn accounts on or off, choose the store's sites, reconnect or disconnect them in Settings." aside={<Link className="text-xs text-accent underline" href="/settings/ads">Manage ad accounts</Link>}>
        <ul className="divide-y divide-border">
          {a.accounts.map((acc) => (
            <li key={acc.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
              <span className="inline-flex items-center gap-2">
                <GoogleIcon size={16} />
                <span className="font-medium">{acc.name ?? acc.accountId}</span>
                <span className="text-xs text-muted">
                  {acc.accountId}
                  {acc.currency ? ` · ${acc.currency}` : ""}
                  {acc.sites?.length ? ` · ${acc.sites.join(", ")}` : " · every site"}
                  {acc.finalThrough ? ` · final up to ${fmtDay(acc.finalThrough)}` : ""}
                </span>
              </span>
              <AccountStatus acc={acc} />
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-muted">
          AdSense estimates earnings as they come in and finalizes each month&apos;s in the first days of the next. bizinsights reads the whole month before again
          during the first ten days of every month, so a month&apos;s figures show as final once that&apos;s done; anything later is AdSense&apos;s estimate and can still
          change. Earnings are kept apart from what you spend on ads.
        </p>
      </Panel>
    </>
  );
}

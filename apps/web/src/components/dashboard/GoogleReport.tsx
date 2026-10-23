"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { GoogleReportLevel, GoogleReportMetrics, GoogleReportRow } from "@app/shared/ads";
import { useApp } from "@/components/AppContext";
import { Alert } from "@/components/ui";
import { actionError, api, ApiError, fmtMoney, fmtNum, fmtPct } from "@/lib/api";
import { DemoChip } from "./Advertising";
import { Definitions, LongRangeNote, reportTooLong } from "./AdsCommon";
import { fmtRange, fmtSpan } from "./format";
import { Badge, Panel, type Tone } from "./Primitives";
import { ReportChange, reportChange } from "./ReportCompare";
import type { AdsModule, Overview } from "./types";

// ---------------------------------------------------------------------------
// The Google Ads report: campaigns (with status, type and budget), ad groups, devices and countries
// for the dates picked, asked of Google for exactly those dates (GET .../ads/google/report).
// Read-only: there is nothing here that changes a campaign. When the answer carries the dates
// compared with (`comparison`), each row shows its change; the dates picked must have ended, so
// a day still running is never set against whole days.
// ---------------------------------------------------------------------------

interface Report {
  level: GoogleReportLevel;
  since: string;
  until: string;
  totals: GoogleReportMetrics;
  rows: GoogleReportRow[];
  truncated: boolean;
  /** The dates compared with, when asked for and given: their totals and each row's figures (by id). */
  comparison?: { since: string; until: string; totals: GoogleReportMetrics; rows: Array<{ id: string } & Partial<GoogleReportMetrics>> };
}
interface Answer {
  account: { id: string; accountId: string; name: string | null; currency: string | null; timezone: string | null };
  today: string;
  cached: boolean;
  report: Report;
}

const LEVELS: Array<{ id: GoogleReportLevel; label: string; one: string }> = [
  { id: "campaign", label: "Campaigns", one: "Campaign" },
  { id: "ad_group", label: "Ad groups", one: "Ad group" },
  { id: "device", label: "Devices", one: "Device" },
  { id: "country", label: "Countries", one: "Country" },
];

function statusOf(s: string | null): { label: string; tone: Tone } | null {
  if (!s) return null;
  if (s === "ENABLED") return { label: "Active", tone: "good" };
  if (s === "PAUSED") return { label: "Paused", tone: "neutral" };
  if (s === "REMOVED") return { label: "Removed", tone: "neutral" };
  return { label: s.toLowerCase().replace(/_/g, " "), tone: "neutral" };
}

/** Google's campaign types in everyday words. */
const CHANNEL: Record<string, string> = {
  SEARCH: "Search",
  SHOPPING: "Shopping",
  PERFORMANCE_MAX: "Performance Max",
  DISPLAY: "Display",
  VIDEO: "YouTube",
  DEMAND_GEN: "Demand Gen",
  DISCOVERY: "Discovery",
  MULTI_CHANNEL: "App",
  LOCAL: "Local",
  SMART: "Smart",
  HOTEL: "Hotel",
  TRAVEL: "Travel",
};

const NA = "—";
const times = (n: number | null) => (n === null ? NA : `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(n)}×`);

function Cells({ m, money }: { m: GoogleReportMetrics; money: (n: number | null) => string }) {
  const td = "px-2 py-2 text-right tabular-nums";
  return (
    <>
      <td className={td}>{money(m.spend)}</td>
      <td className={td}>{fmtNum(m.impressions)}</td>
      <td className={td}>{fmtNum(m.clicks)}</td>
      <td className={td}>{m.ctr === null ? NA : fmtPct(m.ctr)}</td>
      <td className={td}>{money(m.cpc)}</td>
      <td className={td}>{money(m.cpm)}</td>
      <td className={td}>{fmtNum(m.conversions)}</td>
      <td className={td}>{money(m.costPerConversion)}</td>
      <td className={td}>{money(m.conversionValue)}</td>
      <td className={td}>{times(m.roas)}</td>
    </>
  );
}

// Google's own column names where they differ from everyday words: its conversions count every
// conversion action, so their value ÷ cost is "Conv. value / cost", not a return on purchases.
const HEADINGS = ["Spent", "Impressions", "Clicks", "Click-through rate", "Per click", "Per 1,000 impressions", "Conversions (all actions)", "Per conversion", "Conversion value", "Conv. value / cost"];

const DEFINITIONS: Array<[string, string]> = [
  ["Click-through rate", "Clicks ÷ impressions."],
  ["Per click", "Spend ÷ clicks (Google's average CPC)."],
  ["Per 1,000 impressions", "Spend × 1,000 ÷ impressions (CPM)."],
  ["Conversions (all actions)", "Google's own count of every conversion action set to count: purchases, and also leads, sign-ups, calls. Not your Shopify orders."],
  ["Per conversion", "Spend ÷ conversions."],
  ["Conv. value / cost", "Conversion value ÷ spend, on every conversion action. The Google Ads card's ROAS is on purchases only."],
];

export function GoogleReportPanel({ ov, accounts }: { ov: Overview; accounts: AdsModule["accounts"] }) {
  const { workspace } = useApp();
  const google = accounts.filter((a) => a.provider === "google");
  const [connection, setConnection] = useState(google[0]?.id ?? "");
  const [level, setLevel] = useState<GoogleReportLevel>("campaign");
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [error, setError] = useState<{ message: string; reconnect: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const { from, to } = ov.range;
  // Changes only for dates that are over: a day still running against whole days reads as a drop.
  const ended = to < ov.today;
  const cfrom = ended ? ov.previous.from : null;
  const cto = ended ? ov.previous.to : null;
  const chosen = google.find((a) => a.id === connection) ?? google[0];
  const tooLong = reportTooLong(ov.range);

  useEffect(() => {
    if (!chosen || tooLong) return;
    let live = true;
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams({ connection: chosen.id, level, from, to, ...(cfrom && cto ? { cfrom, cto } : {}) });
    api<Answer>(`/workspaces/${workspace.id}/stores/${ov.store.id}/ads/google/report?${qs}`)
      .then((a) => live && setAnswer(a))
      .catch((e: unknown) => {
        if (!live) return;
        setAnswer(null);
        setError({ message: actionError(e, "load the Google Ads report"), reconnect: e instanceof ApiError && e.code === "reconnect" });
      })
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
    // The account's status changes on every poll; only a different question asks Google again.
  }, [workspace.id, ov.store.id, chosen?.id, level, from, to, cfrom, cto, tooLong]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!chosen) return null;
  if (tooLong) {
    return (
      <Panel id="d-google-report" title="Google Ads report" help={`${fmtRange(from, to)}.`}>
        <LongRangeNote name="Google Ads" />
      </Panel>
    );
  }
  const r = answer?.report;
  const currency = answer?.account.currency ?? chosen.currency ?? "USD";
  const money = (n: number | null) => (n === null ? NA : fmtMoney(n, currency));
  const includesToday = !!answer && to >= answer.today;
  const current = LEVELS.find((l) => l.id === (r?.level ?? level))!;
  const cmp = r?.comparison;
  const before = new Map((cmp?.rows ?? []).map((row) => [row.id, row]));

  return (
    <Panel
      id="d-google-report"
      title="Google Ads report"
      help={
        chosen.demo
          ? `${fmtRange(from, to)}, generated by bizinsights for the demo account (simulated, nothing read from Google). In ${currency}.`
          : `${fmtRange(from, to)}, straight from Google${answer?.account.timezone ? ` (days in the ad account's time zone, ${answer.account.timezone})` : ""}. In ${currency}. Read-only.`
      }
      aside={
        google.length > 1 ? (
          <label className="flex items-center gap-2 text-xs text-muted">
            Ad account
            <select className="input h-8 py-0 text-sm" value={chosen.id} onChange={(e) => setConnection(e.target.value)} data-testid="google-report-account">
              {google.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name ?? a.accountId}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span className="inline-flex items-center gap-2 text-xs text-muted">
            {chosen.name ?? chosen.accountId}
            {chosen.demo && <DemoChip small />}
          </span>
        )
      }
    >
      <div role="tablist" aria-label="Report level" className="mb-3 inline-flex flex-wrap rounded-lg border border-border p-0.5">
        {LEVELS.map((l) => (
          <button
            key={l.id}
            type="button"
            role="tab"
            aria-selected={level === l.id}
            className={`rounded-md px-3 py-1 text-sm ${level === l.id ? "bg-surface font-semibold shadow-sm" : "text-muted"}`}
            onClick={() => setLevel(l.id)}
            data-testid={`google-report-${l.id}`}
          >
            {l.label}
          </button>
        ))}
      </div>

      {error ? (
        <Alert kind={error.reconnect ? "error" : "info"}>
          {error.message}{" "}
          {error.reconnect && (
            <Link className="font-medium underline" href="/settings/ads">
              Reconnect Google Ads
            </Link>
          )}
        </Alert>
      ) : !r ? (
        <div className="skeleton h-40" aria-hidden="true" />
      ) : (
        <>
          {includesToday && (
            <p className="mb-2 text-xs text-muted">Today&apos;s numbers are still coming in: Google takes up to a few hours to report clicks and spend, and longer for conversions.</p>
          )}
          <div className={`-mx-1 overflow-x-auto ${loading ? "opacity-60" : ""}`} aria-busy={loading}>
            <table className="w-full min-w-[64rem] text-sm" data-testid="google-report-table">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="px-2 pb-2 font-normal">{current.one}</th>
                  {HEADINGS.map((h) => (
                    <th key={h} className="px-2 pb-2 text-right font-normal">
                      {h}
                    </th>
                  ))}
                  {cmp && <th className="px-2 pb-2 text-right font-normal">Spend vs before</th>}
                  {cmp && <th className="px-2 pb-2 text-right font-normal">Conversions vs before</th>}
                </tr>
              </thead>
              <tbody>
                <tr className="border-t border-border bg-surface font-medium">
                  <td className="px-2 py-2">Whole ad account</td>
                  <Cells m={r.totals} money={money} />
                  {cmp && <ReportChange value={reportChange(r.totals.spend, cmp.totals.spend)} neutral />}
                  {cmp && <ReportChange value={reportChange(r.totals.conversions, cmp.totals.conversions)} />}
                </tr>
                {cmp && (
                  <tr className="border-t border-border text-muted" data-testid="google-report-before">
                    <td className="px-2 py-2">Before ({fmtSpan(cmp.since, cmp.until)})</td>
                    <Cells m={cmp.totals} money={money} />
                    <td />
                    <td />
                  </tr>
                )}
                {r.rows.map((row) => {
                  const s = statusOf(row.status);
                  const details = [
                    row.campaignName,
                    row.channel ? (CHANNEL[row.channel] ?? row.channel.toLowerCase().replace(/_/g, " ")) : null,
                    row.dailyBudget !== null ? `budget ${money(row.dailyBudget)} a day` : null,
                  ].filter(Boolean);
                  const was = before.get(row.id);
                  return (
                    <tr key={row.id} className="border-t border-border">
                      <td className="max-w-[18rem] px-2 py-2">
                        <span className="block truncate font-medium" title={row.name}>
                          {row.name}
                        </span>
                        {(s || details.length > 0) && (
                          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                            {s && <Badge tone={s.tone}>{s.label}</Badge>}
                            {details.length > 0 && <span className="truncate">{details.join(" · ")}</span>}
                          </span>
                        )}
                      </td>
                      <Cells m={row} money={money} />
                      {cmp && <ReportChange value={reportChange(row.spend, was?.spend)} neutral />}
                      {cmp && <ReportChange value={reportChange(row.conversions, was?.conversions)} />}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {r.rows.length === 0 &&
            (r.totals.impressions === 0 && r.totals.spend === 0 ? (
              <p className="mt-2 text-sm text-muted">Nothing in this ad account was shown to anyone in these dates.</p>
            ) : r.level === "ad_group" ? (
              <p className="mt-2 text-sm text-muted">No ad groups had any activity in these dates: Performance Max campaigns have no ad groups, so their spend is on the Campaigns tab.</p>
            ) : (
              <p className="mt-2 text-sm text-muted">Google has no split at this level for these dates; the account&apos;s activity is in the Whole ad account row above.</p>
            ))}
          {r.truncated && <p className="mt-2 text-xs text-muted">Showing the {r.rows.length} that spent most.</p>}
          <ul className="mt-3 list-disc space-y-1 pl-4 text-xs text-muted">
            <li>
              Conversions and their value are Google&apos;s own count of every conversion action it&apos;s set to count (purchases, and also leads, sign-ups or calls),
              using each action&apos;s attribution settings. They are not your Shopify orders, they can overlap with what Meta claims, and they aren&apos;t added into your
              store&apos;s sales.
            </li>
            {cmp ? (
              <li>Changes compare with {fmtSpan(cmp.since, cmp.until)}, as Google reports those dates now.</li>
            ) : !ended ? (
              <li>Changes show once the dates picked are over: today is still running, so it isn&apos;t set against whole days.</li>
            ) : null}
            {r.level === "ad_group" && r.rows.length > 0 && <li>Performance Max campaigns have no ad groups, so their spend shows on the Campaigns tab but not here.</li>}
            {r.level === "country" && <li>Countries are where the people who saw your ads were, not the places your campaigns target.</li>}
            {answer && (chosen.demo ? <li>Generated by bizinsights from the demo&apos;s seed: the same figures every time, and nothing fetched from Google.</li> : <li>{answer.cached ? "Fetched from Google in the last few minutes." : "Fetched from Google just now."}</li>)}
          </ul>
          <Definitions items={DEFINITIONS} />
        </>
      )}
    </Panel>
  );
}

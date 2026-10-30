"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { googleAdName, googleAdTypeLabel, isGoogleObjectId, type GoogleReportLevel, type GoogleReportMetrics, type GoogleReportRow } from "@app/shared/ads";
import { isDemoObjectId } from "@app/shared/adsDemo";
import { useApp } from "@/components/AppContext";
import { Alert } from "@/components/ui";
import { actionError, api, ApiError, fmtMoney, fmtNum, fmtPct } from "@/lib/api";
import { DemoChip } from "./Advertising";
import { Definitions } from "./AdsCommon";
import { fmtRange, fmtSpan } from "./format";
import { Badge, Panel, type Tone } from "./Primitives";
import { DrillCrumbs, OpenRow, useReportDrill } from "./ReportDrill";
import { ReportChange, reportChange } from "./ReportCompare";
import type { AdsModule, Overview } from "./types";

// ---------------------------------------------------------------------------
// The Google Ads report: campaigns (with status, type and budget), ad groups, devices and countries
// for the dates picked, asked of Google for exactly those dates (GET .../ads/google/report).
// Read-only: there is nothing here that changes a campaign. When the answer carries the dates
// compared with (`comparison`), each row shows its change; the dates picked must have ended, so
// a day still running is never set against whole days. A campaign opens to its ad groups (a
// Performance Max campaign to its asset groups), an ad group to its ads (?campaign=&adgroup=,
// ReportDrill), with those rows added up on top.
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

/** The whole account's tabs. */
const LEVELS: Array<{ id: GoogleReportLevel; label: string }> = [
  { id: "campaign", label: "Campaigns" },
  { id: "ad_group", label: "Ad groups" },
  { id: "device", label: "Devices" },
  { id: "country", label: "Countries" },
];

/** What one row is, at every level (asset groups and ads are only read down from a campaign or an ad group). */
const ONE: Record<GoogleReportLevel, string> = { campaign: "Campaign", ad_group: "Ad group", device: "Device", country: "Country", asset_group: "Asset group", ad: "Ad" };

/** A campaign's or ad group's id the report takes: Google's own (digits), or the demo's. */
const isGoogleId = (v: string): v is string => isGoogleObjectId(v) || isDemoObjectId(v);

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
      <td className={td}>{m.conversionRate === null ? NA : fmtPct(m.conversionRate)}</td>
      <td className={td}>{money(m.costPerConversion)}</td>
      <td className={td}>{money(m.conversionValue)}</td>
      <td className={td}>{times(m.roas)}</td>
    </>
  );
}

// Google's own column names where they differ from everyday words: its conversions count every
// conversion action, so their value ÷ cost is "Conv. value / cost", not a return on purchases.
const HEADINGS = ["Spent", "Impressions", "Clicks", "Click-through rate", "Per click", "Per 1,000 impressions", "Conversions (all actions)", "Conversion rate", "Per conversion", "Conversion value", "Conv. value / cost"];

const DEFINITIONS: Array<[string, string]> = [
  ["Click-through rate", "Clicks ÷ impressions."],
  ["Per click", "Spend ÷ clicks (Google's average CPC)."],
  ["Per 1,000 impressions", "Spend × 1,000 ÷ impressions (CPM)."],
  ["Conversions (all actions)", "Google's own count of every conversion action set to count: purchases, and also leads, sign-ups, calls. Not your Shopify orders."],
  ["Conversion rate", "Conversions ÷ clicks (Google's conv. rate), on every conversion action. Not your store's conversion rate, which divides orders by Shopify's sessions."],
  ["Per conversion", "Spend ÷ conversions."],
  ["Conv. value / cost", "Conversion value ÷ spend, on every conversion action. The Google Ads card's ROAS is on purchases only."],
];

export function GoogleReportPanel({ ov, accounts }: { ov: Overview; accounts: AdsModule["accounts"] }) {
  const { workspace } = useApp();
  const google = accounts.filter((a) => a.provider === "google");
  const [connection, setConnection] = useState(google[0]?.id ?? "");
  const [level, setLevel] = useState<GoogleReportLevel>("campaign");
  const [answer, setAnswer] = useState<{ drill: string; a: Answer } | null>(null);
  const [error, setError] = useState<{ message: string; reconnect: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const { from, to } = ov.range;
  // Changes only for dates that are over: a day still running against whole days reads as a drop.
  const ended = to < ov.today;
  const cfrom = ended ? ov.previous.from : null;
  const cto = ended ? ov.previous.to : null;
  const chosen = google.find((a) => a.id === connection) ?? google[0];
  const drill = useReportDrill("adgroup", isGoogleId, chosen?.id);
  // Each campaign's type (Performance Max has asset groups, not ad groups), from its row: a campaign
  // opened by a link is looked up on the campaign list first. Null: not on it (no activity in the dates).
  const [channels, setChannels] = useState<Record<string, string | null>>({});
  const channel = drill.campaign ? channels[drill.campaign] : undefined;
  const lookingUp = drill.campaign !== null && drill.child === null && channel === undefined;
  const asked: { level: GoogleReportLevel; campaign?: string; adGroup?: string } = drill.child
    ? { level: "ad", ...(drill.campaign ? { campaign: drill.campaign } : {}), adGroup: drill.child }
    : drill.campaign && !lookingUp
      ? { level: channel === "PERFORMANCE_MAX" ? "asset_group" : "ad_group", campaign: drill.campaign }
      : { level: lookingUp ? "campaign" : level };
  const drillKey = `${asked.campaign ?? "-"}:${asked.adGroup ?? "-"}`;

  useEffect(() => {
    if (!chosen || !drill.ready) return;
    let live = true;
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams({ connection: chosen.id, ...asked, from, to, ...(cfrom && cto ? { cfrom, cto } : {}) });
    api<Answer>(`/workspaces/${workspace.id}/stores/${ov.store.id}/ads/google/report?${qs}`)
      .then((a) => {
        if (!live) return;
        setAnswer({ drill: drillKey, a });
        // The campaign list says each campaign's type, for opening one.
        if (a.report.level === "campaign" && drillKey === "-:-") {
          drill.learn(Object.fromEntries(a.report.rows.map((row) => [row.id, row.name])));
          setChannels((known) => {
            const next = { ...known, ...Object.fromEntries(a.report.rows.map((row) => [row.id, row.channel])) };
            if (drill.campaign && !(drill.campaign in next)) next[drill.campaign] = null;
            return next;
          });
        }
      })
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
  }, [workspace.id, ov.store.id, chosen?.id, drill.ready, asked.level, drillKey, from, to, cfrom, cto]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!chosen) return null;
  // Another campaign's or ad group's rows are never shown under this one's name while it loads.
  const r = !lookingUp && answer?.drill === drillKey ? answer.a.report : undefined;
  const shown = r ? answer!.a : null;
  const currency = shown?.account.currency ?? chosen.currency ?? "USD";
  const money = (n: number | null) => (n === null ? NA : fmtMoney(n, currency));
  const includesToday = !!shown && to >= shown.today;
  const cmp = r?.comparison;
  const before = new Map((cmp?.rows ?? []).map((row) => [row.id, row]));
  // What was opened, by the name the row clicked gave, else as Google names it on the rows under it.
  const campaignName = drill.campaign ? (drill.nameOf(drill.campaign) ?? r?.rows.find((row) => row.campaignId === drill.campaign)?.campaignName ?? `Campaign ${drill.campaign}`) : null;
  const adGroupName = drill.child ? (drill.nameOf(drill.child) ?? r?.rows.find((row) => row.adGroupId === drill.child)?.adGroupName ?? `Ad group ${drill.child}`) : null;
  const top = () => {
    drill.top();
    setLevel("campaign");
  };
  /** Open a campaign's ad groups (a Performance Max one's asset groups), or an ad group's ads: only rows with an id the API takes. */
  const opens = (row: GoogleReportRow): (() => void) | null => {
    if (!isGoogleId(row.id)) return null;
    if (r?.level === "campaign") {
      return () => {
        setChannels((known) => ({ ...known, [row.id]: row.channel }));
        drill.go({ id: row.id, name: row.name });
      };
    }
    if (r?.level === "ad_group") {
      const c = row.campaignId && isGoogleId(row.campaignId) ? row.campaignId : null;
      return () => {
        // It has ad groups, so it isn't Performance Max: its crumb goes back to them.
        if (c) setChannels((known) => ({ ...known, [c]: known[c] ?? null }));
        drill.go(c ? { id: c, name: row.campaignName ?? `Campaign ${c}` } : null, { id: row.id, name: row.name });
      };
    }
    return null;
  };
  const what = r?.level === "asset_group" ? "asset groups" : r?.level === "ad" ? "ads" : "ad groups";

  return (
    <Panel
      id="d-google-report"
      title="Google Ads report"
      help={
        chosen.demo
          ? `${fmtRange(from, to)}, generated by bizinsights for the demo account (simulated, nothing read from Google). In ${currency}.`
          : `${fmtRange(from, to)}, straight from Google${shown?.account.timezone ? ` (days in the ad account's time zone, ${shown.account.timezone})` : ""}. In ${currency}. Read-only.`
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
      {drill.open ? (
        <DrillCrumbs
          testid="google-report-crumbs"
          steps={[
            { label: "All campaigns", onClick: top },
            ...(campaignName ? [{ label: campaignName, onClick: drill.up }] : []),
            ...(adGroupName ? [{ label: adGroupName }] : []),
          ]}
        />
      ) : (
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
      )}

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
                  <th className="px-2 pb-2 font-normal">{ONE[r.level]}</th>
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
                <tr className="border-t border-border bg-surface font-medium" data-testid="google-report-whole">
                  {/* Down from a campaign or an ad group: its rows added up, not Google's own row for it. */}
                  <td className="px-2 py-2">{!drill.open ? "Whole ad account" : `All ${what} in this ${drill.child ? "ad group" : "campaign"}`}</td>
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
                  // An ad named by Google says its type in its name already (googleAdName); one with its own name, beside it.
                  const ownName = row.adType !== null && row.name !== googleAdName(null, row.adType, row.id);
                  const details = [
                    drill.open ? null : row.campaignName,
                    row.channel ? (CHANNEL[row.channel] ?? row.channel.toLowerCase().replace(/_/g, " ")) : null,
                    row.dailyBudget !== null ? `budget ${money(row.dailyBudget)} a day` : null,
                    ownName ? googleAdTypeLabel(row.adType) : null,
                  ].filter(Boolean);
                  const was = before.get(row.id);
                  const open = opens(row);
                  return (
                    <tr key={row.id} className="border-t border-border" data-testid="google-report-row">
                      <td className="max-w-[18rem] px-2 py-2">
                        {open ? (
                          <OpenRow name={row.name} what={r.level === "ad_group" ? "ads" : row.channel === "PERFORMANCE_MAX" ? "asset groups" : "ad groups"} onClick={open} testid="google-report-open" />
                        ) : (
                          <span className="block truncate font-medium" title={row.name}>
                            {row.name}
                          </span>
                        )}
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
            (drill.open ? (
              <p className="mt-2 text-sm text-muted">Nothing in this {drill.child ? "ad group" : "campaign"} was shown to anyone in these dates.</p>
            ) : r.totals.impressions === 0 && r.totals.spend === 0 ? (
              <p className="mt-2 text-sm text-muted">Nothing in this ad account was shown to anyone in these dates.</p>
            ) : r.level === "ad_group" ? (
              <p className="mt-2 text-sm text-muted">No ad groups had any activity in these dates: Performance Max campaigns have no ad groups, so their spend is on the Campaigns tab.</p>
            ) : (
              <p className="mt-2 text-sm text-muted">Google has no split at this level for these dates; the account&apos;s activity is in the Whole ad account row above.</p>
            ))}
          {r.truncated && <p className="mt-2 text-xs text-muted">Showing the {r.rows.length} that spent most{drill.open ? "; the top row adds up every one" : ""}.</p>}
          <ul className="mt-3 list-disc space-y-1 pl-4 text-xs text-muted">
            {drill.open ? (
              <li>
                The top row adds up the {what} Google reported for these dates, asked of Google for exactly those dates. It isn&apos;t Google&apos;s own row for the{" "}
                {drill.child ? "ad group" : "campaign"}, so it can differ a little from the {drill.child ? "ad group's" : "campaign's"} figures on the{" "}
                {drill.child ? "Ad groups" : "Campaigns"} view, and from Campaign comparison, which shows the days stored at the last sync.
              </li>
            ) : (
              (r.level === "campaign" || r.level === "ad_group") && (
                <li>Press {r.level === "campaign" ? "a campaign to see its ad groups (a Performance Max campaign's asset groups, which it has instead)" : "an ad group to see its ads"}.</li>
              )
            )}
            {r.level === "ad" && <li>An ad without a name of its own at Google (most kinds, responsive search ads among them) is named by its type and Google&apos;s id for it.</li>}
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
            {r.level === "ad_group" && !drill.open && r.rows.length > 0 && <li>Performance Max campaigns have no ad groups, so their spend shows on the Campaigns tab but not here.</li>}
            {r.level === "country" && <li>Countries are where the people who saw your ads were, not the places your campaigns target.</li>}
            {shown && (chosen.demo ? <li>Generated by bizinsights from the demo&apos;s seed: the same figures every time, and nothing fetched from Google.</li> : <li>{shown.cached ? "Fetched from Google in the last few minutes." : "Fetched from Google just now."}</li>)}
          </ul>
          <Definitions items={DEFINITIONS} />
        </>
      )}
    </Panel>
  );
}

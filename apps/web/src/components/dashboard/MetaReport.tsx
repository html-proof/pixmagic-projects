"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { metaAttributionLabel, type MetaReportMetrics, type MetaReportRow, type MetaReportView } from "@app/shared/ads";
import { useApp } from "@/components/AppContext";
import { ErrorNotice } from "@/components/ErrorNotice";
import { LoadError } from "@/components/LoadError";
import { api, ApiError, fmtMoney, fmtNum, fmtPct } from "@/lib/api";
import { fmtRange, fmtTimes } from "./format";
import { Badge, Panel, type Tone } from "./Primitives";
import type { AdsModule, Overview } from "./types";

// ---------------------------------------------------------------------------
// The Meta Ads report: campaigns, ad sets and ads, or the whole account by placement, device or
// country, for the dates picked, asked of Meta for exactly those dates (GET .../ads/meta/report). Reach and frequency count each person once over the
// range, so they're never added up from days. Read-only: there is nothing here that changes an ad.
// ---------------------------------------------------------------------------

interface Report {
  level: MetaReportView;
  since: string;
  until: string;
  totals: MetaReportMetrics;
  rows: MetaReportRow[];
  truncated: boolean;
  attribution: string[];
}
interface Answer {
  account: { id: string; accountId: string; name: string | null; currency: string | null; timezone: string | null };
  today: string;
  cached: boolean;
  report: Report;
}

const LEVELS: Array<{ id: MetaReportView; label: string; one: string }> = [
  { id: "campaign", label: "Campaigns", one: "Campaign" },
  { id: "adset", label: "Ad sets", one: "Ad set" },
  { id: "ad", label: "Ads", one: "Ad" },
  { id: "placement", label: "Placements", one: "Placement" },
  { id: "device", label: "Devices", one: "Device" },
  { id: "country", label: "Countries", one: "Country" },
];

/** Meta's effective_status in words, and how worried to be about it. */
function statusOf(s: string | null): { label: string; tone: Tone } | null {
  if (!s) return null;
  switch (s) {
    case "ACTIVE":
      return { label: "Active", tone: "good" };
    case "PAUSED":
    case "CAMPAIGN_PAUSED":
    case "ADSET_PAUSED":
      return { label: s === "PAUSED" ? "Paused" : s === "CAMPAIGN_PAUSED" ? "Campaign paused" : "Ad set paused", tone: "neutral" };
    case "IN_PROCESS":
    case "PENDING_REVIEW":
    case "PREAPPROVED":
      return { label: "In review", tone: "neutral" };
    case "DISAPPROVED":
      return { label: "Rejected", tone: "danger" };
    case "WITH_ISSUES":
      return { label: "Has issues", tone: "warn" };
    case "PENDING_BILLING_INFO":
      return { label: "Billing needed", tone: "warn" };
    case "ARCHIVED":
    case "DELETED":
      return { label: s === "ARCHIVED" ? "Archived" : "Deleted", tone: "neutral" };
    default:
      return { label: s.toLowerCase().replace(/_/g, " "), tone: "neutral" };
  }
}

const NA = "—";
const freq = (n: number | null) => (n === null ? NA : new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(n));

function Cells({ m, money }: { m: MetaReportMetrics; money: (n: number | null) => string }) {
  const td = "px-2 py-2 text-right tabular-nums";
  return (
    <>
      <td className={td}>{money(m.spend)}</td>
      <td className={td}>{fmtNum(m.impressions)}</td>
      <td className={td}>{m.reach === null ? NA : fmtNum(m.reach)}</td>
      <td className={td}>{freq(m.frequency)}</td>
      <td className={td}>{fmtNum(m.linkClicks)}</td>
      <td className={td}>{m.linkCtr === null ? NA : fmtPct(m.linkCtr)}</td>
      <td className={td}>{money(m.costPerLinkClick)}</td>
      <td className={td}>{money(m.cpm)}</td>
      <td className={td}>{fmtNum(m.purchases)}</td>
      <td className={td}>{money(m.costPerPurchase)}</td>
      <td className={td}>{money(m.purchaseValue)}</td>
      <td className={td}>{fmtTimes(m.roas)}</td>
    </>
  );
}

const HEADINGS = ["Spent", "Impressions", "Reach", "Frequency", "Link clicks", "Link click rate", "Per link click", "Per 1,000 impressions", "Purchases", "Per purchase", "Purchase value", "Return"];

export function MetaReportPanel({ ov, accounts }: { ov: Overview; accounts: AdsModule["accounts"] }) {
  const { workspace } = useApp();
  const meta = accounts.filter((a) => a.provider === "meta");
  const [connection, setConnection] = useState(meta[0]?.id ?? "");
  const [level, setLevel] = useState<MetaReportView>("campaign");
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(false);
  const { from, to } = ov.range;
  const chosen = meta.find((a) => a.id === connection) ?? meta[0];

  useEffect(() => {
    if (!chosen) return;
    let live = true;
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams({ connection: chosen.id, level, from, to });
    api<Answer>(`/workspaces/${workspace.id}/stores/${ov.store.id}/ads/meta/report?${qs}`)
      .then((a) => live && setAnswer(a))
      .catch((e: unknown) => {
        if (!live) return;
        setAnswer(null);
        setError(e instanceof ApiError ? e : new ApiError(0, "network", ""));
      })
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
    // The account's status changes on every poll; only a different question asks Meta again.
  }, [workspace.id, ov.store.id, chosen?.id, level, from, to, attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!chosen) return null;
  const r = answer?.report;
  const currency = answer?.account.currency ?? chosen.currency ?? "USD";
  const money = (n: number | null) => (n === null ? NA : fmtMoney(n, currency));
  const attribution = (r?.attribution ?? []).map(metaAttributionLabel).filter(Boolean).join("; ");
  const includesToday = !!answer && to >= answer.today;

  return (
    <Panel
      id="d-meta-report"
      title="Meta Ads report"
      help={`${fmtRange(from, to)}, straight from Meta${answer?.account.timezone ? ` (days in the ad account's time zone, ${answer.account.timezone})` : ""}. In ${currency}. Read-only.`}
      aside={
        meta.length > 1 ? (
          <label className="flex items-center gap-2 text-xs text-muted">
            Ad account
            <select className="input h-8 py-0 text-sm" value={chosen.id} onChange={(e) => setConnection(e.target.value)} data-testid="meta-report-account">
              {meta.map((a) => (
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
      <div role="tablist" aria-label="Report level" className="mb-3 inline-flex flex-wrap rounded-lg border border-border p-0.5">
        {LEVELS.map((l) => (
          <button
            key={l.id}
            type="button"
            role="tab"
            aria-selected={level === l.id}
            className={`rounded-md px-3 py-1 text-sm ${level === l.id ? "bg-surface font-semibold shadow-sm" : "text-muted"}`}
            onClick={() => setLevel(l.id)}
            data-testid={`meta-report-${l.id}`}
          >
            {l.label}
          </button>
        ))}
      </div>

      {error ? (
        error.code === "reconnect" ? <ErrorNotice kind="integration" title="Integration disconnected" correlationId={error.correlationId} action={<Link className="btn-primary" href="/settings/ads">Reconnect Meta Ads</Link>}>Access to this ad account has ended. Reconnect it to resume reports.</ErrorNotice>
        : <LoadError what="the Meta Ads report" error={error} onRetry={() => setAttempt((n) => n + 1)} busy={loading} />
      ) : !r ? (
        <div className="skeleton h-40" aria-hidden="true" />
      ) : (
        <>
          {includesToday && (
            <p className="mb-2 text-xs text-muted">Today&apos;s numbers are still coming in: Meta updates them through the day, and can revise purchases for some days afterwards.</p>
          )}
          <div className={`-mx-1 overflow-x-auto ${loading ? "opacity-60" : ""}`} aria-busy={loading}>
            <table className="w-full min-w-[72rem] text-sm" data-testid="meta-report-table">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="px-2 pb-2 font-normal">{LEVELS.find((l) => l.id === r.level)!.one}</th>
                  {HEADINGS.map((h) => (
                    <th key={h} className="px-2 pb-2 text-right font-normal">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr className="border-t border-border bg-surface font-medium">
                  <td className="px-2 py-2">Whole ad account</td>
                  <Cells m={r.totals} money={money} />
                </tr>
                {r.rows.map((row) => {
                  const s = statusOf(row.status);
                  return (
                    <tr key={row.id} className="border-t border-border">
                      <td className="max-w-[18rem] px-2 py-2">
                        <span className="block truncate font-medium" title={row.name}>
                          {row.name}
                        </span>
                        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                          {s && <Badge tone={s.tone}>{s.label}</Badge>}
                          {(row.adsetName ?? row.campaignName) && <span className="truncate">{[row.campaignName, row.adsetName].filter(Boolean).join(" › ")}</span>}
                        </span>
                      </td>
                      <Cells m={row} money={money} />
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {r.rows.length === 0 && <p className="mt-2 text-sm text-muted">Nothing in this ad account was shown to anyone in these dates.</p>}
          {r.truncated && <p className="mt-2 text-xs text-muted">Showing the {r.rows.length} that spent most.</p>}
          <ul className="mt-3 list-disc space-y-1 pl-4 text-xs text-muted">
            <li>Reach counts each person once over the whole period, so the rows don&apos;t add up to the account&apos;s reach. Frequency is impressions per person reached.</li>
            {r.level === "device" && <li>Devices are the ones the ads were shown on.</li>}
            {r.level === "country" && <li>Countries are where the people who saw your ads were.</li>}
            <li>
              Purchases and purchase value are Meta&apos;s own count of sales it credits to these ads
              {attribution ? ` (${attribution})` : ""}. They are not your Shopify orders, and they aren&apos;t added into your store&apos;s sales.
            </li>
            {answer && <li>{answer.cached ? "Fetched from Meta in the last few minutes." : "Fetched from Meta just now."}</li>}
          </ul>
        </>
      )}
    </Panel>
  );
}

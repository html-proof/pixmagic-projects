"use client";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import {
  isMetaObjectId,
  META_ATTRIBUTION_WINDOWS,
  metaAttributionLabel,
  metaObjectiveLabel,
  metaStatusGroup,
  metaWords,
  type MetaAttributionWindow,
  type MetaCampaignCounts,
  type MetaObjectDetails,
  type MetaReportMetrics,
  type MetaReportRow,
  type MetaReportView,
  type MetaStatusGroup,
} from "@app/shared/ads";
import { useApp } from "@/components/AppContext";
import { Alert } from "@/components/ui";
import { actionError, api, ApiError, fmtMoney, fmtNum, fmtPct } from "@/lib/api";
import { Definitions } from "./AdsCommon";
import { fmtDay, fmtRange, fmtSpan, fmtTimes, plural } from "./format";
import { Badge, Delta, NeutralDelta, Panel, type Tone } from "./Primitives";
import { DrillCrumbs, OpenRow, useReportDrill } from "./ReportDrill";
import { ReportChange, reportChange } from "./ReportCompare";
import type { AdsModule, Overview } from "./types";

// ---------------------------------------------------------------------------
// The Meta Ads report: campaigns, ad sets and ads, or the whole account by placement, device,
// country, age group or gender, for the dates picked, asked of Meta for exactly those dates (GET
// .../ads/meta/report). Reach and frequency count each person once over the range, so they're
// never added up from days. Read-only: there is nothing here that changes an ad. When the answer
// carries the dates compared with (`comparison`), the figures at a glance and each row show their
// change; the dates picked must have ended, so a day still running is never set against whole days.
// Each campaign, ad set or ad also brings what it is set to at Meta (objective, budget, schedule,
// bidding, an ad's preview), and the account's campaigns are counted by state. A campaign opens to
// its ad sets, an ad set to its ads (?campaign=&adset=, ReportDrill), with that campaign's or ad
// set's own totals in place of the account's. Purchases, their value, ROAS and cost per purchase
// follow each ad set's own attribution setting, or one fixed window picked (Attribution): Meta's
// count under it, "Not reported" where Meta gave none.
// ---------------------------------------------------------------------------

interface Report {
  level: MetaReportView;
  since: string;
  until: string;
  totals: MetaReportMetrics;
  rows: MetaReportRow[];
  truncated: boolean;
  attribution: string[];
  /** The account's campaigns by state at Meta now; null when not read, absent from older answers. */
  campaigns?: MetaCampaignCounts | null;
  /** The dates compared with, when asked for and given: their totals and each row's figures (by id). */
  comparison?: { since: string; until: string; totals: MetaReportMetrics; rows: Array<{ id: string } & Partial<MetaReportMetrics>> };
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
  { id: "age", label: "Age", one: "Age group" },
  { id: "gender", label: "Gender", one: "Gender" },
];

/** The levels whose rows are campaigns, ad sets or ads (with a status and settings), not a split of the account. */
const OBJECT_LEVELS: ReadonlySet<MetaReportView> = new Set(["campaign", "adset", "ad"]);

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
const NOT_REPORTED = "Not reported";
const freq = (n: number | null) => (n === null ? NA : new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(n));

/** Whose purchases: each ad set's own attribution setting (Meta's `value`, the default), or one fixed window. */
type Attribution = "setting" | MetaAttributionWindow;
const ATTRIBUTIONS: Array<[Attribution, string]> = [["setting", "Each ad set's own setting"], ...META_ATTRIBUTION_WINDOWS.map((w): [Attribution, string] => [w, metaAttributionLabel(w) ?? w])];
const attributionLabel = (at: Attribution) => ATTRIBUTIONS.find(([a]) => a === at)?.[1] ?? at;

type PurchaseKey = "purchases" | "purchaseValue" | "costPerPurchase" | "roas";
const isPurchaseKey = (k: string): k is PurchaseKey => k === "purchases" || k === "purchaseValue" || k === "costPerPurchase" || k === "roas";

/**
 * A purchase figure under the attribution picked: the ad set's own setting's, or one window's. Undefined:
 * Meta gave no figure for that window (Not reported), as in answers cached before the windows were read.
 * Null: no figure to work out (a cost with no purchases, a return with no spend), "—" as elsewhere.
 */
function purchaseFigure(m: Partial<MetaReportMetrics> | undefined, key: PurchaseKey, at: Attribution): number | null | undefined {
  if (!m) return undefined;
  if (at === "setting") return m[key];
  const w = m.byWindow?.[at];
  if (!w || (key === "purchases" || key === "costPerPurchase" ? w.purchases : w.purchaseValue) === null) return undefined;
  return w[key];
}

const notReported = <span className="text-xs text-muted">{NOT_REPORTED}</span>;

function Cells({ m, money, at }: { m: MetaReportMetrics; money: (n: number | null) => string; at: Attribution }) {
  const td = "px-2 py-2 text-right tabular-nums";
  const p = (key: PurchaseKey, show: (n: number | null) => string) => {
    const v = purchaseFigure(m, key, at);
    return v === undefined ? notReported : show(v);
  };
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
      <td className={td}>{fmtNum(m.landingPageViews)}</td>
      <td className={td}>{money(m.costPerLandingPageView)}</td>
      <td className={td}>{p("purchases", (n) => (n === null ? NA : fmtNum(n)))}</td>
      <td className={td}>{p("costPerPurchase", money)}</td>
      <td className={td}>{p("purchaseValue", money)}</td>
      <td className={td}>{p("roas", fmtTimes)}</td>
    </>
  );
}

const HEADINGS = ["Spent", "Impressions", "Reach", "Frequency", "Link clicks", "Link click rate", "Per link click", "Per 1,000 impressions", "Landing page views", "Per landing page view", "Purchases", "Per purchase", "Purchase value", "Purchase ROAS"];
/** The purchase columns' headings say the window picked. */
const headingsFor = (at: Attribution) => (at === "setting" ? HEADINGS : HEADINGS.map((h, i) => (i >= HEADINGS.length - 4 ? `${h} (${attributionLabel(at)})` : h)));

const DEFINITIONS: Array<[string, string]> = [
  ["Reach", "People who saw an ad at least once in these dates, each counted once."],
  ["Frequency", "Impressions ÷ reach: how many times each person saw an ad on average."],
  ["Link clicks", "Clicks on the ad's link. Meta's “clicks (all)”, which also count likes, comments and profile taps, aren't used."],
  ["Link click rate", "Link clicks ÷ impressions (CTR)."],
  ["Per link click", "Spend ÷ link clicks (CPC)."],
  ["Per 1,000 impressions", "Spend × 1,000 ÷ impressions (CPM)."],
  ["Landing page views", "Link clicks after which your page loaded, as Meta's pixel saw it. Meta's count, not your store's sessions or visitors: a visit Meta can't see isn't counted, and one person can land twice."],
  ["Per landing page view", "Spend ÷ landing page views."],
  ["Purchases", "Purchases Meta credits to these ads, by each ad set's own attribution setting unless another is picked: Meta's count, not your Shopify orders."],
  [
    "Attribution",
    "Which purchases Meta credits to the ads. Each ad set's own setting is what Ads Manager shows by default (for example 7-day click, 1-day view). 1-day and 7-day click: purchases within 1 or 7 days of someone clicking an ad. 1-day view: within a day of someone seeing an ad without clicking it. Each is Meta's own count under that window, for every ad set alike; Not reported where Meta gave no figure for it.",
  ],
  ["Per purchase", "Spend ÷ the purchases Meta credits to the ads (cost per result, when the result is a purchase)."],
  ["Purchase ROAS", "Purchase value ÷ spend: Meta's own return on ad spend."],
  ["Active campaigns", "Campaigns delivering now, of every campaign in the ad account (archived and deleted ones included), as Meta lists them at this moment."],
  ["Budget", "The campaign's or ad set's daily budget, or its lifetime budget, as set at Meta, in the ad account's currency."],
];

// ---------------------------------------------------------------------------
// The figures at a glance: the account's totals for the dates, each with the change against the
// dates compared with (whole days only) and what was compared.
// ---------------------------------------------------------------------------

/**
 * How each figure reads as news: `neutral` ones (spend, how many people were reached) are neither
 * good nor bad by themselves; `invert` ones are costs, where lower is better.
 */
const KPIS: Array<{ key: Exclude<keyof MetaReportMetrics, "byWindow">; label: string; kind: "money" | "count" | "rate" | "times" | "frequency"; neutral?: boolean; invert?: boolean }> = [
  { key: "spend", label: "Spent", kind: "money", neutral: true },
  { key: "impressions", label: "Impressions", kind: "count", neutral: true },
  { key: "reach", label: "Reach", kind: "count", neutral: true },
  { key: "frequency", label: "Frequency", kind: "frequency", neutral: true },
  { key: "linkClicks", label: "Link clicks", kind: "count" },
  { key: "linkCtr", label: "Link click rate", kind: "rate" },
  { key: "costPerLinkClick", label: "Per link click", kind: "money", invert: true },
  { key: "cpm", label: "Per 1,000 impressions", kind: "money", invert: true },
  { key: "landingPageViews", label: "Landing page views (Meta's count)", kind: "count" },
  { key: "purchases", label: "Purchases (Meta's count)", kind: "count" },
  { key: "purchaseValue", label: "Purchase value (Meta's count)", kind: "money" },
  { key: "roas", label: "Purchase ROAS", kind: "times" },
  { key: "costPerPurchase", label: "Per purchase", kind: "money", invert: true },
];

function Kpi({ label, value, change, before, note, testid }: { label: string; value: string; change?: ReactNode; before?: string | null; note?: string; testid: string }) {
  return (
    <div className="lift min-w-0 rounded-lg border border-border bg-surface p-3" data-testid={testid}>
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 truncate text-xl font-semibold tabular-nums">{value}</p>
      {change && <p className="mt-1">{change}</p>}
      {before && <p className="mt-1 truncate text-xs text-muted">Before: {before}</p>}
      {note && <p className="mt-1 text-xs text-muted">{note}</p>}
    </div>
  );
}

function Glance({ r, money, cached, timezone, drilled, at }: { r: Report; money: (n: number | null) => string; cached: boolean; timezone: string | null; drilled: boolean; at: Attribution }) {
  // Undefined: a window's figure Meta didn't give (purchaseFigure).
  const show = (kind: (typeof KPIS)[number]["kind"], v: number | null | undefined) =>
    v === undefined ? NOT_REPORTED : v === null ? NA : kind === "money" ? money(v) : kind === "count" ? fmtNum(v) : kind === "rate" ? fmtPct(v) : kind === "times" ? fmtTimes(v) : freq(v);
  const cmp = r.comparison;
  const label = cmp ? `vs ${fmtSpan(cmp.since, cmp.until)}` : "vs before";
  // The account's campaigns by state: not a campaign's or an ad set's figure, so not shown down from one.
  const counts = drilled ? undefined : r.campaigns;
  const figure = (m: Partial<MetaReportMetrics> | undefined, key: (typeof KPIS)[number]["key"]) => (isPurchaseKey(key) ? purchaseFigure(m, key, at) : (m?.[key] ?? null));
  return (
    <div className="mb-4" data-testid="meta-report-glance">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
        {KPIS.map((k) => {
          const now = figure(r.totals, k.key);
          const was = cmp ? figure(cmp.totals, k.key) : null;
          const change = cmp ? reportChange(now, was) : null;
          return (
            <Kpi
              key={k.key}
              testid={`meta-kpi-${k.key}`}
              // A window's figures say which: Meta's count under it.
              label={isPurchaseKey(k.key) && at !== "setting" ? `${k.label.replace(/ \(Meta's count\)$/, "")} (Meta's count, ${attributionLabel(at)})` : k.label}
              value={show(k.kind, now)}
              change={
                !cmp ? undefined : change === null ? (
                  <span className="text-xs text-muted">nothing to compare with</span>
                ) : k.neutral ? (
                  <NeutralDelta value={change} label={label} />
                ) : (
                  <Delta value={change} invert={k.invert} label={label} />
                )
              }
              before={cmp ? show(k.kind, was) : null}
            />
          );
        })}
        {counts !== undefined && (
          <Kpi
            testid="meta-kpi-campaigns"
            label="Active campaigns"
            value={counts ? `${fmtNum(counts.active)} of ${fmtNum(counts.total)}` : NA}
            note={
              counts
                ? `${plural(counts.paused, "paused")}, ${counts.other === 1 ? "1 other (archived, deleted or in review)" : `${fmtNum(counts.other)} others (archived, deleted or in review)`}${counts.complete ? "" : "; of the campaigns read so far"}. At Meta now, not for the dates.`
                : "Meta didn't list the campaigns in time."
            }
          />
        )}
      </div>
      <p className="mt-2 text-xs text-muted" data-testid="meta-report-source">
        Source: Meta Ads · {cached ? "fetched from Meta in the last few minutes" : "fetched from Meta just now"} · {fmtRange(r.since, r.until)}
        {timezone ? `, days in ${timezone}` : ""}
        {cmp ? ` · changes compare with ${fmtSpan(cmp.since, cmp.until)}, as Meta reports those dates now` : " · changes show once the dates picked are over"}.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// What each campaign, ad set or ad is set to at Meta, under its name.
// ---------------------------------------------------------------------------

/** "1 Oct 2026 onward", "1 Oct – 31 Dec 2026": the schedule from Meta's timestamps (their date part is in the account's own zone). */
function scheduleWords(d: MetaObjectDetails): string | null {
  const day = (iso: string | null) => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : null);
  const start = day(d.startTime);
  const end = day(d.endTime);
  if (start && end) return start === end ? fmtDay(start) : `${fmtSpan(start, end)}`;
  if (start) return `from ${fmtDay(start)}`;
  if (end) return `until ${fmtDay(end)}`;
  return null;
}

function DetailsLine({ level, d, money }: { level: MetaReportView; d: MetaObjectDetails; money: (n: number | null) => string }) {
  const parts: ReactNode[] = [];
  if (level === "campaign") {
    const objective = metaObjectiveLabel(d.objective);
    if (objective) parts.push(<span key="objective">Objective: {objective}</span>);
    if (d.buyingType === "RESERVED") parts.push(<span key="buying">Reserved (reach and frequency)</span>);
  }
  if (level === "adset") {
    const goal = metaWords(d.optimizationGoal);
    if (goal) parts.push(<span key="goal">Optimized for {goal.toLowerCase()}</span>);
    const billed = metaWords(d.billingEvent);
    if (billed) parts.push(<span key="billed">Billed per {billed.toLowerCase()}</span>);
  }
  if (d.dailyBudget !== null) parts.push(<span key="budget">Budget {money(d.dailyBudget)} a day</span>);
  else if (d.lifetimeBudget !== null) parts.push(<span key="budget">Lifetime budget {money(d.lifetimeBudget)}</span>);
  const schedule = scheduleWords(d);
  if (schedule) parts.push(<span key="schedule">{schedule}</span>);
  const bid = metaWords(d.bidStrategy);
  if (bid && level !== "ad") parts.push(<span key="bid">Bid: {bid.toLowerCase()}</span>);
  if (level === "ad" && d.previewLink) {
    parts.push(
      <a key="preview" className="text-accent underline-offset-2 hover:underline" href={d.previewLink} target="_blank" rel="noopener noreferrer">
        Preview the ad on Facebook
      </a>,
    );
  }
  if (!parts.length) return null;
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted" data-testid="meta-row-details">
      {parts.map((p, i) => (
        <span key={i} className="inline-flex items-center gap-x-2">
          {i > 0 && <span aria-hidden>·</span>}
          {p}
        </span>
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// The report panel.
// ---------------------------------------------------------------------------

type StatusFilter = "all" | MetaStatusGroup;
const STATUS_FILTERS: Array<[StatusFilter, string]> = [
  ["all", "All"],
  ["active", "Active"],
  ["paused", "Paused"],
  ["other", "Other"],
];

export function MetaReportPanel({ ov, accounts }: { ov: Overview; accounts: AdsModule["accounts"] }) {
  const { workspace } = useApp();
  const meta = accounts.filter((a) => a.provider === "meta");
  const [connection, setConnection] = useState(meta[0]?.id ?? "");
  const [level, setLevel] = useState<MetaReportView>("campaign");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [objectiveFilter, setObjectiveFilter] = useState("all");
  // Kept down from a campaign and across levels: it is how the purchases are counted, not a filter.
  const [at, setAt] = useState<Attribution>("setting");
  const [answer, setAnswer] = useState<{ drill: string; a: Answer } | null>(null);
  const [error, setError] = useState<{ message: string; reconnect: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const { from, to } = ov.range;
  // Changes only for dates that are over: a day still running against whole days reads as a drop.
  const ended = to < ov.today;
  const cfrom = ended ? ov.previous.from : null;
  const cto = ended ? ov.previous.to : null;
  const chosen = meta.find((a) => a.id === connection) ?? meta[0];
  const drill = useReportDrill("adset", isMetaObjectId, chosen?.id);
  // Down from a campaign: its ad sets; from an ad set: its ads (in its campaign, when known).
  const asked: { level: MetaReportView; campaign?: string; adset?: string } = drill.child
    ? { level: "ad", ...(drill.campaign ? { campaign: drill.campaign } : {}), adset: drill.child }
    : drill.campaign
      ? { level: "adset", campaign: drill.campaign }
      : { level };
  const drillKey = `${drill.campaign ?? "-"}:${drill.child ?? "-"}`;
  // Each list opened starts with every row shown: a filter picked on the campaigns isn't the ad sets'.
  useEffect(() => {
    setStatusFilter("all");
    setObjectiveFilter("all");
  }, [drillKey]);

  useEffect(() => {
    if (!chosen || !drill.ready) return;
    let live = true;
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams({ connection: chosen.id, ...asked, from, to, ...(cfrom && cto ? { cfrom, cto } : {}) });
    api<Answer>(`/workspaces/${workspace.id}/stores/${ov.store.id}/ads/meta/report?${qs}`)
      .then((a) => live && setAnswer({ drill: drillKey, a }))
      .catch((e: unknown) => {
        if (!live) return;
        setAnswer(null);
        setError({ message: actionError(e, "load the Meta Ads report"), reconnect: e instanceof ApiError && e.code === "reconnect" });
      })
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
    // The account's status changes on every poll; only a different question asks Meta again.
  }, [workspace.id, ov.store.id, chosen?.id, drill.ready, asked.level, drillKey, from, to, cfrom, cto]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!chosen) return null;
  // Another campaign's or ad set's rows are never shown under this one's name while it loads.
  const r = answer?.drill === drillKey ? answer.a.report : undefined;
  const shown = r ? answer!.a : null;
  const currency = shown?.account.currency ?? chosen.currency ?? "USD";
  const money = (n: number | null) => (n === null ? NA : fmtMoney(n, currency));
  const attribution = (r?.attribution ?? []).map(metaAttributionLabel).filter(Boolean).join("; ");
  const includesToday = !!shown && to >= shown.today;
  const cmp = r?.comparison;
  const before = new Map((cmp?.rows ?? []).map((row) => [row.id, row]));
  const objects = !!r && OBJECT_LEVELS.has(r.level);
  // The filters apply to campaigns, ad sets and ads (a split of the account has no status).
  const objectives = objects && r.level === "campaign" ? [...new Set(r.rows.map((row) => row.details?.objective).filter((o): o is string => !!o))].sort() : [];
  const rows = (r?.rows ?? []).filter((row) => {
    if (!objects) return true;
    if (statusFilter !== "all" && metaStatusGroup(row.status) !== statusFilter) return false;
    if (objectiveFilter !== "all" && row.details?.objective !== objectiveFilter) return false;
    return true;
  });
  const filtered = !!r && rows.length !== r.rows.length;
  const countBy = (g: StatusFilter) => (g === "all" ? (r?.rows.length ?? 0) : (r?.rows.filter((row) => metaStatusGroup(row.status) === g).length ?? 0));
  // What was opened, by the name the row clicked gave, else as Meta names it on the rows under it.
  const campaignName = drill.campaign ? (drill.nameOf(drill.campaign) ?? r?.rows.find((row) => row.campaignId === drill.campaign)?.campaignName ?? `Campaign ${drill.campaign}`) : null;
  const adsetName = drill.child ? (drill.nameOf(drill.child) ?? r?.rows.find((row) => row.adsetId === drill.child)?.adsetName ?? `Ad set ${drill.child}`) : null;
  const whole = drill.child ? "ad set" : drill.campaign ? "campaign" : "ad account";
  const top = () => {
    drill.top();
    setLevel("campaign");
  };
  /** Open a campaign's ad sets, or an ad set's ads: only rows with Meta's own ids (never "unknown"). */
  const opens = (row: MetaReportRow): (() => void) | null => {
    if (!isMetaObjectId(row.id)) return null;
    if (r?.level === "campaign") return () => drill.go({ id: row.id, name: row.name });
    if (r?.level === "adset") return () => drill.go(row.campaignId ? { id: row.campaignId, name: row.campaignName ?? `Campaign ${row.campaignId}` } : null, { id: row.id, name: row.name });
    return null;
  };

  return (
    <Panel
      id="d-meta-report"
      title="Meta Ads report"
      help={`${fmtRange(from, to)}, straight from Meta${shown?.account.timezone ? ` (days in the ad account's time zone, ${shown.account.timezone})` : ""}. In ${currency}. Read-only.`}
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
      {drill.open && (
        <DrillCrumbs
          testid="meta-report-crumbs"
          steps={[
            { label: "All campaigns", onClick: top },
            ...(campaignName ? [{ label: campaignName, onClick: drill.up }] : []),
            ...(adsetName ? [{ label: adsetName }] : []),
          ]}
        />
      )}
      {error ? (
        <Alert kind={error.reconnect ? "error" : "info"}>
          {error.message}{" "}
          {error.reconnect && (
            <Link className="font-medium underline" href="/settings/ads">
              Reconnect Meta Ads
            </Link>
          )}
        </Alert>
      ) : !r ? (
        <div className="skeleton h-40" aria-hidden="true" />
      ) : (
        <>
          {includesToday && (
            <p className="mb-2 text-xs text-muted">Today&apos;s numbers are still coming in: Meta updates them through the day, and can revise purchases for some days afterwards.</p>
          )}
          <div className={loading ? "opacity-60" : ""} aria-busy={loading}>
            <Glance r={r} money={money} cached={shown!.cached} timezone={shown!.account.timezone} drilled={drill.open} at={at} />
          </div>

          <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
            {/* Down from a campaign or an ad set, the breadcrumb above says where; the levels are the whole account's. */}
            {!drill.open && (
              <div role="tablist" aria-label="Report level" className="inline-flex flex-wrap rounded-lg border border-border p-0.5">
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
            )}
            {objects && (
              <div className="inline-flex flex-wrap items-center gap-1" role="group" aria-label="Delivery status" data-testid="meta-report-status-filter">
                {STATUS_FILTERS.map(([g, label]) => (
                  <button
                    key={g}
                    type="button"
                    aria-pressed={statusFilter === g}
                    className={`rounded-full border px-2.5 py-0.5 text-xs ${statusFilter === g ? "border-accent bg-accent/10 font-medium text-text" : "border-border text-muted hover:text-text"}`}
                    onClick={() => setStatusFilter(g)}
                  >
                    {label} <span className="tabular-nums opacity-70">{countBy(g)}</span>
                  </button>
                ))}
              </div>
            )}
            {objectives.length > 1 && (
              <label className="flex items-center gap-2 text-xs text-muted">
                Objective
                <select className="input h-8 py-0 text-sm" value={objectiveFilter} onChange={(e) => setObjectiveFilter(e.target.value)} data-testid="meta-report-objective">
                  <option value="all">All objectives</option>
                  {objectives.map((o) => (
                    <option key={o} value={o}>
                      {metaObjectiveLabel(o)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="flex items-center gap-2 text-xs text-muted">
              Attribution
              <select className="input h-8 py-0 text-sm" value={at} onChange={(e) => setAt(e.target.value as Attribution)} data-testid="meta-report-attribution">
                {ATTRIBUTIONS.map(([a, label]) => (
                  <option key={a} value={a}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className={`-mx-1 overflow-x-auto ${loading ? "opacity-60" : ""}`} aria-busy={loading}>
            <table className="w-full min-w-[72rem] text-sm" data-testid="meta-report-table">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="px-2 pb-2 font-normal">{LEVELS.find((l) => l.id === r.level)!.one}</th>
                  {headingsFor(at).map((h) => (
                    <th key={h} className="px-2 pb-2 text-right font-normal">
                      {h}
                    </th>
                  ))}
                  {cmp && <th className="px-2 pb-2 text-right font-normal">Spend vs before</th>}
                  {cmp && <th className="px-2 pb-2 text-right font-normal">Purchases vs before</th>}
                </tr>
              </thead>
              <tbody>
                <tr className="border-t border-border bg-surface font-medium" data-testid="meta-report-whole">
                  <td className="px-2 py-2">Whole {whole}</td>
                  <Cells m={r.totals} money={money} at={at} />
                  {cmp && <ReportChange value={reportChange(r.totals.spend, cmp.totals.spend)} neutral />}
                  {cmp && <ReportChange value={reportChange(purchaseFigure(r.totals, "purchases", at), purchaseFigure(cmp.totals, "purchases", at))} />}
                </tr>
                {cmp && (
                  <tr className="border-t border-border text-muted" data-testid="meta-report-before">
                    <td className="px-2 py-2">Before ({fmtSpan(cmp.since, cmp.until)})</td>
                    <Cells m={cmp.totals} money={money} at={at} />
                    <td />
                    <td />
                  </tr>
                )}
                {rows.map((row) => {
                  const s = statusOf(row.status);
                  const was = before.get(row.id);
                  const open = opens(row);
                  // Down from a campaign or an ad set, the breadcrumb names them; on the account's own lists, each row does.
                  const parents = drill.open ? [] : [row.campaignName, row.adsetName].filter(Boolean);
                  return (
                    <tr key={row.id} className="border-t border-border" data-testid="meta-report-row">
                      <td className="max-w-[22rem] px-2 py-2">
                        {open ? (
                          <OpenRow name={row.name} what={r.level === "campaign" ? "ad sets" : "ads"} onClick={open} testid="meta-report-open" />
                        ) : (
                          <span className="block truncate font-medium" title={row.name}>
                            {row.name}
                          </span>
                        )}
                        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                          {s && <Badge tone={s.tone}>{s.label}</Badge>}
                          {parents.length > 0 && <span className="truncate">{parents.join(" › ")}</span>}
                        </span>
                        {row.details && <DetailsLine level={r.level} d={row.details} money={money} />}
                      </td>
                      <Cells m={row} money={money} at={at} />
                      {cmp && <ReportChange value={reportChange(row.spend, was?.spend)} neutral />}
                      {cmp && <ReportChange value={reportChange(purchaseFigure(row, "purchases", at), purchaseFigure(was, "purchases", at))} />}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {r.rows.length === 0 && <p className="mt-2 text-sm text-muted">Nothing in this {whole} was shown to anyone in these dates.</p>}
          {r.rows.length > 0 && rows.length === 0 && <p className="mt-2 text-sm text-muted">Nothing matches these filters. The {whole}&apos;s totals above cover every row.</p>}
          {filtered && rows.length > 0 && (
            <p className="mt-2 text-xs text-muted">
              Showing {rows.length} of {r.rows.length}; the {whole}&apos;s totals above cover every row.
            </p>
          )}
          {r.truncated && <p className="mt-2 text-xs text-muted">Showing the {r.rows.length} that spent most.</p>}
          <ul className="mt-3 list-disc space-y-1 pl-4 text-xs text-muted">
            <li>Reach counts each person once over the whole period, so the rows don&apos;t add up to the {whole}&apos;s reach. Frequency is impressions per person reached.</li>
            {drill.open ? (
              <li>
                The {whole}&apos;s own totals and its {r.level === "ad" ? "ads" : "ad sets"}, asked of Meta for exactly these dates. They can differ a little from the campaign&apos;s figures on Campaign
                comparison, which are its days as stored at the last sync: Meta revises purchases for some days afterwards.
              </li>
            ) : (
              (r.level === "campaign" || r.level === "adset") && <li>Press {r.level === "campaign" ? "a campaign" : "an ad set"} to see its {r.level === "campaign" ? "ad sets" : "ads"}.</li>
            )}
            {objects && <li>Status, objective, budget and schedule are as Meta lists them now, not as they were in the dates picked. Budgets are in the ad account&apos;s currency.</li>}
            {r.level === "device" && <li>Devices are the ones the ads were shown on.</li>}
            {r.level === "country" && <li>Countries are where the people who saw your ads were.</li>}
            {(r.level === "age" || r.level === "gender") && <li>Age groups and genders are Meta&apos;s own totals for the people who saw the ads; nothing here is about any one person.</li>}
            {cmp ? (
              <li>Changes compare with {fmtSpan(cmp.since, cmp.until)}, as Meta reports those dates now.</li>
            ) : !ended ? (
              <li>Changes show once the dates picked are over: today is still running, so it isn&apos;t set against whole days.</li>
            ) : null}
            {at === "setting" ? (
              <li>
                Purchases and purchase value are Meta&apos;s own count of sales it credits to these ads, by each ad set&apos;s own attribution setting
                {attribution ? ` (${attribution})` : ""}. They are not your Shopify orders, and they aren&apos;t added into your store&apos;s sales.
              </li>
            ) : (
              <li>
                Purchases, purchase value, ROAS and cost per purchase are Meta&apos;s own count under {attributionLabel(at).toLowerCase()} attribution, the same window for every
                ad set{attribution ? ` (whatever each is set to: ${attribution})` : ""}; Not reported where Meta gave no figure for it. They are not your Shopify orders,
                and they aren&apos;t added into your store&apos;s sales.
              </li>
            )}
            {shown && <li>{shown.cached ? "Fetched from Meta in the last few minutes." : "Fetched from Meta just now."}</li>}
          </ul>
          <Definitions items={DEFINITIONS} />
        </>
      )}
    </Panel>
  );
}

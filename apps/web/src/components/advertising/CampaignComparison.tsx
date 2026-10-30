"use client";
import Link from "next/link";
import { useState } from "react";
import { CAMPAIGN_STATUS_GROUP_LABEL, CAMPAIGN_STATUS_GROUPS, isGoogleObjectId, isMetaObjectId, type AdSpendProvider, type CampaignStatusGroup } from "@app/shared/ads";
import { isDemoObjectId } from "@app/shared/adsDemo";
import { fmtMoney, fmtNum, fmtPct } from "@/lib/api";
import { BEING_READ, ChangeNote, ComparedLine } from "@/components/dashboard/AdsCommon";
import { shownFigures } from "@/components/dashboard/adFigures";
import { DemoChip } from "@/components/dashboard/Advertising";
import { fmtTimes } from "@/components/dashboard/format";
import { ChartChoice, Delta, NeutralDelta, Panel } from "@/components/dashboard/Primitives";
import type { AdsModule, Overview } from "@/components/dashboard/types";
import { PLATFORM } from "./AdvertisingUi";

// ---------------------------------------------------------------------------
// Every Meta and Google Ads campaign of the dates side by side, from their stored days, on the
// measures that mean the same thing on both. Each campaign's change is the API's, on the same whole
// days as the totals' (none when the totals have none). Purchases and ROAS are each platform's own
// claim; Google's other conversions stay apart from purchases, and Meta has none of them. A
// campaign's name opens its ad sets or ad groups in its platform's live report.
// ---------------------------------------------------------------------------

type Campaign = NonNullable<AdsModule["campaigns"]>[number];
type SortKey = "spend" | "purchaseValue" | "roas" | "linkClicks" | "ctr" | "cpc" | "impressions";
const SORTS: Array<[SortKey, string]> = [
  ["spend", "Spend"],
  ["purchaseValue", "Purchase value"],
  ["roas", "ROAS"],
  ["linkClicks", "Link clicks"],
  ["ctr", "Click-through rate"],
  ["cpc", "Cost per click"],
  ["impressions", "Impressions"],
];

type StatusFilter = "all" | CampaignStatusGroup | "unknown";
const STATUS_FILTERS: Array<[StatusFilter, string]> = [["all", "All statuses"], ...CAMPAIGN_STATUS_GROUPS.map((g): [StatusFilter, string] => [g, CAMPAIGN_STATUS_GROUP_LABEL[g]]), ["unknown", "Status not read yet"]];

/** Whether a campaign is one the filters ask for: its name (or id) has the words typed, and its status is the one picked. */
function matches(c: Campaign, query: string, status: StatusFilter) {
  const q = query.trim().toLowerCase();
  const named = !q || c.name.toLowerCase().includes(q) || c.campaignId === q;
  const group = c.statusGroup ?? null;
  return named && (status === "all" || (status === "unknown" ? group === null : group === status));
}

/** The platform's own word, as a reader would write it (CAMPAIGN_PAUSED → "Campaign paused"). */
const statusWords = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, " ");

/**
 * Where a campaign's ad sets (Meta) or ad groups (Google) are: its platform's page, narrowed to its
 * account, with the campaign opened in the live report (ReportDrill); the dates come along (kept for
 * the tab). None for the "Other campaigns" row (what Meta's account spent beyond its listed campaigns)
 * or an id the report doesn't take.
 */
function drillHref(c: Campaign, connectionId: string | undefined): string | null {
  if (!connectionId) return null;
  const known = c.provider === "meta" ? isMetaObjectId(c.campaignId) : isGoogleObjectId(c.campaignId) || isDemoObjectId(c.campaignId);
  if (!known) return null;
  return `/advertising/${c.provider}?${new URLSearchParams({ account: connectionId, campaign: c.campaignId })}`;
}

/** A figure not known yet (null) sorts last, whichever way. */
function byKey(k: SortKey) {
  return (a: Campaign, b: Campaign) => {
    const x = a[k];
    const y = b[k];
    if (x === null && y === null) return b.spend - a.spend;
    if (x === null) return 1;
    if (y === null) return -1;
    // The cheapest click first; every other measure biggest first.
    return k === "cpc" ? x - y : y - x;
  };
}

/** A campaign's change; what it is against is said once, above the table. */
function SpendChange({ c, a }: { c: Campaign; a: AdsModule }) {
  if (!a.compared || !c.change) return <span className="text-muted">—</span>;
  if (c.change.previous.spend === 0) return <span className="text-xs text-muted">{c.spend > 0 ? "new" : "—"}</span>;
  return <NeutralDelta value={c.change.deltas.spend} label="" />;
}

function RoasChange({ c, a }: { c: Campaign; a: AdsModule }) {
  if (!a.compared || !c.change || c.change.deltas.roas === null) return <span className="text-muted">—</span>;
  return <Delta value={c.change.deltas.roas} label="" />;
}

export function CampaignComparison({ ov }: { ov: Overview }) {
  const a = ov.modules.ads!;
  const [sort, setSort] = useState<SortKey>("spend");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const campaigns = a.campaigns ?? [];
  const money = (n: number) => fmtMoney(n, a.currency);
  const total = shownFigures(a).totals?.spend ?? null;
  const names = new Map(a.accounts.map((acc) => [`${acc.provider}:${acc.accountId}`, { name: acc.name ?? acc.accountId, demo: !!acc.demo, connectionId: acc.id }]));
  const providers = [...new Set(campaigns.map((c) => c.provider))] as AdSpendProvider[];
  const rows = campaigns.filter((c) => matches(c, query, status)).sort(byKey(sort));
  const filtered = rows.length !== campaigns.length;
  return (
    <Panel
      id="ad-campaigns"
      title={`${fmtNum(campaigns.length)} ${campaigns.length === 1 ? "campaign" : "campaigns"}${providers.length > 1 ? " across Meta and Google" : ""}`}
      help={
        <>
          Their stored days for these dates, in {a.currency}.{" "}
          {a.compared ? (
            <>
              Changes compare {a.compared.trimmed ? "whole days only, through the last day over" : "the dates compared with"}: <ComparedLine fig={a} show={(t) => money(t.spend)} what="all spend" />.
            </>
          ) : (
            <>
              Changes: <ChangeNote fig={a} value={null} ov={ov} />.
            </>
          )}
        </>
      }
      aside={<ChartChoice label="Sort by" value={sort} options={SORTS} onChange={setSort} />}
    >
      {campaigns.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2" data-testid="campaign-filters">
          <input
            type="search"
            className="input h-9 w-56"
            placeholder="Find a campaign"
            aria-label="Find a campaign by name or ID"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            data-testid="campaign-search"
          />
          <ChartChoice label="Campaign status" value={status} options={STATUS_FILTERS} onChange={setStatus} />
          {filtered && (
            <span className="text-xs text-muted" data-testid="campaign-filter-count" aria-live="polite">
              Showing {fmtNum(rows.length)} of {fmtNum(campaigns.length)}. Share of spend is still of all spend.
            </span>
          )}
        </div>
      )}
      {campaigns.length === 0 ? (
        <p className="text-sm text-muted">No campaign spent anything in these dates.</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted" data-testid="campaign-filter-empty">
          No campaign here matches.{" "}
          <button
            type="button"
            className="text-accent underline-offset-2 hover:underline"
            onClick={() => {
              setQuery("");
              setStatus("all");
            }}
          >
            Show every campaign
          </button>
        </p>
      ) : (
        <div className="-mx-1 overflow-x-auto">
          <table className="w-full min-w-[72rem] text-sm" data-testid="campaign-comparison">
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="px-1 pb-2 font-normal">Campaign</th>
                <th className="px-1 pb-2 font-normal">Status</th>
                <th className="px-1 pb-2 text-right font-normal">Spend</th>
                <th className="px-1 pb-2 text-right font-normal">Share of spend</th>
                <th className="px-1 pb-2 text-right font-normal">Spend change</th>
                <th className="px-1 pb-2 text-right font-normal">Impressions</th>
                <th className="px-1 pb-2 text-right font-normal">Link clicks</th>
                <th className="px-1 pb-2 text-right font-normal">Click-through rate</th>
                <th className="px-1 pb-2 text-right font-normal">Cost per click</th>
                <th className="px-1 pb-2 text-right font-normal">Purchases (platform&apos;s count)</th>
                <th className="px-1 pb-2 text-right font-normal">Purchase value (platform&apos;s count)</th>
                <th className="px-1 pb-2 text-right font-normal">ROAS (platform&apos;s own)</th>
                <th className="px-1 pb-2 text-right font-normal">ROAS change</th>
                <th className="px-1 pb-2 text-right font-normal">Conversions (all actions, Google)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const P = PLATFORM[c.provider];
                const account = names.get(`${c.provider}:${c.accountId}`);
                const href = drillHref(c, account?.connectionId);
                return (
                  <tr
                    key={`${c.provider}:${c.accountId}:${c.campaignId}`}
                    className="border-t border-border"
                    data-testid="campaign-row"
                    data-provider={c.provider}
                    data-status={c.statusGroup ?? "unknown"}
                  >
                    <td className="px-1 py-2">
                      <span className="inline-flex items-center gap-2">
                        <P.Icon size={14} />
                        {href ? (
                          <Link
                            className="font-medium text-accent underline-offset-2 hover:underline"
                            href={href}
                            title={`${c.name}: view its ${c.provider === "meta" ? "ad sets" : "ad groups"} in ${P.name}' live report`}
                            data-testid="campaign-drill-link"
                          >
                            {c.name}
                          </Link>
                        ) : (
                          <span className="font-medium">{c.name}</span>
                        )}
                        {account?.demo && <DemoChip small />}
                      </span>
                      <span className="block text-xs text-muted">
                        {P.name} · {account?.name ?? c.accountId}
                        {c.complete === false ? " · its account's figures stop before these dates end" : ""}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-1 py-2 text-xs" title={c.status ? `${P.name} says ${c.status}` : undefined}>
                      {c.status ? statusWords(c.status) : <span className="text-muted">Not read yet</span>}
                    </td>
                    <td className="px-1 py-2 text-right tabular-nums">{money(c.spend)}</td>
                    <td className="px-1 py-2 text-right tabular-nums">{total ? fmtPct(c.spend / total) : "—"}</td>
                    <td className="whitespace-nowrap px-1 py-2 text-right">
                      <SpendChange c={c} a={a} />
                    </td>
                    <td className="px-1 py-2 text-right tabular-nums">{fmtNum(c.impressions)}</td>
                    <td className="px-1 py-2 text-right tabular-nums">{c.linkClicks === null ? BEING_READ : fmtNum(c.linkClicks)}</td>
                    <td className="px-1 py-2 text-right tabular-nums">{c.linkClicks === null ? BEING_READ : fmtPct(c.ctr)}</td>
                    <td className="px-1 py-2 text-right tabular-nums">{c.linkClicks === null ? BEING_READ : c.cpc === null ? "—" : money(c.cpc)}</td>
                    <td className="px-1 py-2 text-right tabular-nums">{c.purchases === null ? BEING_READ : fmtNum(c.purchases)}</td>
                    <td className="px-1 py-2 text-right tabular-nums">{c.purchaseValue === null ? BEING_READ : money(c.purchaseValue)}</td>
                    <td className="px-1 py-2 text-right tabular-nums">{c.purchases === null ? BEING_READ : fmtTimes(c.roas)}</td>
                    <td className="whitespace-nowrap px-1 py-2 text-right">
                      <RoasChange c={c} a={a} />
                    </td>
                    <td className="px-1 py-2 text-right tabular-nums">{c.provider === "google" ? fmtNum(c.conversions) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-xs text-muted">
        Purchases, their value and ROAS are what each platform credits to its own ads: a sale can be counted by both, and they aren&apos;t your Shopify orders. A campaign&apos;s change
        compares the same whole days as the totals above; one that spent nothing in the dates compared is new, not up from $0. A status is the platform&apos;s own, as of the
        account&apos;s last sync.
      </p>
    </Panel>
  );
}

"use client";
import { useEffect, useState } from "react";
import { CAMPAIGN_SORTS, type CampaignSort } from "@app/shared/adsAnalytics";
import { Badge } from "@/components/dashboard/Primitives";
import { fmtDay } from "@/components/dashboard/format";
import { LoadError } from "@/components/LoadError";
import { friendlyError, useApi } from "@/lib/api";
import { campaignStatusLabel, campaignTypeLabel, type CampaignsAnswer } from "@/lib/googleAds";
import { METRIC_COLUMNS, Section, figureWriters, writeMetric } from "./ui";

/** Section 2: the campaign table, searched, filtered, sorted and paged by the API (GET .../analytics/campaigns). */
export function CampaignsSection({ base, dates, currency, demo, types, statuses }: { base: string; dates: string; currency: string; demo: boolean; types: string[]; statuses: string[] }) {
  const [q, setQ] = useState("");
  const [typed, setTyped] = useState("");
  const [status, setStatus] = useState("");
  const [type, setType] = useState("");
  const [sort, setSort] = useState<CampaignSort>("spend");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(5);
  // The search asks the API once typing pauses, not per keystroke.
  useEffect(() => {
    const t = window.setTimeout(() => {
      setQ(typed.trim());
      setPage(1);
    }, 300);
    return () => window.clearTimeout(t);
  }, [typed]);
  const qs = new URLSearchParams({ sort, dir, page: String(page), pageSize: String(pageSize), ...(q ? { q } : {}), ...(status ? { status } : {}), ...(type ? { type } : {}) });
  const answer = useApi<CampaignsAnswer>(`${base}/analytics/campaigns?${dates}&${qs}`);
  const w = figureWriters(currency);
  const a = answer.data;
  const order = (key: CampaignSort) => {
    if (sort === key) setDir(dir === "desc" ? "asc" : "desc");
    else {
      setSort(key);
      setDir(key === "name" ? "asc" : "desc");
    }
    setPage(1);
  };
  const arrow = (key: CampaignSort) => (sort === key ? (dir === "desc" ? " ↓" : " ↑") : "");
  const th = (key: CampaignSort, label: string, right = true) => (
    <th key={key} className={`px-2 pb-2 font-normal ${right ? "text-right" : ""}`} aria-sort={sort === key ? (dir === "asc" ? "ascending" : "descending") : "none"}>
      <button type="button" className="whitespace-nowrap hover:text-text" onClick={() => order(key)}>
        {label}
        {arrow(key)}
      </button>
    </th>
  );
  return (
    <Section id="campaigns" title="Campaign performance" help="Every campaign with figures in these dates. Search, sort by any column, filter by status or type, and page through." demo={demo}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input type="search" className="input h-9 w-56" placeholder="Search campaigns" aria-label="Search campaigns" value={typed} onChange={(e) => setTyped(e.target.value)} data-testid="ga-campaign-search" />
        <select
          className="input h-9 w-auto"
          aria-label="Campaign status"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
          data-testid="ga-campaign-status"
        >
          <option value="">Any status</option>
          {statuses.map((s) => (
            <option key={s} value={s}>
              {campaignStatusLabel(s)}
            </option>
          ))}
        </select>
        <select
          className="input h-9 w-auto"
          aria-label="Campaign type"
          value={type}
          onChange={(e) => {
            setType(e.target.value);
            setPage(1);
          }}
          data-testid="ga-campaign-type"
        >
          <option value="">Any type</option>
          {types.map((t) => (
            <option key={t} value={t}>
              {campaignTypeLabel(t)}
            </option>
          ))}
        </select>
        <select
          className="input h-9 w-auto"
          aria-label="Rows per page"
          value={pageSize}
          onChange={(e) => {
            setPageSize(Number(e.target.value));
            setPage(1);
          }}
        >
          {[5, 10, 25].map((n) => (
            <option key={n} value={n}>
              {n} per page
            </option>
          ))}
        </select>
      </div>
      {answer.error && !a ? (
        <LoadError what="the campaigns" error={answer.error} onRetry={() => void answer.reload()} busy={answer.loading} />
      ) : !a ? (
        <div className="skeleton h-40" aria-hidden="true" />
      ) : (
        <>
          <div className={`-mx-1 overflow-x-auto ${answer.loading ? "opacity-60" : ""}`} aria-busy={answer.loading}>
            <table className="w-full min-w-[72rem] text-sm" data-testid="ga-campaign-table">
              <thead className="text-left text-xs text-muted">
                <tr>
                  {th("name", "Campaign", false)}
                  <th className="px-2 pb-2 font-normal">Type</th>
                  <th className="px-2 pb-2 font-normal">Status</th>
                  {METRIC_COLUMNS.filter((m) => (CAMPAIGN_SORTS as readonly string[]).includes(m.key)).map((m) => th(m.key as CampaignSort, m.label))}
                </tr>
              </thead>
              <tbody>
                {a.rows.map((c) => (
                  <tr key={c.id} className="border-t border-border" data-testid="ga-campaign-row" data-campaign={c.id}>
                    <td className="max-w-[16rem] px-2 py-2">
                      <span className="block truncate font-medium" title={c.name}>
                        {c.name}
                      </span>
                      <span className="block text-xs text-muted">
                        {c.startDay ? `since ${fmtDay(c.startDay)}` : ""}
                        {c.dailyBudget !== null ? ` · budget ${w.money(c.dailyBudget)} a day` : ""}
                      </span>
                    </td>
                    <td className="px-2 py-2">{campaignTypeLabel(c.type)}</td>
                    <td className="px-2 py-2">
                      <Badge tone={c.status === "ENABLED" ? "good" : "neutral"}>{campaignStatusLabel(c.status)}</Badge>
                    </td>
                    {METRIC_COLUMNS.filter((m) => (CAMPAIGN_SORTS as readonly string[]).includes(m.key)).map((m) => (
                      <td key={m.key} className="px-2 py-2 text-right tabular-nums">
                        {writeMetric(w, m.kind, c[m.key])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {a.rows.length === 0 && <p className="mt-2 text-sm text-muted">No campaign matches.</p>}
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
            <span data-testid="ga-campaign-count">
              {a.total} campaign{a.total === 1 ? "" : "s"} · page {a.page} of {a.pages}
            </span>
            <span className="flex gap-2">
              <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={a.page <= 1} data-testid="ga-campaign-prev">
                Previous
              </button>
              <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={() => setPage((p) => Math.min(a.pages, p + 1))} disabled={a.page >= a.pages} data-testid="ga-campaign-next">
                Next
              </button>
            </span>
          </div>
          {answer.error && <p className="mt-2 text-xs text-muted">{friendlyError(answer.error)}</p>}
        </>
      )}
    </Section>
  );
}

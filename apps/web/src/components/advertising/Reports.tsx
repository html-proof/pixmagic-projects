"use client";
import type { AccessKey } from "@app/shared/access";
import { AD_PROVIDERS, type AdProvider, type AdSpendProvider } from "@app/shared/ads";
import { useApp } from "@/components/AppContext";
import { comparisonHelp, CustomDates, DateRangeSelect, type ShownComparison } from "@/components/dashboard/DateRange";
import { fmtRange } from "@/components/dashboard/format";
import { LoadError } from "@/components/LoadError";
import { useApi } from "@/lib/api";
import { AccountSelect, DownloadCsv, PLATFORM } from "./AdvertisingUi";
import { useAccountChoices, useAdvertisingQuestion, useQueryParam } from "./useAdvertising";

// ---------------------------------------------------------------------------
// The Advertising area's reports: each one's table as it downloads (GET …/export/table, the same rows
// as the CSV, apps/api/src/routes/exports.ts), for the dates, platform and account picked. Seeing a
// report needs what its page needs; downloading it needs "Export approved reports" as well, and
// the API checks both.
// ---------------------------------------------------------------------------

const REPORTS = [
  { id: "ads_summary", label: "Summary", need: "marketing.ads", about: "The overview's figures: ad spend, the platforms' own purchases and ROAS, your Shopify sales per unit of spend (MER) and AdSense's earnings, each with the figure compared with and the change." },
  { id: "ads_platforms", label: "By platform", need: "marketing.ads", about: "Each platform's totals for the dates; one without every day stored says Unavailable and why." },
  { id: "ads_daily", label: "By day", need: "marketing.ads", about: "Each platform's spend, impressions, clicks and own purchases day by day; a day without figures says so, never 0." },
  { id: "ads_campaigns", label: "Campaigns", need: "marketing.campaigns", about: "Every campaign with its account, its figures and its change in spend and ROAS on the same whole days as the totals." },
  { id: "adsense_daily", label: "AdSense by day", need: "marketing.ads", about: "AdSense's estimated earnings, page views, impressions and clicks day by day: money in, kept apart from ad spend." },
] as const satisfies ReadonlyArray<{ id: string; label: string; need: AccessKey; about: string }>;
type ReportId = (typeof REPORTS)[number]["id"];

const isReport = (v: string): v is ReportId => REPORTS.some((r) => r.id === v);
const isSpendPlatform = (v: string): v is AdSpendProvider => v === "meta" || v === "google";

interface Table {
  section: string;
  label: string;
  range: { from: string; to: string };
  previous: ShownComparison;
  header: string[];
  rows: Array<Array<string | number | null>>;
}

/** Rows shown on screen; the download has them all. */
const SHOWN_ROWS = 400;
const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const cell = (v: string | number | null) => (v === null ? "" : typeof v === "number" ? number.format(v) : v);

export function AdvertisingReports() {
  const { workspace, store, allowed } = useApp();
  const reports = REPORTS.filter((r) => allowed(r.need) && allowed("marketing.ads"));
  const [picked, setPicked] = useQueryParam("report", isReport);
  const [spendPlatform, setSpendPlatform] = useQueryParam("platform", isSpendPlatform);
  const report = reports.find((r) => r.id === picked) ?? reports[0];
  const adsense = report?.id === "adsense_daily";
  const platform: AdProvider | null = adsense ? "adsense" : report?.id === "ads_summary" ? null : spendPlatform;
  const q = useAdvertisingQuestion(platform);
  const accounts = useAccountChoices(adsense ? ["adsense"] : platform ? [platform] : AD_PROVIDERS.filter((p) => p !== "adsense"));
  const path = store && report && q.query ? `/workspaces/${workspace.id}/stores/${store.id}/export/table?section=${report.id}&${q.query}` : null;
  const table = useApi<Table>(path);
  const t = table.data;
  if (!report) return <p className="card text-sm text-muted">Your access doesn&apos;t include any advertising reports.</p>;

  return (
    <div className="space-y-4">
      <div className="animate-rise">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="page-title">Advertising reports</h1>
            <p className="mt-1 text-sm text-muted">Each report as it downloads, for the dates picked. The CSV holds exactly these rows.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <DateRangeSelect r={q.dates} shown={t ? { range: t.range, previous: t.previous, timezone: store?.timezone ?? "UTC" } : null} id="report-dates" label="Dates" size="sm" />
          </div>
        </div>
        <div className="mt-2 flex flex-wrap justify-end gap-2">
          <CustomDates r={q.dates} />
        </div>
        <div className="mt-3 flex flex-wrap gap-2" role="radiogroup" aria-label="Report">
          {reports.map((r) => (
            <button
              key={r.id}
              type="button"
              role="radio"
              aria-checked={r.id === report.id}
              onClick={() => setPicked(r.id)}
              className={`rounded-lg border px-3 py-1.5 text-sm transition ${r.id === report.id ? "border-accent bg-accent/10 font-medium" : "border-border text-muted hover:text-text"}`}
              data-testid={`report-${r.id}`}
            >
              {r.label}
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-muted">{report.about}</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {!adsense && report.id !== "ads_summary" && (
            <label className="flex items-center gap-2 text-xs text-muted">
              Platform
              <select
                className="input h-9 w-auto py-0 text-sm"
                aria-label="Platform"
                value={spendPlatform ?? ""}
                onChange={(e) => {
                  setSpendPlatform(isSpendPlatform(e.target.value) ? e.target.value : null);
                  q.setAccount(null);
                }}
                data-testid="report-platform"
              >
                <option value="">Meta Ads and Google Ads</option>
                <option value="meta">{PLATFORM.meta.name}</option>
                <option value="google">{PLATFORM.google.name}</option>
              </select>
            </label>
          )}
          <AccountSelect accounts={accounts} value={q.account} onChange={q.setAccount} />
          <span className="ml-auto">
            <DownloadCsv section={report.id} query={q.query} />
          </span>
        </div>
        {!allowed("reports.export") && <p className="mt-2 text-xs text-muted">Downloading needs the &ldquo;Export approved reports&rdquo; permission; ask a workspace owner or admin.</p>}
      </div>

      {table.error && !t ? (
        <LoadError what="this report" error={table.error} onRetry={() => void table.reload()} busy={table.loading} />
      ) : !t ? (
        <div className="card" aria-hidden>
          <div className="skeleton h-48" />
        </div>
      ) : (
        <section className="card min-w-0" aria-labelledby="report-h" data-testid="report-table">
          <h2 id="report-h" className="font-semibold">
            {t.label}
          </h2>
          <p className="mt-0.5 text-xs text-muted">
            {fmtRange(t.range.from, t.range.to)}, compared with {comparisonHelp(t.previous, t.range)}. {t.rows.length === 1 ? "1 row" : `${number.format(t.rows.length)} rows`}.
          </p>
          {t.rows.length === 0 ? (
            <p className="mt-3 text-sm text-muted">Nothing to report for these dates.</p>
          ) : (
            <div className="-mx-1 mt-3 overflow-x-auto">
              <table className="w-full min-w-[40rem] text-sm">
                <thead className="text-left text-xs text-muted">
                  <tr>
                    {t.header.map((h, i) => (
                      <th key={h} className={`px-1 pb-2 font-normal ${i === 0 ? "" : "text-right"}`}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {t.rows.slice(0, SHOWN_ROWS).map((r, i) => (
                    <tr key={i} className="border-t border-border" data-testid="report-row">
                      {r.map((v, j) => (
                        <td key={j} className={`px-1 py-1.5 ${j === 0 ? "" : "text-right tabular-nums"}`}>
                          {cell(v)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {t.rows.length > SHOWN_ROWS && <p className="mt-2 text-xs text-muted">The first {number.format(SHOWN_ROWS)} rows; the download has all {number.format(t.rows.length)}.</p>}
        </section>
      )}
    </div>
  );
}

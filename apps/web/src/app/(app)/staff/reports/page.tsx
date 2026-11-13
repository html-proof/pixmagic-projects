"use client";
import { useEffect, useState } from "react";
import {
  currencyExponent,
  GRANULARITIES,
  PAYMENT_STATUS_LABEL,
  PAYMENT_STATUSES,
  RANGE_LABEL,
  RANGE_PRESETS,
  type Granularity,
  type PaymentStatus,
} from "@app/shared/staff";
import { Panel } from "@/components/dashboard/Primitives";
import { LoadError } from "@/components/LoadError";
import { ColumnsChart, RankedBars, VIZ } from "@/components/staff/charts";
import { EstimateNote, KpiCard, RangeFilter, rangeQuery, rangeReady, Table, Tabs, Td, Th, type KpiData, type RangeValue } from "@/components/staff/ui";
import { PageHeader, Skeleton, useToast } from "@/components/AppUi";
import { actionError, useApi, useLiveApi } from "@/lib/api";
import { exportFile, fmtDay, fmtHours, fmtMoney, fmtSpan, useStaff } from "@/lib/staff";

// ---------------------------------------------------------------------------------------------
// Reports & analytics: one date range for the whole page (kept in the address bar, so a link
// reproduces the view), KPI cards, six charts and a downloadable report table. The API does all
// the counting; this page only arranges and formats its answers. No Stitch screen draws it: it
// takes the Team screens' look from the shared pieces (figure tiles, white cards, soft-header
// tables and tabs in components/staff/ui.tsx).
// ---------------------------------------------------------------------------------------------

interface Analytics {
  asOf: string;
  timezone: string;
  currency: string | null;
  range: { from: string; to: string };
  kpis: KpiData[];
  notes: string[];
}

interface Trends {
  asOf: string;
  timezone: string;
  currency: string | null;
  range: { from: string; to: string };
  granularity: Granularity;
  allowedGranularities: Granularity[];
  buckets: Array<{
    key: string;
    label: string;
    regularSeconds: number;
    overtimeSeconds: number;
    regularCost?: string;
    overtimeCost?: string;
    cost?: string;
    paid?: string;
    owed?: string;
    outstanding?: string;
  }>;
  attendance: Array<{ key: string; label: string; present: number; absent: number; late: number; unscheduled: number }>;
  employees: Array<{ id: string; fullName: string; department: string | null; seconds: number; overtimeSeconds: number; cost?: string; currency?: string }>;
  notes: string[];
}

type ReportType = "attendance" | "payroll" | "payments";
type ReportGroup = "employee" | "department" | "position" | "day" | "week" | "month" | "year" | "period" | "method" | "status";
type CellValue = string | number | null;

interface Report {
  title: string;
  subtitle: string;
  range: { from: string; to: string };
  columns: Array<{ key: string; label: string; kind: "text" | "hours" | "money" | "count" }>;
  rows: Array<Record<string, CellValue>>;
  totals: Record<string, CellValue> | null;
  notes: string[];
}

const REPORT_LABEL: Record<ReportType, string> = { attendance: "Attendance", payroll: "Payroll", payments: "Payments" };
const GROUP_LABEL: Record<ReportGroup, string> = {
  employee: "Employee",
  department: "Department",
  position: "Position",
  day: "Day",
  week: "Week",
  month: "Month",
  year: "Year",
  period: "Pay period",
  method: "Payment method",
  status: "Status",
};
/** What each report can be grouped by (the API checks the same list). */
const GROUPS: Record<ReportType, ReportGroup[]> = {
  attendance: ["employee", "department", "position", "day", "week", "month", "year"],
  payroll: ["employee", "department", "position", "period", "month", "year", "status"],
  payments: ["employee", "department", "method", "status", "day", "week", "month", "year"],
};
const REPORT_TYPES = Object.keys(GROUPS) as ReportType[];

/** How many report rows to draw; the downloads always have all of them. */
const SHOWN_ROWS = 500;

const isDay = (s: string | null): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

/** useLiveApi plus "Try again" (asking a fresh question makes it check now) and the question actually asked. */
function useLive<T>(path: string | null, ms: number) {
  const [n, setN] = useState(0);
  const asked = path && n ? `${path}${path.includes("?") ? "&" : "?"}_r=${n}` : path;
  const live = useLiveApi<T>(asked, ms);
  return { ...live, asked, retry: () => setN((x) => x + 1) };
}

/** Money for charts: bar heights need numbers; labels go back through the exact formatter. */
const amount = (s: string | undefined) => (s ? Number(s) : 0);
const moneyFormat = (currency: string) => (v: number) => fmtMoney(v.toFixed(currencyExponent(currency)), currency);
const hoursFormat = (v: number) => fmtHours(Math.round(v));
const countFormat = (v: number) => new Intl.NumberFormat().format(v);

export default function StaffReports() {
  const { base, can } = useStaff();
  const pay = can("pay:view");
  const toast = useToast();

  const [range, setRange] = useState<RangeValue>({ preset: "this_month", from: "", to: "" });
  const [type, setType] = useState<ReportType>("attendance");
  const [groupBy, setGroupBy] = useState<ReportGroup>("employee");
  const [paymentStatus, setPaymentStatus] = useState<PaymentStatus | "">("");
  const [restored, setRestored] = useState(false);
  const [view, setView] = useState<"cost" | "hours">(pay ? "cost" : "hours");
  const [allEmployees, setAllEmployees] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);

  // Read the view from the address bar once, before asking anything, so a shared link doesn't
  // first load this month.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const preset = RANGE_PRESETS.find((p) => p === q.get("preset"));
    const g = GRANULARITIES.find((x) => x === q.get("g"));
    const from = q.get("from");
    const to = q.get("to");
    if (preset) setRange({ preset, from: isDay(from) ? from : "", to: isDay(to) ? to : "", granularity: g });
    const t = REPORT_TYPES.find((x) => x === q.get("report"));
    const usableType = t && (t === "attendance" || pay) ? t : "attendance";
    setType(usableType);
    const by = GROUPS[usableType].find((x) => x === q.get("by"));
    if (by) setGroupBy(by);
    const ps = PAYMENT_STATUSES.find((x) => x === q.get("status"));
    if (ps) setPaymentStatus(ps);
    setRestored(true);
    // Once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ...and keep it there (replace, not push: each change isn't a page to go back through).
  useEffect(() => {
    if (!restored) return;
    const url = new URL(window.location.href);
    for (const k of ["preset", "from", "to", "g", "report", "by", "status"]) url.searchParams.delete(k);
    url.searchParams.set("preset", range.preset);
    if (range.preset === "custom") {
      if (range.from) url.searchParams.set("from", range.from);
      if (range.to) url.searchParams.set("to", range.to);
    }
    if (range.granularity) url.searchParams.set("g", range.granularity);
    if (type !== "attendance") url.searchParams.set("report", type);
    if (groupBy !== "employee") url.searchParams.set("by", groupBy);
    if (type === "payments" && paymentStatus) url.searchParams.set("status", paymentStatus);
    if (url.href !== window.location.href) window.history.replaceState(window.history.state, "", url.href);
  }, [restored, range, type, groupBy, paymentStatus]);

  // A pay report needs pay:view, which can change with the workspace: fall back to attendance.
  const reportType: ReportType = type !== "attendance" && !pay ? "attendance" : type;
  const reportGroup: ReportGroup = GROUPS[reportType].includes(groupBy) ? groupBy : "employee";
  const live = range.preset === "live";
  const ready = restored && rangeReady(range);
  const rq = rangeQuery({ ...range, granularity: undefined });
  const every = live ? 30_000 : 300_000;
  const kpis = useLive<Analytics>(ready ? `${base}/analytics?${rq}` : null, every);
  const trends = useLive<Trends>(ready ? `${base}/analytics/trends?${rangeQuery(range)}` : null, every);
  const reportQs = new URLSearchParams({ type: reportType, groupBy: reportGroup, ...(reportType === "payments" && paymentStatus ? { paymentStatus } : {}) }).toString();
  const report = useApi<Report>(ready ? `${base}/reports?${reportQs}&${rq}` : null);

  const k = kpis.data;
  const t = trends.data;
  const cur = t?.currency ?? k?.currency ?? null;
  const updating = (kpis.loading || trends.loading) && (kpis.dataPath !== kpis.asked || trends.dataPath !== trends.asked);
  const allowed = t?.allowedGranularities;

  function changeRange(next: RangeValue) {
    // Custom starts from the dates on screen, so only the end that changes has to be picked.
    if (next.preset === "custom" && range.preset !== "custom" && !next.from && !next.to && t) next = { ...next, from: t.range.from, to: t.range.to };
    setRange(next);
    setAllEmployees(false);
  }

  function changeType(next: ReportType) {
    setType(next);
    if (!GROUPS[next].includes(groupBy)) setGroupBy("employee");
  }

  async function download(format: "csv" | "xlsx" | "pdf") {
    setExporting(format);
    try {
      await exportFile(base, {
        kind: "report",
        format,
        report: {
          type: reportType,
          groupBy: reportGroup,
          preset: range.preset === "live" ? "today" : range.preset,
          ...(range.preset === "custom" ? { from: range.from, to: range.to } : {}),
          ...(reportType === "payments" && paymentStatus ? { paymentStatus } : {}),
        },
      });
    } catch (e) {
      toast("error", actionError(e, "prepare the download"));
    } finally {
      setExporting(null);
    }
  }

  const labels = t?.buckets.map((b) => b.label) ?? [];
  const kpi = (key: string) => k?.kpis.find((x) => x.key === key);
  const employees = t ? (allEmployees ? t.employees : t.employees.slice(0, 10)) : [];

  return (
    <>
      <PageHeader
        title="Reports & analytics"
        sub={
          k ? (
            <>
              {RANGE_LABEL[range.preset]} · {fmtSpan(k.range.from, k.range.to)} · times in {k.timezone} · updated{" "}
              {new Date(k.asOf).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
              {kpis.failing && " · can't reach bizinsights, showing the last update"}
            </>
          ) : (
            "Hours, attendance and pay over any period, with tables you can download."
          )
        }
      />

      <section className="card sticky top-2 z-20 !py-3" aria-label="Period">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <RangeFilter value={{ ...range, granularity: range.granularity && allowed && !allowed.includes(range.granularity) ? undefined : range.granularity }} onChange={changeRange} granularities={allowed} />
          <p className="pb-2 text-xs text-muted" aria-live="polite">
            {updating ? (
              "Updating…"
            ) : live ? (
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden className="relative flex h-2 w-2">
                  <span className="animate-ping-soft absolute inline-flex h-full w-full rounded-full bg-good opacity-60" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-good" />
                </span>
                Live: today, updated every 30 seconds
              </span>
            ) : null}
          </p>
        </div>
      </section>

      {/* KPI cards */}
      <section aria-label="Key figures" className="space-y-3">
        {kpis.error && !k ? (
          <LoadError what="the key figures" error={kpis.error} onRetry={kpis.retry} busy={kpis.loading} />
        ) : !k ? (
          ready ? <Skeleton lines={4} /> : null
        ) : (
          <div className={`grid grid-cols-1 gap-3 transition-opacity sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 ${updating ? "opacity-60" : ""}`}>
            {k.kpis.map((x) => (
              <KpiCard key={x.key} kpi={x} currency={k.currency} />
            ))}
          </div>
        )}
      </section>

      {/* Charts */}
      {trends.error && !t ? (
        <LoadError what="the charts" error={trends.error} onRetry={trends.retry} busy={trends.loading} />
      ) : !t ? (
        ready ? <Skeleton lines={6} /> : null
      ) : (
        <div className={`grid gap-4 transition-opacity lg:grid-cols-2 ${updating ? "opacity-60" : ""}`}>
          <Panel id="chart-hours" title="Working hours" help="Paid time worked in each period, split into regular hours and overtime.">
            <ColumnsChart
              label="Working hours per period"
              labels={labels}
              series={[
                { key: "regular", label: "Regular", color: VIZ[0], values: t.buckets.map((b) => b.regularSeconds) },
                { key: "overtime", label: "Overtime", color: VIZ[1], values: t.buckets.map((b) => b.overtimeSeconds) },
              ]}
              format={hoursFormat}
              empty="No hours recorded in this period yet. They appear as soon as someone clocks in."
            />
          </Panel>

          {pay && cur && (
            <Panel id="chart-cost" title="Payroll cost" help="Estimated wages earned in each period, from recorded hours and pay rates.">
              <ColumnsChart
                label="Payroll cost per period"
                labels={labels}
                series={[{ key: "cost", label: "Estimated wages", color: VIZ[0], values: t.buckets.map((b) => amount(b.cost)) }]}
                format={moneyFormat(cur)}
                empty="No wages in this period yet. Check that your staff have pay rates if hours were worked."
              />
            </Panel>
          )}

          <Panel
            id="chart-employees"
            title={pay ? "Cost per employee" : "Hours per employee"}
            help={pay ? "Estimated wages per person in this period, highest first." : "Hours worked per person in this period, most first."}
          >
            {t.employees.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border px-3 py-10 text-center text-sm text-muted">Nobody worked in this period.</p>
            ) : (
              <>
                <RankedBars
                  label={pay ? "Cost per employee" : "Hours per employee"}
                  format={pay && cur ? moneyFormat(cur) : hoursFormat}
                  rows={employees.map((e) => ({
                    key: e.id,
                    label: e.fullName,
                    sub: [e.department, `${fmtHours(e.seconds)} worked`, e.overtimeSeconds > 0 ? `${fmtHours(e.overtimeSeconds)} overtime` : null, pay && e.currency && e.currency !== cur ? `paid in ${e.currency}` : null]
                      .filter(Boolean)
                      .join(" · "),
                    value: pay ? (e.currency === cur ? amount(e.cost) : 0) : e.seconds,
                    display: pay ? fmtMoney(e.cost, e.currency) : fmtHours(e.seconds),
                  }))}
                />
                {t.employees.length > 10 && (
                  <button type="button" className="mt-3 text-sm text-accent hover:underline" onClick={() => setAllEmployees((x) => !x)}>
                    {allEmployees ? "Show the top 10" : `Show all ${t.employees.length}`}
                  </button>
                )}
              </>
            )}
          </Panel>

          <Panel
            id="chart-overtime"
            title="Regular vs overtime"
            help={view === "cost" ? "What regular hours and overtime cost in each period." : "How much of the time worked was overtime."}
            aside={pay && cur ? <Tabs label="Show" tabs={[["cost", "Cost"], ["hours", "Hours"]] as const} value={view} onChange={setView} /> : undefined}
          >
            {(kpi("regular_hours") || kpi("overtime_hours")) && (
              <p className="mb-3 text-sm">
                Regular <span className="font-semibold tabular-nums">{fmtHours(Number(kpi("regular_hours")?.value ?? 0))}</span> · Overtime{" "}
                <span className="font-semibold tabular-nums">{fmtHours(Number(kpi("overtime_hours")?.value ?? 0))}</span>
              </p>
            )}
            {view === "cost" && pay && cur ? (
              <ColumnsChart
                label="Regular and overtime cost per period"
                labels={labels}
                series={[
                  { key: "regular", label: "Regular pay", color: VIZ[0], values: t.buckets.map((b) => amount(b.regularCost)) },
                  { key: "overtime", label: "Overtime pay", color: VIZ[1], values: t.buckets.map((b) => amount(b.overtimeCost)) },
                ]}
                format={moneyFormat(cur)}
                empty="No wages in this period yet."
              />
            ) : (
              <ColumnsChart
                label="Regular and overtime hours per period"
                labels={labels}
                series={[
                  { key: "regular", label: "Regular hours", color: VIZ[0], values: t.buckets.map((b) => b.regularSeconds) },
                  { key: "overtime", label: "Overtime hours", color: VIZ[1], values: t.buckets.map((b) => b.overtimeSeconds) },
                ]}
                format={hoursFormat}
                empty="No hours recorded in this period yet."
              />
            )}
          </Panel>

          <Panel
            id="chart-attendance"
            title="Attendance"
            help="Absent: had a scheduled shift but didn't clock in. Late: clocked in after the scheduled start plus the grace period. Present: clocked in at least once that day."
          >
            <ColumnsChart
              label="Attendance per period"
              labels={t.attendance.map((a) => a.label)}
              mode="grouped"
              series={[
                { key: "present", label: "Present", color: VIZ[0], values: t.attendance.map((a) => a.present) },
                { key: "absent", label: "Absent", color: VIZ[2], values: t.attendance.map((a) => a.absent) },
                { key: "late", label: "Late", color: VIZ[1], values: t.attendance.map((a) => a.late) },
              ]}
              format={countFormat}
              empty="No attendance to show yet. Absences only count when you plan shifts in Shift schedules."
            />
          </Panel>

          {pay && cur && (
            <Panel
              id="chart-paid"
              title="Paid vs outstanding"
              help="Owed: approved payroll (net) for pay periods ending in each period. Paid: payments recorded with a date in it. Outstanding: what is still unpaid of what was owed."
            >
              <ColumnsChart
                label="Paid, owed and outstanding per period"
                labels={labels}
                mode="grouped"
                series={[
                  { key: "paid", label: "Paid", color: VIZ[0], values: t.buckets.map((b) => amount(b.paid)) },
                  { key: "owed", label: "Owed", color: VIZ[1], values: t.buckets.map((b) => amount(b.owed)) },
                  { key: "outstanding", label: "Outstanding", color: VIZ[2], values: t.buckets.map((b) => amount(b.outstanding)) },
                ]}
                format={moneyFormat(cur)}
                empty="No approved payroll or payments in this period. They appear once a payroll is approved or a payment is recorded."
              />
            </Panel>
          )}
        </div>
      )}

      {(pay || (k?.notes.length ?? 0) > 0 || (t?.notes.length ?? 0) > 0) && (
        <div className="space-y-2">
          {pay && <EstimateNote />}
          {[...new Set([...(k?.notes ?? []), ...(t?.notes ?? [])])].map((n) => (
            <p key={n} className="text-xs text-muted">
              {n}
            </p>
          ))}
        </div>
      )}

      {/* Report table */}
      <Panel
        id="report"
        title="Reports"
        help="A table for the period above, grouped the way you choose. Download it for your records or your accountant."
        aside={
          can("staff:export") ? (
            <div className="flex flex-wrap gap-2" role="group" aria-label="Download">
              {(
                [
                  ["csv", "CSV"],
                  ["xlsx", "Excel"],
                  ["pdf", "PDF"],
                ] as const
              ).map(([f, label]) => (
                <button key={f} type="button" className="btn-secondary px-3 py-1.5" disabled={!ready || exporting !== null} onClick={() => void download(f)}>
                  {exporting === f ? "Preparing…" : label}
                </button>
              ))}
            </div>
          ) : undefined
        }
      >
        <div className="flex flex-wrap items-end gap-3">
          <label className="min-w-[9rem]">
            <span className="label text-xs text-muted">Report</span>
            <select className="input" value={reportType} onChange={(e) => changeType(e.target.value as ReportType)}>
              {REPORT_TYPES.filter((x) => x === "attendance" || pay).map((x) => (
                <option key={x} value={x}>
                  {REPORT_LABEL[x]}
                </option>
              ))}
            </select>
          </label>
          <label className="min-w-[9rem]">
            <span className="label text-xs text-muted">Group by</span>
            <select className="input" value={reportGroup} onChange={(e) => setGroupBy(e.target.value as ReportGroup)}>
              {GROUPS[reportType].map((g) => (
                <option key={g} value={g}>
                  {GROUP_LABEL[g]}
                </option>
              ))}
            </select>
          </label>
          {reportType === "payments" && (
            <label className="min-w-[9rem]">
              <span className="label text-xs text-muted">Payment status</span>
              <select className="input" value={paymentStatus} onChange={(e) => setPaymentStatus(e.target.value as PaymentStatus | "")}>
                <option value="">All</option>
                {PAYMENT_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {PAYMENT_STATUS_LABEL[s]}
                  </option>
                ))}
              </select>
            </label>
          )}
          {report.data && (
            <button type="button" className="pb-2 text-sm text-accent hover:underline disabled:opacity-50" onClick={() => void report.reload()} disabled={report.loading}>
              {report.loading ? "Refreshing…" : "Refresh"}
            </button>
          )}
        </div>

        <div className="mt-4">
          {report.error && !report.data ? (
            <LoadError what="the report" error={report.error} onRetry={() => void report.reload()} busy={report.loading} />
          ) : !report.data ? (
            ready ? <Skeleton lines={5} /> : null
          ) : (
            <ReportTable report={report.data} groupBy={reportGroup} currency={cur} />
          )}
        </div>
      </Panel>
    </>
  );
}

const MONTH = (key: string) => new Intl.DateTimeFormat(undefined, { timeZone: "UTC", month: "long", year: "numeric" }).format(new Date(`${key}-01T00:00:00Z`));

function ReportTable({ report, groupBy, currency }: { report: Report; groupBy: ReportGroup; currency: string | null }) {
  const cols = report.columns;
  const group = (v: CellValue) => {
    const s = v === null ? "—" : String(v);
    if ((groupBy === "day" || groupBy === "week") && /^\d{4}-\d{2}-\d{2}$/.test(s)) return fmtDay(s, { weekday: groupBy === "day", year: true });
    if (groupBy === "month" && /^\d{4}-\d{2}$/.test(s)) return MONTH(s);
    return s;
  };
  const cell = (kind: Report["columns"][number]["kind"], key: string, v: CellValue, row: Record<string, CellValue>, total = false) => {
    if (v === null || v === undefined || v === "") return kind === "text" ? "" : "—";
    if (kind === "hours") return fmtHours(Number(v));
    if (kind === "count") return new Intl.NumberFormat().format(Number(v));
    if (kind === "money") {
      const c = typeof row.currency === "string" && row.currency ? row.currency : currency;
      return c ? fmtMoney(String(v), c) : String(v);
    }
    return key === "group" && !total ? group(v) : String(v);
  };
  const rows = report.rows.slice(0, SHOWN_ROWS);

  return (
    <div className="space-y-3">
      <div>
        <h3 className="font-medium">{report.title}</h3>
        <p className="text-xs text-muted">{report.subtitle}</p>
      </div>
      {report.rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-8 text-center text-sm text-muted">Nothing to report for this period. Try a longer period or another report.</p>
      ) : (
        <Table label={report.title}>
          <thead>
            <tr>
              {cols.map((c) => (
                <Th key={c.key} right={c.kind !== "text"}>
                  {c.label}
                </Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="hover:bg-bg/60">
                {cols.map((c) => (
                  <Td key={c.key} right={c.kind !== "text"}>
                    {cell(c.kind, c.key, r[c.key] ?? null, r)}
                  </Td>
                ))}
              </tr>
            ))}
          </tbody>
          {report.totals && (
            <tfoot>
              <tr className="font-semibold">
                {cols.map((c) => (
                  <Td key={c.key} right={c.kind !== "text"} className="border-t-2 border-t-border">
                    {cell(c.kind, c.key, report.totals![c.key] ?? null, report.totals!, true)}
                  </Td>
                ))}
              </tr>
            </tfoot>
          )}
        </Table>
      )}
      {report.rows.length > SHOWN_ROWS && (
        <p className="text-xs text-muted">
          Showing the first {SHOWN_ROWS} of {new Intl.NumberFormat().format(report.rows.length)} rows. The downloads include all of them.
        </p>
      )}
      {report.notes.length > 0 && (
        <ul className="space-y-1 text-xs text-muted">
          {report.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

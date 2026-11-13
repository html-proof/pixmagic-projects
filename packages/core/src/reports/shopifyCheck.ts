/**
 * The reconciliation report: bizinsights' figures next to Shopify's own reports for a set of
 * standard periods, each figure classified, read live from Shopify (the dashboard's check uses
 * the kept answers instead, reports/shopify.ts). Run by the cron Lambda's "shopify-check" action
 * (operators, docs/RUNBOOK.md) and by `GET .../shopify-check` (a member with "View financial reports"
 * and the sales breakdown; CSV too).
 *
 * Statuses, as the audit defines them:
 * - match: the same to the cent (orders: the same count).
 * - difference: they differ while nothing explains it; worth a look (`reconcileSales`).
 * - sync_delay: they differ while changes from Shopify are still being counted here.
 * - definition_mismatch: not the same measure, shown side by side (the pixel's tracked visits
 *   against Shopify's sessions).
 * - not_verifiable: one side has no figure: Shopify refused or can't run the report, or the
 *   period starts before bizinsights' imported history (Shopify shares 60 days of orders).
 */
import { Prisma, type Store, type Tx } from "@app/db";
import { DATE_PRESETS, historyStart, resolvePreset, summarize, type DatePreset } from "@app/shared";
import { env } from "../env.js";
import { fetchUntil } from "../http.js";
import { fetchShopifyReport, type ReportFetchDeps, type ReportValues, type ReportWindow } from "../shopifyReports.js";
import { localMoment } from "./common.js";
import { dataFreshness } from "./overview.js";
import { dailyRows, dailyRowsUntil } from "./sales.js";
import { reconcileSales } from "./shopify.js";

export const CHECK_PERIODS = ["today", "yesterday", "7d", "30d", "90d", "mtd", "lastmonth"] as const satisfies readonly DatePreset[];

export type CheckStatus = "match" | "difference" | "sync_delay" | "definition_mismatch" | "not_verifiable";

/**
 * How long the route's calls to Shopify may take in all (up to 21 of them), so the report comes
 * within the API's time limit: as long as a live ad report's reads get (AD_REPORT_BUDGET_MS). A
 * call it cuts off is one Shopify didn't answer; none starts after it.
 */
export const SHOPIFY_CHECK_BUDGET_MS = 40_000;

/**
 * Where the report reads our figures: each time in a short tenant transaction (the API's route), or
 * straight from systemDb (the cron). Shopify is asked between reads, never inside one: its calls
 * take seconds each, and a transaction expires after 20 (TX_TIMEOUT_MS in @app/db).
 */
export type CheckReads = <T>(read: (tx: Tx) => Promise<T>) => Promise<T>;

export interface CheckReportRow {
  metric: string;
  shopify: number | null;
  bizinsights: number | null;
  difference: number | null;
  /** difference ÷ Shopify's figure × 100; null when Shopify's is 0 or missing. */
  percent: number | null;
  status: CheckStatus;
  note: string | null;
}

export interface CheckReportPeriod {
  preset: DatePreset;
  from: string;
  to: string;
  /** Store-local time the last day is counted up to, while the period is still running. */
  until: string | null;
  rows: CheckReportRow[];
}

const LABEL: Record<string, string> = {
  grossSales: "Gross sales",
  discounts: "Discounts",
  returns: "Returns (sales reversals)",
  netSales: "Net sales",
  shipping: "Shipping charges",
  duties: "Duties",
  additionalFees: "Additional fees",
  taxes: "Taxes",
  totalSales: "Total sales",
  orders: "Orders",
  averageOrderValue: "Average order value",
  sessions: "Sessions",
  visitors: "Visitors",
  conversionRate: "Conversion rate",
  grossProfit: "Gross profit",
  costOfGoodsSold: "Cost of goods sold",
};

const r2 = (n: number) => Math.round(n * 100) / 100;
const pct = (difference: number | null, shopify: number | null) => (difference === null || shopify === null || shopify === 0 ? null : r2((difference / Math.abs(shopify)) * 100));
const val = (x: ReportValues | null, k: string) => (x ? (x[k] ?? null) : null);

const REFUSED: Record<string, string> = {
  access_denied: "Shopify didn't let bizinsights read this report (Reports access, or protected customer data approval).",
  unsupported: "Shopify can't run this report for this store (plan or report).",
  failed: "Shopify's reports didn't answer.",
  not_granted: "The store hasn't granted bizinsights its Shopify reports (read_reports).",
  out_of_time: "Not asked: Shopify's reports were slow to answer, so the check stopped. Try again in a few minutes.",
};

/** Store-local tracked visits (the web pixel's) in a window, cut at the same time of day while it runs. */
async function trackedVisits(tx: Tx, store: Pick<Store, "id" | "workspaceId" | "timezone">, w: ReportWindow) {
  const cut = w.until ? Prisma.sql`AND (day < ${w.to} OR entered_at IS NULL OR entered_at < ${localMoment(w.to, w.until, store.timezone)})` : Prisma.empty;
  const [row] = await tx.$queryRaw<Array<{ visits: number; bought: number }>>`
    SELECT COUNT(*)::int AS visits, (COUNT(*) FILTER (WHERE furthest_step = 4))::int AS bought
    FROM funnel_visits
    WHERE workspace_id = ${store.workspaceId} AND store_id = ${store.id} AND day BETWEEN ${w.from} AND ${w.to} ${cut}`;
  return { visits: row?.visits ?? 0, bought: row?.bought ?? 0 };
}

/**
 * Every figure of every period, ours against Shopify's. Shopify is asked for each period's exact
 * window (to the second while it runs), one call after another, and none after `opts.deadline`
 * (epoch ms) when there is one. For a member Team & Access doesn't show them, as on the dashboard
 * (`seesModule`), these are left out and not asked for: `profit: false`, Shopify's gross profit
 * and cost of goods sold (costs); `conversion: false`, Shopify's sessions, visitors and conversion
 * rate and the pixel's tracked visits beside them (conversion).
 */
export async function shopifyCheckReport(
  reads: CheckReads,
  store: Store,
  deps: ReportFetchDeps,
  opts: { periods?: readonly DatePreset[]; now?: Date; deadline?: number; profit?: boolean; conversion?: boolean } = {},
): Promise<{ shop: string; timezone: string; currency: string; apiVersion: string; generatedAt: string; historyFrom: string | null; periods: CheckReportPeriod[] }> {
  const now = opts.now ?? new Date();
  const periods = (opts.periods ?? CHECK_PERIODS).filter((p) => p !== "custom" && (DATE_PRESETS as readonly string[]).includes(p));
  const granted = store.grantedScopes.includes("read_reports");
  const { historyFrom, freshness } = await reads(async (tx) => {
    const [oldest] = await tx.$queryRaw<Array<{ day: string | null }>>`SELECT MIN(local_day) AS day FROM orders WHERE workspace_id = ${store.workspaceId} AND store_id = ${store.id}`;
    return { historyFrom: historyStart(store.ordersHistoryFrom, store.timezone, oldest?.day ?? null), freshness: await dataFreshness(tx, { ws: store.workspaceId, storeId: store.id }, store, now) };
  });
  const { deadline } = opts;
  const calls = deadline === undefined ? deps : { ...deps, fetchImpl: fetchUntil(deps.fetchImpl, deadline) };
  const ask = async (dataset: "sales" | "sessions" | "profit", window: ReportWindow) => {
    if (!granted) return { error: "not_granted" } as const;
    if (deadline !== undefined && Date.now() >= deadline) return { error: "out_of_time" } as const;
    return fetchShopifyReport(store, { dataset, window }, calls);
  };

  const out: CheckReportPeriod[] = [];
  for (const preset of periods) {
    const { range, until = null } = resolvePreset(preset, now, store.timezone);
    const window: ReportWindow = { from: range.from, to: range.to, ...(until ? { until } : {}) };
    const { ourRows, tracked } = await reads(async (tx) => ({
      ourRows: until ? await dailyRowsUntil(tx, store.workspaceId, store.id, { ...range, until }, store.timezone) : await dailyRows(tx, store.workspaceId, store.id, range),
      tracked: opts.conversion === false ? null : await trackedVisits(tx, store, window),
    }));
    const ours = summarize(ourRows);
    const covered = historyFrom !== null && range.from >= historyFrom;
    const [sales, sessions, profit] = [await ask("sales", window), tracked ? await ask("sessions", window) : null, opts.profit === false ? null : await ask("profit", window)];
    const rows: CheckReportRow[] = [];

    // Sales: the same records added up the same way, so they must agree.
    if ("values" in sales) {
      const behind = freshness.waiting > 0;
      for (const r of reconcileSales(ours, sales.values, { behind })) {
        const status: CheckStatus = !covered ? "not_verifiable" : r.state === "match" ? "match" : r.state === "delay" ? "sync_delay" : r.state === "unknown" ? "not_verifiable" : "difference";
        const note = !covered ? `Starts before bizinsights' imported history (${historyFrom ?? "nothing imported"}).` : r.state === "unknown" ? "Shopify's report has no figure for this." : null;
        rows.push({ metric: LABEL[r.metric]!, shopify: r.shopify, bizinsights: r.ours, difference: r.difference, percent: pct(r.difference, r.shopify), status, note });
      }
      const sGross = val(sales.values, "grossSales");
      const sDisc = val(sales.values, "discounts");
      const sOrders = val(sales.values, "orders");
      const sAov = sGross !== null && sDisc !== null && sOrders ? r2((sGross - Math.abs(sDisc)) / sOrders) : null;
      const diff = sAov !== null && ours.averageOrderValue !== null ? r2(ours.averageOrderValue - sAov) : null;
      rows.push({
        metric: LABEL.averageOrderValue!,
        shopify: sAov,
        bizinsights: ours.averageOrderValue,
        difference: diff,
        percent: pct(diff, sAov),
        status: !covered || sAov === null || diff === null ? "not_verifiable" : Math.abs(diff) < 0.005 ? "match" : freshness.waiting > 0 ? "sync_delay" : "difference",
        note: "(gross sales − discounts) ÷ orders, Shopify's formula, from its own totals.",
      });
    } else {
      for (const m of ["grossSales", "discounts", "returns", "netSales", "shipping", "taxes", "totalSales", "orders"]) {
        const ourValue = m === "returns" ? ours.refunds : (ours as unknown as Record<string, number>)[m] ?? null;
        rows.push({ metric: LABEL[m]!, shopify: null, bizinsights: ourValue, difference: null, percent: null, status: "not_verifiable", note: REFUSED[sales.error] ?? null });
      }
    }

    // Sessions: only Shopify counts them; the pixel's tracked visits are another measure.
    if (sessions && tracked) {
      const sv = "values" in sessions ? sessions.values : null;
      const sSessions = val(sv, "sessions");
      const sCompleted = val(sv, "completedSessions");
      const refusedSessions = "error" in sessions ? (REFUSED[sessions.error] ?? null) : null;
      rows.push({ metric: LABEL.sessions!, shopify: sSessions, bizinsights: tracked.visits, difference: null, percent: null, status: sv ? "definition_mismatch" : "not_verifiable", note: refusedSessions ?? "bizinsights counts tracked visits (one shopper on one day, consenting shoppers only), not sessions." });
      rows.push({ metric: LABEL.visitors!, shopify: val(sv, "visitors"), bizinsights: null, difference: null, percent: null, status: "not_verifiable", note: refusedSessions ?? "Shown from Shopify only: unique visitors over a period can't be added up from days." });
      rows.push({
        metric: LABEL.conversionRate!,
        shopify: sSessions ? r2((sCompleted ?? 0) / sSessions * 100) : null,
        bizinsights: tracked.visits ? r2((tracked.bought / tracked.visits) * 100) : null,
        difference: null,
        percent: null,
        status: sv ? "definition_mismatch" : "not_verifiable",
        note: refusedSessions ?? "Percent. Shopify: sessions that completed checkout ÷ sessions. bizinsights: tracked visits that bought ÷ tracked visits.",
      });
    }

    // Profit: Shopify's alone; bizinsights doesn't compute one of its own.
    if (profit) {
      const pv = "values" in profit ? profit.values : null;
      const refusedProfit = "error" in profit ? (REFUSED[profit.error] ?? null) : null;
      const cogs = val(pv, "costOfGoodsSold");
      const without = val(pv, "netSalesWithoutCost");
      rows.push({ metric: LABEL.grossProfit!, shopify: val(pv, "grossProfit"), bizinsights: null, difference: null, percent: null, status: "not_verifiable", note: refusedProfit ?? (without ? `Includes ${without} of net sales with no cost recorded in Shopify.` : "Shopify's figure, shown as is.") });
      rows.push({ metric: LABEL.costOfGoodsSold!, shopify: cogs === null ? null : Math.abs(cogs), bizinsights: null, difference: null, percent: null, status: "not_verifiable", note: refusedProfit });
    }

    out.push({ preset, from: range.from, to: range.to, until, rows });
  }
  return {
    shop: store.shopDomain,
    timezone: store.timezone,
    currency: store.currency,
    apiVersion: env().SHOPIFY_API_VERSION,
    generatedAt: now.toISOString(),
    historyFrom,
    periods: out,
  };
}

/** The report as CSV rows (for `toCsv`): one line per period and figure. */
export function checkReportTable(report: Awaited<ReturnType<typeof shopifyCheckReport>>) {
  const header = ["Period", "From", "To", "Up to (store time)", "Figure", "Shopify", "bizinsights", "Difference", "Difference %", "Status", "Note"];
  const rows = report.periods.flatMap((p) =>
    p.rows.map((r) => [p.preset, p.from, p.to, p.until ?? "", r.metric, r.shopify ?? "", r.bizinsights ?? "", r.difference ?? "", r.percent ?? "", r.status, r.note ?? ""]),
  );
  return { header, rows };
}

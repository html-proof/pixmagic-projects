/**
 * Shopify's own report figures on the dashboard (see ../shopifyReports.ts for where they come
 * from): Shopify's sessions and visitors, its gross profit, and a check of our sales figures
 * against its sales report for the same window.
 *
 * Nothing here calls Shopify. The overview reads the answers the worker keeps, and says which
 * windows are missing or stale (`refresh`) so the route can queue them: the 15-second polls never
 * wait on Shopify, and the page fills in on a later poll.
 */
import type { Store, Tx } from "@app/db";
import { addDays, delta, summarize, type Comparison, type DailyMetricsRow, type DateRange } from "@app/shared";
import { keptReports, REPORT_METRICS, windowKey, type KeptReport, type ReportDataset, type ReportError, type ReportRequest, type ReportValues, type ReportWindow } from "../shopifyReports.js";
import { comparisonRows } from "./sales.js";

/** Minutes a running window's end moves by: its answer serves every poll until the next mark. */
export const REPORT_STEP_MIN = 5;

/** "16:44:12" → "16:40:00": the last mark at or before that time of day. */
export function quantizeUntil(until: string): string {
  const [h = "00", m = "00"] = until.split(":");
  return `${h.padStart(2, "0")}:${String(Math.floor(Number(m) / REPORT_STEP_MIN) * REPORT_STEP_MIN).padStart(2, "0")}:00`;
}

/**
 * The windows to ask Shopify for: the range and what it is compared with. While the range is still
 * running both stop at the same time of day, as everything else on the dashboard does (like for
 * like), here at the last 5-minute mark: the range up to 4:40 pm today against yesterday up to
 * 4:40 pm.
 */
export function reportWindows(range: DateRange, previous: Comparison): { current: ReportWindow; previous: ReportWindow } {
  const until = previous.until ? quantizeUntil(previous.until) : undefined;
  return {
    current: { from: range.from, to: range.to, ...(until ? { until } : {}) },
    previous: { from: previous.from, to: previous.to, ...(until ? { until } : {}) },
  };
}

/**
 * Whether a kept answer should be asked for again. A running window's answer is replaced at each
 * mark (its key changes); days that just ended keep changing for a while (late refunds, Shopify's
 * own processing); older ones hardly ever. A failed call is tried again after 10 minutes; Shopify
 * refusing (no access, a report it can't run here) after 6 hours, a running range's too (keptAnswers).
 * A sales answer kept before a figure was asked for (duties and additional fees, 2026-10-19) is
 * asked again at once: its missing lines would read as differences.
 */
export function reportStale(r: KeptReport | undefined, w: ReportWindow, today: string, now: Date): boolean {
  if (!r) return true;
  if (r.dataset === "sales" && r.values && Object.keys(REPORT_METRICS.sales).some((k) => !(REPORT_METRICS.sales[k as keyof typeof REPORT_METRICS.sales] in r.values!))) return true;
  const age = now.getTime() - r.fetchedAt.getTime();
  if (r.error === "failed") return age > 10 * 60_000;
  if (r.error) return age > 6 * 3600_000;
  if (w.to >= today) return age > 10 * 60_000;
  if (w.to >= addDays(today, -2)) return age > 30 * 60_000;
  return age > 6 * 3600_000;
}

/**
 * The kept answers that decide whether each of a dataset's windows is asked for again (reportStale):
 * their own. A running range's keys change at each mark, so a new mark has none; when the answer
 * still shown for the range (pickAnswers' latest mark that every window has) is Shopify refusing, it
 * stands in for every window, so they are asked again together after its 6 hours instead of every
 * 5 minutes, and pickAnswers keeps showing it meanwhile. Decided for the windows together, never one
 * by one: a window held back alone would never share a newer mark with the others, and pickAnswers
 * would stop at the last one they share. Figures don't hold anything back: each mark's are asked for.
 */
export function keptAnswers(kept: KeptReport[], dataset: ReportDataset, wins: ReportWindow[]): Array<KeptReport | undefined> {
  const own = wins.map((w) => kept.find((k) => k.dataset === dataset && k.window === windowKey(w)));
  if (own.some(Boolean) || !wins[0]?.until) return own;
  const shown = pickAnswers(kept, dataset, wins);
  const range = shown.until !== wins[0].until ? shown.reports[0] : undefined;
  return range?.error === "access_denied" || range?.error === "unsupported" ? wins.map(() => range) : own;
}

/**
 * The answers to show for one dataset: the windows' own when all are kept, otherwise, while the
 * range runs, the latest earlier mark at which every window has one, so the cards keep showing
 * figures (a few minutes older) while the new mark is fetched, and the range and its comparison
 * always stop at the same time of day.
 */
export function pickAnswers(kept: KeptReport[], dataset: ReportDataset, wins: ReportWindow[]): { reports: Array<KeptReport | undefined>; until: string | null } {
  const of = (w: ReportWindow, until: string) => kept.find((k) => k.dataset === dataset && k.window === `${w.from}|${w.to}|${until}`);
  const exact = wins.map((w) => of(w, w.until ?? ""));
  const want = wins[0]?.until;
  if (exact.every(Boolean) || !want) return { reports: exact, until: want ?? null };
  // Earlier marks every window has, latest first ("HH:MM:SS" sorts as time).
  const marks = (w: ReportWindow) =>
    new Set(kept.filter((k) => k.dataset === dataset && k.window.startsWith(`${w.from}|${w.to}|`)).map((k) => k.window.split("|")[2] ?? "").filter((u) => u && u < want));
  const sets = wins.map(marks);
  const common = [...sets[0]!].filter((u) => sets.every((s) => s.has(u))).sort();
  const best = common[common.length - 1];
  return best ? { reports: wins.map((w) => of(w, best)), until: best } : { reports: exact, until: want };
}

export type ReportStatus = "ready" | "loading" | ReportError;

interface Answer {
  status: ReportStatus;
  values: ReportValues | null;
  fetchedAt: Date | null;
}

export const answerOf = (r: KeptReport | undefined): Answer => {
  if (!r) return { status: "loading", values: null, fetchedAt: null };
  // An error kept next to earlier figures (a failed refresh) still shows the figures.
  if (r.values) return { status: "ready", values: r.values, fetchedAt: r.fetchedAt };
  return { status: r.error ?? "failed", values: null, fetchedAt: r.fetchedAt };
};

const v = (x: ReportValues | null, k: string) => (x ? (x[k] ?? null) : null);
const ratio = (a: number | null, b: number | null) => (a !== null && b !== null && b > 0 ? a / b : null);
const r2 = (n: number) => Math.round(n * 100) / 100;

function sessionsFigures(x: ReportValues | null) {
  if (!x) return null;
  return {
    sessions: v(x, "sessions"),
    visitors: v(x, "visitors"),
    cartSessions: v(x, "cartSessions"),
    checkoutSessions: v(x, "checkoutSessions"),
    completedSessions: v(x, "completedSessions"),
    pageviews: v(x, "pageviews"),
    // Shopify's formula: sessions that completed checkout ÷ sessions.
    conversionRate: ratio(v(x, "completedSessions"), v(x, "sessions")),
  };
}

function profitFigures(x: ReportValues | null) {
  if (!x) return null;
  const withCost = v(x, "netSalesWithCost");
  const cogs = v(x, "costOfGoodsSold");
  // Shopify reports COGS as a cost; its sign varies by report, its size doesn't.
  const cost = cogs === null ? null : Math.abs(cogs);
  return {
    grossProfit: v(x, "grossProfit"),
    costOfGoodsSold: cost,
    netSalesWithCost: withCost,
    netSalesWithoutCost: v(x, "netSalesWithoutCost"),
    // Profit and margin on the sales whose cost Shopify recorded: the part that is known.
    profitOnCosted: withCost !== null && cost !== null ? r2(withCost - cost) : null,
    marginOnCosted: withCost !== null && cost !== null ? ratio(withCost - cost, withCost) : null,
  };
}

export interface CheckRow {
  metric: "grossSales" | "discounts" | "returns" | "netSales" | "shipping" | "duties" | "additionalFees" | "taxes" | "totalSales" | "orders";
  shopify: number | null;
  ours: number;
  difference: number | null;
  state: "match" | "differs" | "delay" | "unknown";
}

/**
 * Our figures against Shopify's sales report for the same window, line by line. Shopify reports
 * discounts and reversals with a sign of its own choosing (negative in its reports); which one is
 * read off its own identity, net = gross − discounts − reversals, so a sign never reads as a
 * difference. A difference while changes from Shopify are still waiting to be counted, or while
 * our data is older than the window's end, is a delay rather than a disagreement.
 */
export function reconcileSales(ours: ReturnType<typeof summarize>, shopify: ReportValues, opts: { behind: boolean }): CheckRow[] {
  const gross = v(shopify, "grossSales");
  const disc = v(shopify, "discounts");
  const rev = v(shopify, "salesReversals");
  const net = v(shopify, "netSales");
  const negative = gross !== null && disc !== null && rev !== null && net !== null && Math.abs(gross + disc + rev - net) < 0.01 && Math.abs(gross - disc - rev - net) >= 0.01;
  const reduction = (x: number | null) => (x === null ? null : negative ? -x : x);
  const rows: Array<[CheckRow["metric"], number | null, number]> = [
    ["grossSales", gross, ours.grossSales],
    ["discounts", reduction(disc), ours.discounts],
    ["returns", reduction(rev), ours.refunds],
    ["netSales", net, ours.netSales],
    ["shipping", v(shopify, "shipping"), ours.shipping],
    ["duties", v(shopify, "duties"), ours.duties],
    ["additionalFees", v(shopify, "additionalFees"), ours.additionalFees],
    ["taxes", v(shopify, "taxes"), ours.taxes],
    ["totalSales", v(shopify, "totalSales"), ours.totalSales],
    ["orders", v(shopify, "orders"), ours.orders],
  ];
  return rows.map(([metric, s, o]) => {
    if (s === null) return { metric, shopify: null, ours: o, difference: null, state: "unknown" };
    const difference = metric === "orders" ? o - s : r2(o - s);
    const state = Math.abs(difference) < (metric === "orders" ? 1 : 0.005) ? "match" : opts.behind ? "delay" : "differs";
    return { metric, shopify: metric === "orders" ? s : r2(s), ours: o, difference, state };
  });
}

/**
 * The Shopify-report modules for one store and dates, and the windows to fetch again. `want` says
 * which modules the store has granted and this member may see; `rangeRows` are our day rows for the
 * range (whole days), used as is when the range is finished.
 */
export async function shopifyModules(
  tx: Tx,
  store: Pick<Store, "id" | "workspaceId" | "timezone">,
  dates: { range: DateRange; previous: Comparison },
  ctx: { today: string; now: Date; rangeRows: DailyMetricsRow[]; dataAsOf: string | null; waiting: number },
  want: { sessions: boolean; profit: boolean; check: boolean },
): Promise<{ modules: Record<string, unknown>; refresh: ReportRequest[] }> {
  const modules: Record<string, unknown> = {};
  if (!want.sessions && !want.profit && !want.check) return { modules, refresh: [] };
  const w = reportWindows(dates.range, dates.previous);
  const kept = await keptReports(tx, store, [w.current, w.previous]);
  const refresh: ReportRequest[] = [];
  const need = (dataset: ReportDataset, wins: ReportWindow[]) =>
    keptAnswers(kept, dataset, wins).forEach((k, i) => {
      if (reportStale(k, wins[i]!, ctx.today, ctx.now)) refresh.push({ dataset, window: wins[i]! });
    });
  const asOf = (a: Answer) => (a.fetchedAt ? a.fetchedAt.toISOString() : null);

  if (want.sessions) {
    need("sessions", [w.current, w.previous]);
    const picked = pickAnswers(kept, "sessions", [w.current, w.previous]);
    const until = picked.until;
    const now = answerOf(picked.reports[0]);
    const before = answerOf(picked.reports[1]);
    const cur = sessionsFigures(now.values);
    const prev = sessionsFigures(before.values);
    modules.shopify_sessions = {
      status: now.status,
      asOf: asOf(now),
      until,
      current: cur,
      previous: prev,
      deltas: {
        sessions: delta(cur?.sessions ?? null, prev?.sessions ?? null),
        visitors: delta(cur?.visitors ?? null, prev?.visitors ?? null),
        conversionRate: delta(cur?.conversionRate ?? null, prev?.conversionRate ?? null),
      },
    };
  }

  if (want.profit) {
    need("profit", [w.current, w.previous]);
    const picked = pickAnswers(kept, "profit", [w.current, w.previous]);
    const until = picked.until;
    const now = answerOf(picked.reports[0]);
    const before = answerOf(picked.reports[1]);
    const cur = profitFigures(now.values);
    const prev = profitFigures(before.values);
    modules.profit = {
      status: now.status,
      asOf: asOf(now),
      until,
      current: cur,
      previous: prev ? { grossProfit: prev.grossProfit } : null,
      deltas: { grossProfit: delta(cur?.grossProfit ?? null, prev?.grossProfit ?? null) },
    };
  }

  if (want.check) {
    need("sales", [w.current]);
    const picked = pickAnswers(kept, "sales", [w.current]);
    const until = picked.until;
    const now = answerOf(picked.reports[0]);
    let rows: CheckRow[] | null = null;
    if (now.values) {
      // Ours for exactly the same window: up to the same mark while it runs.
      const ourRows = until ? await comparisonRows(tx, store.workspaceId, store.id, { from: w.current.from, to: w.current.to, until }, store.timezone) : ctx.rangeRows;
      const behind = ctx.waiting > 0 || (!!ctx.dataAsOf && !!now.fetchedAt && Date.parse(ctx.dataAsOf) < now.fetchedAt.getTime() - 15 * 60_000);
      rows = reconcileSales(summarize(ourRows), now.values, { behind });
    }
    modules.shopify_check = {
      status: now.status,
      asOf: asOf(now),
      until,
      window: { from: w.current.from, to: w.current.to },
      rows,
      matches: rows ? rows.every((r) => r.state === "match") : null,
    };
  }
  return { modules, refresh };
}

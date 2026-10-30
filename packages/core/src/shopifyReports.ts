/**
 * Shopify's own report figures, read with ShopifyQL (Admin GraphQL `shopifyqlQuery`, scope
 * `read_reports`; Shopify also requires Level 2 protected customer data access for it).
 *
 * Three things only Shopify's reports can answer exactly, so the dashboard asks them rather than
 * estimating:
 *
 * - **sessions**: online store sessions, unique visitors, the funnel steps, pageviews and the
 *   conversion rate, as Shopify Analytics counts them (human sessions: bot sessions are left out
 *   by Shopify's own classification). The web pixel's "tracked visits" are a different measure
 *   and are never shown as these.
 * - **profit**: gross profit and cost of goods sold, from the cost Shopify recorded with each
 *   sale, and how much of net sales had no cost recorded.
 * - **sales**: Shopify's sales report totals for the same window, to check ours against
 *   (`reconcileSales`): our figures are added up from Shopify's sales records, so they should agree
 *   to the cent.
 *
 * Kept the same way, though not ShopifyQL: **abandoned_checkouts**, Shopify's own abandoned
 * checkouts (how many, their value, how many were recovered), read from the Admin API's checkout
 * list with `read_orders` (shopifyCheckouts.ts). `REPORT_SCOPE` says which scope each dataset needs.
 *
 * Each answer is for one store-local window (`ReportWindow`) and kept in `shopify_reports`, so the
 * dashboard's 15-second polls never wait on Shopify: the worker fetches (`fetchShopifyReports`),
 * the overview reads what is kept (reports/shopify.ts). Unique visitors don't add up across days,
 * so a window is always asked for whole, never summed from days.
 */
import { Prisma, systemDb, type Store, type Tx } from "@app/db";
import type { Coord } from "./coord.js";
import { env } from "./env.js";
import { logger } from "./logger.js";
import type { Producer, Queues } from "./queues.js";
import { ShopifyGraphqlError, ShopifyHttpError, shopifyGraphqlWithCost, type FetchLike } from "./shopify.js";
import { checkoutSearch, readAbandonedCheckouts, type CheckoutValues } from "./shopifyCheckouts.js";
import { getAccessToken } from "./tokens.js";

/** The datasets read with ShopifyQL (`read_reports`). */
export type ShopifyqlDataset = "sales" | "profit" | "sessions";
export type ReportDataset = ShopifyqlDataset | "abandoned_checkouts";
export const REPORT_DATASETS: readonly ReportDataset[] = ["sales", "profit", "sessions", "abandoned_checkouts"];

/** The scope Shopify needs for each dataset: the worker asks for nothing a store hasn't granted. */
export const REPORT_SCOPE: Record<ReportDataset, string> = {
  sales: "read_reports",
  profit: "read_reports",
  sessions: "read_reports",
  abandoned_checkouts: "read_orders",
};

/**
 * Store-local days `from`..`to`, both whole, or `to` only up to `until` ("HH:MM:SS", store-local
 * wall clock) when the window is still running.
 */
export interface ReportWindow {
  from: string;
  to: string;
  until?: string;
}

/** Why Shopify gave no figures: no access (scope or protected data), a report it can't run here (plan, field), or a failed call. */
export type ReportError = "access_denied" | "unsupported" | "failed";

/** The metrics asked for, by dataset: ShopifyQL's names (2026-10 schemas), in our names. */
export const REPORT_METRICS = {
  sales: {
    gross_sales: "grossSales",
    discounts: "discounts",
    sales_reversals: "salesReversals",
    net_sales: "netSales",
    shipping_charges: "shipping",
    duties: "duties",
    additional_fees: "additionalFees",
    taxes: "taxes",
    total_sales: "totalSales",
    orders: "orders",
  },
  profit: {
    gross_profit: "grossProfit",
    cost_of_goods_sold: "costOfGoodsSold",
    net_sales_with_cost_recorded: "netSalesWithCost",
    net_sales_without_cost_recorded: "netSalesWithoutCost",
  },
  sessions: {
    sessions: "sessions",
    online_store_visitors: "visitors",
    sessions_with_cart_additions: "cartSessions",
    sessions_that_reached_checkout: "checkoutSessions",
    sessions_that_completed_checkout: "completedSessions",
    pageviews: "pageviews",
  },
} as const satisfies Record<ShopifyqlDataset, Record<string, string>>;

/** A ShopifyQL dataset's figures, in our names. */
export type ReportValues = Record<string, number | null>;

/** What Shopify answered for one dataset and window: its figures (ShopifyQL's, or the abandoned checkouts'), or why there are none. */
export type ReportAnswer = { values: ReportValues | CheckoutValues } | { error: ReportError };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}:\d{2}$/;

/** The key a window is kept under: "from|to|until". */
export const windowKey = (w: ReportWindow) => `${w.from}|${w.to}|${w.until ?? ""}`;

/** "16:40:00" → "16:39:59": ShopifyQL's UNTIL includes its second, ours stops before it. */
function secondBefore(time: string): string {
  const [h, m, s] = time.split(":").map(Number) as [number, number, number];
  const t = Math.max(0, h * 3600 + m * 60 + s - 1);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(Math.floor(t / 3600))}:${two(Math.floor(t / 60) % 60)}:${two(t % 60)}`;
}

/**
 * The ShopifyQL for one dataset and window. The dates are checked against their formats before
 * they go into the text (ShopifyQL takes no variables), so nothing else can. A window cut at a
 * time of day ends a second before it: ShopifyQL's UNTIL is inclusive, while the dashboard counts
 * what happened before that moment (dayTotals' `until`).
 */
export function reportQuery(dataset: ShopifyqlDataset, w: ReportWindow): string {
  if (!DAY.test(w.from) || !DAY.test(w.to) || (w.until !== undefined && !TIME.test(w.until))) throw new Error(`Bad report window ${windowKey(w)}`);
  const show = Object.keys(REPORT_METRICS[dataset]).join(", ");
  const since = `SINCE ${w.from} UNTIL ${w.until ? `${w.to}T${secondBefore(w.until)}` : w.to}`;
  if (dataset === "sessions") return `FROM sessions SHOW ${show} WHERE human_or_bot_session = 'human' ${since}`;
  return `FROM sales SHOW ${show} ${since}`;
}

export const SHOPIFYQL_QUERY = /* GraphQL */ `
  query ShopifyQL($query: String!) {
    shopifyqlQuery(query: $query) {
      tableData { columns { name dataType } rows }
      parseErrors
    }
  }`;

interface ShopifyqlAnswer {
  shopifyqlQuery: {
    tableData?: { columns?: Array<{ name?: string | null }> | null; rows?: unknown } | null;
    parseErrors?: unknown;
  } | null;
}

const toNumber = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * One row of totals (no GROUP BY or TIMESERIES) in our names. Rows come as objects keyed by column
 * name; a row given as an array is read by the columns' order. A query that matched nothing has no
 * row: every figure is then 0, which is Shopify's answer, not a gap.
 */
export function parseReport(dataset: ShopifyqlDataset, answer: ShopifyqlAnswer["shopifyqlQuery"]): ReportValues {
  const names = REPORT_METRICS[dataset] as Record<string, string>;
  const columns = (answer?.tableData?.columns ?? []).map((c) => c?.name ?? "");
  const rows = Array.isArray(answer?.tableData?.rows) ? (answer!.tableData!.rows as unknown[]) : [];
  const row = rows[0];
  const cell = (name: string): unknown => {
    if (Array.isArray(row)) return row[columns.indexOf(name)];
    if (row && typeof row === "object") return (row as Record<string, unknown>)[name];
    return undefined;
  };
  const out: ReportValues = {};
  for (const [shopify, ours] of Object.entries(names)) out[ours] = row === undefined ? 0 : toNumber(cell(shopify));
  return out;
}

/** GraphQL error codes worth asking again for. */
const TRANSIENT_CODES = new Set(["INTERNAL_SERVER_ERROR", "THROTTLED", "SERVICE_UNAVAILABLE", "TIMEOUT"]);

export interface ReportFetchDeps {
  coord: Coord;
  fetchImpl: FetchLike;
}

export interface ReportRequest {
  dataset: ReportDataset;
  window: ReportWindow;
}

type ReportStore = Pick<Store, "id" | "shopDomain" | "status" | "timezone">;

/** Ask Shopify for one dataset and window. Never throws for Shopify's answers: they are kept as errors. */
export async function fetchShopifyReport(store: ReportStore, req: { dataset: ShopifyqlDataset; window: ReportWindow }, deps: ReportFetchDeps): Promise<{ values: ReportValues } | { error: ReportError }>;
export async function fetchShopifyReport(store: ReportStore, req: ReportRequest, deps: ReportFetchDeps): Promise<ReportAnswer>;
export async function fetchShopifyReport(store: ReportStore, { dataset, window }: ReportRequest, deps: ReportFetchDeps): Promise<ReportAnswer> {
  // Checked before anything is asked: the dates go into Shopify's query text.
  const query = dataset === "abandoned_checkouts" ? checkoutSearch(window, store.timezone) : reportQuery(dataset, window);
  try {
    const accessToken = await getAccessToken(store, deps.coord, deps.fetchImpl);
    const call = { shop: store.shopDomain, accessToken, apiVersion: env().SHOPIFY_API_VERSION, fetchImpl: deps.fetchImpl };
    if (dataset === "abandoned_checkouts") return await readAbandonedCheckouts(call, window, store.timezone);
    const { data } = await shopifyGraphqlWithCost<ShopifyqlAnswer>({ ...call, query: SHOPIFYQL_QUERY, variables: { query } });
    // Withheld (ACCESS_DENIED next to the data: the field needs a scope or protected data access).
    if (!data?.shopifyqlQuery) return { error: "access_denied" };
    const parseErrors = data.shopifyqlQuery.parseErrors;
    if (Array.isArray(parseErrors) ? parseErrors.length > 0 : !!parseErrors) {
      // A metric this store's plan doesn't report, or a schema change: Shopify says which.
      logger.warn({ shop: store.shopDomain, dataset, parseErrors: JSON.stringify(parseErrors).slice(0, 500) }, "shopifyql parse errors");
      return { error: "unsupported" };
    }
    return { values: parseReport(dataset, data.shopifyqlQuery) };
  } catch (err) {
    if ((err instanceof ShopifyHttpError && (err.status === 401 || err.status === 403)) || (err instanceof ShopifyGraphqlError && err.codes.includes("ACCESS_DENIED"))) {
      return { error: "access_denied" };
    }
    // Shopify refusing the query itself (a field this API version lacks, say) won't change by asking
    // again in 10 minutes; its own failures and throttling might.
    if (err instanceof ShopifyGraphqlError && err.codes.some((c) => c && !TRANSIENT_CODES.has(c))) {
      logger.warn({ shop: store.shopDomain, dataset, codes: err.codes }, "shopify report query refused");
      return { error: "unsupported" };
    }
    logger.warn({ err, shop: store.shopDomain, dataset }, "shopify report query failed");
    return { error: "failed" };
  }
}

/** Keep one answer (values or the error), replacing the window's earlier one. */
export async function saveShopifyReport(store: Pick<Store, "id" | "workspaceId">, req: ReportRequest, answer: ReportAnswer, at = new Date()) {
  const window = windowKey(req.window);
  const values = "values" in answer ? (answer.values as Prisma.InputJsonValue) : Prisma.DbNull;
  const error = "error" in answer ? answer.error : null;
  await systemDb.shopifyReport.upsert({
    where: { storeId_dataset_window: { storeId: store.id, dataset: req.dataset, window } },
    create: { workspaceId: store.workspaceId, storeId: store.id, dataset: req.dataset, window, values, error, fetchedAt: at },
    // A failed refresh keeps the figures it had: they are still Shopify's, only older.
    update: error && error === "failed" ? { error, fetchedAt: at } : { values, error, fetchedAt: at },
  });
}

/** Fetch and keep each requested report, one after another (Shopify paces the store's calls). */
export async function fetchShopifyReports(store: ReportStore & Pick<Store, "workspaceId">, requests: ReportRequest[], deps: ReportFetchDeps) {
  for (const req of requests) await saveShopifyReport(store, req, await fetchShopifyReport(store, req, deps));
}

export interface KeptReport {
  dataset: ReportDataset;
  window: string;
  /** As kept: a ShopifyQL dataset's figures; the abandoned checkouts' are read back with checkoutValuesOf. */
  values: ReportValues | null;
  error: ReportError | null;
  fetchedAt: Date;
}

/**
 * What is kept for these windows (any dataset). For a running window, the answers kept at every
 * earlier mark of the same days too, which stand in while the latest mark is fetched.
 */
export async function keptReports(tx: Tx, store: Pick<Store, "id" | "workspaceId">, windows: ReportWindow[]): Promise<KeptReport[]> {
  if (!windows.length) return [];
  const rows = await tx.shopifyReport.findMany({
    where: {
      workspaceId: store.workspaceId,
      storeId: store.id,
      OR: windows.map((w) => (w.until ? { window: { startsWith: `${w.from}|${w.to}|` } } : { window: windowKey(w) })),
    },
  });
  return rows.map((r) => ({
    dataset: r.dataset as ReportDataset,
    window: r.window,
    values: (r.values as ReportValues | null) ?? null,
    error: (r.error as ReportError | null) ?? null,
    fetchedAt: r.fetchedAt,
  }));
}

/** The worker job that fetches Shopify reports for one store; it rides the sync queue, told apart by its kind. */
export interface ShopifyReportsJob {
  kind: "shopify_reports";
  storeId: string;
  requests: ReportRequest[];
}

export const shopifyReportsQueue = (queues: Queues) => queues.sync as unknown as Producer<ShopifyReportsJob>;

/**
 * Queue a fetch of these reports, once per store and set of windows a minute: the dashboard asks
 * on every poll, and every open tab polls.
 */
export async function requestShopifyReports(deps: { queues: Queues; coord: Coord }, store: Pick<Store, "id">, requests: ReportRequest[]) {
  if (!requests.length) return false;
  const key = `shopifyql:${store.id}:${requests.map((r) => `${r.dataset}@${windowKey(r.window)}`).sort().join(",")}`;
  if ((await deps.coord.hit(key, 60)) > 1) return false;
  await shopifyReportsQueue(deps.queues).send({ kind: "shopify_reports", storeId: store.id, requests });
  return true;
}

/** Kept answers older than this are deleted (a running window's answer is replaced every 5 minutes, under a new key). */
export const SHOPIFY_REPORTS_KEEP_DAYS = 14;

export async function pruneShopifyReports(now = new Date()): Promise<number> {
  const old = await systemDb.shopifyReport.deleteMany({ where: { fetchedAt: { lt: new Date(now.getTime() - SHOPIFY_REPORTS_KEEP_DAYS * 86_400_000) } } });
  // A running window's answers serve only until the next mark (and the marks after it, briefly):
  // a day on, none is asked for again.
  const marks = await systemDb.shopifyReport.deleteMany({ where: { fetchedAt: { lt: new Date(now.getTime() - 86_400_000) }, NOT: { window: { endsWith: "|" } } } });
  return old.count + marks.count;
}

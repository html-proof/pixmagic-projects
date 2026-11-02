/**
 * Ad spend, impressions and clicks as the store's marketing apps report them to Shopify, read from
 * Shopify's `marketing_engagements` report (ShopifyQL, Admin GraphQL `shopifyqlQuery`, scope
 * `read_reports`) and kept day by day in shopify_marketing_days. The Facebook & Instagram app, the
 * Google & YouTube app and other channel apps send Shopify their own figures for the campaigns they
 * run for the store (Shopify's marketingEngagementCreate): this is how bizinsights has Meta's and
 * Google's spend for a store that connected nothing but Shopify. What each channel didn't report is
 * kept empty, never 0 (@app/shared/shopifyMarketing has what the dashboard makes of it).
 *
 * The worker reads it on a schedule (apps/worker/src/shopifyMarketing.ts): the last 3 days every 6
 * hours (Shopify takes up to a day to receive a channel's figures), the last 7 days once a day
 * (channels revise their spend for a few days), and the store's history back to its first day, 90
 * days at a time, once. Each read replaces the stored rows of its days: a row is the channel's figure
 * for a day (by store, day, channel, app and campaign), so reading a day twice never counts it twice.
 */
import { systemDb, type Store, type Tx } from "@app/db";
import { addDays, localDay, shopifyMarketing, storeStartDay, type Comparison, type DateRange, type MarketingRow, type MarketingSyncState } from "@app/shared";
import type { Coord } from "./coord.js";
import { env } from "./env.js";
import { logger } from "./logger.js";
import type { Producer, Queues } from "./queues.js";
import { shopifyGraphqlWithCost, type FetchLike } from "./shopify.js";
import { reportErrorOf, SHOPIFYQL_QUERY, type ReportError } from "./shopifyReports.js";
import { getAccessToken } from "./tokens.js";

/** The metrics read, ShopifyQL's names (2026-10 schema) to ours. */
export const MARKETING_METRICS = {
  engagements_ad_spend: "spend",
  engagements_impressions: "impressions",
  engagements_clicks: "clicks",
  engagements_orders: "orders",
  engagements_total_sales: "sales",
  engagements_first_time_customers: "newCustomers",
} as const;

/** A channel's whole day, or its day by campaign. */
export type MarketingLevel = "channel" | "campaign";

const GROUPS: Record<MarketingLevel, readonly string[]> = {
  channel: ["day", "marketing_channel", "marketing_app_name"],
  campaign: ["day", "marketing_channel", "marketing_app_name", "marketing_campaign"],
};

/** Rows asked for per call; more are paged through with OFFSET, up to `MARKETING_MAX_PAGES`. */
export const MARKETING_PAGE = 1000;
const MARKETING_MAX_PAGES = 20;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The ShopifyQL for one level and window (store-local days, both whole). The dates are checked against
 * their format before they go into the text (ShopifyQL takes no variables), so nothing else can. Sorted
 * by every group, so paging with OFFSET neither skips nor repeats a row.
 */
export function marketingQuery(level: MarketingLevel, w: DateRange, offset = 0): string {
  if (!DAY.test(w.from) || !DAY.test(w.to) || w.from > w.to) throw new Error(`Bad marketing window ${w.from}..${w.to}`);
  if (!Number.isInteger(offset) || offset < 0) throw new Error(`Bad offset ${offset}`);
  const by = GROUPS[level];
  return [
    `FROM marketing_engagements SHOW ${Object.keys(MARKETING_METRICS).join(", ")}`,
    `GROUP BY ${by.join(", ")}`,
    `SINCE ${w.from} UNTIL ${w.to}`,
    `ORDER BY ${by.map((c) => `${c} ASC`).join(", ")}`,
    `LIMIT ${MARKETING_PAGE}${offset ? ` OFFSET ${offset}` : ""}`,
  ].join(" ");
}

interface ShopifyqlTable {
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
const toText = (v: unknown): string => (v === null || v === undefined ? "" : String(v).trim());

/** The table's rows as objects keyed by column name (Shopify sends objects; arrays are read by the columns' order). */
function tableRows(answer: ShopifyqlTable["shopifyqlQuery"]): Array<Record<string, unknown>> {
  const columns = (answer?.tableData?.columns ?? []).map((c) => c?.name ?? "");
  const rows = Array.isArray(answer?.tableData?.rows) ? (answer!.tableData!.rows as unknown[]) : [];
  return rows.map((row) => {
    if (Array.isArray(row)) return Object.fromEntries(columns.map((c, i) => [c, row[i]]));
    return row && typeof row === "object" ? (row as Record<string, unknown>) : {};
  });
}

/**
 * Shopify's rows in ours. A day comes as "2026-10-01" (or with a time after it); a row without one, or
 * a campaign row without a campaign (its figures are in the channel's whole day), is left out. A row
 * with no channel is named by its app, or "Other". Two rows Shopify gives the same key are added together.
 */
export function parseMarketingRows(level: MarketingLevel, answer: ShopifyqlTable["shopifyqlQuery"]): MarketingRow[] {
  const out = new Map<string, MarketingRow>();
  for (const r of tableRows(answer)) {
    const day = toText(r.day).slice(0, 10);
    if (!DAY.test(day)) continue;
    const app = toText(r.marketing_app_name) || null;
    const channel = toText(r.marketing_channel) || app || "Other";
    const campaign = level === "campaign" ? toText(r.marketing_campaign) : null;
    if (level === "campaign" && !campaign) continue;
    const row: MarketingRow = { day, channel, app, campaign, spend: null, impressions: null, clicks: null, orders: null, sales: null, newCustomers: null };
    for (const [shopify, ours] of Object.entries(MARKETING_METRICS)) row[ours] = toNumber(r[shopify]);
    const key = [day, channel, app ?? "", campaign ?? ""].join("\u0000");
    const had = out.get(key);
    if (!had) out.set(key, row);
    else {
      for (const m of Object.values(MARKETING_METRICS)) {
        const [a, b] = [had[m], row[m]];
        had[m] = a === null ? b : b === null ? a : a + b;
      }
    }
  }
  return [...out.values()];
}

export interface MarketingFetchDeps {
  coord: Coord;
  fetchImpl: FetchLike;
}

type MarketingStore = Pick<Store, "id" | "shopDomain" | "status">;

/** Read one window, both levels, every page. Never throws for Shopify's answers: they come back as an error. */
export async function fetchShopifyMarketing(store: MarketingStore, w: DateRange, deps: MarketingFetchDeps): Promise<{ rows: MarketingRow[] } | { error: ReportError }> {
  try {
    const accessToken = await getAccessToken(store, deps.coord, deps.fetchImpl);
    const call = { shop: store.shopDomain, accessToken, apiVersion: env().SHOPIFY_API_VERSION, fetchImpl: deps.fetchImpl };
    const rows: MarketingRow[] = [];
    for (const level of ["channel", "campaign"] as const) {
      for (let page = 0; page < MARKETING_MAX_PAGES; page++) {
        const { data } = await shopifyGraphqlWithCost<ShopifyqlTable>({ ...call, query: SHOPIFYQL_QUERY, variables: { query: marketingQuery(level, w, page * MARKETING_PAGE) } });
        // Withheld (ACCESS_DENIED next to the data: the report needs a scope or protected data access).
        if (!data?.shopifyqlQuery) return { error: "access_denied" };
        const parseErrors = data.shopifyqlQuery.parseErrors;
        if (Array.isArray(parseErrors) ? parseErrors.length > 0 : !!parseErrors) {
          // A store whose plan or API version lacks the report or a column: Shopify says which.
          logger.warn({ shop: store.shopDomain, level, parseErrors: JSON.stringify(parseErrors).slice(0, 500) }, "shopify marketing parse errors");
          return { error: "unsupported" };
        }
        const got = tableRows(data.shopifyqlQuery).length;
        rows.push(...parseMarketingRows(level, data.shopifyqlQuery));
        if (got < MARKETING_PAGE) break;
        if (page === MARKETING_MAX_PAGES - 1) logger.warn({ shop: store.shopDomain, level, from: w.from, to: w.to }, "shopify marketing window cut at the page limit");
      }
    }
    return { rows };
  } catch (err) {
    return { error: reportErrorOf(err, store.shopDomain, "marketing_engagements") };
  }
}

/** A row as kept: '' for no app, no campaign (the key's parts can't be null). */
const stored = (r: MarketingRow) => ({ app: r.app ?? "", campaign: r.campaign ?? "" });

/**
 * Keep a window's rows, replacing whatever was kept for its days (a day Shopify revised keeps no old
 * figure, a campaign renamed no old row). One transaction: a reader never sees the days half replaced.
 */
export async function saveShopifyMarketing(store: Pick<Store, "id" | "workspaceId" | "currency">, w: DateRange, rows: MarketingRow[], at = new Date()) {
  const inWindow = rows.filter((r) => r.day >= w.from && r.day <= w.to);
  await systemDb.$transaction([
    systemDb.shopifyMarketingDay.deleteMany({ where: { workspaceId: store.workspaceId, storeId: store.id, day: { gte: w.from, lte: w.to } } }),
    systemDb.shopifyMarketingDay.createMany({
      data: inWindow.map((r) => ({
        workspaceId: store.workspaceId,
        storeId: store.id,
        day: r.day,
        channel: r.channel,
        ...stored(r),
        spend: r.spend,
        // Counts kept whole: Shopify's are integers already.
        impressions: r.impressions === null ? null : Math.round(r.impressions),
        clicks: r.clicks === null ? null : Math.round(r.clicks),
        orders: r.orders,
        sales: r.sales,
        newCustomers: r.newCustomers,
        currency: store.currency,
        fetchedAt: at,
      })),
      skipDuplicates: true,
    }),
  ]);
  return inWindow.length;
}

/** "recent": the last days, every 6 hours; "reconcile": the last 7 days, daily; "backfill": the next 90 days back. */
export type MarketingSyncMode = "recent" | "reconcile" | "backfill";

/** Days a recent read covers (today and the two before): Shopify can take a day to receive a channel's figures. */
export const MARKETING_RECENT_DAYS = 3;
/** Days before today the daily reconciliation reads again: channels revise their spend for days. */
export const MARKETING_RECONCILE_DAYS = 7;
/** Days per read of the history, and of a store's first read. */
export const MARKETING_CHUNK_DAYS = 90;
/** The history read back to when the store's first day isn't known. */
const MARKETING_FALLBACK_YEARS = 3;

type SyncStore = Pick<Store, "id" | "workspaceId" | "shopDomain" | "status" | "timezone" | "currency" | "shopCreatedAt">;
type SyncRow = { coveredFrom: string | null; syncedThrough: string | null; backfilled: boolean };

/** The first day worth reading: the store's own (Shopify's creation date), or a few years back. */
export function marketingFirstDay(store: Pick<Store, "shopCreatedAt" | "timezone">, today: string): string {
  return storeStartDay(store.shopCreatedAt, store.timezone, null) ?? addDays(today, -365 * MARKETING_FALLBACK_YEARS);
}

/**
 * The days one read covers, or null when there is nothing left (a backfill that reached the first day).
 * A store read for the first time gets its last 90 days, whatever the mode. A recent read after a gap
 * (reads that failed for a while) starts the day before the last day read, up to 90 days back.
 */
export function marketingWindow(mode: MarketingSyncMode, state: SyncRow | null, today: string, firstDay: string): DateRange | null {
  const clamp = (from: string) => (from < firstDay ? firstDay : from);
  if (!state?.coveredFrom) return { from: clamp(addDays(today, -(MARKETING_CHUNK_DAYS - 1))), to: today };
  if (mode === "reconcile") return { from: clamp(addDays(today, -MARKETING_RECONCILE_DAYS)), to: today };
  if (mode === "recent") {
    let from = addDays(today, -(MARKETING_RECENT_DAYS - 1));
    if (state.syncedThrough && state.syncedThrough < from) from = addDays(state.syncedThrough, -1);
    const oldest = addDays(today, -(MARKETING_CHUNK_DAYS - 1));
    return { from: clamp(from < oldest ? oldest : from), to: today };
  }
  if (state.backfilled || state.coveredFrom <= firstDay) return null;
  const to = addDays(state.coveredFrom, -1);
  const from = addDays(to, -(MARKETING_CHUNK_DAYS - 1));
  return { from: clamp(from), to };
}

export type MarketingSyncResult =
  | { status: "done"; from: string; to: string; rows: number; more: boolean }
  | { status: "nothing_left" }
  | { status: "error"; error: ReportError };

/**
 * One read for the store (`mode`), its rows kept and its state moved on. A read Shopify refused or that
 * failed keeps the rows read before and says why (`lastError`); the caller decides whether to try again.
 * `more`: history is left to read (the caller queues the next backfill).
 */
export async function syncShopifyMarketing(store: SyncStore, mode: MarketingSyncMode, deps: MarketingFetchDeps, now = new Date()): Promise<MarketingSyncResult> {
  const today = localDay(now, store.timezone);
  const firstDay = marketingFirstDay(store, today);
  const state = await systemDb.shopifyMarketingSync.findUnique({ where: { storeId: store.id } });
  const w = marketingWindow(mode, state, today, firstDay);
  const key = { storeId: store.id };
  if (!w) {
    if (state && !state.backfilled) await systemDb.shopifyMarketingSync.update({ where: key, data: { backfilled: true } });
    return { status: "nothing_left" };
  }
  const answer = await fetchShopifyMarketing(store, w, deps);
  if ("error" in answer) {
    await systemDb.shopifyMarketingSync.upsert({
      where: key,
      create: { storeId: store.id, workspaceId: store.workspaceId, lastAttemptAt: now, lastError: answer.error, consecutiveFailures: 1 },
      update: { lastAttemptAt: now, lastError: answer.error, consecutiveFailures: { increment: 1 } },
    });
    return { status: "error", error: answer.error };
  }
  const rows = await saveShopifyMarketing(store, w, answer.rows, now);
  // The days read only ever widen, in the database itself: a recent read and a walk back through
  // history finishing together each keep the other's days.
  const [after] = await systemDb.$queryRaw<Array<{ backfilled: boolean }>>`
    INSERT INTO shopify_marketing_syncs (store_id, workspace_id, covered_from, synced_through, backfilled, last_synced_at, last_attempt_at, last_error, consecutive_failures, updated_at)
    VALUES (${store.id}, ${store.workspaceId}, ${w.from}, ${w.to}, ${w.from <= firstDay}, ${now}, ${now}, NULL, 0, ${now})
    ON CONFLICT (store_id) DO UPDATE SET
      covered_from = LEAST(COALESCE(shopify_marketing_syncs.covered_from, EXCLUDED.covered_from), EXCLUDED.covered_from),
      synced_through = GREATEST(COALESCE(shopify_marketing_syncs.synced_through, EXCLUDED.synced_through), EXCLUDED.synced_through),
      backfilled = shopify_marketing_syncs.backfilled OR LEAST(COALESCE(shopify_marketing_syncs.covered_from, EXCLUDED.covered_from), EXCLUDED.covered_from) <= ${firstDay},
      last_synced_at = EXCLUDED.last_synced_at, last_attempt_at = EXCLUDED.last_attempt_at,
      last_error = NULL, consecutive_failures = 0, updated_at = EXCLUDED.updated_at
    RETURNING backfilled`;
  logger.info({ storeId: store.id, mode, from: w.from, to: w.to, rows }, "shopify marketing read");
  return { status: "done", from: w.from, to: w.to, rows, more: !after?.backfilled };
}

/** The worker job that reads a store's marketing report; it rides the sync queue, told apart by its kind. */
export interface ShopifyMarketingJob {
  kind: "shopify_marketing";
  storeId: string;
  mode: MarketingSyncMode;
}

export const shopifyMarketingQueue = (queues: Queues) => queues.sync as unknown as Producer<ShopifyMarketingJob>;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/**
 * How long a queued read of each mode holds its store, which is also how often it runs: the recent
 * days every 6 hours, the last week daily, and a walk back through history at most every 6 hours
 * (a walk queues its own next window; the lease starts one again if it broke off).
 */
export const MARKETING_LEASE_MS: Record<MarketingSyncMode, number> = { recent: 6 * HOUR - 5 * MINUTE, reconcile: 22 * HOUR, backfill: 6 * HOUR };
export const marketingLease = (mode: MarketingSyncMode, storeId: string) => `shopify-marketing:${mode}:${storeId}`;

/**
 * Queue a read of the store's marketing report unless one of the same mode holds it (its lease, from
 * the schedule or the dashboard alike); false when one does. A send that fails gives the lease back,
 * so the next tick or poll tries again.
 */
export async function requestShopifyMarketing(deps: { queues: Queues; coord: Coord }, store: Pick<Store, "id">, mode: MarketingSyncMode, opts: { delaySeconds?: number } = {}): Promise<boolean> {
  const lease = marketingLease(mode, store.id);
  if (!(await deps.coord.acquire(lease, MARKETING_LEASE_MS[mode]))) return false;
  try {
    await shopifyMarketingQueue(deps.queues).send({ kind: "shopify_marketing", storeId: store.id, mode }, opts.delaySeconds ? { delaySeconds: opts.delaySeconds } : undefined);
  } catch (err) {
    await deps.coord.release(lease).catch(() => undefined);
    throw err;
  }
  return true;
}

let ready = false;

/**
 * Whether the tables exist: false between a release's deploy and its migration, when the code that
 * reads them is live and they aren't there yet (the overview and the worker then read nothing).
 */
export async function marketingReady(tx: Pick<Tx, "$queryRaw">): Promise<boolean> {
  if (ready) return true;
  const [row] = await tx.$queryRaw<Array<{ ok: boolean }>>`SELECT to_regclass('shopify_marketing_syncs') IS NOT NULL AS ok`;
  ready = row?.ok === true;
  return ready;
}

const num = (v: { toString(): string } | number | null): number | null => (v === null ? null : Number(v));

/**
 * The dashboard's Shopify marketing module for the dates, from what the worker kept: null while the
 * tables don't exist yet. The dates are compared only once they are over, with the dates compared
 * with read back that far: the figures are whole days, so a running day can't be set against the
 * same time of day before.
 */
export async function shopifyMarketingModule(tx: Tx, scope: { ws: string; storeId: string }, store: Pick<Store, "currency">, dates: { range: DateRange; previous: Comparison }, today: string) {
  if (!(await marketingReady(tx))) return null;
  const { ws, storeId } = scope;
  const { range, previous } = dates;
  const sync = await tx.shopifyMarketingSync.findFirst({ where: { workspaceId: ws, storeId } });
  const covered = (r: DateRange) => !!sync?.coveredFrom && (sync.backfilled || r.from >= sync.coveredFrom);
  const compare = range.to < today && covered(previous);
  const read = (r: DateRange) => tx.shopifyMarketingDay.findMany({ where: { workspaceId: ws, storeId, day: { gte: r.from, lte: r.to } } });
  const [rows, previousRows, last] = await Promise.all([
    read(range),
    compare ? read(previous) : null,
    tx.shopifyMarketingDay.groupBy({ by: ["channel", "app"], where: { workspaceId: ws, storeId, campaign: "" }, _max: { day: true } }),
  ]);
  const ours = (r: Awaited<ReturnType<typeof read>>[number]): MarketingRow => ({
    day: r.day,
    channel: r.channel,
    app: r.app || null,
    campaign: r.campaign || null,
    spend: num(r.spend),
    impressions: r.impressions,
    clicks: r.clicks,
    orders: r.orders,
    sales: num(r.sales),
    newCustomers: r.newCustomers,
  });
  const state: MarketingSyncState = {
    lastSyncedAt: sync?.lastSyncedAt?.toISOString() ?? null,
    coveredFrom: sync?.coveredFrom ?? null,
    backfilled: sync?.backfilled ?? false,
    error: (sync?.lastError as MarketingSyncState["error"]) ?? null,
    lastAttemptAt: sync?.lastAttemptAt?.toISOString() ?? null,
  };
  return shopifyMarketing({
    rows: rows.map(ours),
    previousRows: previousRows?.map(ours) ?? null,
    lastDays: last.filter((l) => l._max.day).map((l) => ({ channel: l.channel, app: l.app || null, day: l._max.day! })),
    range,
    compared: compare ? { from: previous.from, to: previous.to } : null,
    currency: store.currency,
    sync: state,
  });
}

/**
 * "Checked against Shopify": each store's dashboard figures compared with Shopify's own records for
 * a window of finished store-local days, the differences traced to the orders that cause them,
 * repaired at the source, and the outcome kept (`reconciliations`, `reconciliation_results`;
 * docs/kpis.md "Checked against Shopify").
 *
 * What it compares with. Shopify's orders and their sales records (agreements → sales) for the
 * window, read again from the Admin API, are added up with the same reference formulas the
 * dashboard's totals follow (`aggregateDaily` in @app/shared). So a check proves that what the
 * dashboard holds is what Shopify holds now: no order missing or deleted, none out of date, no day
 * total left behind. It does not prove that the formulas are Shopify's report definitions: that
 * needs Shopify's own report totals (ShopifyQL, `read_reports`), a separate source
 * ("shopify_reports") that is recorded apart and never mixed with this one.
 *
 * How it runs. A worker job (apps/worker/src/verify.ts) walks the orders Shopify changed since the
 * window began, newest first, a page at a time, and hands each page here (`checkOrders`): every
 * order's share of the window's totals, Shopify's copy against the stored one. An order whose share
 * differs is classified (missing, outdated, sales that differ, a test order) and, unless the check
 * only looks, written again from Shopify's copy, which is the same upsert a webhook does. At the end
 * (`finishCheck`) stored orders of the window that Shopify didn't list are looked up one by one
 * (deleted ones are removed, as Shopify's reports drop them), every day of the window is
 * recomputed from the source tables, and the totals before and after are compared with Shopify's.
 * Orders Shopify no longer shares with the app (`withinReach`) can't be read back at all: their
 * stored share is set aside (`setAside`) and the rest compared without it.
 * The run's progress rides in its row (`state`), so a big store's check spans several jobs.
 *
 * Nothing is ever deleted to make a number match: the only deletions are of orders Shopify itself
 * says are gone or are test orders, exactly what its reports leave out.
 */
import { Prisma, systemDb, toNumber, type Store, type Tx } from "@app/db";
import { addDays, aggregateDaily, eachDay, emptyRow, expandScopes, localDay, type DailyMetricsRow, type OrderInput, type SaleInput } from "@app/shared";
import { logger } from "./logger.js";
import type { NormalizedOrder } from "./normalize.js";
import { dayTotals, recomputeDays } from "./persist.js";
import type { Producer, Queues } from "./queues.js";

/** The figures a check compares, in the order they are reported. */
export const RECONCILE_METRICS = ["orders", "grossSales", "discounts", "returns", "netSales", "shipping", "taxes", "totalSales", "units"] as const;
export type ReconcileMetric = (typeof RECONCILE_METRICS)[number];
export type Totals = Record<ReconcileMetric, number>;

/** Counts compare exactly; money to the cent. */
const COUNT_METRICS: ReadonlySet<ReconcileMetric> = new Set(["orders", "units"]);
const CENT = 0.005;

export type ReconcileTrigger = "scheduled" | "import" | "manual";
export type ReconcileStatus = "running" | "verified" | "repaired" | "differences" | "incomplete" | "failed";
export type ResultStatus = "match" | "repaired" | "difference" | "sync_delay" | "not_verifiable";

/** Why an order's share of the window differed (findings), most telling first. */
export const FINDINGS = ["missing", "deleted", "outdated", "sales_differ", "test_order", "changed_during_check", "not_listed", "stale_day"] as const;
export type FindingKind = (typeof FINDINGS)[number];

/** The worker job that runs a check; it rides the sync queue, told apart by its kind. */
export interface VerifyJob {
  kind: "verify";
  storeId: string;
  reconciliationId: string;
  /** Only look: record what differs, repair nothing (operators' `verify` action). */
  dryRun?: boolean;
  /** Times it has waited for an import of the store to finish. */
  importWaits?: number;
}
export const verifyQueue = (queues: Queues) => queues.sync as unknown as Producer<VerifyJob>;

/** Days a scheduled check covers: the last 7 finished store-local days. */
export const CHECK_DAYS = 7;
/** A check left running this long is presumed dead (its jobs gave up) and a new one may start. */
const RUNNING_STALE_MS = 2 * 3600_000;
/** Order ids kept per finding kind, for the record. */
const SAMPLE = 20;
/** Past this many orders seen, a check stops tracking which stored orders Shopify listed. */
export const MAX_SEEN = 20_000;
/** Kept this long, then deleted (pruneReconciliations). */
export const RECONCILIATIONS_KEEP_DAYS = 90;

const r2 = (n: number) => Math.round(n * 100) / 100;
const zero = (): Totals => ({ orders: 0, grossSales: 0, discounts: 0, returns: 0, netSales: 0, shipping: 0, taxes: 0, totalSales: 0, units: 0 });

/** The compared figures of a day row. Net sales is derived as the dashboard derives it. */
export function totalsOf(r: DailyMetricsRow): Totals {
  return {
    orders: r.orders,
    grossSales: r.grossSales,
    discounts: r.discounts,
    returns: r.refunds,
    netSales: r.grossSales - r.discounts - r.refunds,
    shipping: r.shipping,
    taxes: r.taxes,
    totalSales: r.totalSales,
    units: r.units,
  };
}

function add(a: Totals, b: Totals): Totals {
  const out = zero();
  for (const m of RECONCILE_METRICS) out[m] = a[m] + b[m];
  return out;
}

function sub(a: Totals, b: Totals): Totals {
  const out = zero();
  for (const m of RECONCILE_METRICS) out[m] = a[m] - b[m];
  return out;
}

/** Whether two figures agree: counts exactly, money to the cent (after rounding both to cents). */
export function same(metric: ReconcileMetric, a: number, b: number): boolean {
  return COUNT_METRICS.has(metric) ? a === b : Math.abs(r2(a) - r2(b)) < CENT;
}

const sameTotals = (a: Totals, b: Totals) => RECONCILE_METRICS.every((m) => same(m, a[m], b[m]));

/** Store-local days → totals. */
export type DayTotals = Record<string, Totals>;

function addInto(into: DayTotals, rows: Map<string, DailyMetricsRow>, days: ReadonlySet<string>) {
  for (const [day, row] of rows) {
    if (!days.has(day)) continue;
    into[day] = add(into[day] ?? zero(), totalsOf(row));
  }
}

/**
 * One order's share of the window's days, from its sales records and when it was placed (processed:
 * the day Shopify's reports put it on), counted as an order unless it holds only gift cards.
 */
export function orderShare(
  order: Pick<OrderInput, "createdAt" | "processedAt" | "giftCardOnly">,
  sales: SaleInput[],
  timeZone: string,
  days: ReadonlySet<string>,
): DayTotals {
  const out: DayTotals = {};
  const o: OrderInput = { createdAt: order.createdAt, processedAt: order.processedAt, giftCardOnly: order.giftCardOnly, customerKey: null, isReturningCustomer: false };
  addInto(out, aggregateDaily([o], sales, timeZone, localDay), days);
  return out;
}

function sameShare(a: DayTotals, b: DayTotals) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const day of keys) if (!sameTotals(a[day] ?? zero(), b[day] ?? zero())) return false;
  return true;
}

function sumDays(t: DayTotals): Totals {
  return Object.values(t).reduce(add, zero());
}

// ---------------------------------------------------------------- the run's state

interface Finding {
  count: number;
  /** A few of the orders, by Shopify id and name. */
  orders: Array<{ id: string; name: string | null }>;
}

export interface CheckState {
  /** Where the walk over Shopify's orders has got to (its cursor); null before the first page. */
  cursor: string | null;
  /** Shopify's totals so far, per day of the window. */
  shopify: DayTotals;
  /** What the dashboard showed when the check began (daily_store_metrics), per day. */
  before: DayTotals;
  /** Shopify order ids seen, for the stored orders Shopify didn't list; null past MAX_SEEN. */
  seen: string[] | null;
  /** Days whose stored orders were written again, to recompute. */
  touched: string[];
  /** Orders that changed in Shopify while the check ran (their difference is a sync delay, not an error). */
  changedDuring: number;
  findings: Partial<Record<FindingKind, Finding>>;
  repaired: number;
  removed: number;
  /**
   * The stored share of orders Shopify no longer shares (`setAside`), per day: left out of ours
   * before comparing, as Shopify's side can't hold them. Absent in a state saved before it existed.
   */
  excluded?: DayTotals;
  /** How many orders that is. */
  excludedOrders?: number;
}

export interface CheckWindow {
  from: string;
  to: string;
  timezone: string;
}

/** The finished days a check may cover for this store: the last `days`, within what Shopify shares. */
export function checkWindow(
  store: Pick<Store, "timezone" | "grantedScopes" | "ordersHistoryFrom">,
  days = CHECK_DAYS,
  now = new Date(),
): CheckWindow | null {
  const today = localDay(now, store.timezone);
  const to = addDays(today, -1);
  let from = addDays(to, -(days - 1));
  // Shopify lists orders created in the last 60 days only, without read_all_orders; stored orders
  // from before would all read as "not listed". The imported history's first whole day bounds it too.
  if (!expandScopes(store.grantedScopes).has("read_all_orders")) {
    const visible = addDays(today, -59);
    if (from < visible) from = visible;
  }
  if (store.ordersHistoryFrom && store.ordersHistoryFrom.getTime() > 0) {
    const first = addDays(localDay(store.ordersHistoryFrom, store.timezone), 1);
    if (from < first) from = first;
  }
  return from <= to ? { from, to, timezone: store.timezone } : null;
}

/**
 * The search for Shopify's orders that can have a share of the window: every order changed since a
 * moment safely before the window's first day began anywhere on earth (UTC+14). Placing an order,
 * refunding, returning, cancelling or editing it all change its updated_at.
 */
export function windowSearch(w: Pick<CheckWindow, "from">): string {
  const since = new Date(Date.parse(`${w.from}T00:00:00Z`) - 14 * 3600_000).toISOString();
  return `updated_at:>='${since}'`;
}

// ---------------------------------------------------------------- start

/**
 * Start a check of one store's window, unless one is running already (that one's id comes back).
 * Null when the store has no finished day to check yet.
 */
export async function startReconciliation(
  deps: { queues: Queues },
  store: Pick<Store, "id" | "workspaceId" | "timezone" | "currency" | "grantedScopes" | "ordersHistoryFrom">,
  trigger: ReconcileTrigger,
  opts: { days?: number; now?: Date; delaySeconds?: number; dryRun?: boolean } = {},
): Promise<{ id: string; started: boolean } | null> {
  const now = opts.now ?? new Date();
  const w = checkWindow(store, opts.days ?? CHECK_DAYS, now);
  if (!w) return null;
  const running = await systemDb.reconciliation.findFirst({
    where: { storeId: store.id, status: "running", startedAt: { gt: new Date(now.getTime() - RUNNING_STALE_MS) } },
    select: { id: true },
  });
  if (running) return { id: running.id, started: false };
  // One left running by jobs that died is closed first, so the dashboard doesn't wait on it.
  await systemDb.reconciliation.updateMany({
    where: { storeId: store.id, status: "running" },
    data: { status: "failed", error: "did not finish", finishedAt: now, state: Prisma.DbNull },
  });
  const rec = await systemDb.reconciliation.create({
    data: {
      workspaceId: store.workspaceId,
      storeId: store.id,
      source: "shopify_records",
      trigger,
      fromDay: w.from,
      toDay: w.to,
      timezone: store.timezone,
      currency: store.currency,
      status: "running",
      startedAt: now,
    },
  });
  await verifyQueue(deps.queues).send(
    { kind: "verify", storeId: store.id, reconciliationId: rec.id, ...(opts.dryRun ? { dryRun: true } : {}) },
    opts.delaySeconds ? { delaySeconds: Math.min(900, opts.delaySeconds) } : undefined,
  );
  return { id: rec.id, started: true };
}

/** The first state of a run: what the dashboard shows for the window now. */
export async function initialState(store: Pick<Store, "id" | "workspaceId">, w: CheckWindow): Promise<CheckState> {
  return {
    cursor: null,
    shopify: {},
    before: await storedDayTotals(store, w),
    seen: [],
    touched: [],
    changedDuring: 0,
    findings: {},
    repaired: 0,
    removed: 0,
    excluded: {},
    excludedOrders: 0,
  };
}

/** The window's days as the dashboard reads them (daily_store_metrics), quiet days as zero. */
export async function storedDayTotals(store: Pick<Store, "id" | "workspaceId">, w: Pick<CheckWindow, "from" | "to">): Promise<DayTotals> {
  const rows = await systemDb.dailyStoreMetrics.findMany({ where: { workspaceId: store.workspaceId, storeId: store.id, day: { gte: w.from, lte: w.to } } });
  const out: DayTotals = {};
  for (const day of eachDay(w.from, w.to)) out[day] = zero();
  for (const x of rows) {
    out[x.day] = totalsOf({
      ...emptyRow(x.day),
      grossSales: toNumber(x.grossSales),
      discounts: toNumber(x.discounts),
      refunds: toNumber(x.refunds),
      shipping: toNumber(x.shipping),
      taxes: toNumber(x.taxes),
      totalSales: toNumber(x.totalSales),
      orders: x.orders,
      units: x.units,
    });
  }
  return out;
}

// ---------------------------------------------------------------- a page of orders

type StoredOrder = { updatedAt: Date; createdAt: Date; processedAt: Date | null; giftCardOnly: boolean; sales: SaleInput[] };

/** What is stored of these orders: when Shopify last changed them, when they happened, and their sales in the window. */
async function storedOrders(store: Pick<Store, "id">, shopifyIds: string[], w: CheckWindow) {
  if (!shopifyIds.length) return new Map<string, StoredOrder>();
  const orders = await systemDb.order.findMany({
    where: { storeId: store.id, shopifyId: { in: shopifyIds } },
    select: { id: true, shopifyId: true, shopifyUpdatedAt: true, shopifyCreatedAt: true, shopifyProcessedAt: true, giftCardOnly: true },
  });
  const sales = orders.length
    ? await systemDb.orderSale.findMany({
        where: { storeId: store.id, orderId: { in: orders.map((o) => o.id) }, localDay: { gte: w.from, lte: w.to } },
        select: { orderId: true, happenedAt: true, actionType: true, lineType: true, quantity: true, amount: true, discount: true, tax: true },
      })
    : [];
  const byOrder = new Map<string, SaleInput[]>();
  for (const s of sales) {
    const list = byOrder.get(s.orderId) ?? [];
    list.push({ ...s, amount: toNumber(s.amount), discount: toNumber(s.discount), tax: toNumber(s.tax) });
    byOrder.set(s.orderId, list);
  }
  return new Map(
    orders.map((o): [string, StoredOrder] => [
      o.shopifyId,
      { updatedAt: o.shopifyUpdatedAt, createdAt: o.shopifyCreatedAt, processedAt: o.shopifyProcessedAt, giftCardOnly: o.giftCardOnly, sales: byOrder.get(o.id) ?? [] },
    ]),
  );
}

function note(state: CheckState, kind: FindingKind, order: { id: string; name: string | null }) {
  const f = (state.findings[kind] ??= { count: 0, orders: [] });
  f.count++;
  if (f.orders.length < SAMPLE) f.orders.push(order);
}

const salesOf = (o: NormalizedOrder): SaleInput[] =>
  (o.sales ?? []).map((x) => ({
    orderId: o.shopifyId,
    happenedAt: x.happenedAt,
    actionType: x.actionType,
    lineType: x.lineType,
    quantity: x.quantity,
    amount: x.amount,
    discount: x.discount,
    tax: x.tax,
  }));

/** An order to write again from Shopify's copy, or to remove (Shopify's test orders). */
export type Repair = { order: NormalizedOrder; action: "write" | "remove" };

/**
 * One page of Shopify's orders: adds their share to Shopify's totals, compares each with what is
 * stored, records why any differs, and returns the orders to write again (or remove) so they match.
 * `startedAt`: an order Shopify changed after the check began differs because it is moving, which
 * is recorded as such (the repair still brings it up to date).
 */
export async function checkOrders(store: Pick<Store, "id">, w: CheckWindow, state: CheckState, orders: NormalizedOrder[], startedAt: Date): Promise<Repair[]> {
  const days = new Set(eachDay(w.from, w.to));
  const stored = await storedOrders(store, orders.map((o) => o.shopifyId), w);
  const repairs: Repair[] = [];
  for (const o of orders) {
    if (state.seen) {
      state.seen.push(o.shopifyId);
      if (state.seen.length > MAX_SEEN) state.seen = null;
    }
    const mine = stored.get(o.shopifyId);
    const ref = { id: o.shopifyId, name: o.name };
    if (o.test) {
      // Shopify's reports leave test orders out; one stored is removed.
      if (mine) {
        note(state, "test_order", ref);
        repairs.push({ order: o, action: "remove" });
      }
      continue;
    }
    const theirs = orderShare(o, salesOf(o), w.timezone, days);
    for (const [day, t] of Object.entries(theirs)) state.shopify[day] = add(state.shopify[day] ?? zero(), t);
    const ours = mine ? orderShare(mine, mine.sales, w.timezone, days) : {};
    if (sameShare(theirs, ours)) continue;
    // The order differs from what is stored: say why, then write Shopify's copy.
    if (o.updatedAt > startedAt) {
      state.changedDuring++;
      note(state, "changed_during_check", ref);
    } else if (!mine) note(state, "missing", ref);
    else if (mine.updatedAt < o.updatedAt) note(state, "outdated", ref);
    else note(state, "sales_differ", ref);
    repairs.push({ order: o, action: "write" });
  }
  return repairs;
}

/** Remember the days a repair wrote, to recompute them at the end. */
export function touched(state: CheckState, days: Iterable<string>) {
  state.touched = [...new Set([...state.touched, ...days])].sort();
}

// ---------------------------------------------------------------- the end

/**
 * Stored orders with a share of the window that Shopify didn't list (by id): the walk saw every
 * order Shopify shares that changed since the window began, so these are deleted orders, test
 * orders, or orders Shopify no longer shares. `createdAt` tells the last apart (`withinReach`).
 */
export async function unlistedOrders(store: Pick<Store, "id">, w: CheckWindow, seen: string[]): Promise<Array<{ id: string; name: string; createdAt: Date }>> {
  const rows = await systemDb.$queryRaw<Array<{ shopify_id: string; name: string; created_at: Date }>>`
    SELECT o.shopify_id, o.name, o.shopify_created_at AS created_at FROM orders o
    WHERE o.store_id = ${store.id}
      AND (o.local_day BETWEEN ${w.from} AND ${w.to}
           OR EXISTS (SELECT 1 FROM order_sales s WHERE s.order_id = o.id AND s.local_day BETWEEN ${w.from} AND ${w.to}))
      AND NOT (o.shopify_id = ANY(${seen}::text[]))`;
  return rows.map((r) => ({ id: r.shopify_id, name: r.name, createdAt: r.created_at }));
}

/** Days of orders Shopify shares without read_all_orders, by creation date. */
export const SHOPIFY_ORDER_DAYS = 60;

/**
 * Whether Shopify shares this order with the app at all. Without read_all_orders it neither lists
 * nor returns (`nodes`, `order`) an order created more than 60 days ago: to the API it looks exactly
 * like a deleted one. So an order older than that, a day's margin included, is never taken for
 * deleted: it is out of reach, and kept as stored. (2026-10-18: the first 60-day check removed
 * PixMagic's #2718S, created 61 days before and edited since, as "deleted"; it was put back.)
 */
export function withinReach(createdAt: Date, grantedScopes: string[], now = new Date()): boolean {
  if (expandScopes(grantedScopes).has("read_all_orders")) return true;
  return createdAt.getTime() > now.getTime() - (SHOPIFY_ORDER_DAYS - 1) * 86_400_000;
}

/** What Shopify said about one unlisted order: gone (deleted), a test order, or still there. */
export type Lookup = "gone" | "test" | "present";

/** "out_of_reach": Shopify doesn't share the order (withinReach), so it wasn't looked up. */
export function noteUnlisted(state: CheckState, order: { id: string; name: string | null }, found: Lookup | "out_of_reach") {
  note(state, found === "gone" ? "deleted" : found === "test" ? "test_order" : "not_listed", order);
}

/**
 * Orders Shopify no longer shares (not `withinReach`): recorded as not listed, never looked up or
 * removed, and their stored share of the window set aside (`excluded`), so the figures are compared
 * without them. Shopify's side can't hold them, so what they add here can be neither confirmed nor
 * blamed for a difference; everything else still has to match to the cent.
 */
export async function setAside(store: Pick<Store, "id">, w: CheckWindow, state: CheckState, orders: Array<{ id: string; name: string | null }>) {
  const days = new Set(eachDay(w.from, w.to));
  const stored = await storedOrders(store, orders.map((o) => o.id), w);
  const excluded = (state.excluded ??= {});
  for (const o of orders) {
    noteUnlisted(state, o, "out_of_reach");
    const mine = stored.get(o.id);
    if (!mine) continue;
    for (const [day, t] of Object.entries(orderShare(mine, mine.sales, w.timezone, days))) excluded[day] = add(excluded[day] ?? zero(), t);
    state.excludedOrders = (state.excludedOrders ?? 0) + 1;
  }
}

/** What a check set aside (`setAside`), as kept in its row (`actions.setAside`). */
export type SetAside = {
  orders: number;
  /** Their share of the window's figures, added up. */
  totals: Totals;
};

function setAsideOf(state: CheckState): SetAside | null {
  return state.excludedOrders ? { orders: state.excludedOrders, totals: roundTotals(sumDays(state.excluded ?? {})) } : null;
}

/** Days whose daily_store_metrics row doesn't match its source rows any more (a lost recompute). */
async function staleDays(store: Pick<Store, "id" | "workspaceId">, w: CheckWindow, before: DayTotals): Promise<string[]> {
  const fresh = await sourceDayTotals(store, w);
  return Object.keys(fresh).filter((d) => !sameTotals(fresh[d]!, before[d] ?? zero()));
}

/** The window's days added up from the source tables (the query recomputeDays writes). */
async function sourceDayTotals(store: Pick<Store, "id" | "workspaceId">, w: CheckWindow): Promise<DayTotals> {
  const rows = await systemDb.$queryRaw<
    Array<{ day: string; gross_sales: string; discounts: string; refunds: string; shipping: string; taxes: string; total_sales: string; orders: number; units: number }>
  >`
    ${dayTotals(store, eachDay(w.from, w.to))}
    SELECT day, gross_sales::text, discounts::text, refunds::text, shipping::text, taxes::text, total_sales::text, orders, units FROM t`;
  const out: DayTotals = {};
  for (const x of rows) {
    out[x.day] = totalsOf({
      ...emptyRow(x.day),
      grossSales: Number(x.gross_sales),
      discounts: Number(x.discounts),
      refunds: Number(x.refunds),
      shipping: Number(x.shipping),
      taxes: Number(x.taxes),
      totalSales: Number(x.total_sales),
      orders: Number(x.orders),
      units: Number(x.units),
    });
  }
  return out;
}

export interface MetricResult {
  metric: ReconcileMetric;
  shopify: number | null;
  before: number;
  after: number;
  /** Ours from orders Shopify no longer shares, left out of the comparison (`setAside`). */
  setAside: number;
  status: ResultStatus;
  cause: string | null;
}

/** The finding that best explains a difference, for the record. */
function mainCause(state: CheckState): string | null {
  // Orders set aside are out of the comparison, so they explain no difference left in it.
  const allSetAside = (state.findings.not_listed?.count ?? 0) <= (state.excludedOrders ?? 0);
  for (const k of FINDINGS) if (state.findings[k]?.count && !(k === "not_listed" && allSetAside)) return k;
  return null;
}

/**
 * How each figure came out: Shopify's total against ours without what was set aside (`setAside`).
 * `complete` is false when the check couldn't see every order (stored orders it couldn't account
 * for, or too many to track): money it can't vouch for is then not_verifiable rather than a match.
 */
export function judge(state: CheckState, after: DayTotals, complete: boolean): MetricResult[] {
  const shopify = sumDays(state.shopify);
  const before = sumDays(state.before);
  const now = sumDays(after);
  const aside = sumDays(state.excluded ?? {});
  const cause = mainCause(state);
  return RECONCILE_METRICS.map((metric) => {
    const s = shopify[metric];
    const b = before[metric];
    const a = now[metric];
    const x = aside[metric];
    const beforeMatched = same(metric, s, b - x);
    const afterMatches = same(metric, s, a - x);
    let status: ResultStatus;
    if (!complete && !afterMatches) status = "not_verifiable";
    else if (afterMatches) status = beforeMatched ? "match" : "repaired";
    else if (state.changedDuring > 0) status = "sync_delay";
    else status = "difference";
    return { metric, shopify: r2(s), before: r2(b), after: r2(a), setAside: r2(x), status, cause: beforeMatched ? null : cause };
  });
}

export function runStatus(results: MetricResult[], complete: boolean): ReconcileStatus {
  if (results.some((r) => r.status === "difference")) return "differences";
  if (!complete || results.some((r) => r.status === "not_verifiable" || r.status === "sync_delay")) return "incomplete";
  if (results.some((r) => r.status === "repaired")) return "repaired";
  return "verified";
}

/**
 * Close a check: recompute every day of the window (and any day a repair touched) from the source
 * tables, compare with Shopify's totals, and keep the results. Days whose stored totals had drifted
 * from their own source rows are recorded as such first.
 */
export async function finishCheck(
  store: Pick<Store, "id" | "workspaceId">,
  rec: { id: string },
  w: CheckWindow,
  state: CheckState,
  complete: boolean,
  now = new Date(),
): Promise<{ status: ReconcileStatus; results: MetricResult[] }> {
  for (const day of await staleDays(store, w, state.before)) {
    if (!state.touched.includes(day)) note(state, "stale_day", { id: day, name: null });
  }
  await recomputeDays(store, [...new Set([...eachDay(w.from, w.to), ...state.touched])].sort());
  const after = await storedDayTotals(store, w);
  const results = judge(state, after, complete);
  const status = runStatus(results, complete);
  const aside = setAsideOf(state);
  // The days that still differ once what was set aside is left out, for the record (a handful at
  // most on a healthy store). `bizinsights` is the day as the dashboard shows it.
  const without = (d: string) => sub(after[d]!, state.excluded?.[d] ?? zero());
  const differing = Object.keys(after)
    .filter((d) => !sameTotals(without(d), state.shopify[d] ?? zero()))
    .slice(0, 31)
    .map((day) => ({
      day,
      shopify: roundTotals(state.shopify[day] ?? zero()),
      bizinsights: roundTotals(after[day]!),
      ...(state.excluded?.[day] ? { setAside: roundTotals(state.excluded[day]) } : {}),
    }));
  await systemDb.$transaction([
    systemDb.reconciliationResult.deleteMany({ where: { reconciliationId: rec.id } }),
    systemDb.reconciliationResult.createMany({
      data: results.map((r) => ({
        workspaceId: store.workspaceId,
        reconciliationId: rec.id,
        metric: r.metric,
        shopifyValue: r.shopify,
        beforeValue: r.before,
        afterValue: r.after,
        status: r.status,
        cause: r.cause,
      })),
    }),
    systemDb.reconciliation.update({
      where: { id: rec.id },
      data: {
        status,
        finishedAt: now,
        ordersChecked: state.seen?.length ?? 0,
        findings: { ...state.findings, ...(differing.length ? { days: differing } : {}) } as Prisma.InputJsonValue,
        actions: { repaired: state.repaired, removed: state.removed, recomputed: eachDay(w.from, w.to).length, ...(aside ? { setAside: aside } : {}) } as Prisma.InputJsonValue,
        state: Prisma.DbNull,
      },
    }),
  ]);
  logger.info(
    { storeId: store.id, reconciliationId: rec.id, status, from: w.from, to: w.to, findings: findingCounts(state), repaired: state.repaired, removed: state.removed, setAside: aside },
    "checked against shopify",
  );
  return { status, results };
}

function roundTotals(t: Totals): Totals {
  const out = zero();
  for (const m of RECONCILE_METRICS) out[m] = r2(t[m]);
  return out;
}

const findingCounts = (s: CheckState) => Object.fromEntries(Object.entries(s.findings).map(([k, f]) => [k, f?.count ?? 0]));

// ---------------------------------------------------------------- reading the outcome

/** The latest finished check of a store (and the one running, if any), for the dashboard. */
export async function latestReconciliation(tx: Tx, { ws, storeId }: { ws: string; storeId: string }) {
  const [last, running] = await Promise.all([
    tx.reconciliation.findFirst({
      where: { workspaceId: ws, storeId, source: "shopify_records", status: { notIn: ["running", "failed"] } },
      orderBy: { startedAt: "desc" },
      include: { results: true },
    }),
    tx.reconciliation.findFirst({ where: { workspaceId: ws, storeId, status: "running" }, orderBy: { startedAt: "desc" }, select: { startedAt: true } }),
  ]);
  const aside = last ? readSetAside(last.actions) : null;
  return {
    running: running ? running.startedAt.toISOString() : null,
    last: last
      ? {
          id: last.id,
          status: last.status as ReconcileStatus,
          trigger: last.trigger as ReconcileTrigger,
          from: last.fromDay,
          to: last.toDay,
          checkedAt: (last.finishedAt ?? last.startedAt).toISOString(),
          ordersChecked: last.ordersChecked,
          currency: last.currency,
          findings: summarizeFindings(last.findings),
          repaired: Number((last.actions as { repaired?: number } | null)?.repaired ?? 0),
          removed: Number((last.actions as { removed?: number } | null)?.removed ?? 0),
          /** Orders Shopify no longer shares, left out of the comparison, and their share of the figures. */
          setAside: aside,
          results: RECONCILE_METRICS.map((m) => last.results.find((r) => r.metric === m))
            .filter((r): r is NonNullable<typeof r> => !!r)
            .map((r) => ({
              metric: r.metric as ReconcileMetric,
              shopify: r.shopifyValue === null ? null : toNumber(r.shopifyValue),
              before: r.beforeValue === null ? null : toNumber(r.beforeValue),
              bizinsights: r.afterValue === null ? null : toNumber(r.afterValue),
              /** Part of `bizinsights` left out of the comparison (0 when nothing was). */
              setAside: aside?.totals[r.metric as ReconcileMetric] ?? 0,
              status: r.status as ResultStatus,
              cause: r.cause,
            })),
        }
      : null,
  };
}

/** `actions.setAside` of a check's row, when it set any order aside. */
function readSetAside(actions: unknown): SetAside | null {
  const raw = (actions as { setAside?: { orders?: unknown; totals?: Record<string, unknown> } } | null)?.setAside;
  if (!raw || typeof raw.orders !== "number" || raw.orders <= 0) return null;
  const totals = zero();
  for (const m of RECONCILE_METRICS) totals[m] = Number(raw.totals?.[m] ?? 0) || 0;
  return { orders: raw.orders, totals };
}

/** Finding counts only (the order ids stay in the database, for support). */
function summarizeFindings(raw: unknown): Partial<Record<FindingKind, number>> {
  const out: Partial<Record<FindingKind, number>> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const k of FINDINGS) {
    const f = (raw as Record<string, unknown>)[k] as { count?: unknown } | undefined;
    if (f && typeof f.count === "number" && f.count > 0) out[k] = f.count;
  }
  return out;
}

/** Drop checks older than RECONCILIATIONS_KEEP_DAYS (their results go with them). */
export async function pruneReconciliations(now = new Date()): Promise<number> {
  const { count } = await systemDb.reconciliation.deleteMany({ where: { startedAt: { lt: new Date(now.getTime() - RECONCILIATIONS_KEEP_DAYS * 86_400_000) } } });
  return count;
}

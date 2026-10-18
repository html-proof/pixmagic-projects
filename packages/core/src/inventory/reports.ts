/**
 * The Inventory pages' read side: the overview's figures, the stock list, a product's panel,
 * locations, the stock history and the reports, as functions of a tenant transaction
 * (`withTenant`). Routes authorize and call these, and pass what the member may see (`costs`:
 * cost and stock value; `history`: the stock history): what they may not see isn't computed.
 *
 * Every figure comes from what was read from Shopify (levels, the catalog, orders) or recorded on
 * the way (snapshots, movements); a figure that can't be worked out is null, with the reason.
 */
import { Prisma, type Store, type Tx } from "@app/db";
import {
  addDays,
  daysBetweenInclusive,
  dailyRate,
  daysOfStock,
  delta,
  depletionDay,
  eachDay,
  fastMovers,
  inventoryTurnover,
  localDay,
  localTime,
  restockQuantity,
  sellThrough,
  VELOCITY_DAYS,
  type Comparison,
  type DateRange,
  type StockQuery,
} from "@app/shared";
import { localMoment } from "../reports/common.js";
import type { StoreInventorySettings } from "./settings.js";
import { soldCte, STATUS, variantStockCte, type StockScope } from "./stock.js";

const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const numOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const r2 = (n: number) => Math.round(n * 100) / 100;
/** The relative change from `prev` (0.12 = 12% up; `delta` in @app/shared), as the dashboard's figures give it. */
const pct = (cur: number | null, prev: number | null) => {
  const d = delta(cur, prev);
  return d === null ? null : Math.round(d * 10_000) / 10_000;
};

export interface SeeOpts {
  /** Cost per item, cost and retail stock value, margin and turnover (inventory.costs). */
  costs: boolean;
}

/** What the store's orders say about recent sales, for rates: the first day counted and how many days. */
export interface SalesWindow {
  from: string;
  days: number;
  /** The first day all of the store's orders are imported from (null: not known). */
  historyFrom?: string | null;
}

// ---------------------------------------------------------------------------
// Sync status
// ---------------------------------------------------------------------------

export async function inventoryStatus(tx: Tx, store: Pick<Store, "id" | "workspaceId" | "lastSyncedAt">, scope: StockScope, settings: StoreInventorySettings, now = new Date()) {
  const s = { ws: store.workspaceId, storeId: store.id };
  const [last, lastOk, running, counts] = await Promise.all([
    tx.inventorySyncRun.findFirst({ where: { workspaceId: s.ws, storeId: s.storeId }, orderBy: { startedAt: "desc" } }),
    tx.inventorySyncRun.findFirst({ where: { workspaceId: s.ws, storeId: s.storeId, status: "succeeded" }, orderBy: { finishedAt: "desc" } }),
    tx.syncJob.findFirst({ where: { workspaceId: s.ws, storeId: s.storeId, kind: "inventory", status: { in: ["queued", "running"] } }, orderBy: { createdAt: "desc" } }),
    tx.$queryRaw<Array<{ locations: number; levels: number; updated: Date | null }>>`
      SELECT (SELECT COUNT(*)::int FROM inventory_locations WHERE workspace_id = ${s.ws} AND store_id = ${s.storeId} AND deleted_at IS NULL) AS locations,
             (SELECT COUNT(*)::int FROM inventory_levels WHERE workspace_id = ${s.ws} AND store_id = ${s.storeId}) AS levels,
             (SELECT MAX(synced_at) FROM inventory_levels WHERE workspace_id = ${s.ws} AND store_id = ${s.storeId}) AS updated`,
  ]);
  const c = counts[0];
  // Stale: the scheduled check hasn't succeeded for twice its interval (or the last pass failed).
  const staleAfter = 2 * settings.reconcileHours * 3600_000;
  const checkedAt = lastOk?.finishedAt ?? null;
  const stale = scope.source === "levels" && (!checkedAt || now.getTime() - checkedAt.getTime() > staleAfter || last?.status === "failed");
  return {
    source: scope.source,
    running: !!running,
    lastPass: last
      ? { trigger: last.trigger, status: last.status, startedAt: last.startedAt, finishedAt: last.finishedAt, levelsChecked: last.levelsChecked, differences: last.differences, locations: last.locations }
      : null,
    /** When every level was last checked against Shopify. */
    checkedAt,
    /** The latest level read from Shopify (a pass or a webhook). */
    stockUpdatedAt: c?.updated ?? null,
    /** When the catalog and orders were last imported in full. */
    catalogSyncedAt: store.lastSyncedAt,
    locations: c?.locations ?? 0,
    levels: c?.levels ?? 0,
    stale,
    reconcileHours: settings.reconcileHours,
  };
}
export type InventoryStatus = Awaited<ReturnType<typeof inventoryStatus>>;

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

interface Totals {
  products: number;
  variants: number;
  tracked: number;
  untracked: number;
  available: number | null;
  on_hand: number | null;
  committed: number | null;
  incoming: number | null;
  low: number;
  out: number;
  cost_value: string | null;
  with_cost: number;
  in_stock: number;
  retail_value: string | null;
  untracked_on_hand: number | null;
  slow: number;
}

async function totals(tx: Tx, scope: StockScope, sold30From: string, today: string): Promise<Totals> {
  const levels = scope.source === "levels";
  const [t] = await tx.$queryRaw<Totals[]>`
    WITH ${variantStockCte(scope)}, ${soldCte(scope, sold30From, today, "sold30")}
    SELECT COUNT(DISTINCT product_id)::int AS products, COUNT(*)::int AS variants,
           COUNT(*) FILTER (WHERE tracked)::int AS tracked, COUNT(*) FILTER (WHERE NOT tracked)::int AS untracked,
           COALESCE(SUM(available) FILTER (WHERE tracked), 0)::int AS available,
           ${levels ? Prisma.sql`COALESCE(SUM(on_hand) FILTER (WHERE tracked), 0)::int` : Prisma.sql`NULL::int`} AS on_hand,
           ${levels ? Prisma.sql`COALESCE(SUM(committed) FILTER (WHERE tracked), 0)::int` : Prisma.sql`NULL::int`} AS committed,
           ${levels ? Prisma.sql`COALESCE(SUM(incoming) FILTER (WHERE tracked), 0)::int` : Prisma.sql`NULL::int`} AS incoming,
           COUNT(*) FILTER (WHERE ${STATUS} = 'low')::int AS low,
           COUNT(*) FILTER (WHERE ${STATUS} = 'out')::int AS out,
           SUM(GREATEST(${levels ? Prisma.sql`on_hand` : Prisma.sql`available`}, 0) * unit_cost) FILTER (WHERE tracked AND ${levels ? Prisma.sql`on_hand` : Prisma.sql`available`} > 0)::text AS cost_value,
           COUNT(*) FILTER (WHERE tracked AND ${levels ? Prisma.sql`on_hand` : Prisma.sql`available`} > 0 AND unit_cost IS NOT NULL)::int AS with_cost,
           COUNT(*) FILTER (WHERE tracked AND ${levels ? Prisma.sql`on_hand` : Prisma.sql`available`} > 0)::int AS in_stock,
           COALESCE(SUM(GREATEST(${levels ? Prisma.sql`on_hand` : Prisma.sql`available`}, 0) * price) FILTER (WHERE tracked), 0)::text AS retail_value,
           ${levels ? Prisma.sql`COALESCE(SUM(on_hand) FILTER (WHERE NOT tracked), 0)::int` : Prisma.sql`NULL::int`} AS untracked_on_hand,
           COUNT(*) FILTER (WHERE tracked AND available > 0 AND NOT EXISTS (SELECT 1 FROM sold30 s WHERE s.variant_id = vs.variant_id))::int AS slow
    FROM vs`;
  return t!;
}

/** Units in orders placed on `days` (store-local), the last one counted up to `until` ("HH:MM:SS") when given. */
async function unitsSold(tx: Tx, store: Pick<Store, "id" | "workspaceId" | "timezone">, from: string, to: string, until?: string): Promise<number> {
  const cut = until ? Prisma.sql`AND (o.local_day < ${to} OR o.shopify_created_at <= ${localMoment(to, until, store.timezone)})` : Prisma.empty;
  const [r] = await tx.$queryRaw<Array<{ units: number | null }>>`
    SELECT SUM(li.quantity)::int AS units
    FROM order_line_items li JOIN orders o ON o.id = li.order_id
    WHERE li.workspace_id = ${store.workspaceId} AND li.store_id = ${store.id} AND o.workspace_id = ${store.workspaceId} AND o.store_id = ${store.id}
      AND o.cancelled_at IS NULL AND o.local_day BETWEEN ${from} AND ${to} ${cut}`;
  return num(r?.units);
}

export interface StockKpi {
  value: number | null;
  /** The value it is compared with (the end of the comparison period, or the same span before). */
  previous: number | null;
  /** % change from `previous`; null without one. */
  change: number | null;
  /** Why the value is null, or what it leaves out. */
  note?: string;
  /** Cost value only: false when some stock has no cost recorded. */
  complete?: boolean;
  /** What the figure is as of: "stock" (the stored levels), "orders" (the imported orders), "now" (both). */
  basis: "stock" | "orders";
}

/**
 * Inventory turnover over `range`: the cost of the units sold (current cost per item) ÷ the
 * average cost value of the stock, from the day's-end snapshots. Null, with the reason, unless
 * snapshots cover at least 90% of the days with complete costs and every unit sold has a cost.
 */
async function turnover(tx: Tx, scope: StockScope, range: DateRange): Promise<{ value: number | null; note?: string; cogs: number | null; averageValue: number | null }> {
  const days = daysBetweenInclusive(range.from, range.to);
  const [snap] = await tx.$queryRaw<Array<{ n: number; avg: string | null; incomplete: number }>>`
    SELECT COUNT(*)::int AS n, AVG(cost_value)::text AS avg, COUNT(*) FILTER (WHERE variants_with_cost < variants_in_stock)::int AS incomplete
    FROM inventory_snapshots WHERE workspace_id = ${scope.ws} AND store_id = ${scope.storeId} AND location_key = 'all' AND day BETWEEN ${range.from} AND ${range.to}`;
  const [sold] = await tx.$queryRaw<Array<{ cogs: string | null; without_cost: number }>>`
    WITH ${soldCte(scope, range.from, range.to)}
    SELECT SUM(s.units * v.unit_cost)::text AS cogs, COUNT(*) FILTER (WHERE v.unit_cost IS NULL)::int AS without_cost
    FROM sold s JOIN product_variants v ON v.workspace_id = ${scope.ws} AND v.store_id = ${scope.storeId} AND v.shopify_id = s.variant_id`;
  const n = num(snap?.n);
  const averageValue = numOrNull(snap?.avg);
  const cogs = sold?.without_cost ? null : (numOrNull(sold?.cogs) ?? 0);
  if (n < Math.ceil(days * 0.9)) return { value: null, note: `Needs a daily stock record for most of the period; bizinsights has ${n} of ${days} days.`, cogs, averageValue };
  if (num(snap?.incomplete) > 0) return { value: null, note: "Some stock has no cost per item in Shopify, so its value isn't known.", cogs, averageValue };
  if (cogs === null) return { value: null, note: "Some items sold have no cost per item in Shopify.", cogs, averageValue };
  const value = inventoryTurnover(cogs, averageValue);
  return { value: value === null ? null : r2(value), ...(value === null ? { note: "The stock held over the period was worth nothing at cost." } : {}), cogs, averageValue };
}

/** The overview: every figure on the Inventory overview, with what it's compared with. */
export async function inventoryOverview(
  tx: Tx,
  store: Pick<Store, "id" | "workspaceId" | "timezone">,
  scope: StockScope,
  dates: { range: DateRange; previous: Comparison },
  sales: SalesWindow,
  now: Date,
  see: SeeOpts,
) {
  const today = localDay(now, store.timezone);
  const t = await totals(tx, scope, addDays(today, -(VELOCITY_DAYS - 1)), today);
  const levels = scope.source === "levels";

  // The stock at the end of the comparison period (its day's-end record), when there is one.
  const prevDay = dates.previous.to < today ? dates.previous.to : addDays(today, -1);
  const prev = await tx.inventorySnapshot.findUnique({ where: { storeId_day_locationKey: { storeId: store.id, day: prevDay, locationKey: "all" } } });
  const noRecord = prev ? undefined : "No stock recorded at the start of the period to compare with yet.";
  const stockKpi = (value: number | null, previous: number | null | undefined, note?: string): StockKpi => ({
    value,
    previous: previous ?? null,
    change: pct(value, previous ?? null),
    ...(note ? { note } : previous === undefined || previous === null ? (noRecord ? { note: noRecord } : {}) : {}),
    basis: "stock",
  });
  const needsLevels = "Needs stock-level access in Shopify (Inventory → Stock settings).";

  // Units sold today and this month, each against the same span before, up to the same time of day.
  const time = localTime(now, store.timezone);
  const yesterday = addDays(today, -1);
  const monthStart = `${today.slice(0, 8)}01`;
  const prevMonthStart = `${addDays(monthStart, -1).slice(0, 8)}01`;
  const prevMonthEnd = addDays(monthStart, -1);
  const sameDay = addDays(prevMonthStart, daysBetweenInclusive(monthStart, today) - 1);
  const prevMonthTo = sameDay > prevMonthEnd ? prevMonthEnd : sameDay;
  const [uToday, uYesterday, uMonth, uPrevMonth] = await Promise.all([
    unitsSold(tx, store, today, today),
    unitsSold(tx, store, yesterday, yesterday, time),
    unitsSold(tx, store, monthStart, today),
    unitsSold(tx, store, prevMonthStart, prevMonthTo, prevMonthTo === sameDay ? time : undefined),
  ]);
  const ordersCover = (from: string) => !!sales.historyFrom && sales.historyFrom <= from;
  const notImported = "The orders of the span it's compared with aren't all imported.";

  // Fast- and slow-moving, from the last 30 days of sales.
  const rows = await tx.$queryRaw<Array<{ variant_id: string; units: number }>>`
    WITH ${soldCte(scope, sales.from, today)} SELECT variant_id, units FROM sold`;
  const fast = sales.days >= 14 ? fastMovers(rows.map((r) => ({ id: r.variant_id, units: r.units }))).length : null;
  const rate = dailyRate(rows.reduce((n, r) => n + r.units, 0), sales.days);
  const left = t.available === null ? null : daysOfStock(t.available, rate);

  const costValue = t.with_cost ? numOrNull(t.cost_value) : null;
  const kpis = {
    products: { value: t.products, previous: null, change: null, basis: "stock" } as StockKpi,
    variants: stockKpi(t.variants, prev ? prev.trackedVariants + prev.untrackedVariants : undefined),
    available: stockKpi(t.available, prev?.available),
    onHand: levels ? stockKpi(t.on_hand, prev?.onHand) : stockKpi(null, null, needsLevels),
    committed: levels ? stockKpi(t.committed, prev?.committed) : stockKpi(null, null, needsLevels),
    incoming: levels ? stockKpi(t.incoming, prev?.incoming) : stockKpi(null, null, needsLevels),
    lowStock: stockKpi(t.low, prev?.lowStock),
    outOfStock: stockKpi(t.out, prev?.outOfStock),
    costValue: see.costs
      ? {
          ...stockKpi(costValue, prev?.costValue ? Number(prev.costValue) : undefined, t.with_cost < t.in_stock ? `Incomplete: ${t.in_stock - t.with_cost} of ${t.in_stock} items in stock have no cost per item.` : undefined),
          complete: t.with_cost === t.in_stock,
        }
      : null,
    retailValue: see.costs ? stockKpi(numOrNull(t.retail_value), prev ? Number(prev.retailValue) : undefined) : null,
    unitsToday: ordersCover(yesterday)
      ? ({ value: uToday, previous: uYesterday, change: pct(uToday, uYesterday), basis: "orders" } as StockKpi)
      : ({ value: uToday, previous: null, change: null, note: notImported, basis: "orders" } as StockKpi),
    unitsMonth: ordersCover(prevMonthStart)
      ? ({ value: uMonth, previous: uPrevMonth, change: pct(uMonth, uPrevMonth), basis: "orders" } as StockKpi)
      : ({ value: uMonth, previous: null, change: null, note: notImported, basis: "orders" } as StockKpi),
    fastMoving: { value: fast, previous: null, change: null, basis: "orders", ...(fast === null ? { note: "Needs at least 14 days of imported orders." } : {}) } as StockKpi,
    slowMoving: { value: sales.days >= VELOCITY_DAYS ? t.slow : null, previous: null, change: null, basis: "orders", ...(sales.days < VELOCITY_DAYS ? { note: "Needs 30 days of imported orders." } : {}) } as StockKpi,
    turnover: see.costs ? await turnoverKpi(tx, scope, dates) : null,
    daysOfStock: {
      value: left === null ? null : Math.round(left),
      previous: null,
      change: null,
      basis: "orders",
      ...(left === null ? { note: rate === null ? "Needs at least 14 days of imported orders." : "Nothing sold in the last 30 days." } : {}),
    } as StockKpi,
  };
  return {
    today,
    comparedWith: prevDay,
    kpis,
    untracked: { variants: t.untracked, onHand: t.untracked_on_hand },
    tracked: t.tracked,
    salesDays: sales.days,
  };
}

async function turnoverKpi(tx: Tx, scope: StockScope, dates: { range: DateRange; previous: Comparison }): Promise<StockKpi> {
  const [cur, prev] = await Promise.all([turnover(tx, scope, dates.range), turnover(tx, scope, dates.previous)]);
  return { value: cur.value, previous: prev.value, change: pct(cur.value, prev.value), basis: "orders", ...(cur.note ? { note: cur.note } : {}) };
}

// ---------------------------------------------------------------------------
// The stock list
// ---------------------------------------------------------------------------

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

function stockFilters(q: StockQuery): Prisma.Sql {
  const parts: Prisma.Sql[] = [Prisma.sql`TRUE`];
  if (q.q) {
    const like = `%${escapeLike(q.q)}%`;
    parts.push(Prisma.sql`(product_title ILIKE ${like} OR variant_title ILIKE ${like} OR sku ILIKE ${like} OR barcode ILIKE ${like})`);
  }
  if (q.status) parts.push(Prisma.sql`${STATUS} = ${q.status}`);
  if (q.vendor) parts.push(Prisma.sql`vendor = ${q.vendor}`);
  if (q.type) parts.push(Prisma.sql`product_type = ${q.type}`);
  if (q.collection) parts.push(Prisma.sql`collections @> ${JSON.stringify([{ id: q.collection }])}::jsonb`);
  if (q.priceMin !== undefined) parts.push(Prisma.sql`price >= ${q.priceMin}`);
  if (q.priceMax !== undefined) parts.push(Prisma.sql`price <= ${q.priceMax}`);
  return Prisma.join(parts, " AND ");
}

function stockOrder(q: StockQuery, see: SeeOpts): Prisma.Sql {
  const dir = q.dir === "desc" ? Prisma.sql`DESC` : Prisma.sql`ASC`;
  const nulls = Prisma.sql`NULLS LAST`;
  const by: Record<StockQuery["sort"], Prisma.Sql> = {
    product: Prisma.sql`product_title ${dir}, position ASC NULLS LAST, variant_title ASC`,
    sku: Prisma.sql`sku ${dir} ${nulls}, product_title ASC`,
    available: Prisma.sql`available ${dir} ${nulls}, product_title ASC`,
    on_hand: Prisma.sql`on_hand ${dir} ${nulls}, product_title ASC`,
    committed: Prisma.sql`committed ${dir} ${nulls}, product_title ASC`,
    incoming: Prisma.sql`incoming ${dir} ${nulls}, product_title ASC`,
    value: see.costs ? Prisma.sql`(GREATEST(COALESCE(on_hand, available), 0) * unit_cost) ${dir} ${nulls}, product_title ASC` : Prisma.sql`product_title ASC`,
    updated: Prisma.sql`stock_updated_at ${dir} ${nulls}, product_title ASC`,
  };
  return by[q.sort];
}

interface StockRowDb {
  variant_id: string;
  product_id: string;
  product_title: string;
  product_status: string | null;
  vendor: string | null;
  product_type: string | null;
  image_url: string | null;
  variant_title: string;
  sku: string | null;
  barcode: string | null;
  options: unknown;
  price: string;
  unit_cost: string | null;
  tracked: boolean;
  inventory_policy: string | null;
  threshold: number;
  available: number | null;
  on_hand: number | null;
  committed: number | null;
  incoming: number | null;
  reserved: number | null;
  damaged: number | null;
  safety_stock: number | null;
  quality_control: number | null;
  levels: number | null;
  stock_synced_at: Date | null;
  stock_updated_at: Date | null;
  status: string;
  sold30: number;
  total: bigint;
}

function stockRow(r: StockRowDb, sales: SalesWindow, today: string, settings: Pick<StoreInventorySettings, "leadTimeDays" | "coverDays">, see: SeeOpts) {
  const rate = dailyRate(r.sold30, sales.days);
  const available = r.available;
  const onHand = r.on_hand;
  return {
    variantId: r.variant_id,
    productId: r.product_id,
    productTitle: r.product_title,
    productStatus: r.product_status,
    vendor: r.vendor,
    productType: r.product_type,
    imageUrl: r.image_url,
    variantTitle: r.variant_title,
    options: Array.isArray(r.options) ? (r.options as Array<{ name: string; value: string }>) : [],
    sku: r.sku,
    barcode: r.barcode,
    price: Number(r.price),
    unitCost: see.costs ? numOrNull(r.unit_cost) : undefined,
    stockValue: see.costs ? (r.unit_cost === null ? null : r2(Math.max(0, onHand ?? available ?? 0) * Number(r.unit_cost))) : undefined,
    tracked: r.tracked,
    continueSelling: r.inventory_policy === "continue",
    threshold: r.threshold,
    available,
    onHand,
    committed: r.committed,
    incoming: r.incoming,
    unavailable: r.on_hand === null ? null : num(r.reserved) + num(r.damaged) + num(r.safety_stock) + num(r.quality_control),
    locations: r.levels,
    status: r.status,
    updatedAt: r.stock_updated_at,
    syncedAt: r.stock_synced_at,
    sold30: r.sold30,
    dailyRate: rate === null ? null : r2(rate),
    daysOfStock: available === null || !r.tracked ? null : (() => {
      const d = daysOfStock(available, rate);
      return d === null ? null : Math.round(d);
    })(),
    depletionDate: available === null || !r.tracked ? null : depletionDay(today, available, rate),
    restock: !r.tracked || available === null ? null : restockQuantity({ available, incoming: r.incoming ?? 0, rate, leadTimeDays: settings.leadTimeDays, coverDays: settings.coverDays }),
  };
}
export type StockRow = ReturnType<typeof stockRow>;

/** A page of the stock list: one row per variant (at the location, when one is picked). */
export async function stockList(
  tx: Tx,
  scope: StockScope,
  q: StockQuery,
  sales: SalesWindow,
  today: string,
  settings: Pick<StoreInventorySettings, "leadTimeDays" | "coverDays">,
  see: SeeOpts,
  opts: { all?: boolean; product?: string } = {},
) {
  const limit = opts.all ? Prisma.sql`LIMIT 50000` : Prisma.sql`LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`;
  const product = opts.product ? Prisma.sql`AND vs.product_id = ${opts.product}` : Prisma.empty;
  const rows = await tx.$queryRaw<StockRowDb[]>`
    WITH ${variantStockCte(scope)}, ${soldCte(scope, sales.from, today, "sold30")}
    SELECT vs.*, ${STATUS} AS status, COALESCE(s.units, 0)::int AS sold30, COUNT(*) OVER () AS total
    FROM vs LEFT JOIN sold30 s ON s.variant_id = vs.variant_id
    WHERE ${stockFilters(q)} ${product}
    ORDER BY ${stockOrder(q, see)}
    ${limit}`;
  return {
    rows: rows.map((r) => stockRow(r, sales, today, settings, see)),
    total: rows.length ? Number(rows[0]!.total) : 0,
    page: q.page,
    pageSize: q.pageSize,
  };
}

/** What the stock list can be filtered by, and how many variants are in each status. */
export async function stockFacets(tx: Tx, scope: StockScope) {
  const [vendors, types, collections, statuses, locations] = await Promise.all([
    tx.$queryRaw<Array<{ v: string }>>`SELECT DISTINCT vendor AS v FROM products WHERE workspace_id = ${scope.ws} AND store_id = ${scope.storeId} AND vendor IS NOT NULL AND vendor <> '' ORDER BY 1 LIMIT 500`,
    tx.$queryRaw<Array<{ v: string }>>`SELECT DISTINCT product_type AS v FROM products WHERE workspace_id = ${scope.ws} AND store_id = ${scope.storeId} AND product_type IS NOT NULL AND product_type <> '' ORDER BY 1 LIMIT 500`,
    tx.$queryRaw<Array<{ id: string; title: string }>>`
      SELECT DISTINCT c->>'id' AS id, c->>'title' AS title
      FROM products p, jsonb_array_elements(COALESCE(p.collections, '[]'::jsonb)) c
      WHERE p.workspace_id = ${scope.ws} AND p.store_id = ${scope.storeId} ORDER BY 2 LIMIT 500`,
    tx.$queryRaw<Array<{ status: string; n: number }>>`WITH ${variantStockCte(scope)} SELECT ${STATUS} AS status, COUNT(*)::int AS n FROM vs GROUP BY 1`,
    tx.inventoryLocation.findMany({ where: { workspaceId: scope.ws, storeId: scope.storeId, deletedAt: null }, orderBy: [{ isActive: "desc" }, { name: "asc" }], select: { shopifyId: true, name: true, isActive: true } }),
  ]);
  return {
    vendors: vendors.map((r) => r.v),
    types: types.map((r) => r.v),
    collections: collections.filter((c) => c.id),
    statuses: Object.fromEntries(statuses.map((s) => [s.status, s.n])) as Record<string, number>,
    locations: locations.map((l) => ({ id: l.shopifyId, name: l.name, active: l.isActive })),
  };
}

/** The stock list as a CSV table (every row matching the filters). */
export function stockTable(rows: readonly StockRow[], see: SeeOpts, locationName: string | null) {
  const header = [
    "Product",
    "Variant",
    "SKU",
    "Barcode",
    "Location",
    "Status",
    "Available",
    "On hand",
    "Committed",
    "Incoming",
    "Unavailable",
    "Low-stock threshold",
    "Price",
    ...(see.costs ? ["Cost per item", "Stock value at cost"] : []),
    "Units sold (30 days)",
    "Days of stock left",
    "Last updated (UTC)",
  ];
  const status: Record<string, string> = { in_stock: "In stock", low: "Low stock", out: "Out of stock", untracked: "Not tracked" };
  const body = rows.map((r) => [
    r.productTitle,
    r.variantTitle,
    r.sku,
    r.barcode,
    locationName ?? "All locations",
    status[r.status] ?? r.status,
    r.available,
    r.onHand,
    r.committed,
    r.incoming,
    r.unavailable,
    r.threshold,
    r.price,
    ...(see.costs ? [r.unitCost ?? null, r.stockValue ?? null] : []),
    r.sold30,
    r.daysOfStock,
    r.updatedAt ? r.updatedAt.toISOString() : null,
  ]);
  return { header, rows: body };
}

// ---------------------------------------------------------------------------
// A product
// ---------------------------------------------------------------------------

export async function productDetail(
  tx: Tx,
  store: Pick<Store, "id" | "workspaceId" | "shopDomain" | "timezone">,
  scope: StockScope,
  productId: string,
  sales: SalesWindow,
  today: string,
  settings: Pick<StoreInventorySettings, "leadTimeDays" | "coverDays">,
  see: SeeOpts & { info: boolean; history: boolean },
) {
  const product = await tx.product.findFirst({ where: { workspaceId: store.workspaceId, storeId: store.id, shopifyId: productId } });
  if (!product) return null;
  const variants = await tx.productVariant.findMany({ where: { workspaceId: store.workspaceId, storeId: store.id, productShopifyId: productId }, orderBy: [{ position: "asc" }, { title: "asc" }] });
  const list = await stockList(tx, scope, { sort: "product", dir: "asc", page: 1, pageSize: 200 }, sales, today, settings, see, { all: true, product: productId });
  const stock = new Map(list.rows.map((r) => [r.variantId, r]));
  const items = variants.map((v) => v.inventoryItemId).filter((i): i is string => !!i);
  const levels = scope.source === "levels" && items.length
    ? await tx.$queryRaw<Array<{ inventory_item_id: string; location_shopify_id: string; name: string; is_active: boolean; available: number; on_hand: number; committed: number; incoming: number; reserved: number; damaged: number; safety_stock: number; quality_control: number; shopify_updated_at: Date; synced_at: Date }>>`
        SELECT l.inventory_item_id, l.location_shopify_id, loc.name, loc.is_active, l.available, l.on_hand, l.committed, l.incoming, l.reserved, l.damaged,
               l.safety_stock, l.quality_control, l.shopify_updated_at, l.synced_at
        FROM inventory_levels l JOIN inventory_locations loc ON loc.store_id = l.store_id AND loc.shopify_id = l.location_shopify_id AND loc.deleted_at IS NULL
        WHERE l.workspace_id = ${store.workspaceId} AND l.store_id = ${store.id} AND l.inventory_item_id = ANY(${items}::text[])
        ORDER BY loc.is_active DESC, loc.name`
    : [];
  // Sales: units per day over the last 30 days, and per variant over 7, 30 and 90 days.
  const ids = variants.map((v) => v.shopifyId);
  const from90 = addDays(today, -89);
  const daily = ids.length
    ? await tx.$queryRaw<Array<{ day: string; variant: string; units: number; revenue: string }>>`
        SELECT o.local_day AS day, li.variant_shopify_id AS variant, SUM(li.quantity)::int AS units, SUM(li.price * li.quantity - li.discount)::text AS revenue
        FROM order_line_items li JOIN orders o ON o.id = li.order_id
        WHERE li.workspace_id = ${store.workspaceId} AND li.store_id = ${store.id} AND o.workspace_id = ${store.workspaceId} AND o.store_id = ${store.id}
          AND o.cancelled_at IS NULL AND o.local_day BETWEEN ${from90} AND ${today} AND li.variant_shopify_id = ANY(${ids}::text[])
        GROUP BY 1, 2`
    : [];
  const unitsSince = (variant: string | null, from: string) => daily.filter((d) => (variant === null || d.variant === variant) && d.day >= from).reduce((n, d) => n + d.units, 0);
  const history = see.history && ids.length ? await movementList(tx, store, { page: 1, pageSize: 50, product: productId }) : null;

  return {
    product: {
      id: product.shopifyId,
      title: product.title,
      status: product.status,
      vendor: product.vendor,
      productType: product.productType,
      category: product.category,
      tags: see.info ? product.tags : [],
      collections: see.info && Array.isArray(product.collections) ? (product.collections as Array<{ id: string; title: string }>) : [],
      description: see.info ? product.description : null,
      imageUrl: product.imageUrl,
      handle: product.handle,
      onlineStoreUrl: see.info ? product.onlineStoreUrl : null,
      adminUrl: `https://admin.shopify.com/store/${store.shopDomain.replace(/\.myshopify\.com$/, "")}/products/${product.shopifyId}`,
      createdAt: product.shopifyCreatedAt,
      updatedAt: product.shopifyUpdatedAt,
      lowStockThreshold: product.lowStockThreshold,
    },
    variants: variants.map((v) => {
      const s = stock.get(v.shopifyId);
      return {
        id: v.shopifyId,
        title: v.title,
        sku: v.sku,
        barcode: see.info ? v.barcode : null,
        options: Array.isArray(v.options) ? (v.options as Array<{ name: string; value: string }>) : [],
        price: Number(v.price),
        compareAtPrice: see.info && v.compareAtPrice !== null ? Number(v.compareAtPrice) : null,
        unitCost: see.costs ? (v.unitCost === null ? null : Number(v.unitCost)) : undefined,
        taxable: see.info ? v.taxable : null,
        requiresShipping: see.info ? v.requiresShipping : null,
        weight: see.info && v.weight !== null ? Number(v.weight) : null,
        weightUnit: see.info ? v.weightUnit : null,
        tracked: v.inventoryQuantity !== null,
        continueSelling: v.inventoryPolicy === "continue",
        inventoryItemId: v.inventoryItemId,
        lowStockThreshold: v.lowStockThreshold,
        threshold: s?.threshold ?? null,
        status: s?.status ?? (v.inventoryQuantity === null ? "untracked" : null),
        available: s?.available ?? v.inventoryQuantity,
        onHand: s?.onHand ?? null,
        committed: s?.committed ?? null,
        incoming: s?.incoming ?? null,
        createdAt: v.shopifyCreatedAt,
        updatedAt: v.shopifyUpdatedAt,
        sales: { units7: unitsSince(v.shopifyId, addDays(today, -6)), units30: unitsSince(v.shopifyId, addDays(today, -29)), units90: unitsSince(v.shopifyId, from90) },
        dailyRate: s?.dailyRate ?? null,
        daysOfStock: s?.daysOfStock ?? null,
        depletionDate: s?.depletionDate ?? null,
        restock: s?.restock ?? null,
        levels: levels
          .filter((l) => l.inventory_item_id === v.inventoryItemId)
          .map((l) => ({
            locationId: l.location_shopify_id,
            locationName: l.name,
            locationActive: l.is_active,
            available: l.available,
            onHand: l.on_hand,
            committed: l.committed,
            incoming: l.incoming,
            reserved: l.reserved,
            damaged: l.damaged,
            safetyStock: l.safety_stock,
            qualityControl: l.quality_control,
            updatedAt: l.shopify_updated_at,
            syncedAt: l.synced_at,
          })),
      };
    }),
    sales: {
      days: eachDay(addDays(today, -29), today).map((day) => ({ day, units: daily.filter((d) => d.day === day).reduce((n, d) => n + d.units, 0) })),
      units7: unitsSince(null, addDays(today, -6)),
      units30: unitsSince(null, addDays(today, -29)),
      units90: unitsSince(null, from90),
      revenue30: see.costs ? r2(daily.filter((d) => d.day >= addDays(today, -29)).reduce((n, d) => n + Number(d.revenue), 0)) : undefined,
      salesDays: sales.days,
    },
    history,
  };
}

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

export async function locationsReport(tx: Tx, scope: StockScope, see: SeeOpts) {
  const locations = await tx.inventoryLocation.findMany({ where: { workspaceId: scope.ws, storeId: scope.storeId, deletedAt: null }, orderBy: [{ isActive: "desc" }, { name: "asc" }] });
  if (scope.source !== "levels") return { locations: locations.map((l) => ({ ...locationInfo(l), stock: null })) };
  const rows = await tx.$queryRaw<Array<{ loc: string; stocked: number; available: number; on_hand: number; committed: number; incoming: number; unavailable: number; low: number; out: number; cost_value: string | null; with_cost: number; in_stock: number; untracked: number }>>`
    WITH v AS (
      SELECT v.inventory_item_id, v.unit_cost, (v.inventory_quantity IS NOT NULL) AS tracked,
             COALESCE(v.low_stock_threshold, p.low_stock_threshold, ${scope.threshold})::int AS threshold
      FROM product_variants v JOIN products p ON p.workspace_id = ${scope.ws} AND p.store_id = v.store_id AND p.shopify_id = v.product_shopify_id
      WHERE v.workspace_id = ${scope.ws} AND v.store_id = ${scope.storeId} AND v.inventory_item_id IS NOT NULL AND (p.status IS NULL OR LOWER(p.status) <> 'archived')
    )
    SELECT l.location_shopify_id AS loc,
           COUNT(*) FILTER (WHERE v.tracked AND l.on_hand > 0)::int AS stocked,
           COALESCE(SUM(l.available) FILTER (WHERE v.tracked), 0)::int AS available,
           COALESCE(SUM(l.on_hand) FILTER (WHERE v.tracked), 0)::int AS on_hand,
           COALESCE(SUM(l.committed) FILTER (WHERE v.tracked), 0)::int AS committed,
           COALESCE(SUM(l.incoming) FILTER (WHERE v.tracked), 0)::int AS incoming,
           COALESCE(SUM(l.reserved + l.damaged + l.safety_stock + l.quality_control) FILTER (WHERE v.tracked), 0)::int AS unavailable,
           COUNT(*) FILTER (WHERE v.tracked AND l.available > 0 AND l.available <= v.threshold)::int AS low,
           COUNT(*) FILTER (WHERE v.tracked AND l.available <= 0)::int AS out,
           SUM(GREATEST(l.on_hand, 0) * v.unit_cost) FILTER (WHERE v.tracked AND l.on_hand > 0)::text AS cost_value,
           COUNT(*) FILTER (WHERE v.tracked AND l.on_hand > 0 AND v.unit_cost IS NOT NULL)::int AS with_cost,
           COUNT(*) FILTER (WHERE v.tracked AND l.on_hand > 0)::int AS in_stock,
           COUNT(*) FILTER (WHERE NOT v.tracked)::int AS untracked
    FROM inventory_levels l JOIN v ON v.inventory_item_id = l.inventory_item_id
    WHERE l.workspace_id = ${scope.ws} AND l.store_id = ${scope.storeId}
    GROUP BY 1`;
  const by = new Map(rows.map((r) => [r.loc, r]));
  return {
    locations: locations.map((l) => {
      const r = by.get(l.shopifyId);
      return {
        ...locationInfo(l),
        stock: {
          itemsStocked: r?.stocked ?? 0,
          available: r?.available ?? 0,
          onHand: r?.on_hand ?? 0,
          committed: r?.committed ?? 0,
          incoming: r?.incoming ?? 0,
          unavailable: r?.unavailable ?? 0,
          lowStock: r?.low ?? 0,
          outOfStock: r?.out ?? 0,
          untrackedItems: r?.untracked ?? 0,
          costValue: see.costs ? (r?.with_cost ? numOrNull(r.cost_value) : null) : undefined,
          costComplete: see.costs ? (r?.with_cost ?? 0) === (r?.in_stock ?? 0) : undefined,
        },
      };
    }),
  };
}

function locationInfo(l: { shopifyId: string; name: string; isActive: boolean; isFulfillmentService: boolean; fulfillsOnlineOrders: boolean | null; formattedAddress: string | null; address: unknown; syncedAt: Date }) {
  return {
    id: l.shopifyId,
    name: l.name,
    active: l.isActive,
    fulfillmentService: l.isFulfillmentService,
    fulfillsOnlineOrders: l.fulfillsOnlineOrders,
    address: l.formattedAddress,
    countryCode: (l.address as { countryCode?: string } | null)?.countryCode ?? null,
    syncedAt: l.syncedAt,
  };
}

// ---------------------------------------------------------------------------
// Stock history
// ---------------------------------------------------------------------------

export interface MovementQuery {
  page: number;
  pageSize: number;
  source?: "observed" | "bizinsights";
  location?: string;
  product?: string;
  variant?: string;
  from?: string;
  to?: string;
  q?: string;
}

/** Stock changes, newest first: what bizinsights saw change in Shopify, and the changes made in bizinsights. */
export async function movementList(tx: Tx, store: Pick<Store, "id" | "workspaceId" | "timezone">, q: MovementQuery) {
  const where: Prisma.InventoryMovementWhereInput = {
    workspaceId: store.workspaceId,
    storeId: store.id,
    ...(q.source === "bizinsights" ? { source: "adjustment" } : q.source === "observed" ? { source: { not: "adjustment" } } : {}),
    ...(q.location ? { locationShopifyId: q.location } : {}),
    ...(q.product ? { productShopifyId: q.product } : {}),
    ...(q.variant ? { variantShopifyId: q.variant } : {}),
    ...(q.from || q.to
      ? { observedAt: { ...(q.from ? { gte: dayStart(q.from, store.timezone) } : {}), ...(q.to ? { lt: dayStart(addDays(q.to, 1), store.timezone) } : {}) } }
      : {}),
    ...(q.q ? { OR: [{ productTitle: { contains: q.q, mode: "insensitive" } }, { variantTitle: { contains: q.q, mode: "insensitive" } }, { sku: { contains: q.q, mode: "insensitive" } }] } : {}),
  };
  const [rows, total] = await Promise.all([
    tx.inventoryMovement.findMany({ where, orderBy: [{ observedAt: "desc" }, { id: "desc" }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    tx.inventoryMovement.count({ where }),
  ]);
  const adjustmentIds = [...new Set(rows.map((r) => r.adjustmentId).filter((x): x is string => !!x))];
  const adjustments = adjustmentIds.length ? await tx.inventoryAdjustment.findMany({ where: { workspaceId: store.workspaceId, id: { in: adjustmentIds } } }) : [];
  const byId = new Map(adjustments.map((a) => [a.id, a]));
  const actors = await actorNames(tx, adjustments.map((a) => a.actorUserId));
  return {
    total,
    page: q.page,
    pageSize: q.pageSize,
    rows: rows.map((m) => {
      const a = m.adjustmentId ? byId.get(m.adjustmentId) : undefined;
      return {
        id: m.id,
        at: m.observedAt,
        shopifyUpdatedAt: m.shopifyUpdatedAt,
        // "confirmed": made in bizinsights and confirmed by Shopify; "observed": seen changed in Shopify.
        kind: m.source === "adjustment" ? "confirmed" : "observed",
        source: m.source,
        productId: m.productShopifyId,
        productTitle: m.productTitle,
        variantId: m.variantShopifyId,
        variantTitle: m.variantTitle,
        sku: m.sku,
        locationId: m.locationShopifyId,
        locationName: m.locationName,
        quantityName: m.quantityName,
        before: m.before,
        after: m.after,
        delta: m.delta,
        adjustment: a ? { id: a.id, kind: a.kind, reason: a.reason, note: a.note, referenceId: a.referenceId, by: a.actorUserId ? (actors.get(a.actorUserId) ?? "A former member") : null } : null,
      };
    }),
  };
}

/** The changes asked for in bizinsights, newest first, whatever Shopify answered (confirmed, refused, unconfirmed). */
export async function adjustmentList(tx: Tx, store: Pick<Store, "id" | "workspaceId">, page: number, pageSize: number) {
  const where = { workspaceId: store.workspaceId, storeId: store.id };
  const [rows, total] = await Promise.all([
    tx.inventoryAdjustment.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize }),
    tx.inventoryAdjustment.count({ where }),
  ]);
  const actors = await actorNames(tx, rows.map((r) => r.actorUserId));
  return {
    total,
    page,
    pageSize,
    rows: rows.map((a) => ({
      id: a.id,
      status: a.status,
      kind: a.kind,
      reason: a.reason,
      note: a.note,
      referenceId: a.referenceId,
      productId: a.productShopifyId,
      productTitle: a.productTitle,
      variantId: a.variantShopifyId,
      variantTitle: a.variantTitle,
      sku: a.sku,
      locationId: a.locationShopifyId,
      locationName: a.locationName,
      quantityName: a.quantityName,
      delta: a.delta,
      quantity: a.quantity,
      expectedBefore: a.expectedBefore,
      resultQuantity: a.resultQuantity,
      errorCode: a.errorCode,
      by: a.actorUserId ? (actors.get(a.actorUserId) ?? "A former member") : null,
      createdAt: a.createdAt,
      completedAt: a.completedAt,
    })),
  };
}

async function actorNames(tx: Tx, ids: ReadonlyArray<string | null>): Promise<Map<string, string>> {
  const list = [...new Set(ids.filter((x): x is string => !!x))];
  if (!list.length) return new Map();
  const users = await tx.$queryRaw<Array<{ id: string; name: string | null; email: string }>>`SELECT id, display_name AS name, email FROM users WHERE id = ANY(${list}::text[])`;
  return new Map(users.map((u) => [u.id, u.name || u.email]));
}

/** How far `timeZone`'s wall clock is ahead of UTC at `at`, in ms. */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  const wall = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return wall - Math.floor(at.getTime() / 1000) * 1000;
}

/** The UTC instant the store-local `day` starts at. */
export function dayStart(day: string, timeZone: string): Date {
  const guess = new Date(`${day}T00:00:00Z`);
  const first = new Date(guess.getTime() - zoneOffsetMs(guess, timeZone));
  // Once more at the instant found, in case a daylight-saving change lies between.
  return new Date(guess.getTime() - zoneOffsetMs(first, timeZone));
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export async function inventoryReports(tx: Tx, store: Pick<Store, "id" | "workspaceId" | "timezone">, scope: StockScope, range: DateRange, sales: SalesWindow, today: string, see: SeeOpts) {
  const s = { ws: store.workspaceId, storeId: store.id };
  const snapshots = await tx.inventorySnapshot.findMany({ where: { workspaceId: s.ws, storeId: s.storeId, locationKey: "all", day: { gte: range.from, lte: range.to } }, orderBy: { day: "asc" } });
  const byDay = new Map(snapshots.map((x) => [x.day, x]));
  const days = eachDay(range.from, range.to);
  const trend = days.map((day) => {
    const x = byDay.get(day);
    return {
      day,
      recorded: !!x,
      available: x?.available ?? null,
      onHand: x?.onHand ?? null,
      lowStock: x?.lowStock ?? null,
      outOfStock: x?.outOfStock ?? null,
      costValue: see.costs ? (x?.costValue ? Number(x.costValue) : null) : undefined,
      retailValue: see.costs ? (x ? Number(x.retailValue) : null) : undefined,
    };
  });

  // Stock movements seen per day (available units), by how they were seen.
  const moves = await tx.$queryRaw<Array<{ day: string; source: string; added: number; removed: number }>>`
    SELECT to_char((observed_at AT TIME ZONE 'UTC') AT TIME ZONE ${store.timezone}, 'YYYY-MM-DD') AS day, source,
           COALESCE(SUM(delta) FILTER (WHERE delta > 0), 0)::int AS added, COALESCE(-SUM(delta) FILTER (WHERE delta < 0), 0)::int AS removed
    FROM inventory_movements
    WHERE workspace_id = ${s.ws} AND store_id = ${s.storeId} AND quantity_name = 'available'
      AND observed_at >= ${dayStart(range.from, store.timezone)} AND observed_at < ${dayStart(addDays(range.to, 1), store.timezone)}
    GROUP BY 1, 2`;
  const movement = days.map((day) => {
    const m = moves.filter((x) => x.day === day);
    return {
      day,
      added: m.reduce((n, x) => n + x.added, 0),
      removed: m.reduce((n, x) => n + x.removed, 0),
      bizinsights: m.filter((x) => x.source === "adjustment").reduce((n, x) => n + x.added - x.removed, 0),
    };
  });

  // Product performance over the range.
  const rangeDays = daysBetweenInclusive(range.from, range.to);
  const perf = await tx.$queryRaw<Array<{ variant_id: string; product_id: string; product_title: string; variant_title: string; sku: string | null; units: number; revenue: string; on_hand: number | null; available: number | null; tracked: boolean; unit_cost: string | null }>>`
    WITH ${variantStockCte(scope)}, ${soldCte(scope, range.from, range.to)},
    rev AS (
      SELECT li.variant_shopify_id AS variant_id, SUM(li.price * li.quantity - li.discount)::text AS revenue
      FROM order_line_items li JOIN orders o ON o.id = li.order_id
      WHERE li.workspace_id = ${s.ws} AND li.store_id = ${s.storeId} AND o.workspace_id = ${s.ws} AND o.store_id = ${s.storeId}
        AND o.cancelled_at IS NULL AND o.local_day BETWEEN ${range.from} AND ${range.to} AND li.variant_shopify_id IS NOT NULL
      GROUP BY 1
    )
    SELECT vs.variant_id, vs.product_id, vs.product_title, vs.variant_title, vs.sku, COALESCE(sold.units, 0)::int AS units, COALESCE(rev.revenue, '0') AS revenue,
           vs.on_hand, vs.available, vs.tracked, vs.unit_cost
    FROM vs LEFT JOIN sold ON sold.variant_id = vs.variant_id LEFT JOIN rev ON rev.variant_id = vs.variant_id`;
  const rangeCovered = !!sales.historyFrom && sales.historyFrom <= range.from;
  const row = (r: (typeof perf)[number]) => {
    const onHand = r.on_hand ?? r.available ?? 0;
    return {
      variantId: r.variant_id,
      productId: r.product_id,
      productTitle: r.product_title,
      variantTitle: r.variant_title,
      sku: r.sku,
      units: r.units,
      // Money from sales goes with costs and stock value (inventory.costs).
      revenue: see.costs ? r2(Number(r.revenue)) : undefined,
      perDay: r2(r.units / rangeDays),
      sellThrough: r.tracked ? (() => {
        const st = sellThrough(r.units, onHand);
        return st === null ? null : r2(st * 100);
      })() : null,
      onHand: r.tracked ? onHand : null,
    };
  };
  const top = perf.filter((r) => r.units > 0).sort((a, b) => b.units - a.units).slice(0, 10).map(row);
  const slow = perf.filter((r) => r.tracked && (r.available ?? 0) > 0).sort((a, b) => a.units - b.units || (b.on_hand ?? b.available ?? 0) - (a.on_hand ?? a.available ?? 0)).slice(0, 10).map(row);
  const unitsTotal = perf.reduce((n, r) => n + r.units, 0);
  const onHandTotal = perf.filter((r) => r.tracked).reduce((n, r) => n + Math.max(0, r.on_hand ?? r.available ?? 0), 0);
  const overallSellThrough = sellThrough(unitsTotal, onHandTotal);

  // How often items sold out: available falling from above 0 to 0 or below, as seen.
  const stockouts = await tx.$queryRaw<Array<{ variant_id: string | null; product_title: string | null; variant_title: string | null; n: number }>>`
    SELECT variant_shopify_id AS variant_id, MAX(product_title) AS product_title, MAX(variant_title) AS variant_title, COUNT(*)::int AS n
    FROM inventory_movements
    WHERE workspace_id = ${s.ws} AND store_id = ${s.storeId} AND quantity_name = 'available' AND before > 0 AND after <= 0
      AND observed_at >= ${dayStart(range.from, store.timezone)} AND observed_at < ${dayStart(addDays(range.to, 1), store.timezone)}
    GROUP BY 1 ORDER BY 4 DESC LIMIT 10`;
  const turnoverResult = see.costs ? await turnover(tx, scope, range) : null;
  const locations = await locationsReport(tx, scope, see);

  return {
    range,
    trend,
    recordedDays: snapshots.length,
    movement,
    products: {
      top,
      slow,
      unitsSold: unitsTotal,
      perDay: r2(unitsTotal / rangeDays),
      sellThrough: overallSellThrough === null ? null : r2(overallSellThrough * 100),
      ordersCoverRange: rangeCovered,
    },
    turnover: turnoverResult ? { value: turnoverResult.value, note: turnoverResult.note ?? null, costOfUnitsSold: turnoverResult.cogs, averageStockValue: turnoverResult.averageValue } : null,
    stockouts: { total: stockouts.reduce((n, x) => n + x.n, 0), items: stockouts.map((x) => ({ variantId: x.variant_id, productTitle: x.product_title, variantTitle: x.variant_title, count: x.n })) },
    locations: locations.locations.map((l) => ({ id: l.id, name: l.name, active: l.active, available: l.stock?.available ?? null, onHand: l.stock?.onHand ?? null })),
    // Shopify's order lines as imported don't say which location fulfilled them.
    unitsByFulfillmentLocation: null,
  };
}

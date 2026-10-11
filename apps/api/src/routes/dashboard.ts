import { z } from "zod";
import { Prisma, toNumber, withTenant, type Tx } from "@app/db";
import {
  DATE_PRESETS,
  adSeries,
  adTotals,
  adsenseSeries,
  adsenseTotals,
  addDays,
  campaignTotals,
  siteTotals,
  eachDay,
  channelLabel,
  daysBetweenInclusive,
  delta,
  localDay,
  resolveCapabilities,
  resolvePreset,
  summarize,
  summarizeJourney,
  yearBreakdown,
  PURCHASED_STEP,
  SITE_SECTIONS,
  type AdDayRow,
  type AdsenseDayRow,
  type AdSpendProvider,
  type DailyMetricsRow,
  type DateRange,
  type JourneyPageRow,
  type SiteSection,
} from "@app/shared";
import { adsConfigured, declaredOptionalScopes, declaredScopes, logger, revocableScopes } from "@app/core";
import { HttpError, requireWorkspace, type Deps } from "../context.js";
import type { App } from "../app.js";
import { autoRefresh } from "../sync.js";

const querySchema = z.object({
  preset: z.enum(DATE_PRESETS).default("30d"),
  from: z.string().optional(),
  to: z.string().optional(),
});

/**
 * `revocableScopes` is computed with the same helper the revoke endpoint enforces with, rather
 * than being re-derived in the browser: the UI must not offer to give back a scope the API would
 * then refuse. It is empty in the shipped configuration, where nothing is declared optional.
 */
export function publicStore(s: {
  id: string;
  shopDomain: string;
  name: string | null;
  timezone: string;
  currency: string;
  status: string;
  grantedScopes: string[];
  pixelInstalled: boolean;
  lastSyncedAt: Date | null;
  installedAt: Date | null;
}) {
  return {
    id: s.id,
    shopDomain: s.shopDomain,
    name: s.name,
    timezone: s.timezone,
    currency: s.currency,
    status: s.status,
    grantedScopes: s.grantedScopes,
    revocableScopes: revocableScopes(s.grantedScopes, s.grantedScopes),
    pixelInstalled: s.pixelInstalled,
    lastSyncedAt: s.lastSyncedAt,
    installedAt: s.installedAt,
  };
}

/**
 * Why a store's sync stopped, in a word the dashboard can explain: Shopify's own answer to the
 * last failed job (packages/core/src/shopify.ts). 402 is a frozen, paused or closed store (an unpaid
 * Shopify bill, an ended trial), 404 a store Shopify can't find, 423 a locked one: reconnecting
 * fixes none of them. 401/403 or a missing token is lost access, which reconnecting does fix.
 */
export function syncProblem(error: string | null | undefined): "shop_unavailable" | "shop_gone" | "shop_locked" | "access" | "other" {
  if (!error) return "other";
  if (/^Shopify 402\b/.test(error)) return "shop_unavailable";
  if (/^Shopify 404\b/.test(error)) return "shop_gone";
  if (/^Shopify 423\b/.test(error)) return "shop_locked";
  if (/Shopify auth error|is not connected/.test(error)) return "access";
  return "other";
}

async function dailyRows(tx: Tx, workspaceId: string, storeId: string, r: DateRange): Promise<DailyMetricsRow[]> {
  const rows = await tx.dailyStoreMetrics.findMany({
    where: { workspaceId, storeId, day: { gte: r.from, lte: r.to } },
    orderBy: { day: "asc" },
  });
  return rows.map((x) => ({
    day: x.day,
    grossSales: toNumber(x.grossSales),
    discounts: toNumber(x.discounts),
    refunds: toNumber(x.refunds),
    orders: x.orders,
    units: x.units,
    ordersWithCustomer: x.ordersWithCustomer,
    returningCustomerOrders: x.returningCustomerOrders,
    refundedOrders: x.refundedOrders,
  }));
}

// ---------------------------------------------------------------------------
// Order/catalog modules. Every query filters on workspace_id AND store_id (RLS
// is the backstop, not the filter), uses bound parameters only, and excludes
// cancelled orders unless the module says otherwise. Money comes back from SQL
// as text (exact decimals) and is converted with Number at the edge.
// ---------------------------------------------------------------------------

/** Tenant + store being reported on. */
interface Scope {
  ws: string;
  storeId: string;
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const numOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/**
 * One point per day of the range. daily_store_metrics only has rows for days with orders or
 * refunds, so the quiet days are filled in as zeros: without them the chart drew "last 30 days"
 * as however many days happened to sell, ending on the last sale rather than on today.
 */
function dailySeries(rows: DailyMetricsRow[], r: DateRange) {
  const byDay = new Map(rows.map((x) => [x.day, x]));
  return eachDay(r.from, r.to).map((day) => {
    const x = byDay.get(day);
    if (!x) return { day, netSales: 0, orders: 0, refunds: 0, averageOrderValue: null };
    const beforeRefunds = r2(x.grossSales - x.discounts);
    return {
      day,
      netSales: r2(beforeRefunds - x.refunds),
      orders: x.orders,
      refunds: r2(x.refunds),
      averageOrderValue: x.orders > 0 ? r2(beforeRefunds / x.orders) : null,
    };
  });
}

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;

/** Fulfillment statuses that still need work from the merchant (normalized values, see persist). */
const OPEN_FULFILLMENT_STATUSES = [
  "unfulfilled",
  "partially_fulfilled",
  "on_hold",
  "in_progress",
  "open",
  "pending_fulfillment",
  "scheduled",
];

/** Stock rules for the inventory module. */
const VELOCITY_DAYS = 30;
const LOW_STOCK_UNITS = 5;
const LOW_COVER_DAYS = 14;

/** Index of the largest value, or null when everything is zero. First wins on ties. */
function argMax(values: number[]): number | null {
  let best: number | null = null;
  values.forEach((v, i) => {
    if (v > 0 && (best === null || v > values[best]!)) best = i;
  });
  return best;
}

async function taxAndShipping(tx: Tx, { ws, storeId }: Scope, r: DateRange) {
  const [row] = await tx.$queryRaw<Array<{ tax: string; shipping: string }>>`
    SELECT COALESCE(SUM(o.total_tax), 0)::text AS tax, COALESCE(SUM(o.total_shipping), 0)::text AS shipping
    FROM orders o
    WHERE o.workspace_id = ${ws} AND o.store_id = ${storeId}
      AND o.cancelled_at IS NULL AND o.local_day BETWEEN ${r.from} AND ${r.to}`;
  return { tax: num(row?.tax), shipping: num(row?.shipping) };
}

/** Sales by Shopify sales channel (order source_name). Sales = order subtotal (after discounts). */
async function channels(tx: Tx, { ws, storeId }: Scope, r: DateRange) {
  const rows = await tx.$queryRaw<Array<{ source: string | null; orders: number; sales: string }>>`
    SELECT NULLIF(TRIM(o.source_name), '') AS source, COUNT(*)::int AS orders, COALESCE(SUM(o.subtotal), 0)::text AS sales
    FROM orders o
    WHERE o.workspace_id = ${ws} AND o.store_id = ${storeId}
      AND o.cancelled_at IS NULL AND o.local_day BETWEEN ${r.from} AND ${r.to}
    GROUP BY 1
    ORDER BY SUM(o.subtotal) DESC, COUNT(*) DESC, 1 NULLS LAST`;
  // Several raw sources share one label (web/checkout_next, the two subscription sources, "Web"
  // vs "web"): merge them so each channel is one row. App ids stay separate (one row per app).
  const merged = new Map<string, { source: string | null; label: string; orders: number; sales: number; top: number }>();
  for (const x of rows) {
    const label = channelLabel(x.source);
    const key = x.source && /^\d+$/.test(x.source) ? `app:${x.source}` : label;
    const sales = num(x.sales);
    const m = merged.get(key);
    if (!m) merged.set(key, { source: x.source, label, orders: num(x.orders), sales, top: sales });
    else {
      m.orders += num(x.orders);
      m.sales = r2(m.sales + sales);
      // Report the raw source behind most of the channel's sales.
      if (sales > m.top) Object.assign(m, { source: x.source, top: sales });
    }
  }
  const items = [...merged.values()].sort((a, b) => b.sales - a.sales || b.orders - a.orders);
  const total = r2(items.reduce((a, x) => a + x.sales, 0));
  return {
    items: items.map((x) => ({
      source: x.source,
      label: x.label,
      orders: x.orders,
      sales: x.sales,
      share: total > 0 ? x.sales / total : null,
    })),
  };
}

/**
 * Orders by weekday and hour in the store's time zone. shopify_created_at is a
 * `timestamp` (no zone) holding UTC: `AT TIME ZONE 'UTC'` makes it a timestamptz,
 * the second `AT TIME ZONE <store tz>` turns that into store-local wall time
 * (DST-aware, per order).
 */
async function orderTiming(tx: Tx, { ws, storeId }: Scope, r: DateRange, timeZone: string) {
  const rows = await tx.$queryRaw<Array<{ dow: number; hour: number; orders: number }>>`
    SELECT EXTRACT(ISODOW FROM t.local_ts)::int AS dow, EXTRACT(HOUR FROM t.local_ts)::int AS hour, COUNT(*)::int AS orders
    FROM (
      SELECT (o.shopify_created_at AT TIME ZONE 'UTC') AT TIME ZONE ${timeZone}::text AS local_ts
      FROM orders o
      WHERE o.workspace_id = ${ws} AND o.store_id = ${storeId}
        AND o.cancelled_at IS NULL AND o.local_day BETWEEN ${r.from} AND ${r.to}
    ) t
    GROUP BY 1, 2`;
  const byWeekday = Array<number>(7).fill(0);
  const byHour = Array<number>(24).fill(0);
  for (const x of rows) {
    const dow = num(x.dow); // ISO: 1 = Monday … 7 = Sunday
    const hour = num(x.hour);
    byWeekday[dow - 1]! += num(x.orders);
    byHour[hour]! += num(x.orders);
  }
  const day = argMax(byWeekday);
  return { byWeekday, byHour, busiestDay: day === null ? null : WEEKDAYS[day]!, busiestHour: argMax(byHour) };
}

/**
 * Fulfillment for orders placed in the range, plus the all-time backlog of
 * orders that still need shipping. Ages are in store-local calendar days.
 */
async function fulfillment(tx: Tx, { ws, storeId }: Scope, r: DateRange, today: string) {
  const [cur] = await tx.$queryRaw<
    Array<{ orders: number; fulfilled: number; partially_fulfilled: number; unfulfilled: number; avg_hours: number | null }>
  >`
    SELECT COUNT(*)::int AS orders,
           COUNT(*) FILTER (WHERE o.fulfillment_status = 'fulfilled')::int AS fulfilled,
           COUNT(*) FILTER (WHERE o.fulfillment_status = 'partially_fulfilled')::int AS partially_fulfilled,
           COUNT(*) FILTER (WHERE o.fulfillment_status = 'unfulfilled')::int AS unfulfilled,
           (AVG(EXTRACT(EPOCH FROM (o.fulfilled_at - o.shopify_created_at)))
              FILTER (WHERE o.fulfilled_at IS NOT NULL AND o.fulfilled_at >= o.shopify_created_at) / 3600)::float8 AS avg_hours
    FROM orders o
    WHERE o.workspace_id = ${ws} AND o.store_id = ${storeId}
      AND o.cancelled_at IS NULL AND o.local_day BETWEEN ${r.from} AND ${r.to}`;
  const [open] = await tx.$queryRaw<Array<{ open_now: number; oldest_day: string | null }>>`
    SELECT COUNT(*)::int AS open_now, MIN(o.local_day) AS oldest_day
    FROM orders o
    WHERE o.workspace_id = ${ws} AND o.store_id = ${storeId}
      AND o.cancelled_at IS NULL AND o.fulfillment_status IN (${Prisma.join(OPEN_FULFILLMENT_STATUSES)})`;
  const avg = numOrNull(cur?.avg_hours);
  return {
    current: {
      orders: num(cur?.orders),
      fulfilled: num(cur?.fulfilled),
      partiallyFulfilled: num(cur?.partially_fulfilled),
      unfulfilled: num(cur?.unfulfilled),
      avgHoursToFulfill: avg === null ? null : r1(avg),
    },
    openNow: num(open?.open_now),
    oldestOpenDays: open?.oldest_day ? Math.max(0, daysBetweenInclusive(open.oldest_day, today) - 1) : null,
  };
}

/**
 * Most used discount codes. Codes are case-insensitive in Shopify, so usage is
 * grouped case-insensitively and shown with its most common spelling. An order
 * that used several codes counts toward each of them.
 */
async function discountCodes(tx: Tx, { ws, storeId }: Scope, r: DateRange) {
  const rows = await tx.$queryRaw<Array<{ code: string; orders: number; discount: string; sales: string }>>`
    SELECT mode() WITHIN GROUP (ORDER BY x.code) AS code, COUNT(*)::int AS orders,
           SUM(x.total_discounts)::text AS discount, SUM(x.subtotal)::text AS sales
    FROM (
      SELECT DISTINCT ON (o.id, LOWER(TRIM(c.code))) o.id, LOWER(TRIM(c.code)) AS code_key, TRIM(c.code) AS code,
             o.total_discounts, o.subtotal
      FROM orders o
      CROSS JOIN LATERAL unnest(o.discount_codes) AS c(code)
      WHERE o.workspace_id = ${ws} AND o.store_id = ${storeId}
        AND o.cancelled_at IS NULL AND o.local_day BETWEEN ${r.from} AND ${r.to}
        AND TRIM(c.code) <> ''
    ) x
    GROUP BY x.code_key
    ORDER BY COUNT(*) DESC, SUM(x.total_discounts) DESC, x.code_key
    LIMIT 10`;
  return { items: rows.map((x) => ({ code: x.code, orders: num(x.orders), discount: num(x.discount), sales: num(x.sales) })) };
}

/** Latest 10 orders regardless of range; cancelled ones are included and flagged. */
async function recentOrders(tx: Tx, { ws, storeId }: Scope) {
  const rows = await tx.$queryRaw<
    Array<{
      id: string;
      shopify_id: string;
      name: string;
      created_at: string;
      total: string;
      financial_status: string | null;
      fulfillment_status: string | null;
      source_name: string | null;
      cancelled: boolean;
      units: number;
    }>
  >`
    SELECT o.id, o.shopify_id, o.name,
           to_char(o.shopify_created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
           o.total_price::text AS total, o.financial_status, o.fulfillment_status, o.source_name,
           (o.cancelled_at IS NOT NULL) AS cancelled,
           COALESCE((
             SELECT SUM(li.quantity) FROM order_line_items li
             WHERE li.workspace_id = ${ws} AND li.store_id = ${storeId} AND li.order_id = o.id
           ), 0)::int AS units
    FROM orders o
    WHERE o.workspace_id = ${ws} AND o.store_id = ${storeId}
    ORDER BY o.shopify_created_at DESC, o.id DESC
    LIMIT 10`;
  return {
    items: rows.map((x) => ({
      id: x.id,
      shopifyId: x.shopify_id,
      name: x.name,
      createdAt: x.created_at,
      total: num(x.total),
      financialStatus: x.financial_status,
      fulfillmentStatus: x.fulfillment_status,
      channel: channelLabel(x.source_name),
      units: num(x.units),
      cancelled: Boolean(x.cancelled),
    })),
  };
}

/**
 * Stock on hand for tracked variants of non-archived products, with sales
 * velocity over the last VELOCITY_DAYS store-local days (today included).
 */
async function inventory(tx: Tx, { ws, storeId }: Scope, today: string) {
  const velocityFrom = addDays(today, -(VELOCITY_DAYS - 1));
  const stock = Prisma.sql`
    sold AS (
      SELECT li.variant_shopify_id, SUM(li.quantity) AS units
      FROM order_line_items li
      JOIN orders o ON o.id = li.order_id
      WHERE li.workspace_id = ${ws} AND li.store_id = ${storeId}
        AND o.workspace_id = ${ws} AND o.store_id = ${storeId}
        AND o.cancelled_at IS NULL AND o.local_day BETWEEN ${velocityFrom} AND ${today}
        AND li.variant_shopify_id IS NOT NULL
      GROUP BY li.variant_shopify_id
    ),
    stock AS (
      SELECT v.title AS variant_title, v.sku, v.inventory_quantity AS qty, v.price, v.unit_cost,
             p.title AS product_title,
             COALESCE(s.units, 0)::float8 / ${VELOCITY_DAYS}::float8 AS daily
      FROM product_variants v
      LEFT JOIN products p ON p.workspace_id = ${ws} AND p.store_id = ${storeId} AND p.shopify_id = v.product_shopify_id
      LEFT JOIN sold s ON s.variant_shopify_id = v.shopify_id
      WHERE v.workspace_id = ${ws} AND v.store_id = ${storeId}
        AND v.inventory_quantity IS NOT NULL
        AND (p.status IS NULL OR LOWER(p.status) <> 'archived')
    ),
    covered AS (
      SELECT *, CASE WHEN daily > 0 THEN qty / daily END AS cover,
             (qty > 0 AND (qty <= ${LOW_STOCK_UNITS}::int OR (daily > 0 AND qty / daily < ${LOW_COVER_DAYS}::float8))) AS low
      FROM stock
    )`;
  const [sum] = await tx.$queryRaw<
    Array<{ tracked: number; units: bigint; cost_value: string | null; with_cost: number; retail: string; out_of_stock: number; low_stock: number }>
  >`
    WITH ${stock}
    SELECT COUNT(*)::int AS tracked,
           COALESCE(SUM(GREATEST(qty, 0)), 0)::bigint AS units,
           SUM(GREATEST(qty, 0) * unit_cost)::text AS cost_value,
           COUNT(unit_cost)::int AS with_cost,
           COALESCE(SUM(GREATEST(qty, 0) * price), 0)::text AS retail,
           COUNT(*) FILTER (WHERE qty <= 0)::int AS out_of_stock,
           COUNT(*) FILTER (WHERE low)::int AS low_stock
    FROM covered`;
  const low = await tx.$queryRaw<
    Array<{ product_title: string | null; variant_title: string; sku: string | null; qty: number; daily: number; cover: number | null }>
  >`
    WITH ${stock}
    SELECT product_title, variant_title, sku, qty, daily, cover
    FROM covered
    WHERE low
    ORDER BY cover ASC NULLS LAST, qty ASC, product_title, variant_title
    LIMIT 10`;
  return {
    current: {
      trackedVariants: num(sum?.tracked),
      unitsInStock: num(sum?.units),
      stockValueAtCost: sum?.with_cost ? numOrNull(sum.cost_value) : null,
      variantsWithCost: num(sum?.with_cost),
      retailValue: num(sum?.retail),
      outOfStock: num(sum?.out_of_stock),
      lowStock: num(sum?.low_stock),
    },
    lowStockItems: low.map((x) => ({
      productTitle: x.product_title ?? "Unknown product",
      variantTitle: x.variant_title,
      sku: x.sku,
      quantity: num(x.qty),
      dailySales: r2(num(x.daily)),
      daysOfCover: x.cover === null ? null : r1(num(x.cover)),
    })),
  };
}

/** Products by status and the vendors whose products sold best in the range. */
async function catalog(tx: Tx, { ws, storeId }: Scope, r: DateRange) {
  const [counts] = await tx.$queryRaw<Array<{ active: number; draft: number; archived: number; total: number; variants: number }>>`
    SELECT COUNT(*) FILTER (WHERE LOWER(p.status) IN ('active', 'unlisted'))::int AS active,
           COUNT(*) FILTER (WHERE LOWER(p.status) = 'draft')::int AS draft,
           COUNT(*) FILTER (WHERE LOWER(p.status) = 'archived')::int AS archived,
           COUNT(*)::int AS total,
           (SELECT COUNT(*) FROM product_variants v WHERE v.workspace_id = ${ws} AND v.store_id = ${storeId})::int AS variants
    FROM products p
    WHERE p.workspace_id = ${ws} AND p.store_id = ${storeId}`;
  const vendors = await tx.$queryRaw<Array<{ vendor: string; revenue: string; units: bigint }>>`
    SELECT TRIM(p.vendor) AS vendor, SUM(li.price * li.quantity - li.discount)::text AS revenue, SUM(li.quantity)::bigint AS units
    FROM order_line_items li
    JOIN orders o ON o.id = li.order_id
    JOIN products p ON p.workspace_id = ${ws} AND p.store_id = ${storeId} AND p.shopify_id = li.product_shopify_id
    WHERE li.workspace_id = ${ws} AND li.store_id = ${storeId}
      AND o.workspace_id = ${ws} AND o.store_id = ${storeId}
      AND o.cancelled_at IS NULL AND o.local_day BETWEEN ${r.from} AND ${r.to}
      AND p.vendor IS NOT NULL AND TRIM(p.vendor) <> ''
    GROUP BY TRIM(p.vendor)
    ORDER BY SUM(li.price * li.quantity - li.discount) DESC, TRIM(p.vendor)
    LIMIT 5`;
  return {
    products: { active: num(counts?.active), draft: num(counts?.draft), archived: num(counts?.archived), total: num(counts?.total) },
    variants: num(counts?.variants),
    topVendors: vendors.map((x) => ({ vendor: x.vendor, revenue: num(x.revenue), units: num(x.units) })),
  };
}

/** What has been imported so far (all time, cancelled orders included). Not a module: always present. */
async function importedData(tx: Tx, { ws, storeId }: Scope) {
  const [row] = await tx.$queryRaw<Array<{ orders: number; oldest_day: string | null; newest_day: string | null; products: number; variants: number }>>`
    SELECT o.orders, o.oldest_day, o.newest_day,
           (SELECT COUNT(*) FROM products p WHERE p.workspace_id = ${ws} AND p.store_id = ${storeId})::int AS products,
           (SELECT COUNT(*) FROM product_variants v WHERE v.workspace_id = ${ws} AND v.store_id = ${storeId})::int AS variants
    FROM (
      SELECT COUNT(*)::int AS orders, MIN(local_day) AS oldest_day, MAX(local_day) AS newest_day
      FROM orders
      WHERE workspace_id = ${ws} AND store_id = ${storeId}
    ) o`;
  return {
    orders: num(row?.orders),
    products: num(row?.products),
    variants: num(row?.variants),
    oldestOrderDay: row?.oldest_day ?? null,
    newestOrderDay: row?.newest_day ?? null,
  };
}

// ---------------------------------------------------------------------------
// Ad platforms (Meta Ads, Google Ads), connected on Settings → Ad accounts.
// ---------------------------------------------------------------------------

/**
 * What the store's connected ad accounts report for these dates. Only accounts in one currency
 * are added up (the store's, when any account uses it): adding dollars to euros means nothing.
 * Accounts in other currencies are listed as left out. The platforms' days are their own
 * accounts' calendar days, which match the store's when the time zones do.
 */
async function adsModule(tx: Tx, { ws, storeId }: Scope, range: DateRange, previous: DateRange, storeCurrency: string, netSales: number | null) {
  const conns = await tx.adConnection.findMany({
    // Spend only: AdSense accounts earn money for the store and have their own module below.
    where: { workspaceId: ws, storeId, enabled: true, provider: { in: ["meta", "google"] } },
    select: { id: true, provider: true, accountId: true, accountName: true, currency: true, status: true, lastSyncedAt: true, lastError: true },
    orderBy: [{ provider: "asc" }, { createdAt: "asc" }],
  });
  if (!conns.length) return null;
  const currency = conns.some((c) => c.currency === storeCurrency) ? storeCurrency : (conns.find((c) => c.currency)?.currency ?? storeCurrency);
  const counted = conns.filter((c) => (c.currency ?? currency) === currency);
  const raw = await tx.adCampaignDaily.findMany({
    where: { workspaceId: ws, storeId, connectionId: { in: counted.map((c) => c.id) }, day: { gte: previous.from, lte: range.to } },
  });
  const rows: AdDayRow[] = raw.map((r) => ({
    provider: r.provider as AdSpendProvider,
    accountId: r.accountId,
    campaignId: r.campaignId,
    campaignName: r.campaignName,
    day: r.day,
    spend: toNumber(r.spend),
    impressions: r.impressions,
    clicks: r.clicks,
    conversions: toNumber(r.conversions),
    conversionValue: toNumber(r.conversionValue),
    leads: r.leads,
  }));
  const inRange = (d: DateRange) => rows.filter((r) => r.day >= d.from && r.day <= d.to);
  const cur = inRange(range);
  const prev = inRange(previous);
  const current = adTotals(cur);
  const before = adTotals(prev);
  const providers = [...new Set(counted.map((c) => c.provider as AdSpendProvider))];
  return {
    currency,
    accounts: conns.map((c) => ({
      id: c.id,
      provider: c.provider,
      accountId: c.accountId,
      name: c.accountName,
      currency: c.currency,
      status: c.status,
      lastSyncedAt: c.lastSyncedAt,
      counted: counted.some((x) => x.id === c.id),
    })),
    current,
    previous: { spend: before.spend, clicks: before.clicks, conversions: before.conversions, conversionValue: before.conversionValue, roas: before.roas },
    deltas: {
      spend: delta(current.spend, before.spend),
      clicks: delta(current.clicks, before.clicks),
      conversions: delta(current.conversions, before.conversions),
      roas: delta(current.roas, before.roas),
    },
    series: adSeries(cur, range),
    byProvider: providers.map((p) => ({ provider: p, ...adTotals(cur.filter((r) => r.provider === p)) })),
    /** Each platform's own days, for comparing platforms on the main page. */
    seriesByProvider: providers.map((p) => ({ provider: p, series: adSeries(cur.filter((r) => r.provider === p), range) })),
    campaigns: campaignTotals(cur, 10),
    /** Ad spend as a share of the store's net sales, when both are in the same currency. */
    shareOfSales: currency === storeCurrency && netSales !== null && netSales > 0 ? current.spend / netSales : null,
  };
}

/**
 * What the store's connected AdSense accounts earned from ads shown on its site, for these dates.
 * Money the other way from adsModule: never added to ad spend. One currency only, chosen as for
 * ads; AdSense says an account's currency in its reports, so it's known after the first sync.
 */
async function adsenseModule(tx: Tx, { ws, storeId }: Scope, range: DateRange, previous: DateRange, storeCurrency: string, netSales: number | null) {
  const conns = await tx.adConnection.findMany({
    where: { workspaceId: ws, storeId, enabled: true, provider: "adsense" },
    select: { id: true, accountId: true, accountName: true, currency: true, status: true, lastSyncedAt: true },
    orderBy: { createdAt: "asc" },
  });
  if (!conns.length) return null;
  const currency = conns.some((c) => c.currency === storeCurrency) ? storeCurrency : (conns.find((c) => c.currency)?.currency ?? storeCurrency);
  const counted = conns.filter((c) => (c.currency ?? currency) === currency);
  const raw = await tx.adsenseDaily.findMany({
    where: { workspaceId: ws, storeId, connectionId: { in: counted.map((c) => c.id) }, day: { gte: previous.from, lte: range.to } },
  });
  const rows: AdsenseDayRow[] = raw.map((r) => ({
    accountId: r.accountId,
    site: r.site,
    day: r.day,
    earnings: toNumber(r.earnings),
    pageViews: r.pageViews,
    impressions: r.impressions,
    clicks: r.clicks,
  }));
  const inRange = (d: DateRange) => rows.filter((r) => r.day >= d.from && r.day <= d.to);
  const cur = inRange(range);
  const current = adsenseTotals(cur);
  const before = adsenseTotals(inRange(previous));
  return {
    currency,
    accounts: conns.map((c) => ({
      id: c.id,
      provider: "adsense" as const,
      accountId: c.accountId,
      name: c.accountName,
      currency: c.currency,
      status: c.status,
      lastSyncedAt: c.lastSyncedAt,
      counted: counted.some((x) => x.id === c.id),
    })),
    current,
    previous: { earnings: before.earnings, pageViews: before.pageViews, clicks: before.clicks, pageRpm: before.pageRpm },
    deltas: {
      earnings: delta(current.earnings, before.earnings),
      pageViews: delta(current.pageViews, before.pageViews),
      clicks: delta(current.clicks, before.clicks),
      pageRpm: delta(current.pageRpm, before.pageRpm),
    },
    series: adsenseSeries(cur, range),
    sites: siteTotals(cur, 10),
    /** Ad earnings next to the store's own net sales, when both are in the same currency. */
    vsSales: currency === storeCurrency && netSales !== null && netSales > 0 ? current.earnings / netSales : null,
  };
}

// ---------------------------------------------------------------------------
// Storefront funnel (web pixel). One row per shopper per store-local day in
// funnel_visits; see packages/shared/src/journey.ts for what each column means.
// ---------------------------------------------------------------------------

const TOP_PAGES = 8;
const isSection = (s: string | null): s is SiteSection => s !== null && (SITE_SECTIONS as readonly string[]).includes(s);

async function funnel(tx: Tx, { ws, storeId }: Scope, range: DateRange, previous: DateRange) {
  const inRange = (r: DateRange) => Prisma.sql`workspace_id = ${ws} AND store_id = ${storeId} AND day BETWEEN ${r.from} AND ${r.to}`;

  // How far each visit got, and where the ones that stopped short were last seen.
  const stepRows = await tx.$queryRaw<Array<{ furthest_step: number; exit_section: string | null; visits: number; page_views: number }>>`
    SELECT furthest_step, exit_section, COUNT(*)::int AS visits, SUM(page_views)::int AS page_views
    FROM funnel_visits WHERE ${inRange(range)}
    GROUP BY furthest_step, exit_section`;

  // Visits per site section (bit i of `sections`), and where visits landed.
  const sectionRows = await tx.$queryRaw<Array<{ kind: "visit" | "entry"; section: string | null; n: number }>>`
    SELECT 'visit' AS kind, (${[...SITE_SECTIONS]}::text[])[b.i + 1] AS section, COUNT(*)::int AS n
    FROM funnel_visits v CROSS JOIN generate_series(0, ${SITE_SECTIONS.length - 1}::int) AS b(i)
    WHERE ${inRange(range)} AND v.sections & (1 << b.i) <> 0
    GROUP BY b.i
    UNION ALL
    SELECT 'entry', entry_section, COUNT(*)::int FROM funnel_visits WHERE ${inRange(range)} AND entry_section IS NOT NULL
    GROUP BY entry_section`;

  // Top landing pages (with how many of those visits bought) and top pages people left from without buying.
  const pageRows = await tx.$queryRaw<Array<{ kind: "entry" | "exit"; path: string; section: string; visits: number; purchases: number }>>`
    (SELECT 'entry' AS kind, entry_path AS path, MIN(entry_section) AS section, COUNT(*)::int AS visits,
            COUNT(*) FILTER (WHERE furthest_step = ${PURCHASED_STEP})::int AS purchases
     FROM funnel_visits WHERE ${inRange(range)} AND entry_path IS NOT NULL
     GROUP BY entry_path ORDER BY COUNT(*) DESC, entry_path LIMIT ${TOP_PAGES})
    UNION ALL
    (SELECT 'exit', exit_path, MIN(exit_section), COUNT(*)::int, 0
     FROM funnel_visits WHERE ${inRange(range)} AND exit_path IS NOT NULL AND furthest_step < ${PURCHASED_STEP}
     GROUP BY exit_path ORDER BY COUNT(*) DESC, exit_path LIMIT ${TOP_PAGES})`;

  const [prev] = await tx.$queryRaw<Array<{ visits: number; purchases: number }>>`
    SELECT COUNT(*)::int AS visits, COUNT(*) FILTER (WHERE furthest_step = ${PURCHASED_STEP})::int AS purchases
    FROM funnel_visits WHERE ${inRange(previous)}`;

  const sections = new Map<SiteSection, { section: SiteSection; visits: number; entries: number }>();
  for (const r of sectionRows) {
    if (!isSection(r.section)) continue;
    const row = sections.get(r.section) ?? { section: r.section, visits: 0, entries: 0 };
    if (r.kind === "visit") row.visits += r.n;
    else row.entries += r.n;
    sections.set(r.section, row);
  }
  const summary = summarizeJourney(
    stepRows.map((r) => ({ furthestStep: r.furthest_step, exitSection: isSection(r.exit_section) ? r.exit_section : null, visits: r.visits, pageViews: r.page_views })),
    [...sections.values()],
  );
  const pages = (kind: "entry" | "exit"): JourneyPageRow[] =>
    pageRows
      .filter((r) => r.kind === kind)
      .map((r) => ({ path: r.path, section: isSection(r.section) ? r.section : "other", visits: r.visits, purchases: r.purchases }));

  const prevVisits = prev?.visits ?? 0;
  const prevConversion = prevVisits > 0 ? (prev?.purchases ?? 0) / prevVisits : null;
  return {
    ...summary,
    entryPages: pages("entry"),
    exitPages: pages("exit"),
    previous: { visits: prevVisits, conversionRate: prevConversion },
    deltas: { visits: delta(summary.visits, prevVisits), conversionRate: delta(summary.conversionRate, prevConversion) },
  };
}

export function dashboardRoutes(app: App, deps: Deps) {
  app.get("/workspaces/:ws/stores", async (c) => {
    const { ws } = c.req.param();
    await requireWorkspace(c, deps, ws, "dashboard:read");
    // `imported` is what lets the settings card tell "connected and holding your data" apart from
    // "connected and holding nothing", which look identical from scopes and lastSyncedAt alone.
    // Two grouped queries for the whole workspace, not one pair per store.
    const { stores, orders, products } = await withTenant(ws, async (tx) => ({
      stores: await tx.store.findMany({ where: { workspaceId: ws, status: { not: "uninstalled" } }, orderBy: { createdAt: "asc" } }),
      orders: await tx.order.groupBy({ by: ["storeId"], where: { workspaceId: ws }, _count: { _all: true } }),
      products: await tx.product.groupBy({ by: ["storeId"], where: { workspaceId: ws }, _count: { _all: true } }),
    }));
    const countBy = (rows: Array<{ storeId: string; _count: { _all: number } }>) =>
      new Map(rows.map((r) => [r.storeId, r._count._all]));
    const orderCount = countBy(orders);
    const productCount = countBy(products);
    return c.json({
      stores: stores.map((s) => ({
        ...publicStore(s),
        imported: { orders: orderCount.get(s.id) ?? 0, products: productCount.get(s.id) ?? 0 },
      })),
    });
  });

  app.get("/workspaces/:ws/stores/:storeId/sync", async (c) => {
    const { ws, storeId } = c.req.param();
    await requireWorkspace(c, deps, ws, "dashboard:read");
    return c.json(await withTenant(ws, async (tx) => {
      const store = await tx.store.findFirst({ where: { id: storeId, workspaceId: ws } });
      if (!store) throw new HttpError(404, "Not found", "not_found");
      const jobs = await tx.syncJob.findMany({ where: { storeId, workspaceId: ws }, orderBy: { createdAt: "desc" }, take: 20 });
      return {
        store: publicStore(store),
        jobs: jobs.map((j) => ({ id: j.id, kind: j.kind, status: j.status, progress: j.progress, error: j.error, finishedAt: j.finishedAt })),
      };
    }));
  });

  /**
   * One call returns everything the dashboard needs. Modules are included ONLY
   * when the store's granted scopes enable them; disabled modules come back with
   * the missing scopes so the UI can explain, never with placeholder numbers.
   */
  app.get("/workspaces/:ws/stores/:storeId/overview", async (c) => {
    const { ws, storeId } = c.req.param();
    await requireWorkspace(c, deps, ws, "dashboard:read");
    const q = querySchema.parse(c.req.query());

    let polled: Parameters<typeof autoRefresh>[1] | null = null;
    const body = await withTenant(ws, async (tx) => {
      const store = await tx.store.findFirst({ where: { id: storeId, workspaceId: ws } });
      if (!store) throw new HttpError(404, "Not found", "not_found");
      polled = store;
      const now = new Date();
      let resolved;
      try {
        resolved = resolvePreset(q.preset, now, store.timezone, q.from && q.to ? { from: q.from, to: q.to } : undefined);
      } catch (e) {
        throw new HttpError(400, (e as Error).message, "invalid_range");
      }
      const { range, previous } = resolved;
      // "Today" in the store's zone, for all-time ages and the trailing stock-velocity window.
      const today = localDay(now, store.timezone);
      const scope: Scope = { ws, storeId: store.id };
      // The deployed scope lists let the web app tell apart the three reasons a module is locked:
      // reconnect the store, ask the merchant (POST .../scopes/request), or wait on Shopify. It
      // must never offer an action that cannot work — see routes/scopes.ts.
      const capabilities = resolveCapabilities(store.grantedScopes, {
        pixelInstalled: store.pixelInstalled,
        optionalScopes: declaredOptionalScopes(),
        declaredScopes: declaredScopes(),
      });
      const enabled = new Set(capabilities.filter((c) => c.enabled).map((c) => c.id));
      const modules: Record<string, unknown> = {};
      const data = await importedData(tx, scope);

      let hasData = false;
      if (enabled.has("sales_overview") || enabled.has("refunds") || enabled.has("customers")) {
        const [cur, prev] = await Promise.all([dailyRows(tx, ws, storeId, range), dailyRows(tx, ws, storeId, previous)]);
        const c = summarize(cur);
        const p = summarize(prev);
        hasData = cur.some((r) => r.orders > 0 || r.refunds > 0);
        if (enabled.has("sales_overview")) {
          const { tax, shipping } = await taxAndShipping(tx, scope, range);
          modules.sales_overview = {
            current: {
              grossSales: c.grossSales,
              discounts: c.discounts,
              netSales: c.netSales,
              orders: c.orders,
              units: c.units,
              averageOrderValue: c.averageOrderValue,
              tax,
              shipping,
            },
            previous: { grossSales: p.grossSales, netSales: p.netSales, orders: p.orders, averageOrderValue: p.averageOrderValue },
            deltas: {
              netSales: delta(c.netSales, p.netSales),
              orders: delta(c.orders, p.orders),
              averageOrderValue: delta(c.averageOrderValue, p.averageOrderValue),
              grossSales: delta(c.grossSales, p.grossSales),
            },
            series: dailySeries(cur, range),
            // This calendar year month by month, whatever the dates picked. Reaches back to the
            // December before so January has something to compare with.
            year: yearBreakdown(
              await dailyRows(tx, ws, storeId, { from: `${Number(today.slice(0, 4)) - 1}-12-01`, to: today }),
              today,
              data.oldestOrderDay,
            ),
          };
        }
        if (enabled.has("refunds")) {
          modules.refunds = {
            current: { refunds: c.refunds, refundRate: c.refundRate, refundedOrders: cur.reduce((a, r) => a + r.refundedOrders, 0) },
            deltas: { refunds: delta(c.refunds, p.refunds) },
          };
        }
        if (enabled.has("customers")) {
          modules.customers = {
            current: { returningCustomerRate: c.returningCustomerRate },
            previous: { returningCustomerRate: p.returningCustomerRate },
          };
        }
      }

      if (enabled.has("top_products")) {
        const top = await tx.$queryRaw<Array<{ product_shopify_id: string | null; title: string; revenue: string; units: bigint }>>`
          SELECT li.product_shopify_id, COALESCE(MAX(p.title), MAX(li.title)) AS title,
                 SUM(li.price * li.quantity - li.discount)::text AS revenue, SUM(li.quantity) AS units
          FROM order_line_items li
          JOIN orders o ON o.id = li.order_id
          LEFT JOIN products p ON p.store_id = li.store_id AND p.shopify_id = li.product_shopify_id
          WHERE li.workspace_id = ${ws} AND li.store_id = ${storeId}
            AND o.cancelled_at IS NULL AND o.local_day BETWEEN ${range.from} AND ${range.to}
          GROUP BY li.product_shopify_id
          ORDER BY SUM(li.price * li.quantity - li.discount) DESC
          LIMIT 5`;
        modules.top_products = {
          items: top.map((t) => ({ productId: t.product_shopify_id, title: t.title, revenue: Number(t.revenue), units: Number(t.units) })),
        };
      }

      if (enabled.has("funnel")) modules.funnel = await funnel(tx, scope, range, previous);

      // Not a Shopify capability: present once an ad account is connected to the store.
      const netSales = (modules.sales_overview as { current?: { netSales?: number } } | undefined)?.current?.netSales ?? null;
      const ads = await adsModule(tx, scope, range, previous, store.currency, netSales);
      if (ads) modules.ads = ads;
      const adsense = await adsenseModule(tx, scope, range, previous, store.currency, netSales);
      if (adsense) modules.adsense = adsense;
      // Which platforms are connected at all, hidden accounts included: the Advertising section
      // offers the ones that aren't, and says so when every account is hidden. Counts only, and
      // only for a store with ad accounts (absent means none).
      const adCounts = await tx.adConnection.groupBy({ by: ["provider", "enabled"], where: { workspaceId: ws, storeId: store.id }, _count: { _all: true } });
      const connected = { meta: 0, google: 0, adsense: 0, hidden: 0 };
      for (const g of adCounts) {
        if (g.provider === "meta" || g.provider === "google" || g.provider === "adsense") connected[g.provider] += g._count._all;
        if (!g.enabled) connected.hidden += g._count._all;
      }
      if (adCounts.length) modules.ad_connections = connected;
      // Which platforms this server can connect at all: the dashboard only offers those.
      const configured = adsConfigured();
      if (configured.meta || configured.google || configured.adsense) modules.ad_configured = configured;

      if (enabled.has("channels")) modules.channels = await channels(tx, scope, range);
      if (enabled.has("order_timing")) modules.order_timing = await orderTiming(tx, scope, range, store.timezone);
      if (enabled.has("fulfillment")) modules.fulfillment = await fulfillment(tx, scope, range, today);
      if (enabled.has("discount_codes")) modules.discount_codes = await discountCodes(tx, scope, range);
      if (enabled.has("recent_orders")) modules.recent_orders = await recentOrders(tx, scope);
      if (enabled.has("inventory")) modules.inventory = await inventory(tx, scope, today);
      if (enabled.has("catalog")) modules.catalog = await catalog(tx, scope, range);

      const failed = store.status === "error" ? await tx.syncJob.findFirst({ where: { storeId, workspaceId: ws, status: "failed" }, orderBy: { createdAt: "desc" }, select: { error: true } }) : null;
      return {
        store: publicStore(store),
        // Only while the store is in error: why, so the page can say what will fix it.
        syncProblem: store.status === "error" ? syncProblem(failed?.error) : null,
        range,
        previous,
        // The store's today, so the page can tell a finished day from one still running.
        today,
        capabilities,
        modules,
        hasData,
        data,
      };
    });
    // The dashboard polls this every 15 s: use that to keep the store fresh from Shopify.
    if (polled) {
      await autoRefresh(deps, polled).catch((err) => logger.warn({ err, storeId }, "auto refresh failed"));
    }
    return c.json(body);
  });
}

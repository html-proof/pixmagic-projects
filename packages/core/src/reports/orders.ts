import { Prisma, type Tx } from "@app/db";
import { channelLabel, daysBetweenInclusive, TRAFFIC_LABEL, TRAFFIC_SOURCES, type DateRange, type TrafficSource } from "@app/shared";
import { argMax, num, numOrNull, r1, r2, type Scope } from "./common.js";

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

/** Sales by Shopify sales channel (order source_name). Sales = order subtotal (after discounts). */
export async function channels(tx: Tx, { ws, storeId }: Scope, r: DateRange) {
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
 * Where this period's sales came from, by the visit that led to each order (Shopify's own record:
 * packages/shared/src/traffic.ts), with the same money as sales by channel (after discounts,
 * before tax and shipping). Other websites are listed by host. Orders stored before sources were
 * recorded are counted as `pending` (the dashboard's refresh re-reads them).
 */
export async function traffic(tx: Tx, { ws, storeId }: Scope, r: DateRange) {
  const rows = await tx.$queryRaw<Array<{ source: string | null; medium: string | null; host: string | null; campaign: string | null; orders: number; sales: string }>>`
    SELECT o.traffic_source AS source, o.traffic_medium AS medium, o.referrer_host AS host, o.traffic_campaign AS campaign,
           COUNT(*)::int AS orders, COALESCE(SUM(o.subtotal), 0)::text AS sales
    FROM orders o
    WHERE o.workspace_id = ${ws} AND o.store_id = ${storeId}
      AND o.cancelled_at IS NULL AND o.local_day BETWEEN ${r.from} AND ${r.to}
    GROUP BY 1, 2, 3, 4`;
  type Item = { key: string; source: string; label: string; orders: number; sales: number; paidOrders: number; paidSales: number };
  const items = new Map<string, Item>();
  const campaigns = new Map<string, { source: string; label: string; campaign: string; orders: number; sales: number }>();
  let pending = 0;
  for (const x of rows) {
    const orders = num(x.orders);
    const sales = num(x.sales);
    if (!x.source) {
      pending += orders;
      continue;
    }
    const source = (TRAFFIC_SOURCES as readonly string[]).includes(x.source) ? (x.source as TrafficSource) : "other";
    const key = source === "other" && x.host ? `site:${x.host}` : source;
    const label = source === "other" && x.host ? x.host : TRAFFIC_LABEL[source];
    const it = items.get(key) ?? { key, source, label, orders: 0, sales: 0, paidOrders: 0, paidSales: 0 };
    it.orders += orders;
    it.sales = r2(it.sales + sales);
    if (x.medium === "paid") {
      it.paidOrders += orders;
      it.paidSales = r2(it.paidSales + sales);
    }
    items.set(key, it);
    if (x.campaign) {
      const ck = `${source}:${x.campaign}`;
      const c = campaigns.get(ck) ?? { source, label: TRAFFIC_LABEL[source], campaign: x.campaign, orders: 0, sales: 0 };
      c.orders += orders;
      c.sales = r2(c.sales + sales);
      campaigns.set(ck, c);
    }
  }
  const list = [...items.values()].sort((a, b) => b.sales - a.sales || b.orders - a.orders);
  const total = r2(list.reduce((a, x) => a + x.sales, 0));
  const paid = list.reduce((a, x) => ({ orders: a.orders + x.paidOrders, sales: r2(a.sales + x.paidSales) }), { orders: 0, sales: 0 });
  return {
    items: list.map(({ key, ...x }) => ({ ...x, id: key, share: total > 0 ? x.sales / total : null })),
    paid: { ...paid, share: total > 0 ? paid.sales / total : null },
    campaigns: [...campaigns.values()].sort((a, b) => b.sales - a.sales || b.orders - a.orders).slice(0, 10),
    /** Orders in these dates whose source hasn't been read yet. */
    pending,
  };
}

/**
 * Orders by weekday and hour in the store's time zone. shopify_created_at is a
 * `timestamp` (no zone) holding UTC: `AT TIME ZONE 'UTC'` makes it a timestamptz,
 * the second `AT TIME ZONE <store tz>` turns that into store-local wall time
 * (DST-aware, per order).
 */
export async function orderTiming(tx: Tx, { ws, storeId }: Scope, r: DateRange, timeZone: string) {
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
export async function fulfillment(tx: Tx, { ws, storeId }: Scope, r: DateRange, today: string) {
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
export async function discountCodes(tx: Tx, { ws, storeId }: Scope, r: DateRange) {
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
export async function recentOrders(tx: Tx, { ws, storeId }: Scope) {
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

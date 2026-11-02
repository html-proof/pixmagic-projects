import { Prisma, type Tx } from "@app/db";
import {
  adsFromShopify,
  PLATFORM_SOURCES,
  visitsCounted,
  type AdSourceFacts,
  type AdSpendProvider,
  type Comparison,
  type DateRange,
  type SourcedDay,
  type SourcedSales,
  type SourcedVisits,
} from "@app/shared";
import type { AdsFigures } from "./ads.js";
import { localMoment, MERCHANDISE, num, SALE_VALUE, type Scope } from "./common.js";

// ---------------------------------------------------------------------------
// Meta Ads and Google Ads from the store's own orders (packages/shared/src/adsFromShopify.ts): what
// the Advertising pages show for a platform with no ad account connected. Read from the orders and
// sales Shopify already sent (read_orders): nothing to connect, kept current by the store's own sync.
// ---------------------------------------------------------------------------

/**
 * Each order's net sales from the sales in `r`, for the orders placed in `r` or with sales in it, by
 * the order's visit (source, medium, the link's campaign), as the traffic module counts them
 * (salesByOrder in orders.ts). `until`: the dates compared with a running day, cut at the same time of
 * day on their last day (Shopify's like-for-like): no order placed, and no sale made, after it.
 */
async function bySource(tx: Tx, { ws, storeId }: Scope, r: DateRange, until: Prisma.Sql | null): Promise<SourcedSales[]> {
  const rows = await tx.$queryRaw<Array<{ source: string | null; medium: string | null; campaign: string | null; orders: number; sales: string }>>`
    SELECT o.traffic_source AS source, o.traffic_medium AS medium, o.traffic_campaign AS campaign,
           (COUNT(*) FILTER (WHERE o.local_day BETWEEN ${r.from} AND ${r.to} AND NOT o.gift_card_only
              ${until ? Prisma.sql`AND COALESCE(o.shopify_processed_at, o.shopify_created_at) < ${until}` : Prisma.empty}))::int AS orders,
           COALESCE(SUM(v.sales), 0)::text AS sales
    FROM orders o
    LEFT JOIN (
      SELECT s.order_id, SUM(${SALE_VALUE}) AS sales
      FROM order_sales s
      WHERE s.workspace_id = ${ws} AND s.store_id = ${storeId} AND ${MERCHANDISE} AND s.local_day BETWEEN ${r.from} AND ${r.to}
        ${until ? Prisma.sql`AND s.happened_at < ${until}` : Prisma.empty}
      GROUP BY s.order_id
    ) v ON v.order_id = o.id
    WHERE o.workspace_id = ${ws} AND o.store_id = ${storeId}
      AND (o.local_day BETWEEN ${r.from} AND ${r.to} OR v.order_id IS NOT NULL)
    GROUP BY 1, 2, 3`;
  return rows.map((x) => ({ source: x.source, medium: x.medium, campaign: x.campaign, orders: num(x.orders), sales: num(x.sales) }));
}

/** The platforms' sources day by day: the orders placed each day, and the net sales made each day. */
async function byDay(tx: Tx, { ws, storeId }: Scope, r: DateRange, sources: readonly string[]): Promise<SourcedDay[]> {
  const rows = await tx.$queryRaw<Array<{ day: string; source: string; medium: string | null; orders: number; sales: string }>>`
    SELECT day, source, medium, SUM(orders)::int AS orders, COALESCE(SUM(sales), 0)::text AS sales
    FROM (
      SELECT o.local_day AS day, o.traffic_source AS source, o.traffic_medium AS medium, 1 AS orders, 0::numeric AS sales
      FROM orders o
      WHERE o.workspace_id = ${ws} AND o.store_id = ${storeId} AND o.local_day BETWEEN ${r.from} AND ${r.to}
        AND NOT o.gift_card_only AND o.traffic_source = ANY(${sources}::text[])
      UNION ALL
      SELECT s.local_day, o.traffic_source, o.traffic_medium, 0, ${SALE_VALUE}
      FROM order_sales s JOIN orders o ON o.id = s.order_id
      WHERE s.workspace_id = ${ws} AND s.store_id = ${storeId} AND ${MERCHANDISE} AND s.local_day BETWEEN ${r.from} AND ${r.to}
        AND o.traffic_source = ANY(${sources}::text[])
    ) x
    GROUP BY 1, 2, 3`;
  return rows.map((x) => ({ day: x.day, source: x.source, medium: x.medium, orders: num(x.orders), sales: num(x.sales) }));
}

/**
 * The storefront pixel's visits over the dates from the platforms' sources (funnel_visits, one per
 * visitor and day, as the Shopping Funnel counts them), by how far each went (its furthest step), from
 * the first day it recorded where visits came from: the days before have no source, so they are left
 * out rather than counted as none.
 */
async function visitsBySource(tx: Tx, { ws, storeId }: Scope, r: DateRange, sources: readonly string[]): Promise<SourcedVisits> {
  const [first] = await tx.$queryRaw<Array<{ day: string }>>`
    SELECT day FROM funnel_visits WHERE workspace_id = ${ws} AND store_id = ${storeId} AND source IS NOT NULL ORDER BY day LIMIT 1`;
  const from = first?.day ?? null;
  const counted = visitsCounted(from, r);
  if (!counted) return { from, rows: [] };
  const rows = await tx.$queryRaw<Array<{ source: string; furthest_step: number; visits: number }>>`
    SELECT source, furthest_step, COUNT(*)::int AS visits FROM funnel_visits
    WHERE workspace_id = ${ws} AND store_id = ${storeId} AND day BETWEEN ${counted} AND ${r.to} AND source = ANY(${sources}::text[])
    GROUP BY 1, 2`;
  return { from, rows: rows.map((x) => ({ source: x.source, visits: num(x.visits), furthestStep: num(x.furthest_step) })) };
}

/**
 * Meta's and Google's figures from the store's orders (`provider`: one of them only), for the dates
 * and, when `compare` (their orders imported, as the dashboard's sales compare), for the dates compared
 * with; `visits`: the storefront pixel records visits (the funnel capability), so they are counted too.
 */
export async function adsFromShopifyModule(
  tx: Tx,
  scope: Scope,
  dates: { range: DateRange; previous: Comparison },
  opts: { currency: string; timeZone: string; compare: boolean; historyFrom: string | null; provider?: AdSpendProvider; visits?: boolean },
) {
  const { range, previous } = dates;
  const providers: AdSpendProvider[] = opts.provider ? [opts.provider] : ["meta", "google"];
  const sources = providers.flatMap((p) => PLATFORM_SOURCES[p]);
  const until = opts.compare && previous.until ? localMoment(previous.to, previous.until, opts.timeZone) : null;
  const [rows, days, previousRows, visits] = await Promise.all([
    bySource(tx, scope, range, null),
    byDay(tx, scope, range, sources),
    opts.compare ? bySource(tx, scope, previous, until) : null,
    opts.visits ? visitsBySource(tx, scope, range, sources) : null,
  ]);
  return adsFromShopify({ providers, rows, days, previousRows, range, compared: previous, currency: opts.currency, historyFrom: opts.historyFrom, visits });
}

/**
 * What decides where Meta's and Google's figures come from (adPlatformSources in @app/shared): the
 * accounts the ads module counted for the store and whether each platform's figures cover the dates
 * (`ads`: null or absent with no account shown), its hidden accounts, and a sign-in still waiting for
 * an ad account.
 */
export async function adSourceFacts(tx: Tx, { ws, storeId }: Scope, ads: AdsFigures | null | undefined): Promise<Record<AdSpendProvider, AdSourceFacts>> {
  const [hidden, waiting] = await Promise.all([
    tx.adConnection.groupBy({ by: ["provider"], where: { workspaceId: ws, storeId, enabled: false, provider: { in: ["meta", "google"] } }, _count: { _all: true } }),
    tx.adLogin.findMany({ where: { workspaceId: ws, storeId, provider: { in: ["meta", "google"] } }, select: { provider: true } }),
  ]);
  const of = (p: AdSpendProvider): AdSourceFacts => {
    const own = ads?.byProvider.find((b) => b.provider === p);
    return {
      accounts: (ads?.accounts ?? []).filter((a) => a.provider === p),
      figures: !!own && (own.current !== null || own.soFar !== null),
      hidden: hidden.find((h) => h.provider === p)?._count._all ?? 0,
      waiting: waiting.some((l) => l.provider === p),
    };
  };
  return { meta: of("meta"), google: of("google") };
}

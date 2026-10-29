import { Prisma, type Store, type Tx } from "@app/db";
import {
  comparisonImported,
  countsByStep,
  daysBetweenInclusive,
  delta,
  eachDay,
  FUNNEL_DEVICES,
  funnelInsights,
  funnelTransitions,
  FUNNEL_STEPS,
  PURCHASED_STEP,
  reachedCounts,
  segmentFunnel,
  SITE_SECTIONS,
  summarizeJourney,
  TRAFFIC_SOURCES,
  visitsHistoryStart,
  type Comparison,
  type DateRange,
  type FunnelFilter,
  type JourneyPageRow,
  type SegmentFunnel,
  type SiteSection,
} from "@app/shared";
import { localMoment, r2, SALE_UNITS, SALE_VALUE, type Scope } from "./common.js";

// ---------------------------------------------------------------------------
// Storefront funnel (web pixel). One row per shopper per store-local day in
// funnel_visits; see packages/shared/src/journey.ts for what each column means,
// and packages/shared/src/funnel.ts for the Shopping Funnel page's maths.
// ---------------------------------------------------------------------------

const TOP_PAGES = 8;
/** The funnel step a visit reaches by starting a checkout. */
const CHECKOUT_STEP = FUNNEL_STEPS.indexOf("started_checkout");
const isSection = (s: string | null): s is SiteSection => s !== null && (SITE_SECTIONS as readonly string[]).includes(s);

/**
 * The filter's condition on funnel_visits `v` (packages/shared/src/funnel.ts, FunnelFilter), as an
 * `AND …` to append, or nothing. A returning visit is the same browser tracked on an earlier day.
 */
function filterSql(ws: string, f: FunnelFilter): Prisma.Sql {
  const parts: Prisma.Sql[] = [];
  if (f.device) parts.push(Prisma.sql`v.device = ${f.device}`);
  if (f.country) parts.push(Prisma.sql`v.country = ${f.country}`);
  if (f.landing) parts.push(Prisma.sql`v.entry_section = ${f.landing}`);
  if (f.source) parts.push(Prisma.sql`v.source = ${f.source}`);
  if (f.visitor) {
    const earlier = Prisma.sql`EXISTS (SELECT 1 FROM funnel_visits e WHERE e.workspace_id = ${ws} AND e.store_id = v.store_id AND e.visitor = v.visitor AND e.day < v.day)`;
    parts.push(f.visitor === "returning" ? earlier : Prisma.sql`NOT ${earlier}`);
  }
  return parts.length ? Prisma.sql`AND ${Prisma.join(parts, " AND ")}` : Prisma.empty;
}

/**
 * The store's funnel for these dates, against its comparison. Visits are counted only from when
 * the web pixel was put in place (`historyFrom`, see `visitsHistoryStart`): a comparison reaching
 * back before that would count a period partly unrecorded and show a rise that never happened, so
 * its figures and changes are left out (null, `previous.imported` false) and the page says there
 * is no earlier data. `filter` narrows every figure to some of the visits (the Shopping Funnel page).
 */
export async function funnel(tx: Tx, { ws, storeId }: Scope, range: DateRange, previous: Comparison, store: Pick<Store, "timezone" | "pixelInstalledAt">, filter: FunnelFilter = {}) {
  const timeZone = store.timezone;
  const only = filterSql(ws, filter);
  const inRange = (r: DateRange) => Prisma.sql`v.workspace_id = ${ws} AND v.store_id = ${storeId} AND v.day BETWEEN ${r.from} AND ${r.to} ${only}`;
  // A running comparison's last day: the visits that had started by the same time of day (one
  // recorded before visits were timed counts, as it always did).
  const inComparison = previous.until
    ? Prisma.sql`${inRange(previous)} AND (v.day < ${previous.to} OR v.entered_at IS NULL OR v.entered_at < ${localMoment(previous.to, previous.until, timeZone)})`
    : inRange(previous);

  // How far each visit got, and where the ones that stopped short were last seen.
  const stepRows = await tx.$queryRaw<Array<{ furthest_step: number; exit_section: string | null; visits: number; page_views: number }>>`
    SELECT v.furthest_step, v.exit_section, COUNT(*)::int AS visits, SUM(v.page_views)::int AS page_views
    FROM funnel_visits v WHERE ${inRange(range)}
    GROUP BY v.furthest_step, v.exit_section`;

  // Visits per site section (bit i of `sections`), and where visits landed.
  const sectionRows = await tx.$queryRaw<Array<{ kind: "visit" | "entry"; section: string | null; n: number }>>`
    SELECT 'visit' AS kind, (${[...SITE_SECTIONS]}::text[])[b.i + 1] AS section, COUNT(*)::int AS n
    FROM funnel_visits v CROSS JOIN generate_series(0, ${SITE_SECTIONS.length - 1}::int) AS b(i)
    WHERE ${inRange(range)} AND v.sections & (1 << b.i) <> 0
    GROUP BY b.i
    UNION ALL
    SELECT 'entry', v.entry_section, COUNT(*)::int FROM funnel_visits v WHERE ${inRange(range)} AND v.entry_section IS NOT NULL
    GROUP BY v.entry_section`;

  // Top landing pages (with how many of those visits bought) and top pages people left from without buying.
  const pageRows = await tx.$queryRaw<Array<{ kind: "entry" | "exit"; path: string; section: string; visits: number; purchases: number }>>`
    (SELECT 'entry' AS kind, v.entry_path AS path, MIN(v.entry_section) AS section, COUNT(*)::int AS visits,
            COUNT(*) FILTER (WHERE v.furthest_step = ${PURCHASED_STEP})::int AS purchases
     FROM funnel_visits v WHERE ${inRange(range)} AND v.entry_path IS NOT NULL
     GROUP BY v.entry_path ORDER BY COUNT(*) DESC, v.entry_path LIMIT ${TOP_PAGES})
    UNION ALL
    (SELECT 'exit', v.exit_path, MIN(v.exit_section), COUNT(*)::int, 0
     FROM funnel_visits v WHERE ${inRange(range)} AND v.exit_path IS NOT NULL AND v.furthest_step < ${PURCHASED_STEP}
     GROUP BY v.exit_path ORDER BY COUNT(*) DESC, v.exit_path LIMIT ${TOP_PAGES})`;

  const [first] = await tx.$queryRaw<Array<{ day: string | null }>>`
    SELECT MIN(day) AS day FROM funnel_visits WHERE workspace_id = ${ws} AND store_id = ${storeId}`;
  const historyFrom = visitsHistoryStart(store.pixelInstalledAt, timeZone, first?.day ?? null);
  const imported = comparisonImported(previous, historyFrom);
  // The comparison step by step: the page compares every step and transition, the dashboard its visits and conversion.
  const prevRows = imported
    ? await tx.$queryRaw<Array<{ furthest_step: number; visits: number }>>`
        SELECT v.furthest_step, COUNT(*)::int AS visits FROM funnel_visits v WHERE ${inComparison} GROUP BY v.furthest_step`
    : null;

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

  const prevReached = prevRows ? reachedCounts(countsByStep(prevRows.map((r) => ({ furthestStep: r.furthest_step, visits: r.visits })))) : null;
  const prevVisits = prevReached ? prevReached[0]! : null;
  const prevConversion = prevReached && prevVisits ? prevReached[PURCHASED_STEP]! / prevVisits : null;
  return {
    ...summary,
    entryPages: pages("entry"),
    exitPages: pages("exit"),
    /** The first day every visit was counted from (null: none recorded yet). */
    historyFrom,
    /** `reached`: visits that reached each step or a later one, in the dates compared with. */
    previous: { visits: prevVisits, conversionRate: prevConversion, imported, reached: prevReached },
    deltas: { visits: imported ? delta(summary.visits, prevVisits) : null, conversionRate: imported ? delta(summary.conversionRate, prevConversion) : null },
  };
}

/**
 * Shoppers who started a checkout in the range, and how many bought or left (`OrderOutcomes.checkouts`
 * in @app/shared): visits whose furthest step is the checkout or the purchase, one per shopper per
 * day as the funnel counts them. Only from when the pixel counted every visit (`visitsHistoryStart`);
 * null when that is after the range or nothing was recorded, which isn't the same as none.
 */
export async function checkoutsLeft(tx: Tx, { ws, storeId }: Scope, range: DateRange, store: Pick<Store, "timezone" | "pixelInstalledAt">) {
  const [first] = await tx.$queryRaw<Array<{ day: string | null }>>`
    SELECT MIN(day) AS day FROM funnel_visits WHERE workspace_id = ${ws} AND store_id = ${storeId}`;
  const historyFrom = visitsHistoryStart(store.pixelInstalledAt, store.timezone, first?.day ?? null);
  if (!historyFrom || range.to < historyFrom) return null;
  // The day tracking began on was only partly counted: from the day after.
  const from = historyFrom > range.from ? historyFrom : null;
  const [row] = await tx.$queryRaw<Array<{ started: number; completed: number }>>`
    SELECT (COUNT(*) FILTER (WHERE v.furthest_step >= ${CHECKOUT_STEP}))::int AS started,
           (COUNT(*) FILTER (WHERE v.furthest_step = ${PURCHASED_STEP}))::int AS completed
    FROM funnel_visits v
    WHERE v.workspace_id = ${ws} AND v.store_id = ${storeId} AND v.day BETWEEN ${from ?? range.from} AND ${range.to}`;
  const started = row?.started ?? 0;
  const completed = row?.completed ?? 0;
  return { started, completed, left: started - completed, from };
}

/** What the Shopping Funnel page asks beyond the dashboard's funnel. */
export interface FunnelView {
  filter: FunnelFilter;
  /** The member may see product sales (orders, units and net sales per product: the top products permission). */
  productSales: boolean;
  /** The member may see where visitors came from (the traffic sources permission): the source segment and filter. */
  sources: boolean;
}

/** Countries listed one by one before the rest are put together. */
const TOP_COUNTRIES = 12;
/** Products listed: the most-viewed product pages, and the best sellers no tracked visit viewed. */
const TOP_VIEWED = 200;
const TOP_SOLD = 50;

/** Segment rows (one dimension, grouped by furthest step) → a funnel per segment, largest first. */
function segmentsOf(rows: Array<{ key: string; furthest_step: number; visits: number }>): SegmentFunnel[] {
  const by = new Map<string, Array<{ furthestStep: number; visits: number }>>();
  for (const r of rows) by.set(r.key, [...(by.get(r.key) ?? []), { furthestStep: r.furthest_step, visits: r.visits }]);
  return [...by.entries()].map(([key, rs]) => segmentFunnel(key, countsByStep(rs))).sort((a, b) => b.visits - a.visits || a.key.localeCompare(b.key));
}

/** Countries past the first TOP_COUNTRIES, put together as "other" (the not recorded and unknown stay apart). */
function topCountries(list: SegmentFunnel[]): SegmentFunnel[] {
  const named = list.filter((s) => s.key !== "not_recorded" && s.key !== "unknown");
  if (named.length <= TOP_COUNTRIES) return list;
  const rest = named.slice(TOP_COUNTRIES);
  const at = [0, 0, 0, 0, 0];
  for (const s of rest) s.reached.forEach((n, k) => (at[k] = (at[k] ?? 0) + n - (s.reached[k + 1] ?? 0)));
  return [...named.slice(0, TOP_COUNTRIES), segmentFunnel("other", at), ...list.filter((s) => s.key === "not_recorded" || s.key === "unknown")];
}

/**
 * Everything the Shopping Funnel page shows from the pixel's visits, for these dates and the
 * filter: the dashboard's funnel (above), the comparison step by step, every transition, day by
 * day, funnels per device, country, landing page, new or returning visitor and traffic source,
 * products, the observations the numbers support, and the store's checklist.
 *
 * Device and country, and the product pages, are recorded from `detailsFrom` (the first visit that
 * has them); traffic sources, and quick adds, checkouts and purchases per product, from
 * `sourcesFrom` (the first visit with a source: the same pixel release sends both). Visits from
 * before have none, and say so (`not_recorded`, null) rather than guess.
 */
export async function funnelDetail(tx: Tx, scope: Scope, range: DateRange, previous: Comparison, store: Pick<Store, "timezone" | "pixelInstalledAt">, view: FunnelView) {
  const { ws, storeId } = scope;
  const base = await funnel(tx, scope, range, previous, store, view.filter);
  const only = filterSql(ws, view.filter);
  const inRange = Prisma.sql`v.workspace_id = ${ws} AND v.store_id = ${storeId} AND v.day BETWEEN ${range.from} AND ${range.to} ${only}`;

  const [browsers] = await tx.$queryRaw<Array<{ n: number }>>`SELECT COUNT(DISTINCT v.visitor)::int AS n FROM funnel_visits v WHERE ${inRange}`;

  // Day by day: visits by how far they got.
  const dayRows = await tx.$queryRaw<Array<{ day: string; furthest_step: number; visits: number }>>`
    SELECT v.day, v.furthest_step, COUNT(*)::int AS visits FROM funnel_visits v WHERE ${inRange} GROUP BY v.day, v.furthest_step`;
  const byDay = new Map<string, Array<{ furthestStep: number; visits: number }>>();
  for (const r of dayRows) byDay.set(r.day, [...(byDay.get(r.day) ?? []), { furthestStep: r.furthest_step, visits: r.visits }]);
  // A day before visits were counted has no figures (null), which isn't the same as none.
  const daily = eachDay(range.from, range.to).map((day) => ({ day, reached: base.historyFrom && day >= base.historyFrom ? reachedCounts(countsByStep(byDay.get(day) ?? [])) : null }));

  // Every segment at once. `recorded`: the visit has a device (and so a country, when the edge knew it).
  const segRows = await tx.$queryRaw<
    Array<{ gd: number; gc: number; gl: number; gr: number; gs: number; device: string | null; recorded: boolean | null; country: string | null; entry_section: string | null; returning: boolean | null; source: string | null; furthest_step: number; visits: number }>
  >`
    WITH s AS (
      SELECT v.device, v.device IS NOT NULL AS recorded, v.country, v.entry_section, v.source, v.furthest_step,
             EXISTS (SELECT 1 FROM funnel_visits e WHERE e.workspace_id = ${ws} AND e.store_id = v.store_id AND e.visitor = v.visitor AND e.day < v.day) AS returning
      FROM funnel_visits v WHERE ${inRange}
    )
    SELECT GROUPING(s.device)::int AS gd, GROUPING(s.country)::int AS gc, GROUPING(s.entry_section)::int AS gl, GROUPING(s.returning)::int AS gr, GROUPING(s.source)::int AS gs,
           s.device, s.recorded, s.country, s.entry_section, s.returning, s.source, s.furthest_step, COUNT(*)::int AS visits
    FROM s
    GROUP BY GROUPING SETS ((s.device, s.furthest_step), (s.recorded, s.country, s.furthest_step), (s.entry_section, s.furthest_step), (s.returning, s.furthest_step), (s.source, s.furthest_step))`;
  const dim = (want: "device" | "country" | "landing" | "visitor" | "source") =>
    segRows
      .filter((r) => (want === "device" ? r.gd : want === "country" ? r.gc : want === "landing" ? r.gl : want === "visitor" ? r.gr : r.gs) === 0)
      .map((r) => ({
        key:
          want === "device"
            ? (r.device === null ? "not_recorded" : (FUNNEL_DEVICES as readonly string[]).includes(r.device) ? r.device : "unknown")
            : want === "country"
              ? (!r.recorded ? "not_recorded" : (r.country ?? "unknown"))
              : want === "landing"
                ? (isSection(r.entry_section) ? r.entry_section : "not_recorded")
                : want === "visitor"
                  ? (r.returning ? "returning" : "new")
                  : (r.source === null ? "not_recorded" : (TRAFFIC_SOURCES as readonly string[]).includes(r.source) ? r.source : "unknown"),
        furthest_step: r.furthest_step,
        visits: r.visits,
      }));
  const segments = {
    device: segmentsOf(dim("device")),
    country: topCountries(segmentsOf(dim("country"))),
    landing: segmentsOf(dim("landing")),
    visitor: segmentsOf(dim("visitor")),
    // Where visitors came from is the traffic sources permission's.
    ...(view.sources ? { source: segmentsOf(dim("source")) } : {}),
  };

  // When device, country and product pages, and traffic sources, began to be recorded, and the last visit seen.
  const [details] = await tx.$queryRaw<Array<{ day: string }>>`
    SELECT day FROM funnel_visits WHERE workspace_id = ${ws} AND store_id = ${storeId} AND device IS NOT NULL ORDER BY day LIMIT 1`;
  const [sourced] = await tx.$queryRaw<Array<{ day: string }>>`
    SELECT day FROM funnel_visits WHERE workspace_id = ${ws} AND store_id = ${storeId} AND source IS NOT NULL ORDER BY day LIMIT 1`;
  const [last] = await tx.$queryRaw<Array<{ at: Date | null }>>`
    SELECT MAX(exited_at) AS at FROM funnel_visits
    WHERE workspace_id = ${ws} AND store_id = ${storeId} AND day = (SELECT MAX(day) FROM funnel_visits WHERE workspace_id = ${ws} AND store_id = ${storeId})`;
  const detailsFrom = details?.day ?? null;
  const sourcesFrom = sourced?.day ?? null;

  // Products: visits that viewed each, added it to cart from its page, added it quickly from anywhere else, started a checkout
  // with it, bought it (the steps bits, PRODUCT_* in packages/shared/src/funnel.ts); visits that landed on its page, left the
  // store from it without buying, and landed on it and left from it without buying (`landedLeft`).
  const productRows = await tx.$queryRaw<Array<{ handle: string; viewed: number; added: number; quick_added: number; checkouts: number; purchased: number }>>`
    SELECT p.handle, COUNT(*) FILTER (WHERE p.steps & 1 <> 0)::int AS viewed, COUNT(*) FILTER (WHERE p.steps & 2 <> 0)::int AS added,
           COUNT(*) FILTER (WHERE p.steps & 4 <> 0)::int AS quick_added, COUNT(*) FILTER (WHERE p.steps & 8 <> 0)::int AS checkouts,
           COUNT(*) FILTER (WHERE p.steps & 16 <> 0)::int AS purchased
    FROM funnel_product_visits p
    JOIN funnel_visits v ON v.store_id = p.store_id AND v.day = p.day AND v.visitor = p.visitor
    WHERE p.workspace_id = ${ws} AND p.store_id = ${storeId} AND p.day BETWEEN ${range.from} AND ${range.to} AND ${inRange}
    GROUP BY p.handle ORDER BY viewed DESC, p.handle LIMIT ${TOP_VIEWED}`;
  const edgeRows = await tx.$queryRaw<Array<{ kind: "landed" | "exit" | "landedLeft"; handle: string; visits: number }>>`
    SELECT 'landed' AS kind, substr(v.entry_path, 11) AS handle, COUNT(*)::int AS visits
    FROM funnel_visits v WHERE ${inRange} AND v.entry_path LIKE '/products/%' GROUP BY 2
    UNION ALL
    SELECT 'exit', substr(v.exit_path, 11), COUNT(*)::int
    FROM funnel_visits v WHERE ${inRange} AND v.exit_path LIKE '/products/%' AND v.furthest_step < ${PURCHASED_STEP} GROUP BY 2
    UNION ALL
    SELECT 'landedLeft', substr(v.entry_path, 11), COUNT(*)::int
    FROM funnel_visits v WHERE ${inRange} AND v.entry_path LIKE '/products/%' AND v.exit_path = v.entry_path AND v.furthest_step < ${PURCHASED_STEP} GROUP BY 2`;

  // Sales by product for the same dates, from the store's orders: every order, tracked or not, and net of returns.
  const sold = view.productSales
    ? await tx.$queryRaw<Array<{ product_id: string; orders: number; units: string; net_sales: string }>>`
        SELECT li.product_shopify_id AS product_id,
          (COUNT(DISTINCT s.order_id) FILTER (WHERE s.action_type = 'order'))::int AS orders,
          COALESCE(SUM(${SALE_UNITS}), 0)::text AS units,
          COALESCE(SUM(${SALE_VALUE}), 0)::text AS net_sales
        FROM order_sales s JOIN LATERAL (
          SELECT li.product_shopify_id FROM order_line_items li
          WHERE li.workspace_id = ${ws} AND li.store_id = ${storeId} AND li.shopify_id = s.line_item_shopify_id AND li.order_id = s.order_id LIMIT 1
        ) li ON TRUE
        WHERE s.workspace_id = ${ws} AND s.store_id = ${storeId} AND s.line_type = 'product'
          AND s.local_day BETWEEN ${range.from} AND ${range.to} AND li.product_shopify_id IS NOT NULL
        GROUP BY li.product_shopify_id`
    : [];
  const salesOf = new Map(sold.map((r) => [r.product_id, { orders: r.orders, units: Number(r.units), netSales: r2(Number(r.net_sales)) }]));
  const topSold = [...salesOf.entries()].sort((a, b) => b[1].netSales - a[1].netSales || b[1].units - a[1].units).slice(0, TOP_SOLD).map(([id]) => id);
  const catalog = await tx.product.findMany({
    where: { workspaceId: ws, storeId, OR: [{ handle: { in: productRows.map((r) => r.handle) } }, { shopifyId: { in: topSold } }] },
    select: { shopifyId: true, handle: true, title: true, imageUrl: true, onlineStoreUrl: true },
  });
  const byHandle = new Map(catalog.filter((p) => p.handle).map((p) => [p.handle!.toLowerCase(), p]));
  const edges = (kind: "landed" | "exit" | "landedLeft", handle: string) => edgeRows.find((r) => r.kind === kind && r.handle === handle)?.visits ?? 0;
  // Views are known only for days product pages were recorded; quick adds, checkouts and purchases for days sources were.
  const viewsKnown = !!detailsFrom && range.to >= detailsFrom;
  const cartsKnown = !!sourcesFrom && range.to >= sourcesFrom;
  const products = productRows.map((r) => {
    const p = byHandle.get(r.handle);
    return {
      handle: r.handle,
      productId: p?.shopifyId ?? null,
      title: p?.title ?? null,
      imageUrl: p?.imageUrl ?? null,
      url: p?.onlineStoreUrl ?? null,
      viewed: r.viewed as number | null,
      added: r.added as number | null,
      addRate: r.viewed > 0 ? r.added / r.viewed : null,
      quickAdded: cartsKnown ? r.quick_added : null,
      checkouts: cartsKnown ? r.checkouts : null,
      purchased: cartsKnown ? r.purchased : null,
      // Every visit that bought it started a checkout with it (PRODUCT_PURCHASED sets both), so this is a share of the same visits.
      checkoutCompletion: cartsKnown && r.checkouts > 0 ? r.purchased / r.checkouts : null,
      landed: edges("landed", r.handle),
      landedLeft: edges("landedLeft", r.handle),
      exits: edges("exit", r.handle),
      ...(view.productSales ? (p && salesOf.get(p.shopifyId)) || { orders: 0, units: 0, netSales: 0 } : {}),
    };
  });
  // Best sellers no tracked visit viewed in these dates (bought from a link to checkout, by shoppers not tracked, on other channels).
  const listed = new Set(products.map((p) => p.productId).filter(Boolean));
  for (const id of topSold) {
    const p = catalog.find((c) => c.shopifyId === id);
    if (!p || listed.has(id)) continue;
    const handle = p.handle?.toLowerCase() ?? `product-${id}`;
    products.push({
      handle,
      productId: id,
      title: p.title,
      imageUrl: p.imageUrl,
      url: p.onlineStoreUrl,
      viewed: viewsKnown ? 0 : null,
      added: viewsKnown ? 0 : null,
      addRate: null,
      quickAdded: cartsKnown ? 0 : null,
      checkouts: cartsKnown ? 0 : null,
      purchased: cartsKnown ? 0 : null,
      checkoutCompletion: null,
      landed: edges("landed", handle),
      landedLeft: edges("landedLeft", handle),
      exits: edges("exit", handle),
      ...salesOf.get(id)!,
    });
  }

  const checks = await tx.funnelActionCheck.findMany({ where: { workspaceId: ws, storeId }, orderBy: { doneAt: "asc" } });
  const people = checks.length
    ? await tx.user.findMany({ where: { id: { in: [...new Set(checks.map((c) => c.doneBy).filter((id): id is string => !!id))] } }, select: { id: true, displayName: true, email: true } })
    : [];
  const actions = checks.map((c) => {
    const who = people.find((u) => u.id === c.doneBy);
    return { id: c.actionId, doneAt: c.doneAt.toISOString(), doneBy: c.doneBy, doneByName: who ? (who.displayName ?? who.email) : null };
  });

  const reached = base.steps.map((s) => s.reached);
  const before = base.previous.reached;
  return {
    ...base,
    filter: view.filter,
    /** Each step's visits against the dates compared with, as a change (null: nothing to compare). */
    stepDeltas: reached.map((n, k) => (before ? delta(n, before[k] ?? 0) : null)),
    /** Distinct browsers among the visits (one shopper tracked on several days is one browser). */
    browsers: browsers?.n ?? 0,
    transitions: funnelTransitions(reached, base.previous.reached),
    daily,
    segments,
    products,
    productSales: view.productSales,
    /** The first day device, country and product pages were recorded (null: none yet). */
    detailsFrom,
    /** The first day traffic sources, and quick adds, checkouts and purchases per product, were recorded (null: none yet). */
    sourcesFrom,
    /** When the latest tracked visit was last seen. */
    lastEventAt: last?.at ? last.at.toISOString() : null,
    insights: funnelInsights({
      reached,
      previousReached: base.previous.reached,
      sameLength: daysBetweenInclusive(range.from, range.to) === daysBetweenInclusive(previous.from, previous.to),
      devices: segments.device,
      visitors: segments.visitor,
      products: products.filter((p) => p.viewed !== null).map((p) => ({ handle: p.handle, title: p.title, viewed: p.viewed ?? 0, added: p.added ?? 0 })),
    }),
    actions,
  };
}

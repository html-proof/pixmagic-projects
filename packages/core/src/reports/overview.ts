import type { Store, Tx } from "@app/db";
import { comparisonImported, delta, localDay, pastYearBreakdown, resolveCapabilities, storeStartDay, summarize, yearBreakdown, type AdProvider, type Comparison, type DailyMetricsRow, type DateRange } from "@app/shared";
import { adsConfigured } from "../adConnections.js";
import { latestReconciliation } from "../reconcile.js";
import { storeSalesCalculation } from "../salesCalculation.js";
import { declaredScopes, optionalScopesFor } from "../scopes.js";
import { adsenseModule, adsModule } from "./ads.js";
import { catalog, importedData, inventory } from "./catalog.js";
import type { Scope } from "./common.js";
import { funnel, funnelDetail, type FunnelView } from "./funnel.js";
import { channels, discountCodes, fulfillment, orderTiming, recentOrders, traffic } from "./orders.js";
import { comparisonRows, customerCounts, dailyRows, dailySeries } from "./sales.js";
import { productPerformance } from "./products.js";
import { shopifyModules } from "./shopify.js";

/**
 * Why a store's sync stopped, in a word the dashboard can explain: Shopify's own answer to the
 * last failed job (packages/core/src/shopify.ts). 402 is a frozen, paused or closed store (an unpaid
 * Shopify bill, an ended trial), 404 a store Shopify can't find, 423 a locked one: reconnecting
 * fixes none of them. 401/403 or a missing token is lost access, which reconnecting does fix.
 * `not_approved`: Shopify hasn't approved the app for protected customer data (the worker's
 * NotApprovedError), which only Shopify's approval fixes.
 */
export function syncProblem(error: string | null | undefined): "shop_unavailable" | "shop_gone" | "shop_locked" | "access" | "not_approved" | "other" {
  if (!error) return "other";
  if (/protected customer data/i.test(error)) return "not_approved";
  if (/^Shopify 402\b/.test(error)) return "shop_unavailable";
  if (/^Shopify 404\b/.test(error)) return "shop_gone";
  if (/^Shopify 423\b/.test(error)) return "shop_locked";
  // The worker records a 401/403 as "Shopify rejected our access (403); ..." (AccessRevokedError).
  if (/Shopify auth error|rejected our access|is not connected/.test(error)) return "access";
  return "other";
}

/**
 * What the Advertising pages ask of the ad modules beyond the dashboard's question: one platform's or
 * one account's figures, and every campaign. Figures for some of the accounts are never set against
 * the store's whole sales (MER, share of sales, cost per order): only the accounts' own figures, and,
 * for a whole platform, the orders Shopify credits to that platform's ads.
 */
export interface AdsView {
  /** Only this platform's accounts. */
  platform?: AdProvider;
  /** Only this account (an ad connection's id). */
  account?: string;
  /** Every campaign, each with its change, rather than the 10 that spent most. */
  allCampaigns?: boolean;
}

/**
 * Everything the dashboard shows for one store and one date range, in one transaction (`tx` from
 * `withTenant`, so RLS applies). Modules are included ONLY when the store's granted scopes enable
 * them; disabled modules come back in `capabilities` with the missing scopes so the UI can
 * explain, never with placeholder numbers.
 *
 * `sees` says which modules the member asking may see (Team & Access, `seesModule` in
 * @app/shared/access): the others are not even computed. The route still passes the answer through
 * `redactOverview`, which also takes out the fields inside a module that need their own permission.
 *
 * `adsView` narrows the ad modules for the Advertising pages (AdsView). `funnelView`: the Shopping
 * Funnel page's question (its filter), which makes the funnel module the page's full report
 * (`funnelDetail`) instead of the dashboard's summary.
 *
 * The caller has checked that `store` belongs to the workspace and resolved the dates.
 */
export async function storeOverview(
  tx: Tx,
  store: Store,
  dates: { range: DateRange; previous: Comparison },
  now = new Date(),
  sees: (module: string) => boolean = () => true,
  adsView: AdsView = {},
  funnelView?: FunnelView,
) {
  const { range, previous } = dates;
  const ws = store.workspaceId;
  const storeId = store.id;
  // "Today" in the store's zone, for all-time ages and the trailing stock-velocity window.
  const today = localDay(now, store.timezone);
  const scope: Scope = { ws, storeId: store.id };
  // The deployed scope lists let the web app tell apart the three reasons a module is locked:
  // reconnect the store, ask the merchant (POST .../scopes/request), or wait on Shopify. It
  // must never offer an action that cannot work — see apps/api/src/routes/scopes.ts.
  const capabilities = resolveCapabilities(store.grantedScopes, {
    pixelInstalled: store.pixelInstalled,
    optionalScopes: optionalScopesFor(store),
    declaredScopes: declaredScopes(),
  });
  const enabled = new Set(capabilities.filter((c) => c.enabled && sees(c.id)).map((c) => c.id));
  const modules: Record<string, unknown> = {};
  const data = await importedData(tx, scope, store);
  // A comparison reaching back before the imported history (Shopify shares 60 days without
  // read_all_orders) would count a period mostly missing: its order figures and changes are left
  // out (null), and the page says there is no earlier data, rather than show a fake drop or 0%.
  const previousImported = comparisonImported(previous, data.historyFrom);
  const change = (now: number | null, before: number | null) => (previousImported ? delta(now, before) : null);

  let hasData = false;
  let rangeRows: DailyMetricsRow[] | null = null;
  if (enabled.has("sales_overview") || enabled.has("refunds") || enabled.has("customers")) {
    // While the range is still running, the comparison stops at the same time of day (Shopify's like-for-like).
    const [cur, prev] = await Promise.all([dailyRows(tx, ws, storeId, range), previousImported ? comparisonRows(tx, ws, storeId, previous, store.timezone) : []]);
    rangeRows = cur;
    // This calendar year and the two before it, month by month, whatever the dates picked: one read
    // from the January two years back (this year's January compares with the December before).
    const yearRows = enabled.has("sales_overview") ? await dailyRows(tx, ws, storeId, { from: `${Number(today.slice(0, 4)) - 2}-01-01`, to: today }) : [];
    const c = summarize(cur);
    const p = summarize(prev);
    hasData = cur.some((r) => r.orders > 0 || r.refunds > 0);
    if (enabled.has("sales_overview")) {
      // Shopify's "Total sales breakdown", line for line: gross − discounts − returns = net sales,
      // + additional fees + duties + shipping + taxes = total sales. The lines come for the dates
      // compared with too, so the store's own calculation from them (Custom sales) compares as well.
      // totalRefunded: what refunds took off that total sales, tax and shipping in (under the tile).
      modules.sales_overview = {
        current: {
          grossSales: c.grossSales,
          discounts: c.discounts,
          returns: c.refunds,
          netSales: c.netSales,
          totalSales: c.totalSales,
          totalRefunded: c.totalRefunded,
          orders: c.orders,
          units: c.units,
          averageOrderValue: c.averageOrderValue,
          tax: c.taxes,
          shipping: c.shipping,
          duties: c.duties,
          additionalFees: c.additionalFees,
        },
        previous: previousImported
          ? {
              grossSales: p.grossSales,
              netSales: p.netSales,
              totalSales: p.totalSales,
              tax: p.taxes,
              shipping: p.shipping,
              duties: p.duties,
              additionalFees: p.additionalFees,
              orders: p.orders,
              units: p.units,
              averageOrderValue: p.averageOrderValue,
            }
          : null,
        deltas: {
          netSales: change(c.netSales, p.netSales),
          totalSales: change(c.totalSales, p.totalSales),
          orders: change(c.orders, p.orders),
          averageOrderValue: change(c.averageOrderValue, p.averageOrderValue),
          grossSales: change(c.grossSales, p.grossSales),
          units: change(c.units, p.units),
        },
        series: dailySeries(cur, range),
        // This calendar year month by month, and the same months of the two years before, whole
        // (the dashboard's monthly comparison): each month not imported is said to be so.
        year: { ...yearBreakdown(yearRows, today, data.historyFrom), past: [1, 2].map((back) => pastYearBreakdown(yearRows, today, back, data.historyFrom)) },
        // The store's own calculation from those lines: which it counts and whether the dashboard
        // shows it. Restored for everyone who opens the dashboard; Shopify's figures above never change.
        calculation: await storeSalesCalculation(tx, scope),
      };
    }
    if (enabled.has("refunds")) {
      modules.refunds = {
        current: { refunds: c.refunds, refundRate: c.refundRate, refundedOrders: cur.reduce((a, r) => a + r.refundedOrders, 0) },
        deltas: { refunds: change(c.refunds, p.refunds) },
      };
    }
    if (enabled.has("customers")) {
      // Shopify's returning customer rate: customers who had bought before ÷ customers, each counted once.
      const [now, before] = await Promise.all([
        customerCounts(tx, scope, range, store.timezone),
        previousImported ? customerCounts(tx, scope, previous, store.timezone) : null,
      ]);
      modules.customers = {
        current: now,
        previous: before ?? { customers: null, returningCustomers: null, newCustomers: null, returningCustomerRate: null },
      };
    }
  }

  if (enabled.has("top_products")) modules.top_products = await productPerformance(tx, scope, store, range, {}, now);

  if (enabled.has("funnel")) modules.funnel = funnelView ? await funnelDetail(tx, scope, range, previous, store, funnelView) : await funnel(tx, scope, range, previous, store);

  // Not a Shopify capability: present once an ad account is connected to the store.
  type SalesFigures = { netSales?: number; orders?: number };
  const salesModule = modules.sales_overview as { current?: SalesFigures; previous?: SalesFigures | null } | undefined;
  const netSales = salesModule?.current?.netSales ?? null;
  // The store's own time zone and this answer's now: the same "today" as the dates above, with no
  // second look-up. Its orders and the dates compared with go with the net sales (the ads module sets
  // them against the spend); which orders Shopify credits to each platform's ads is read when the
  // store's traffic sources are read at all (the channels capability, and the member sees them).
  // Some of the spend (one platform, one account) is never set against the whole store's sales; one
  // AdSense account's earnings neither.
  const { platform, account } = adsView;
  const someSpend = !!(platform || account);
  const adsOpts = {
    timeZone: store.timezone,
    now,
    orders: someSpend ? null : (salesModule?.current?.orders ?? null),
    before: !someSpend && salesModule?.previous ? { netSales: salesModule.previous.netSales ?? null, orders: salesModule.previous.orders ?? null } : null,
    attribution: !account && enabled.has("channels"),
    connections: account ? [account] : undefined,
    allCampaigns: adsView.allCampaigns,
  };
  if (sees("ads") && platform !== "adsense") {
    const ads = await adsModule(tx, scope, range, previous, store.currency, someSpend ? null : netSales, { ...adsOpts, provider: platform });
    if (ads) modules.ads = ads;
  }
  if (sees("adsense") && (!platform || platform === "adsense")) {
    const adsense = await adsenseModule(tx, scope, range, previous, store.currency, account ? null : netSales, adsOpts);
    if (adsense) modules.adsense = adsense;
  }
  if (sees("ad_connections")) {
    // Which platforms are connected at all, hidden accounts included: the Advertising section
    // offers the ones that aren't, and says so when every account is hidden. Counts only, and
    // only for a store with ad accounts (absent means none). `waiting`: the platforms whose sign-in
    // is connected with no ad account yet (adConnections/logins.ts), which the section says instead.
    const adCounts = await tx.adConnection.groupBy({ by: ["provider", "enabled"], where: { workspaceId: ws, storeId: store.id }, _count: { _all: true } });
    const waiting = (await tx.adLogin.findMany({ where: { workspaceId: ws, storeId: store.id }, select: { provider: true } })).map((l) => l.provider);
    const connected = { meta: 0, google: 0, adsense: 0, hidden: 0, ...(waiting.length ? { waiting } : {}) };
    for (const g of adCounts) {
      if (g.provider === "meta" || g.provider === "google" || g.provider === "adsense") connected[g.provider] += g._count._all;
      if (!g.enabled) connected.hidden += g._count._all;
    }
    if (adCounts.length || waiting.length) modules.ad_connections = connected;
  }
  // Which platforms this server can connect at all: the dashboard only offers those.
  const configured = adsConfigured();
  if (sees("ad_configured") && (configured.meta || configured.google || configured.adsense)) modules.ad_configured = configured;

  if (enabled.has("channels")) {
    modules.channels = await channels(tx, scope, range);
    if (sees("traffic")) modules.traffic = await traffic(tx, scope, range);
  }
  if (enabled.has("order_timing")) modules.order_timing = await orderTiming(tx, scope, range, store.timezone);
  if (enabled.has("fulfillment")) modules.fulfillment = await fulfillment(tx, scope, range, today);
  if (enabled.has("discount_codes")) modules.discount_codes = await discountCodes(tx, scope, range);
  if (enabled.has("recent_orders")) modules.recent_orders = await recentOrders(tx, scope, range, store.timezone);
  if (enabled.has("inventory")) modules.inventory = await inventory(tx, store, today);
  if (enabled.has("catalog")) modules.catalog = await catalog(tx, scope, range);

  const freshness = await dataFreshness(tx, scope, store, now);
  const check = await checkSummary(tx, scope);
  // Shopify's own report figures, once the store has granted its reports (read_reports): its
  // sessions and visitors, its gross profit, and the sales figures checked against its sales report.
  // Read from what the worker keeps; `shopifyRefresh` says which to fetch again.
  const checkSales = store.grantedScopes.includes("read_reports") && enabled.has("sales_overview") && sees("shopify_check");
  const shopify = await shopifyModules(
    tx,
    store,
    dates,
    { today, now, rangeRows: rangeRows ?? (checkSales ? await dailyRows(tx, ws, storeId, range) : []), dataAsOf: freshness.asOf, waiting: freshness.waiting },
    { sessions: enabled.has("shopify_sessions"), profit: enabled.has("profit"), check: checkSales },
  );
  Object.assign(modules, shopify.modules);
  const failed =
    store.status === "error"
      ? await tx.syncJob.findFirst({ where: { storeId, workspaceId: ws, status: "failed" }, orderBy: { createdAt: "desc" }, select: { error: true } })
      : null;
  return {
    // Only while the store is in error: why, so the page can say what will fix it.
    syncProblem: store.status === "error" ? syncProblem(failed?.error) : null,
    // How current the numbers are: when they last matched Shopify, and whether changes are waiting.
    freshness,
    // The last check against Shopify's own records: its outcome and dates, never its figures.
    check,
    // The store's today, so the page can tell a finished day from one still running.
    today,
    // False: the imported orders don't reach back to the comparison, so no order figure is compared.
    previousImported,
    capabilities,
    modules,
    hasData,
    data,
    // Shopify reports to fetch again (missing or stale); the route queues them, nothing waits.
    shopifyRefresh: shopify.refresh,
  };
}

/**
 * How current this store's numbers are, from what actually brought Shopify's changes in, not from
 * whether the page is polling (the dashboard used to say "Live" for that):
 *
 * - `asOf`: the later of the last finished order import or re-read (`lastSyncedAt`) and the last
 *   order notification processed. Every change Shopify had told us about by then is counted.
 * - `waiting` / `waitingSince`: notifications received and not processed yet, and since when. A
 *   backlog of minutes means the numbers are behind Shopify's by about that much.
 * - `failed`: notifications that failed for good in the last 24 hours. The nightly reconcile
 *   re-reads those orders; until then they may be missing or out of date.
 *
 * Shopify's own reports can take a few minutes to include a new order too, so a small gap either
 * way is normal.
 */
export async function dataFreshness(tx: Tx, { ws, storeId }: Scope, store: Pick<Store, "lastSyncedAt">, now = new Date()) {
  const [w] = await tx.$queryRaw<Array<{ last: Date | null; waiting: number; waiting_since: Date | null; failed: number }>>`
    SELECT MAX(processed_at) FILTER (WHERE status = 'succeeded') AS last,
           (COUNT(*) FILTER (WHERE status IN ('queued', 'running')))::int AS waiting,
           MIN(received_at) FILTER (WHERE status IN ('queued', 'running')) AS waiting_since,
           (COUNT(*) FILTER (WHERE status = 'failed' AND received_at > ${new Date(now.getTime() - 86_400_000)}))::int AS failed
    FROM webhook_events
    WHERE workspace_id = ${ws} AND store_id = ${storeId} AND received_at > ${new Date(now.getTime() - 3 * 86_400_000)}
      AND (topic LIKE 'orders/%' OR topic LIKE 'refunds/%')`;
  const times = [store.lastSyncedAt, w?.last ?? null].filter((d): d is Date => !!d);
  return {
    asOf: times.length ? new Date(Math.max(...times.map((d) => d.getTime()))).toISOString() : null,
    waiting: w?.waiting ?? 0,
    waitingSince: w?.waiting_since ? w.waiting_since.toISOString() : null,
    failed: w?.failed ?? 0,
  };
}

/**
 * The last check of the store's figures against Shopify (packages/core/src/reconcile.ts), as every
 * member who sees the dashboard may see it: the outcome, the days it covered and when, how many
 * figures matched; never the figures themselves (those need finance.breakdown, GET .../check).
 */
export async function checkSummary(tx: Tx, scope: Scope) {
  const { last, running } = await latestReconciliation(tx, scope);
  return {
    running,
    last: last
      ? {
          status: last.status,
          from: last.from,
          to: last.to,
          checkedAt: last.checkedAt,
          ordersChecked: last.ordersChecked,
          matched: last.results.filter((r) => r.status === "match" || r.status === "repaired").length,
          compared: last.results.length,
          repaired: last.repaired + last.removed,
          // Orders Shopify no longer shares, left out of the comparison (a count, no money).
          setAside: last.setAside?.orders ?? 0,
        }
      : null,
  };
}

/** A workspace's connected stores, with how many orders and products each holds. */
export async function workspaceStores(tx: Tx, ws: string) {
  // `imported` is what lets the settings card tell "connected and holding your data" apart from
  // "connected and holding nothing", which look identical from scopes and lastSyncedAt alone.
  // Two grouped queries for the whole workspace, not one pair per store.
  const stores = await tx.store.findMany({ where: { workspaceId: ws, status: { not: "uninstalled" } }, orderBy: { createdAt: "asc" } });
  const orders = await tx.order.groupBy({ by: ["storeId"], where: { workspaceId: ws }, _count: { _all: true }, _min: { localDay: true } });
  const products = await tx.product.groupBy({ by: ["storeId"], where: { workspaceId: ws }, _count: { _all: true } });
  const countBy = (rows: Array<{ storeId: string; _count: { _all: number } }>) => new Map(rows.map((r) => [r.storeId, r._count._all]));
  const orderCount = countBy(orders);
  const oldestOrderDay = new Map(orders.map((r) => [r.storeId, r._min.localDay]));
  const productCount = countBy(products);
  // Why a store that stopped syncing stopped, as the dashboard says it: the card's status line must
  // not send someone to reconnect a store that reconnecting doesn't fix. Only stores in error, which are few.
  const problems = new Map<string, ReturnType<typeof syncProblem>>();
  for (const s of stores.filter((s) => s.status === "error")) {
    const failed = await tx.syncJob.findFirst({ where: { storeId: s.id, workspaceId: ws, status: "failed" }, orderBy: { createdAt: "desc" }, select: { error: true } });
    problems.set(s.id, syncProblem(failed?.error));
  }
  return stores.map((store) => ({
    store,
    imported: { orders: orderCount.get(store.id) ?? 0, products: productCount.get(store.id) ?? 0 },
    syncProblem: problems.get(store.id) ?? null,
    // Where the store's dates begin (storeStartDay), so the date pickers know before the first numbers load.
    startDay: storeStartDay(store.shopCreatedAt, store.timezone, oldestOrderDay.get(store.id) ?? null),
  }));
}

/** A store's 20 latest sync jobs, newest first. */
export async function recentSyncJobs(tx: Tx, ws: string, storeId: string) {
  const jobs = await tx.syncJob.findMany({ where: { storeId, workspaceId: ws }, orderBy: { createdAt: "desc" }, take: 20 });
  return jobs.map((j) => ({ id: j.id, kind: j.kind, status: j.status, progress: j.progress, error: j.error, finishedAt: j.finishedAt }));
}

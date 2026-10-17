import type { Store, Tx } from "@app/db";
import { comparisonImported, delta, localDay, resolveCapabilities, summarize, yearBreakdown, type Comparison, type DateRange } from "@app/shared";
import { adsConfigured } from "../adConnections.js";
import { declaredOptionalScopes, declaredScopes } from "../scopes.js";
import { adsenseModule, adsModule } from "./ads.js";
import { catalog, importedData, inventory } from "./catalog.js";
import type { Scope } from "./common.js";
import { funnel } from "./funnel.js";
import { channels, discountCodes, fulfillment, orderTiming, recentOrders, traffic } from "./orders.js";
import { comparisonRows, dailyRows, dailySeries, topProducts } from "./sales.js";

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
  // The worker records a 401/403 as "Shopify rejected our access (403); ..." (AccessRevokedError).
  if (/Shopify auth error|rejected our access|is not connected/.test(error)) return "access";
  return "other";
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
 * The caller has checked that `store` belongs to the workspace and resolved the dates.
 */
export async function storeOverview(tx: Tx, store: Store, dates: { range: DateRange; previous: Comparison }, now = new Date(), sees: (module: string) => boolean = () => true) {
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
    optionalScopes: declaredOptionalScopes(),
    declaredScopes: declaredScopes(),
  });
  const enabled = new Set(capabilities.filter((c) => c.enabled && sees(c.id)).map((c) => c.id));
  const modules: Record<string, unknown> = {};
  const data = await importedData(tx, scope);
  // A comparison reaching back before the first imported order (Shopify shares 60 days without
  // read_all_orders) would count a period mostly missing: its order figures and changes are left
  // out (null), and the page says there is no earlier data, rather than show a fake drop or 0%.
  const previousImported = comparisonImported(previous, data.oldestOrderDay);
  const change = (now: number | null, before: number | null) => (previousImported ? delta(now, before) : null);

  let hasData = false;
  if (enabled.has("sales_overview") || enabled.has("refunds") || enabled.has("customers")) {
    // While the range is still running, the comparison stops at the same time of day (Shopify's like-for-like).
    const [cur, prev] = await Promise.all([dailyRows(tx, ws, storeId, range), previousImported ? comparisonRows(tx, ws, storeId, previous, store.timezone) : []]);
    const c = summarize(cur);
    const p = summarize(prev);
    hasData = cur.some((r) => r.orders > 0 || r.refunds > 0);
    if (enabled.has("sales_overview")) {
      // Shopify's "Total sales breakdown", line for line: gross − discounts − returns = net sales,
      // + shipping + taxes (+ duties and fees) = total sales.
      modules.sales_overview = {
        current: {
          grossSales: c.grossSales,
          discounts: c.discounts,
          returns: c.refunds,
          netSales: c.netSales,
          totalSales: c.totalSales,
          orders: c.orders,
          units: c.units,
          averageOrderValue: c.averageOrderValue,
          tax: c.taxes,
          shipping: c.shipping,
        },
        previous: previousImported
          ? {
              grossSales: p.grossSales,
              netSales: p.netSales,
              totalSales: p.totalSales,
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
        // This calendar year month by month, whatever the dates picked. Reaches back to the
        // December before so January has something to compare with.
        year: yearBreakdown(await dailyRows(tx, ws, storeId, { from: `${Number(today.slice(0, 4)) - 1}-12-01`, to: today }), today, data.oldestOrderDay),
      };
    }
    if (enabled.has("refunds")) {
      modules.refunds = {
        current: { refunds: c.refunds, refundRate: c.refundRate, refundedOrders: cur.reduce((a, r) => a + r.refundedOrders, 0) },
        deltas: { refunds: change(c.refunds, p.refunds) },
      };
    }
    if (enabled.has("customers")) {
      modules.customers = {
        current: { returningCustomerRate: c.returningCustomerRate },
        previous: { returningCustomerRate: previousImported ? p.returningCustomerRate : null },
      };
    }
  }

  if (enabled.has("top_products")) modules.top_products = await topProducts(tx, scope, range);

  if (enabled.has("funnel")) modules.funnel = await funnel(tx, scope, range, previous, store.timezone);

  // Not a Shopify capability: present once an ad account is connected to the store.
  const netSales = (modules.sales_overview as { current?: { netSales?: number } } | undefined)?.current?.netSales ?? null;
  if (sees("ads")) {
    const ads = await adsModule(tx, scope, range, previous, store.currency, netSales);
    if (ads) modules.ads = ads;
  }
  if (sees("adsense")) {
    const adsense = await adsenseModule(tx, scope, range, previous, store.currency, netSales);
    if (adsense) modules.adsense = adsense;
  }
  if (sees("ad_connections")) {
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
  if (enabled.has("recent_orders")) modules.recent_orders = await recentOrders(tx, scope);
  if (enabled.has("inventory")) modules.inventory = await inventory(tx, scope, today);
  if (enabled.has("catalog")) modules.catalog = await catalog(tx, scope, range);

  const failed =
    store.status === "error"
      ? await tx.syncJob.findFirst({ where: { storeId, workspaceId: ws, status: "failed" }, orderBy: { createdAt: "desc" }, select: { error: true } })
      : null;
  return {
    // Only while the store is in error: why, so the page can say what will fix it.
    syncProblem: store.status === "error" ? syncProblem(failed?.error) : null,
    // The store's today, so the page can tell a finished day from one still running.
    today,
    // False: the imported orders don't reach back to the comparison, so no order figure is compared.
    previousImported,
    capabilities,
    modules,
    hasData,
    data,
  };
}

/** A workspace's connected stores, with how many orders and products each holds. */
export async function workspaceStores(tx: Tx, ws: string) {
  // `imported` is what lets the settings card tell "connected and holding your data" apart from
  // "connected and holding nothing", which look identical from scopes and lastSyncedAt alone.
  // Two grouped queries for the whole workspace, not one pair per store.
  const stores = await tx.store.findMany({ where: { workspaceId: ws, status: { not: "uninstalled" } }, orderBy: { createdAt: "asc" } });
  const orders = await tx.order.groupBy({ by: ["storeId"], where: { workspaceId: ws }, _count: { _all: true } });
  const products = await tx.product.groupBy({ by: ["storeId"], where: { workspaceId: ws }, _count: { _all: true } });
  const countBy = (rows: Array<{ storeId: string; _count: { _all: number } }>) => new Map(rows.map((r) => [r.storeId, r._count._all]));
  const orderCount = countBy(orders);
  const productCount = countBy(products);
  return stores.map((store) => ({ store, imported: { orders: orderCount.get(store.id) ?? 0, products: productCount.get(store.id) ?? 0 } }));
}

/** A store's 20 latest sync jobs, newest first. */
export async function recentSyncJobs(tx: Tx, ws: string, storeId: string) {
  const jobs = await tx.syncJob.findMany({ where: { storeId, workspaceId: ws }, orderBy: { createdAt: "desc" }, take: 20 });
  return jobs.map((j) => ({ id: j.id, kind: j.kind, status: j.status, progress: j.progress, error: j.error, finishedAt: j.finishedAt }));
}

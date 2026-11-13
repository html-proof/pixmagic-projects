import { z } from "zod";
import { withTenant } from "@app/db";
import { AD_PROVIDERS, allows, COUNTRY_CODE, DATE_PRESETS, FUNNEL_DEVICES, isFunnelAction, redactOverview, resolvePreset, salesCalculationInput, seesModule, SITE_SECTIONS, TRAFFIC_SOURCES, VISITOR_KINDS, type FunnelFilter, type MemberAccess, type RangeLimits, type ShopifyMarketing } from "@app/shared";
import {
  audit,
  latestReconciliation,
  logger,
  requestShopifyMarketing,
  requestShopifyReports,
  revocableOptionalScopesFor,
  revocableScopes,
  saveSalesCalculation,
  startReconciliation,
  storeSalesCalculation,
  type ReportRequest,
} from "@app/core";
import { PRODUCT_SORTS, productPerformance, recentSyncJobs, storeLimits, storeOverview, workspaceStores, type AdsView, type FunnelView } from "@app/core/reports";
import { body, clientIp, HttpError, requireWorkspace, type Deps } from "../context.js";
import type { App } from "../app.js";
import { autoRefresh } from "../sync.js";
import { limit, LIMITS } from "../rateLimit.js";

/**
 * The dates asked about, as the dashboard and its downloads ask: `preset=7d`,
 * `preset=custom&from=…&to=…`. They are compared with the period just before them
 * (`resolvePreset` in @app/shared).
 */
export const datesQuery = {
  preset: z.enum(DATE_PRESETS).default("30d"),
  from: z.string().optional(),
  to: z.string().optional(),
};
type DatesQuery = z.infer<z.ZodObject<typeof datesQuery>>;

/**
 * What the Advertising pages narrow the ad figures to: `platform=meta|google|adsense`, `account=<an ad
 * connection's id>` (AdsView in core: figures for some of the spend are never set against the store's
 * whole sales).
 */
export const adsViewQuery = {
  platform: z.enum(AD_PROVIDERS).optional(),
  account: z.string().min(1).max(64).optional(),
};

/**
 * What the Shopping Funnel page narrows the visit figures to (FunnelFilter in @app/shared):
 * `device=mobile|tablet|desktop|unknown`, `visitor=new|returning`, `landing=<site section>`,
 * `country=<ISO 3166 code>`, `source=<traffic source>`.
 */
export const funnelQuery = {
  device: z.enum(FUNNEL_DEVICES).optional(),
  visitor: z.enum(VISITOR_KINDS).optional(),
  landing: z.enum(SITE_SECTIONS).optional(),
  country: z.string().regex(COUNTRY_CODE).optional(),
  source: z.enum(TRAFFIC_SOURCES).optional(),
};
type FunnelQuery = z.infer<z.ZodObject<typeof funnelQuery>>;

/**
 * The Shopping Funnel page's question, for the member asking: product sales only with the top
 * products permission, and visits by traffic source only with the traffic sources one (without it
 * a `source` asked for is left out, and the answer's `filter` says what was applied).
 */
export function funnelViewOf(q: FunnelQuery, access: MemberAccess): FunnelView {
  const sources = seesModule(access, "traffic");
  const filter: FunnelFilter = {};
  if (q.device) filter.device = q.device;
  if (q.visitor) filter.visitor = q.visitor;
  if (q.landing) filter.landing = q.landing;
  if (q.country) filter.country = q.country;
  if (q.source && sources) filter.source = q.source;
  return { filter, productSales: seesModule(access, "top_products"), sources };
}

/**
 * `parts=advertising`: only what the Advertising pages show (the ad modules, where Meta's and
 * Google's figures come from, the spend their apps report to Shopify and their figures from the
 * store's own orders, and the store's sales, Shopify sessions, traffic, customers and refunds they're
 * set against, with Shopify's product costs and the owner's own costs for the profitability figures),
 * with every campaign; the rest of the dashboard isn't computed.
 * `parts=funnel`: only what the Shopping Funnel page shows (the funnel in full, narrowed by
 * `funnelQuery`, and the orders, Shopify sessions and traffic sources beside it).
 * `parts=sheet`: only what the Profit sheet shows (/sheet): the sales day by day, the visits day by
 * day beside the funnel's summary, the ad spend day by day, and for its profit rows the product costs
 * day by day and the owner's costs with their terms.
 */
const ADVERTISING_MODULES: ReadonlySet<string> = new Set([
  "ads",
  "adsense",
  "ad_connections",
  "ad_configured",
  "ad_sources",
  "ads_from_shopify",
  "shopify_marketing",
  "shopify_sessions",
  "sales_overview",
  "channels",
  "traffic",
  "customers",
  "refunds",
  "profit",
  "expenses",
]);
const FUNNEL_MODULES: ReadonlySet<string> = new Set(["funnel", "shopify_sessions", "sales_overview", "channels", "traffic"]);
const SHEET_MODULES: ReadonlySet<string> = new Set(["sales_overview", "funnel", "ads", "ad_connections", "product_costs", "expenses"]);
const overviewQuery = z.object({ ...datesQuery, ...adsViewQuery, ...funnelQuery, parts: z.enum(["advertising", "funnel", "sheet"]).optional() });

/**
 * The dates in the store's zone, at most 12 months at a time, within the store's `limits`
 * (`storeLimits` in core: custom dates no earlier than its first day once Shopify's creation date is
 * known; without them, from 2000). Custom dates that can't be reported on are a 400
 * `invalid_range`.
 */
export function resolveQueryDates(q: DatesQuery, now: Date, timeZone: string, limits: RangeLimits = {}) {
  try {
    return resolvePreset(q.preset, now, timeZone, q.from && q.to ? { from: q.from, to: q.to } : undefined, limits);
  } catch (e) {
    throw new HttpError(400, (e as Error).message, "invalid_range");
  }
}

/**
 * `revocableScopes` is computed with the same helper the revoke endpoint enforces with, rather
 * than being re-derived in the browser: the UI must not offer to give back a scope the API would
 * then refuse. It is empty in the shipped configuration, where nothing is declared optional.
 */
export function publicStore(s: {
  id: string;
  shopDomain: string;
  shopifyAppKey: string;
  name: string | null;
  timezone: string;
  currency: string;
  status: string;
  grantedScopes: string[];
  pixelInstalled: boolean;
  lastSyncedAt: Date | null;
  installedAt: Date | null;
  shopCreatedAt: Date | null;
}) {
  return {
    id: s.id,
    shopDomain: s.shopDomain,
    name: s.name,
    timezone: s.timezone,
    currency: s.currency,
    status: s.status,
    grantedScopes: s.grantedScopes,
    revocableScopes: revocableScopes(s.grantedScopes, s.grantedScopes, revocableOptionalScopesFor(s)),
    pixelInstalled: s.pixelInstalled,
    lastSyncedAt: s.lastSyncedAt,
    installedAt: s.installedAt,
    // When Shopify created the store (null until its details are read): where its dates begin.
    shopCreatedAt: s.shopCreatedAt,
  };
}

export function dashboardRoutes(app: App, deps: Deps) {
  app.get("/workspaces/:ws/stores/:storeId/analytics/products/top-selling", async (c) => {
    const { ws, storeId } = c.req.param();
    await requireWorkspace(c, deps, ws, "products.performance");
    const q = z.object({
      ...datesQuery,
      dateFrom: z.string().optional(), dateTo: z.string().optional(),
      sortBy: z.enum(PRODUCT_SORTS).default("units"), direction: z.enum(["asc", "desc"]).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(100), page: z.coerce.number().int().min(1).max(100).default(1),
      search: z.string().max(200).optional(), productId: z.string().max(100).optional(), collectionId: z.string().max(100).optional(),
    }).parse(c.req.query());
    return c.json(await withTenant(ws, async tx => {
      const store = await tx.store.findFirst({ where: { id: storeId, workspaceId: ws } });
      if (!store) throw new HttpError(404, "Not found", "not_found");
      if (!["orders", "products"].every(resource => store.grantedScopes.some(s => s === `read_${resource}` || s === `write_${resource}`))) throw new HttpError(403, "Order and product access are required. Reconnect the store with the required access.", "missing_scope");
      if (!!q.dateFrom !== !!q.dateTo) throw new HttpError(400, "Both dateFrom and dateTo are required", "invalid_range");
      const now = new Date();
      const limits = await storeLimits(tx, { ws, storeId }, store);
      const dates = resolveQueryDates(q.dateFrom && q.dateTo ? { ...q, preset: "custom", from: q.dateFrom, to: q.dateTo } : q, now, store.timezone, limits);
      return productPerformance(tx, { ws, storeId }, store, dates.range, q);
    }));
  });
  app.get("/workspaces/:ws/stores", async (c) => {
    const { ws } = c.req.param();
    const { access } = await requireWorkspace(c, deps, ws, "dashboard:read");
    const stores = await withTenant(ws, (tx) => workspaceStores(tx, ws));
    // Every member gets the store picker; how many orders and products each store holds is for
    // those who see the stores' connection (Settings → Stores), as the dashboard's answer keeps a
    // store's size from members who see neither its orders nor its products (redactOverview).
    const counts = allows(access, "integrations.status");
    return c.json({ stores: stores.map(({ store, imported, syncProblem, startDay }) => ({ ...publicStore(store), ...(counts ? { imported } : {}), syncProblem, startDay })) });
  });

  // The import's progress and its failures: the Shopify connection's status page.
  app.get("/workspaces/:ws/stores/:storeId/sync", async (c) => {
    const { ws, storeId } = c.req.param();
    await requireWorkspace(c, deps, ws, "integrations.status");
    return c.json(await withTenant(ws, async (tx) => {
      const store = await tx.store.findFirst({ where: { id: storeId, workspaceId: ws } });
      if (!store) throw new HttpError(404, "Not found", "not_found");
      return { store: publicStore(store), jobs: await recentSyncJobs(tx, ws, storeId) };
    }));
  });

  /**
   * One call returns everything the dashboard needs (packages/core/src/reports): modules the
   * store's scopes enable, and for the others what's missing, never placeholder numbers. A member
   * gets only the modules and fields their permissions cover (Team & Access): the rest is neither
   * computed nor sent.
   */
  app.get("/workspaces/:ws/stores/:storeId/overview", async (c) => {
    const { ws, storeId } = c.req.param();
    const { access } = await requireWorkspace(c, deps, ws, "dashboard:read");
    const q = overviewQuery.parse(c.req.query());
    const advertising = q.parts === "advertising";
    const adsView: AdsView = advertising ? { platform: q.platform, account: q.account, allCampaigns: true, fromShopify: true } : {};
    const only = advertising ? ADVERTISING_MODULES : q.parts === "funnel" ? FUNNEL_MODULES : q.parts === "sheet" ? SHEET_MODULES : null;
    const sees = (m: string) => (!only || only.has(m)) && seesModule(access, m);
    const funnelView = q.parts === "funnel" ? funnelViewOf(q, access) : undefined;

    let polled: Parameters<typeof autoRefresh>[1] | null = null;
    let reports: ReportRequest[] = [];
    let marketingFirstRead = false;
    const body = await withTenant(ws, async (tx) => {
      const store = await tx.store.findFirst({ where: { id: storeId, workspaceId: ws } });
      if (!store) throw new HttpError(404, "Not found", "not_found");
      polled = store;
      const now = new Date();
      const dates = resolveQueryDates(q, now, store.timezone, await storeLimits(tx, { ws, storeId }, store));
      const report = redactOverview(await storeOverview(tx, store, dates, now, sees, adsView, funnelView, { visitsByDay: q.parts === "sheet", profitByDay: q.parts === "sheet" }), access);
      reports = report.shopifyRefresh;
      // Granted Shopify's reports and never read its marketing report: read it now rather than at the next tick.
      marketingFirstRead = (report.modules.shopify_marketing as ShopifyMarketing | undefined)?.status === "syncing";
      return {
        store: publicStore(store),
        syncProblem: report.syncProblem,
        // The dates as they were asked for, so a panel that asks about them again (Sales by
        // collection) gets the same days on both sides: "this week" is compared with the same days
        // of the week before, which the same days picked by hand are not.
        preset: q.preset,
        range: dates.range,
        // What the range is compared with (the period just before).
        previous: dates.previous,
        today: report.today,
        // When the numbers last matched Shopify, and any changes still waiting (dataFreshness in core).
        freshness: report.freshness,
        // The last check against Shopify's own records (outcome only; checkSummary in core).
        check: report.check,
        capabilities: report.capabilities,
        modules: report.modules,
        hasData: report.hasData,
        data: report.data,
      };
    });
    // The dashboard polls this every 15 s: use that to keep the store fresh from Shopify.
    if (polled) {
      await autoRefresh(deps, polled).catch((err) => logger.warn({ err, storeId }, "auto refresh failed"));
      // Shopify's own report figures this answer lacked or held stale: the worker fetches them, a later poll shows them.
      if (reports.length) await requestShopifyReports(deps, polled, reports).catch((err) => logger.warn({ err, storeId }, "shopify reports request failed"));
      if (marketingFirstRead) await requestShopifyMarketing(deps, polled, "recent").catch((err) => logger.warn({ err, storeId }, "shopify marketing request failed"));
    }
    return c.json(body);
  });

  /**
   * The Shopping Funnel's checklist: mark a recommended action done for the store, or not done
   * (FUNNEL_ACTIONS in @app/shared). Anyone who sees the funnel may tick it, as the team's shared
   * list; a shared (view-only) dashboard and API keys can't.
   */
  app.put("/workspaces/:ws/stores/:storeId/funnel/actions/:actionId", async (c) => {
    const { ws, storeId, actionId } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, "analytics.conversion");
    if (a.link || !a.user) throw new HttpError(403, "The shared dashboard is view-only.", "forbidden");
    if (!isFunnelAction(actionId)) throw new HttpError(404, "Not found", "not_found");
    const { done } = z.object({ done: z.boolean() }).parse(await body(c));
    const userId = a.user.id;
    const result = await withTenant(ws, async (tx) => {
      const store = await tx.store.findFirst({ where: { id: storeId, workspaceId: ws }, select: { id: true } });
      if (!store) throw new HttpError(404, "Not found", "not_found");
      if (!done) {
        await tx.funnelActionCheck.deleteMany({ where: { workspaceId: ws, storeId, actionId } });
        return { id: actionId, done: false, doneAt: null };
      }
      const row = await tx.funnelActionCheck.upsert({
        where: { storeId_actionId: { storeId, actionId } },
        create: { workspaceId: ws, storeId, actionId, doneBy: userId },
        update: {},
      });
      return { id: actionId, done: true, doneAt: row.doneAt.toISOString() };
    });
    await audit({ workspaceId: ws, actorUserId: userId, action: done ? "funnel.action_done" : "funnel.action_undone", targetType: "store", targetId: storeId, metadata: { action: actionId }, ip: clientIp(c) }).catch(
      (err: unknown) => logger.warn({ err }, "audit failed"),
    );
    return c.json(result);
  });

  /**
   * The last check against Shopify with its figures: Shopify's, ours before and after any repair,
   * and why they differed (packages/core/src/reconcile.ts). The figures are the sales breakdown, so
   * they need finance.breakdown (owners and admins hold it).
   */
  app.get("/workspaces/:ws/stores/:storeId/check", async (c) => {
    const { ws, storeId } = c.req.param();
    await requireWorkspace(c, deps, ws, "finance.breakdown");
    return c.json(await withTenant(ws, async (tx) => {
      const store = await tx.store.findFirst({ where: { id: storeId, workspaceId: ws }, select: { id: true } });
      if (!store) throw new HttpError(404, "Not found", "not_found");
      return latestReconciliation(tx, { ws, storeId });
    }));
  });

  /** Check the last 7 finished days against Shopify now (the daily check runs by itself as well). */
  app.post("/workspaces/:ws/stores/:storeId/check", async (c) => {
    const { ws, storeId } = c.req.param();
    await requireWorkspace(c, deps, ws, "integrations.manage");
    const store = await withTenant(ws, (tx) => tx.store.findFirst({ where: { id: storeId, workspaceId: ws } }));
    if (!store) throw new HttpError(404, "Not found", "not_found");
    if (store.status !== "active") throw new HttpError(409, "The store must be connected and imported before it can be checked.", "store_not_ready");
    await limit(deps.coord, `rl:check:${store.id}`, LIMITS.storeCheck);
    const started = await startReconciliation(deps, store, "manual");
    if (!started) throw new HttpError(409, "There is no finished day to check yet.", "nothing_to_check");
    return c.json(started, 202);
  });

  /**
   * The store's own sales calculation (Custom sales, docs/kpis.md): which lines of Shopify's total
   * sales it counts. Its figures are drawn from the sales breakdown, so reading it needs
   * finance.breakdown; the overview carries it too.
   */
  app.get("/workspaces/:ws/stores/:storeId/sales-calculation", async (c) => {
    const { ws, storeId } = c.req.param();
    await requireWorkspace(c, deps, ws, "finance.breakdown");
    return c.json(await withTenant(ws, async (tx) => {
      const store = await tx.store.findFirst({ where: { id: storeId, workspaceId: ws }, select: { id: true } });
      if (!store) throw new HttpError(404, "Not found", "not_found");
      return { calculation: await storeSalesCalculation(tx, { ws, storeId }) };
    }));
  });

  /**
   * Save it, for everyone who opens the store's dashboard: owners and admins only (it changes what
   * the whole team sees), never a shared link. Only the choice of lines is kept, never an amount,
   * and Shopify's own figures are untouched. Each change is in the audit log, before and after.
   */
  app.put("/workspaces/:ws/stores/:storeId/sales-calculation", async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, "stores:manage");
    const input = salesCalculationInput.parse(await body(c));
    const { saved, before } = await withTenant(ws, async (tx) => {
      const store = await tx.store.findFirst({ where: { id: storeId, workspaceId: ws }, select: { id: true } });
      if (!store) throw new HttpError(404, "Not found", "not_found");
      return saveSalesCalculation(tx, { ws, storeId }, input, a.user?.id ?? null);
    });
    await audit({
      workspaceId: ws,
      actorUserId: a.user?.id ?? null,
      action: "sales_calculation.changed",
      targetType: "store",
      targetId: storeId,
      metadata: {
        before: { components: before.components, label: before.label, applyToDashboard: before.applyToDashboard, presets: before.presets.length },
        after: { components: saved.components, label: saved.label, applyToDashboard: saved.applyToDashboard, presets: saved.presets.length },
      },
      ip: clientIp(c),
    }).catch((err: unknown) => logger.warn({ err }, "audit failed"));
    return c.json({ calculation: saved });
  });
}

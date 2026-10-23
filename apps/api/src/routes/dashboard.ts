import { z } from "zod";
import { withTenant } from "@app/db";
import { AD_PROVIDERS, COMPARE_MODES, DATE_PRESETS, redactOverview, resolvePreset, salesCalculationInput, seesModule, type RangeLimits } from "@app/shared";
import {
  audit,
  latestReconciliation,
  logger,
  requestShopifyReports,
  revocableScopes,
  saveSalesCalculation,
  startReconciliation,
  storeSalesCalculation,
  type ReportRequest,
} from "@app/core";
import { PRODUCT_SORTS, productPerformance, recentSyncJobs, storeLimits, storeOverview, workspaceStores, type AdsView } from "@app/core/reports";
import { body, clientIp, HttpError, requireWorkspace, type Deps } from "../context.js";
import type { App } from "../app.js";
import { autoRefresh } from "../sync.js";
import { limit, LIMITS } from "../rateLimit.js";

/**
 * The dates asked about and what they are compared with, as the dashboard and its downloads ask:
 * `preset=7d`, `preset=custom&from=…&to=…`, plus `compare=year` or `compare=custom&cfrom=…&cto=…`
 * (the period just before when absent).
 */
export const datesQuery = {
  preset: z.enum(DATE_PRESETS).default("30d"),
  from: z.string().optional(),
  to: z.string().optional(),
  compare: z.enum(COMPARE_MODES).default("previous"),
  cfrom: z.string().optional(),
  cto: z.string().optional(),
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
 * `parts=advertising`: only what the Advertising pages show (the ad modules, and the store's sales
 * and traffic they're set against), with every campaign; the rest of the dashboard isn't computed.
 */
const ADVERTISING_MODULES: ReadonlySet<string> = new Set(["ads", "adsense", "ad_connections", "ad_configured", "sales_overview", "channels", "traffic"]);
const overviewQuery = z.object({ ...datesQuery, ...adsViewQuery, parts: z.enum(["advertising"]).optional() });

/**
 * The dates in the store's zone, within its `limits` (`storeLimits` in core): All time from its first
 * day, custom dates no earlier than Shopify's creation date, of any length. Without them (the
 * Inventory pages, which offer neither All time nor more than a year) the general limits apply:
 * from 2000, up to a year. Custom dates or comparison dates that can't be reported on are a 400
 * `invalid_range`.
 */
export function resolveQueryDates(q: DatesQuery, now: Date, timeZone: string, limits: RangeLimits = {}) {
  try {
    return resolvePreset(
      q.preset,
      now,
      timeZone,
      q.from && q.to ? { from: q.from, to: q.to } : undefined,
      { mode: q.compare, from: q.cfrom, to: q.cto },
      limits,
    );
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
    revocableScopes: revocableScopes(s.grantedScopes, s.grantedScopes),
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
      return productPerformance(tx, { ws, storeId }, store, dates.range, q, now);
    }));
  });
  app.get("/workspaces/:ws/stores", async (c) => {
    const { ws } = c.req.param();
    await requireWorkspace(c, deps, ws, "dashboard:read");
    const stores = await withTenant(ws, (tx) => workspaceStores(tx, ws));
    return c.json({ stores: stores.map(({ store, imported, syncProblem, startDay }) => ({ ...publicStore(store), imported, syncProblem, startDay })) });
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
    const adsView: AdsView = advertising ? { platform: q.platform, account: q.account, allCampaigns: true } : {};
    const sees = (m: string) => (!advertising || ADVERTISING_MODULES.has(m)) && seesModule(access, m);

    let polled: Parameters<typeof autoRefresh>[1] | null = null;
    let reports: ReportRequest[] = [];
    const body = await withTenant(ws, async (tx) => {
      const store = await tx.store.findFirst({ where: { id: storeId, workspaceId: ws } });
      if (!store) throw new HttpError(404, "Not found", "not_found");
      polled = store;
      const now = new Date();
      const dates = resolveQueryDates(q, now, store.timezone, await storeLimits(tx, { ws, storeId }, store));
      const report = redactOverview(await storeOverview(tx, store, dates, now, sees, adsView), access);
      reports = report.shopifyRefresh;
      return {
        store: publicStore(store),
        syncProblem: report.syncProblem,
        range: dates.range,
        // What the range is compared with, how it was chosen, and whether the imported orders reach back to it.
        // All time is compared with the period before it whatever was asked (resolvePreset).
        previous: { ...dates.previous, compare: q.preset === "all" ? "previous" : q.compare, imported: report.previousImported },
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
    }
    return c.json(body);
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

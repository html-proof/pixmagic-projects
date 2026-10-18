import { z } from "zod";
import { withTenant } from "@app/db";
import { COMPARE_MODES, DATE_PRESETS, redactOverview, resolvePreset, seesModule } from "@app/shared";
import { latestReconciliation, logger, requestShopifyReports, revocableScopes, startReconciliation, type ReportRequest } from "@app/core";
import { recentSyncJobs, storeOverview, workspaceStores } from "@app/core/reports";
import { HttpError, requireWorkspace, type Deps } from "../context.js";
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
const querySchema = z.object(datesQuery);
type DatesQuery = z.infer<typeof querySchema>;

/** The dates in the store's zone; custom dates or comparison dates that can't be reported on are a 400 `invalid_range`. */
export function resolveQueryDates(q: DatesQuery, now: Date, timeZone: string) {
  try {
    return resolvePreset(q.preset, now, timeZone, q.from && q.to ? { from: q.from, to: q.to } : undefined, { mode: q.compare, from: q.cfrom, to: q.cto });
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

export function dashboardRoutes(app: App, deps: Deps) {
  app.get("/workspaces/:ws/stores", async (c) => {
    const { ws } = c.req.param();
    await requireWorkspace(c, deps, ws, "dashboard:read");
    const stores = await withTenant(ws, (tx) => workspaceStores(tx, ws));
    return c.json({ stores: stores.map(({ store, imported, syncProblem }) => ({ ...publicStore(store), imported, syncProblem })) });
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
    const q = querySchema.parse(c.req.query());

    let polled: Parameters<typeof autoRefresh>[1] | null = null;
    let reports: ReportRequest[] = [];
    const body = await withTenant(ws, async (tx) => {
      const store = await tx.store.findFirst({ where: { id: storeId, workspaceId: ws } });
      if (!store) throw new HttpError(404, "Not found", "not_found");
      polled = store;
      const now = new Date();
      const dates = resolveQueryDates(q, now, store.timezone);
      const report = redactOverview(await storeOverview(tx, store, dates, now, (m) => seesModule(access, m)), access);
      reports = report.shopifyRefresh;
      return {
        store: publicStore(store),
        syncProblem: report.syncProblem,
        range: dates.range,
        // What the range is compared with, how it was chosen, and whether the imported orders reach back to it.
        previous: { ...dates.previous, compare: q.compare, imported: report.previousImported },
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
}

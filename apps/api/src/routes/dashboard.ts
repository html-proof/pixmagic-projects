import { z } from "zod";
import { withTenant } from "@app/db";
import { DATE_PRESETS, resolvePreset } from "@app/shared";
import { logger, revocableScopes } from "@app/core";
import { recentSyncJobs, storeOverview, workspaceStores } from "@app/core/reports";
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

export function dashboardRoutes(app: App, deps: Deps) {
  app.get("/workspaces/:ws/stores", async (c) => {
    const { ws } = c.req.param();
    await requireWorkspace(c, deps, ws, "dashboard:read");
    const stores = await withTenant(ws, (tx) => workspaceStores(tx, ws));
    return c.json({ stores: stores.map(({ store, imported }) => ({ ...publicStore(store), imported })) });
  });

  app.get("/workspaces/:ws/stores/:storeId/sync", async (c) => {
    const { ws, storeId } = c.req.param();
    await requireWorkspace(c, deps, ws, "dashboard:read");
    return c.json(await withTenant(ws, async (tx) => {
      const store = await tx.store.findFirst({ where: { id: storeId, workspaceId: ws } });
      if (!store) throw new HttpError(404, "Not found", "not_found");
      return { store: publicStore(store), jobs: await recentSyncJobs(tx, ws, storeId) };
    }));
  });

  /**
   * One call returns everything the dashboard needs (packages/core/src/reports): modules the
   * store's scopes enable, and for the others what's missing, never placeholder numbers.
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
      let dates;
      try {
        dates = resolvePreset(q.preset, now, store.timezone, q.from && q.to ? { from: q.from, to: q.to } : undefined);
      } catch (e) {
        throw new HttpError(400, (e as Error).message, "invalid_range");
      }
      const report = await storeOverview(tx, store, dates, now);
      return {
        store: publicStore(store),
        syncProblem: report.syncProblem,
        range: dates.range,
        previous: dates.previous,
        today: report.today,
        capabilities: report.capabilities,
        modules: report.modules,
        hasData: report.hasData,
        data: report.data,
      };
    });
    // The dashboard polls this every 15 s: use that to keep the store fresh from Shopify.
    if (polled) {
      await autoRefresh(deps, polled).catch((err) => logger.warn({ err, storeId }, "auto refresh failed"));
    }
    return c.json(body);
  });
}

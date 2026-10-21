import { z } from "zod";
import { withTenant } from "@app/db";
import { DATE_PRESETS, resolvePreset } from "@app/shared";
import { buildDashboardReport, publicStore, logger } from "@app/core";
import { HttpError, requireWorkspace, type Deps } from "../context.js";
import type { App } from "../app.js";
import { autoRefresh } from "../sync.js";

// Preserve imports used by existing consumers while the implementation lives in core.
export { publicStore, syncProblem } from "@app/core";

const querySchema = z.object({
  preset: z.enum(DATE_PRESETS).default("30d"),
  from: z.string().optional(),
  to: z.string().optional(),
});

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
      return buildDashboardReport(tx, store, resolved, now);
    });
    // The dashboard polls this every 15 s: use that to keep the store fresh from Shopify.
    if (polled) {
      await autoRefresh(deps, polled).catch((err) => logger.warn({ err, storeId }, "auto refresh failed"));
    }
    return c.json(body);
  });
}

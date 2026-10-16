import { withTenant } from "@app/db";
import { audit, customerDataExport, resolveAlerts } from "@app/core";
import { clientIp, HttpError, requireWorkspace, type Deps } from "../context.js";
import type { App } from "../app.js";

/** Shopify expects a data request answered within 30 days of receiving it. */
const ANSWER_WITHIN_MS = 30 * 86_400_000;

/**
 * Settings → Privacy requests: the customers/data_request webhooks Shopify sent for the
 * workspace's stores, and the export of each customer's data for the owner to pass on
 * (packages/core/src/privacy.ts). The export holds a customer's personal data, so it is for the
 * people who can read the audit log (owners and admins), and every download is audited.
 */
export function privacyRoutes(app: App, deps: Deps) {
  app.get("/workspaces/:ws/privacy-requests", async (c) => {
    const { ws } = c.req.param();
    await requireWorkspace(c, deps, ws, "audit:read");
    const items = await withTenant(ws, async (tx) => {
      const rows = await tx.dataRequest.findMany({ where: { workspaceId: ws }, orderBy: { receivedAt: "desc" }, take: 100 });
      const stores = await tx.store.findMany({ where: { workspaceId: ws, id: { in: [...new Set(rows.map((r) => r.storeId))] } }, select: { id: true, shopDomain: true, name: true } });
      const byId = new Map(stores.map((s) => [s.id, s]));
      return rows.map((r) => ({
        id: r.id,
        store: byId.get(r.storeId) ?? null,
        customerId: r.customerId,
        ordersRequested: r.ordersRequested.length,
        receivedAt: r.receivedAt,
        answerBy: new Date(r.receivedAt.getTime() + ANSWER_WITHIN_MS),
        downloadedAt: r.downloadedAt,
      }));
    });
    return c.json({ items });
  });

  app.get("/workspaces/:ws/privacy-requests/:id/export", async (c) => {
    const { ws, id } = c.req.param();
    const access = await requireWorkspace(c, deps, ws, "audit:read");
    const { request, data, pending } = await withTenant(ws, async (tx) => {
      const request = await tx.dataRequest.findFirst({ where: { id, workspaceId: ws } });
      if (!request) throw new HttpError(404, "Not found", "not_found");
      const data = await customerDataExport(tx, request);
      await tx.dataRequest.update({ where: { id: request.id }, data: { downloadedAt: new Date() } });
      const pending = await tx.dataRequest.count({ where: { workspaceId: ws, storeId: request.storeId, downloadedAt: null } });
      return { request, data, pending };
    });
    // The owner has what they need: the "privacy request" alert can close once none is waiting.
    if (pending === 0) await resolveAlerts(request.storeId, ["privacy_request"]);
    await audit({
      workspaceId: ws,
      actorUserId: access.user?.id,
      action: "gdpr.data_request_downloaded",
      targetType: "data_request",
      targetId: request.id,
      ip: clientIp(c),
    });
    c.header("content-disposition", `attachment; filename="customer-data-${request.customerId ?? request.id}.json"`);
    c.header("cache-control", "no-store");
    return c.json(data);
  });
}

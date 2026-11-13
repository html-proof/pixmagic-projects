import { withTenant } from "@app/db";
import { integrationsStatus, metaDiscovery } from "@app/core/integrations";
import { HttpError, requireWorkspace, type Deps } from "../context.js";
import type { App } from "../app.js";

/**
 * Every connection of a store in one answer: Shopify, Meta Ads, Google Ads, Google AdSense and
 * WhatsApp, each with where it stands on one scale of six statuses worked out here, not in the
 * browser (core's integrations/status.ts, @app/shared/integrations; docs/api/api-overview.md), its
 * accounts, the figures it brings and what this caller may do with it. Read-only: each action is
 * done on the provider's own routes (ads.ts, whatsapp.ts, workspaces.ts).
 *
 * "View integration connection status" lets someone in; what they may do is worked out from the rest
 * of their access. A shared link and an API key only look.
 */
export function integrationsRoutes(app: App, deps: Deps) {
  app.get("/workspaces/:ws/stores/:storeId/integrations", async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, "integrations.status");
    const store = await withTenant(ws, (tx) => tx.store.findFirst({ where: { id: storeId, workspaceId: ws } }));
    if (!store || store.status === "uninstalled") throw new HttpError(404, "Not found", "not_found");
    return c.json(await integrationsStatus(store, { access: a.access, acts: !!a.user && !a.link }));
  });

  /**
   * Meta, found through the store's Shopify connection: one of six states (@app/shared/metaDiscovery),
   * what the store's Shopify orders show of Facebook and Instagram, the Meta assets bizinsights reads,
   * and what this caller is offered: nothing, their own Meta sign-in for another store (POST
   * .../ads/meta/reuse), or Meta's sign-in. Shopify's own Meta access never counts as bizinsights':
   * Meta seen only in Shopify is CONNECTED_IN_SHOPIFY, marked CONNECTED_IN_SHOPIFY_BUT_NOT_AUTHORIZED_FOR_OUR_APP.
   * The order counts follow the caller's traffic and attribution permissions, as the dashboard's do.
   */
  app.get("/workspaces/:ws/stores/:storeId/meta/discovery", async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, "integrations.status");
    const store = await withTenant(ws, (tx) => tx.store.findFirst({ where: { id: storeId, workspaceId: ws } }));
    if (!store || store.status === "uninstalled") throw new HttpError(404, "Not found", "not_found");
    return c.json(await metaDiscovery(store, { access: a.access, acts: !!a.user && !a.link, userId: a.user?.id ?? null }));
  });
}

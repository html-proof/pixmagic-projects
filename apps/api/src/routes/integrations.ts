import { withTenant } from "@app/db";
import { integrationsStatus } from "@app/core/integrations";
import { HttpError, requireWorkspace, type Deps } from "../context.js";
import type { App } from "../app.js";
import { smsDeps } from "./smsCommon.js";

/**
 * Every connection of a store in one answer: Shopify, Meta Ads, Google Ads, Google AdSense, WhatsApp,
 * SMS and email, each with where it stands on one scale of six statuses worked out here, not in the
 * browser (core's integrations/status.ts, @app/shared/integrations; docs/api/api-overview.md), its
 * accounts, the figures it brings and what this caller may do with it. Read-only: each action is
 * done on the provider's own routes (ads.ts, whatsapp.ts, automations.ts, workspaces.ts).
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
    const viewer = { access: a.access, acts: !!a.user && !a.link };
    return c.json(await integrationsStatus(store, viewer, { ...smsDeps(deps), smtpConnect: deps.smtpConnect }));
  });
}

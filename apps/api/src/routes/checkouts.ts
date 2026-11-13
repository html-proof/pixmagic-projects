import { z } from "zod";
import { withTenant, type Store } from "@app/db";
import { hasCapability, localDay } from "@app/shared";
import { logger, requestShopifyReports, type ReportRequest } from "@app/core";
import { abandonedCheckoutsModule, storeLimits } from "@app/core/reports";
import { HttpError, requireWorkspace, type Deps } from "../context.js";
import type { App } from "../app.js";
import { datesQuery, resolveQueryDates } from "./dashboard.js";

const query = z.object(datesQuery);

/**
 * Shopify's own abandoned checkouts for the dashboard's dates and what they are compared with
 * (core reports/abandonedCheckouts.ts): how many, their value, how many were recovered. The
 * Shopping Funnel page polls it.
 *
 * It answers from what the worker keeps and queues what is missing or stale, so a poll never waits
 * on Shopify. Counts, money and dates only, never who the shoppers were: "View checkout abandonment"
 * is enough (the customer lists, GET .../contacts, need their own permissions).
 */
export function checkoutRoutes(app: App, deps: Deps) {
  app.get("/workspaces/:ws/stores/:storeId/abandoned-checkouts", async (c) => {
    const { ws, storeId } = c.req.param();
    await requireWorkspace(c, deps, ws, "analytics.abandonment");
    let polled: Store | null = null;
    let refresh: ReportRequest[] = [];
    const body = await withTenant(ws, async (tx) => {
      const store = await tx.store.findFirst({ where: { id: storeId, workspaceId: ws } });
      if (!store) throw new HttpError(404, "Not found", "not_found");
      if (!hasCapability(store.grantedScopes, "abandoned_checkouts")) throw new HttpError(403, "bizinsights needs access to your orders first.", "missing_scopes");
      // The question is read once the store is known to be this workspace's (another's answers 404, not 400).
      const q = query.parse(c.req.query());
      const now = new Date();
      const dates = resolveQueryDates(q, now, store.timezone, await storeLimits(tx, { ws, storeId }, store));
      const answer = await abandonedCheckoutsModule(tx, store, dates, { today: localDay(now, store.timezone), now });
      polled = store;
      refresh = answer.refresh;
      return { range: dates.range, previous: dates.previous, module: answer.module };
    });
    // What Shopify hasn't answered yet, or answered a while ago: the worker asks, a later poll shows it.
    if (polled && refresh.length) await requestShopifyReports(deps, polled, refresh).catch((err) => logger.warn({ err, storeId }, "abandoned checkouts request failed"));
    return c.json(body);
  });
}

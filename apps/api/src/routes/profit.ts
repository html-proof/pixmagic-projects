import { z } from "zod";
import { withTenant } from "@app/db";
import { allows, isMonth, localDay, seesModule } from "@app/shared";
import { profitReport } from "@app/core/reports";
import { HttpError, requireWorkspace, type Deps } from "../context.js";
import type { App } from "../app.js";

/**
 * The Profit sheet's profit and loss (docs/kpis.md "Profit and loss"): a month's days, the month, and
 * the 12 months ending with it, from the store's sales, its products' costs, the ad spend and the
 * owner's costs (core's profitReport). Revenue takes shipping and fees, so it needs "View gross
 * sales, discounts, tax, shipping and total sales" (finance.breakdown, which shows the costs list too)
 * with the sales; product costs and the ad spend each need their own permission, and without it the
 * profit they would give away isn't given (the answer says they're hidden). Read-only: a shared link
 * and API keys may read it as they read the dashboard.
 */
export function profitRoutes(app: App, deps: Deps) {
  app.get("/workspaces/:ws/stores/:storeId/profit", async (c) => {
    const { ws, storeId } = c.req.param();
    const { access } = await requireWorkspace(c, deps, ws, "finance.breakdown");
    if (!allows(access, "analytics.sales")) throw new HttpError(403, "You don't have permission to do that", "forbidden");
    return c.json(
      await withTenant(ws, async (tx) => {
        // The store first: another workspace's store is a 404, whatever the question.
        const store = await tx.store.findFirst({ where: { id: storeId, workspaceId: ws } });
        if (!store) throw new HttpError(404, "Not found", "not_found");
        const now = new Date();
        const thisMonth = localDay(now, store.timezone).slice(0, 7);
        const { month } = z.object({ month: z.string().refine((m) => isMonth(m) && m >= "2000-01", "A month, YYYY-MM").optional() }).parse(c.req.query());
        if (month && month > thisMonth) throw new HttpError(400, "That month hasn't started yet.", "invalid_month");
        return profitReport(tx, store, month ?? thisMonth, now, {
          productCosts: seesModule(access, "product_costs"),
          ads: seesModule(access, "ads"),
          refunds: allows(access, "finance.refunds"),
        });
      }),
    );
  });
}

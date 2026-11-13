import { z } from "zod";
import { withTenant } from "@app/db";
import { hasCapability } from "@app/shared";
import { collectionSales } from "@app/core/reports";
import { HttpError, requireWorkspace, type Deps } from "../context.js";
import type { App } from "../app.js";
import { datesQuery, resolveQueryDates } from "./dashboard.js";

const query = z.object(datesQuery);

/**
 * Sales by collection (core reports/collections.ts): each Shopify collection's net sales, units
 * and orders for the dashboard's dates. Top products'
 * figures grouped another way, so the same permission ("View product performance") and the same
 * access (orders and products) as GET .../analytics/products/top-selling.
 *
 * The products page asks as the dashboard was asked: the same preset, or the same custom dates
 * (apps/web/src/components/dashboard/collectionDates.ts). A preset's dates may start before the store's first day (the last 90 days of a store a
 * month old), which dates picked in the date picker may not: that limit isn't applied here, and
 * days before the store simply have no sales.
 */
export function collectionRoutes(app: App, deps: Deps) {
  app.get("/workspaces/:ws/stores/:storeId/analytics/collections/sales", async (c) => {
    const { ws, storeId } = c.req.param();
    await requireWorkspace(c, deps, ws, "products.performance");
    return c.json(
      await withTenant(ws, async (tx) => {
        const store = await tx.store.findFirst({ where: { id: storeId, workspaceId: ws } });
        if (!store) throw new HttpError(404, "Not found", "not_found");
        if (!hasCapability(store.grantedScopes, "top_products")) {
          throw new HttpError(403, "Order and product access are required. Reconnect the store with the required access.", "missing_scope");
        }
        // The question is read once the store is known to be this workspace's (another's answers 404, not 400).
        const q = query.parse(c.req.query());
        const dates = resolveQueryDates(q, new Date(), store.timezone);
        return { range: dates.range, ...(await collectionSales(tx, { ws, storeId }, store, dates.range)) };
      }),
    );
  });
}

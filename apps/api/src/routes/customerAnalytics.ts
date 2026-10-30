import { z } from "zod";
import { withTenant } from "@app/db";
import { allows, hasCapability } from "@app/shared";
import { COHORT_MONTHS, MAX_COHORT_MONTHS } from "@app/shared/customers";
import { customerAnalytics } from "@app/core/reports";
import { HttpError, requireWorkspace, type Deps } from "../context.js";
import type { App } from "../app.js";
import { datesQuery, resolveQueryDates } from "./dashboard.js";

const query = z.object({ ...datesQuery, months: z.coerce.number().int().min(1).max(MAX_COHORT_MONTHS).default(COHORT_MONTHS) });

/**
 * Customer lifetime figures and monthly first-order cohorts (core reports/customers.ts,
 * docs/customer-analytics.md): repeat customers, orders and net sales per customer for the dates,
 * and each first-order month's customers coming back month by month. The Customers page's own
 * report, so "View returning vs new customers" and the access the New vs returning figures need
 * (orders and customers), as the dashboard's customers module.
 *
 * The Customers page asks with the dashboard's own dates written out as custom dates, as Sales by
 * collection does: the store's first-day limit of picked dates isn't applied (a preset's dates may
 * start before it), and the dates are counted from the first day customers are known anyway.
 *
 * Inside it, what tells the store's size goes only to those who see it on the dashboard: order
 * counts (and where the orders begin) with sales or the order list, net sales per customer with
 * sales; otherwise customers × net sales per customer would be the store's net sales.
 */
export function customerAnalyticsRoutes(app: App, deps: Deps) {
  app.get("/workspaces/:ws/stores/:storeId/analytics/customers", async (c) => {
    const { ws, storeId } = c.req.param();
    const { access } = await requireWorkspace(c, deps, ws, "customers.analytics");
    return c.json(
      await withTenant(ws, async (tx) => {
        const scope = { ws, storeId };
        const store = await tx.store.findFirst({ where: { id: storeId, workspaceId: ws } });
        if (!store) throw new HttpError(404, "Not found", "not_found");
        if (!hasCapability(store.grantedScopes, "customers")) {
          throw new HttpError(403, "bizinsights needs access to your orders and customers first.", "missing_scope");
        }
        // The question is read once the store is known to be this workspace's (another's answers 404, not 400).
        const q = query.parse(c.req.query());
        const now = new Date();
        const dates = resolveQueryDates(q, now, store.timezone);
        const view = { months: q.months, orders: allows(access, ["analytics.sales", "orders.list"]), money: allows(access, "analytics.sales") };
        return { range: dates.range, months: q.months, ...(await customerAnalytics(tx, scope, store, dates.range, now, view)) };
      }),
    );
  });
}

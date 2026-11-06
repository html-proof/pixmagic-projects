import { z } from "zod";
import { withTenant } from "@app/db";
import { orderList, storeLimits } from "@app/core/reports";
import { allows, hasCapability, ORDER_CANCELLED_FILTERS, ORDER_FIELD_ACCESS, ORDER_LIST_SORTS, PAYMENT_GROUPS, redactOrderRows, SHIPPING_GROUPS, type OrderListPage } from "@app/shared";
import { HttpError, requireWorkspace, type Deps } from "../context.js";
import type { App } from "../app.js";
import { datesQuery, resolveQueryDates } from "./dashboard.js";

/** The dashboard's dates (`datesQuery`), then the list's own question (OrderListQuery in @app/shared). */
const query = z.object({
  ...datesQuery,
  q: z.string().trim().max(40).optional(),
  payment: z.enum(PAYMENT_GROUPS).optional(),
  shipping: z.enum(SHIPPING_GROUPS).optional(),
  cancelled: z.enum(ORDER_CANCELLED_FILTERS).optional(),
  sort: z.enum(ORDER_LIST_SORTS).default("newest"),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(10).max(100).default(25),
});

/** Each filter on a field of the order rows that needs its own permission (ORDER_FIELD_ACCESS), and what that field is called. */
const FILTERS = [
  { filter: "payment", field: "financialStatus", what: "payment status" },
  { filter: "shipping", field: "fulfillmentStatus", what: "fulfillment status" },
  { filter: "cancelled", field: "cancelled", what: "cancellations" },
] as const;

/**
 * The Orders & shipping page's list: a page of the store's orders placed in the dashboard's dates
 * (core reports/orders.ts `orderList`, the same orders and fields as the overview's recent orders),
 * searched by order number and filtered by payment, shipping and cancellation.
 *
 * Needs "View order list". Each order's payment status, fulfillment status and cancelled flag need
 * their own permission and are left out without it, as on the overview (`redactOrderRows`); a filter
 * on one of them is refused without it (403), so it can't tell what the field hides. Reads from the
 * database only, so it is under the global per-IP limit alone, as the other lists are.
 */
export function orderRoutes(app: App, deps: Deps) {
  app.get("/workspaces/:ws/stores/:storeId/orders", async (c) => {
    const { ws, storeId } = c.req.param();
    const { access } = await requireWorkspace(c, deps, ws, "orders.list");
    const body: OrderListPage = await withTenant(ws, async (tx) => {
      const store = await tx.store.findFirst({ where: { id: storeId, workspaceId: ws } });
      if (!store) throw new HttpError(404, "Not found", "not_found");
      if (!hasCapability(store.grantedScopes, "recent_orders")) throw new HttpError(403, "bizinsights needs access to your orders first.", "missing_scopes");
      // The question is read once the store is known to be this workspace's (another's answers 404, not 400).
      const q = query.parse(c.req.query());
      for (const f of FILTERS) {
        if (q[f.filter] !== undefined && !allows(access, ORDER_FIELD_ACCESS[f.field])) {
          throw new HttpError(403, `You don't have permission to see ${f.what}, so you can't filter orders by it.`, "forbidden");
        }
      }
      const dates = resolveQueryDates(q, new Date(), store.timezone, await storeLimits(tx, { ws, storeId }, store));
      const page = await orderList(tx, { ws, storeId }, dates.range, q);
      return { range: dates.range, total: page.total, page: page.page, pageSize: page.pageSize, items: redactOrderRows(page.items, access) };
    });
    return c.json(body);
  });
}

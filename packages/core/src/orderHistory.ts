import { Prisma, systemDb, type OrderHistoryWindow, type Store, type Tx } from "@app/db";
import { expandScopes, localDay, startOfLocalDay } from "@app/shared";

/**
 * A store's full order history (read_all_orders), imported one store-local calendar year at a time,
 * newest first (table order_history_windows).
 *
 * Why years, and not the whole history as one export: Shopify's bulk export of five years of orders
 * with their sales records can run for hours, and the worker stops polling an export after about an
 * hour and walks the same orders page by page instead, at Shopify's query-cost pace of about 7 orders
 * every 9 seconds. One year is a fraction of that, and a year that fails is all that is read again.
 * Newest first, so the dates people look at most fill in first, and the dashboard can say which
 * years are in while older ones are still coming (`orderHistoryStatus`).
 *
 * Without read_all_orders none of this applies: Shopify shares the last 60 days, read as one window
 * (`ordersSearch` in the worker).
 *
 * Years go by order creation date, as Shopify's order search filters (`created_at`), with every
 * boundary the start of 1 January in the store's time zone, shared by the two years either side of
 * it, so no order falls between them. The newest year runs on to now, the oldest from the store's
 * first order back: its search has no lower bound, and its `fromAt` is the epoch, which is what
 * `stores.orders_history_from` holds for a store whose whole history is in.
 */

/** One year of the plan: orders created from `fromAt` (the epoch for the oldest) up to `toAt` (null for the newest: up to now). */
export interface HistoryWindowPlan {
  year: number;
  fromAt: Date;
  toAt: Date | null;
}

/** Every year from the one `oldestCreatedAt` falls in (store-local) to `now`'s, newest first. */
export function planHistoryWindows(oldestCreatedAt: Date, now: Date, timeZone: string): HistoryWindowPlan[] {
  const thisYear = Number(localDay(now, timeZone).slice(0, 4));
  const firstYear = Math.min(thisYear, Number(localDay(oldestCreatedAt, timeZone).slice(0, 4)));
  const newYear = (y: number) => startOfLocalDay(`${String(y).padStart(4, "0")}-01-01`, timeZone);
  const plan: HistoryWindowPlan[] = [];
  for (let y = thisYear; y >= firstYear; y--) {
    plan.push({ year: y, fromAt: y === firstYear ? new Date(0) : newYear(y), toAt: y === thisYear ? null : newYear(y + 1) });
  }
  return plan;
}

/** Shopify's order search for one year of the plan; null (no filter: every order) for a plan of one year. */
export function historyWindowSearch(w: Pick<OrderHistoryWindow, "fromAt" | "toAt">): string | null {
  const parts: string[] = [];
  if (w.fromAt.getTime() > 0) parts.push(`created_at:>='${w.fromAt.toISOString()}'`);
  if (w.toAt) parts.push(`created_at:<'${w.toAt.toISOString()}'`);
  return parts.length ? parts.join(" AND ") : null;
}

const sameTime = (a: Date | null, b: Date | null) => (a === null || b === null ? a === b : a.getTime() === b.getTime());

/**
 * Plan a full history import for the orders job `jobId`, or resume the store's unfinished one, and
 * return the first year to read (null: the store has no orders, nothing to read).
 *
 * `oldestCreatedAt` asks Shopify when the store's first order was created (OLDEST_ORDER_QUERY).
 *
 * A plan is resumed only while it is unfinished (a year not done: the import before stopped part
 * way) and was read with the customer as this one would be (read_customers): its finished years are
 * kept, everything else is read again. A finished plan is started over, since a new full import is
 * asked for because something changed (read_customers granted, a store whose sync broke). The newest
 * year runs up to now, so it is always read again: orders kept coming while the import was stopped.
 */
export async function startOrderHistory(
  store: Pick<Store, "id" | "workspaceId" | "timezone" | "grantedScopes">,
  jobId: string,
  oldestCreatedAt: () => Promise<Date | null>,
  now = new Date(),
): Promise<OrderHistoryWindow | null> {
  const oldest = await oldestCreatedAt();
  const existing = await systemDb.orderHistoryWindow.findMany({ where: { storeId: store.id } });
  if (!oldest) {
    await systemDb.orderHistoryWindow.deleteMany({ where: { storeId: store.id } });
    return null;
  }
  const withCustomers = expandScopes(store.grantedScopes).has("read_customers");
  const resumable = existing.some((w) => w.status !== "done") && existing.every((w) => w.withCustomers === withCustomers);
  const byYear = new Map(existing.map((w) => [w.year, w]));
  const plan = planHistoryWindows(oldest, now, store.timezone);
  const kept = (p: HistoryWindowPlan) => {
    const w = byYear.get(p.year);
    return resumable && p.toAt !== null && !!w && w.status === "done" && sameTime(w.fromAt, p.fromAt) && sameTime(w.toAt, p.toAt);
  };
  await systemDb.$transaction([
    systemDb.orderHistoryWindow.deleteMany({ where: { storeId: store.id, year: { notIn: plan.map((p) => p.year) } } }),
    ...plan.map((p) =>
      kept(p)
        ? systemDb.orderHistoryWindow.update({ where: { storeId_year: { storeId: store.id, year: p.year } }, data: { planJobId: jobId, syncJobId: jobId } })
        : systemDb.orderHistoryWindow.upsert({
            where: { storeId_year: { storeId: store.id, year: p.year } },
            create: { workspaceId: store.workspaceId, storeId: store.id, planJobId: jobId, syncJobId: jobId, year: p.year, fromAt: p.fromAt, toAt: p.toAt, withCustomers },
            update: {
              planJobId: jobId,
              syncJobId: jobId,
              fromAt: p.fromAt,
              toAt: p.toAt,
              withCustomers,
              status: "queued",
              orders: 0,
              bulkOperationId: null,
              attempts: 0,
              error: null,
              startedAt: null,
              finishedAt: null,
            },
          }),
    ),
  ]);
  return nextHistoryYear(store.id);
}

/** The newest year of the store's plan not read yet, or null when every one is in. */
export async function nextHistoryYear(storeId: string): Promise<OrderHistoryWindow | null> {
  return systemDb.orderHistoryWindow.findFirst({ where: { storeId, status: { not: "done" } }, orderBy: { year: "desc" } });
}

/** A year's import has begun (its first message): running, for job `jobId`, one more attempt. */
export async function startHistoryWindow(windowId: string, jobId: string): Promise<void> {
  const now = new Date();
  await systemDb.orderHistoryWindow.update({
    where: { id: windowId },
    data: { status: "running", syncJobId: jobId, attempts: { increment: 1 }, error: null, startedAt: now, finishedAt: null },
  });
  await systemDb.syncJob.update({ where: { id: jobId }, data: { lastActivityAt: now } });
}

/** The bulk export submitted (or adopted) for a year, so a later year never reads it as its own. */
export async function recordHistoryExport(windowId: string, bulkOperationId: string): Promise<void> {
  await systemDb.orderHistoryWindow.update({ where: { id: windowId }, data: { bulkOperationId } });
}

/** The orders of a year (by creation, as its search) and the days they and their sales fall on. */
function windowOrders(storeId: string, w: Pick<OrderHistoryWindow, "fromAt" | "toAt">) {
  const to = w.toAt ? Prisma.sql`AND o.shopify_created_at < ${w.toAt}` : Prisma.empty;
  return Prisma.sql`SELECT o.id, o.local_day FROM orders o WHERE o.store_id = ${storeId} AND o.shopify_created_at >= ${w.fromAt} ${to}`;
}

/**
 * A year is in: count what it holds and mark it done; move the store's history start back to it once
 * every newer year is done too (stores.orders_history_from: the oldest year's is the epoch, the whole
 * history). Returns the days whose totals to recompute (its orders' days, and the days their sales
 * happened on, a refund in a later year included) and the next year to read (null: that was the last).
 */
export async function finishHistoryWindow(store: Pick<Store, "id">, w: OrderHistoryWindow): Promise<{ days: string[]; next: OrderHistoryWindow | null }> {
  const orders = windowOrders(store.id, w);
  const [counted] = await systemDb.$queryRaw<Array<{ n: number }>>`SELECT COUNT(*)::int AS n FROM (${orders}) w`;
  const days = await systemDb.$queryRaw<Array<{ day: string }>>`
    SELECT w.local_day AS day FROM (${orders}) w
    UNION
    SELECT s.local_day AS day FROM order_sales s JOIN (${orders}) w ON w.id = s.order_id WHERE s.store_id = ${store.id}`;
  const now = new Date();
  await systemDb.orderHistoryWindow.update({ where: { id: w.id }, data: { status: "done", orders: counted?.n ?? 0, error: null, finishedAt: now } });
  await systemDb.syncJob.update({ where: { id: w.syncJobId }, data: { lastActivityAt: now } }).catch(() => undefined);
  const newerOpen = await systemDb.orderHistoryWindow.count({ where: { storeId: store.id, year: { gt: w.year }, status: { not: "done" } } });
  if (!newerOpen) {
    await systemDb.store.updateMany({
      where: { id: store.id, OR: [{ ordersHistoryFrom: null }, { ordersHistoryFrom: { gt: w.fromAt } }] },
      data: { ordersHistoryFrom: w.fromAt },
    });
  }
  return { days: days.map((d) => d.day), next: await nextHistoryYear(store.id) };
}

/** The import job `syncJobId` gave up: the year it was reading failed, and says why. */
export async function failHistoryWindows(syncJobId: string, error: string): Promise<void> {
  await systemDb.orderHistoryWindow.updateMany({ where: { syncJobId, status: "running" }, data: { status: "failed", error: error.slice(0, 500), finishedAt: new Date() } });
}

export type HistoryWindowStatus = "queued" | "running" | "done" | "failed";

/**
 * The store's full history import, year by year, newest first, for the dashboard: which years are
 * in, which is being read, and which failed (Shopify's reason stays in the logs). Empty for a store
 * without read_all_orders, or before its first full import has planned its years.
 */
export async function orderHistoryStatus(tx: Tx, { ws, storeId }: { ws: string; storeId: string }) {
  const rows = await tx.orderHistoryWindow.findMany({
    where: { workspaceId: ws, storeId },
    orderBy: { year: "desc" },
    select: { year: true, status: true, orders: true, finishedAt: true },
  });
  return rows.map((r) => ({ year: r.year, status: r.status as HistoryWindowStatus, orders: r.orders, finishedAt: r.finishedAt }));
}

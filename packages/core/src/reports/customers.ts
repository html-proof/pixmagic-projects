import { Prisma, type Store, type Tx } from "@app/db";
import { firstWholeDay, localDay, type DateRange } from "@app/shared";
import {
  acquiredTotals,
  addMonths,
  COHORT_MONTHS,
  cohortGrid,
  customerFigures,
  customerHistoryStart,
  customersKnownDay,
  type Cohort,
  type CohortCount,
  type CustomerFigures,
  type FigureOptions,
} from "@app/shared/customers";
import { importedData } from "./catalog.js";
import { MERCHANDISE, num, SALE_VALUE, type Scope } from "./common.js";

/** What this member may see beside the customer counts (the API decides, from Team & Access). */
export interface CustomerAnalyticsView {
  /** First-order months in the cohort table, newest first (1 to MAX_COHORT_MONTHS). */
  months?: number;
  /** Order counts: orders per customer, orders without a known customer. */
  orders: boolean;
  /** Net sales per customer. */
  money: boolean;
}

/** Customers in the dates on screen, counted from the first day customers are known. */
export interface CustomerDates extends DateRange {
  /** The dates asked for began before customers are known: counted from `customersFrom`. */
  clamped: boolean;
  figures: CustomerFigures;
  /** Orders in the dates with no known customer: guest checkouts, redacted customers, orders read before Your customers was granted. */
  withoutCustomer?: number;
  /** With net sales: the customers' orders whose sales aren't read from Shopify yet (net sales wait for them). */
  salesPending?: number;
  /** With net sales: their orders whose sales were never read and won't be (`SALES_REREAD_DAYS`): net sales stay unknown. */
  salesUnread?: number;
}

export interface CustomerCohorts {
  /** The first day the cohorts read: customers who first bought from this day on are in them. */
  from: string;
  items: Cohort[];
  /** Everyone in the cohorts listed, together: lifetime-to-date figures of customers who first bought since `from`. */
  acquired: CustomerFigures;
  /** Customers who ordered since `from` whose first order was before it: in no cohort. */
  returningFromBefore: number;
  /** With net sales: the cohorts' orders whose sales aren't read from Shopify yet (their cohorts' net sales wait for them). */
  salesPending?: number;
  /** With net sales: the cohorts' orders whose sales were never read and won't be: their cohorts have no net sales. */
  salesUnread?: number;
}

/**
 * Orders whose sales records were never read are read again while they were created in the last 60
 * days (apps/worker sweeps.ts `seedSalesRereads`, apps/api sync.ts `needsReread`): within them
 * they are still to come; older ones (stored before bizinsights read Shopify's sales records, say)
 * stay unread, and their net sales unknown, for good.
 */
export const SALES_REREAD_DAYS = 60;

type DatesRaw = { customers: number; repeat_customers: number; orders: number; without_customer: number; pending: number; unread: number; net_sales: string | null };
type CohortRaw = { cohort: string | null; month: string | null; first_buyers: number; returned: number; orders: number; pending: number; unread: number; net_sales: string | null };

/**
 * Customer lifetime figures and monthly first-order cohorts (docs/customer-analytics.md), read
 * live from the orders stored, never predicted. Orders of gift cards only are left out, and their
 * customers with them, as Shopify's customer reports leave them out (`customerCounts`); cancelled
 * orders count as order history, as they do for the returning-customer flag.
 *
 * - Where it starts (`customersFrom`, `customerHistoryStart`): the first whole day whose orders are
 *   all imported and linked to their customer. Shopify shares 60 days of orders without
 *   read_all_orders, and orders read before the store granted read_customers have no customer.
 * - A customer's first order is the one Shopify counts as their first purchase
 *   (`orders.is_returning_customer` false, settled from Shopify's own position of the order,
 *   `settleReturningCustomers`): known even when their earlier orders were never imported, so a
 *   customer who first bought before the stored history is never put in a cohort as new.
 * - Customers are never stored, only a keyed hash on their orders (persist.ts `customerKey`); a
 *   redacted customer's orders lose it and drop out of every figure at once.
 *
 * Read when the Customers page asks, never in the dashboard's live poll. Each query is bounded by
 * the store's days (orders' (store_id, local_day) index): the dates on screen, and for the cohorts
 * at most MAX_COHORT_MONTHS months of orders with a known customer.
 */
export async function customerAnalytics(tx: Tx, scope: Scope, store: Store, range: DateRange, now: Date, view: CustomerAnalyticsView) {
  const { ws, storeId } = scope;
  const today = localDay(now, store.timezone);
  const data = await importedData(tx, scope, store);
  // The first whole day imported: the day after the one the import window started on; with the
  // whole history (the epoch), the first order's day; unrecorded (older imports), the history's start.
  const window = store.ordersHistoryFrom;
  const wholeFrom = !window ? data.historyFrom : window.getTime() <= 0 ? data.oldestOrderDay : firstWholeDay(window, store.timezone);
  // daily_store_metrics has a row a day (orders of gift cards only left out, as here): the cheap way
  // to the days whose orders had a known customer and those whose orders had none (customersKnownDay).
  // Before the first whole day, only the days with a known customer count: a few at most.
  const days = wholeFrom
    ? await tx.$queryRaw<Array<{ day: string; orders: number; with_customer: number }>>`
        SELECT day, orders, orders_with_customer AS with_customer FROM daily_store_metrics
        WHERE workspace_id = ${ws} AND store_id = ${storeId} AND orders > 0
          AND (day >= ${wholeFrom} OR orders_with_customer > 0)`
    : [];
  const known = wholeFrom ? customersKnownDay(days.map((d) => ({ day: d.day, orders: num(d.orders), withCustomer: num(d.with_customer) })), wholeFrom) : null;
  const customersFrom = customerHistoryStart(wholeFrom, known);
  const about = {
    today,
    importing: store.status === "pending" || store.status === "syncing",
    // Shown to everyone who sees the customers: their figures start there. It tells, within a day
    // or so, where the orders bizinsights holds begin, which isn't a sales or order figure.
    customersFrom,
    // How the orders' history can be had, and the orders' own start: with the order counts, as the
    // dashboard's own `data` (redactOverview).
    // `customersLater`: customers are known from later than the orders are all in (orders read
    // before the store granted read_customers, or only guests' orders, say nobody).
    ...(view.orders
      ? { historyFrom: data.historyFrom, historyAccess: data.history.access, customersLater: customersFrom !== null && wholeFrom !== null && customersFrom > wholeFrom }
      : {}),
  };
  if (customersFrom === null || customersFrom > today) return { ...about, dates: null, cohorts: null };
  const rereadFrom = new Date(now.getTime() - SALES_REREAD_DAYS * 86_400_000);
  return { ...about, dates: await customerDates(tx, scope, range, customersFrom, view, rereadFrom), cohorts: await customerCohorts(tx, scope, today, customersFrom, view, rereadFrom) };
}

/** Net sales are shown only once every order counted has its sales read from Shopify. */
const moneyOf = (view: CustomerAnalyticsView, unreadOrders: number): FigureOptions["money"] => (view.money ? (unreadOrders > 0 ? "withheld" : "shown") : undefined);

/**
 * The dates on screen, from `customersFrom` at the earliest: customers who ordered, those who
 * ordered twice or more in the dates, their orders, and the net sales of those orders as they stand
 * now (a return made since is taken off; product and adjustment lines, before tax and shipping,
 * the dashboard's net sales taken order by order). Null when the dates end before customers are known.
 * Orders whose sales aren't read: still to come (`salesPending`) or never (`salesUnread`, created
 * before `rereadFrom`); either withholds the net sales.
 */
async function customerDates(tx: Tx, { ws, storeId }: Scope, range: DateRange, customersFrom: string, view: CustomerAnalyticsView, rereadFrom: Date): Promise<CustomerDates | null> {
  const from = range.from < customersFrom ? customersFrom : range.from;
  if (from > range.to) return null;
  const sales = view.money
    ? Prisma.sql`(SELECT COALESCE(SUM(${SALE_VALUE}), 0) FROM order_sales s JOIN o ON o.id = s.order_id
         WHERE s.workspace_id = ${ws} AND s.store_id = ${storeId} AND o.customer_key IS NOT NULL AND ${MERCHANDISE})::text`
    : Prisma.sql`NULL::text`;
  const [r] = await tx.$queryRaw<DatesRaw[]>`
    WITH o AS MATERIALIZED (
      SELECT id, customer_key, sales_updated_at IS NULL AS pending, shopify_created_at < ${rereadFrom} AS past_reread FROM orders
      WHERE workspace_id = ${ws} AND store_id = ${storeId} AND NOT gift_card_only
        AND local_day BETWEEN ${from} AND ${range.to}
    ),
    c AS (SELECT customer_key, COUNT(*) AS n FROM o WHERE customer_key IS NOT NULL GROUP BY customer_key)
    SELECT (SELECT COUNT(*) FROM c)::int AS customers,
           (SELECT COUNT(*) FROM c WHERE n >= 2)::int AS repeat_customers,
           (SELECT COALESCE(SUM(n), 0) FROM c)::int AS orders,
           (SELECT COUNT(*) FROM o WHERE customer_key IS NULL)::int AS without_customer,
           (SELECT COUNT(*) FROM o WHERE customer_key IS NOT NULL AND pending AND NOT past_reread)::int AS pending,
           (SELECT COUNT(*) FROM o WHERE customer_key IS NOT NULL AND pending AND past_reread)::int AS unread,
           ${sales} AS net_sales`;
  const pending = view.money ? num(r?.pending) : 0;
  const unread = view.money ? num(r?.unread) : 0;
  const figures = customerFigures(
    { customers: num(r?.customers), repeatCustomers: num(r?.repeat_customers), orders: num(r?.orders), netSales: num(r?.net_sales) },
    { orders: view.orders, money: moneyOf(view, pending + unread) },
  );
  return {
    from,
    to: range.to,
    clamped: from !== range.from,
    figures,
    ...(view.orders ? { withoutCustomer: num(r?.without_customer) } : {}),
    ...(view.money ? { salesPending: pending, salesUnread: unread } : {}),
  };
}

/**
 * Monthly first-order cohorts (`cohortGrid`): the orders with a known customer from `from`, the
 * later of `customersFrom` and the first day of the oldest month listed, to today. A customer's
 * cohort is the month of their first order; their orders are counted in the months they were
 * placed in, by the store's days. A cohort with orders whose sales aren't read has no net sales
 * (`cohortGrid`), the others keep theirs; everyone together (`acquired`) has none while any has.
 */
async function customerCohorts(tx: Tx, { ws, storeId }: Scope, today: string, customersFrom: string, view: CustomerAnalyticsView, rereadFrom: Date): Promise<CustomerCohorts> {
  const months = view.months ?? COHORT_MONTHS;
  const oldest = `${addMonths(today.slice(0, 7), -(months - 1))}-01`;
  const from = customersFrom > oldest ? customersFrom : oldest;
  // Net sales of the cohorts' orders as they stand now (their product and adjustment lines, returns
  // since included), by the month of the order: summed per cell, never per order, which on a big
  // store spilled 270,000 groups to disk (300,000 orders over 24 months: 2.3 s against 1.5 s).
  const value = view.money
    ? Prisma.sql`,
    v AS (
      SELECT x.cohort, x.month, SUM(${SALE_VALUE}) AS value
      FROM x JOIN order_sales s ON s.order_id = x.id
      WHERE s.workspace_id = ${ws} AND s.store_id = ${storeId} AND ${MERCHANDISE}
      GROUP BY GROUPING SETS ((x.cohort, x.month), (x.cohort))
    )`
    : Prisma.empty;
  const rows = await tx.$queryRaw<CohortRaw[]>`
    WITH k AS MATERIALIZED (
      SELECT id, customer_key, local_day, is_returning_customer AS ret, sales_updated_at IS NULL AS pending, shopify_created_at < ${rereadFrom} AS past_reread FROM orders
      WHERE workspace_id = ${ws} AND store_id = ${storeId} AND customer_key IS NOT NULL AND NOT gift_card_only
        AND local_day BETWEEN ${from} AND ${today}
    ),
    -- Customers whose first purchase ever is in these days, and its day.
    f AS (SELECT customer_key, MIN(local_day) AS first_day FROM k WHERE NOT ret GROUP BY customer_key),
    x AS MATERIALIZED (
      SELECT k.id, k.customer_key, k.ret, k.pending, k.past_reread, left(f.first_day, 7) AS cohort, left(k.local_day, 7) AS month
      FROM k JOIN f ON f.customer_key = k.customer_key
      WHERE k.local_day >= f.first_day
    ),
    c AS (
      SELECT x.cohort, x.month,
             (COUNT(DISTINCT x.customer_key) FILTER (WHERE NOT x.ret))::int AS first_buyers,
             (COUNT(DISTINCT x.customer_key) FILTER (WHERE x.ret))::int AS returned,
             COUNT(*)::int AS orders,
             (COUNT(*) FILTER (WHERE x.pending AND NOT x.past_reread))::int AS pending,
             (COUNT(*) FILTER (WHERE x.pending AND x.past_reread))::int AS unread
      FROM x GROUP BY GROUPING SETS ((x.cohort, x.month), (x.cohort))
    )${value}
    SELECT c.cohort, c.month, c.first_buyers, c.returned, c.orders, c.pending, c.unread,
           ${view.money ? Prisma.sql`COALESCE(v.value, 0)::text` : Prisma.sql`NULL::text`} AS net_sales
    FROM c ${view.money ? Prisma.sql`LEFT JOIN v ON v.cohort = c.cohort AND v.month IS NOT DISTINCT FROM c.month` : Prisma.empty}
    UNION ALL
    -- Customers back in these days who first bought before them: never put in a cohort as new.
    SELECT NULL, NULL, 0, COUNT(DISTINCT k.customer_key)::int, 0, 0, 0, NULL
    FROM k WHERE NOT EXISTS (SELECT 1 FROM f WHERE f.customer_key = k.customer_key)`;
  const counts: CohortCount[] = rows
    .filter((r): r is CohortRaw & { cohort: string } => r.cohort !== null)
    .map((r) => ({ cohort: r.cohort, month: r.month, firstBuyers: num(r.first_buyers), returned: num(r.returned), orders: num(r.orders), ...(view.money ? { netSales: num(r.net_sales), unreadSales: num(r.pending) + num(r.unread) } : {}) }));
  const whole = rows.filter((r) => r.cohort !== null && r.month === null);
  const pending = view.money ? whole.reduce((a, r) => a + num(r.pending), 0) : 0;
  const unread = view.money ? whole.reduce((a, r) => a + num(r.unread), 0) : 0;
  // Shown cohort by cohort: one with orders whose sales aren't read withholds its own (cohortGrid).
  const items = cohortGrid(counts, { orders: view.orders, money: moneyOf(view, 0), today, from, customersFrom, months });
  return {
    from,
    items,
    acquired: customerFigures(acquiredTotals(counts, items), { orders: view.orders, money: moneyOf(view, pending + unread) }),
    returningFromBefore: num(rows.find((r) => r.cohort === null)?.returned),
    ...(view.money ? { salesPending: pending, salesUnread: unread } : {}),
  };
}


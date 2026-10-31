/**
 * Customer lifetime figures and monthly first-order cohorts (docs/customer-analytics.md): the
 * arithmetic over the counts the report's queries give (packages/core/src/reports/customers.ts),
 * kept here so it is tested on its own. Months are calendar months of the store's own days
 * ("YYYY-MM-DD", store-local), as Shopify's cohort report counts them.
 *
 * Nothing here is a prediction: every figure is what the stored orders say happened, and a month
 * that hasn't come yet has no figure at all (never 0). Customers are known only from the day the
 * orders carry them (`recordedCustomerStart` from the recorded grant, `customerHistoryStart` for a
 * store that granted before it was recorded), so a cohort whose month began before that is marked
 * partial instead of being read as a small one.
 */
// Without the ".js" the rest of the package uses, as ./sales does: a bundler importing this file
// directly (@app/shared/customers) doesn't map "./dates.js" to dates.ts.
import { addDays, firstWholeDay } from "./dates";

/** How many first-order months the cohort table lists unless asked for another number, and at most. */
export const COHORT_MONTHS = 12;
export const MAX_COHORT_MONTHS = 24;

const cents = (n: number) => Math.round(n * 100) / 100;

/** "2026-03" or "2026-03-14" → year × 12 + month − 1: months counted from year 0. */
export function monthIndex(day: string): number {
  return Number(day.slice(0, 4)) * 12 + Number(day.slice(5, 7)) - 1;
}

/** The month `n` calendar months after `month` ("YYYY-MM"; a negative `n` goes back): "2026-12", 1 → "2027-01". */
export function addMonths(month: string, n: number): string {
  const i = monthIndex(month) + n;
  return `${String(Math.floor(i / 12)).padStart(4, "0")}-${String((i % 12) + 1).padStart(2, "0")}`;
}

/** Calendar months from `a`'s month to `b`'s (days or months): 30 December → 2 January is 1. */
export const monthsBetween = (a: string, b: string): number => monthIndex(b) - monthIndex(a);

/** `total` per customer, or null without customers: never a 0 nobody counted. */
export const perCustomer = (total: number, customers: number): number | null => (customers > 0 ? total / customers : null);

/**
 * The first store-local day from which every order's customer is known, or null while none is,
 * inferred from the orders: for a store that granted read_customers before the grant was recorded
 * (stores.customers_from null; `recordedCustomerStart` otherwise).
 *
 * - `wholeFrom`: the first day whose orders were all imported (the day after the one the import
 *   window started on, `firstWholeDay` of stores.orders_history_from; the store's own history start
 *   when that isn't recorded).
 * - `known`: the day orders began to carry their customer (`customersKnownDay`), whether orders
 *   of an earlier day since `wholeFrom` are there (`unlinkedBefore`), whether one of that day itself
 *   has none (`unlinkedOn`), and whether an order before `wholeFrom` has one (`linkedBefore`: the
 *   import window's partial first day, say).
 *
 * Orders are linked to their customer only once the store grants read_customers. Granting it later
 * re-reads the last 60 days of orders, from a moment part way through a day: the orders before that
 * stay without a customer, and so may some of that day's. So once orders since `wholeFrom` went
 * without a customer, customers are known from the day they began to carry one, or the day after
 * when some of its orders have none. Guest checkouts have none either, so a store whose first days
 * had guest orders only starts a few days late.
 */
export function customerHistoryStart(wholeFrom: string | null, known: { day: string; unlinkedBefore: boolean; unlinkedOn: boolean; linkedBefore?: boolean } | null): string | null {
  if (wholeFrom === null || known === null) return null;
  // Nothing without a customer before it: linked from the start (that day's own unlinked orders are
  // guests when orders were linked before the window's first whole day too).
  if (known.day <= wholeFrom || (!known.unlinkedBefore && (!known.unlinkedOn || known.linkedBefore))) return wholeFrom;
  return known.unlinkedOn ? addDays(known.day, 1) : known.day;
}

/**
 * `customerHistoryStart` for a store whose grant of read_customers is recorded: `customersFrom`
 * (stores.customers_from), from when every stored order carries its customer. That moment is part
 * way through a day, which is only partly known (`firstWholeDay`); the epoch is the whole history
 * read with customers. Never before `wholeFrom`, the first day whose orders are all imported; null
 * while that isn't known.
 */
export function recordedCustomerStart(wholeFrom: string | null, customersFrom: Date, timeZone: string): string | null {
  if (wholeFrom === null) return null;
  if (customersFrom.getTime() <= 0) return wholeFrom;
  const day = firstWholeDay(customersFrom, timeZone);
  return day > wholeFrom ? day : wholeFrom;
}

/** One store-local day's orders (daily_store_metrics, gift cards only left out) and how many of them have a known customer. */
export interface CustomerDay {
  day: string;
  orders: number;
  withCustomer: number;
}

/** How well one share of orders with a customer fits `k` of `n` (binomial log-likelihood at its own rate; 0 for none or all). */
const shareFit = (k: number, n: number) => (k <= 0 || k >= n ? 0 : k * Math.log(k / n) + (n - k) * Math.log(1 - k / n));
/** How much likelier (log) a start after the first day with a known customer must make the orders than that day does. */
const LATER_START_EVIDENCE = 1;
/** The orders before a start have at most this part of the share with a customer that the orders from it on have. */
const BEFORE_START_SHARE = 1 / 3;

/**
 * `customerHistoryStart`'s `known`, from the days with orders: the day orders began to carry their
 * customer, or null while none does.
 *
 * Not simply the first day an order has one: a single order linked out of turn (an old order updated
 * since the grant, or one Shopify dates by when it was processed elsewhere, before it was created)
 * would put the start before weeks of orders read without their customer. Nor the day that best
 * splits days with a customer from days without: on a store whose sales are mostly guest checkouts or
 * walk-ins with no customer, days of the second kind outnumber the others all along, and the start
 * would go to its last days.
 *
 * So the orders since `wholeFrom` are read as two stretches, before the start and from it on, each with
 * its own share of orders that have a customer, and the start is the day with a known customer that
 * fits them best (the grant's re-read begins part way through a day: that day's orders without one
 * count as before it), where the share before is at most a third of the share after
 * (`BEFORE_START_SHARE`). A start later than the first day with a known customer has to fit clearly
 * better (`LATER_START_EVIDENCE`): a store whose first weeks had fewer customers by chance keeps its
 * first day. Days before `wholeFrom` only say whether orders were linked before it (`linkedBefore`).
 */
export function customersKnownDay(days: readonly CustomerDay[], wholeFrom: string): { day: string; unlinkedBefore: boolean; unlinkedOn: boolean; linkedBefore: boolean } | null {
  const inWindow = days.filter((d) => d.day >= wholeFrom && d.orders > 0).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  const linkedOf = (d: CustomerDay) => Math.max(0, Math.min(d.withCustomer, d.orders));
  const linked = inWindow.reduce((n, d) => n + linkedOf(d), 0);
  const orders = inWindow.reduce((n, d) => n + d.orders, 0);
  let first = -1;
  let firstFit = 0;
  let best = -1;
  let bestFit = -Infinity;
  let linkedSoFar = 0;
  let ordersSoFar = 0;
  for (let i = 0; i < inWindow.length; i++) {
    const d = inWindow[i]!;
    const withCustomer = linkedOf(d);
    if (withCustomer > 0) {
      const before = ordersSoFar + d.orders - withCustomer;
      const after = orders - before;
      const fit = shareFit(linkedSoFar, before) + shareFit(linked - linkedSoFar, after);
      if (first < 0) [first, firstFit] = [i, fit];
      const fewerBefore = linkedSoFar === 0 || linkedSoFar / before <= BEFORE_START_SHARE * ((linked - linkedSoFar) / after);
      if (fewerBefore && fit > bestFit) [best, bestFit] = [i, fit];
    }
    linkedSoFar += withCustomer;
    ordersSoFar += d.orders;
  }
  if (first < 0) return null;
  const pick = bestFit - firstFit > LATER_START_EVIDENCE ? best : first;
  const d = inWindow[pick]!;
  return { day: d.day, unlinkedBefore: pick > 0, unlinkedOn: d.orders > d.withCustomer, linkedBefore: days.some((x) => x.day < wholeFrom && x.withCustomer > 0) };
}

/** What a group of customers did, each customer once, from the report's queries. */
export interface CustomerTotals {
  customers: number;
  /** Customers with two orders or more among those counted. */
  repeatCustomers: number;
  /** Their orders, first orders included. */
  orders: number;
  /** Net sales of those orders (product and adjustment lines before tax, after discounts and any returns since). */
  netSales?: number;
}

/**
 * Figures per customer. `orders` and the net sales ones are there only for someone who may see
 * them (the API decides: the store's order counts and sales are other permissions than customers');
 * the net sales ones are null when they can't be known yet (`money: "withheld"`).
 */
export interface CustomerFigures {
  customers: number;
  repeatCustomers: number;
  /** repeatCustomers ÷ customers; null without customers. */
  repeatRate: number | null;
  orders?: number;
  ordersPerCustomer?: number | null;
  netSales?: number | null;
  netSalesPerCustomer?: number | null;
}

/**
 * What to show beside the customer counts: order counts (`orders`), and net sales, `"shown"`, or
 * `"withheld"` (null: some of the orders' sales aren't read from Shopify yet).
 */
export interface FigureOptions {
  orders?: boolean;
  money?: "shown" | "withheld";
}

export function customerFigures(t: CustomerTotals, o: FigureOptions = {}): CustomerFigures {
  const out: CustomerFigures = { customers: t.customers, repeatCustomers: t.repeatCustomers, repeatRate: perCustomer(t.repeatCustomers, t.customers) };
  if (o.orders) Object.assign(out, { orders: t.orders, ordersPerCustomer: perCustomer(t.orders, t.customers) });
  if (o.money === "shown") {
    const value = cents(t.netSales ?? 0);
    const each = perCustomer(value, t.customers);
    Object.assign(out, { netSales: value, netSalesPerCustomer: each === null ? null : cents(each) });
  } else if (o.money === "withheld") Object.assign(out, { netSales: null, netSalesPerCustomer: null });
  return out;
}

/**
 * One group of the cohort query: a first-order month (`cohort`, "YYYY-MM") and a month its
 * customers ordered in (`month`), or the whole cohort (`month` null).
 */
export interface CohortCount {
  cohort: string;
  month: string | null;
  /** Customers whose first order is in the group: in the cohort's own month and the whole cohort, its size. */
  firstBuyers: number;
  /** Distinct customers with a repeat order in the group (an order after their first). */
  returned: number;
  /** Orders, first orders included. */
  orders: number;
  /** Net sales of those orders, when asked for. */
  netSales?: number;
  /** Of those orders, the ones whose sales aren't read from Shopify (yet, or ever): the cohort's net sales are withheld while it has any. */
  unreadSales?: number;
}

export interface CohortCell {
  /** Calendar months after the first order's month: 0 is that month itself. */
  n: number;
  month: string;
  /** Customers of the cohort who ordered again in the month (in month 0: after their first order). */
  returned: number;
  /** returned ÷ the cohort's customers: the month's retention rate. Null for a cohort without customers. */
  rate: number | null;
  /** The store's current month, not over yet: "so far". */
  running: boolean;
  /**
   * Net sales per customer of the cohort's orders up to the end of this month, first orders
   * included: what a customer of the cohort has spent so far, not a forecast.
   */
  netSalesPerCustomerToDate?: number | null;
}

export interface Cohort {
  /** The month of these customers' first order ("YYYY-MM"). */
  month: string;
  customers: number;
  /**
   * The month began before customers are known (`customersFrom`): customers who first bought in it
   * before that day aren't in the cohort, so it is smaller than it was.
   */
  partial: boolean;
  /** Customers of the cohort with a second order (any month so far). */
  repeatCustomers: number;
  repeatRate: number | null;
  ordersPerCustomer?: number | null;
  /** Net sales per customer of everything the cohort ordered so far. */
  netSalesPerCustomer?: number | null;
  /** Month 0 up to the store's current month; no cell for a month that hasn't come. */
  cells: CohortCell[];
}

/**
 * The cohort table, newest first: one row per first-order month from `from`'s month (the first day
 * the cohort query read) to the store's current month (`today`), `months` at most. Every row has a
 * cell from month 0 to the current month and none after; a month with no repeat order is a real 0
 * (the orders of every month after `from` are all in). Each customer is in one cohort only, so the
 * cohorts' totals add up (`acquiredTotals`). Net sales (`money: "shown"`) are withheld cohort by
 * cohort: only a cohort with orders whose sales aren't read (`unreadSales`) has none.
 */
export function cohortGrid(rows: CohortCount[], o: FigureOptions & { today: string; from: string; customersFrom: string; months?: number }): Cohort[] {
  const current = o.today.slice(0, 7);
  const first = o.from.slice(0, 7);
  const count = Math.min(o.months ?? COHORT_MONTHS, MAX_COHORT_MONTHS, monthsBetween(first, current) + 1);
  const whole = new Map<string, CohortCount>();
  const cell = new Map<string, CohortCount>();
  for (const r of rows) {
    if (r.month === null) whole.set(r.cohort, r);
    else cell.set(`${r.cohort}|${r.month}`, r);
  }
  const out: Cohort[] = [];
  for (let i = 0; i < count; i++) {
    const month = addMonths(current, -i);
    const t = whole.get(month);
    const customers = t?.firstBuyers ?? 0;
    const money = o.money === "shown" && (t?.unreadSales ?? 0) > 0 ? "withheld" : o.money;
    const f = customerFigures({ customers, repeatCustomers: t?.returned ?? 0, orders: t?.orders ?? 0, netSales: t?.netSales ?? 0 }, { ...o, money });
    let toDate = 0;
    const cells: CohortCell[] = [];
    for (let n = 0; n <= monthsBetween(month, current); n++) {
      const at = addMonths(month, n);
      const c = cell.get(`${month}|${at}`);
      const returned = c?.returned ?? 0;
      const x: CohortCell = { n, month: at, returned, rate: perCustomer(returned, customers), running: at === current };
      if (money === "shown") {
        toDate += c?.netSales ?? 0;
        const each = perCustomer(toDate, customers);
        x.netSalesPerCustomerToDate = each === null ? null : cents(each);
      } else if (money === "withheld") x.netSalesPerCustomerToDate = null;
      cells.push(x);
    }
    out.push({
      month,
      customers,
      partial: `${month}-01` < o.customersFrom,
      repeatCustomers: f.repeatCustomers,
      repeatRate: f.repeatRate,
      ...(o.orders ? { ordersPerCustomer: f.ordersPerCustomer } : {}),
      ...(o.money ? { netSalesPerCustomer: f.netSalesPerCustomer } : {}),
      cells,
    });
  }
  return out;
}

/** The customers of the cohorts listed, together: everyone who first bought from `from` on. */
export function acquiredTotals(rows: CohortCount[], cohorts: Cohort[]): CustomerTotals {
  const shown = new Set(cohorts.map((c) => c.month));
  const t: CustomerTotals = { customers: 0, repeatCustomers: 0, orders: 0, netSales: 0 };
  for (const r of rows) {
    if (r.month !== null || !shown.has(r.cohort)) continue;
    t.customers += r.firstBuyers;
    t.repeatCustomers += r.returned;
    t.orders += r.orders;
    t.netSales = (t.netSales ?? 0) + (r.netSales ?? 0);
  }
  return t;
}

/**
 * KPI definitions. See docs/kpis.md for the full write-up. All money is in the
 * store's currency, rounded to 2 dp at the edges only.
 *
 * The sales figures are Shopify's own: they add up Shopify's sales records (an order's
 * agreements → sales), each on the day it happened, the way Shopify's reports do.
 */
export interface DailyMetricsRow {
  day: string;
  grossSales: number; // items sold that day at full price, before discounts, excl. tax & shipping
  discounts: number; // discounts on the items sold that day, before tax
  refunds: number; // returns: what refunds, cancellations and edits took back that day, before tax
  shipping: number; // shipping charged after shipping discounts and refunds, before tax
  taxes: number;
  totalSales: number; // net sales + shipping + taxes + duties and fees (Shopify's "Total sales")
  orders: number; // orders placed that day (cancelled orders included, test orders never stored)
  units: number; // items sold less items returned that day
  ordersWithCustomer: number;
  returningCustomerOrders: number;
  refundedOrders: number; // distinct orders with a return that day
}

export interface KpiSummary {
  grossSales: number;
  discounts: number;
  refunds: number;
  netSales: number;
  shipping: number;
  taxes: number;
  totalSales: number;
  orders: number;
  units: number;
  averageOrderValue: number | null;
  refundRate: number | null;
  returningCustomerRate: number | null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const ratio = (num: number, den: number) => (den > 0 ? num / den : null);

export function summarize(rows: DailyMetricsRow[]): KpiSummary {
  const t = rows.reduce(
    (a, r) => {
      a.grossSales += r.grossSales;
      a.discounts += r.discounts;
      a.refunds += r.refunds;
      a.shipping += r.shipping;
      a.taxes += r.taxes;
      a.totalSales += r.totalSales;
      a.orders += r.orders;
      a.units += r.units;
      a.ordersWithCustomer += r.ordersWithCustomer;
      a.returning += r.returningCustomerOrders;
      return a;
    },
    { grossSales: 0, discounts: 0, refunds: 0, shipping: 0, taxes: 0, totalSales: 0, orders: 0, units: 0, ordersWithCustomer: 0, returning: 0 },
  );
  // Money totals are rounded to cents before deriving ratios, so the result does
  // not depend on float summation order (SQL and JS agree exactly).
  const gross = r2(t.grossSales);
  const discounts = r2(t.discounts);
  const refunds = r2(t.refunds);
  const netBeforeRefunds = r2(gross - discounts);
  const aov = ratio(netBeforeRefunds, t.orders);
  return {
    grossSales: gross,
    discounts,
    refunds,
    netSales: r2(netBeforeRefunds - refunds),
    shipping: r2(t.shipping),
    taxes: r2(t.taxes),
    totalSales: r2(t.totalSales),
    orders: t.orders,
    units: t.units,
    averageOrderValue: aov === null ? null : r2(aov),
    refundRate: ratio(refunds, netBeforeRefunds),
    returningCustomerRate: ratio(t.returning, t.ordersWithCustomer),
  };
}

/** Relative change vs previous period; null when there is no baseline. */
export function delta(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || previous === 0) return null;
  return (current - previous) / Math.abs(previous);
}

// ---- Orders and sales -> daily rows (the reference for recomputeDays in packages/core) ----

export interface OrderInput {
  createdAt: Date;
  customerKey: string | null;
  isReturningCustomer: boolean;
}

/** One of Shopify's sales records, as stored (order_sales). */
export interface SaleInput {
  orderId: string;
  happenedAt: Date;
  /** order | return | update | unknown */
  actionType: string;
  /** product | shipping | gift_card | tip | duty | fee | additional_fee | adjustment | unknown */
  lineType: string;
  quantity: number | null;
  /** After discounts, taxes included. */
  amount: number;
  /** Discounts before taxes. */
  discount: number;
  tax: number;
}

/** Lines that make net sales. Gift cards and tips count nowhere; the rest only in total sales. */
export const MERCHANDISE_LINES: ReadonlySet<string> = new Set(["product", "adjustment"]);

/**
 * A sale's value before tax, and its tax, with the sign Shopify gave it, as its reports add them
 * up. A return's lines are mostly negative, but not all: a refund that differs from the items'
 * value carries adjustment lines of both signs (+225.10 and −225.10 on one PixMagic refund), and
 * only their sum is what the refund took back. Forcing every return line negative counted those
 * pairs twice over.
 */
export function saleValue(x: Pick<SaleInput, "actionType" | "amount" | "tax">): { value: number; tax: number } {
  return { value: x.amount - x.tax, tax: x.tax };
}

export function emptyRow(day: string): DailyMetricsRow {
  return {
    day,
    grossSales: 0,
    discounts: 0,
    refunds: 0,
    shipping: 0,
    taxes: 0,
    totalSales: 0,
    orders: 0,
    units: 0,
    ordersWithCustomer: 0,
    returningCustomerOrders: 0,
    refundedOrders: 0,
  };
}

export function aggregateDaily(
  orders: OrderInput[],
  sales: SaleInput[],
  timeZone: string,
  toDay: (d: Date, tz: string) => string,
): Map<string, DailyMetricsRow> {
  const out = new Map<string, DailyMetricsRow>();
  const row = (day: string) => {
    let r = out.get(day);
    if (!r) out.set(day, (r = emptyRow(day)));
    return r;
  };
  for (const o of orders) {
    const r = row(toDay(o.createdAt, timeZone));
    r.orders += 1;
    if (o.customerKey) {
      r.ordersWithCustomer += 1;
      if (o.isReturningCustomer) r.returningCustomerOrders += 1;
    }
  }
  const returnedPerDay = new Map<string, Set<string>>();
  for (const x of sales) {
    if (x.lineType === "gift_card" || x.lineType === "tip") continue;
    const day = toDay(x.happenedAt, timeZone);
    const r = row(day);
    const { value, tax } = saleValue(x);
    r.taxes += tax;
    r.totalSales += value + tax;
    if (MERCHANDISE_LINES.has(x.lineType)) {
      if (x.actionType === "order") {
        r.grossSales += value + x.discount;
        r.discounts += x.discount;
      } else r.refunds -= value;
    } else if (x.lineType === "shipping") r.shipping += value;
    if (x.lineType === "product" && x.actionType === "order") r.units += Math.abs(x.quantity ?? 0);
    if (x.lineType === "product" && x.actionType === "return") r.units -= Math.abs(x.quantity ?? 0);
    if (x.actionType === "return") {
      const set = returnedPerDay.get(day) ?? new Set<string>();
      set.add(x.orderId);
      returnedPerDay.set(day, set);
    }
  }
  for (const [day, set] of returnedPerDay) row(day).refundedOrders = set.size;
  return out;
}

const CHANNEL_LABELS: Record<string, string> = {
  web: "Online Store",
  pos: "Point of Sale",
  shopify_draft_order: "Draft orders",
  iphone: "Shopify app (iPhone)",
  android: "Shopify app (Android)",
  buy_button: "Buy Button",
  checkout_next: "Online Store",
  subscription_contract: "Subscriptions",
  subscription_contract_checkout_one: "Subscriptions",
};

/**
 * Human label for Shopify's order `source_name`. Numeric values are the API
 * client id of the sales-channel app that created the order.
 */
export function channelLabel(sourceName: string | null | undefined): string {
  const s = (sourceName ?? "").trim();
  if (!s) return "Unknown";
  const known = CHANNEL_LABELS[s.toLowerCase()];
  if (known) return known;
  if (/^\d+$/.test(s)) return "Other sales channel app";
  const words = s.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

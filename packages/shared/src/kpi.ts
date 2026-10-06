/**
 * KPI definitions. See docs/kpis.md for the full write-up. All money is in the
 * store's currency, rounded to 2 dp at the edges only.
 */
export interface DailyMetricsRow {
  day: string;
  grossSales: number; // sum(line price * qty) before discounts, excl. tax & shipping
  discounts: number; // sum(discount allocations) on orders placed that day
  refunds: number; // sum(refunded line subtotal) on refunds *created* that day
  orders: number; // orders placed that day (cancelled orders excluded)
  units: number;
  ordersWithCustomer: number;
  returningCustomerOrders: number;
  refundedOrders: number; // distinct orders with a refund created that day
}

export interface KpiSummary {
  grossSales: number;
  discounts: number;
  refunds: number;
  netSales: number;
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
      a.orders += r.orders;
      a.units += r.units;
      a.ordersWithCustomer += r.ordersWithCustomer;
      a.returning += r.returningCustomerOrders;
      return a;
    },
    { grossSales: 0, discounts: 0, refunds: 0, orders: 0, units: 0, ordersWithCustomer: 0, returning: 0 },
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

// ---- Order -> daily contribution (used by the worker aggregator) ----

export interface OrderInput {
  createdAt: Date;
  cancelledAt: Date | null;
  customerKey: string | null;
  isReturningCustomer: boolean;
  lineItems: Array<{ price: number; quantity: number; discount: number }>;
}

export interface RefundInput {
  orderId: string;
  createdAt: Date;
  lineSubtotal: number;
}

export function emptyRow(day: string): DailyMetricsRow {
  return {
    day,
    grossSales: 0,
    discounts: 0,
    refunds: 0,
    orders: 0,
    units: 0,
    ordersWithCustomer: 0,
    returningCustomerOrders: 0,
    refundedOrders: 0,
  };
}

export function aggregateDaily(
  orders: OrderInput[],
  refunds: RefundInput[],
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
    if (o.cancelledAt) continue;
    const r = row(toDay(o.createdAt, timeZone));
    r.orders += 1;
    for (const li of o.lineItems) {
      r.grossSales += li.price * li.quantity;
      r.discounts += li.discount;
      r.units += li.quantity;
    }
    if (o.customerKey) {
      r.ordersWithCustomer += 1;
      if (o.isReturningCustomer) r.returningCustomerOrders += 1;
    }
  }
  const refundedPerDay = new Map<string, Set<string>>();
  for (const f of refunds) {
    const day = toDay(f.createdAt, timeZone);
    row(day).refunds += f.lineSubtotal;
    const set = refundedPerDay.get(day) ?? new Set<string>();
    set.add(f.orderId);
    refundedPerDay.set(day, set);
  }
  for (const [day, set] of refundedPerDay) row(day).refundedOrders = set.size;
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

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
  duties: number; // import duties charged that day, before tax
  additionalFees: number; // Shopify's fees and additional fees (and any sale it gives no type), before tax
  totalSales: number; // net sales + shipping + taxes + duties + additional fees (Shopify's "Total sales")
  // what refunds, returns and cancellations took off total sales that day: their sales with tax,
  // shipping, duties and fees in (gift cards and tips aside, as total sales leaves them out)
  totalRefunded: number;
  // orders placed that day, on the day Shopify processed them (cancelled orders included, test
  // orders never stored, orders of gift cards only left out: Shopify's reports don't count them)
  orders: number;
  // what those orders sold on the day they were placed: their items after discounts, before tax,
  // without gift cards, and without what an edit on a later day added. Average order value is this
  // ÷ orders, as Shopify's AOV is
  orderValue: number;
  units: number; // items sold less items returned that day, gift cards included (Shopify's "net items sold")
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
  duties: number;
  additionalFees: number;
  totalSales: number;
  totalRefunded: number;
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
      a.duties += r.duties;
      a.additionalFees += r.additionalFees;
      a.totalSales += r.totalSales;
      a.totalRefunded += r.totalRefunded;
      a.orders += r.orders;
      a.orderValue += r.orderValue;
      a.units += r.units;
      a.ordersWithCustomer += r.ordersWithCustomer;
      a.returning += r.returningCustomerOrders;
      return a;
    },
    { grossSales: 0, discounts: 0, refunds: 0, shipping: 0, taxes: 0, duties: 0, additionalFees: 0, totalSales: 0, totalRefunded: 0, orders: 0, orderValue: 0, units: 0, ordersWithCustomer: 0, returning: 0 },
  );
  // Money totals are rounded to cents before deriving ratios, so the result does
  // not depend on float summation order (SQL and JS agree exactly).
  const gross = r2(t.grossSales);
  const discounts = r2(t.discounts);
  const refunds = r2(t.refunds);
  const netBeforeRefunds = r2(gross - discounts);
  // Shopify's AOV: the orders' value on the day they were placed (edits on a later day, returns, gift
  // cards, tax and shipping left out) ÷ the orders, which leave out orders of gift cards only.
  const aov = ratio(r2(t.orderValue), t.orders);
  return {
    grossSales: gross,
    discounts,
    refunds,
    netSales: r2(netBeforeRefunds - refunds),
    shipping: r2(t.shipping),
    taxes: r2(t.taxes),
    duties: r2(t.duties),
    additionalFees: r2(t.additionalFees),
    totalSales: r2(t.totalSales),
    totalRefunded: r2(t.totalRefunded),
    orders: t.orders,
    units: t.units,
    averageOrderValue: aov === null ? null : r2(aov),
    refundRate: ratio(refunds, netBeforeRefunds),
    returningCustomerRate: ratio(t.returning, t.ordersWithCustomer),
  };
}



// ---- Orders and sales -> daily rows (the reference for recomputeDays in packages/core) ----

export interface OrderInput {
  /** The id its sales name (SaleInput.orderId): how a sale is known to be its order's own. */
  id?: string;
  createdAt: Date;
  /**
   * When Shopify processed the order: the date its reports put it on. The same moment as createdAt
   * for an order placed in the store; earlier for one imported, synced from POS offline or brought
   * in by a marketplace app. Null for an order stored before it was read: createdAt stands in.
   */
  processedAt?: Date | null;
  /** Every item a gift card: Shopify's reports don't count the order, nor its customer. */
  giftCardOnly?: boolean;
  customerKey: string | null;
  isReturningCustomer: boolean;
}

/** The day an order counts on: Shopify's processed date, else its creation (orders stored before it was read). */
export const orderMoment = (o: Pick<OrderInput, "createdAt" | "processedAt">): Date => o.processedAt ?? o.createdAt;

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
 * Where a sale that isn't merchandise, shipping, a gift card or a tip goes in Shopify's total sales
 * breakdown: a duty is a duty; a fee, an additional fee or a sale Shopify gives no type
 * (`unknown`) is an additional fee, so the lines always add up to total sales, as Shopify's do.
 */
export const chargeLine = (lineType: string): "duties" | "additionalFees" => (lineType === "duty" ? "duties" : "additionalFees");

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
    duties: 0,
    additionalFees: 0,
    totalSales: 0,
    totalRefunded: 0,
    orders: 0,
    orderValue: 0,
    units: 0,
    ordersWithCustomer: 0,
    returningCustomerOrders: 0,
    refundedOrders: 0,
  };
}

/** Lines that count as items sold: Shopify's net items sold includes gift cards. */
const ITEM_LINES: ReadonlySet<string> = new Set(["product", "gift_card"]);

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
  // The day each order was placed: its own sales that day (an edit made the same day included) are
  // its value as placed, Shopify's AOV numerator; an edit on a later day isn't.
  const placedOn = new Map<string, string>();
  for (const o of orders) {
    if (o.id) placedOn.set(o.id, toDay(orderMoment(o), timeZone));
    if (o.giftCardOnly) continue;
    const r = row(toDay(orderMoment(o), timeZone));
    r.orders += 1;
    if (o.customerKey) {
      r.ordersWithCustomer += 1;
      if (o.isReturningCustomer) r.returningCustomerOrders += 1;
    }
  }
  const returnedPerDay = new Map<string, Set<string>>();
  for (const x of sales) {
    if (x.lineType === "tip") continue;
    const day = toDay(x.happenedAt, timeZone);
    const r = row(day);
    if (ITEM_LINES.has(x.lineType) && x.actionType === "order") r.units += Math.abs(x.quantity ?? 0);
    if (ITEM_LINES.has(x.lineType) && x.actionType === "return") r.units -= Math.abs(x.quantity ?? 0);
    // Gift cards are sold as payment, not merchandise: no sales, tax or returns, as in Shopify.
    if (x.lineType === "gift_card") continue;
    const { value, tax } = saleValue(x);
    r.taxes += tax;
    r.totalSales += value + tax;
    if (x.actionType === "return") r.totalRefunded -= value + tax;
    if (MERCHANDISE_LINES.has(x.lineType)) {
      if (x.actionType === "order") {
        r.grossSales += value + x.discount;
        r.discounts += x.discount;
        if (placedOn.get(x.orderId) === day) r.orderValue += value;
      } else r.refunds -= value;
    } else if (x.lineType === "shipping") r.shipping += value;
    else r[chargeLine(x.lineType)] += value;
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

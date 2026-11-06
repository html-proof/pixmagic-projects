/**
 * How the dashboard's "Orders at a glance" sorts the orders placed in the dates, by what Shopify says
 * of each (docs/kpis.md "Orders at a glance"). Every order is exactly one of completed, awaiting
 * payment or unsuccessful, so the three add up to the Orders tile.
 */

/** Payment states (Shopify's displayFinancialStatus, lowercase) of an order whose money never came in: voided, or an authorization that ran out. */
export const PAYMENT_FAILED_STATUSES: readonly string[] = ["voided", "expired"];
/** Payment states of an order not paid in full yet: pending (cash on delivery, bank transfer), authorized and not captured, partly paid. */
export const PAYMENT_WAITING_STATUSES: readonly string[] = ["pending", "authorized", "partially_paid"];

/** Unsuccessful: cancelled, its payment failed, or every cent refunded. */
export type OrderOutcome = "completed" | "awaiting_payment" | "cancelled" | "payment_failed" | "refunded";

/**
 * Where one order stands. Cancelled first, whatever its payment says (a cancelled order is usually
 * refunded or voided too); a payment state not known (an order stored before it was read) is completed,
 * as Shopify gives every order one.
 */
export function orderOutcome(o: { cancelled: boolean; financialStatus: string | null }): OrderOutcome {
  if (o.cancelled) return "cancelled";
  const f = o.financialStatus;
  if (f !== null && PAYMENT_FAILED_STATUSES.includes(f)) return "payment_failed";
  if (f === "refunded") return "refunded";
  if (f !== null && PAYMENT_WAITING_STATUSES.includes(f)) return "awaiting_payment";
  return "completed";
}

/** Whether the order is still on: completed or awaiting payment. These are the orders to send. */
export const orderGoesAhead = (outcome: OrderOutcome) => outcome === "completed" || outcome === "awaiting_payment";

/**
 * The overview's `order_outcomes` module, for the orders placed in the dates (gift-card-only orders
 * left out, as the Orders tile counts them). Each part needs its own Team & Access permission, so
 * any of them may be missing (`redactOverview`).
 */
export interface OrderOutcomes {
  /** Orders placed in the dates: the Orders tile's count. */
  orders?: number;
  /** "View payment status" and "View cancellations". unsuccessful = cancelled + paymentFailed + refunded. */
  outcome?: { completed: number; awaitingPayment: number; unsuccessful: number; cancelled: number; paymentFailed: number; refunded: number };
  /**
   * "View fulfillment status". Of the orders still on (completed or awaiting payment): how many were
   * sent in full, in part, or are still to send; their items, and the items of the orders sent in full.
   * An order whose status isn't known yet is in `orders` and none of the three.
   */
  shipping?: { orders: number; sent: number; partlySent: number; notSent: number; items: number; itemsSent: number };
  /**
   * "View checkout abandonment". Shoppers who started a checkout in the dates, and how many of them
   * bought or left without buying, from the storefront pixel (one per shopper per day). `from`: the
   * first day counted when tracking began inside the dates. Null when the pixel isn't on, or began
   * after the dates.
   */
  checkouts?: { started: number; completed: number; left: number; from: string | null } | null;
}

// ---------------------------------------------------------------------------
// The order list (GET .../orders, the Orders & shipping page)
// ---------------------------------------------------------------------------

/** The order list's payment filter: Shopify's payment states (displayFinancialStatus, lowercase) in four groups. */
export const PAYMENT_GROUPS = ["paid", "pending", "refunded", "other"] as const;
export type PaymentGroup = (typeof PAYMENT_GROUPS)[number];

/**
 * The payment states in each group. "other" is every state not listed here, and none at all: voided,
 * expired, a state Shopify adds later, an order stored before its state was read. Pending is the
 * states still waiting on the money (PAYMENT_WAITING_STATUSES); refunded counts a partial refund too.
 */
export const PAYMENT_GROUP_STATUSES: Readonly<Record<Exclude<PaymentGroup, "other">, readonly string[]>> = {
  paid: ["paid"],
  pending: PAYMENT_WAITING_STATUSES,
  refunded: ["refunded", "partially_refunded"],
};

export const PAYMENT_GROUP_LABEL: Readonly<Record<PaymentGroup, string>> = { paid: "Paid", pending: "Pending", refunded: "Refunded", other: "Other" };

/** Which payment group an order's payment state is in. */
export function paymentGroup(financialStatus: string | null | undefined): PaymentGroup {
  if (financialStatus) for (const g of ["paid", "pending", "refunded"] as const) if (PAYMENT_GROUP_STATUSES[g].includes(financialStatus)) return g;
  return "other";
}

/** The order list's shipping filter: Shopify's fulfillment states (displayFulfillmentStatus, lowercase) in three groups. */
export const SHIPPING_GROUPS = ["shipped", "partly", "not_shipped"] as const;
export type ShippingGroup = (typeof SHIPPING_GROUPS)[number];

/**
 * The fulfillment states sent in full and in part. "not_shipped" is every other state, and none at
 * all: unfulfilled, on hold, scheduled, in progress, restocked, an order stored before its state was read.
 */
export const SHIPPING_GROUP_STATUSES: Readonly<Record<Exclude<ShippingGroup, "not_shipped">, readonly string[]>> = {
  shipped: ["fulfilled"],
  partly: ["partially_fulfilled"],
};

export const SHIPPING_GROUP_LABEL: Readonly<Record<ShippingGroup, string>> = { shipped: "Shipped", partly: "Partly shipped", not_shipped: "Not shipped" };

/** Which shipping group an order's fulfillment state is in. */
export function shippingGroup(fulfillmentStatus: string | null | undefined): ShippingGroup {
  if (fulfillmentStatus) for (const g of ["shipped", "partly"] as const) if (SHIPPING_GROUP_STATUSES[g].includes(fulfillmentStatus)) return g;
  return "not_shipped";
}

/** The order list's cancellation filter: cancelled orders only, or none of them. */
export const ORDER_CANCELLED_FILTERS = ["only", "exclude"] as const;
export type OrderCancelledFilter = (typeof ORDER_CANCELLED_FILTERS)[number];

/**
 * The order list's order: newest or oldest first (by when Shopify processed the orders, as every
 * order figure dates them), or by total, equal totals newest first. The order's id breaks any tie
 * left, so pages never overlap or skip one.
 */
export const ORDER_LIST_SORTS = ["newest", "oldest", "total_desc", "total_asc"] as const;
export type OrderListSort = (typeof ORDER_LIST_SORTS)[number];

/** The order list's question, past the dates (GET .../orders). `q` is part of an order number, its "#" optional. */
export interface OrderListQuery {
  q?: string;
  payment?: PaymentGroup;
  shipping?: ShippingGroup;
  cancelled?: OrderCancelledFilter;
  sort: OrderListSort;
  /** From 1. */
  page: number;
  pageSize: number;
}

/**
 * One order of the order list, as the overview's recent orders give it too. Payment status,
 * fulfillment status and cancelled each need their own Team & Access permission, so any of them may
 * be missing (`redactOrderRows` in ./access.ts).
 */
export interface OrderListItem {
  id: string;
  shopifyId: string;
  /** Shopify's order number: "#1001". */
  name: string;
  /** When Shopify processed the order (ISO 8601, UTC). */
  createdAt: string;
  /** The order's total as placed. */
  total: number;
  financialStatus?: string | null;
  fulfillmentStatus?: string | null;
  /** The sales channel's name (`channelLabel`). */
  channel: string;
  units: number;
  cancelled?: boolean;
}

/** A page of the order list: the dates in the store's zone, how many orders match, and this page's. */
export interface OrderListPage {
  range: { from: string; to: string };
  total: number;
  page: number;
  pageSize: number;
  items: OrderListItem[];
}

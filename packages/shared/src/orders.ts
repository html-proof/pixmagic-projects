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

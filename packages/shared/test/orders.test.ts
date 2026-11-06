import { describe, expect, it } from "vitest";
import {
  orderGoesAhead,
  orderOutcome,
  PAYMENT_GROUP_LABEL,
  PAYMENT_GROUP_STATUSES,
  PAYMENT_GROUPS,
  paymentGroup,
  SHIPPING_GROUP_LABEL,
  SHIPPING_GROUP_STATUSES,
  SHIPPING_GROUPS,
  shippingGroup,
} from "../src/orders.js";

describe("orderOutcome", () => {
  it("puts every order in exactly one place, cancelled first", () => {
    const of = (financialStatus: string | null, cancelled = false) => orderOutcome({ cancelled, financialStatus });
    expect(of("paid")).toBe("completed");
    expect(of("partially_refunded")).toBe("completed");
    for (const f of ["pending", "authorized", "partially_paid"]) expect(of(f)).toBe("awaiting_payment");
    expect(of("voided")).toBe("payment_failed");
    expect(of("expired")).toBe("payment_failed");
    expect(of("refunded")).toBe("refunded");
    // A cancelled order is usually refunded or voided too: it counts once, as cancelled.
    expect(of("refunded", true)).toBe("cancelled");
    expect(of("paid", true)).toBe("cancelled");
    // Shopify gives every order a payment state; one stored before it was read isn't a failure.
    expect(of(null)).toBe("completed");
  });

  it("sends the orders still on: completed or awaiting payment (cash on delivery ships before it is paid)", () => {
    expect(orderGoesAhead("completed")).toBe(true);
    expect(orderGoesAhead("awaiting_payment")).toBe(true);
    for (const o of ["cancelled", "payment_failed", "refunded"] as const) expect(orderGoesAhead(o)).toBe(false);
  });
});

describe("the order list's payment and shipping groups", () => {
  it("puts each of Shopify's payment states in one group; a state it doesn't list, or none, is other", () => {
    expect(paymentGroup("paid")).toBe("paid");
    for (const f of ["pending", "authorized", "partially_paid"]) expect(paymentGroup(f)).toBe("pending");
    expect(paymentGroup("refunded")).toBe("refunded");
    expect(paymentGroup("partially_refunded")).toBe("refunded");
    for (const f of ["voided", "expired", "something_new", "", null, undefined]) expect(paymentGroup(f)).toBe("other");
    // The groups' lists don't overlap, so the list's filter and this function agree on every state.
    const listed = Object.values(PAYMENT_GROUP_STATUSES).flat();
    expect(new Set(listed).size).toBe(listed.length);
    for (const [group, states] of Object.entries(PAYMENT_GROUP_STATUSES)) for (const s of states) expect(paymentGroup(s)).toBe(group);
  });

  it("puts each of Shopify's fulfillment states in one group; anything not sent at all is not shipped", () => {
    expect(shippingGroup("fulfilled")).toBe("shipped");
    expect(shippingGroup("partially_fulfilled")).toBe("partly");
    for (const f of ["unfulfilled", "on_hold", "in_progress", "open", "pending_fulfillment", "scheduled", "restocked", "", null, undefined]) expect(shippingGroup(f)).toBe("not_shipped");
    for (const [group, states] of Object.entries(SHIPPING_GROUP_STATUSES)) for (const s of states) expect(shippingGroup(s)).toBe(group);
  });

  it("labels every group, for the page's filters", () => {
    expect(Object.keys(PAYMENT_GROUP_LABEL)).toEqual([...PAYMENT_GROUPS]);
    expect(Object.keys(SHIPPING_GROUP_LABEL)).toEqual([...SHIPPING_GROUPS]);
  });
});

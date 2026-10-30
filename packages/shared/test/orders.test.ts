import { describe, expect, it } from "vitest";
import { orderGoesAhead, orderOutcome } from "../src/orders.js";

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

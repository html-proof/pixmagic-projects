import { describe, expect, it } from "vitest";
import { refundHealth, shippingHealth, stockHealth, trendHealth, worstHealth } from "../src/health.js";

describe("store health rules", () => {
  it("does not grade incomplete days or unavailable comparisons", () => {
    for (const delta of [null, NaN, Infinity, -Infinity]) expect(trendHealth(delta, false)).toBe("info");
    expect(trendHealth(-1, true)).toBe("info");
    expect(trendHealth(0, false)).toBe("good");
    expect(trendHealth(-0.099, false)).toBe("watch");
    expect(trendHealth(-0.1, false)).toBe("attention");
  });

  it("keeps refund thresholds inclusive", () => {
    expect([0, 0.05, 0.051, 0.1, 0.101, null, NaN].map(refundHealth)).toEqual([
      "good", "good", "watch", "watch", "attention", "info", "info",
    ]);
  });

  it("prioritizes sold-out stock and orders waiting over three days", () => {
    expect(stockHealth(1, 10)).toBe("attention");
    expect(stockHealth(0, 1)).toBe("watch");
    expect(stockHealth(0, 0)).toBe("good");
    expect(shippingHealth(0, 10)).toBe("good");
    expect(shippingHealth(1, null)).toBe("watch");
    expect(shippingHealth(1, 3)).toBe("watch");
    expect(shippingHealth(1, 4)).toBe("attention");
  });

  it("combines statuses with attention first and no checks as information only", () => {
    expect(worstHealth([])).toBe("info");
    expect(worstHealth(["good", "info", "watch"])).toBe("watch");
    expect(worstHealth(["attention", "good"])).toBe("attention");
  });
});

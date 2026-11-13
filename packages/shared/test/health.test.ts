import { describe, expect, it } from "vitest";
import { GRADE, gradeCover, gradeRefundRate, gradeShipping, gradeStock, shippingIsLate } from "../src/health.js";

describe("GRADE", () => {
  it("states the thresholds docs/kpis.md documents", () => {
    expect(GRADE).toEqual({ refundRateGood: 0.05, refundRateWatch: 0.1, shippingDays: 3, coverDays: 7, coverUnits: 2 });
  });
});

describe("gradeRefundRate", () => {
  it.each([
    [0, "good"],
    [0.0499, "good"],
    [0.05, "good"],
    [0.0501, "watch"],
    [0.0999, "watch"],
    [0.1, "watch"],
    [0.1001, "attention"],
    [1, "attention"],
  ] as const)("%s → %s", (rate, grade) => {
    expect(gradeRefundRate(rate)).toBe(grade);
  });
});

describe("gradeStock", () => {
  it.each([
    [0, 0, "good"],
    [0, 1, "watch"],
    [0, 12, "watch"],
    [1, 0, "attention"],
    [1, 5, "attention"],
  ] as const)("%s sold out, %s low → %s", (out, low, grade) => {
    expect(gradeStock(out, low)).toBe(grade);
  });
});

describe("shippingIsLate", () => {
  it.each([
    [null, false],
    [0, false],
    [2.9, false],
    [3, false],
    [3.1, true],
    [4, true],
  ] as const)("oldest %s days → %s", (days, late) => {
    expect(shippingIsLate(days)).toBe(late);
  });
});

describe("gradeShipping", () => {
  it.each([
    [0, null, "good"],
    // Nothing waiting is good even if an age is reported.
    [0, 9, "good"],
    [1, null, "watch"],
    [1, 0, "watch"],
    [2, 3, "watch"],
    [2, 3.5, "attention"],
    [5, 4, "attention"],
  ] as const)("%s waiting, oldest %s days → %s", (open, oldest, grade) => {
    expect(gradeShipping(open, oldest)).toBe(grade);
  });
});

describe("gradeCover", () => {
  it.each([
    // Days of sales left decide when there are more than 2 units.
    [6.9, 3, "attention"],
    [7, 3, "watch"],
    [7.1, 3, "watch"],
    [0, 3, "attention"],
    // No recent sales: only the units left count.
    [null, 3, "watch"],
    [null, 2, "attention"],
    [null, 0, "attention"],
    // 2 units or fewer is urgent, however slowly it sells.
    [30, 2, "attention"],
    [30, 1, "attention"],
    [30, 3, "watch"],
  ] as const)("%s days, %s units → %s", (days, qty, grade) => {
    expect(gradeCover(days, qty)).toBe(grade);
  });
});

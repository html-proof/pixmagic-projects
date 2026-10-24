import { describe, expect, it } from "vitest";
import { historyWindowSearch, OLDEST_ORDER_QUERY, planHistoryWindows } from "../src/index.js";
import { requestedCost } from "./queryCost.js";

describe("a full order history, a calendar year at a time", () => {
  // 24 Oct 2026, 2 pm in Melbourne (UTC+11 in summer, +10 in winter).
  const now = new Date("2026-10-24T03:00:00Z");
  const tz = "Australia/Melbourne";

  it("plans every year from the first order's to this one, newest first, with shared boundaries", () => {
    const plan = planHistoryWindows(new Date("2023-05-10T00:00:00Z"), now, tz);
    expect(plan.map((p) => p.year)).toEqual([2026, 2025, 2024, 2023]);
    // The newest year runs on to now; the oldest has no lower bound (the epoch).
    expect(plan[0]).toEqual({ year: 2026, fromAt: new Date("2025-12-31T13:00:00Z"), toAt: null });
    expect(plan[3]!.fromAt).toEqual(new Date(0));
    // Each year ends where the next one starts: midnight on 1 January in Melbourne.
    for (let i = 1; i < plan.length; i++) expect(plan[i]!.toAt).toEqual(plan[i - 1]!.fromAt);
    expect(plan[1]).toEqual({ year: 2025, fromAt: new Date("2024-12-31T13:00:00Z"), toAt: new Date("2025-12-31T13:00:00Z") });
  });

  it("goes by the store's calendar: an order on 31 Dec in UTC can be the next year's", () => {
    // 31 Dec 2024, 20:00 UTC is already 1 Jan 2025 in Melbourne: the plan starts at 2025.
    expect(planHistoryWindows(new Date("2024-12-31T20:00:00Z"), now, tz).map((p) => p.year)).toEqual([2026, 2025]);
    expect(planHistoryWindows(new Date("2024-12-31T20:00:00Z"), now, "America/New_York").map((p) => p.year)).toEqual([2026, 2025, 2024]);
  });

  it("is one year, every order, for a store that opened this year", () => {
    const plan = planHistoryWindows(new Date("2026-08-26T09:00:00Z"), now, tz);
    expect(plan).toEqual([{ year: 2026, fromAt: new Date(0), toAt: null }]);
    expect(historyWindowSearch(plan[0]!)).toBeNull();
  });

  it("searches each year by creation date, as the paged and bulk paths both read it", () => {
    const [newest, middle, oldest] = planHistoryWindows(new Date("2024-03-01T00:00:00Z"), now, tz);
    expect(historyWindowSearch(newest!)).toBe("created_at:>='2025-12-31T13:00:00.000Z'");
    expect(historyWindowSearch(middle!)).toBe("created_at:>='2024-12-31T13:00:00.000Z' AND created_at:<'2025-12-31T13:00:00.000Z'");
    expect(historyWindowSearch(oldest!)).toBe("created_at:<'2024-12-31T13:00:00.000Z'");
  });

  it("asks Shopify for the first order at almost no cost", () => {
    expect(OLDEST_ORDER_QUERY).toContain("sortKey: CREATED_AT");
    expect(OLDEST_ORDER_QUERY).not.toContain("reverse");
    expect(requestedCost(OLDEST_ORDER_QUERY)).toBeLessThanOrEqual(3);
  });
});

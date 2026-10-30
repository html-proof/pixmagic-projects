import { describe, expect, it } from "vitest";
import { expenseInput, expenseInRange, expensesComplete, expenseTotals, netProfit, type ExpenseInput } from "../src/index.js";

/**
 * A store's own costs (Settings → Costs): how each is spread over the days it covers, how a range's
 * costs add up, what the API takes, and when net profit may be given.
 */

const cost = (over: Partial<ExpenseInput>): ExpenseInput => ({ name: "Cost", category: "other", amount: 100, cadence: "monthly", startsOn: "2026-01-01", endsOn: null, note: null, ...over });

describe("a cost over the dates", () => {
  it("counts a monthly cost whole for a whole month, whatever its length, and by its share of a part", () => {
    const plan = cost({ amount: 39, cadence: "monthly", startsOn: "2025-06-15" });
    expect(expenseInRange(plan, { from: "2026-02-01", to: "2026-02-28" })).toBe(39);
    expect(expenseInRange(plan, { from: "2026-10-01", to: "2026-10-31" })).toBe(39);
    // 10 of September's 30 days: a third.
    expect(expenseInRange(plan, { from: "2026-09-21", to: "2026-09-30" })).toBe(13);
    // Across two months: the end of one and the start of the next, each by its own length.
    expect(expenseInRange(cost({ amount: 31, startsOn: "2026-01-01" }), { from: "2026-01-31", to: "2026-02-14" })).toBe(16.5);
    // A whole year of months adds up to twelve of them.
    expect(expenseInRange(plan, { from: "2026-01-01", to: "2026-12-31" })).toBe(468);
  });

  it("counts nothing before a cost starts or after it ends", () => {
    const app = cost({ amount: 30, startsOn: "2026-10-16", endsOn: "2026-10-20" });
    // 16–20 Oct only: 5 of October's 31 days.
    expect(expenseInRange(app, { from: "2026-10-01", to: "2026-10-31" })).toBe(4.84);
    expect(expenseInRange(app, { from: "2026-09-01", to: "2026-10-15" })).toBe(0);
    expect(expenseInRange(app, { from: "2026-10-21", to: "2026-12-31" })).toBe(0);
  });

  it("counts a cost paid once on its day, and weekly and yearly costs by their days", () => {
    expect(expenseInRange(cost({ amount: 250, cadence: "once", startsOn: "2026-10-05" }), { from: "2026-10-01", to: "2026-10-07" })).toBe(250);
    expect(expenseInRange(cost({ amount: 250, cadence: "once", startsOn: "2026-10-08" }), { from: "2026-10-01", to: "2026-10-07" })).toBe(0);
    expect(expenseInRange(cost({ amount: 70, cadence: "weekly" }), { from: "2026-10-05", to: "2026-10-18" })).toBe(140);
    expect(expenseInRange(cost({ amount: 70, cadence: "weekly" }), { from: "2026-10-05", to: "2026-10-07" })).toBe(30);
    // A yearly cost: the whole year, and 2028's 29 February counted in a leap year's 366 days.
    expect(expenseInRange(cost({ amount: 365, cadence: "yearly" }), { from: "2026-01-01", to: "2026-12-31" })).toBe(365);
    expect(expenseInRange(cost({ amount: 366, cadence: "yearly" }), { from: "2028-02-01", to: "2028-02-29" })).toBe(29);
  });

  it("adds a range's costs up by category, biggest first, to the cent", () => {
    const totals = expenseTotals(
      [
        cost({ category: "shopify_plan", amount: 39 }),
        cost({ category: "shopify_apps", amount: 19.99 }),
        cost({ category: "shopify_apps", amount: 0.01 }),
        cost({ category: "staff", amount: 1200, startsOn: "2027-01-01" }),
      ],
      { from: "2026-10-01", to: "2026-10-31" },
    );
    expect(totals).toEqual({ total: 59, byCategory: [{ category: "shopify_plan", amount: 39 }, { category: "shopify_apps", amount: 20 }], counted: 3 });
  });
});

describe("what Settings → Costs may save", () => {
  it("takes a whole cost and refuses one that can't be counted", () => {
    expect(expenseInput.parse(cost({ name: "  Klaviyo  " })).name).toBe("Klaviyo");
    expect(() => expenseInput.parse(cost({ name: " " }))).toThrow();
    expect(() => expenseInput.parse(cost({ amount: -1 }))).toThrow();
    expect(() => expenseInput.parse(cost({ amount: 1.005 }))).toThrow();
    expect(() => expenseInput.parse(cost({ startsOn: "2026-02-30" }))).toThrow();
    expect(() => expenseInput.parse(cost({ startsOn: "2026-10-10", endsOn: "2026-10-09" }))).toThrow("can't end before it starts");
    expect(() => expenseInput.parse(cost({ cadence: "once", endsOn: "2026-12-31" }))).toThrow("no end date");
    expect(() => expenseInput.parse({ ...cost({}), extra: 1 })).toThrow();
  });
});

describe("net profit", () => {
  const range = { from: "2026-10-01", to: "2026-10-31" };
  const known = { revenue: 10_000, productCosts: 4_000, uncosted: 0, adSpend: 1_500.5, yourCosts: 1_200.25, complete: true };

  it("is revenue less the cost of goods, the ad spend and the owner's costs, when every one is known", () => {
    expect(netProfit(known)).toEqual({ value: 3_299.25, gaps: [] });
    // No ad account connected: nothing spent through one; other ads are the owner's costs.
    expect(netProfit({ ...known, adSpend: 0 })).toEqual({ value: 4_799.75, gaps: [] });
  });

  it("is never given with an input missing, and says every reason", () => {
    expect(netProfit({ ...known, productCosts: null, adSpend: null, complete: false })).toEqual({ value: null, gaps: ["product_costs", "ad_spend", "costs_not_complete"] });
    expect(netProfit({ ...known, uncosted: 12 })).toEqual({ value: null, gaps: ["uncosted_sales"] });
    expect(netProfit({ ...known, adSpend: "hidden" })).toEqual({ value: null, gaps: ["ads_hidden"] });
  });

  it("counts the costs list complete only for dates from the day the owner said so", () => {
    expect(expensesComplete("2026-10-01", range)).toBe(true);
    expect(expensesComplete("2026-10-02", range)).toBe(false);
    expect(expensesComplete(null, range)).toBe(false);
  });
});

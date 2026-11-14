import { describe, expect, it } from "vitest";
import {
  costsOver,
  eachDay,
  expenseInRange,
  expenseSettingsInput,
  expenseTotals,
  monthDays,
  operatingDaysBetween,
  outcomeOf,
  profitAds,
  profitAndLoss,
  runsOf,
  type ProfitCost,
  type ProfitDay,
  type ProfitSetup,
} from "../src/index.js";

/**
 * Profit and loss (the Profit sheet): the owner's monthly fixed costs spread over the month's own
 * days, a day's operating profit after its variable costs and its share of the fixed ones, a month's
 * net profit after interest and tax, and every figure left out, with its reason, when an input is
 * missing. The first case is the brief's own example, in rupees.
 */

const monthly = (category: ProfitCost["category"], amount: number, startsOn = "2025-01-01", endsOn: string | null = null): ProfitCost => ({ category, amount, cadence: "monthly", startsOn, endsOn });
const once = (category: ProfitCost["category"], amount: number, day: string): ProfitCost => ({ category, amount, cadence: "once", startsOn: day, endsOn: null });

/** Rent ₹15,000, salaries ₹30,000, software ₹3,000 and other fixed costs ₹2,000: ₹50,000 a month. */
const FIXED: ProfitCost[] = [monthly("rent", 15_000), monthly("staff", 30_000), monthly("software", 3_000), monthly("other", 2_000)];

const setup = (over: Partial<ProfitSetup> = {}): ProfitSetup => ({ productCosts: "known", ads: "known", costs: FIXED, operatingWeekdays: [], completeFrom: "2025-01-01", ...over });

/** A day with `sales` of net sales, its products costing `cost`, and `ads` spent on ads. */
function day(d: string, sales: number, cost: number, ads: number | null = 0, over: Partial<ProfitDay> = {}): ProfitDay {
  return { day: d, imported: true, grossSales: sales, discounts: 0, returns: 0, netSales: sales, shipping: 0, additionalFees: 0, orders: sales > 0 ? 10 : 0, products: { cost, withCost: sales, withoutCost: 0 }, adSpend: ads, ...over };
}

describe("a day's operating profit", () => {
  it("takes off the day's variable costs and its share of the month's fixed costs: the brief's example", () => {
    // November 2026 has 30 days: ₹50,000 ÷ 30 = ₹1,666.67 a day.
    expect(expenseTotals(FIXED, { from: "2026-11-02", to: "2026-11-02" }).byGroup.fixed).toBe(1666.67);
    // Sales ₹10,000; variable costs ₹4,000: products ₹3,000, ads ₹700, payment fees ₹300 paid that day.
    const pl = profitAndLoss([day("2026-11-02", 10_000, 3_000, 700)], setup({ costs: [...FIXED, once("payment_fees", 300, "2026-11-02")] }));
    expect(pl).toMatchObject({ revenue: 10_000, productCosts: 3_000, adSpend: 700, variableCosts: 4_000, fixedCosts: 1666.67, grossProfit: 7_000, operatingProfit: 4333.33, netProfit: 4333.33, gaps: [] });
    expect(pl.operatingMargin).toBeCloseTo(0.433333, 5);
    expect(pl.grossMargin).toBe(0.7);
    expect(outcomeOf(pl.operatingProfit)).toBe("profit");
  });

  it("is a loss when the day's sales don't cover its costs, and break-even when they cover them to the cent", () => {
    const loss = profitAndLoss([day("2026-11-03", 2_000, 1_000)], setup());
    expect(loss.operatingProfit).toBe(-666.67);
    expect(outcomeOf(loss.operatingProfit)).toBe("loss");
    const even = profitAndLoss([day("2026-11-04", 10_000, 8333.33)], setup());
    expect(even.operatingProfit).toBe(0);
    expect(outcomeOf(even.operatingProfit)).toBe("break_even");
    expect(outcomeOf(null)).toBe("missing");
  });

  it("never takes the whole month's fixed costs off one day, whatever the month's length", () => {
    // 28, 29, 30 and 31 days: each cost ÷ its month's days, to the cent.
    const perDay = (d: string) => expenseTotals(FIXED, { from: d, to: d }).byGroup.fixed;
    expect(perDay("2026-02-10")).toBe(1785.71);
    expect(perDay("2028-02-10")).toBe(1724.14);
    expect(perDay("2026-11-10")).toBe(1666.67);
    expect(perDay("2026-10-10")).toBe(1612.9);
    // A whole month is the whole ₹50,000, whatever its days add up to one by one.
    for (const m of ["2026-02", "2028-02", "2026-11", "2026-10"]) expect(expenseTotals(FIXED, monthDays(m)).byGroup.fixed).toBe(50_000);
    expect(monthDays("2028-02")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
  });

  it("spreads fixed costs over the days the store is open, when it says which", () => {
    // Open Monday to Saturday: November 2026 has 25 such days (its five Sundays closed): ₹2,000 each.
    const open = [0, 1, 2, 3, 4, 5];
    expect(operatingDaysBetween("2026-11-01", "2026-11-30", open)).toBe(25);
    const pl = (d: string) => profitAndLoss([day(d, 10_000, 4_000)], setup({ operatingWeekdays: open }));
    expect(pl("2026-11-02").fixedCosts).toBe(2_000);
    expect(pl("2026-11-02").operatingProfit).toBe(4_000);
    // A Sunday carries none; the month still carries all of it.
    expect(pl("2026-11-01").fixedCosts).toBe(0);
    expect(expenseTotals(FIXED, monthDays("2026-11"), open).byGroup.fixed).toBe(50_000);
    // A weekly cost over a 5-day week: a fifth of it a weekday.
    expect(expenseInRange({ amount: 700, cadence: "weekly", startsOn: "2026-01-01", endsOn: null }, { from: "2026-11-02", to: "2026-11-02" }, [0, 1, 2, 3, 4])).toBe(140);
    expect(expenseInRange({ amount: 700, cadence: "weekly", startsOn: "2026-01-01", endsOn: null }, { from: "2026-11-07", to: "2026-11-08" }, [0, 1, 2, 3, 4])).toBe(0);
  });
});

describe("a month's profit", () => {
  // November 2026, every day alike: ₹3,000 of sales, ₹1,200 of products, ₹300 of ads.
  const days = eachDay("2026-11-01", "2026-11-30").map((d) => day(d, 3_000, 1_200, 300));
  const costs = [...FIXED, monthly("packaging", 3_000), monthly("income_tax", 3_000), monthly("interest", 1_500)];

  it("takes off the month's variable and fixed costs for operating profit, then interest and tax for net profit", () => {
    const pl = profitAndLoss(days, setup({ costs }));
    expect(pl).toMatchObject({
      days: 30,
      revenue: 90_000,
      productCosts: 36_000,
      adSpend: 9_000,
      variableCosts: 48_000,
      fixedCosts: 50_000,
      belowOperating: 4_500,
      grossProfit: 54_000,
      operatingProfit: -8_000,
      netProfit: -12_500,
    });
    expect(pl.yours.byGroup).toEqual({ fixed: 50_000, variable: 3_000, non_operating: 4_500 });
    // Nothing counted twice: net profit is revenue less every cost once.
    expect(pl.netProfit).toBe(90_000 - 36_000 - 9_000 - pl.yours.total);
    expect(pl.yours.byCategory[0]).toEqual({ category: "staff", section: "fixed", amount: 30_000 });
  });

  it("counts the month so far while it runs, and only the costs running in it", () => {
    expect(monthDays("2026-11", "2026-11-02")).toEqual({ from: "2026-11-01", to: "2026-11-02" });
    const soFar = profitAndLoss(days.slice(0, 2), setup({ costs }));
    // Two of November's 30 days, one run: a fifteenth of each monthly cost, rounded once.
    expect(soFar.fixedCosts).toBe(3333.33);
    // A cost that ended in October and one starting in December count nothing in November.
    const past = profitAndLoss(days, setup({ costs: [monthly("rent", 15_000, "2025-01-01", "2026-10-31"), monthly("staff", 30_000, "2026-12-01")] }));
    expect(past.fixedCosts).toBe(0);
  });

  it("adds a filter's days up a run of consecutive days at a time", () => {
    expect(runsOf(["2026-11-04", "2026-11-02", "2026-11-03", "2026-11-09"])).toEqual([
      { from: "2026-11-02", to: "2026-11-04" },
      { from: "2026-11-09", to: "2026-11-09" },
    ]);
    // Two days apart: each its own day's share, rounded on its own (₹1,666.67 twice).
    expect(costsOver(FIXED, ["2026-11-02", "2026-11-04"]).byGroup.fixed).toBe(3333.34);
    expect(costsOver(FIXED, ["2026-11-02", "2026-11-03"]).byGroup.fixed).toBe(3333.33);
  });
});

describe("figures that can't be given", () => {
  it("gives no profit for days whose sales weren't imported, never a 0", () => {
    const pl = profitAndLoss([day("2026-11-02", 0, 0, 0, { imported: false })], setup());
    expect(pl).toMatchObject({ revenue: null, netSales: null, grossProfit: null, operatingProfit: null, netProfit: null, afterKnownCosts: null });
    expect(pl.gaps).toContain("sales_not_imported");
  });

  it("gives profit from the costs in the list when it isn't marked complete, and says it isn't", () => {
    const pl = profitAndLoss([day("2026-11-02", 10_000, 3_000, 700)], setup({ completeFrom: null }));
    expect(pl.gaps).toEqual([]);
    expect(pl.costsComplete).toBe(false);
    expect(pl.operatingProfit).toBe(10_000 - 3_000 - 700 - 1666.67);
    expect(pl.netProfit).toBe(pl.operatingProfit);
    expect(pl.afterKnownCosts).toBeNull();
    expect(pl.grossProfit).toBe(7_000);
    // Complete only from a later day: not marked complete for these days, the profit the same.
    const later = profitAndLoss([day("2026-11-02", 10_000, 3_000, 700)], setup({ completeFrom: "2026-11-03" }));
    expect(later).toMatchObject({ costsComplete: false, operatingProfit: pl.operatingProfit });
    expect(profitAndLoss([day("2026-11-02", 10_000, 3_000, 700)], setup()).costsComplete).toBe(true);
  });

  it("gives no gross profit when product costs aren't known whole", () => {
    // Some products sold have no cost per item: the cost is short.
    const short = profitAndLoss([day("2026-11-02", 10_000, 3_000, 0, { products: { cost: 3_000, withCost: 8_000, withoutCost: 2_000 } })], setup());
    expect(short.grossProfit).toBeNull();
    expect(short.variableCosts).toBeNull();
    expect(short.grossGaps).toEqual(["uncosted_sales"]);
    expect(short.uncostedSales).toBe(2_000);
    // None has one.
    expect(profitAndLoss([day("2026-11-02", 10_000, 0, 0, { products: { cost: 0, withCost: 0, withoutCost: 10_000 } })], setup()).grossGaps).toEqual(["no_cost_recorded"]);
    // Not shared, or not shown to this member.
    expect(profitAndLoss([day("2026-11-02", 10_000, 0, 0, { products: null })], setup()).grossGaps).toEqual(["product_costs"]);
    expect(profitAndLoss([day("2026-11-02", 10_000, 3_000)], setup({ productCosts: "unavailable" })).grossGaps).toEqual(["product_costs"]);
    expect(profitAndLoss([day("2026-11-02", 10_000, 3_000)], setup({ productCosts: "hidden" })).productCosts).toBeNull();
  });

  it("counts no ad account as nothing spent through one, and an unknown day of spend as unknown", () => {
    expect(profitAndLoss([day("2026-11-02", 10_000, 3_000, null)], setup({ ads: "none" })).operatingProfit).toBe(5333.33);
    const unknown = profitAndLoss([day("2026-11-02", 10_000, 3_000, null)], setup());
    expect(unknown.operatingProfit).toBeNull();
    expect(unknown.gaps).toEqual(["ad_spend"]);
    expect(profitAndLoss([day("2026-11-02", 10_000, 3_000, 0)], setup({ ads: "unusable" })).gaps).toEqual(["ad_spend"]);
    expect(profitAndLoss([day("2026-11-02", 10_000, 3_000, 0)], setup({ ads: "hidden" })).gaps).toEqual(["ads_hidden"]);
  });

  it("takes the ad spend off only when it is the whole spend in the store's currency", () => {
    const ads = (o: { currency?: string; leftOut?: string[]; demo?: boolean } = {}) => ({ currency: "AUD", leftOut: [], demo: false, ...o });
    expect(profitAds(true, ads(), "AUD")).toBe("known");
    // Meta in AUD, Google in EUR: the AUD spend leaves Google's out, so it isn't the whole spend.
    expect(profitAds(true, ads({ leftOut: ["google-eu"] }), "AUD")).toBe("unusable");
    expect(profitAds(true, ads({ currency: "EUR" }), "AUD")).toBe("unusable");
    expect(profitAds(true, ads({ demo: true }), "AUD")).toBe("unusable");
    expect(profitAds(true, null, "AUD")).toBe("none");
    expect(profitAds(false, ads({ leftOut: ["google-eu"] }), "AUD")).toBe("hidden");
  });
});

describe("refunds, discounts and money", () => {
  it("works from sales after discounts and returns, with shipping and fees charged as revenue", () => {
    const pl = profitAndLoss([day("2026-11-02", 10_000, 3_000, 0, { grossSales: 12_000, discounts: 1_000, returns: 1_000, shipping: 450, additionalFees: 50 })], setup());
    expect(pl).toMatchObject({ grossSales: 12_000, discounts: 1_000, returns: 1_000, netSales: 10_000, shippingAndFees: 500, revenue: 10_500 });
    // Gross profit is Shopify's: net sales less product costs; operating profit is on revenue.
    expect(pl.grossProfit).toBe(7_000);
    expect(pl.operatingProfit).toBe(10_500 - 3_000 - 1666.67);
    // Returns not shown to this member: left out, the rest the same.
    expect(profitAndLoss([day("2026-11-02", 10_000, 3_000, 0, { returns: undefined })], setup()).returns).toBeUndefined();
  });

  it("adds money up in cents", () => {
    const pl = profitAndLoss(
      eachDay("2026-11-01", "2026-11-10").map((d) => day(d, 0.1, 0.07, 0.01)),
      setup({ costs: [] }),
    );
    expect(pl.revenue).toBe(1);
    expect(pl.productCosts).toBe(0.7);
    expect(pl.operatingProfit).toBe(0.2);
  });

  it("takes the days the store is open as Settings → Costs saves them", () => {
    expect(expenseSettingsInput.parse({ operatingWeekdays: [5, 0, 1, 2, 3, 4] })).toEqual({ operatingWeekdays: [0, 1, 2, 3, 4, 5] });
    // All seven are every day, stored one way.
    expect(expenseSettingsInput.parse({ operatingWeekdays: [0, 1, 2, 3, 4, 5, 6] })).toEqual({ operatingWeekdays: [] });
    expect(() => expenseSettingsInput.parse({ operatingWeekdays: [1, 1] })).toThrow();
    expect(() => expenseSettingsInput.parse({ operatingWeekdays: [7] })).toThrow();
    expect(() => expenseSettingsInput.parse({})).toThrow();
    expect(expenseSettingsInput.parse({ completeFrom: null })).toEqual({ completeFrom: null });
  });
});

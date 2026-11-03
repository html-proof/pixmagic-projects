import { describe, expect, it } from "vitest";
import { profitAndLoss, type ProfitCost, type ProfitDay, type ProfitSetup } from "../src/index.js";

/**
 * The owner's own profit and loss workbook (EEq.xlsx, "Dashboard" sheet, 1–31 October, a column a
 * day), worked out again by the profit engine from the same inputs: each day's sales with GST and
 * without, orders, items sold, Meta ad spend and product costs, and the costs the workbook takes off
 * (shipping $20, packaging $3 and transaction fees $0.30 an order, merchant fees 2% of sales with
 * tax on a day with sales, and five monthly fixed costs spread over October's 31 days). Every cost
 * total matches the workbook to the cent. Three of its ratios differ on purpose (docs/kpis.md "Profit
 * and loss"): the workbook divides profit, the variable costs and the fixed costs by sales with tax;
 * bizinsights divides them by revenue before tax, since the tax collected is the government's.
 */

const REVENUE = [112, 1211.8, 337, 930, 1349, 1358, 1132, 1650, 1521, 871, 352, 1441, 613, 1424, 1077, 1747, 2050, 891, 1359, 104, 1416, 493, 1084, 2938, 2082, 35, 62, -431, 854, 1021, 2647.7];
const EX_TAX = [
  101.82, 1101.64, 306.36, 845.45, 1226.36, 1234.55, 1029.09, 1500, 1382.73, 791.82, 320, 1310, 557.27, 1294.55, 979.09, 1588.18, 1863.64, 810, 1235.45, 94.55, 1287.27, 448.18, 985.45, 2670.91, 1892.73, 31.82, 56.36, -391.82, 776.36,
  928.18, 2407,
];
const ORDERS = [1, 5, 2, 3, 5, 5, 3, 9, 5, 2, 2, 5, 2, 4, 4, 5, 6, 3, 5, 1, 4, 3, 6, 9, 6, 2, 1, 1, 4, 2, 5];
const ITEMS = [1, 6, 7, 4, 5, 6, 3, 17, 7, 2, 2, 11, 2, 5, 4, 5, 15, 3, 5, 1, 5, 3, 5, 15, 12, 2, 1, 5, 11, 2, 38];
const META = [
  406.65, 402.95, 340.11, 422.46, 392.96, 367.04, 355.97, 366.58, 348.58, 335.36, 447.15, 331.45, 394.09, 355.1, 360.82, 377.78, 321.31, 450.43, 364.93, 335.62, 424.95, 390.85, 347.2, 368.9, 541.72, 431.27, 414.3, 368.7, 382.51, 424.55,
  378.48,
];
const PRODUCT = [28, 302.95, 84.25, 232.5, 337.25, 339.5, 283, 412.5, 380.25, 217.75, 88, 360.25, 153.25, 356, 269.25, 436.75, 512.5, 222.75, 339.75, 26, 354, 123.25, 271, 734.5, 520.5, 8.75, 15.5, 0, 213.5, 255.25, 661.93];

const DAYS: ProfitDay[] = REVENUE.map((revenue, i) => ({
  day: `2026-10-${String(i + 1).padStart(2, "0")}`,
  imported: true,
  grossSales: EX_TAX[i]!,
  discounts: 0,
  returns: 0,
  netSales: EX_TAX[i]!,
  shipping: 0,
  additionalFees: 0,
  orders: ORDERS[i]!,
  totalSales: revenue,
  units: ITEMS[i]!,
  products: { cost: PRODUCT[i]!, withCost: EX_TAX[i]!, withoutCost: 0 },
  adSpend: META[i]!,
  adSpendBy: { meta: META[i]!, google: 0 },
}));

const rule = (category: ProfitCost["category"], method: "percent" | "per_order", amount: number): ProfitCost => ({ category, method, amount, percentBase: method === "percent" ? "total_sales" : null, cadence: "daily", startsOn: "2026-01-01", endsOn: null });
const monthly = (category: ProfitCost["category"], amount: number): ProfitCost => ({ category, amount, cadence: "monthly", startsOn: "2026-01-01", endsOn: null });

const COSTS: ProfitCost[] = [
  rule("shipping", "per_order", 20),
  rule("packaging", "per_order", 3),
  rule("payment_fees", "per_order", 0.3),
  rule("merchant_fees", "percent", 2),
  monthly("fixed_ads", 2_300),
  monthly("other", 1_500),
  monthly("operating", 4_784),
  monthly("software", 650),
  monthly("staff", 2_500),
];
const SETUP: ProfitSetup = { productCosts: "known", ads: "known", costs: COSTS, operatingWeekdays: [], completeFrom: "2026-01-01" };

describe("the owner's October workbook, worked out by bizinsights", () => {
  const month = profitAndLoss(DAYS, SETUP);

  it("has the workbook's sales, tax and sales stats", () => {
    expect(month).toMatchObject({ totalSales: 33_731.5, revenue: 30_664.99, taxes: 3_066.51, orders: 120, units: 210 });
  });

  it("has the workbook's advertising, variable, fixed and total costs, to the cent", () => {
    expect(month.advertising).toBe(11_950.77);
    expect(month.adSpendBy).toEqual({ meta: 11_950.77, google: 0 });
    expect(month.productCosts).toBe(8_540.63);
    const cost = (c: string) => month.yours.byCategory.find((x) => x.category === c)?.amount;
    expect([cost("shipping"), cost("packaging"), cost("payment_fees"), cost("merchant_fees")]).toEqual([2_400, 360, 36, 683.25]);
    expect(month.variableExAds).toBe(12_019.88);
    expect(month.fixedCosts).toBe(11_734);
    expect(month.totalExpenses).toBe(35_704.65);
  });

  it("has the workbook's profit, a cent apart where it rounds sales before tax differently", () => {
    // The workbook takes 33,731.50 ÷ 1.1 = 30,665.00 for the month; its own days before tax add up to 30,664.99, as Shopify's do.
    expect(month.netProfit).toBe(-5_039.66);
    expect(month.operatingProfit).toBe(-5_039.66);
  });

  it("has the workbook's MER and sitewide ROAS, and gives the cost ratios and margin on revenue before tax", () => {
    expect(month.mer).toBeCloseTo(0.3543, 4);
    expect(month.roas).toBeCloseTo(2.8225, 4);
    // The workbook: VCR 35.63%, FCR 34.79%, profit −14.94%, each ÷ sales with tax.
    expect(month.vcr).toBeCloseTo(0.392, 3);
    expect(month.fcr).toBeCloseTo(0.3827, 4);
    expect(month.netMargin).toBeCloseTo(-0.1643, 4);
  });

  it("has the workbook's figures day by day, the day of a refund included", () => {
    const first = profitAndLoss([DAYS[0]!], SETUP);
    expect(first).toMatchObject({ variableExAds: 53.54, fixedCosts: 378.52, totalExpenses: 838.71, netProfit: -736.89 });
    // 28 October: −$431 of sales (a refund). Its merchant fee is 0, its order costs still count, and no ratio is given on negative sales.
    const refund = profitAndLoss([DAYS[27]!], SETUP);
    expect(refund).toMatchObject({ totalSales: -431, variableExAds: 23.3, fixedCosts: 378.52, totalExpenses: 770.52, netProfit: -1_162.34, mer: null, vcr: null, netMargin: null });
    expect(refund.roas).toBeCloseTo(-1.169, 3);
  });
});

import { describe, expect, it } from "vitest";
import {
  categoryLabel,
  categorySection,
  dueDate,
  dueOccurrences,
  expenseInput,
  expenseInRange,
  expenseTotals,
  nextDue,
  occurrences,
  type DayFigures,
  type ExpenseInputSent,
  type ExpenseTerms,
} from "../src/index.js";

/**
 * The Profit & Loss page's costs: when each payment of a recurring cost falls due and which days it
 * pays for, how a payment recorded with another amount (or skipped) and a pause count, the costs that
 * follow the sales (a percentage, an amount per order or per item), the store's own categories, and
 * what the API takes.
 */

const terms = (over: Partial<ExpenseTerms>): ExpenseTerms => ({ amount: 100, cadence: "monthly", startsOn: "2026-01-01", endsOn: null, ...over });

describe("when a recurring cost's payments fall due", () => {
  it("keeps a month's day of the month, or the month's last day when it has none", () => {
    expect([0, 1, 2, 3].map((k) => dueDate("2026-01-31", "monthly", k))).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
    expect([0, 1, 2].map((k) => dueDate("2027-11-30", "quarterly", k))).toEqual(["2027-11-30", "2028-02-29", "2028-05-30"]);
    expect([0, 1, 2].map((k) => dueDate("2026-03-15", "half_yearly", k))).toEqual(["2026-03-15", "2026-09-15", "2027-03-15"]);
    expect([0, 1].map((k) => dueDate("2028-02-29", "yearly", k))).toEqual(["2028-02-29", "2029-02-28"]);
    expect([0, 1, 2].map((k) => dueDate("2026-10-30", "fortnightly", k))).toEqual(["2026-10-30", "2026-11-13", "2026-11-27"]);
    expect([0, 1].map((k) => dueDate("2026-12-31", "daily", k))).toEqual(["2026-12-31", "2027-01-01"]);
  });

  it("covers the days up to the next payment, and stops at the end date with that payment's share", () => {
    expect(occurrences(terms({ startsOn: "2026-10-15" }), "2026-10-01", "2026-11-30")).toEqual([
      { due: "2026-10-15", from: "2026-10-15", to: "2026-11-14", periodTo: "2026-11-14", amount: 100, recorded: false },
      { due: "2026-11-15", from: "2026-11-15", to: "2026-12-14", periodTo: "2026-12-14", amount: 100, recorded: false },
    ]);
    // Ends on 19 Dec: the December payment counts on 15–19 Dec only.
    const ending = occurrences(terms({ startsOn: "2026-10-15", endsOn: "2026-12-19" }), "2026-12-01", "2026-12-31");
    expect(ending.map((o) => [o.due, o.to, o.periodTo])).toEqual([
      ["2026-11-15", "2026-12-14", "2026-12-14"],
      ["2026-12-15", "2026-12-19", "2027-01-14"],
    ]);
    // In the profit and loss, a monthly cost is its calendar month's share: 19 of December's 31 days.
    expect(expenseInRange(terms({ startsOn: "2026-10-15", endsOn: "2026-12-19" }), { from: "2026-12-01", to: "2026-12-31" })).toBe(61.29);
    // A weekly one ending mid-week counts its last payment's days up to the end: 3 of 7.
    expect(expenseInRange(terms({ amount: 70, cadence: "weekly", startsOn: "2026-10-05", endsOn: "2026-10-14" }), { from: "2026-10-01", to: "2026-10-31" })).toBe(100);
    // A cost paid once is its one day.
    expect(occurrences(terms({ cadence: "once", startsOn: "2026-10-05" }), "2026-10-01", "2026-10-31")).toEqual([{ due: "2026-10-05", from: "2026-10-05", to: "2026-10-05", periodTo: "2026-10-05", amount: 100, recorded: false }]);
    // A percentage has no payments of its own.
    expect(occurrences(terms({ method: "percent", percentBase: "revenue", amount: 2 }), "2026-10-01", "2026-10-31")).toEqual([]);
  });

  it("records each payment once it has fallen due, and says when the next one is", () => {
    const rent = terms({ amount: 2_300, startsOn: "2026-08-15" });
    expect(dueOccurrences(rent, "2026-11-03").map((o) => o.due)).toEqual(["2026-08-15", "2026-09-15", "2026-10-15"]);
    expect(dueOccurrences(rent, "2026-11-15").map((o) => o.due)).toEqual(["2026-08-15", "2026-09-15", "2026-10-15", "2026-11-15"]);
    expect(nextDue(rent, "2026-11-03")).toBe("2026-11-15");
    expect(nextDue(rent, "2026-11-15")).toBe("2026-12-15");
    expect(nextDue({ ...rent, endsOn: "2026-12-01" }, "2026-11-20")).toBeNull();
    // Paused: nothing falls due from the day it was paused on, and there is no next payment.
    expect(dueOccurrences({ ...rent, pausedFrom: "2026-10-01" }, "2026-11-20").map((o) => o.due)).toEqual(["2026-08-15", "2026-09-15"]);
    expect(nextDue({ ...rent, pausedFrom: "2026-10-01" }, "2026-11-20")).toBeNull();
    // A cost paid once falls due on its day; nothing after it.
    expect(nextDue(terms({ cadence: "once", startsOn: "2026-12-01" }), "2026-11-20")).toBe("2026-12-01");
    expect(dueOccurrences(terms({ cadence: "once", startsOn: "2026-10-01" }), "2026-11-20")).toEqual([]);
  });
});

describe("a recurring cost in the profit and loss", () => {
  it("spreads a month's payment over its calendar month, a quarter's over its calendar quarter", () => {
    const quarterly = terms({ amount: 900, cadence: "quarterly", startsOn: "2026-02-15" });
    // Each calendar month of a whole quarter: a third (Q2: April, May, June).
    expect(expenseInRange(quarterly, { from: "2026-04-01", to: "2026-06-30" })).toBe(900);
    expect(expenseInRange(quarterly, { from: "2026-07-01", to: "2026-07-31" })).toBeCloseTo((900 * 31) / 92, 2);
    expect(expenseInRange(terms({ amount: 1_200, cadence: "half_yearly" }), { from: "2026-01-01", to: "2026-12-31" })).toBe(2_400);
    // Fortnightly: a fourteenth a day.
    expect(expenseInRange(terms({ amount: 140, cadence: "fortnightly", startsOn: "2026-10-01" }), { from: "2026-10-01", to: "2026-10-31" })).toBe(310);
    expect(expenseInRange(terms({ amount: 5, cadence: "daily", startsOn: "2026-10-01" }), { from: "2026-10-01", to: "2026-10-31" })).toBe(155);
  });

  it("counts a payment recorded with another amount in its own month, and leaves the others as they were", () => {
    const power = terms({ amount: 200, startsOn: "2026-08-01", payments: [{ due: "2026-10-01", amount: 230 }] });
    expect(expenseInRange(power, { from: "2026-09-01", to: "2026-09-30" })).toBe(200);
    expect(expenseInRange(power, { from: "2026-10-01", to: "2026-10-31" })).toBe(230);
    expect(expenseInRange(power, { from: "2026-10-01", to: "2026-10-10" })).toBe(74.19);
    // A skipped payment (recorded at 0) counts nothing in its month.
    expect(expenseInRange({ ...power, payments: [{ due: "2026-09-01", amount: 0 }] }, { from: "2026-08-01", to: "2026-10-31" })).toBe(400);
    // Weekly payments recorded one by one: that week's days carry that payment.
    const cleaner = terms({ amount: 70, cadence: "weekly", startsOn: "2026-10-05", payments: [{ due: "2026-10-12", amount: 140 }] });
    expect(expenseInRange(cleaner, { from: "2026-10-05", to: "2026-10-18" })).toBe(210);
  });

  it("counts nothing for the periods whose payment falls due while it is paused", () => {
    const app = terms({ amount: 30, startsOn: "2026-08-10", pausedFrom: "2026-10-01" });
    expect(expenseInRange(app, { from: "2026-09-01", to: "2026-09-30" })).toBe(30);
    // October's payment (10 Oct) would fall due while paused.
    expect(expenseInRange(app, { from: "2026-10-01", to: "2026-12-31" })).toBe(0);
  });
});

describe("a cost that follows the sales", () => {
  const sales: Record<string, DayFigures> = {
    "2026-10-27": { totalSales: 62, revenue: 56.36, netSales: 56.36, orders: 1, units: 1 },
    "2026-10-28": { totalSales: -431, revenue: -391.82, netSales: -391.82, orders: 1, units: 5 },
    "2026-10-29": { totalSales: 854, revenue: 776.36, netSales: 776.36, orders: 4, units: 11 },
  };
  const figures = (d: string) => sales[d];
  const range = { from: "2026-10-27", to: "2026-10-29" };

  it("takes a percentage of each day's sales, never below 0 on a day refunds outweigh them", () => {
    const merchant = terms({ method: "percent", percentBase: "total_sales", amount: 2, cadence: "daily", startsOn: "2026-10-01" });
    // 2% of 62 and of 854; nothing on the day of −431.
    expect(expenseInRange(merchant, range, [], figures)).toBe(18.32);
    expect(expenseInRange({ ...merchant, percentBase: "revenue" }, range, [], figures)).toBe(16.66);
    // Without the days' sales there is nothing to take it of.
    expect(expenseInRange(merchant, range)).toBe(0);
  });

  it("takes an amount per order or per item sold, from the day it starts to the day it ends", () => {
    const shipping = terms({ method: "per_order", amount: 20, cadence: "daily", startsOn: "2026-10-01" });
    expect(expenseInRange(shipping, range, [], figures)).toBe(120);
    expect(expenseInRange({ ...shipping, startsOn: "2026-10-28", endsOn: "2026-10-28" }, range, [], figures)).toBe(20);
    expect(expenseInRange(terms({ method: "per_item", amount: 0.5, cadence: "daily", startsOn: "2026-10-01" }), range, [], figures)).toBe(8.5);
  });
});

describe("the store's own categories", () => {
  const customs = [{ id: "ckwarehouse01", name: "Warehouse", section: "fixed" as const }];

  it("names a custom category and puts its costs in its section", () => {
    expect(categorySection("custom:ckwarehouse01", customs)).toBe("fixed");
    expect(categoryLabel("custom:ckwarehouse01", customs)).toBe("Warehouse");
    expect(categorySection("custom:ckgone0000001", customs)).toBeNull();
    expect(categoryLabel("custom:ckgone0000001", customs)).toBe("Category removed");
    expect(categorySection("marketing")).toBe("advertising");
    const totals = expenseTotals(
      [
        { ...terms({ amount: 500 }), category: "custom:ckwarehouse01", section: "fixed" },
        { ...terms({ amount: 300 }), category: "marketing" },
      ],
      { from: "2026-10-01", to: "2026-10-31" },
    );
    expect(totals.byCategory).toEqual([
      { category: "custom:ckwarehouse01", section: "fixed", amount: 500 },
      { category: "marketing", section: "advertising", amount: 300 },
    ]);
    // Advertising counts with the variable costs in operating profit.
    expect(totals.byGroup).toEqual({ fixed: 500, variable: 300, non_operating: 0 });
    expect(totals.bySection).toEqual({ advertising: 300, variable: 0, fixed: 500, non_operating: 0 });
  });
});

describe("what the cost form may save", () => {
  const base: ExpenseInputSent = { name: "Cost", category: "other", amount: 100, cadence: "monthly", startsOn: "2026-01-01", endsOn: null, note: null };

  it("takes a cost from before the new fields, with their defaults", () => {
    expect(expenseInput.parse(base)).toEqual({ ...base, description: null, method: "amount", percentBase: null, currency: null, vendor: null, paymentMethod: null });
  });

  it("takes the new fields, blank text as none", () => {
    const parsed = expenseInput.parse({ ...base, description: "  ", vendor: " Australia Post ", paymentMethod: "Card", currency: "AUD", category: "custom:ckwarehouse01" });
    expect(parsed).toMatchObject({ description: null, vendor: "Australia Post", paymentMethod: "Card", currency: "AUD", category: "custom:ckwarehouse01" });
    expect(() => expenseInput.parse({ ...base, category: "custom:x" })).toThrow();
    expect(() => expenseInput.parse({ ...base, category: "rent2" })).toThrow();
    expect(() => expenseInput.parse({ ...base, currency: "aud" })).toThrow();
  });

  it("takes an amount below 0 only once: a refund or a credit", () => {
    expect(expenseInput.parse({ ...base, cadence: "once", amount: -49.5 }).amount).toBe(-49.5);
    expect(() => expenseInput.parse({ ...base, amount: -49.5 })).toThrow("Only an amount paid once");
  });

  it("takes a percentage with what it is of, follows each day's sales, and refuses one above 100", () => {
    expect(expenseInput.parse({ ...base, method: "percent", percentBase: "total_sales", amount: 2.9 })).toMatchObject({ cadence: "daily", amount: 2.9, percentBase: "total_sales" });
    expect(() => expenseInput.parse({ ...base, method: "percent", amount: 2.9 })).toThrow("Say what the percentage is of");
    expect(() => expenseInput.parse({ ...base, method: "percent", percentBase: "revenue", amount: 101 })).toThrow("at most 100");
    expect(() => expenseInput.parse({ ...base, percentBase: "revenue" })).toThrow("Say what the percentage is of");
    expect(expenseInput.parse({ ...base, method: "per_order", amount: 0.3, cadence: "once" }).cadence).toBe("daily");
  });
});

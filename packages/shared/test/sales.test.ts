import { describe, expect, it } from "vitest";
import { dailyBreakdown, dayTiers, eachDay, niceRound, tierOf, weekdayOf, yearBreakdown, type DailyMetricsRow, type SalesDay } from "../src/index.js";

const day = (d: string, netSales: number, orders = netSales > 0 ? 1 : 0): SalesDay => ({
  day: d,
  netSales,
  totalSales: netSales,
  orders,
  refunds: 0,
  averageOrderValue: orders ? netSales / orders : null,
});

const row = (d: string, grossSales: number, extra: Partial<DailyMetricsRow> = {}): DailyMetricsRow => ({
  day: d,
  grossSales,
  discounts: 0,
  refunds: 0,
  shipping: 0,
  taxes: 0,
  duties: 0,
  additionalFees: 0,
  totalSales: grossSales,
  orders: grossSales > 0 ? 1 : 0,
  orderValue: grossSales,
  units: 0,
  ordersWithCustomer: 0,
  returningCustomerOrders: 0,
  refundedOrders: 0,
  ...extra,
});

describe("day tiers", () => {
  it("rounds to figures a merchant would set as targets", () => {
    expect(niceRound(1530)).toBe(1500);
    expect(niceRound(2040)).toBe(2000);
    expect(niceRound(765)).toBe(750);
    expect(niceRound(1.2)).toBe(1);
    expect(niceRound(0)).toBe(0);
    expect(niceRound(-5)).toBe(0);
  });

  it("sets strong and best days relative to the store's own average", () => {
    // A$30,597 over 30 days: the screenshot's A$1,500 and A$2,000 lines.
    expect(dayTiers(1020)).toEqual({ strong: 1500, best: 2000 });
    expect(dayTiers(48)).toEqual({ strong: 70, best: 95 });
    expect(dayTiers(0)).toBeNull();
    expect(dayTiers(null)).toBeNull();
    const t = dayTiers(1020);
    expect([tierOf(2000, t), tierOf(1999.99, t), tierOf(1500, t), tierOf(0, t), tierOf(-40, t), tierOf(5000, null)]).toEqual([3, 2, 2, 1, 1, 1]);
  });

  it("names weekdays Monday first", () => {
    expect(weekdayOf("2026-10-05")).toBe(0); // Monday
    expect(weekdayOf("2026-10-11")).toBe(6); // Sunday
  });
});

describe("daily breakdown", () => {
  it("grades days only once there are two weeks of finished ones", () => {
    const days = eachDay("2026-09-01", "2026-09-14").map((d) => day(d, d.endsWith("05") ? 400 : 100));
    const graded = dailyBreakdown(days, "2026-10-09", null);
    expect(graded.tiers).toEqual({ strong: 200, best: 250 });
    expect(graded.days.filter((d) => d.tier === 3).map((d) => d.day)).toEqual(["2026-09-05"]);
    const short = dailyBreakdown(days.slice(1), "2026-10-09", null);
    expect(short.tiers).toBeNull();
    expect(short.days.every((d) => d.tier === 1)).toBe(true);
  });

  it("keeps days before the imported history apart from quiet days, and today apart from finished ones", () => {
    const b = dailyBreakdown(
      [day("2026-06-28", 0), day("2026-06-29", 100), day("2026-06-30", 0), day("2026-07-01", 40)],
      "2026-07-01",
      "2026-06-29",
    );
    expect(b.days.map((d) => [d.status, d.cumulative])).toEqual([
      ["not_imported", null],
      ["complete", 100],
      ["complete", 100],
      ["today", 140],
    ]);
    // Finished, imported days only: (100 + 0) / 2.
    expect(b.average).toBe(50);
    expect(b.total).toBe(140);
    expect(b.importedDays).toBe(3);
    expect(b.daysWithSales).toBe(2);
    expect(b.best).toEqual({ day: "2026-06-29", netSales: 100 });
    // Two finished days are too few to grade.
    expect(b.tiers).toBeNull();
  });

  it("names the months it covers whole, but not the one still running or one not fully imported", () => {
    const june = eachDay("2026-06-01", "2026-07-01").map((d) => day(d, 10));
    expect(dailyBreakdown(june, "2026-07-01", null).fullMonths).toEqual(["2026-06"]);
    expect(dailyBreakdown(june, "2026-07-01", "2026-06-10").fullMonths).toEqual([]);
    expect(dailyBreakdown(june, "2026-06-30", null).fullMonths).toEqual([]);
    expect(dailyBreakdown(june.slice(1), "2026-07-01", null).fullMonths).toEqual([]);
  });

  it("finds the best weekday once there are two full weeks", () => {
    // Saturdays sell 300, every other day 100.
    const days = eachDay("2026-09-01", "2026-09-14").map((d) => day(d, weekdayOf(d) === 5 ? 300 : 100));
    expect(dailyBreakdown(days, "2026-10-09", null).bestWeekday).toEqual({ weekday: 5, average: 300 });
    expect(dailyBreakdown(days.slice(1), "2026-10-09", null).bestWeekday).toBeNull();
    expect(dailyBreakdown([], "2026-10-09", null)).toMatchObject({ total: 0, average: null, best: null, tiers: null, fullMonths: [] });
  });
});

describe("year breakdown", () => {
  const rows = [
    row("2025-12-15", 999),
    row("2026-07-19", 100),
    row("2026-07-31", 50, { discounts: 10 }),
    row("2026-08-10", 200),
    row("2026-09-03", 120),
    row("2026-09-20", 280, { refunds: 30 }),
    row("2026-10-02", 90),
  ];

  it("leaves months before the imported history out, and compares only fully imported months", () => {
    const y = yearBreakdown(rows, "2026-10-09", "2026-07-19");
    expect(y.year).toBe(2026);
    expect(y.months.map((m) => m.month)).toEqual(["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]);
    expect(y.months.slice(0, 6).every((m) => m.coverage === "none" && m.netSales === 0 && m.change === null)).toBe(true);

    const [jul, aug, sep, oct] = y.months.slice(6);
    expect(jul).toMatchObject({ coverage: "partial", netSales: 140, orders: 2, change: null });
    // August is whole, but July isn't, so there's nothing fair to compare it with.
    expect(aug).toMatchObject({ coverage: "full", netSales: 200, change: null, comparedWith: null });
    expect(sep).toMatchObject({ coverage: "full", netSales: 370, refunds: 30, orders: 2, averageOrderValue: 200, change: 0.85 });
    expect(sep!.comparedWith).toEqual({ from: "2026-08-01", to: "2026-08-31" });
    // October so far (1–9) against 1–9 September, not all of it.
    expect(oct).toMatchObject({ current: true, from: "2026-10-01", to: "2026-10-09", netSales: 90, change: -0.25 });
    expect(oct!.comparedWith).toEqual({ from: "2026-09-01", to: "2026-09-09" });

    expect(y.total).toBe(800);
    expect(y.orders).toBe(6);
  });

  it("compares January with December, and a long month's end with a short month's", () => {
    const all = yearBreakdown(rows, "2026-10-09", null);
    expect(all.months[0]).toMatchObject({ coverage: "full", netSales: 0, change: -1 });
    expect(all.months[0]!.comparedWith).toEqual({ from: "2025-12-01", to: "2025-12-31" });

    const march = yearBreakdown([row("2026-02-10", 100), row("2026-03-30", 50)], "2026-03-30", null).months.at(-1)!;
    expect(march.comparedWith).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(march.change).toBe(-0.5);
  });
});

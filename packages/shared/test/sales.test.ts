import { describe, expect, it } from "vitest";
import {
  customSalesMonths,
  dailyBreakdown,
  dayTiers,
  eachDay,
  NET_SALES_MONTHS,
  niceRound,
  pastYearBreakdown,
  periodBreakdown,
  SHOPIFY_STANDARD,
  splitTotal,
  tierOf,
  TOTAL_SALES_MONTHS,
  weekdayOf,
  yearBreakdown,
  yearFigures,
  type DailyMetricsRow,
  type SalesDay,
} from "../src/index.js";

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
  totalRefunded: 0,
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
    expect(b.best).toEqual({ day: "2026-06-29", value: 100 });
    // Two finished days are too few to grade.
    expect(b.tiers).toBeNull();
  });

  it("groups the days into Monday-to-Sunday weeks and calendar months, keeping what isn't whole apart", () => {
    // Wednesday 30 Sep to Thursday 15 Oct; today is the 15th; orders imported from 1 Oct.
    const days = eachDay("2026-09-30", "2026-10-15").map((d) => day(d, 10));
    const range = { from: "2026-09-30", to: "2026-10-15" };
    const b = dailyBreakdown(days, "2026-10-15", "2026-10-01");
    const weeks = periodBreakdown(b, range, "week");
    expect(weeks.map((w) => [w.key, w.from, w.to, w.status, w.clipped, w.value, w.cumulative])).toEqual([
      // Wed 30 Sep – Sun 4 Oct: cut short by the dates, and its first day wasn't imported.
      ["2026-W40", "2026-09-30", "2026-10-04", "partial", true, 40, 40],
      ["2026-W41", "2026-10-05", "2026-10-11", "complete", false, 70, 110],
      // Mon 12 – Thu 15 Oct: holds today.
      ["2026-W42", "2026-10-12", "2026-10-15", "partial", true, 40, 150],
    ]);
    expect(weeks[1]!.orders).toBe(7);
    const months = periodBreakdown(b, range, "month");
    expect(months.map((m) => [m.key, m.status, m.clipped, m.value, m.cumulative])).toEqual([
      // 30 Sep alone, never imported: not a $0 month.
      ["2026-09", "not_imported", true, 0, null],
      ["2026-10", "partial", true, 150, 150],
    ]);
    // A whole finished month is complete and not clipped.
    const sept = eachDay("2026-09-01", "2026-09-30").map((d) => day(d, 1));
    expect(periodBreakdown(dailyBreakdown(sept, "2026-10-15", null), { from: "2026-09-01", to: "2026-09-30" }, "month")).toMatchObject([{ status: "complete", clipped: false, value: 30, orders: 30 }]);
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

  it("measures the days by another figure when given one, and keeps each day's net sales as they are", () => {
    // Net sales 100 every day; the measure adds shipping, which only Saturdays have (300).
    const days = eachDay("2026-09-01", "2026-09-14").map((d) => ({ ...day(d, 100), shipping: weekdayOf(d) === 5 ? 300 : 0 }));
    const net = dailyBreakdown(days, "2026-10-09", null);
    expect(net).toMatchObject({ total: 1400, average: 100, best: { day: "2026-09-01", value: 100 } });
    expect(net.days.every((d) => d.tier === 1)).toBe(true);

    const b = dailyBreakdown(days, "2026-10-09", null, (d) => d.netSales + d.shipping);
    expect(b.total).toBe(2000);
    expect(b.average).toBe(142.86);
    // Tiers, the best day and the best weekday follow the measure.
    expect(b.tiers).toEqual({ strong: 200, best: 300 });
    expect(b.days.filter((d) => d.tier === 3).map((d) => d.day)).toEqual(["2026-09-05", "2026-09-12"]);
    expect(b.best).toEqual({ day: "2026-09-05", value: 400 });
    expect(b.bestWeekday).toEqual({ weekday: 5, average: 400 });
    expect(b.days.at(-1)!.cumulative).toBe(2000);
    expect(b.days[4]).toMatchObject({ day: "2026-09-05", value: 400, netSales: 100 });
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

  it("leaves months before the imported history out", () => {
    const y = yearBreakdown(rows, "2026-10-09", "2026-07-19");
    expect(y.year).toBe(2026);
    expect(y.months.map((m) => m.month)).toEqual(["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]);
    expect(y.months.slice(0, 6).every((m) => m.coverage === "none" && m.netSales === 0)).toBe(true);

    const [jul, aug, sep, oct] = y.months.slice(6);
    expect(jul).toMatchObject({ coverage: "partial", netSales: 140, orders: 2 });
    expect(aug).toMatchObject({ coverage: "full", netSales: 200 });
    expect(sep).toMatchObject({ coverage: "full", netSales: 370, refunds: 30, orders: 2, averageOrderValue: 200 });
    // October so far (1–9).
    expect(oct).toMatchObject({ current: true, from: "2026-10-01", to: "2026-10-09", netSales: 90 });
    // A month carries its own figures only: nothing of the month before.
    for (const m of y.months) for (const k of ["change", "comparedWith", "comparedLines"]) expect(m).not.toHaveProperty(k);

    expect(y.total).toBe(800);
    expect(y.orders).toBe(6);
  });

  it("counts every month when the whole history is imported, the year before left out", () => {
    const all = yearBreakdown(rows, "2026-10-09", null);
    expect(all.months[0]).toMatchObject({ month: "2026-01", coverage: "full", netSales: 0 });
    expect(all.total).toBe(800);

    const march = yearBreakdown([row("2026-02-10", 100), row("2026-03-30", 50)], "2026-03-30", null).months.at(-1)!;
    expect(march).toMatchObject({ month: "2026-03", from: "2026-03-01", to: "2026-03-30", netSales: 50 });
  });
});

describe("the same months of the years before", () => {
  const rows = [row("2024-02-29", 40), row("2024-03-05", 60), row("2025-02-10", 100), row("2025-02-28", 25), row("2025-03-31", 70), row("2025-04-01", 999), row("2026-02-10", 10)];

  it("covers January to this month, each month whole, none of them running", () => {
    const y = pastYearBreakdown(rows, "2026-02-18", 1, null);
    expect(y.year).toBe(2025);
    expect(y.months.map((m) => [m.month, m.from, m.to, m.current])).toEqual([
      ["2025-01", "2025-01-01", "2025-01-31", false],
      ["2025-02", "2025-02-01", "2025-02-28", false],
    ]);
    // All of February 2025, though February 2026 is only at the 18th.
    expect(y.months[1]).toMatchObject({ netSales: 125, orders: 2 });
    expect(y.total).toBe(125);
    // A leap year's February runs to the 29th.
    expect(pastYearBreakdown(rows, "2026-02-18", 2, null).months[1]).toMatchObject({ to: "2024-02-29", netSales: 40 });
    // Nothing after this month's end comes in (April 2025 against a March 2026).
    expect(pastYearBreakdown(rows, "2026-03-02", 1, null).total).toBe(195);
  });

  it("says which of those months weren't imported", () => {
    const y = pastYearBreakdown(rows, "2026-03-02", 2, "2024-03-01");
    expect(y.months.map((m) => m.coverage)).toEqual(["none", "none", "full"]);
    expect(y.months[1]).toMatchObject({ netSales: 0, orders: 0 });
    expect(y.total).toBe(60);
  });
});

describe("total sales month by month", () => {
  it("measures a month by its total sales", () => {
    const y = yearBreakdown([row("2026-01-10", 100), row("2026-02-03", 150, { totalSales: 180 })], "2026-02-28", null);
    expect(y.months.map(TOTAL_SALES_MONTHS.value)).toEqual([100, 180]);
    expect(yearFigures(y.months, TOTAL_SALES_MONTHS).total).toBe(280);
  });
});

describe("the lines of total sales by month, and Custom sales from them", () => {
  // Amounts a floating-point sum gets wrong (0.1 + 0.2...), so the cents must hold.
  const lined = (d: string, gross: number, lines: Pick<DailyMetricsRow, "shipping" | "taxes" | "duties" | "additionalFees" | "totalSales">, extra: Partial<DailyMetricsRow> = {}) =>
    row(d, gross, { ...lines, ...extra });
  const rows = [
    // Before the imported history: never counted.
    lined("2026-07-20", 500, { shipping: 9, taxes: 50, duties: 0, additionalFees: 0, totalSales: 559 }),
    lined("2026-08-05", 100.1, { shipping: 10.05, taxes: 11.02, duties: 0.3, additionalFees: 0.2, totalSales: 121.67 }),
    lined("2026-08-06", 0.2, { shipping: 0.1, taxes: 0.02, duties: 0, additionalFees: 0, totalSales: 0.32 }),
    lined("2026-08-20", 50, { shipping: 5, taxes: 5.5, duties: 1, additionalFees: 0.5, totalSales: 62 }),
    lined("2026-09-02", 80, { shipping: 6.6, taxes: 7.3, duties: 0, additionalFees: 0.1, totalSales: 87 }, { discounts: 5, refunds: 2 }),
  ];
  const y = yearBreakdown(rows, "2026-09-10", "2026-08-01");
  const [aug, sep] = y.months.slice(7);
  const exclTax = { ...SHOPIFY_STANDARD, taxes: false };

  it("adds up each month's lines", () => {
    expect(aug).toMatchObject({ coverage: "full", netSales: 150.3, additionalFees: 0.7, duties: 1.3, shipping: 15.15, taxes: 16.54, totalSales: 183.99 });
    expect(sep).toMatchObject({ current: true, netSales: 73, additionalFees: 0.1, duties: 0, shipping: 6.6, taxes: 7.3, totalSales: 87 });
    // The lines make total sales to the cent.
    for (const m of [aug!, sep!]) expect(splitTotal(m).unsplit).toBe(0);
  });

  it("keeps months before the imported history as not imported, with no lines", () => {
    const before = y.months.slice(0, 7);
    expect(before.every((m) => m.coverage === "none")).toBe(true);
    expect(before.every((m) => m.netSales === 0 && m.totalSales === 0 && m.taxes === 0 && m.shipping === 0)).toBe(true);
    // The figures leave them out rather than count them as $0 months.
    const f = yearFigures(y.months, customSalesMonths(exclTax));
    expect(f.months.slice(0, 7).every((m) => m.cumulative === null)).toBe(true);
  });

  it("works out Custom sales per month in cents", () => {
    const custom = customSalesMonths(exclTax);
    expect(custom.value(aug!)).toBe(167.45);
    expect(custom.value(sep!)).toBe(79.7);

    const f = yearFigures(y.months, custom);
    expect(f.months.slice(7)).toEqual([
      { month: "2026-08", value: 167.45, cumulative: 167.45 },
      { month: "2026-09", value: 79.7, cumulative: 247.15 },
    ]);
    expect(f.total).toBe(247.15);
    // Only finished, fully imported months make the average: August alone.
    expect(f).toMatchObject({ average: 167.45, finishedMonths: 1, best: { month: "2026-08", value: 167.45 } });
  });

  it("gives net sales the same figures as the months carry", () => {
    const f = yearFigures(y.months, NET_SALES_MONTHS);
    expect(f.total).toBe(y.total);
    expect(f.months.map((m) => m.value)).toEqual(y.months.map((m) => (m.coverage === "none" ? 0 : m.netSales)));
    expect(f.months.at(-1)).toMatchObject({ value: 73, cumulative: 223.3 });
    // Every line counted is Shopify's total sales.
    expect(yearFigures(y.months, customSalesMonths(SHOPIFY_STANDARD)).total).toBe(270.99);
  });
});

import { describe, expect, it } from "vitest";
import { customRangeProblem, DATE_PRESETS, resolvePreset, rowsByMonth, storeRangeLimits, storeStartDay, weekStart } from "../src/dates.js";

// The dashboard's dates begin where the store does (docs/kpis.md, "Conventions"): This week, All
// time from the store's first day, and custom dates from that day on, of any length.

describe("This week", () => {
  it("starts on Monday, whatever day today is", () => {
    expect(weekStart("2026-10-19")).toBe("2026-10-19"); // a Monday
    expect(weekStart("2026-10-22")).toBe("2026-10-19"); // Thursday
    expect(weekStart("2026-10-25")).toBe("2026-10-19"); // Sunday: still the week that began on Monday
  });

  it("runs from Monday to today, across month and year ends", () => {
    expect(resolvePreset("wtd", new Date("2026-10-22T12:00:00Z"), "UTC").range).toEqual({ from: "2026-10-19", to: "2026-10-22" });
    expect(resolvePreset("wtd", new Date("2026-10-19T12:00:00Z"), "UTC").range).toEqual({ from: "2026-10-19", to: "2026-10-19" });
    // Sunday 1 Nov: the week began in October.
    expect(resolvePreset("wtd", new Date("2026-11-01T12:00:00Z"), "UTC").range).toEqual({ from: "2026-10-26", to: "2026-11-01" });
    // Friday 1 Jan 2027: the week began in 2026.
    expect(resolvePreset("wtd", new Date("2027-01-01T12:00:00Z"), "UTC").range).toEqual({ from: "2026-12-28", to: "2027-01-01" });
  });

  it("follows the store's time zone, not UTC", () => {
    // 14:30 UTC on Sunday 25 Oct is already Monday 26 Oct in Sydney: a new week there.
    const now = new Date("2026-10-25T14:30:00Z");
    expect(resolvePreset("wtd", now, "UTC").range).toEqual({ from: "2026-10-19", to: "2026-10-25" });
    expect(resolvePreset("wtd", now, "Australia/Sydney").range).toEqual({ from: "2026-10-26", to: "2026-10-26" });
  });

  it("is compared with the same days of the week before, up to the same time of day", () => {
    const { range, previous } = resolvePreset("wtd", new Date("2026-10-22T05:30:00Z"), "UTC");
    expect(range).toEqual({ from: "2026-10-19", to: "2026-10-22" });
    // Monday to Thursday against last Monday to Thursday, never the Thursday to Sunday just before.
    expect(previous).toEqual({ from: "2026-10-12", to: "2026-10-15", until: "05:30:00" });
    expect(resolvePreset("wtd", new Date("2026-10-22T05:30:00Z"), "UTC", undefined, { mode: "year" }).previous).toEqual({
      from: "2025-10-19",
      to: "2025-10-22",
      until: "05:30:00",
    });
  });
});

describe("the store's first day", () => {
  it("is the day Shopify created the store, in the store's time zone", () => {
    // 14:00 UTC on 14 March is already 15 March in Melbourne (UTC+11 in March).
    const created = new Date("2022-03-14T14:00:00Z");
    expect(storeStartDay(created, "Australia/Melbourne", null)).toBe("2022-03-15");
    expect(storeStartDay(created, "UTC", null)).toBe("2022-03-14");
  });

  it("is an earlier order's day when orders came from another platform before the store existed on Shopify", () => {
    const created = new Date("2022-03-14T14:00:00Z");
    expect(storeStartDay(created, "Australia/Melbourne", "2019-06-01")).toBe("2019-06-01");
    expect(storeStartDay(created, "Australia/Melbourne", "2023-01-05")).toBe("2022-03-15");
  });

  it("falls back to the first order, and is unknown without either", () => {
    expect(storeStartDay(null, "UTC", "2026-08-25")).toBe("2026-08-25");
    expect(storeStartDay(null, "UTC", null)).toBeNull();
  });
});

describe("All time", () => {
  const now = new Date("2026-10-23T03:00:00Z");
  const limits = storeRangeLimits("2022-03-15", true);

  it("runs from the store's first day to today", () => {
    expect(resolvePreset("all", now, "UTC", undefined, undefined, limits).range).toEqual({ from: "2022-03-15", to: "2026-10-23" });
  });

  it("is only today while the store's first day isn't known yet", () => {
    expect(resolvePreset("all", now, "UTC").range).toEqual({ from: "2026-10-23", to: "2026-10-23" });
    expect(resolvePreset("all", now, "UTC", undefined, undefined, storeRangeLimits(null, false)).range).toEqual({ from: "2026-10-23", to: "2026-10-23" });
  });

  it("is compared with the period before the store's first day, whatever comparison is asked for", () => {
    const asked = resolvePreset("all", now, "UTC", undefined, { mode: "year" }, limits).previous;
    expect(asked).toEqual(resolvePreset("all", now, "UTC", undefined, { mode: "previous" }, limits).previous);
    // Wholly before the store's first day: there is nothing in it, so no change is given.
    expect(asked.to < "2022-03-15").toBe(true);
    expect(asked.from).toBe("2017-08-04");
    expect(asked.to).toBe("2022-03-14");
  });

  it("is a preset the API accepts", () => {
    expect(DATE_PRESETS).toContain("all");
    expect(DATE_PRESETS).toContain("wtd");
  });
});

describe("custom dates within the store's limits", () => {
  const today = "2026-10-23";
  const limits = storeRangeLimits("2022-03-15", true);

  it("can't start before the store's first day", () => {
    expect(customRangeProblem({ from: "2022-03-14", to: "2022-04-30" }, today, limits)).toBe("before_start");
    expect(customRangeProblem({ from: "2022-03-15", to: "2022-04-30" }, today, limits)).toBeNull();
    expect(() => resolvePreset("custom", new Date("2026-10-23T03:00:00Z"), "UTC", { from: "2021-01-01", to: "2021-12-31" }, undefined, limits)).toThrow(
      "Range starts before the store's first day",
    );
    expect(() =>
      resolvePreset("30d", new Date("2026-10-23T03:00:00Z"), "UTC", undefined, { mode: "custom", from: "2021-01-01", to: "2021-01-31" }, limits),
    ).toThrow("Comparison starts before the store's first day");
  });

  it("may be any length from then on, across years", () => {
    expect(customRangeProblem({ from: "2022-03-15", to: "2026-10-23" }, today, limits)).toBeNull();
    expect(resolvePreset("custom", new Date("2026-10-23T03:00:00Z"), "UTC", { from: "2023-01-01", to: "2025-06-30" }, undefined, limits)).toEqual({
      range: { from: "2023-01-01", to: "2025-06-30" },
      previous: { from: "2020-07-03", to: "2022-12-31" },
    });
  });

  it("start anywhere from 2000 while Shopify's creation date isn't known: the first order's day only starts All time", () => {
    const unknown = storeRangeLimits("2026-08-25", false);
    expect(customRangeProblem({ from: "2026-08-01", to: "2026-08-31" }, today, unknown)).toBeNull();
    expect(resolvePreset("all", new Date("2026-10-23T03:00:00Z"), "UTC", undefined, undefined, unknown).range).toEqual({ from: "2026-08-25", to: "2026-10-23" });
  });

  it("keeps the general limits where no store's are given (up to a year, from 2000)", () => {
    expect(customRangeProblem({ from: "2025-01-01", to: "2026-01-02" }, today)).toBe("too_long");
    expect(customRangeProblem({ from: "2022-03-14", to: "2022-04-30" }, today)).toBeNull();
  });

  it("are still refused when they start after the store's today, reversed or half-typed", () => {
    expect(customRangeProblem({ from: "2026-10-24", to: "2026-10-30" }, today, limits)).toBe("future");
    expect(customRangeProblem({ from: "2026-10-10", to: "2026-10-01" }, today, limits)).toBe("reversed");
    expect(customRangeProblem({ from: "0202-01-01", to: "2026-10-01" }, today, limits)).toBe("incomplete");
  });
});

describe("rowsByMonth", () => {
  it("adds each month's days up, keyed by its first day in the range", () => {
    const rows = [
      { day: "2026-01-30", sales: 10, orders: 1 },
      { day: "2026-01-31", sales: 5.5, orders: 2 },
      { day: "2026-02-01", sales: 7, orders: 0 },
      { day: "2026-02-28", sales: 3, orders: 1 },
      { day: "2026-03-01", sales: 0, orders: 0 },
    ];
    expect(rowsByMonth(rows)).toEqual([
      { day: "2026-01-30", sales: 15.5, orders: 3 },
      { day: "2026-02-01", sales: 10, orders: 1 },
      { day: "2026-03-01", sales: 0, orders: 0 },
    ]);
  });

  it("keeps a month with no figures at all as a gap, never a 0", () => {
    const rows: Array<{ day: string; spend: number | null }> = [
      { day: "2026-01-30", spend: null },
      { day: "2026-01-31", spend: null },
      { day: "2026-02-01", spend: null },
      { day: "2026-02-02", spend: 4 },
    ];
    expect(rowsByMonth(rows)).toEqual([
      { day: "2026-01-30", spend: null },
      { day: "2026-02-01", spend: 4 },
    ]);
  });
});

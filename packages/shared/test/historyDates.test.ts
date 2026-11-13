import { describe, expect, it } from "vitest";
import {
  calendarYear,
  customRangeProblem,
  latestRangeEnd,
  monthsEarlier,
  resolvePreset,
  storeRangeLimits,
  storeStartDay,
  yearsBetween,
} from "../src/dates";

describe("ranges of up to 12 months, however far back", () => {
  it("counts months on the calendar, short months and leap days included", () => {
    expect(monthsEarlier("2026-10-24", 6)).toBe("2026-04-24");
    expect(monthsEarlier("2026-03-15", 6)).toBe("2025-09-15");
    // A month without the day: its last day.
    expect(monthsEarlier("2026-08-31", 6)).toBe("2026-02-28");
    expect(monthsEarlier("2028-08-31", 6)).toBe("2028-02-29");
    expect(monthsEarlier("2026-01-31", -1)).toBe("2026-02-28");
  });

  it("lets a range run to the day before the same date a year later", () => {
    expect(latestRangeEnd("2024-01-01")).toBe("2024-12-31");
    expect(latestRangeEnd("2025-03-15")).toBe("2026-03-14");
    // Across a 29 February: 366 days.
    expect(latestRangeEnd("2023-03-01")).toBe("2024-02-29");
    // From 29 February, to the 28th: the next year has no 29th.
    expect(latestRangeEnd("2024-02-29")).toBe("2025-02-28");
  });

  it("takes exactly 12 months and refuses a day more, in any year", () => {
    expect(customRangeProblem({ from: "2023-01-01", to: "2023-12-31" })).toBeNull();
    expect(customRangeProblem({ from: "2024-01-01", to: "2024-12-31" })).toBeNull();
    expect(customRangeProblem({ from: "2023-01-01", to: "2024-01-01" })).toBe("too_long");
    expect(customRangeProblem({ from: "2019-07-01", to: "2020-06-30" })).toBeNull();
    expect(customRangeProblem({ from: "2019-07-01", to: "2020-07-01" })).toBe("too_long");
    const now = new Date("2026-10-24T03:00:00Z");
    expect(() => resolvePreset("custom", now, "UTC", { from: "2023-01-01", to: "2024-01-01" })).toThrow("pick up to 12 months at a time");
    // An older year on its own is a question like any other, and its comparison the year before it.
    expect(resolvePreset("custom", now, "UTC", { from: "2023-01-01", to: "2023-12-31" })).toEqual({
      range: { from: "2023-01-01", to: "2023-12-31" },
      previous: { from: "2022-01-01", to: "2022-12-31" },
    });
    // The period before a calendar year is the calendar year before, leap or not, as for Last year:
    // never 31 Dec 2022 – 31 Dec 2023 (the 366 days before 2024).
    expect(resolvePreset("custom", now, "UTC", { from: "2024-01-01", to: "2024-12-31" }).previous).toEqual({ from: "2023-01-01", to: "2023-12-31" });
    expect(resolvePreset("custom", now, "UTC", { from: "2025-01-01", to: "2025-12-31" }).previous).toEqual({ from: "2024-01-01", to: "2024-12-31" });
    // Other custom dates keep as many days just before.
    expect(resolvePreset("custom", now, "UTC", { from: "2024-01-02", to: "2024-12-31" }).previous).toEqual({ from: "2023-01-02", to: "2024-01-01" });
  });

  it("has the last 6 and 12 months up to today, compared with as many days before", () => {
    // 24 Oct 2026, 2 pm in Melbourne.
    const now = new Date("2026-10-24T03:00:00Z");
    const tz = "Australia/Melbourne";
    expect(resolvePreset("6m", now, tz)).toEqual({ range: { from: "2026-04-25", to: "2026-10-24" }, until: "14:00:00", previous: { from: "2025-10-24", to: "2026-04-24", until: "14:00:00" } });
    expect(resolvePreset("12m", now, tz)).toEqual({ range: { from: "2025-10-25", to: "2026-10-24" }, until: "14:00:00", previous: { from: "2024-10-25", to: "2025-10-24", until: "14:00:00" } });
    // Both stay within 12 months, on a leap day and at a month's end too.
    for (const at of ["2028-02-29T12:00:00Z", "2026-08-31T12:00:00Z", "2026-03-31T12:00:00Z"]) {
      for (const p of ["6m", "12m"] as const) {
        const { range } = resolvePreset(p, new Date(at), "UTC");
        expect(customRangeProblem(range)).toBeNull();
      }
    }
    expect(resolvePreset("12m", new Date("2028-02-29T12:00:00Z"), "UTC").range).toEqual({ from: "2027-03-01", to: "2028-02-29" });
    expect(resolvePreset("6m", new Date("2026-08-31T12:00:00Z"), "UTC").range).toEqual({ from: "2026-03-01", to: "2026-08-31" });
  });
});

describe("where a store's dates begin", () => {
  it("is the day Shopify created the store, or an earlier imported order's", () => {
    // 14 Mar 2022, 11 pm UTC is already the 15th in Melbourne.
    const created = new Date("2022-03-14T23:00:00Z");
    expect(storeStartDay(created, "Australia/Melbourne", null)).toBe("2022-03-15");
    expect(storeStartDay(created, "Australia/Melbourne", "2023-01-02")).toBe("2022-03-15");
    expect(storeStartDay(created, "Australia/Melbourne", "2021-06-01")).toBe("2021-06-01");
    expect(storeStartDay(null, "UTC", "2026-08-26")).toBe("2026-08-26");
    expect(storeStartDay(null, "UTC", null)).toBeNull();
  });

  it("keeps custom dates from starting before it once Shopify's creation date is known", () => {
    const limits = storeRangeLimits("2022-03-15", true);
    expect(customRangeProblem({ from: "2022-03-15", to: "2022-12-31" }, "2026-10-24", limits)).toBeNull();
    expect(customRangeProblem({ from: "2022-03-14", to: "2022-12-31" }, "2026-10-24", limits)).toBe("before_start");
    expect(() => resolvePreset("custom", new Date("2026-10-24T03:00:00Z"), "UTC", { from: "2021-01-01", to: "2021-12-31" }, limits)).toThrow(
      "before the store's first day",
    );
    // Only the first order known: a quiet first month before it is still the store's.
    expect(customRangeProblem({ from: "2022-03-14", to: "2022-12-31" }, "2026-10-24", storeRangeLimits("2022-03-15", false))).toBeNull();
    // The period before may reach back before it: the answer then says no orders are that old.
    expect(resolvePreset("custom", new Date("2026-10-24T03:00:00Z"), "UTC", { from: "2022-03-15", to: "2022-12-31" }, limits).previous).toEqual({
      from: "2021-05-27",
      to: "2022-03-14",
    });
  });

  it("offers each calendar year from the store's first to this one", () => {
    expect(yearsBetween("2022-03-15", "2026-10-24")).toEqual([2026, 2025, 2024, 2023, 2022]);
    expect(yearsBetween("2026-08-26", "2026-10-24")).toEqual([2026]);
    expect(yearsBetween(null, "2026-10-24")).toHaveLength(27);
    expect(calendarYear(2024, "2026-10-24")).toEqual({ from: "2024-01-01", to: "2024-12-31" });
    expect(calendarYear(2026, "2026-10-24")).toEqual({ from: "2026-01-01", to: "2026-10-24" });
    expect(customRangeProblem(calendarYear(2024, "2026-10-24"))).toBeNull();
  });
});

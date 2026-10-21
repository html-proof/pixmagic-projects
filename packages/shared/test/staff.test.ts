import { describe, expect, it } from "vitest";
import {
  allocateWork,
  computeFlags,
  currencyExponent,
  earningsMinor,
  endOfLocalDay,
  formatScaled,
  hoursDecimal,
  liveStatus,
  localDayOf,
  minorToString,
  parseDecimal,
  passwordProblems,
  periodContaining,
  priceWork,
  rateOn,
  resolveRange,
  roundDiv,
  sessionWork,
  staffAccess,
  staffCan,
  startOfLocalDay,
  startOfWeek,
  toMinor,
  tzOffsetMinutes,
  zonedTimeToUtc,
  bucketsBetween,
  nextLocalHour,
  type OvertimeRules,
  type WorkInterval,
} from "../src/staff/index";

const NY = "America/New_York";
const SYD = "Australia/Sydney";
const UTC = "UTC";
/** Epoch seconds of a local wall time. */
const at = (day: string, h: number, m: number, tz: string) => Math.floor(zonedTimeToUtc(day, h, m, tz) / 1000);
const iv = (id: string, day: string, h1: number, m1: number, day2: string, h2: number, m2: number, tz: string): WorkInterval => ({
  sessionId: id,
  start: at(day, h1, m1, tz),
  end: at(day2, h2, m2, tz),
});
const H = 3600;

const DAILY_8: OvertimeRules = {
  dailyThresholdMinutes: 8 * 60,
  weeklyThresholdMinutes: null,
  multiplier: "1.5",
  doubleTimeDailyThresholdMinutes: null,
  doubleTimeMultiplier: null,
  holidayMultiplier: "1",
};
const WEEKLY_40: OvertimeRules = { ...DAILY_8, dailyThresholdMinutes: null, weeklyThresholdMinutes: 40 * 60 };

describe("money", () => {
  it("parses decimals exactly and refuses extra places", () => {
    expect(parseDecimal("20", 4)).toBe(200000n);
    expect(parseDecimal("20.375", 4)).toBe(203750n);
    expect(() => parseDecimal("20.37501", 4)).toThrow(/decimal places/);
    expect(() => parseDecimal("-1", 2)).toThrow();
    expect(() => parseDecimal("1e3", 2)).toThrow();
    expect(formatScaled(203750n, 4)).toBe("20.3750");
  });

  it("knows each currency's minor unit", () => {
    expect(currencyExponent("USD")).toBe(2);
    expect(currencyExponent("JPY")).toBe(0);
    expect(currencyExponent("KWD")).toBe(3);
    expect(toMinor("160.00", "USD")).toBe(16000n);
    expect(minorToString(16000n, "USD")).toBe("160.00");
    expect(minorToString(1500n, "JPY")).toBe("1500");
    expect(() => toMinor("10.5", "JPY")).toThrow();
  });

  it("rounds half away from zero", () => {
    expect(roundDiv(5n, 2n)).toBe(3n);
    expect(roundDiv(4n, 3n)).toBe(1n);
    expect(roundDiv(-5n, 2n)).toBe(-3n);
  });

  it("$20/h for 8 hours is $160.00; 1.5x and odd rates round once to the cent", () => {
    expect(earningsMinor(8 * H, parseDecimal("20", 4), parseDecimal("1", 4), "USD")).toBe(16000n);
    expect(earningsMinor(2 * H, parseDecimal("20", 4), parseDecimal("1.5", 4), "USD")).toBe(6000n);
    // 7h 20m at 20.375 = 149.4166.. -> 149.42
    expect(earningsMinor(7 * H + 20 * 60, parseDecimal("20.375", 4), parseDecimal("1", 4), "USD")).toBe(14942n);
    // Whole yen.
    expect(earningsMinor(90 * 60, parseDecimal("1250", 4), parseDecimal("1", 4), "JPY")).toBe(1875n);
  });
});

describe("time zones and daylight saving", () => {
  it("resolves skipped and repeated wall times like Temporal's 'compatible'", () => {
    // New York springs forward 2026-03-08 02:00 -> 03:00: 02:30 does not exist and becomes 03:30 EDT.
    expect(new Date(zonedTimeToUtc("2026-03-08", 2, 30, NY)).toISOString()).toBe("2026-03-08T07:30:00.000Z");
    // Falls back 2026-11-01 02:00 -> 01:00: 01:30 happens twice; the first (EDT) wins.
    expect(new Date(zonedTimeToUtc("2026-11-01", 1, 30, NY)).toISOString()).toBe("2026-11-01T05:30:00.000Z");
    expect(tzOffsetMinutes(Date.parse("2026-01-15T12:00:00Z"), SYD)).toBe(660);
    expect(tzOffsetMinutes(Date.parse("2026-07-15T12:00:00Z"), SYD)).toBe(600);
  });

  it("knows a spring-forward day has 23 hours and a fall-back day 25", () => {
    expect(endOfLocalDay("2026-03-08", NY) - startOfLocalDay("2026-03-08", NY)).toBe(23 * H * 1000);
    expect(endOfLocalDay("2026-11-01", NY) - startOfLocalDay("2026-11-01", NY)).toBe(25 * H * 1000);
    expect(endOfLocalDay("2026-04-05", SYD) - startOfLocalDay("2026-04-05", SYD)).toBe(25 * H * 1000);
    expect(localDayOf(Date.parse("2026-10-13T14:30:00Z"), SYD)).toBe("2026-10-14");
  });

  it("finds local hour boundaries in half-hour zones", () => {
    const t = Date.parse("2026-10-14T10:10:00Z"); // 15:40 in Kolkata (+5:30)
    expect(new Date(nextLocalHour(t, "Asia/Kolkata")).toISOString()).toBe("2026-10-14T10:30:00.000Z");
  });

  it("starts weeks on the configured day", () => {
    expect(startOfWeek("2026-10-14", 1)).toBe("2026-10-12"); // Wednesday -> Monday
    expect(startOfWeek("2026-10-14", 0)).toBe("2026-10-11"); // -> Sunday
    expect(startOfWeek("2026-10-12", 1)).toBe("2026-10-12");
  });
});

describe("allocateWork: hours", () => {
  it("counts an 8-hour shift as 8 regular hours", () => {
    const chunks = allocateWork([iv("s1", "2026-10-14", 9, 0, "2026-10-14", 17, 0, UTC)], { timeZone: UTC, weekStartsOn: 1, rules: DAILY_8 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ category: "regular", seconds: 8 * H, day: "2026-10-14" });
  });

  it("pays time past the daily threshold as overtime", () => {
    const chunks = allocateWork([iv("s1", "2026-10-14", 8, 0, "2026-10-14", 18, 30, UTC)], { timeZone: UTC, weekStartsOn: 1, rules: DAILY_8 });
    expect(chunks.map((c) => [c.category, c.seconds, c.multiplier])).toEqual([
      ["regular", 8 * H, "1.0000"],
      ["overtime", 2.5 * H, "1.5000"],
    ]);
  });

  it("adds double time past its own daily threshold", () => {
    const rules: OvertimeRules = { ...DAILY_8, doubleTimeDailyThresholdMinutes: 12 * 60, doubleTimeMultiplier: "2" };
    const chunks = allocateWork([iv("s1", "2026-10-14", 6, 0, "2026-10-14", 20, 0, UTC)], { timeZone: UTC, weekStartsOn: 1, rules });
    expect(chunks.map((c) => [c.category, c.seconds / H])).toEqual([
      ["regular", 8],
      ["overtime", 4],
      ["double_time", 2],
    ]);
  });

  it("applies the weekly threshold across days, counting each minute once", () => {
    // Mon-Fri 9h each = 45h with a 40h weekly threshold and no daily one: last 5h are overtime.
    const days = ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"];
    const ivs = days.map((d, i) => iv(`s${i}`, d, 8, 0, d, 17, 0, UTC));
    const chunks = allocateWork(ivs, { timeZone: UTC, weekStartsOn: 1, rules: WEEKLY_40 });
    const sum = (cat: string) => chunks.filter((c) => c.category === cat).reduce((a, c) => a + c.seconds, 0) / H;
    expect(sum("regular")).toBe(40);
    expect(sum("overtime")).toBe(5);
    // Daily and weekly together: daily overtime does not also count towards the 40.
    const both = allocateWork(ivs, { timeZone: UTC, weekStartsOn: 1, rules: { ...WEEKLY_40, dailyThresholdMinutes: 8 * 60 } });
    const sum2 = (cat: string) => both.filter((c) => c.category === cat).reduce((a, c) => a + c.seconds, 0) / H;
    expect(sum2("regular")).toBe(40);
    expect(sum2("overtime")).toBe(5);
  });

  it("splits an overnight shift at local midnight", () => {
    const chunks = allocateWork([iv("s1", "2026-10-14", 22, 0, "2026-10-15", 6, 0, SYD)], { timeZone: SYD, weekStartsOn: 1, rules: DAILY_8 });
    expect(chunks.map((c) => [c.day, c.seconds / H, c.category])).toEqual([
      ["2026-10-14", 2, "regular"],
      ["2026-10-15", 6, "regular"],
    ]);
  });

  it("counts real elapsed time across daylight saving changes", () => {
    // 00:00 -> 08:00 on the day New York springs forward is 7 hours of work.
    const spring = allocateWork([iv("s1", "2026-03-08", 0, 0, "2026-03-08", 8, 0, NY)], { timeZone: NY, weekStartsOn: 1, rules: DAILY_8 });
    expect(spring.reduce((a, c) => a + c.seconds, 0)).toBe(7 * H);
    // 22:00 -> 06:00 over the fall-back night is 9 hours: 2 on the 31st, 7 on the 1st.
    const fall = allocateWork([iv("s1", "2026-10-31", 22, 0, "2026-11-01", 6, 0, NY)], { timeZone: NY, weekStartsOn: 1, rules: DAILY_8 });
    expect(fall.map((c) => [c.day, c.seconds / H])).toEqual([
      ["2026-10-31", 2],
      ["2026-11-01", 7],
    ]);
  });

  it("pays holiday premiums on the holiday's local day", () => {
    const rules: OvertimeRules = { ...DAILY_8, holidayMultiplier: "2" };
    const chunks = allocateWork([iv("s1", "2026-12-25", 9, 0, "2026-12-25", 19, 0, UTC)], {
      timeZone: UTC,
      weekStartsOn: 1,
      rules,
      holidays: new Set(["2026-12-25"]),
    });
    expect(chunks.map((c) => [c.category, c.seconds / H, c.multiplier])).toEqual([
      ["holiday", 8, "2.0000"],
      ["overtime", 2, "2.0000"],
    ]);
  });

  it("never counts overlapping sessions twice", () => {
    const chunks = allocateWork(
      [iv("a", "2026-10-14", 9, 0, "2026-10-14", 13, 0, UTC), iv("b", "2026-10-14", 12, 0, "2026-10-14", 15, 0, UTC)],
      { timeZone: UTC, weekStartsOn: 1, rules: null },
    );
    expect(chunks.reduce((a, c) => a + c.seconds, 0)).toBe(6 * H);
  });
});

describe("priceWork: rates in force when the work happened", () => {
  it("uses each day's effective rate and rounds each line once", () => {
    const chunks = allocateWork(
      [iv("a", "2026-10-13", 9, 0, "2026-10-13", 17, 0, UTC), iv("b", "2026-10-14", 9, 0, "2026-10-14", 19, 0, UTC)],
      { timeZone: UTC, weekStartsOn: 1, rules: DAILY_8 },
    );
    const rates = [
      { effectiveFrom: "2026-01-01", hourlyRate: "20" },
      { effectiveFrom: "2026-10-14", hourlyRate: "22.50" },
    ];
    expect(rateOn(rates, "2026-10-13")).toBe("20");
    const priced = priceWork(chunks, rates, "USD");
    expect(priced.regularSeconds).toBe(16 * H);
    expect(priced.overtimeSeconds).toBe(2 * H);
    // 8h x 20 = 160; 8h x 22.50 = 180; 2h x 22.50 x 1.5 = 67.50
    expect(priced.lines.map((l) => [l.category, l.hourlyRate, l.seconds / H, l.amountMinor])).toEqual([
      ["regular", "20.0000", 8, 16000n],
      ["regular", "22.5000", 8, 18000n],
      ["overtime", "22.5000", 2, 6750n],
    ]);
    expect(priced.grossMinor).toBe(40750n);
  });

  it("holds back time worked before any rate was set", () => {
    const chunks = allocateWork([iv("a", "2026-10-14", 9, 0, "2026-10-14", 12, 0, UTC)], { timeZone: UTC, weekStartsOn: 1, rules: null });
    const priced = priceWork(chunks, [{ effectiveFrom: "2026-10-15", hourlyRate: "30" }], "USD");
    expect(priced.unpricedSeconds).toBe(3 * H);
    expect(priced.grossMinor).toBe(0n);
  });
});

describe("sessionWork: breaks and open shifts", () => {
  const t = (iso: string) => Date.parse(iso);
  it("deducts unpaid breaks and keeps paid ones", () => {
    const w = sessionWork(
      { id: "s", clockInAt: t("2026-10-14T09:00:00Z"), clockOutAt: t("2026-10-14T17:30:00Z") },
      [
        { startAt: t("2026-10-14T12:00:00Z"), endAt: t("2026-10-14T12:30:00Z"), paid: false },
        { startAt: t("2026-10-14T15:00:00Z"), endAt: t("2026-10-14T15:10:00Z"), paid: true },
      ],
      t("2026-10-14T18:00:00Z"),
    );
    expect(w.spanSeconds).toBe(8.5 * H);
    expect(w.unpaidBreakSeconds).toBe(30 * 60);
    expect(w.paidBreakSeconds).toBe(10 * 60);
    expect(w.workedSeconds).toBe(8 * H);
    expect(w.intervals).toHaveLength(2);
  });

  it("runs an open shift to now, but never past the stale cap", () => {
    const open = { id: "s", clockInAt: t("2026-10-14T09:00:00Z"), clockOutAt: null };
    expect(sessionWork(open, [], t("2026-10-14T11:00:00Z")).workedSeconds).toBe(2 * H);
    expect(sessionWork(open, [], t("2026-10-16T09:00:00Z"), 14 * H).workedSeconds).toBe(14 * H);
  });

  it("counts an open break up to now", () => {
    const w = sessionWork(
      { id: "s", clockInAt: t("2026-10-14T09:00:00Z"), clockOutAt: null },
      [{ startAt: t("2026-10-14T10:00:00Z"), endAt: null, paid: false }],
      t("2026-10-14T10:20:00Z"),
    );
    expect(w.workedSeconds).toBe(1 * H);
    expect(w.unpaidBreakSeconds).toBe(20 * 60);
  });
});

describe("pay periods and reporting ranges", () => {
  it("finds the period holding a day for every cycle", () => {
    expect(periodContaining("2026-10-14", "weekly", "2026-10-05")).toEqual({ from: "2026-10-12", to: "2026-10-18" });
    expect(periodContaining("2026-10-14", "biweekly", "2026-10-05")).toEqual({ from: "2026-10-05", to: "2026-10-18" });
    expect(periodContaining("2026-10-04", "biweekly", "2026-10-05")).toEqual({ from: "2026-09-21", to: "2026-10-04" });
    expect(periodContaining("2026-02-20", "semimonthly", "2026-01-01")).toEqual({ from: "2026-02-16", to: "2026-02-28" });
    expect(periodContaining("2026-10-14", "monthly", "2026-01-01")).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(periodContaining("2026-10-14", "daily", "2026-01-01")).toEqual({ from: "2026-10-14", to: "2026-10-14" });
  });

  it("compares running periods with the same elapsed span", () => {
    expect(resolveRange("this_month", "2026-03-31", 1)).toEqual({
      range: { from: "2026-03-01", to: "2026-03-31" },
      previous: { from: "2026-02-01", to: "2026-02-28" },
      inProgress: true,
    });
    expect(resolveRange("this_week", "2026-10-14", 1).previous).toEqual({ from: "2026-10-05", to: "2026-10-07" });
    expect(resolveRange("last_year", "2026-10-14", 1).range).toEqual({ from: "2025-01-01", to: "2025-12-31" });
    expect(resolveRange("custom", "2026-10-14", 1, { from: "2026-10-01", to: "2026-10-10" }).previous).toEqual({ from: "2026-09-21", to: "2026-09-30" });
    expect(() => resolveRange("custom", "2026-10-14", 1, { from: "2026-10-10", to: "2026-10-01" })).toThrow();
  });

  it("lists chart buckets", () => {
    expect(bucketsBetween({ from: "2026-09-28", to: "2026-10-14" }, "week", 1)).toEqual(["2026-09-28", "2026-10-05", "2026-10-12"]);
    expect(bucketsBetween({ from: "2026-01-01", to: "2026-12-31" }, "quarter", 1)).toEqual(["2026-Q1", "2026-Q2", "2026-Q3", "2026-Q4"]);
    expect(bucketsBetween({ from: "2026-10-14", to: "2026-10-14" }, "hour", 1)).toHaveLength(24);
  });
});

describe("attendance flags and live status", () => {
  const t = (iso: string) => Date.parse(iso);
  const base = {
    breaks: [],
    breakRules: { maxBreaksPerShift: 2, maxBreakMinutes: 60 },
    lateGraceMinutes: 5,
    staleAfterHours: 14,
    timeZone: UTC,
  };
  it("flags late starts, early finishes and unscheduled work", () => {
    expect(
      computeFlags({
        ...base,
        clockInAt: t("2026-10-14T09:10:00Z"),
        clockOutAt: t("2026-10-14T16:00:00Z"),
        schedule: { startsAt: t("2026-10-14T09:00:00Z"), endsAt: t("2026-10-14T17:00:00Z") },
        nowMs: t("2026-10-14T18:00:00Z"),
      }),
    ).toEqual(["late", "early_departure"]);
    expect(computeFlags({ ...base, clockInAt: t("2026-10-14T22:00:00Z"), clockOutAt: t("2026-10-15T02:00:00Z"), schedule: null, nowMs: t("2026-10-15T03:00:00Z") })).toEqual([
      "unscheduled",
      "overnight",
    ]);
    expect(computeFlags({ ...base, clockInAt: t("2026-10-14T06:00:00Z"), clockOutAt: null, schedule: null, nowMs: t("2026-10-15T06:00:00Z") })).toContain("stale");
  });

  it("calls someone absent only after their shift should have started", () => {
    const common = {
      employeeStatus: "active" as const,
      openSession: null,
      closedToday: 0,
      needsReview: false,
      scheduledToday: [{ startsAt: t("2026-10-14T09:00:00Z"), endsAt: t("2026-10-14T17:00:00Z") }],
      lateGraceMinutes: 5,
      staleAfterHours: 14,
      isHoliday: false,
    };
    expect(liveStatus({ ...common, nowMs: t("2026-10-14T08:00:00Z") })).toBe("not_in_yet");
    expect(liveStatus({ ...common, nowMs: t("2026-10-14T09:30:00Z") })).toBe("absent");
    expect(liveStatus({ ...common, openSession: { clockInAt: t("2026-10-14T09:00:00Z"), onBreak: true }, nowMs: t("2026-10-14T10:00:00Z") })).toBe("on_break");
    expect(liveStatus({ ...common, scheduledToday: [], nowMs: t("2026-10-14T10:00:00Z") })).toBe("off_today");
  });
});

describe("staff permissions", () => {
  it("gives owners everything and staff roles only their area", () => {
    expect(staffCan(staffAccess("owner", null), "payroll:approve")).toBe(true);
    expect(staffAccess("viewer", null).permissions).toEqual([]);
    const hr = staffAccess("analyst", "hr_manager");
    expect(staffCan(hr, "staff:manage")).toBe(true);
    expect(staffCan(hr, "pay:view")).toBe(false);
    const payroll = staffAccess("viewer", "payroll_manager");
    expect(staffCan(payroll, "payments:manage")).toBe(true);
    expect(staffCan(payroll, "staff:manage")).toBe(false);
    const sup = staffAccess("viewer", "supervisor");
    expect(sup.scope).toBe("assigned");
    expect(staffCan(sup, "pay:view")).toBe(false);
  });
});

describe("password policy", () => {
  it("asks for length, variety and nothing personal", () => {
    expect(passwordProblems("short")).toContain("Use at least 12 characters.");
    expect(passwordProblems("alllowercaseletters")).toHaveLength(1);
    expect(passwordProblems("Password1234")).toEqual(["That password is too common. Choose something less predictable."]);
    expect(passwordProblems("JaneDoe-2026-x", { name: "Jane Doe" })).toContain("Don't use your name or email address in your password.");
    expect(passwordProblems("Tr0ub4dor&3-horse")).toEqual([]);
  });
});

describe("hours formatting", () => {
  it("rounds to hundredths of an hour without floats", () => {
    expect(hoursDecimal(8 * H)).toBe("8.00");
    expect(hoursDecimal(7 * H + 45 * 60)).toBe("7.75");
    expect(hoursDecimal(20 * 60)).toBe("0.33");
  });
});

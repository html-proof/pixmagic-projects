import { describe, expect, it } from "vitest";
import { addDays } from "@app/shared";
import { AD_CHECK_DAYS, AD_CHECK_SETTLED_DAYS, AD_CHECK_TOLERANCE, adCheckWindow, adFigureDifferences, adFigureSlack } from "../src/index.js";

/**
 * The daily check of stored ad figures against the platform, the pure parts: which week is checked,
 * and when two totals still count as the same (the database and the platforms' answers are in
 * apps/worker/test/adOperator.test.ts).
 */

const now = new Date("2026-10-29T12:00:00Z");
const today = "2026-10-29";
const conn = (historyFrom: string | null, syncedThrough: string | null, timezone = "UTC") => ({ timezone, historyFrom, syncedThrough });

describe("the week checked", () => {
  it("is a settled week: seven days ending eight days before the account's today", () => {
    expect([AD_CHECK_DAYS, AD_CHECK_SETTLED_DAYS]).toEqual([7, 8]);
    expect(adCheckWindow(conn(addDays(today, -89), today), now)).toEqual({ since: "2026-10-15", until: "2026-10-21" });
    // The account's own calendar: still 28 October in Los Angeles.
    expect(adCheckWindow(conn(addDays(today, -89), today, "America/Los_Angeles"), new Date("2026-10-29T05:00:00Z"))).toEqual({ since: "2026-10-14", until: "2026-10-20" });
  });

  it("only when the stored days cover all of it", () => {
    // Connected ten days ago: its history starts inside the week.
    expect(adCheckWindow(conn(addDays(today, -10), today), now)).toBeNull();
    // Its syncs stopped before the week ended.
    expect(adCheckWindow(conn(addDays(today, -89), "2026-10-20"), now)).toBeNull();
    expect(adCheckWindow(conn(null, null), now)).toBeNull();
    // Exactly covered is enough.
    expect(adCheckWindow(conn("2026-10-15", "2026-10-21"), now)).toEqual({ since: "2026-10-15", until: "2026-10-21" });
  });
});

describe("when two totals are the same", () => {
  it("within 1% of the platform's figure", () => {
    expect(AD_CHECK_TOLERANCE).toBe(0.01);
    expect(adFigureDifferences([{ field: "spend", stored: 990.5, platform: 1000, slack: 0.1 }])).toEqual([]);
    expect(adFigureDifferences([{ field: "spend", stored: 985, platform: 1000, slack: 0.1 }])).toEqual([{ field: "spend", stored: 985, platform: 1000, relative: -0.015 }]);
    expect(adFigureDifferences([{ field: "impressions", stored: 12_200, platform: 12_000, slack: 1 }])).toEqual([{ field: "impressions", stored: 12_200, platform: 12_000, relative: 0.0167 }]);
  });

  it("or within what rounding alone can make, on small figures", () => {
    // One purchase apart on a small account is noise; two is not.
    expect(adFigureDifferences([{ field: "purchases", stored: 3, platform: 4, slack: 1 }])).toEqual([]);
    expect(adFigureDifferences([{ field: "purchases", stored: 2, platform: 4, slack: 1 }])).toEqual([{ field: "purchases", stored: 2, platform: 4, relative: -0.5 }]);
    // Half a cent per rounded figure: 20 stored Meta rows over 7 days, and the week's total.
    expect(adFigureSlack("meta", 20, 7)).toBeCloseTo(0.175);
    expect(adFigureSlack("adsense", 14, 7)).toBeCloseTo(0.075);
    expect(adFigureDifferences([{ field: "spend", stored: 4.1, platform: 4.25, slack: adFigureSlack("meta", 20, 7) }])).toEqual([]);
    expect(adFigureDifferences([{ field: "spend", stored: 4.0, platform: 4.25, slack: adFigureSlack("meta", 20, 7) }])).toHaveLength(1);
  });

  it("says nothing relative when the platform reports nothing", () => {
    expect(adFigureDifferences([{ field: "spend", stored: 12, platform: 0, slack: 0.05 }])).toEqual([{ field: "spend", stored: 12, platform: 0, relative: null }]);
    expect(adFigureDifferences([{ field: "spend", stored: 0, platform: 0, slack: 0.05 }])).toEqual([]);
  });
});

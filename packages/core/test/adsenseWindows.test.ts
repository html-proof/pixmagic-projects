import { describe, expect, it } from "vitest";
import { addDays } from "@app/shared";
import { ADS_HISTORY_DAYS, ADS_MAX_LOOKBACK_DAYS, ADS_WINDOW_DAYS, catchUpWindow, historyTarget, nextHistoryWindow, planAdSyncWindow } from "../src/index.js";

/**
 * AdSense's windows: AdSense reports about three years back (ADS_MAX_LOOKBACK_DAYS.adsense), less than
 * Google Ads and a little less than Meta, so every window a sync plans stops there, on the account's
 * own calendar.
 */

const now = new Date("2026-10-29T12:00:00Z");
const today = "2026-10-29";
const adsense = (historyFrom: string | null, syncedThrough: string | null, timezone = "UTC") => ({ provider: "adsense", timezone, historyFrom, syncedThrough });
/** The oldest day AdSense still reports, today included in the count. */
const oldest = addDays(today, -(ADS_MAX_LOOKBACK_DAYS.adsense - 1));

describe("AdSense's sync windows", () => {
  it("reaches back about three years, less than Meta's 37 months", () => {
    expect(ADS_MAX_LOOKBACK_DAYS.adsense).toBe(1095);
    expect(ADS_MAX_LOOKBACK_DAYS.adsense).toBeLessThan(ADS_MAX_LOOKBACK_DAYS.meta);
    expect(oldest).toBe("2023-10-31");
  });

  it("fills a hole only from where AdSense still reports, 90 days at a time, oldest first", () => {
    // Stored up to four years ago, then nothing: the hole is filled from AdSense's oldest day on.
    const w = planAdSyncWindow(adsense(addDays(today, -1600), addDays(today, -1460)), addDays(today, -2), today, "request", now);
    expect(w).toEqual({ since: oldest, until: addDays(oldest, ADS_WINDOW_DAYS - 1), rest: { since: addDays(oldest, ADS_WINDOW_DAYS), until: today } });
    // Asked for further back than that: cut at the same day.
    expect(planAdSyncWindow(adsense(null, null), "2020-01-01", addDays(oldest, 9), "request", now)).toEqual({ since: oldest, until: addDays(oldest, 9), rest: null });
  });

  it("plans nothing for days AdSense no longer reports", () => {
    expect(planAdSyncWindow(adsense(null, null), "2020-01-01", addDays(oldest, -1), "history", now)).toBeNull();
    expect(planAdSyncWindow(adsense(addDays(today, -89), today), "2020-01-01", addDays(oldest, -1), "request", now)).toBeNull();
  });

  it("history: the newest part first, stopping at AdSense's oldest day", () => {
    const w = planAdSyncWindow(adsense(addDays(oldest, 50), today), "2020-01-01", addDays(oldest, 49), "history", now);
    expect(w).toEqual({ since: oldest, until: addDays(oldest, 49), rest: null });
  });

  it("catches up from a few days before the last day stored, never from before AdSense's oldest day", () => {
    expect(catchUpWindow(adsense(addDays(today, -200), addDays(today, -40)), now)).toEqual({ since: addDays(today, -43), until: today });
    expect(catchUpWindow(adsense(addDays(today, -2000), addDays(today, -1800)), now)).toEqual({ since: oldest, until: today });
    // Nothing stored yet: the first sync's 90 days.
    expect(catchUpWindow(adsense(null, null), now)).toEqual({ since: addDays(today, -89), until: today });
  });

  it("walks history back to 25 months, which AdSense still reports", () => {
    const target = historyTarget({ provider: "adsense", timezone: "UTC" }, now);
    expect(target).toBe(addDays(today, -(ADS_HISTORY_DAYS - 1)));
    expect(target > oldest).toBe(true);
    expect(nextHistoryWindow(adsense(addDays(target, 10), today), now)).toEqual({ since: target, until: addDays(target, 9) });
    expect(nextHistoryWindow(adsense(target, today), now)).toBeNull();
  });

  it("counts the days on the account's own calendar", () => {
    // 05:00 UTC on 29 October is still 28 October in Los Angeles: its today, and its oldest day, are a day earlier.
    const early = new Date("2026-10-29T05:00:00Z");
    expect(catchUpWindow(adsense(null, null, "America/Los_Angeles"), early)).toEqual({ since: addDays("2026-10-28", -89), until: "2026-10-28" });
    expect(catchUpWindow(adsense(addDays(today, -2000), addDays(today, -1800), "America/Los_Angeles"), early).since).toBe(addDays(oldest, -1));
  });
});

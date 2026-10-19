import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays, describeAlert } from "@app/shared";
import {
  resetEnvCache,
  adAlertsFor,
  ADS_HISTORY_DAYS,
  ADS_WINDOW_DAYS,
  catchUpWindow,
  countGoogleAdsOperations,
  countingGoogleAdsFetch,
  googleAdsBudget,
  googleAdsBudgetAllows,
  googleAdsOperationsToday,
  historyTarget,
  memoryCoord,
  mergeCoverage,
  nextHistoryWindow,
  pauseGoogleAds,
  planAdSyncWindow,
  type FetchLike,
} from "../src/index.js";

/**
 * Ad syncs, the pure parts: which days a sync fetches (holes first, long ranges cut, history walked
 * back), the unbroken run of stored days it leaves, Google's daily allowance, and what an ad
 * connection's state says in an alert.
 */

const saved = { ...process.env };
beforeAll(() => {
  Object.assign(process.env, {
    NODE_ENV: "test",
    SESSION_SECRET: "unit-session-secret-123456",
    OTP_PEPPER: "unit-pepper",
    TOKEN_ENCRYPTION_KEYS: `1:${Buffer.alloc(32, 1).toString("base64")}`,
    APP_URL: "https://app.test",
  });
  resetEnvCache();
});
afterAll(() => {
  process.env = saved;
  resetEnvCache();
});

const now = new Date("2026-10-19T12:00:00Z");
const today = "2026-10-19";
const meta = (historyFrom: string | null, syncedThrough: string | null) => ({ provider: "meta", timezone: "UTC", historyFrom, syncedThrough });

describe("the window a sync fetches", () => {
  it("fetches what was asked when the stored days run up to it", () => {
    expect(planAdSyncWindow(meta(addDays(today, -89), addDays(today, -1)), addDays(today, -2), today, "schedule", now)).toEqual({ since: addDays(today, -2), until: today, rest: null });
    // Nothing stored yet: as asked.
    expect(planAdSyncWindow(meta(null, null), addDays(today, -89), today, "request", now)).toEqual({ since: addDays(today, -89), until: today, rest: null });
  });

  it("fills a hole since the last day stored first (an account that waited 45 days for a reconnect)", () => {
    const w = planAdSyncWindow(meta(addDays(today, -200), addDays(today, -45)), addDays(today, -2), today, "request", now);
    expect(w).toEqual({ since: addDays(today, -44), until: today, rest: null });
  });

  it("cuts a long window into 90 days, oldest first, the rest left for a follow-up", () => {
    const w = planAdSyncWindow(meta(addDays(today, -400), addDays(today, -200)), addDays(today, -2), today, "schedule", now);
    expect(w).toEqual({ since: addDays(today, -199), until: addDays(today, -110), rest: { since: addDays(today, -109), until: today } });
    expect(ADS_WINDOW_DAYS).toBe(90);
  });

  it("history: the newest part first, next to what is stored, and never the forward hole", () => {
    const w = planAdSyncWindow(meta(addDays(today, -100), addDays(today, -50)), addDays(today, -300), addDays(today, -101), "history", now);
    expect(w).toEqual({ since: addDays(today, -190), until: addDays(today, -101), rest: { since: addDays(today, -300), until: addDays(today, -191) } });
  });

  it("leaves out days the platform no longer reports, and says when nothing is left", () => {
    // Meta keeps about 37 months: a hole that began four years ago is filled from where Meta still reaches.
    const w = planAdSyncWindow(meta(addDays(today, -1600), addDays(today, -1460)), addDays(today, -2), today, "request", now);
    expect(w?.since).toBe(addDays(today, -1119));
    expect(planAdSyncWindow(meta(null, null), addDays(today, -2000), addDays(today, -1500), "history", now)).toBeNull();
    expect(planAdSyncWindow(meta(null, null), today, addDays(today, -1), "request", now)).toBeNull();
  });
});

describe("the unbroken run of stored days", () => {
  it("starts with the first window, and grows with windows that touch or overlap it", () => {
    expect(mergeCoverage({ historyFrom: null, syncedThrough: null }, "2026-07-22", today)).toEqual({ historyFrom: "2026-07-22", syncedThrough: today });
    expect(mergeCoverage({ historyFrom: "2026-07-22", syncedThrough: "2026-10-17" }, "2026-10-17", today)).toEqual({ historyFrom: "2026-07-22", syncedThrough: today });
    // The day before history_from: history walked back.
    expect(mergeCoverage({ historyFrom: "2026-07-22", syncedThrough: today }, "2026-04-23", "2026-07-21")).toEqual({ historyFrom: "2026-04-23", syncedThrough: today });
  });

  it("starts again after a hole the platform no longer reaches, so the days before it read as not stored", () => {
    expect(mergeCoverage({ historyFrom: "2022-01-01", syncedThrough: "2022-06-30" }, "2023-09-01", today)).toEqual({ historyFrom: "2023-09-01", syncedThrough: today });
  });

  it("doesn't count a window before the run with a gap between", () => {
    const cov = { historyFrom: "2026-07-22", syncedThrough: today };
    expect(mergeCoverage(cov, "2026-01-01", "2026-03-31")).toBe(cov);
  });
});

describe("walking history back", () => {
  it("goes 90 days at a time down to 25 months, and stops there", () => {
    const target = historyTarget({ provider: "meta", timezone: "UTC" }, now);
    expect(target).toBe(addDays(today, -(ADS_HISTORY_DAYS - 1)));
    expect(nextHistoryWindow(meta(addDays(today, -89), today), now)).toEqual({ since: addDays(today, -179), until: addDays(today, -90) });
    // The last step stops at the target.
    expect(nextHistoryWindow(meta(addDays(target, 30), today), now)).toEqual({ since: target, until: addDays(target, 29) });
    expect(nextHistoryWindow(meta(target, today), now)).toBeNull();
    // Nothing stored yet: the first sync comes first.
    expect(nextHistoryWindow(meta(null, null), now)).toBeNull();
  });
});

describe("catching a connection up", () => {
  it("re-reads a few days before the last one stored, up to today; nothing stored: the first sync's 90 days", () => {
    expect(catchUpWindow(meta(addDays(today, -300), addDays(today, -60)), now)).toEqual({ since: addDays(today, -63), until: today });
    expect(catchUpWindow(meta(null, null), now)).toEqual({ since: addDays(today, -89), until: today });
    // Never further back than the platform reports.
    expect(catchUpWindow(meta(addDays(today, -2000), addDays(today, -1800)), now).since).toBe(addDays(today, -1119));
  });
});

describe("Google's daily allowance", () => {
  it("counts the operations of the last 24 hours, hour by hour", async () => {
    const coord = memoryCoord();
    const t = Date.parse("2026-10-19T10:30:00Z");
    await countGoogleAdsOperations(coord, 3, t - 23 * 3_600_000);
    await countGoogleAdsOperations(coord, 2, t - 3_600_000);
    await countGoogleAdsOperations(coord, 2, t);
    await countGoogleAdsOperations(coord, 0, t);
    expect(await googleAdsOperationsToday(coord, t)).toBe(7);
    // A day later the oldest hour has dropped out.
    expect(await googleAdsOperationsToday(coord, t + 3_600_000)).toBe(4);
  });

  it("holds background syncs back at 80% (history at 60%), and everything while Google says it is used up", async () => {
    const at = (used: number) => ({ paused: false, used, limit: 2880 });
    expect(googleAdsBudgetAllows(at(2303), "schedule")).toBe(true);
    expect(googleAdsBudgetAllows(at(2304), "schedule")).toBe(false);
    expect(googleAdsBudgetAllows(at(1727), "history")).toBe(true);
    expect(googleAdsBudgetAllows(at(1728), "history")).toBe(false);
    const coord = memoryCoord();
    expect((await googleAdsBudget(coord)).paused).toBe(false);
    await pauseGoogleAds(coord, null);
    const b = await googleAdsBudget(coord);
    expect(b).toMatchObject({ paused: true, used: 0, limit: 2880 });
    expect(googleAdsBudgetAllows(b, "schedule")).toBe(false);
  });

  it("counts only the requests that reach the Google Ads API", async () => {
    const f: FetchLike = async () => new Response("{}");
    const c = countingGoogleAdsFetch(f);
    await c.fetchImpl("https://oauth2.googleapis.com/token", { method: "POST" });
    await c.fetchImpl("https://googleads.googleapis.com/v25/customers/1/googleAds:searchStream", { method: "POST" });
    await c.fetchImpl(new URL("https://googleads.googleapis.com/v25/customers:listAccessibleCustomers"));
    expect(c.operations()).toBe(2);
  });
});

describe("an ad connection's alerts", () => {
  const conn = (over: Partial<Parameters<typeof adAlertsFor>[0]> = {}) => ({
    id: "c1",
    provider: "meta",
    accountId: "act_1",
    accountName: "Shop ads",
    status: "active",
    errorCode: null,
    accessTokenExpiresAt: new Date(now.getTime() + 40 * 86_400_000),
    consecutiveFailures: 0,
    lastSyncedAt: now,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    timezone: "UTC",
    ...over,
  });

  it("a working connection calls for none", () => {
    expect(adAlertsFor(conn(), now)).toEqual([]);
  });

  it("access that ended, or a login that lost the account, asks for a reconnect in the app's own words", () => {
    const [a] = adAlertsFor(conn({ status: "reconnect", errorCode: "auth_expired" }), now);
    expect(a).toMatchObject({ kind: "ads_reconnect", severity: "warning" });
    expect(a!.message).toContain('Meta ad account "Shop ads"');
    expect(a!.message).toContain("Press Reconnect");
    expect(adAlertsFor(conn({ provider: "adsense", accountName: null, accountId: "pub-1", status: "permission", errorCode: "no_access" }), now)[0]!.message).toContain('AdSense account "pub-1"');
    const w = describeAlert({ code: "ads_reconnect:c1", severity: "warning", message: a!.message });
    expect(w).toEqual({ severity: "warning", area: "ads", title: "An ad account needs reconnecting", body: a!.message });
  });

  it("Meta access running out within a week is announced with its date", () => {
    const [a] = adAlertsFor(conn({ accessTokenExpiresAt: new Date("2026-10-24T09:00:00Z") }), now);
    expect(a).toMatchObject({ kind: "ads_expiring" });
    expect(a!.message).toContain("24 October 2026");
    // Already gone: the sync marks it "reconnect" instead. Google's renews itself.
    expect(adAlertsFor(conn({ accessTokenExpiresAt: new Date(now.getTime() - 1000) }), now)).toEqual([]);
    expect(adAlertsFor(conn({ provider: "google", accessTokenExpiresAt: new Date(now.getTime() + 3600_000) }), now)).toEqual([]);
  });

  it("failing syncs are announced after six in a row or a day without one that worked, never for problems that are ours", () => {
    expect(adAlertsFor(conn({ status: "error", errorCode: "temporary", consecutiveFailures: 2 }), now)).toEqual([]);
    expect(adAlertsFor(conn({ status: "error", errorCode: "temporary", consecutiveFailures: 6 }), now)[0]).toMatchObject({ kind: "ads_failing" });
    const [late] = adAlertsFor(conn({ status: "error", errorCode: "provider_error", consecutiveFailures: 1, lastSyncedAt: new Date("2026-10-17T08:00:00Z") }), now);
    expect(late!.message).toContain("hasn't updated since 17 October 2026");
    for (const code of ["internal", "not_approved", "not_configured", "quota_exhausted"]) {
      expect(adAlertsFor(conn({ status: "error", errorCode: code, consecutiveFailures: 20, lastSyncedAt: null }), now)).toEqual([]);
    }
  });

  it("an account the platform closed or disabled is said to be unavailable", () => {
    expect(adAlertsFor(conn({ provider: "google", accountName: "Brand", status: "unavailable", errorCode: "account_closed" }), now)[0]).toMatchObject({
      kind: "ads_unavailable",
      message: expect.stringContaining("Google Ads says this account is closed"),
    });
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays, describeAlert } from "@app/shared";
import {
  resetEnvCache,
  adAlertsFor,
  ADS_HISTORY_DAYS,
  ADS_WINDOW_DAYS,
  AdsRateLimitedError,
  AdsRetryableError,
  catchUpWindow,
  countGoogleAdsOperations,
  countingGoogleAdsFetch,
  googleAdsBudget,
  googleAdsBudgetAllows,
  googleAdsOperationsToday,
  googleAdsPaused,
  historyTarget,
  isMetaAppLimit,
  memoryCoord,
  mergeCoverage,
  META_ADS_PAUSE_S,
  metaAdsPaused,
  metaAdsPausedUntil,
  nextHistoryWindow,
  pauseGoogleAds,
  pauseMetaAds,
  planAdSyncWindow,
  type FetchLike,
} from "../src/index.js";

/**
 * Ad syncs, the pure parts: which days a sync fetches (holes first, long ranges cut, history walked
 * back), the unbroken run of stored days it leaves, Google's daily allowance, Meta's limit on
 * bizinsights' app, and what an ad connection's state says in an alert.
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

  it("never lowers an hour's figure when the coordinator's counter starts again at the hour's end", async () => {
    const coord = memoryCoord();
    const t = Date.parse("2026-10-19T10:59:59Z");
    await countGoogleAdsOperations(coord, 400, t);
    // The next sync's hits reach the coordinator just after 11:00: its window for this key is a new one.
    let fresh = 0;
    const rolled = { ...coord, hit: async () => ++fresh };
    await countGoogleAdsOperations(rolled, 2, t);
    expect(await googleAdsOperationsToday(coord, t)).toBe(400);
    await countGoogleAdsOperations(coord, 3, t);
    expect(await googleAdsOperationsToday(coord, t)).toBe(403);
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

  it("the allowance is GOOGLE_ADS_DAILY_OPERATIONS once set (a higher access level), else Explorer's; an empty setting is unset", async () => {
    const coord = memoryCoord();
    try {
      process.env.GOOGLE_ADS_DAILY_OPERATIONS = "15000";
      resetEnvCache();
      expect((await googleAdsBudget(coord)).limit).toBe(15000);
      expect(googleAdsBudgetAllows({ paused: false, used: 11_999, limit: 15000 }, "schedule")).toBe(true);
      process.env.GOOGLE_ADS_DAILY_OPERATIONS = "";
      resetEnvCache();
      expect((await googleAdsBudget(coord)).limit).toBe(2880);
      // Not a number of operations: the config refuses it rather than guess.
      process.env.GOOGLE_ADS_DAILY_OPERATIONS = "lots";
      resetEnvCache();
      await expect(googleAdsBudget(coord)).rejects.toThrow(/GOOGLE_ADS_DAILY_OPERATIONS/);
    } finally {
      delete process.env.GOOGLE_ADS_DAILY_OPERATIONS;
      resetEnvCache();
    }
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

describe("Meta's limit on bizinsights' app", () => {
  it("only Meta's code 4 is the app's; 17, 613 and the business use case codes are an account's or a person's", () => {
    expect(isMetaAppLimit(new AdsRateLimitedError("Application request limit reached", null, "rate_limited", 4))).toBe(true);
    for (const code of [17, 32, 613, 80000, 80004, undefined]) expect(isMetaAppLimit(new AdsRateLimitedError("limit", 60, "rate_limited", code))).toBe(false);
    // Not throttling at all, even with the same number.
    expect(isMetaAppLimit(new AdsRetryableError("Service temporarily unavailable", 4))).toBe(false);
  });

  it("pauses Meta Ads for the wait Meta gave, else a quarter of its rolling hour; never under a minute or over the hour", async () => {
    const coord = memoryCoord();
    expect(await metaAdsPaused(coord)).toBe(false);
    expect(await pauseMetaAds(coord, null)).toBe(META_ADS_PAUSE_S);
    expect(META_ADS_PAUSE_S).toBe(900);
    const until = (await metaAdsPausedUntil(coord))!.getTime();
    expect(until - Date.now()).toBeGreaterThan(899_000);
    expect(until - Date.now()).toBeLessThanOrEqual(900_000);
    expect(await pauseMetaAds(coord, 420)).toBe(420);
    expect(await pauseMetaAds(coord, 5)).toBe(60);
    expect(await pauseMetaAds(coord, 7200)).toBe(3600);
    // Google's pause is its own.
    expect(await googleAdsPaused(coord)).toBe(false);
    // A coordinator that can't keep it: nothing thrown, no pause.
    const down = { ...memoryCoord(), put: async () => Promise.reject(new Error("unreachable")), peek: async () => Promise.reject(new Error("unreachable")) };
    expect(await pauseMetaAds(down, null)).toBeNull();
    expect(await metaAdsPaused(down)).toBe(false);
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

  it("is worded from the status when the code left on the row belongs to another one", () => {
    // A sync timed out (temporary), then a live report found the token dead and changed the status alone.
    const [a] = adAlertsFor(conn({ status: "reconnect", errorCode: "temporary" }), now);
    expect(a).toMatchObject({ kind: "ads_reconnect" });
    expect(a!.message).toContain("Press Reconnect");
    expect(a!.message).not.toContain("tries again by itself");
    // A lost account with a code of ours left over still asks the merchant, worded as the lost account.
    const [b] = adAlertsFor(conn({ status: "permission", errorCode: "internal" }), now);
    expect(b!.message).toContain("can no longer see this ad account");
    // An outage after an account was closed: worded as the failure it is.
    const [c] = adAlertsFor(conn({ status: "error", errorCode: "account_closed", consecutiveFailures: 6 }), now);
    expect(c).toMatchObject({ kind: "ads_failing" });
    expect(c!.message).not.toContain("closed");
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

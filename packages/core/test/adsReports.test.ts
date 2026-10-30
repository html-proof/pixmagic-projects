import type { AdConnection } from "@app/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FetchLike } from "../src/shopify.js";

/**
 * The live reports per connection: what a failure leaves on the connection (classifyAdError, then
 * recordAdFailure as "report"), Meta's permission errors told apart, and AdSense limited to the
 * store's sites. The database and the stored tokens are stood in for: what's tested is the order of
 * the steps and what each is given.
 */

const recorded: Array<{ id: string; failure: unknown; from: string }> = [];
let recordFails = false;
vi.mock("../src/adConnections/status.js", () => ({
  recordAdFailure: async (id: string, failure: unknown, from: string) => {
    if (recordFails) throw new Error("database unreachable");
    recorded.push({ id, failure, from });
  },
}));
let tokenError: Error | null = null;
vi.mock("../src/adConnections/credentials.js", () => ({
  adAccessToken: async () => {
    if (tokenError) throw tokenError;
    return "TOKEN";
  },
}));
let configured = true;
vi.mock("../src/adConnections/config.js", () => ({
  AD_PROVIDER_NAME: { meta: "Meta", google: "Google Ads", adsense: "Google AdSense" },
  metaConfig: (fetchImpl?: FetchLike) => (configured ? { appId: "app1", appSecret: "sec", version: "v25.0", fetchImpl } : null),
  // Reports go through googleClient: switching new Google Ads connections off (googleConfig) leaves them.
  googleClient: (fetchImpl?: FetchLike) => (configured ? { clientId: "cid", clientSecret: "csec", version: "v25", fetchImpl } : null),
  adsenseConfig: (fetchImpl?: FetchLike) => (configured ? { clientId: "cid", clientSecret: "csec", fetchImpl } : null),
}));

const { adsenseReportForConnection, googleReportForConnection, metaReportForConnection } = await import("../src/adConnections/reports.js");
const { AdsAuthError, AdsPermissionError, AdsRateLimitedError, AdsReportPendingError, AdsRetryableError } = await import("../src/ads.js");
const { googleAdsOperationsToday, googleAdsPaused, metaAdsPaused, pauseGoogleAds } = await import("../src/adConnections/budget.js");
const { memoryCoord } = await import("../src/coord.js");

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const conn = (over: Partial<AdConnection> = {}) => ({ id: "conn1", provider: "meta", accountId: "act_1", currency: "USD", sites: [], ...over }) as AdConnection;

beforeEach(() => {
  recorded.length = 0;
  recordFails = false;
  tokenError = null;
  configured = true;
});

describe("live reports per connection", () => {
  it("Meta: ads_read taken back marks the connection reconnect; a login that lost the account, permission", async () => {
    const meta = (adsRead: string): FetchLike => async (input) => {
      const u = new URL(String(input));
      if (u.pathname.endsWith("/me/permissions")) return json({ data: [{ permission: "ads_read", status: adsRead }] });
      return json({ error: { message: "(#200) Requires ads_read permission", code: 200 } }, 403);
    };
    const revoked = await metaReportForConnection(conn(), "campaign", "2026-10-01", "2026-10-07", meta("declined")).catch((e: unknown) => e);
    expect(revoked).toBeInstanceOf(AdsAuthError);
    expect(recorded).toEqual([{ id: "conn1", from: "report", failure: expect.objectContaining({ status: "reconnect", code: "scope_missing" }) }]);
    recorded.length = 0;
    const lost = await metaReportForConnection(conn(), "campaign", "2026-10-01", "2026-10-07", meta("granted")).catch((e: unknown) => e);
    expect(lost).toBeInstanceOf(AdsPermissionError);
    expect(recorded[0]!.failure).toMatchObject({ status: "permission", code: "no_access", detail: "(#200) Requires ads_read permission" });
  });

  it("Meta: the request's deadline reaches every Meta call; past it the report is still being prepared, which says nothing about the connection", async () => {
    const calls: URL[] = [];
    const meta: FetchLike = async (input) => {
      calls.push(new URL(String(input)));
      return json({ data: [] });
    };
    // A comparison's second range, asked once the first used up the request's time.
    const err = await metaReportForConnection(conn(), "campaign", "2026-09-01", "2026-09-07", meta, { deadline: Date.now() - 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdsReportPendingError);
    expect(calls).toEqual([]);
    expect(recorded).toEqual([{ id: "conn1", from: "report", failure: expect.objectContaining({ status: "error", code: "temporary", retryable: true }) }]);
    // With time left (the default: META_REPORT_JOB.budgetMs from now), the report comes.
    recorded.length = 0;
    expect((await metaReportForConnection(conn(), "campaign", "2026-09-01", "2026-09-07", meta)).rows).toEqual([]);
    expect(recorded).toEqual([]);
  });

  it("Meta: its limit on bizinsights' app pauses Meta Ads, syncs too; while paused no call is made and the answer is Meta's throttling", async () => {
    const coord = memoryCoord();
    let calls = 0;
    const appLimit: FetchLike = async () => (calls++, json({ error: { message: "(#4) Application request limit reached", code: 4 } }, 400));
    await expect(metaReportForConnection(conn(), "campaign", "2026-10-01", "2026-10-07", appLimit, { coord })).rejects.toMatchObject({ code: 4, errorCode: "rate_limited" });
    expect(await metaAdsPaused(coord)).toBe(true);
    // Another account's report, while paused: Meta isn't asked, and the route words it as Meta's throttling ("busy").
    calls = 0;
    recorded.length = 0;
    const held = await metaReportForConnection(conn({ id: "conn2", accountId: "act_2" }), "campaign", "2026-10-01", "2026-10-07", appLimit, { coord }).catch((e: unknown) => e);
    expect(held).toBeInstanceOf(AdsRateLimitedError);
    expect(held).toMatchObject({ errorCode: "rate_limited" });
    expect((held as InstanceType<typeof AdsRateLimitedError>).retryAfterS).toBeGreaterThan(890);
    expect(calls).toBe(0);
    expect(recorded).toEqual([]);
    // One account's own throttling (17) leaves the others alone.
    const fresh = memoryCoord();
    const userLimit: FetchLike = async () => json({ error: { message: "User request limit reached", code: 17 } }, 400);
    await expect(metaReportForConnection(conn(), "campaign", "2026-10-01", "2026-10-07", userLimit, { coord: fresh })).rejects.toMatchObject({ code: 17 });
    expect(await metaAdsPaused(fresh)).toBe(false);
  });

  it("Google: the failure is classified and recorded as a report's; recording failing never hides the report's own error", async () => {
    const throttled: FetchLike = async () =>
      json(
        [
          {
            error: {
              code: 429,
              message: "Resource has been exhausted",
              status: "RESOURCE_EXHAUSTED",
              details: [{ "@type": "type.googleapis.com/google.ads.googleads.v25.errors.GoogleAdsFailure", errors: [{ errorCode: { quotaError: "RESOURCE_TEMPORARILY_EXHAUSTED" }, message: "Too many requests" }] }],
            },
          },
        ],
        429,
      );
    await expect(googleReportForConnection(conn({ provider: "google", accountId: "111" }), "campaign", "2026-10-01", "2026-10-07", throttled)).rejects.toBeInstanceOf(AdsRateLimitedError);
    // recordAdFailure decides that a report's throttling leaves the connection as it is; it's told.
    expect(recorded[0]).toMatchObject({ from: "report", failure: { status: "error", code: "rate_limited", retryable: true } });
    recordFails = true;
    await expect(googleReportForConnection(conn({ provider: "google", accountId: "111" }), "campaign", "2026-10-01", "2026-10-07", throttled)).rejects.toBeInstanceOf(AdsRateLimitedError);
    // A refresh token Google refused: ended access, recorded.
    recordFails = false;
    recorded.length = 0;
    tokenError = new AdsAuthError("Token has been expired or revoked.");
    await expect(googleReportForConnection(conn({ provider: "google", accountId: "111" }), "campaign", "2026-10-01", "2026-10-07", throttled)).rejects.toBeInstanceOf(AdsAuthError);
    expect(recorded[0]!.failure).toMatchObject({ status: "reconnect", code: "auth_expired" });
  });

  it("Google: its operations count against bizinsights' daily allowance, none are made while that is used up, and Google saying so pauses them", async () => {
    const coord = memoryCoord();
    let calls = 0;
    const google: FetchLike = async () => {
      calls++;
      return json([{ results: [{ metrics: { costMicros: "1000000", impressions: "10", clicks: "1", conversions: 0, conversionsValue: 0 } }] }]);
    };
    const account = conn({ provider: "google", accountId: "111" });
    await googleReportForConnection(account, "campaign", "2026-10-01", "2026-10-07", google, { coord });
    expect(calls).toBeGreaterThan(0);
    expect(await googleAdsOperationsToday(coord)).toBe(calls);
    // Paused: no call at all, and the allowance named (not the account's problem: nothing recorded on it).
    await pauseGoogleAds(coord, null);
    calls = 0;
    await expect(googleReportForConnection(account, "campaign", "2026-10-01", "2026-10-07", google, { coord })).rejects.toMatchObject({ errorCode: "quota_exhausted" });
    expect(calls).toBe(0);
    // Google answering that the allowance is used up pauses Google Ads for the syncs too.
    const fresh = memoryCoord();
    const exhausted: FetchLike = async () =>
      json([{ error: { code: 429, message: "Resource has been exhausted", status: "RESOURCE_EXHAUSTED", details: [{ "@type": "type.googleapis.com/google.ads.googleads.v25.errors.GoogleAdsFailure", errors: [{ errorCode: { quotaError: "RESOURCE_EXHAUSTED" }, message: "Too many requests", details: { quotaErrorDetails: { rateScope: "DEVELOPER", rateName: "Number of operations for explorer access", retryDelay: "3600s" } } }] }] } }], 429);
    await expect(googleReportForConnection(account, "campaign", "2026-10-01", "2026-10-07", exhausted, { coord: fresh })).rejects.toMatchObject({ errorCode: "quota_exhausted" });
    expect(await googleAdsPaused(fresh)).toBe(true);
    expect(recorded.every((r) => (r.failure as { status: string }).status === "error")).toBe(true);
  });

  it("Google: a drill-down (one campaign's ad groups, one ad group's ads) is one counted operation, not two", async () => {
    const coord = memoryCoord();
    const queries: string[] = [];
    const google: FetchLike = async (_input, init) => {
      queries.push((JSON.parse(String(init?.body)) as { query: string }).query);
      return json([{ results: [{ campaign: { id: "11", name: "Brand" }, adGroup: { id: "55", name: "Shoes" }, metrics: { costMicros: "1000000", impressions: "10", clicks: "1" } }] }]);
    };
    const account = conn({ provider: "google", accountId: "111" });
    const r = await googleReportForConnection(account, "ad_group", "2026-10-01", "2026-10-07", google, { coord, parent: { campaign: "11" } });
    expect(r.rows).toEqual([expect.objectContaining({ id: "55", campaignId: "11" })]);
    expect(queries).toHaveLength(1);
    expect(await googleAdsOperationsToday(coord)).toBe(1);
    // The whole account's ad groups: the account's totals too, two.
    await googleReportForConnection(account, "ad_group", "2026-10-01", "2026-10-07", google, { coord });
    expect(await googleAdsOperationsToday(coord)).toBe(3);
    // The demo's drill-down: generated, nothing fetched or counted.
    const demo = conn({ provider: "google", isDemo: true, accountId: "DEMO-ADS-001", demoSeed: 7, timezone: "UTC", createdAt: new Date("2026-10-20T00:00:00Z") });
    const ads = await googleReportForConnection(demo, "ad", "2026-10-01", "2026-10-07", google, { coord, parent: { campaign: "demo-c2", adGroup: "demo-c2-core" } });
    expect(ads.rows.length).toBeGreaterThan(0);
    expect(queries).toHaveLength(3);
    expect(await googleAdsOperationsToday(coord)).toBe(3);
  });

  it("Google and AdSense: a report ends by its deadline, as 'busy' (try again), and the operations it started are still counted", async () => {
    const coord = memoryCoord();
    let calls = 0;
    // Google takes the request and never answers (until the call is cut off).
    const hangs: FetchLike = (_input, init) => {
      calls++;
      return new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true }));
    };
    const started = Date.now();
    const google = await googleReportForConnection(conn({ provider: "google", accountId: "111" }), "campaign", "2026-10-01", "2026-10-07", hangs, { coord, deadline: Date.now() + 200 }).catch((e: unknown) => e);
    expect(google).toBeInstanceOf(AdsRetryableError);
    expect(google).not.toBeInstanceOf(AdsRateLimitedError);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(calls).toBeGreaterThan(0);
    expect(await googleAdsOperationsToday(coord)).toBe(calls);
    const adsense = await adsenseReportForConnection(conn({ provider: "adsense", accountId: "accounts/pub-1" }), "site", "2026-10-01", "2026-10-07", hangs, { deadline: Date.now() + 200 }).catch((e: unknown) => e);
    expect(adsense).toBeInstanceOf(AdsRetryableError);
    // A deadline already passed makes no call at all.
    calls = 0;
    await expect(googleReportForConnection(conn({ provider: "google", accountId: "111" }), "campaign", "2026-10-01", "2026-10-07", hangs, { deadline: Date.now() - 1 })).rejects.toBeInstanceOf(AdsRetryableError);
    expect(calls).toBe(0);
  });

  it("AdSense: limited to the connection's sites, in the report's currency", async () => {
    const calls: URL[] = [];
    const adsense: FetchLike = async (input) => {
      const u = new URL(String(input));
      calls.push(u);
      return json({
        headers: [{ name: "COUNTRY_CODE", type: "DIMENSION" }, { name: "COUNTRY_NAME", type: "DIMENSION" }, { name: "ESTIMATED_EARNINGS", type: "METRIC_CURRENCY", currencyCode: "AUD" }],
        rows: [{ cells: [{ value: "AU" }, { value: "Australia" }, { value: "3.10" }] }],
        totals: { cells: [{}, {}, { value: "3.10" }] },
        totalMatchedRows: "1",
      });
    };
    const r = await adsenseReportForConnection(conn({ provider: "adsense", accountId: "pub-1", sites: ["shop.example.com"] }), "country", "2026-10-01", "2026-10-07", adsense);
    expect(r).toMatchObject({ level: "country", since: "2026-10-01", until: "2026-10-07", currency: "AUD", truncated: false, rows: [{ id: "AU", name: "Australia", earnings: 3.1 }], totals: { earnings: 3.1 } });
    // The sites it was limited to go with it, so the page can say whose earnings these are.
    expect(r.sites).toEqual(["shop.example.com"]);
    expect(calls[0]!.pathname).toBe("/v2/accounts/pub-1/reports:generate");
    expect(calls[0]!.searchParams.getAll("filters")).toEqual(["DOMAIN_CODE==shop.example.com"]);
    expect(recorded).toEqual([]);
  });

  it("a platform not set up on this server is ours: said so, and nothing recorded on the connection", async () => {
    configured = false;
    for (const run of [
      () => metaReportForConnection(conn(), "campaign", "2026-10-01", "2026-10-07"),
      () => googleReportForConnection(conn({ provider: "google" }), "campaign", "2026-10-01", "2026-10-07"),
      () => adsenseReportForConnection(conn({ provider: "adsense" }), "site", "2026-10-01", "2026-10-07"),
    ]) {
      await expect(run()).rejects.toMatchObject({ status: 503, errorCode: "not_configured" });
    }
    expect(recorded).toEqual([]);
  });
});

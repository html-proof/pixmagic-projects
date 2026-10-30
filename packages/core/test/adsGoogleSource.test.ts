import { describe, expect, it } from "vitest";
import { addDays, DEMO_ACCOUNT_ID, DEMO_DEFAULT_SEED } from "@app/shared";
import { AdsApiError, demoContextOf, GoogleAdsDemoProvider, GoogleAdsProductionProvider, googleAdsSource, isDemoConnection, type FetchLike } from "../src/index.js";

/**
 * Where a Google Ads connection's figures come from: the generator for a demo row (never a network
 * call, whatever is configured), Google for a real one (and nothing at all without the OAuth client).
 */

const noNetwork: FetchLike = async () => {
  throw new Error("the demo made a network call");
};

const demoConn = {
  provider: "google",
  isDemo: true,
  accountId: DEMO_ACCOUNT_ID,
  loginCustomerId: null,
  demoSeed: 4242,
  currency: "AUD",
  timezone: "Australia/Melbourne",
  createdAt: new Date("2026-10-19T23:30:00Z"),
};

describe("the demo source", () => {
  it("is chosen for a demo row whatever keys are around, and never fetches", async () => {
    const src = googleAdsSource(demoConn, { cfg: { clientId: "id", clientSecret: "secret", version: "v25", fetchImpl: noNetwork }, accessToken: "" });
    expect(src).toBeInstanceOf(GoogleAdsDemoProvider);
    expect(src.kind).toBe("demo");
    const rows = await src.campaignDays("2026-09-01", "2026-09-07");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.accountId === DEMO_ACCOUNT_ID && r.day >= "2026-09-01" && r.day <= "2026-09-07")).toBe(true);
    const health = await src.accountHealth();
    expect(health).toMatchObject({ status: "active", currency: "AUD", timezone: "Australia/Melbourne" });
    expect(health.detail).toContain("not verified by Google");
    const report = await src.report("campaign", "2026-09-01", "2026-09-30");
    expect(report.rows.length).toBeGreaterThan(0);
    expect(report.truncated).toBe(false);
    // Down from a campaign to its ad groups and an ad group's ads: generated too.
    const groups = await src.report("ad_group", "2026-09-01", "2026-09-30", { campaign: "demo-c2" });
    expect(groups.rows.map((r) => r.id).sort()).toEqual(["demo-c2-broad", "demo-c2-core"]);
    const ads = await src.report("ad", "2026-09-01", "2026-09-30", { campaign: "demo-c2", adGroup: "demo-c2-core" });
    expect(ads.rows.length).toBeGreaterThan(0);
    expect(ads.rows.every((r) => r.adGroupId === "demo-c2-core")).toBe(true);
    // Keywords and search terms: generated as well, never asked of Google.
    const keywords = await src.report("keyword", "2026-09-01", "2026-09-30");
    expect(keywords.rows.length).toBeGreaterThan(0);
    expect(keywords.rows.every((r) => r.matchType !== null && r.qualityScore !== null)).toBe(true);
    const terms = await src.report("search_term", "2026-09-01", "2026-09-30", { campaign: "demo-c7" });
    expect(terms.rows.length).toBeGreaterThan(0);
    expect(terms.rows.every((r) => r.campaignId === "demo-c7" && r.channel === "PERFORMANCE_MAX")).toBe(true);
  });

  it("takes its epoch from the day the demo was connected, in the account's own zone", () => {
    // 23:30 UTC on the 19th is already the 20th in Melbourne.
    expect(demoContextOf(demoConn)).toEqual({ seed: 4242, currency: "AUD", epoch: "2026-10-20" });
    expect(demoContextOf({ ...demoConn, demoSeed: null, currency: null, timezone: "Not/AZone" })).toEqual({ seed: DEMO_DEFAULT_SEED, currency: "INR", epoch: "2026-10-19" });
  });

  it("generates the same days whichever window asks for them", async () => {
    const src = new GoogleAdsDemoProvider(demoConn);
    const whole = await src.campaignDays("2026-09-01", "2026-09-30");
    const part = await src.campaignDays("2026-09-10", "2026-09-12");
    expect(part).toEqual(whole.filter((r) => r.day >= "2026-09-10" && r.day <= "2026-09-12"));
    const today = demoContextOf(demoConn).epoch;
    expect((await src.campaignDays(addDays(today, 5), addDays(today, 5))).length).toBeGreaterThan(0);
  });
});

describe("the production source", () => {
  it("is chosen for a real row, and refuses without the OAuth client", () => {
    const real = { ...demoConn, isDemo: false, accountId: "1234567890", loginCustomerId: "9876543210", demoSeed: null };
    expect(isDemoConnection(real)).toBe(false);
    expect(isDemoConnection({ provider: "meta", isDemo: true })).toBe(false);
    const src = googleAdsSource(real, { cfg: { clientId: "id", clientSecret: "secret", version: "v25", fetchImpl: noNetwork }, accessToken: "token" });
    expect(src).toBeInstanceOf(GoogleAdsProductionProvider);
    expect(src.kind).toBe("production");
    expect(() => googleAdsSource(real, { cfg: null, accessToken: "token" })).toThrow(AdsApiError);
    try {
      googleAdsSource(real, { cfg: null, accessToken: "token" });
    } catch (err) {
      expect((err as AdsApiError).errorCode).toBe("not_configured");
    }
  });

  it("asks Google, never the generator", async () => {
    let asked = 0;
    const fetchImpl: FetchLike = async () => {
      asked++;
      return new Response(JSON.stringify([{ results: [] }]), { status: 200, headers: { "content-type": "application/json" } });
    };
    const src = googleAdsSource({ ...demoConn, isDemo: false, accountId: "1234567890" }, { cfg: { clientId: "id", clientSecret: "secret", version: "v25", fetchImpl }, accessToken: "token" });
    expect(await src.campaignDays("2026-09-01", "2026-09-07")).toEqual([]);
    expect(asked).toBe(1);
    // A drill-down is one query, and only for Google's own ids.
    expect((await src.report("ad", "2026-09-01", "2026-09-07", { adGroup: "55" })).rows).toEqual([]);
    expect(asked).toBe(2);
    await expect(src.report("ad", "2026-09-01", "2026-09-07", { adGroup: "demo-c2-core" })).rejects.toMatchObject({ status: 400 });
    expect(asked).toBe(2);
  });
});

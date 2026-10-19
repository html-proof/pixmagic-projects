import { describe, expect, it } from "vitest";
import {
  AdsApiError,
  AdsAuthError,
  adsenseAccounts,
  adsenseAuthorizeUrl,
  adsenseSiteDays,
  AdsRetryableError,
  googleAdAccounts,
  googleAuthorizeUrl,
  googleCampaignDays,
  googleExchangeCode,
  googleRefresh,
  metaAdAccounts,
  metaAuthorizeUrl,
  metaCampaignDays,
  metaExchangeCode,
  ADS_GOOGLE_RECHECK_DAYS,
  ADS_RECHECK_DAYS,
  recheckDays,
  type FetchLike,
} from "../src/index.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A fake fetch that answers by URL and records every call. */
function fake(route: (url: URL, init: RequestInit | undefined) => Response | Promise<Response>) {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    return route(url, init);
  };
  return { fetchImpl, calls };
}

const meta = (fetchImpl: FetchLike) => ({ appId: "app1", appSecret: "sec", version: "v25.0", fetchImpl });
const google = (fetchImpl: FetchLike) => ({ clientId: "cid", clientSecret: "csec", version: "v25", fetchImpl });

describe("Meta", () => {
  it("asks only to read ads, and turns the code into a long-lived token", async () => {
    const url = new URL(metaAuthorizeUrl(meta(fetch), "https://app/api/integrations/meta/callback", "st"));
    expect(url.origin + url.pathname).toBe("https://www.facebook.com/v25.0/dialog/oauth");
    expect(url.searchParams.get("scope")).toBe("ads_read");
    expect(url.searchParams.get("state")).toBe("st");

    const f = fake((u) =>
      u.searchParams.get("grant_type") === "fb_exchange_token" ? json({ access_token: "LONG", expires_in: 5_184_000 }) : json({ access_token: "SHORT", expires_in: 3600 }),
    );
    const t = await metaExchangeCode(meta(f.fetchImpl), "CODE", "https://app/cb");
    expect(t.accessToken).toBe("LONG");
    expect(t.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 59 * 86_400_000);
    expect(f.calls[0]!.url.searchParams.get("code")).toBe("CODE");
    expect(f.calls[1]!.url.searchParams.get("fb_exchange_token")).toBe("SHORT");
  });

  it("lists ad accounts across pages and reads daily campaign numbers", async () => {
    const f = fake((u) => {
      if (u.pathname.endsWith("/me/adaccounts") && !u.searchParams.get("after")) {
        return json({ data: [{ id: "act_1", name: "Main", currency: "AUD", timezone_name: "Australia/Sydney" }], paging: { next: "https://graph.facebook.com/v25.0/me/adaccounts?after=x" } });
      }
      if (u.pathname.endsWith("/me/adaccounts")) return json({ data: [{ id: "act_2", name: "Second", currency: "USD" }] });
      if (u.pathname.endsWith("/act_1/insights")) {
        expect(JSON.parse(u.searchParams.get("time_range")!)).toEqual({ since: "2026-10-01", until: "2026-10-02" });
        return json({ data: [{ campaign_id: "9", campaign_name: "Spring", date_start: "2026-10-01", spend: "5.5", impressions: "100", clicks: "4", actions: [{ action_type: "omni_purchase", value: "1" }] }] });
      }
      return json({ error: { message: "unexpected" } }, 400);
    });
    expect(await metaAdAccounts(meta(f.fetchImpl), "TOKEN")).toEqual([
      { accountId: "act_1", name: "Main", currency: "AUD", timezone: "Australia/Sydney", status: null, statusDetail: null },
      { accountId: "act_2", name: "Second", currency: "USD", timezone: null, status: null, statusDetail: null },
    ]);
    const rows = await metaCampaignDays(meta(f.fetchImpl), "TOKEN", "1", "2026-10-01", "2026-10-02");
    expect(rows).toEqual([expect.objectContaining({ provider: "meta", accountId: "act_1", campaignName: "Spring", spend: 5.5, conversions: 1 })]);
  });

  it("tells an expired token apart from a rate limit", async () => {
    const expired = fake(() => json({ error: { message: "Session has expired", code: 190 } }, 400));
    await expect(metaAdAccounts(meta(expired.fetchImpl), "T")).rejects.toBeInstanceOf(AdsAuthError);
    const busy = fake(() => json({ error: { message: "User request limit reached", code: 17 } }, 400));
    await expect(metaAdAccounts(meta(busy.fetchImpl), "T")).rejects.toBeInstanceOf(AdsRetryableError);
    // A permission error keeps Meta's code, so a sync can tell "ads_read taken back" from "lost one account".
    const denied = fake(() => json({ error: { message: "(#200) Requires ads_read permission", code: 200 } }, 403));
    await expect(metaAdAccounts(meta(denied.fetchImpl), "T")).rejects.toMatchObject({ status: 403, code: 200 });
  });

  it("uses a Facebook Login for Business configuration when one is set", () => {
    const url = new URL(metaAuthorizeUrl({ ...meta(fetch), configId: "cfg9" }, "https://app/cb", "st"));
    expect(url.searchParams.get("config_id")).toBe("cfg9");
    expect(url.searchParams.has("scope")).toBe(false);
  });
});

describe("Google", () => {
  it("asks for offline access to Google Ads reporting", async () => {
    const url = new URL(googleAuthorizeUrl(google(fetch), "https://app/cb", "st"));
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/adwords");
    expect(url.searchParams.get("access_type")).toBe("offline");

    const f = fake(async (_u, init) => {
      const form = new URLSearchParams(String(init?.body));
      if (form.get("grant_type") === "authorization_code") return json({ access_token: "AT", refresh_token: "RT", expires_in: 3599 });
      if (form.get("refresh_token") === "RT") return json({ access_token: "AT2", expires_in: 3599 });
      return json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400);
    });
    expect(await googleExchangeCode(google(f.fetchImpl), "CODE", "https://app/cb")).toMatchObject({ accessToken: "AT", refreshToken: "RT" });
    expect(await googleRefresh(google(f.fetchImpl), "RT")).toMatchObject({ accessToken: "AT2", refreshToken: "RT" });
    await expect(googleRefresh(google(f.fetchImpl), "OLD")).rejects.toBeInstanceOf(AdsAuthError);
  });

  it("finds direct accounts and a manager's clients, and reads daily campaign numbers", async () => {
    const f = fake(async (u, init) => {
      const headers = new Headers(init?.headers);
      // Developer tokens were retired (2026-09-09): access follows the Cloud project.
      expect(headers.get("developer-token")).toBeNull();
      if (u.pathname === "/v25/customers:listAccessibleCustomers") return json({ resourceNames: ["customers/111", "customers/222", "customers/333"] });
      const query = init?.body ? (JSON.parse(String(init.body)) as { query: string }).query : "";
      if (u.pathname === "/v25/customers/111/googleAds:searchStream" && query.endsWith("FROM customer")) {
        return json([{ results: [{ customer: { id: "111", descriptiveName: "Shop ads", currencyCode: "AUD", timeZone: "Australia/Sydney", manager: false } }] }]);
      }
      // Purchases only: conversion actions of the PURCHASE category (a lead was the other conversion).
      if (u.pathname === "/v25/customers/111/googleAds:searchStream" && query.includes("segments.conversion_action_category = 'PURCHASE'")) {
        return json([{ results: [{ campaign: { id: "5" }, segments: { date: "2026-10-01", conversionActionCategory: "PURCHASE" }, metrics: { conversions: 1, conversionsValue: 40 } }] }]);
      }
      if (u.pathname === "/v25/customers/111/googleAds:searchStream") return json([{ results: [{ campaign: { id: "5", name: "Brand" }, segments: { date: "2026-10-01" }, metrics: { costMicros: "2500000", impressions: "50", clicks: "3", conversions: 2, conversionsValue: 55 } }] }]);
      if (u.pathname === "/v25/customers/222/googleAds:searchStream" && query.endsWith("FROM customer")) return json([{ results: [{ customer: { id: "222", descriptiveName: "Agency", manager: true } }] }]);
      if (u.pathname === "/v25/customers/222/googleAds:searchStream") {
        expect(headers.get("login-customer-id")).toBe("222");
        return json([{ results: [{ customerClient: { id: "444", descriptiveName: "Client", currencyCode: "USD", timeZone: "America/New_York", manager: false } }] }]);
      }
      // A cancelled account: skipped, not fatal.
      return json([{ error: { message: "The customer account can't be accessed because it is not yet enabled or has been deactivated.", status: "PERMISSION_DENIED" } }], 403);
    });
    expect(await googleAdAccounts(google(f.fetchImpl), "AT")).toEqual([
      { accountId: "111", name: "Shop ads", currency: "AUD", timezone: "Australia/Sydney", loginCustomerId: null, status: null },
      { accountId: "444", name: "Client", currency: "USD", timezone: "America/New_York", loginCustomerId: "222", status: null },
    ]);
    const rows = await googleCampaignDays(google(f.fetchImpl), "AT", { accountId: "111" }, "2026-10-01", "2026-10-01");
    expect(rows).toEqual([{ provider: "google", accountId: "111", campaignId: "5", campaignName: "Brand", day: "2026-10-01", spend: 2.5, impressions: 50, clicks: 3, linkClicks: 3, conversions: 2, conversionValue: 55, purchases: 1, purchaseValue: 40, leads: 0 }]);
    await expect(googleCampaignDays(google(f.fetchImpl), "AT", { accountId: "111" }, "2026-10-01' OR 1=1 --", "2026-10-01")).rejects.toThrow("Invalid date range");
  });
});

describe("AdSense", () => {
  const adsense = (fetchImpl: FetchLike) => ({ clientId: "cid", clientSecret: "csec", fetchImpl });
  const report = (bySite: boolean) => ({
    headers: [
      { name: "DATE", type: "DIMENSION" },
      ...(bySite ? [{ name: "DOMAIN_CODE", type: "DIMENSION" }] : []),
      { name: "ESTIMATED_EARNINGS", type: "METRIC_CURRENCY", currencyCode: "AUD" },
      { name: "PAGE_VIEWS", type: "METRIC_TALLY" },
      { name: "IMPRESSIONS", type: "METRIC_TALLY" },
      { name: "CLICKS", type: "METRIC_TALLY" },
    ],
    rows: [{ cells: [{ value: "2026-10-01" }, ...(bySite ? [{ value: "shop.example.com" }] : []), { value: "4.2" }, { value: "900" }, { value: "1800" }, { value: "3" }] }],
  });

  it("asks for offline, read-only access to AdSense, with no developer token", () => {
    const url = new URL(adsenseAuthorizeUrl(adsense(fetch), "https://app/api/ads/adsense/callback", "st"));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/adsense.readonly");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("redirect_uri")).toBe("https://app/api/ads/adsense/callback");
  });

  it("lists accounts across pages, leaving closed ones out", async () => {
    const f = fake((u, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer AT");
      expect(new Headers(init?.headers).get("developer-token")).toBeNull();
      if (u.pathname !== "/v2/accounts") return json({ error: { message: "unexpected" } }, 400);
      if (!u.searchParams.get("pageToken")) {
        return json({ accounts: [{ name: "accounts/pub-1", displayName: "My site", timeZone: { id: "Australia/Sydney" }, state: "READY" }, { name: "accounts/pub-2", displayName: "Old", state: "CLOSED" }], nextPageToken: "p2" });
      }
      return json({ accounts: [{ name: "accounts/pub-3", state: "NEEDS_ATTENTION" }] });
    });
    expect(await adsenseAccounts(adsense(f.fetchImpl), "AT")).toEqual([
      { accountId: "pub-1", name: "My site", currency: null, timezone: "Australia/Sydney", status: "active", statusDetail: null },
      { accountId: "pub-3", name: null, currency: null, timezone: null, status: "needs_attention", statusDetail: null },
    ]);
    expect(f.calls[1]!.url.searchParams.get("pageToken")).toBe("p2");
  });

  it("reads earnings per site per day on the account's own calendar", async () => {
    const f = fake(() => json(report(true)));
    const r = await adsenseSiteDays(adsense(f.fetchImpl), "AT", "pub-1", "2026-09-30", "2026-10-01");
    expect(r).toEqual({ currency: "AUD", rows: [{ accountId: "pub-1", site: "shop.example.com", day: "2026-10-01", earnings: 4.2, pageViews: 900, impressions: 1800, clicks: 3 }] });
    const q = f.calls[0]!.url;
    expect(q.pathname).toBe("/v2/accounts/pub-1/reports:generate");
    expect([q.searchParams.get("startDate.year"), q.searchParams.get("startDate.month"), q.searchParams.get("startDate.day")]).toEqual(["2026", "9", "30"]);
    expect([q.searchParams.get("endDate.year"), q.searchParams.get("endDate.month"), q.searchParams.get("endDate.day")]).toEqual(["2026", "10", "1"]);
    expect(q.searchParams.getAll("dimensions")).toEqual(["DATE", "DOMAIN_CODE"]);
    expect(q.searchParams.getAll("metrics")).toEqual(["ESTIMATED_EARNINGS", "PAGE_VIEWS", "IMPRESSIONS", "CLICKS"]);
    expect(q.searchParams.get("reportingTimeZone")).toBe("ACCOUNT_TIME_ZONE");
  });

  it("falls back to whole-account days when AdSense won't split the report by site", async () => {
    const f = fake((u) => (u.searchParams.getAll("dimensions").includes("DOMAIN_CODE") ? json({ error: { message: "Invalid dimension combination", status: "INVALID_ARGUMENT" } }, 400) : json(report(false))));
    const r = await adsenseSiteDays(adsense(f.fetchImpl), "AT", "accounts/pub-1", "2026-10-01", "2026-10-01");
    expect(r.rows).toEqual([{ accountId: "pub-1", site: "", day: "2026-10-01", earnings: 4.2, pageViews: 900, impressions: 1800, clicks: 3 }]);
    expect(f.calls).toHaveLength(2);
  });

  it("tells ended access, rate limits and bad input apart", async () => {
    const ended = fake(() => json({ error: { message: "Request had invalid authentication credentials.", status: "UNAUTHENTICATED" } }, 401));
    await expect(adsenseAccounts(adsense(ended.fetchImpl), "AT")).rejects.toBeInstanceOf(AdsAuthError);
    const busy = fake(() => json({ error: { message: "Quota exceeded", status: "RESOURCE_EXHAUSTED" } }, 429));
    await expect(adsenseSiteDays(adsense(busy.fetchImpl), "AT", "pub-1", "2026-10-01", "2026-10-01")).rejects.toBeInstanceOf(AdsRetryableError);
    const none = fake(() => json({ error: { message: "User does not have an AdSense account.", status: "PERMISSION_DENIED" } }, 403));
    await expect(adsenseAccounts(adsense(none.fetchImpl), "AT")).rejects.toMatchObject({ status: 403 });
    await expect(adsenseSiteDays(adsense(none.fetchImpl), "AT", "pub-1", "2026-10-01' OR 1=1", "2026-10-01")).rejects.toThrow("Invalid date range");
    await expect(adsenseSiteDays(adsense(none.fetchImpl), "AT", "../accounts/pub-1", "2026-10-01", "2026-10-01")).rejects.toBeInstanceOf(AdsApiError);
    expect(none.calls).toHaveLength(1);
  });
});

describe("the daily re-check of an ad account", () => {
  it("re-reads as far back as each platform keeps revising: Google 90 days, Meta 30, AdSense the month before early in a month", () => {
    const now = new Date("2026-10-17T12:00:00Z");
    expect(recheckDays({ provider: "google", timezone: "UTC" }, now)).toBe(ADS_GOOGLE_RECHECK_DAYS);
    expect(recheckDays({ provider: "meta", timezone: "UTC" }, now)).toBe(ADS_RECHECK_DAYS);
    expect(recheckDays({ provider: "adsense", timezone: "UTC" }, now)).toBe(ADS_RECHECK_DAYS);
    // 5 Oct: September's estimated earnings are being finalized, so all of September comes again (35 days).
    expect(recheckDays({ provider: "adsense", timezone: "UTC" }, new Date("2026-10-05T12:00:00Z"))).toBe(35);
    // 10 March: all of February (28 days) and ten days of March.
    expect(recheckDays({ provider: "adsense", timezone: "UTC" }, new Date("2026-03-10T12:00:00Z"))).toBe(38);
    // January looks back into December of the year before.
    expect(recheckDays({ provider: "adsense", timezone: "UTC" }, new Date("2027-01-02T12:00:00Z"))).toBe(33);
  });
});

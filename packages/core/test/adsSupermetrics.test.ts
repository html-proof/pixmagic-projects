import { describe, expect, it } from "vitest";
import {
  AdsApiError,
  AdsAuthError,
  AdsNoAccountsError,
  AdsPermissionError,
  AdsRateLimitedError,
  AdsReportPendingError,
  AdsRetryableError,
  classifyAdError,
  supermetricsAccountHealth,
  supermetricsAccountId,
  supermetricsAdsenseDays,
  supermetricsAdsenseReport,
  supermetricsCreateLoginLink,
  supermetricsError,
  supermetricsGoogleDays,
  supermetricsGoogleReport,
  supermetricsLoginAccounts,
  supermetricsLoginUsable,
  supermetricsMetaAccountStatus,
  supermetricsMetaDays,
  supermetricsMetaReport,
  supermetricsQuery,
  supermetricsSourceLicensed,
  type FetchLike,
  type SupermetricsCredential,
} from "../src/index.js";

/**
 * The Supermetrics client (packages/core/src/ads/supermetrics.ts) against answers shaped like
 * Supermetrics' documented ones: the Data API's JSON output (meta.query.fields with each field's
 * data_column, data as rows of values; https://docs.supermetrics.com/apidocs/output-formats), its
 * asynchronous status (https://docs.supermetrics.com/apidocs/async-queries), its error envelope and
 * codes (https://docs.supermetrics.com/apidocs/errors), and the Management API's login links,
 * logins and login accounts.
 */

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

type Call = { url: URL; init?: RequestInit; body: Record<string, unknown> | null };
function fake(route: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    const call = { url, init, body };
    calls.push(call);
    return route(call);
  };
  return { fetchImpl, calls };
}

const cfg = (fetchImpl: FetchLike) => ({ apiKey: "sm_test_key_0123456789", baseUrl: "https://api.supermetrics.com", fetchImpl });
const cred: SupermetricsCredential = { dsUser: "ads.owner@example.com", dsAccount: "123456789" };

/**
 * A finished query's answer for the fields asked, the columns in reverse order (as data_column says),
 * so the rows are only right when read by data_column, never by position.
 */
function answer(fields: string[], rows: Array<Record<string, unknown>>) {
  const order = [...fields].reverse();
  return json({
    meta: { status_code: "SUCCESS", query: { fields: fields.map((id) => ({ id, field_id: id, data_column: order.indexOf(id) })) } },
    data: rows.map((r) => order.map((f) => (r[f] === undefined ? null : r[f]))),
  });
}

/** Answer each query from `byFields(fields, body)`. */
function dataApi(byFields: (fields: string[], body: Record<string, unknown>) => Array<Record<string, unknown>>) {
  return fake((c) => {
    if (c.url.pathname !== "/query/data/json") return json({ error: { code: "NOT_FOUND" } }, 404);
    const fields = c.body?.fields as string[];
    return answer(fields, byFields(fields, c.body!));
  });
}

describe("every request carries the key in a header, and the login's username never in a URL", () => {
  it("queries are POSTed with ds_user, the account, the dates, the fields and no_headers", async () => {
    const f = dataApi(() => [{ Date: "2026-10-01", cost: 1 }]);
    await supermetricsQuery(cfg(f.fetchImpl), { dsId: "FA", cred, since: "2026-10-01", until: "2026-10-02", fields: ["Date", "cost"] });
    const [call] = f.calls;
    expect(call!.init?.method).toBe("POST");
    expect(new Headers(call!.init?.headers).get("authorization")).toBe("Bearer sm_test_key_0123456789");
    expect(call!.url.toString()).not.toContain("sm_test_key");
    expect(call!.url.toString()).not.toContain("example.com");
    expect(call!.body).toMatchObject({ ds_id: "FA", ds_user: "ads.owner@example.com", ds_accounts: ["123456789"], start_date: "2026-10-01", end_date: "2026-10-02", fields: ["Date", "cost"], settings: { no_headers: true } });
  });

  it("a login link asks for the platform, the expiry and where to send the person back", async () => {
    const f = fake(() => json({ meta: { request_id: "r1" }, data: { link_id: "lnk_1", status_code: "OPEN", login_url: "https://hub.supermetrics.com/login/link/abc", ds_id: "FA" } }, 201));
    const link = await supermetricsCreateLoginLink(cfg(f.fetchImpl), {
      dsId: "FA",
      description: "bizinsights meta · workspace w1 · store s1",
      expiresAt: new Date("2026-10-22T12:30:00Z"),
      redirectUrl: "https://bizinsights.io/api/ads/supermetrics/callback?state=abc",
    });
    expect(link).toMatchObject({ linkId: "lnk_1", status: "OPEN", loginUrl: "https://hub.supermetrics.com/login/link/abc", loginId: null });
    expect(f.calls[0]!.url.pathname).toBe("/ds/login/link");
    expect(f.calls[0]!.body).toEqual({
      ds_id: "FA",
      description: "bizinsights meta · workspace w1 · store s1",
      expiry_time: "2026-10-22T12:30:00.000Z",
      redirect_url: "https://bizinsights.io/api/ads/supermetrics/callback?state=abc",
    });
  });

  it("a link without an https address to send the person to is refused (plain http only on this machine)", async () => {
    const linkTo = (login_url: string) =>
      supermetricsCreateLoginLink(cfg(fake(() => json({ data: { link_id: "lnk_1", login_url } }, 201)).fetchImpl), { dsId: "FA", description: "x", expiresAt: new Date(), redirectUrl: "https://bizinsights.io/cb" });
    await expect(linkTo("javascript:alert(1)")).rejects.toBeInstanceOf(AdsApiError);
    await expect(linkTo("http://hub.supermetrics.com/login/link/abc")).rejects.toBeInstanceOf(AdsApiError);
    await expect(linkTo("not a url")).rejects.toBeInstanceOf(AdsApiError);
    // A local stand-in for Supermetrics (development).
    await expect(linkTo("http://127.0.0.1:9361/login/link/lnk_1")).resolves.toMatchObject({ linkId: "lnk_1" });
  });
});

describe("Supermetrics' error codes say whose problem it is", () => {
  it("the key, the licence or a query bizinsights built wrong are ours; the login ended means reconnect; a lost account is permission", () => {
    expect(classifyAdError(supermetricsError(401, { code: "API_KEY_INVALID" }))).toMatchObject({ status: "error", code: "not_configured" });
    expect(classifyAdError(supermetricsError(403, { code: "LICENSE_ACCESS_DATA_SOURCE" }))).toMatchObject({ code: "not_configured" });
    expect(classifyAdError(supermetricsError(400, { code: "FIELD_NOT_FOUND" }))).toMatchObject({ code: "not_configured" });
    expect(supermetricsError(500, { code: "QUERY_AUTH_EXPIRED" })).toBeInstanceOf(AdsAuthError);
    expect(classifyAdError(supermetricsError(500, { code: "QUERY_AUTH_LOGIN_FAILED" }))).toMatchObject({ status: "reconnect", code: "auth_expired" });
    expect(supermetricsError(400, { code: "QUERY_ACCOUNT_INVALID" })).toBeInstanceOf(AdsPermissionError);
    expect(classifyAdError(supermetricsError(429, { code: "QUERY_ACCOUNT_UNAVAILABLE" }))).toMatchObject({ status: "permission", code: "no_access" });
  });

  it("throttling and the team's daily allowance wait (the allowance is ours); outages retry", () => {
    const limited = supermetricsError(429, { code: "QUERY_API_RATE_LIMITED" }, 30);
    expect(limited).toBeInstanceOf(AdsRateLimitedError);
    expect(classifyAdError(limited)).toMatchObject({ code: "rate_limited", retryable: true, retryAfterS: 30 });
    expect(classifyAdError(supermetricsError(429, { code: "LICENSE_DAILY_QUERY_LIMIT_EXCEEDED" }))).toMatchObject({ code: "quota_exhausted", retryable: true });
    expect(supermetricsError(503, undefined)).toBeInstanceOf(AdsRetryableError);
    expect(supermetricsError(500, { code: "QUERY_ERROR" })).toBeInstanceOf(AdsRetryableError);
  });

  it("an error answer's Retry-After is kept", async () => {
    const f = fake(() => json({ meta: {}, error: { code: "TOO_MANY_REQUESTS", message: "Slow down" } }, 429, { "retry-after": "12" }));
    const err = await supermetricsQuery(cfg(f.fetchImpl), { dsId: "FA", cred, since: "2026-10-01", until: "2026-10-01", fields: ["cost"] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdsRateLimitedError);
    expect(err).toMatchObject({ retryAfterS: 12 });
  });
});

describe("a query that takes longer is followed until it's done", () => {
  it("queued, then running, then the rows from /query/status", async () => {
    let polls = 0;
    const f = fake((c) => {
      if (c.url.pathname === "/query/data/json") return json({ meta: { schedule_id: "sch_1", status_code: "QUEUED" }, data: [] });
      expect(c.url.pathname).toBe("/query/status");
      expect(c.url.searchParams.get("schedule_id")).toBe("sch_1");
      polls++;
      if (polls < 2) return json({ meta: { schedule_id: "sch_1", status_code: "RUNNING" }, data: [] });
      return answer(["Date", "cost"], [{ Date: "2026-10-01", cost: "4.5" }]);
    });
    const rows = await supermetricsQuery(cfg(f.fetchImpl), { dsId: "FA", cred, since: "2026-10-01", until: "2026-10-01", fields: ["Date", "cost"] }, { pollMs: 1 });
    expect(rows).toEqual([{ Date: "2026-10-01", cost: "4.5" }]);
    expect(polls).toBe(2);
  });

  it("a query that fails says why; one still running at the deadline is the caller's to word", async () => {
    const failed = fake(() => json({ meta: { schedule_id: "s", status_code: "FAILURE" }, error: { code: "QUERY_AUTH_EXPIRED" } }));
    await expect(supermetricsQuery(cfg(failed.fetchImpl), { dsId: "FA", cred, since: "2026-10-01", until: "2026-10-01", fields: ["cost"] })).rejects.toBeInstanceOf(AdsAuthError);
    const slow = fake(() => json({ meta: { schedule_id: "s", status_code: "RUNNING" }, data: [] }));
    await expect(
      supermetricsQuery(cfg(slow.fetchImpl), { dsId: "FA", cred, since: "2026-10-01", until: "2026-10-01", fields: ["cost"] }, { deadline: Date.now() + 2500, pollMs: 1, stillRunning: () => new AdsReportPendingError("still") }),
    ).rejects.toBeInstanceOf(AdsReportPendingError);
  });

  it("dates are checked before anything is sent", async () => {
    const f = fake(() => json({}));
    await expect(supermetricsQuery(cfg(f.fetchImpl), { dsId: "FA", cred, since: "2026-10-05", until: "2026-10-01", fields: ["cost"] })).rejects.toBeInstanceOf(AdsApiError);
    expect(f.calls).toHaveLength(0);
  });
});

describe("Meta Ads through Supermetrics is worked out like bizinsights' own Meta reading", () => {
  const meta = dataApi((fields) => {
    if (fields.includes("adcampaign_id")) {
      return [
        { Date: "2026-10-01", adcampaign_id: "111", adcampaign_name: "Prospecting", cost: 30.5, impressions: 1000, Clicks: 40, inline_link_clicks: 25, action_omni_purchase: 2, purchase_conversion_value: 180, "onsite_conversion.lead_grouped": 1, offsite_conversions_fb_pixel_lead: 2 },
        { Date: "2026-10-01", adcampaign_id: "222", adcampaign_name: "Retargeting", cost: 10, impressions: 300, Clicks: 9, inline_link_clicks: 6, action_omni_purchase: null, purchase_conversion_value: null },
      ];
    }
    // The account's own day: 5.00 more than its listed campaigns (a deleted campaign).
    return [{ Date: "2026-10-01", currency: "AUD", timezone_name: "Australia/Melbourne", account_status: "1", profile: "Shop AU", cost: 45.5, impressions: 1400, Clicks: 52, inline_link_clicks: 33, action_omni_purchase: 2, purchase_conversion_value: 180, "onsite_conversion.lead_grouped": 1, offsite_conversions_fb_pixel_lead: 2 }];
  });

  it("purchases are Meta's omni purchases; leads add lead-form and website leads; what campaigns leave out is one 'Other campaigns' row", async () => {
    const { rows, account } = await supermetricsMetaDays(cfg(meta.fetchImpl), cred, "2026-10-01", "2026-10-01");
    expect(account).toEqual({ status: "active", detail: null, name: "Shop AU", currency: "AUD", timezone: "Australia/Melbourne" });
    const prospecting = rows.find((r) => r.campaignId === "111")!;
    expect(prospecting).toMatchObject({ provider: "meta", accountId: "act_123456789", spend: 30.5, impressions: 1000, clicks: 40, linkClicks: 25, purchases: 2, purchaseValue: 180, conversions: 2, conversionValue: 180, leads: 3 });
    // A campaign without purchases has none, not a guess.
    expect(rows.find((r) => r.campaignId === "222")).toMatchObject({ purchases: 0, purchaseValue: 0, leads: 0 });
    const other = rows.find((r) => r.campaignId === "other")!;
    expect(other).toMatchObject({ spend: 5, impressions: 100, clicks: 3, linkClicks: 2 });
    // The stored days add up to Meta's account total.
    expect(rows.reduce((s, r) => s + r.spend, 0)).toBeCloseTo(45.5, 2);
  });

  it("Meta's account status comes as a code or a name", () => {
    expect(supermetricsMetaAccountStatus(1)).toBe("active");
    expect(supermetricsMetaAccountStatus("DISABLED")).toBe("disabled");
    expect(supermetricsMetaAccountStatus("Pending risk review")).toBe("under_review");
    expect(supermetricsMetaAccountStatus("101")).toBe("closed");
    expect(supermetricsMetaAccountStatus("nonsense")).toBeNull();
  });

  it("the report by campaign carries each campaign's status and settings; by country, ISO codes named; the totals count reach once", async () => {
    const f = dataApi((fields) => {
      if (fields.includes("adcampaign_id")) {
        return [
          { adcampaign_id: "111", adcampaign_name: "Prospecting", campaignstatus: "ACTIVE", campaignobjective: "OUTCOME_SALES", campaign_daily_budget: "50", cost: 300, impressions: 10000, reach: 6000, Frequency: 1.67, Clicks: 400, inline_link_clicks: 250, action_omni_purchase: 10, purchase_conversion_value: 900 },
          { adcampaign_id: "222", adcampaign_name: "Old", campaignstatus: "Paused", cost: 20, impressions: 900, reach: 800, Clicks: 10, inline_link_clicks: 5 },
        ];
      }
      if (fields.includes("Country")) return [{ Country: "au", cost: 320, impressions: 10900, Clicks: 410, inline_link_clicks: 255 }];
      return [{ cost: 320, impressions: 10900, reach: 6500, Frequency: 1.68, Clicks: 410, inline_link_clicks: 255, action_omni_purchase: 10, purchase_conversion_value: 900 }];
    });
    const report = await supermetricsMetaReport(cfg(f.fetchImpl), cred, "campaign", "2026-10-01", "2026-10-07");
    expect(report.totals).toMatchObject({ spend: 320, reach: 6500, frequency: 1.68, purchases: 10, purchaseValue: 900 });
    expect(report.rows[0]).toMatchObject({ id: "111", name: "Prospecting", status: "ACTIVE", spend: 300, purchases: 10, roas: 3, details: { objective: "OUTCOME_SALES", dailyBudget: 50 } });
    expect(report.rows[1]).toMatchObject({ id: "222", status: "PAUSED" });
    // Supermetrics only lists campaigns with activity: they aren't counted by state.
    expect(report.campaigns).toBeNull();
    const countries = await supermetricsMetaReport(cfg(f.fetchImpl), cred, "country", "2026-10-01", "2026-10-07");
    expect(countries.rows[0]).toMatchObject({ id: "AU", name: "Australia", spend: 320 });
  });
});

describe("Google Ads through Supermetrics", () => {
  it("cost comes in the account's currency, purchases are the PURCHASE category's conversions", async () => {
    const f = dataApi((fields) => {
      if (fields.includes("ConversionCategory")) {
        return [
          { Date: "2026-10-01", CampaignID: "9", ConversionCategory: "PURCHASE", Conversions: 3, ConversionValue: 240 },
          { Date: "2026-10-01", CampaignID: "9", ConversionCategory: "Submit lead form", Conversions: 5, ConversionValue: 0 },
        ];
      }
      return [{ Date: "2026-10-01", CampaignID: "9", Campaignname: "Search brand", profile: "Shop", Currencycode: "USD", Timezone: "America/New_York", Cost: "12.34", Impressions: 500, Clicks: 20, Conversions: 8, ConversionValue: 240 }];
    });
    const { rows, account } = await supermetricsGoogleDays(cfg(f.fetchImpl), { dsUser: "u", dsAccount: "123-456-7890" }, "2026-10-01", "2026-10-01");
    expect(account).toMatchObject({ name: "Shop", currency: "USD", timezone: "America/New_York" });
    expect(rows).toEqual([
      { provider: "google", accountId: "1234567890", campaignId: "9", campaignName: "Search brand", day: "2026-10-01", spend: 12.34, impressions: 500, clicks: 20, linkClicks: 20, conversions: 8, conversionValue: 240, purchases: 3, purchaseValue: 240, leads: 0 },
    ]);
  });

  it("the device report maps Supermetrics' device words; countries by their codes", async () => {
    const f = dataApi((fields) => {
      if (fields.includes("Device")) {
        return [
          { Device: "Mobile devices with full browsers", Cost: 10, Impressions: 100, Clicks: 5, Conversions: 1, ConversionValue: 50 },
          { Device: "Computers", Cost: 5, Impressions: 40, Clicks: 2, Conversions: 0, ConversionValue: 0 },
          { Device: "Tablets with full browsers", Cost: 1, Impressions: 10, Clicks: 1, Conversions: 0, ConversionValue: 0 },
        ];
      }
      if (fields.includes("CountryCode")) return [{ CountryCode: "NZ", Cost: 16, Impressions: 150, Clicks: 8, Conversions: 1, ConversionValue: 50 }];
      return [{ Cost: 16, Impressions: 150, Clicks: 8, Conversions: 1, ConversionValue: 50 }];
    });
    const devices = await supermetricsGoogleReport(cfg(f.fetchImpl), cred, "device", "2026-10-01", "2026-10-07");
    expect(devices.rows.map((r) => [r.id, r.name])).toEqual([
      ["MOBILE", "Phones"],
      ["DESKTOP", "Computers"],
      ["TABLET", "Tablets"],
    ]);
    expect(devices.totals).toMatchObject({ spend: 16, clicks: 8, conversions: 1, roas: 3.125 });
    const countries = await supermetricsGoogleReport(cfg(f.fetchImpl), cred, "country", "2026-10-01", "2026-10-07");
    expect(countries.rows[0]).toMatchObject({ id: "NZ", name: "New Zealand", spend: 16 });
  });
});

describe("AdSense through Supermetrics", () => {
  it("earnings in US dollars unless the account's own currency is known; sites in lower case", async () => {
    const f = dataApi((fields) => [{ date: "2026-10-01", domain_name: "Shop.Example.com", [fields[2]!]: 7.25, page_views: 1000, individual_ad_impressions: 3000, ad_clicks: 12 }]);
    const usd = await supermetricsAdsenseDays(cfg(f.fetchImpl), { dsUser: "u", dsAccount: "ca-pub-123" }, "2026-10-01", "2026-10-01", null);
    expect(f.calls[0]!.body!.fields).toContain("earnings_usd");
    expect(usd).toEqual({ currency: "USD", rows: [{ accountId: "pub-123", site: "shop.example.com", day: "2026-10-01", earnings: 7.25, pageViews: 1000, impressions: 3000, clicks: 12 }] });
    // Read in its own currency only when that was decided when it was connected, and bizinsights knows the currency.
    const own = await supermetricsAdsenseDays(cfg(f.fetchImpl), { dsUser: "u", dsAccount: "ca-pub-123", adsenseCurrency: "account" }, "2026-10-01", "2026-10-01", "AUD");
    expect(f.calls[1]!.body!.fields).toContain("earnings");
    expect(own.currency).toBe("AUD");
    const unknown = await supermetricsAdsenseDays(cfg(f.fetchImpl), { dsUser: "u", dsAccount: "ca-pub-123", adsenseCurrency: "account" }, "2026-10-01", "2026-10-01", null);
    expect(unknown.currency).toBe("USD");
  });

  it("the report keeps the store's sites only, whatever the cut", async () => {
    const f = dataApi(() => [
      { domain_name: "shop.example.com", country_code: "AU", country_name: "Australia", earnings_usd: 5, page_views: 100, individual_ad_impressions: 300, ad_clicks: 2 },
      { domain_name: "blog.other.com", country_code: "AU", country_name: "Australia", earnings_usd: 50, page_views: 900, individual_ad_impressions: 3000, ad_clicks: 20 },
    ]);
    const r = await supermetricsAdsenseReport(cfg(f.fetchImpl), cred, "country", "2026-10-01", "2026-10-07", ["shop.example.com"], null);
    expect(r.rows).toEqual([expect.objectContaining({ id: "AU", name: "Australia", earnings: 5, pageViews: 100 })]);
    expect(r.totals).toMatchObject({ earnings: 5, pageViews: 100, clicks: 2 });
    const every = await supermetricsAdsenseReport(cfg(f.fetchImpl), cred, "site", "2026-10-01", "2026-10-07", [], null);
    expect(every.rows.map((x) => x.id)).toEqual(["blog.other.com", "shop.example.com"]);
  });
});

describe("logins and their accounts", () => {
  it("accounts are listed across pages, ids written the way bizinsights writes them, Supermetrics' kept for queries", async () => {
    const f = fake((c) => {
      const offset = Number(c.url.searchParams.get("offset"));
      if (offset === 0) return json({ meta: { paginate: { offset: 0, limit: 1000, total: 1001 } }, data: [...Array.from({ length: 999 }, (_, i) => ({ account_id: String(1000 + i), name: `A${i}` })), { account_id: "act_77", name: "Main" }] });
      return json({ meta: { paginate: { offset: 1000, limit: 1000, total: 1001 } }, data: [{ account_id: "77", name: "Dup" }] });
    });
    const list = await supermetricsLoginAccounts(cfg(f.fetchImpl), "meta", "login_1");
    expect(list).toHaveLength(1000);
    expect(list.find((a) => a.accountId === "act_77")).toMatchObject({ name: "Main", sourceAccountId: "act_77" });
    expect(list[0]).toMatchObject({ accountId: "act_1000", sourceAccountId: "1000" });
    expect(f.calls.map((c) => c.url.pathname)).toEqual(["/ds/login/login_1/accounts", "/ds/login/login_1/accounts"]);
  });

  it("a login that reaches nothing has nothing to connect", async () => {
    const f = fake(() => json({ meta: { paginate: { total: 0 } }, data: [] }));
    await expect(supermetricsLoginAccounts(cfg(f.fetchImpl), "google", "l")).rejects.toBeInstanceOf(AdsNoAccountsError);
  });

  it("ids: Meta act_<digits>, Google Ads ten digits, AdSense pub-<digits>", () => {
    expect(supermetricsAccountId("meta", "123")).toBe("act_123");
    expect(supermetricsAccountId("meta", "act_123")).toBe("act_123");
    expect(supermetricsAccountId("google", "123-456-7890")).toBe("1234567890");
    expect(supermetricsAccountId("adsense", "ca-pub-088712")).toBe("pub-088712");
    expect(supermetricsAccountId("adsense", "pub-088712")).toBe("pub-088712");
  });

  it("a login is usable until revoked, or past its expiry unless Supermetrics renews it", () => {
    const now = new Date("2026-10-22T00:00:00Z");
    expect(supermetricsLoginUsable({ expiresAt: null, revokedAt: null, refreshable: false }, now)).toBe(true);
    expect(supermetricsLoginUsable({ expiresAt: new Date("2026-10-01"), revokedAt: null, refreshable: true }, now)).toBe(true);
    expect(supermetricsLoginUsable({ expiresAt: new Date("2026-10-01"), revokedAt: null, refreshable: false }, now)).toBe(false);
    expect(supermetricsLoginUsable({ expiresAt: null, revokedAt: new Date("2026-10-01"), refreshable: true }, now)).toBe(false);
  });

  it("health: a revoked login means reconnect; an account the login no longer lists means permission", async () => {
    const revoked = fake(() => json({ data: { login_id: "l", username: "u", revoked_time: "2026-10-01T00:00:00Z" } }));
    await expect(supermetricsAccountHealth(cfg(revoked.fetchImpl), "meta", "l", "123")).rejects.toBeInstanceOf(AdsAuthError);
    const gone = fake(() => json({ error: { code: "NOT_FOUND", message: "Login not found" } }, 404));
    await expect(supermetricsAccountHealth(cfg(gone.fetchImpl), "meta", "l", "123")).rejects.toBeInstanceOf(AdsAuthError);
    const lost = fake((c) => (c.url.pathname.endsWith("/accounts") ? json({ meta: { paginate: { total: 1 } }, data: [{ account_id: "999", name: "Other" }] }) : json({ data: { login_id: "l", username: "u" } })));
    await expect(supermetricsAccountHealth(cfg(lost.fetchImpl), "meta", "l", "123")).rejects.toBeInstanceOf(AdsPermissionError);
    const fine = fake((c) => (c.url.pathname.endsWith("/accounts") ? json({ meta: { paginate: { total: 1 } }, data: [{ account_id: "123", name: "Shop" }] }) : json({ data: { login_id: "l", username: "u" } })));
    await expect(supermetricsAccountHealth(cfg(fine.fetchImpl), "meta", "l", "123")).resolves.toMatchObject({ name: "Shop" });
  });

  it("the licence check: a LICENSE_ error means not licensed; an outage can't tell; a refused key is ours at once", async () => {
    expect(await supermetricsSourceLicensed(cfg(fake(() => json({ data: [] })).fetchImpl), "meta")).toBe("licensed");
    expect(await supermetricsSourceLicensed(cfg(fake(() => json({ error: { code: "LICENSE_ACCESS_DATA_SOURCE" } }, 403)).fetchImpl), "adsense")).toBe("not_licensed");
    expect(await supermetricsSourceLicensed(cfg(fake(() => json({}, 502)).fetchImpl), "google")).toBe("unknown");
    await expect(supermetricsSourceLicensed(cfg(fake(() => json({ error: { code: "API_KEY_INVALID" } }, 401)).fetchImpl), "google")).rejects.toMatchObject({ errorCode: "not_configured" });
  });
});

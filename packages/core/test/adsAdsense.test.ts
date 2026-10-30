import { describe, expect, it } from "vitest";
import {
  AdsApiError,
  AdsAuthError,
  adsenseAccountHealth,
  adsenseAccounts,
  adsenseReport,
  adsenseSiteDays,
  AdsNoAccountsError,
  AdsPermissionError,
  AdsRateLimitedError,
  classifyAdError,
  type FetchLike,
} from "../src/index.js";

/**
 * The AdSense Management API v2 client against answers shaped like Google's: errors as
 * google.rpc.Status with ErrorInfo / RetryInfo details (https://cloud.google.com/apis/design/errors),
 * accounts with state and pendingTasks (https://developers.google.com/adsense/management/reference/rest/v2/accounts),
 * and reports:generate with its filters (https://developers.google.com/adsense/management/reporting/filtering).
 */

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function fake(route: (url: URL, init: RequestInit | undefined) => Response | Promise<Response>) {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    return route(url, init);
  };
  return { fetchImpl, calls };
}

const adsense = (fetchImpl: FetchLike) => ({ clientId: "cid", clientSecret: "csec", fetchImpl });
const errorInfo = (reason: string, message: string, status = "PERMISSION_DENIED", code = 403) => ({
  error: { code, message, status, details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason, domain: "googleapis.com", metadata: { service: "adsense.googleapis.com" } }] },
});
const days = (f: { fetchImpl: FetchLike }) => adsenseSiteDays(adsense(f.fetchImpl), "AT", "pub-1", "2026-10-01", "2026-10-01");

describe("AdSense errors say what happened, not just 'it didn't work'", () => {
  it("the API switched off on bizinsights' project is ours to fix; a token without adsense.readonly asks for a reconnect", async () => {
    const off = fake(() => json(errorInfo("SERVICE_DISABLED", "AdSense Management API has not been used in project 123 before or it is disabled."), 403));
    const err = await days(off).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdsApiError);
    expect(err).toMatchObject({ errorCode: "not_configured" });
    expect(classifyAdError(err)).toMatchObject({ status: "error", code: "not_configured" });
    // The same without the ErrorInfo, from Google's wording alone.
    await expect(days(fake(() => json({ error: { code: 403, message: "AdSense Management API has not been used in project 123 before or it is disabled.", status: "PERMISSION_DENIED" } }, 403)))).rejects.toMatchObject({ errorCode: "not_configured" });
    const scope = await days(fake(() => json(errorInfo("ACCESS_TOKEN_SCOPE_INSUFFICIENT", "Request had insufficient authentication scopes."), 403))).catch((e: unknown) => e);
    expect(scope).toBeInstanceOf(AdsAuthError);
    expect(classifyAdError(scope)).toMatchObject({ status: "reconnect", code: "scope_missing" });
  });

  it("this login can no longer read the account: permission missing; a login with no AdSense account at all: nothing to connect", async () => {
    const lost = await days(fake(() => json({ error: { code: 403, message: "The caller does not have permission", status: "PERMISSION_DENIED" } }, 403))).catch((e: unknown) => e);
    expect(lost).toBeInstanceOf(AdsPermissionError);
    expect(classifyAdError(lost)).toMatchObject({ status: "permission", code: "no_access" });
    await expect(adsenseAccountHealth(adsense(fake(() => json({ error: { code: 403, message: "The caller does not have permission", status: "PERMISSION_DENIED" } }, 403)).fetchImpl), "AT", "pub-1")).rejects.toBeInstanceOf(AdsPermissionError);
    const none = await adsenseAccounts(adsense(fake(() => json({ error: { code: 403, message: "User does not have an AdSense account.", status: "PERMISSION_DENIED" } }, 403)).fetchImpl), "AT").catch((e: unknown) => e);
    expect(none).toBeInstanceOf(AdsNoAccountsError);
    expect(none).toMatchObject({ status: 403, reason: "no_ads_account" });
    // Ended access is still ended access.
    await expect(days(fake(() => json({ error: { code: 401, message: "Request had invalid authentication credentials.", status: "UNAUTHENTICATED" } }, 401)))).rejects.toMatchObject({ errorCode: "auth_expired" });
  });

  it("throttling waits as long as Google says", async () => {
    const busy = fake(() => json({ error: { code: 429, message: "Quota exceeded", status: "RESOURCE_EXHAUSTED", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "45s" }] } }, 429));
    const err = await days(busy).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdsRateLimitedError);
    expect(err).toMatchObject({ retryAfterS: 45, errorCode: "rate_limited" });
  });
});

describe("AdSense accounts and their state", () => {
  it("the picker and the daily check say when sign-up isn't finished or the account needs attention", async () => {
    const f = fake((u) => {
      if (u.pathname === "/v2/accounts") {
        return json({
          accounts: [
            { name: "accounts/pub-1", displayName: "Ready", state: "READY" },
            { name: "accounts/pub-2", displayName: "Half done", state: "READY", pendingTasks: ["phone-pin-verification", "billing-profile-creation"] },
            { name: "accounts/pub-3", displayName: "Attention", state: "NEEDS_ATTENTION" },
            { name: "accounts/pub-4", displayName: "Closed", state: "CLOSED" },
          ],
        });
      }
      expect(u.search).toBe("");
      if (u.pathname === "/v2/accounts/pub-4") return json({ name: "accounts/pub-4", displayName: "Closed", state: "CLOSED", timeZone: { id: "UTC" } });
      return json({ name: "accounts/pub-2", displayName: "Half done", state: "READY", pendingTasks: ["phone-pin-verification"], timeZone: { id: "Australia/Sydney" } });
    });
    expect((await adsenseAccounts(adsense(f.fetchImpl), "AT")).map((a) => [a.accountId, a.status, a.statusDetail])).toEqual([
      ["pub-1", "active", null],
      ["pub-2", "setup_unfinished", "Still to do in AdSense: phone pin verification, billing profile creation"],
      ["pub-3", "needs_attention", null],
    ]);
    expect(await adsenseAccountHealth(adsense(f.fetchImpl), "AT", "pub-2")).toEqual({ status: "setup_unfinished", detail: "Still to do in AdSense: phone pin verification", name: "Half done", currency: null, timezone: "Australia/Sydney" });
    // An account closed since it was connected says so on the daily check.
    expect(await adsenseAccountHealth(adsense(f.fetchImpl), "AT", "accounts/pub-4")).toMatchObject({ status: "closed" });
    await expect(adsenseAccountHealth(adsense(f.fetchImpl), "AT", "../pub-4")).rejects.toThrow("Invalid AdSense account");
  });

  it("a login with nothing left to connect is never an empty list: none at all, or only closed accounts, says which", async () => {
    const empty = await adsenseAccounts(adsense(fake(() => json({})).fetchImpl), "AT").catch((e: unknown) => e);
    expect(empty).toBeInstanceOf(AdsNoAccountsError);
    expect(empty).toMatchObject({ reason: "no_ads_account", diagnosis: { listed: 0, closed: 0 } });
    const closed = fake(() => json({ accounts: [{ name: "accounts/pub-4", displayName: "Old site", state: "CLOSED" }, { name: "accounts/pub-5", state: "CLOSED" }] }));
    const allClosed = await adsenseAccounts(adsense(closed.fetchImpl), "AT").catch((e: unknown) => e);
    expect(allClosed).toBeInstanceOf(AdsNoAccountsError);
    expect(allClosed).toMatchObject({ reason: "not_ready", diagnosis: { listed: 2, closed: 2 } });
  });
});

describe("the AdSense report", () => {
  /** As reports:generate answers: the dimensions asked, then the metrics in the order asked (ADSENSE_REPORT_METRICS). */
  const report = (level: "site" | "country" | "platform" | "ad_unit", totalMatchedRows?: string) => ({
    headers: [
      ...(level === "site"
        ? [{ name: "DOMAIN_CODE", type: "DIMENSION" }]
        : level === "country"
          ? [{ name: "COUNTRY_CODE", type: "DIMENSION" }, { name: "COUNTRY_NAME", type: "DIMENSION" }]
          : level === "platform"
            ? [{ name: "PLATFORM_TYPE_CODE", type: "DIMENSION" }, { name: "PLATFORM_TYPE_NAME", type: "DIMENSION" }]
            : [{ name: "AD_UNIT_ID", type: "DIMENSION" }, { name: "AD_UNIT_NAME", type: "DIMENSION" }]),
      { name: "ESTIMATED_EARNINGS", type: "METRIC_CURRENCY", currencyCode: "AUD" },
      { name: "PAGE_VIEWS", type: "METRIC_TALLY" },
      { name: "IMPRESSIONS", type: "METRIC_TALLY" },
      { name: "CLICKS", type: "METRIC_TALLY" },
      { name: "AD_REQUESTS", type: "METRIC_TALLY" },
      { name: "AD_REQUESTS_COVERAGE", type: "METRIC_RATIO" },
      { name: "ACTIVE_VIEW_VIEWABILITY", type: "METRIC_RATIO" },
    ],
    rows:
      level === "site"
        ? [{ cells: [{ value: "shop.example.com" }, { value: "4.20" }, { value: "900" }, { value: "1200" }, { value: "3" }, { value: "1500" }, { value: "0.8" }, { value: "0.55" }] }]
        : level === "country"
          ? [{ cells: [{ value: "AU" }, { value: "Australia" }, { value: "2" }, { value: "100" }, { value: "150" }, { value: "1" }, { value: "200" }, { value: "0.75" }, { value: "0.6" }] }]
          : level === "platform"
            ? [{ cells: [{ value: "HighEndMobile" }, { value: "High-end mobile devices" }, { value: "1" }, { value: "50" }, { value: "70" }, { value: "0" }, { value: "90" }, { value: "0.78" }, { value: "0.7" }] }]
            : [{ cells: [{ value: "ca-pub-1:4455" }, { value: "Article footer" }, { value: "3.30" }, { value: "700" }, { value: "640" }, { value: "2" }, { value: "800" }, { value: "0.8" }, { value: "0.66" }] }],
    ...(totalMatchedRows ? { totalMatchedRows } : {}),
  });

  it("limits the report to the store's sites with AdSense's filter syntax, biggest earners first", async () => {
    const f = fake((u) => json(report(u.searchParams.getAll("dimensions").includes("DOMAIN_CODE") ? "site" : u.searchParams.getAll("dimensions").includes("COUNTRY_CODE") ? "country" : "platform")));
    const r = await adsenseReport(adsense(f.fetchImpl), "AT", "pub-1", "site", "2026-10-01", "2026-10-07", ["shop.example.com", "www.shop.example.com"]);
    expect(r).toMatchObject({ currency: "AUD", truncated: false, rows: [{ id: "shop.example.com", earnings: 4.2, pageViews: 900, impressions: 1200, clicks: 3, adRequests: 1500, coverage: 0.8, viewability: 0.55 }] });
    const q = f.calls[0]!.url.searchParams;
    // One filters parameter, a comma for OR (several filters parameters would mean AND).
    expect(q.getAll("filters")).toEqual(["DOMAIN_CODE==shop.example.com,DOMAIN_CODE==www.shop.example.com"]);
    expect(f.calls[0]!.url.search).toContain("filters=DOMAIN_CODE%3D%3Dshop.example.com%2CDOMAIN_CODE%3D%3Dwww.shop.example.com");
    expect(q.getAll("orderBy")).toEqual(["-ESTIMATED_EARNINGS"]);
    expect(q.get("reportingTimeZone")).toBe("ACCOUNT_TIME_ZONE");
    expect(q.getAll("dimensions")).toEqual(["DOMAIN_CODE"]);
    expect(q.has("dimensions") && !q.getAll("dimensions").includes("DATE")).toBe(true);
    // Country and device type, with AdSense's own names.
    expect((await adsenseReport(adsense(f.fetchImpl), "AT", "pub-1", "country", "2026-10-01", "2026-10-07")).rows[0]).toMatchObject({ id: "AU", name: "Australia", earnings: 2 });
    expect((await adsenseReport(adsense(f.fetchImpl), "AT", "pub-1", "platform", "2026-10-01", "2026-10-07")).rows[0]).toMatchObject({ id: "HighEndMobile", name: "High-end mobile devices" });
    // No sites: every site of the account, unfiltered.
    expect(f.calls[1]!.url.searchParams.has("filters")).toBe(false);
  });

  it("splits by ad unit, by AdSense's id and name, with ad requests, coverage and viewability asked for every level", async () => {
    const f = fake((u) => json(report(u.searchParams.getAll("dimensions").includes("AD_UNIT_ID") ? "ad_unit" : "site")));
    const r = await adsenseReport(adsense(f.fetchImpl), "AT", "pub-1", "ad_unit", "2026-10-01", "2026-10-07", ["shop.example.com"]);
    expect(r.rows).toEqual([
      { id: "ca-pub-1:4455", name: "Article footer", earnings: 3.3, pageViews: 700, impressions: 640, clicks: 2, pageRpm: 4.71, perClick: 1.65, ctr: 2 / 640, adRequests: 800, coverage: 0.8, viewability: 0.66 },
    ]);
    const q = f.calls[0]!.url.searchParams;
    expect(q.getAll("dimensions")).toEqual(["AD_UNIT_ID", "AD_UNIT_NAME"]);
    // The metric names of AdSense Management API v2 (reference/rest/v2/Metric), the same for every level.
    expect(q.getAll("metrics")).toEqual(["ESTIMATED_EARNINGS", "PAGE_VIEWS", "IMPRESSIONS", "CLICKS", "AD_REQUESTS", "AD_REQUESTS_COVERAGE", "ACTIVE_VIEW_VIEWABILITY"]);
    // An ad unit's earnings on the store's sites only, as every other level.
    expect(q.getAll("filters")).toEqual(["DOMAIN_CODE==shop.example.com"]);
    await adsenseReport(adsense(f.fetchImpl), "AT", "pub-1", "site", "2026-10-01", "2026-10-07");
    expect(f.calls[1]!.url.searchParams.getAll("metrics")).toEqual(q.getAll("metrics"));
  });

  it("a level AdSense won't give ad requests, coverage or viewability for is read again without them: those unknown, never 0", async () => {
    const f = fake((u) => {
      if (u.searchParams.getAll("metrics").includes("AD_REQUESTS")) return json({ error: { code: 400, message: "Invalid metric/dimension combination.", status: "INVALID_ARGUMENT" } }, 400);
      // As AdSense answers the stored days' measures alone: their columns only.
      const r = report("country");
      return json({ ...r, headers: r.headers.slice(0, 6), rows: r.rows.map((x) => ({ cells: x.cells.slice(0, 6) })) });
    });
    const r = await adsenseReport(adsense(f.fetchImpl), "AT", "pub-1", "country", "2026-10-01", "2026-10-07", ["shop.example.com"]);
    expect(r.rows).toEqual([{ id: "AU", name: "Australia", earnings: 2, pageViews: 100, impressions: 150, clicks: 1, pageRpm: 20, perClick: 2, ctr: 1 / 150, adRequests: null, coverage: null, viewability: null }]);
    expect(r.totals).toMatchObject({ earnings: 2, adRequests: null, coverage: null, viewability: null });
    expect(f.calls.map((x) => x.url.searchParams.getAll("metrics"))).toEqual([
      ["ESTIMATED_EARNINGS", "PAGE_VIEWS", "IMPRESSIONS", "CLICKS", "AD_REQUESTS", "AD_REQUESTS_COVERAGE", "ACTIVE_VIEW_VIEWABILITY"],
      ["ESTIMATED_EARNINGS", "PAGE_VIEWS", "IMPRESSIONS", "CLICKS"],
    ]);
    // The second asks the same of AdSense otherwise: the level, the dates, the store's sites.
    expect(f.calls[1]!.url.searchParams.getAll("dimensions")).toEqual(["COUNTRY_CODE", "COUNTRY_NAME"]);
    expect(f.calls[1]!.url.searchParams.getAll("filters")).toEqual(["DOMAIN_CODE==shop.example.com"]);
    // Anything else AdSense refuses isn't asked twice.
    const lost = fake(() => json({ error: { code: 403, message: "The caller does not have permission", status: "PERMISSION_DENIED" } }, 403));
    await expect(adsenseReport(adsense(lost.fetchImpl), "AT", "pub-1", "country", "2026-10-01", "2026-10-07")).rejects.toBeInstanceOf(AdsPermissionError);
    expect(lost.calls).toHaveLength(1);
  });

  it("a store whose sites AdSense can't match gets nothing, never every site's earnings; a cut-off report says so", async () => {
    const f = fake(() => json(report("site", "1500")));
    expect(await adsenseReport(adsense(f.fetchImpl), "AT", "pub-1", "site", "2026-10-01", "2026-10-07", ["bad,host", "a\\b"])).toEqual({
      rows: [],
      currency: null,
      truncated: false,
      totals: { earnings: 0, pageViews: 0, impressions: 0, clicks: 0, pageRpm: null, perClick: null, ctr: null, adRequests: null, coverage: null, viewability: null },
    });
    expect(f.calls).toHaveLength(0);
    expect((await adsenseReport(adsense(f.fetchImpl), "AT", "pub-1", "site", "2026-10-01", "2026-10-07", ["bad,host", "shop.example.com"])).truncated).toBe(true);
    expect(f.calls[0]!.url.searchParams.getAll("filters")).toEqual(["DOMAIN_CODE==shop.example.com"]);
    await expect(adsenseReport(adsense(f.fetchImpl), "AT", "pub-1", "site", "2026-10-01' OR 1=1", "2026-10-07")).rejects.toThrow("Invalid date range");
  });

  it("the totals are AdSense's own (the rows a cut-off report leaves out included), else the rows added up", async () => {
    // Its totals row: as long as the others, the dimension's cell empty.
    const cut = fake(() =>
      json({ ...report("site", "1500"), totals: { cells: [{}, { value: "250.40" }, { value: "90000" }, { value: "120000" }, { value: "300" }, { value: "150000" }, { value: "0.8" }, { value: "0.61" }] } }),
    );
    const r = await adsenseReport(adsense(cut.fetchImpl), "AT", "pub-1", "site", "2026-10-01", "2026-10-07");
    expect(r.truncated).toBe(true);
    // Its ratios too are AdSense's, over every matched row.
    expect(r.totals).toEqual({ earnings: 250.4, pageViews: 90000, impressions: 120000, clicks: 300, pageRpm: 2.78, perClick: 0.83, ctr: 300 / 120000, adRequests: 150000, coverage: 0.8, viewability: 0.61 });
    // No totals row: the rows read.
    const plain = await adsenseReport(adsense(fake(() => json(report("site"))).fetchImpl), "AT", "pub-1", "site", "2026-10-01", "2026-10-07");
    expect(plain.totals).toMatchObject({ earnings: 4.2, pageViews: 900, impressions: 1200, clicks: 3, adRequests: 1500, coverage: 0.8, viewability: 0.55 });
  });
});

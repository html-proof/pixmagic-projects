import { describe, expect, it } from "vitest";
import { pkceChallenge, pkcePair } from "@app/shared";
import {
  adsenseAuthorizeUrl,
  AdsAuthError,
  AdsNoAccountsError,
  AdsNotApprovedError,
  googleAdAccounts,
  AdsRetryableError,
  googleAuthorizeUrl,
  googleExchangeCode,
  googleRefresh,
  googleReport,
  googleRevoke,
  googleUserId,
  metaAdAccounts,
  metaCampaignDays,
  metaExchangeCode,
  metaReport,
  metaRevokeAdsRead,
  metaUserId,
  type FetchLike,
} from "../src/index.js";

/**
 * The connection lifecycle around the ad platforms' sign-ins (PKCE, refresh-token rotation, who
 * signed in, revocation, Meta's report jobs) and the live reports (Google Ads by campaign, ad
 * group, device and country; Meta split by placement, device and country).
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

const meta = (fetchImpl: FetchLike) => ({ appId: "app1", appSecret: "sec", version: "v25.0", fetchImpl });
const google = (fetchImpl: FetchLike) => ({ clientId: "cid", clientSecret: "csec", version: "v25", fetchImpl });
const queryOf = (init: RequestInit | undefined) => (JSON.parse(String(init?.body)) as { query: string }).query;

describe("sign-in security and lifecycle", () => {
  it("Google: the PKCE challenge goes in the URL, the verifier only in the code exchange", async () => {
    const { verifier, challenge } = pkcePair();
    expect(pkceChallenge(verifier)).toBe(challenge);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    const url = new URL(googleAuthorizeUrl(google(fetch), "https://app/cb", "st", challenge));
    expect(url.searchParams.get("code_challenge")).toBe(challenge);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.toString()).not.toContain(verifier);
    expect(new URL(adsenseAuthorizeUrl({ clientId: "cid", clientSecret: "csec" }, "https://app/cb", "st", challenge)).searchParams.get("code_challenge")).toBe(challenge);

    const f = fake(async () => json({ access_token: "AT", refresh_token: "RT", expires_in: 3599, scope: "https://www.googleapis.com/auth/adwords" }));
    await googleExchangeCode(google(f.fetchImpl), "CODE", "https://app/cb", verifier);
    const form = new URLSearchParams(String(f.calls[0]!.init?.body));
    expect(form.get("code_verifier")).toBe(verifier);
    expect(form.get("client_secret")).toBe("csec");
  });

  it("Google: a refresh token Google replaces comes back marked as rotated", async () => {
    const f = fake(async () => json({ access_token: "AT2", refresh_token: "RT2", expires_in: 3599 }));
    expect(await googleRefresh(google(f.fetchImpl), "RT")).toMatchObject({ accessToken: "AT2", refreshToken: "RT2", rotated: true });
    const same = fake(async () => json({ access_token: "AT3", expires_in: 3599 }));
    expect(await googleRefresh(google(same.fetchImpl), "RT")).toMatchObject({ refreshToken: "RT", rotated: false });
  });

  it("Google: who signed in, only for a token issued to our client; revoking treats a dead token as done", async () => {
    const f = fake((u) => (u.searchParams.get("access_token") === "OURS" ? json({ aud: "cid", sub: "10987654321", scope: "x" }) : json({ aud: "someone-else", sub: "1" })));
    expect(await googleUserId(google(f.fetchImpl), "OURS")).toBe("10987654321");
    await expect(googleUserId(google(f.fetchImpl), "THEIRS")).rejects.toBeInstanceOf(AdsAuthError);
    const noSub = fake(() => json({ aud: "cid", scope: "x" }));
    expect(await googleUserId(google(noSub.fetchImpl), "OURS")).toBeNull();

    const revoke = fake(async (u, init) => {
      expect(u.toString()).toBe("https://oauth2.googleapis.com/revoke");
      expect(new URLSearchParams(String(init?.body)).get("token")).toBe("RT");
      return new Response("{}", { status: 200 });
    });
    await googleRevoke({ fetchImpl: revoke.fetchImpl }, "RT");
    expect(revoke.calls).toHaveLength(1);
    const dead = fake(() => json({ error: "invalid_token", error_description: "Token expired or revoked" }, 400));
    await expect(googleRevoke({ fetchImpl: dead.fetchImpl }, "OLD")).resolves.toBeUndefined();
    const down = fake(() => json({ error: "backend_error" }, 503));
    await expect(googleRevoke({ fetchImpl: down.fetchImpl }, "RT")).rejects.toBeInstanceOf(AdsRetryableError);
  });

  it("Meta: a system-user token (no expiry) is kept as it is; revoking drops ads_read only, with the token in the body", async () => {
    const f = fake(() => json({ access_token: "SYSTEM_USER" }));
    expect(await metaExchangeCode(meta(f.fetchImpl), "CODE", "https://app/cb")).toEqual({ accessToken: "SYSTEM_USER", refreshToken: null, expiresAt: null });
    expect(f.calls).toHaveLength(1);

    const me = fake(() => json({ id: "1234567890" }));
    expect(await metaUserId(meta(me.fetchImpl), "T")).toBe("1234567890");

    const del = fake(async (u, init) => {
      expect(init?.method).toBe("DELETE");
      expect(u.pathname).toBe("/v25.0/me/permissions/ads_read");
      expect(u.search).toBe("");
      expect(new URLSearchParams(String(init?.body)).get("access_token")).toBe("T");
      return json({ success: true });
    });
    await metaRevokeAdsRead(meta(del.fetchImpl), "T");
    expect(del.calls).toHaveLength(1);
    const expired = fake(() => json({ error: { message: "Session has expired", code: 190 } }, 400));
    await expect(metaRevokeAdsRead(meta(expired.fetchImpl), "T")).resolves.toBeUndefined();
  });

  it("Meta: a range too big for one answer runs as a report job", async () => {
    const f = fake(async (u, init) => {
      if (init?.method === "POST") {
        expect(u.pathname).toBe("/v25.0/act_1/insights");
        const form = new URLSearchParams(String(init.body));
        expect(form.get("time_increment")).toBe("1");
        expect(form.get("access_token")).toBe("T");
        expect(form.has("limit")).toBe(false);
        return json({ report_run_id: "777" });
      }
      if (u.pathname === "/v25.0/act_1/insights") return json({ error: { message: "Please reduce the amount of data you're asking for, then retry your request", code: 1 } }, 500);
      if (u.pathname === "/v25.0/777") return json({ async_status: "Job Completed", async_percent_completion: 100 });
      if (u.pathname === "/v25.0/777/insights") return json({ data: [{ campaign_id: "9", campaign_name: "Big", date_start: "2026-08-01", spend: "3" }] });
      return json({ error: { message: `unexpected ${u.pathname}` } }, 400);
    });
    const rows = await metaCampaignDays(meta(f.fetchImpl), "T", "1", "2026-07-01", "2026-10-01", { pollMs: 0 });
    expect(rows).toEqual([expect.objectContaining({ campaignId: "9", campaignName: "Big", day: "2026-08-01", spend: 3 })]);

    const failed = fake(async (u, init) => {
      if (init?.method === "POST") return json({ report_run_id: "778" });
      if (u.pathname === "/v25.0/778") return json({ async_status: "Job Failed" });
      return json({ error: { message: "reduce the amount of data", code: 1 } }, 500);
    });
    await expect(metaCampaignDays(meta(failed.fetchImpl), "T", "1", "2026-07-01", "2026-10-01", { pollMs: 0 })).rejects.toBeInstanceOf(AdsRetryableError);
    // A plain rate limit is retried by the queue, not turned into a job.
    const limited = fake(() => json({ error: { message: "User request limit reached", code: 17 } }, 400));
    await expect(metaCampaignDays(meta(limited.fetchImpl), "T", "1", "2026-07-01", "2026-10-01", { pollMs: 0 })).rejects.toBeInstanceOf(AdsRetryableError);
    expect(limited.calls.every((c) => c.init?.method !== "POST")).toBe(true);
  });
});

describe("Google Ads access level", () => {
  it("a project with Test access only is told apart from an account that can't be read, and never sends a developer token", async () => {
    const notApproved = {
      error: {
        code: 403,
        message: "The caller does not have permission",
        status: "PERMISSION_DENIED",
        details: [{ "@type": "type.googleapis.com/google.ads.googleads.v25.errors.GoogleAdsFailure", errors: [{ errorCode: { authorizationError: "CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION" }, message: "Project not approved" }] }],
      },
    };
    const f = fake(async (u, init) => {
      expect(new Headers(init?.headers).get("developer-token")).toBeNull();
      if (u.pathname.endsWith("customers:listAccessibleCustomers")) return json({ resourceNames: ["customers/111"] });
      return json([notApproved], 403);
    });
    await expect(googleAdAccounts(google(f.fetchImpl), "AT")).rejects.toBeInstanceOf(AdsNotApprovedError);
    // A cancelled account is still just skipped; when it's the only one, the person is told why nothing connects.
    const cancelled = fake(async (u) =>
      u.pathname.endsWith("customers:listAccessibleCustomers")
        ? json({ resourceNames: ["customers/111"] })
        : json([{ error: { message: "The customer account can't be accessed because it is not yet enabled or has been deactivated.", status: "PERMISSION_DENIED" } }], 403),
    );
    await expect(googleAdAccounts(google(cancelled.fetchImpl), "AT")).rejects.toMatchObject({ reason: "not_ready" });
  });
});

describe("a Google login with nothing to connect says why", () => {
  it("no Google Ads account at all: NOT_ADS_USER, or an empty list", async () => {
    const notAdsUser = fake(async () =>
      json({ error: { code: 401, message: "The user's Google Account isn't associated with any Google Ads accounts.", status: "UNAUTHENTICATED", details: [{ errors: [{ errorCode: { authenticationError: "NOT_ADS_USER" } }] }] } }, 401),
    );
    const err = await googleAdAccounts(google(notAdsUser.fetchImpl), "AT").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdsNoAccountsError);
    expect(err).toMatchObject({ reason: "no_ads_account" });
    const empty = fake(async () => json({}));
    await expect(googleAdAccounts(google(empty.fetchImpl), "AT")).rejects.toMatchObject({ reason: "no_ads_account" });
  });

  it("a manager account with no active ad account under it", async () => {
    const f = fake(async (u, init) => {
      if (u.pathname.endsWith("customers:listAccessibleCustomers")) return json({ resourceNames: ["customers/222"] });
      if (queryOf(init).endsWith("FROM customer")) return json([{ results: [{ customer: { id: "222", descriptiveName: "My manager", manager: true } }] }]);
      return json([{ results: [] }]);
    });
    await expect(googleAdAccounts(google(f.fetchImpl), "AT")).rejects.toMatchObject({ reason: "manager_only" });
  });

  it("Google's account chooser is shown every time, so another login can be picked", () => {
    const url = new URL(googleAuthorizeUrl(google(fetch), "https://app/cb", "st"));
    expect(url.searchParams.get("prompt")?.split(" ").sort()).toEqual(["consent", "select_account"]);
  });
});

describe("a Meta login with nothing to connect says why", () => {
  /** Meta answering an empty account list, and its token inspector answering `debug`. */
  const emptyMeta = (debug: () => Response) =>
    fake((u) => {
      if (u.pathname.endsWith("/me/adaccounts")) return json({ data: [] });
      if (u.pathname.endsWith("/debug_token")) return debug();
      return json({ error: { message: "unexpected" } }, 400);
    });

  it("a login that reaches no ad account: ads_read covers everything it can reach, which is nothing", async () => {
    const f = emptyMeta(() => json({ data: { is_valid: true, scopes: ["ads_read"], granular_scopes: [{ scope: "ads_read" }] } }));
    const err = await metaAdAccounts(meta(f.fetchImpl), "USER_T").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdsNoAccountsError);
    expect(err).toMatchObject({ reason: "no_ads_account" });
    // Meta's inspector is asked with the app's own token about the person's.
    const inspect = f.calls.find((c) => c.url.pathname.endsWith("/debug_token"))!.url.searchParams;
    expect(inspect.get("input_token")).toBe("USER_T");
    expect(inspect.get("access_token")).toBe("app1|sec");
  });

  it("the person picked accounts on Facebook's screen and none came through", async () => {
    const none = emptyMeta(() => json({ data: { granular_scopes: [{ scope: "ads_read", target_ids: [] }] } }));
    await expect(metaAdAccounts(meta(none.fetchImpl), "T")).rejects.toMatchObject({ reason: "none_shared" });
    const unreadable = emptyMeta(() => json({ data: { granular_scopes: [{ scope: "ads_read", target_ids: ["act_9"] }] } }));
    await expect(metaAdAccounts(meta(unreadable.fetchImpl), "T")).rejects.toMatchObject({ reason: "none_shared", message: expect.stringContaining("act_9") });
  });

  it("the inspector failing still says 'no ad account', never 'try again'", async () => {
    const f = emptyMeta(() => json({ error: { message: "Invalid OAuth access token", code: 190 } }, 400));
    await expect(metaAdAccounts(meta(f.fetchImpl), "T")).rejects.toMatchObject({ reason: "no_ads_account" });
  });
});

describe("live reports", () => {
  it("Google: campaigns with status, type and budget, and account totals; dates are checked before they reach the query", async () => {
    const queries: string[] = [];
    const f = fake(async (_u, init) => {
      const query = queryOf(init);
      queries.push(query);
      if (query.startsWith("SELECT metrics.")) return json([{ results: [{ metrics: { costMicros: "12500000", impressions: "1000", clicks: "50", conversions: 2, conversionsValue: 100 } }] }]);
      return json([
        {
          results: [
            { campaign: { id: "1", name: "Brand", status: "ENABLED", advertisingChannelType: "SEARCH" }, campaignBudget: { amountMicros: "20000000" }, metrics: { costMicros: "2500000", impressions: "200", clicks: "10", conversions: 0, conversionsValue: 0 } },
            { campaign: { id: "2", name: "PMax", status: "PAUSED", advertisingChannelType: "PERFORMANCE_MAX" }, campaignBudget: { amountMicros: "50000000" }, metrics: { costMicros: "10000000", impressions: "800", clicks: "40", conversions: 2, conversionsValue: 100 } },
          ],
        },
      ]);
    });
    const r = await googleReport(google(f.fetchImpl), "AT", { accountId: "111" }, "campaign", "2026-10-01", "2026-10-07");
    expect(r.totals).toMatchObject({ spend: 12.5, impressions: 1000, clicks: 50, ctr: 0.05, cpc: 0.25, cpm: 12.5, conversions: 2, costPerConversion: 6.25, roas: 8 });
    expect(r.rows.map((x) => [x.name, x.status, x.channel, x.dailyBudget, x.spend])).toEqual([
      ["PMax", "PAUSED", "PERFORMANCE_MAX", 50, 10],
      ["Brand", "ENABLED", "SEARCH", 20, 2.5],
    ]);
    expect(r.rows[1]!.costPerConversion).toBeNull();
    expect(queries.every((q) => q.includes("segments.date BETWEEN '2026-10-01' AND '2026-10-07'"))).toBe(true);
    await expect(googleReport(google(f.fetchImpl), "AT", { accountId: "111" }, "campaign", "2026-10-01' OR 1=1", "2026-10-07")).rejects.toThrow("Invalid date range");
  });

  it("Google: countries are grouped across targeting rows and named; devices are summed across campaigns; ad groups name their campaign", async () => {
    const f = fake(async (_u, init) => {
      const query = queryOf(init);
      if (query.includes("FROM geo_target_constant")) {
        expect(query).toContain("'geoTargetConstants/2840'");
        return json([{ results: [{ geoTargetConstant: { id: "2840", countryCode: "US" } }, { geoTargetConstant: { id: "2036", countryCode: "AU" } }] }]);
      }
      if (query.includes("FROM user_location_view")) {
        return json([
          {
            results: [
              { userLocationView: { countryCriterionId: "2840" }, metrics: { costMicros: "1000000", impressions: "10", clicks: "1" } },
              { userLocationView: { countryCriterionId: "2840" }, metrics: { costMicros: "2000000", impressions: "20", clicks: "2" } },
              { userLocationView: { countryCriterionId: "2036" }, metrics: { costMicros: "500000", impressions: "5", clicks: "0" } },
            ],
          },
        ]);
      }
      if (query.includes("segments.device")) {
        return json([{ results: [{ segments: { device: "MOBILE" }, metrics: { costMicros: "1000000" } }, { segments: { device: "MOBILE" }, metrics: { costMicros: "1000000" } }, { segments: { device: "DESKTOP" }, metrics: { costMicros: "500000" } }] }]);
      }
      if (query.includes("FROM ad_group")) {
        return json([{ results: [{ campaign: { name: "Brand" }, adGroup: { id: "55", name: "Shoes", status: "ENABLED" }, metrics: { costMicros: "4000000" } }] }]);
      }
      return json([{ results: [] }]);
    });
    const c = await googleReport(google(f.fetchImpl), "AT", { accountId: "111", loginCustomerId: "222" }, "country", "2026-10-01", "2026-10-01");
    expect(c.rows.map((x) => [x.name, x.spend, x.clicks])).toEqual([
      ["United States", 3, 3],
      ["Australia", 0.5, 0],
    ]);
    expect(new Headers(f.calls[0]!.init?.headers).get("login-customer-id")).toBe("222");
    const d = await googleReport(google(f.fetchImpl), "AT", { accountId: "111" }, "device", "2026-10-01", "2026-10-01");
    expect(d.rows.map((x) => [x.name, x.spend])).toEqual([
      ["Phones", 2],
      ["Computers", 0.5],
    ]);
    // No account totals row came back: nothing ran, so the totals are zero.
    expect(d.totals.spend).toBe(0);
    const g = await googleReport(google(f.fetchImpl), "AT", { accountId: "111" }, "ad_group", "2026-10-01", "2026-10-01");
    expect(g.rows[0]).toMatchObject({ id: "55", name: "Shoes", campaignName: "Brand", status: "ENABLED", spend: 4 });
  });

  it("Meta: the whole account split by placement, device and country", async () => {
    const f = fake((u) => {
      if (u.searchParams.get("breakdowns") === "publisher_platform,platform_position") {
        expect(u.searchParams.get("level")).toBe("account");
        return json({
          data: [
            { publisher_platform: "instagram", platform_position: "instagram_stories", spend: "4", impressions: "100", reach: "80" },
            { publisher_platform: "facebook", platform_position: "feed", spend: "6", impressions: "200", reach: "150" },
          ],
        });
      }
      if (u.searchParams.get("breakdowns") === "impression_device") return json({ data: [{ impression_device: "android_smartphone", spend: "1" }] });
      if (u.searchParams.get("breakdowns") === "country") return json({ data: [{ country: "GB", spend: "2" }] });
      return json({ data: [{ spend: "10", impressions: "300", reach: "200" }] });
    });
    const p = await metaReport(meta(f.fetchImpl), "T", "1", "placement", "2026-10-01", "2026-10-07");
    expect(p.rows.map((r) => [r.name, r.spend, r.status])).toEqual([
      ["Facebook · Feed", 6, null],
      ["Instagram · Stories", 4, null],
    ]);
    expect(p.totals.reach).toBe(200);
    // No status lookup for a split: its rows aren't campaigns, ad sets or ads.
    expect(f.calls.some((c) => c.url.searchParams.has("ids"))).toBe(false);
    expect((await metaReport(meta(f.fetchImpl), "T", "1", "device", "2026-10-01", "2026-10-07")).rows[0]!.name).toBe("Android phones");
    expect((await metaReport(meta(f.fetchImpl), "T", "1", "country", "2026-10-01", "2026-10-07")).rows[0]!.name).toBe("United Kingdom");
  });
});

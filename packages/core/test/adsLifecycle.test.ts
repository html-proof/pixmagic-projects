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

  it("Meta: a system-user token (no expiry) is kept as it is; revoking drops ads_read only, with the token in the header", async () => {
    const f = fake(() => json({ access_token: "SYSTEM_USER" }));
    expect(await metaExchangeCode(meta(f.fetchImpl), "CODE", "https://app/cb")).toEqual({ accessToken: "SYSTEM_USER", refreshToken: null, expiresAt: null });
    expect(f.calls).toHaveLength(1);

    const me = fake(() => json({ id: "1234567890" }));
    expect(await metaUserId(meta(me.fetchImpl), "T")).toBe("1234567890");

    const del = fake(async (u, init) => {
      expect(init?.method).toBe("DELETE");
      expect(u.pathname).toBe("/v25.0/me/permissions/ads_read");
      // Only the token's proof, never the token itself.
      expect([...u.searchParams.keys()]).toEqual(["appsecret_proof"]);
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer T");
      expect(String(init?.body ?? "")).toBe("");
      return json({ success: true });
    });
    expect(await metaRevokeAdsRead(meta(del.fetchImpl), "T")).toBe("revoked");
    expect(del.calls).toHaveLength(1);
  });

  it("Meta: a token that stopped working doesn't end the grant: bizinsights' app token takes ads_read back for the person", async () => {
    const userTokenDead = (appToken: (u: URL, init?: RequestInit) => Response) =>
      fake((u, init) => {
        const auth = new Headers(init?.headers).get("authorization");
        if (auth === "Bearer T") return json({ error: { message: "Error validating access token: Session has expired", code: 190, error_subcode: 463 } }, 400);
        expect(auth).toBe("Bearer app1|sec");
        // The app token holds the secret itself: no proof goes with it.
        expect(u.searchParams.has("appsecret_proof")).toBe(false);
        return appToken(u, init);
      });
    const ok = userTokenDead((u, init) => {
      expect(init?.method).toBe("DELETE");
      expect(u.pathname).toBe("/v25.0/5550001/permissions/ads_read");
      return json({ success: true });
    });
    expect(await metaRevokeAdsRead(meta(ok.fetchImpl), "T", "5550001")).toBe("revoked");
    expect(ok.calls).toHaveLength(2);

    // Meta refuses, and lists the person's grants without ads_read: there was nothing left to take back.
    const gone = userTokenDead((u, init) =>
      init?.method === "DELETE" ? json({ error: { message: "(#100) Invalid parameter", code: 100 } }, 400) : json({ data: [{ permission: "whatsapp_business_messaging", status: "granted" }, { permission: "ads_read", status: "declined" }] }),
    );
    expect(await metaRevokeAdsRead(meta(gone.fetchImpl), "T", "5550001")).toBe("not_granted");
    // Meta refuses and ads_read is still granted: not revoked, and said so.
    const still = userTokenDead((_u, init) => (init?.method === "DELETE" ? json({ error: { message: "(#100) Invalid parameter", code: 100 } }, 400) : json({ data: [{ permission: "ads_read", status: "granted" }] })));
    await expect(metaRevokeAdsRead(meta(still.fetchImpl), "T", "5550001")).rejects.toMatchObject({ code: 100 });
    // Without the person's id, Meta's token inspector is asked whose token it was; when it can't say,
    // nothing can take it back: never reported as revoked.
    const unknown = userTokenDead(() => json({ error: { message: "unexpected" } }, 400));
    await expect(metaRevokeAdsRead(meta(unknown.fetchImpl), "T")).rejects.toBeInstanceOf(AdsAuthError);
    await expect(metaRevokeAdsRead(meta(unknown.fetchImpl), "T", "../me")).rejects.toBeInstanceOf(AdsAuthError);
    expect(unknown.calls.map((c) => c.url.pathname)).toEqual(["/v25.0/me/permissions/ads_read", "/v25.0/debug_token", "/v25.0/me/permissions/ads_read", "/v25.0/debug_token"]);
  });

  it("Meta: with no person id kept, the token inspector says whose expired token it was, and the app token takes ads_read back", async () => {
    // debug_token answers for a token that no longer works: is_valid false, Meta's error, and user_id.
    const inspected = (data: Record<string, unknown>) =>
      fake((u, init) => {
        const auth = new Headers(init?.headers).get("authorization");
        if (auth === "Bearer T") return json({ error: { message: "Error validating access token: Session has expired", code: 190, error_subcode: 463 } }, 400);
        expect(auth).toBe("Bearer app1|sec");
        if (u.pathname === "/v25.0/debug_token") {
          expect(u.searchParams.get("input_token")).toBe("T");
          return json({ data: { is_valid: false, error: { code: 190, subcode: 463, message: "Session has expired" }, ...data } });
        }
        expect(init?.method).toBe("DELETE");
        expect(u.pathname).toBe("/v25.0/5550002/permissions/ads_read");
        return json({ success: true });
      });
    const ours = inspected({ app_id: "app1", user_id: "5550002" });
    expect(await metaRevokeAdsRead(meta(ours.fetchImpl), "T")).toBe("revoked");
    expect(ours.calls).toHaveLength(3);
    // Another app's token, or no usable id: not ours to take back.
    await expect(metaRevokeAdsRead(meta(inspected({ app_id: "other", user_id: "5550002" }).fetchImpl), "T")).rejects.toBeInstanceOf(AdsAuthError);
    await expect(metaRevokeAdsRead(meta(inspected({ app_id: "app1", user_id: "me/../x" }).fetchImpl), "T")).rejects.toBeInstanceOf(AdsAuthError);
    await expect(metaRevokeAdsRead(meta(inspected({ app_id: "app1" }).fetchImpl), "T")).rejects.toBeInstanceOf(AdsAuthError);
  });

  it("Meta: a range too big for one answer runs as a report job", async () => {
    const f = fake(async (u, init) => {
      if (init?.method === "POST") {
        expect(u.pathname).toBe("/v25.0/act_1/insights");
        const form = new URLSearchParams(String(init.body));
        expect(form.get("time_increment")).toBe("1");
        expect(form.has("access_token")).toBe(false);
        expect(new Headers(init.headers).get("authorization")).toBe("Bearer T");
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
    const inspect = f.calls.find((c) => c.url.pathname.endsWith("/debug_token"))!;
    expect(inspect.url.searchParams.get("input_token")).toBe("USER_T");
    expect(inspect.url.searchParams.has("access_token")).toBe(false);
    expect(new Headers(inspect.init?.headers).get("authorization")).toBe("Bearer app1|sec");
  });

  it("the person picked accounts on Facebook's screen and none came through", async () => {
    const none = emptyMeta(() => json({ data: { granular_scopes: [{ scope: "ads_read", target_ids: [] }] } }));
    await expect(metaAdAccounts(meta(none.fetchImpl), "T")).rejects.toMatchObject({ reason: "none_shared" });
    const unreadable = emptyMeta(() => json({ data: { granular_scopes: [{ scope: "ads_read", target_ids: ["act_9"] }] } }));
    await expect(metaAdAccounts(meta(unreadable.fetchImpl), "T")).rejects.toMatchObject({ reason: "none_shared", message: expect.stringContaining("act_9") });
  });

  it("the inspector failing still says 'no ad account', never 'try again'", async () => {
    const f = emptyMeta(() => json({ error: { message: "Invalid OAuth access token", code: 190 } }, 400));
    const err = (await metaAdAccounts(meta(f.fetchImpl), "T").catch((e: unknown) => e)) as AdsNoAccountsError;
    expect(err).toMatchObject({ reason: "no_ads_account" });
    // Every look-up Meta refused is noted with its code, not thrown.
    expect(err.diagnosis).toMatchObject({ metaUserId: null, me: { failed: 400 }, token: { failed: "auth", message: "Invalid OAuth access token" }, appRole: null });
    expect(err.loginName).toBeNull();
  });

  it("says, for the log, who signed in, what the grant holds and their role on the app; the login's name only for the page", async () => {
    const f = fake((u) => {
      if (u.pathname.endsWith("/me/adaccounts")) return json({ data: [] });
      if (u.pathname.endsWith("/me")) return json({ id: "1020", name: " Sebastian Thomas " });
      if (u.pathname.endsWith("/debug_token")) {
        return json({ data: { type: "USER", app_id: "app1", is_valid: true, user_id: "1020", scopes: ["ads_read", "public_profile"], granular_scopes: [{ scope: "ads_read" }, { scope: "pages_show_list", target_ids: ["9", "8"] }] } });
      }
      if (u.pathname.endsWith("/app1/roles")) return json({ data: [{ user: "1020", role: "administrators" }, { user: "77", role: "testers" }] });
      return json({ error: { message: "unexpected" } }, 400);
    });
    const err = (await metaAdAccounts(meta(f.fetchImpl), "USER_T").catch((e: unknown) => e)) as AdsNoAccountsError;
    expect(err).toMatchObject({ reason: "no_ads_account", loginName: "Sebastian Thomas" });
    expect(err.diagnosis).toEqual({
      metaUserId: "1020",
      token: { type: "USER", ownApp: true, valid: true, scopes: ["ads_read", "public_profile"], granted: { ads_read: "all", pages_show_list: 2 } },
      appRole: "administrators",
      appRolesListed: 2,
    });
    expect(JSON.stringify(err.diagnosis)).not.toContain("Sebastian");
    // The roles are asked with the app's own token; the person's name with theirs.
    const roles = f.calls.find((c) => c.url.pathname.endsWith("/app1/roles"))!;
    expect(new Headers(roles.init?.headers).get("authorization")).toBe("Bearer app1|sec");
    const me = f.calls.find((c) => c.url.pathname.endsWith("/me"))!;
    expect(me.url.searchParams.get("fields")).toBe("id,name");
    expect(new Headers(me.init?.headers).get("authorization")).toBe("Bearer USER_T");

    // A profile with no role on the app, which shared no ad account on Facebook's screen.
    const stranger = fake((u) => {
      if (u.pathname.endsWith("/me/adaccounts")) return json({ data: [] });
      if (u.pathname.endsWith("/me")) return json({ id: "3030", name: "Other" });
      if (u.pathname.endsWith("/debug_token")) return json({ data: { type: "USER", app_id: "app1", is_valid: true, granular_scopes: [{ scope: "ads_read", target_ids: [] }] } });
      if (u.pathname.endsWith("/app1/roles")) return json({ data: [{ user: "1020", role: "administrators" }] });
      return json({ error: { message: "unexpected" } }, 400);
    });
    const none = (await metaAdAccounts(meta(stranger.fetchImpl), "T").catch((e: unknown) => e)) as AdsNoAccountsError;
    expect(none).toMatchObject({ reason: "none_shared", diagnosis: { metaUserId: "3030", appRole: "none", appRolesListed: 1, token: { granted: { ads_read: 0 } } } });
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

  it("Google, down from a campaign: its ad groups, a Performance Max campaign's asset groups, an ad group's ads; one query each, the rows added up as the totals", async () => {
    const queries: string[] = [];
    const f = fake(async (_u, init) => {
      const query = queryOf(init);
      queries.push(query);
      if (query.includes("FROM ad_group_ad")) {
        return json([
          {
            results: [
              { campaign: { id: "11", name: "Brand" }, adGroup: { id: "55", name: "Shoes" }, adGroupAd: { status: "ENABLED", ad: { id: "7001", type: "RESPONSIVE_SEARCH_AD" } }, metrics: { costMicros: "3000000", impressions: "300", clicks: "30" } },
              { campaign: { id: "11", name: "Brand" }, adGroup: { id: "55", name: "Shoes" }, adGroupAd: { status: "PAUSED", ad: { id: "7002", type: "RESPONSIVE_SEARCH_AD" } }, metrics: { costMicros: "1000000", impressions: "100", clicks: "5" } },
            ],
          },
        ]);
      }
      if (query.includes("FROM asset_group")) return json([{ results: [{ campaign: { id: "12", name: "PMax" }, assetGroup: { id: "901", name: "Summer", status: "ENABLED" }, metrics: { costMicros: "2500000", impressions: "50" } }] }]);
      return json([{ results: [{ campaign: { id: "11", name: "Brand" }, adGroup: { id: "55", name: "Shoes", status: "ENABLED" }, metrics: { costMicros: "4000000", impressions: "400", clicks: "35" } }] }]);
    });
    const during = "segments.date BETWEEN '2026-10-01' AND '2026-10-07'";
    const groups = await googleReport(google(f.fetchImpl), "AT", { accountId: "111" }, "ad_group", "2026-10-01", "2026-10-07", 200, { campaign: "11" });
    expect(queries).toEqual([`SELECT campaign.id, campaign.name, ad_group.id, ad_group.name, ad_group.status, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value FROM ad_group WHERE ${during} AND campaign.id = 11`]);
    expect(groups.rows[0]).toMatchObject({ id: "55", campaignId: "11", campaignName: "Brand" });
    // Not the account's totals (no customer query): the campaign's ad groups added up.
    expect(groups.totals).toMatchObject({ spend: 4, impressions: 400, clicks: 35 });

    queries.length = 0;
    const assets = await googleReport(google(f.fetchImpl), "AT", { accountId: "111" }, "asset_group", "2026-10-01", "2026-10-07", 200, { campaign: "12" });
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("FROM asset_group WHERE");
    expect(queries[0]).toContain("AND campaign.id = 12");
    expect(assets.rows.map((r) => [r.id, r.name, r.campaignId])).toEqual([["901", "Summer", "12"]]);

    queries.length = 0;
    const ads = await googleReport(google(f.fetchImpl), "AT", { accountId: "111" }, "ad", "2026-10-01", "2026-10-07", 1, { campaign: "11", adGroup: "55" });
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatch(/^SELECT campaign\.id, campaign\.name, ad_group\.id, ad_group\.name, ad_group_ad\.ad\.id, ad_group_ad\.ad\.name, ad_group_ad\.ad\.type, ad_group_ad\.status, metrics\./);
    expect(queries[0]).toContain(`FROM ad_group_ad WHERE ${during} AND campaign.id = 11 AND ad_group.id = 55`);
    // The ad's text and links are never asked for.
    expect(queries[0]).not.toMatch(/headline|description|final_url/);
    expect(ads.rows).toEqual([expect.objectContaining({ id: "7001", name: "Responsive search ad 7001", adGroupId: "55", adType: "RESPONSIVE_SEARCH_AD", status: "ENABLED" })]);
    // One row shown of two: the totals still add up every one Google returned.
    expect(ads.truncated).toBe(true);
    expect(ads.totals).toMatchObject({ spend: 4, impressions: 400, clicks: 35 });
  });

  it("Google: an id that isn't Google's, or a level that can't be under it, is refused before any query", async () => {
    const f = fake(async () => json([{ results: [] }]));
    const asked: Array<[Parameters<typeof googleReport>[3], { campaign?: string; adGroup?: string }]> = [
      ["ad_group", { campaign: "1 OR 1=1" }],
      ["ad", { adGroup: "55) OR (1=1" }],
      ["ad", { adGroup: "demo-c2-core" }],
      ["ad", { campaign: "11" }],
      ["asset_group", {}],
      ["campaign", { campaign: "11" }],
      ["device", { campaign: "11" }],
    ];
    for (const [level, parent] of asked) {
      await expect(googleReport(google(f.fetchImpl), "AT", { accountId: "111" }, level, "2026-10-01", "2026-10-07", 200, parent)).rejects.toMatchObject({ status: 400 });
    }
    expect(f.calls).toHaveLength(0);
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
      if (u.searchParams.get("breakdowns") === "publisher_platform,impression_device") return json({ data: [{ publisher_platform: "facebook", impression_device: "android_smartphone", spend: "1" }] });
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

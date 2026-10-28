import { describe, expect, it } from "vitest";
import {
  AD_ACCOUNT_LIST_MAX_BYTES,
  adsenseAuthorizeUrl,
  AdsApiError,
  AdsAuthError,
  AdsNoAccountsError,
  AdsNotApprovedError,
  AdsPermissionError,
  AdsRateLimitedError,
  AdsRetryableError,
  AdsUnavailableError,
  classifyAdError,
  GOOGLE_DISCOVERY_MAX_CUSTOMERS,
  googleAdAccounts,
  googleAuthorizeUrl,
  googleCampaignDays,
  googleRefresh,
  googleUserId,
  readGoogleError,
  type FetchLike,
} from "../src/index.js";

/**
 * The Google Ads API client against answers shaped like Google's REST ones: a generic top-level
 * message ("The caller does not have permission") with the real reason in error.details[], a
 * GoogleAdsFailure whose errors[].errorCode is a oneof such as { authorizationError: "..." }
 * (https://developers.google.com/google-ads/api/docs/get-started/common-errors, the v25 errors.proto,
 * and https://cloud.google.com/apis/design/errors for ErrorInfo / RetryInfo).
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

const google = (fetchImpl: FetchLike, version = "v25") => ({ clientId: "cid", clientSecret: "csec", version, fetchImpl });
const queryOf = (init: RequestInit | undefined) => (init?.body ? (JSON.parse(String(init.body)) as { query: string }).query : "");

/** A Google Ads failure as REST answers it: the wrapper's words on top, Google's own in the GoogleAdsFailure. */
const adsFailure = (httpStatus: number, status: string, errors: Array<{ errorCode: Record<string, string>; message: string; details?: unknown }>, extra: unknown[] = []) => ({
  error: {
    code: httpStatus,
    message: httpStatus === 401 ? "Request is missing required authentication credential." : "The caller does not have permission",
    status,
    details: [{ "@type": "type.googleapis.com/google.ads.googleads.v25.errors.GoogleAdsFailure", errors, requestId: "req-1" }, ...extra],
  },
});

/** googleCampaignDays answered `body` (searchStream wraps a failure in its array). */
const daysFailing = async (body: unknown, httpStatus: number, version = "v25") => {
  const f = fake(() => json([body], httpStatus));
  return googleCampaignDays(google(f.fetchImpl, version), "AT", { accountId: "111" }, "2026-10-01", "2026-10-02").then(
    () => {
      throw new Error("expected a failure");
    },
    (err: unknown) => err as Error & { errorCode?: string; providerCode?: string; retryAfterS?: number | null },
  );
};

describe("Google Ads errors are sorted by Google's error codes, not the wrapper's text", () => {
  it("this login lost the account (removed, the manager link gone): permission missing, in Google's own words", async () => {
    const err = await daysFailing(
      adsFailure(403, "PERMISSION_DENIED", [{ errorCode: { authorizationError: "USER_PERMISSION_DENIED" }, message: "User doesn't have permission to access customer. Note: If you're accessing a client customer, the manager's customer ID must be set in the 'login-customer-id' header." }]),
      403,
    );
    expect(err).toBeInstanceOf(AdsPermissionError);
    expect(err.message).toMatch(/^User doesn't have permission to access customer/);
    expect(err).toMatchObject({ errorCode: "no_access", providerCode: "authorizationError.USER_PERMISSION_DENIED" });
    expect(classifyAdError(err)).toMatchObject({ status: "permission", code: "no_access", retryable: false });

    const link = await daysFailing(adsFailure(403, "PERMISSION_DENIED", [{ errorCode: { authorizationError: "INVALID_LOGIN_CUSTOMER_ID_SERVING_CUSTOMER_ID_COMBINATION" }, message: "The login customer specified does not have access to the account specified." }]), 403);
    expect(link).toBeInstanceOf(AdsPermissionError);
    const twoStep = await daysFailing(adsFailure(401, "UNAUTHENTICATED", [{ errorCode: { authenticationError: "TWO_STEP_VERIFICATION_NOT_ENROLLED" }, message: "An account administrator changed this account's authentication settings." }]), 401);
    expect(twoStep).toBeInstanceOf(AdsPermissionError);
    // From v25, ACTION_NOT_PERMITTED is a person's permission, not the project's access level.
    expect(await daysFailing(adsFailure(403, "PERMISSION_DENIED", [{ errorCode: { authorizationError: "ACTION_NOT_PERMITTED" }, message: "The user does not have permission to perform this action." }]), 403)).toBeInstanceOf(AdsPermissionError);
  });

  it("the account itself: cancelled or deactivated, not found, sign-up unfinished, suspended", async () => {
    const cases: Array<[Record<string, string>, string]> = [
      [{ authorizationError: "CUSTOMER_NOT_ENABLED" }, "account_closed"],
      [{ authenticationError: "CUSTOMER_NOT_FOUND" }, "account_closed"],
      [{ authorizationError: "INCOMPLETE_SIGNUP" }, "account_not_ready"],
      [{ authorizationError: "ACTION_NOT_PERMITTED_FOR_SUSPENDED_ACCOUNT" }, "account_disabled"],
    ];
    for (const [errorCode, code] of cases) {
      const err = await daysFailing(adsFailure(403, "PERMISSION_DENIED", [{ errorCode, message: "The customer account can't be accessed because it is not yet enabled or has been deactivated." }]), 403);
      expect(err).toBeInstanceOf(AdsUnavailableError);
      expect(err.errorCode).toBe(code);
      expect(classifyAdError(err).status).toBe("unavailable");
    }
  });

  it("ended access asks for a reconnect; a token without the adwords permission says the permission is missing", async () => {
    const revoked = await daysFailing(adsFailure(401, "UNAUTHENTICATED", [{ errorCode: { authenticationError: "OAUTH_TOKEN_REVOKED" }, message: "OAuth token in the header has been revoked." }]), 401);
    expect(revoked).toBeInstanceOf(AdsAuthError);
    expect(revoked).toMatchObject({ errorCode: "auth_expired", message: "OAuth token in the header has been revoked." });
    // A 401 with no GoogleAdsFailure at all is still ended access.
    expect(await daysFailing({ error: { code: 401, message: "Request had invalid authentication credentials.", status: "UNAUTHENTICATED" } }, 401)).toBeInstanceOf(AdsAuthError);
    const scope = await daysFailing(
      {
        error: {
          code: 403,
          message: "Request had insufficient authentication scopes.",
          status: "PERMISSION_DENIED",
          details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT", domain: "googleapis.com", metadata: { service: "googleads.googleapis.com" } }],
        },
      },
      403,
    );
    expect(scope).toBeInstanceOf(AdsAuthError);
    expect(scope.errorCode).toBe("scope_missing");
    expect(classifyAdError(scope).status).toBe("reconnect");
  });

  it("bizinsights' own project: not approved for production accounts, disabled, the API switched off, terms unsigned", async () => {
    for (const value of ["CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION", "PROJECT_DISABLED", "DEVELOPER_TOKEN_NOT_APPROVED"]) {
      const err = await daysFailing(adsFailure(403, "PERMISSION_DENIED", [{ errorCode: { authorizationError: value }, message: `${value} message` }]), 403);
      expect(err).toBeInstanceOf(AdsNotApprovedError);
      expect(err).toMatchObject({ errorCode: "not_approved", providerCode: `authorizationError.${value}`, message: `${value} message` });
    }
    // Up to v24, Test-access-only answered ACTION_NOT_PERMITTED.
    expect(await daysFailing(adsFailure(403, "PERMISSION_DENIED", [{ errorCode: { authorizationError: "ACTION_NOT_PERMITTED" }, message: "x" }]), 403, "v24")).toBeInstanceOf(AdsNotApprovedError);
    const disabled = await daysFailing(
      {
        error: {
          code: 403,
          message: "Google Ads API has not been used in project 123 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/googleads.googleapis.com/overview?project=123 then retry.",
          status: "PERMISSION_DENIED",
          details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "SERVICE_DISABLED", domain: "googleapis.com", metadata: { service: "googleads.googleapis.com", consumer: "projects/123" } }],
        },
      },
      403,
    );
    expect(disabled).toBeInstanceOf(AdsApiError);
    expect(disabled.errorCode).toBe("not_configured");
    expect(classifyAdError(disabled)).toMatchObject({ status: "error", code: "not_configured" });
    const tos = await daysFailing(adsFailure(403, "PERMISSION_DENIED", [{ errorCode: { authorizationError: "MISSING_TOS" }, message: "The developer must sign the terms of service." }]), 403);
    expect(tos.errorCode).toBe("not_configured");
  });

  it("quota: the project's daily operations allowance, short-term throttling, and how long Google says to wait", async () => {
    const daily = await daysFailing(
      adsFailure(429, "RESOURCE_EXHAUSTED", [
        {
          errorCode: { quotaError: "RESOURCE_EXHAUSTED" },
          message: "Too many requests. Retry in 43200 seconds.",
          details: { quotaErrorDetails: { rateScope: "DEVELOPER", rateName: "Number of operations for explorer access", retryDelay: "43200s" } },
        },
      ]),
      429,
    );
    expect(daily).toBeInstanceOf(AdsRateLimitedError);
    expect(daily).toMatchObject({ errorCode: "quota_exhausted", retryAfterS: 43200, providerCode: "quotaError.RESOURCE_EXHAUSTED" });
    expect(classifyAdError(daily)).toMatchObject({ status: "error", code: "quota_exhausted", retryable: true, retryAfterS: 43200 });

    const burst = await daysFailing(
      adsFailure(429, "RESOURCE_EXHAUSTED", [{ errorCode: { quotaError: "RESOURCE_TEMPORARILY_EXHAUSTED" }, message: "Too many requests in a short amount of time.", details: { quotaErrorDetails: { rateScope: "DEVELOPER", retryDelay: "30.5s" } } }]),
      429,
    );
    expect(burst).toMatchObject({ errorCode: "rate_limited", retryAfterS: 31 });
    // The account's own bucket is throttling, whatever its name.
    const account = await daysFailing(adsFailure(429, "RESOURCE_EXHAUSTED", [{ errorCode: { quotaError: "RESOURCE_EXHAUSTED" }, message: "Too many requests.", details: { quotaErrorDetails: { rateScope: "ACCOUNT", rateName: "Requests per account", retryDelay: "5s" } } }]), 429);
    expect(account).toMatchObject({ errorCode: "rate_limited", retryAfterS: 5 });
    // A plain gRPC RESOURCE_EXHAUSTED with RetryInfo.
    const plain = await daysFailing({ error: { code: 429, message: "Resource has been exhausted", status: "RESOURCE_EXHAUSTED", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "12s" }] } }, 429);
    expect(plain).toMatchObject({ errorCode: "rate_limited", retryAfterS: 12 });
  });

  it("Google's own trouble is worth a retry; a refused query is the platform's refusal", async () => {
    expect(await daysFailing(adsFailure(500, "INTERNAL", [{ errorCode: { internalError: "INTERNAL_ERROR" }, message: "An internal error has occurred." }]), 500)).toBeInstanceOf(AdsRetryableError);
    expect(await daysFailing({ error: { code: 503, message: "The service is currently unavailable.", status: "UNAVAILABLE" } }, 503)).toBeInstanceOf(AdsRetryableError);
    const bad = await daysFailing(adsFailure(400, "INVALID_ARGUMENT", [{ errorCode: { queryError: "PROHIBITED_SEGMENT_WITH_METRIC_IN_SELECT_OR_WHERE_CLAUSE" }, message: "Cannot select or filter on the following segment" }]), 400);
    expect(bad).toBeInstanceOf(AdsApiError);
    expect(bad).toMatchObject({ status: 400, errorCode: "provider_error", providerCode: "queryError.PROHIBITED_SEGMENT_WITH_METRIC_IN_SELECT_OR_WHERE_CLAUSE" });
  });

  it("reads Google's error envelope whatever is missing from it", () => {
    expect(readGoogleError(undefined, 502, "fallback")).toEqual({ httpStatus: 502, status: null, message: "fallback", reasons: [], retryAfterS: null, adsErrors: [] });
    const g = readGoogleError({ message: "m", details: [{ errors: [{ errorCode: { quotaError: "RESOURCE_EXHAUSTED" }, details: { quotaErrorDetails: { retryDelay: { seconds: "90", nanos: 500000000 } } } }] }, "junk"] }, 429, "f");
    expect(g.adsErrors).toEqual([{ code: "quotaError.RESOURCE_EXHAUSTED", message: null, quota: { rateScope: null, rateName: null, retryDelayS: 91 } }]);
  });
});

describe("searchStream", () => {
  it("an error after the answer began fails the read: the batches before it are only part of it", async () => {
    const f = fake(() =>
      json([
        { results: [{ campaign: { id: "5", name: "Brand" }, segments: { date: "2026-10-01" }, metrics: { costMicros: "1000000" } }] },
        { error: { code: 500, message: "Internal error encountered.", status: "INTERNAL" } },
      ]),
    );
    await expect(googleCampaignDays(google(f.fetchImpl), "AT", { accountId: "111" }, "2026-10-01", "2026-10-01")).rejects.toBeInstanceOf(AdsRetryableError);
    const lost = fake(() => json([{ results: [] }, adsFailure(403, "PERMISSION_DENIED", [{ errorCode: { authorizationError: "USER_PERMISSION_DENIED" }, message: "no" }])]));
    await expect(googleCampaignDays(google(lost.fetchImpl), "AT", { accountId: "111" }, "2026-10-01", "2026-10-01")).rejects.toBeInstanceOf(AdsPermissionError);
    // A 200 cut off mid-stream (not JSON) is no answer, never an empty one.
    const cut = fake(() => new Response('[{"results":[{"campaign":{"id":"5"}', { status: 200 }));
    await expect(googleCampaignDays(google(cut.fetchImpl), "AT", { accountId: "111" }, "2026-10-01", "2026-10-01")).rejects.toBeInstanceOf(AdsRetryableError);
  });
});

describe("purchases among Google's conversions", () => {
  const row = (id: string, day: string, conversions: number, value: number) => ({ campaign: { id, name: `C${id}` }, segments: { date: day }, metrics: { costMicros: "1000000", impressions: "10", clicks: "1", conversions, conversionsValue: value } });

  it("a second query asks for the PURCHASE category only, the segment in SELECT as well as WHERE, merged by campaign and day", async () => {
    const queries: string[] = [];
    const f = fake((_u, init) => {
      const q = queryOf(init);
      queries.push(q);
      if (q.includes("conversion_action_category")) {
        return json([
          {
            results: [
              { campaign: { id: "1" }, segments: { date: "2026-10-01", conversionActionCategory: "PURCHASE" }, metrics: { conversions: 2, conversionsValue: 80.5 } },
              { campaign: { id: "2" }, segments: { date: "2026-10-02", conversionActionCategory: "PURCHASE" }, metrics: { conversions: 1, conversionsValue: 20 } },
            ],
          },
        ]);
      }
      return json([{ results: [row("1", "2026-10-01", 5, 100), row("1", "2026-10-02", 0, 0), row("2", "2026-10-02", 1, 20)] }]);
    });
    const rows = await googleCampaignDays(google(f.fetchImpl), "AT", { accountId: "111" }, "2026-10-01", "2026-10-02");
    expect(queries[1]).toBe(
      "SELECT campaign.id, segments.date, segments.conversion_action_category, metrics.conversions, metrics.conversions_value FROM campaign WHERE segments.date BETWEEN '2026-10-01' AND '2026-10-02' AND segments.conversion_action_category = 'PURCHASE'",
    );
    // Every conversion stays as Google counts it; purchases are their own figure (zero where none were credited).
    expect(rows.map((r) => [r.campaignId, r.day, r.conversions, r.purchases, r.purchaseValue])).toEqual([
      ["1", "2026-10-01", 5, 2, 80.5],
      ["1", "2026-10-02", 0, 0, 0],
      ["2", "2026-10-02", 1, 1, 20],
    ]);
  });

  it("with no conversion in the window there are no purchases to ask for: one query, purchases zero", async () => {
    const f = fake(() => json([{ results: [row("1", "2026-10-01", 0, 0)] }]));
    const rows = await googleCampaignDays(google(f.fetchImpl), "AT", { accountId: "111" }, "2026-10-01", "2026-10-01");
    expect(f.calls).toHaveLength(1);
    expect(rows[0]).toMatchObject({ purchases: 0, purchaseValue: 0 });
    const none = fake(() => json([{ results: [] }]));
    expect(await googleCampaignDays(google(none.fetchImpl), "AT", { accountId: "111" }, "2026-10-01", "2026-10-01")).toEqual([]);
    expect(none.calls).toHaveLength(1);
  });

  it("Google refusing the purchase query leaves purchases unknown, not the sync failed; ended access still fails it", async () => {
    const refused = fake((_u, init) =>
      queryOf(init).includes("conversion_action_category")
        ? json([adsFailure(400, "INVALID_ARGUMENT", [{ errorCode: { queryError: "PROHIBITED_SEGMENT_WITH_METRIC_IN_SELECT_OR_WHERE_CLAUSE" }, message: "x" }])], 400)
        : json([{ results: [row("1", "2026-10-01", 3, 30)] }]),
    );
    const rows = await googleCampaignDays(google(refused.fetchImpl), "AT", { accountId: "111" }, "2026-10-01", "2026-10-01");
    expect(rows[0]).toMatchObject({ conversions: 3, purchases: null, purchaseValue: null });
    const limited = fake((_u, init) =>
      queryOf(init).includes("conversion_action_category")
        ? json([adsFailure(429, "RESOURCE_EXHAUSTED", [{ errorCode: { quotaError: "RESOURCE_TEMPORARILY_EXHAUSTED" }, message: "slow down" }])], 429)
        : json([{ results: [row("1", "2026-10-01", 3, 30)] }]),
    );
    await expect(googleCampaignDays(google(limited.fetchImpl), "AT", { accountId: "111" }, "2026-10-01", "2026-10-01")).rejects.toBeInstanceOf(AdsRateLimitedError);
  });
});

describe("the accounts a Google login reaches", () => {
  it("looks them up 8 at a time, in Google's order, with each account's status; managers are never listed", async () => {
    const ids = Array.from({ length: 30 }, (_, i) => String(1000 + i));
    let running = 0;
    let most = 0;
    const f = fake(async (u, init) => {
      if (u.pathname.endsWith("customers:listAccessibleCustomers")) return json({ resourceNames: [...ids.map((id) => `customers/${id}`), "customers/1000"] });
      const id = u.pathname.split("/")[3]!;
      const q = queryOf(init);
      running++;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, 2));
      running--;
      if (q.includes("FROM customer_client")) {
        expect(new Headers(init?.headers).get("login-customer-id")).toBe(id);
        return json([{ results: [{ customerClient: { id: "9001", descriptiveName: "Client", currencyCode: "USD", timeZone: "UTC", manager: false, status: "ENABLED" } }] }]);
      }
      expect(q).toBe("SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.manager, customer.status FROM customer");
      if (id === "1001") return json([{ results: [{ customer: { id, descriptiveName: "Agency", manager: true, status: "ENABLED" } }] }]);
      if (id === "1002") return json([adsFailure(403, "PERMISSION_DENIED", [{ errorCode: { authorizationError: "USER_PERMISSION_DENIED" }, message: "no" }])], 403);
      return json([{ results: [{ customer: { id, descriptiveName: `A${id}`, currencyCode: "AUD", timeZone: "UTC", manager: false, status: id === "1003" ? "SUSPENDED" : "ENABLED" } }] }]);
    });
    const accounts = await googleAdAccounts(google(f.fetchImpl), "AT");
    expect(most).toBeLessThanOrEqual(8);
    expect(most).toBeGreaterThan(1);
    // Each customer once (the duplicate in Google's list is looked up once), the manager's client after the direct ones before it.
    expect(f.calls.filter((c) => queryOf(c.init).endsWith("FROM customer"))).toHaveLength(30);
    expect(accounts.map((a) => a.accountId)).toEqual(["1000", "9001", ...ids.slice(3)]);
    expect(accounts.find((a) => a.accountId === "1003")).toMatchObject({ status: "disabled", loginCustomerId: null });
    expect(accounts.find((a) => a.accountId === "9001")).toMatchObject({ status: "active", loginCustomerId: "1001" });
    expect(accounts.some((a) => a.accountId === "1001" || a.accountId === "1002")).toBe(false);
    expect(accounts.truncated).toBeUndefined();
  });

  it("an agency login with more customers than one sign-in looks up: the first 300, the list marked as cut", async () => {
    const total = GOOGLE_DISCOVERY_MAX_CUSTOMERS + 20;
    const f = fake((u) => {
      if (u.pathname.endsWith("customers:listAccessibleCustomers")) return json({ resourceNames: Array.from({ length: total }, (_, i) => `customers/${5000 + i}`) });
      const id = u.pathname.split("/")[3]!;
      return json([{ results: [{ customer: { id, manager: false, status: "ENABLED" } }] }]);
    });
    const accounts = await googleAdAccounts(google(f.fetchImpl), "AT");
    expect(accounts).toHaveLength(GOOGLE_DISCOVERY_MAX_CUSTOMERS);
    expect(accounts.truncated).toBe(true);
    expect(f.calls).toHaveLength(GOOGLE_DISCOVERY_MAX_CUSTOMERS + 1);
  });

  it("a failure that is the sign-in's or bizinsights' fails the whole look-up; one account's own only leaves it out", async () => {
    const failing = (body: unknown, status: number) =>
      fake((u) => (u.pathname.endsWith("customers:listAccessibleCustomers") ? json({ resourceNames: ["customers/1", "customers/2"] }) : u.pathname.includes("/1/") ? json([{ results: [{ customer: { id: "1", manager: false } }] }]) : json([body], status)));
    const quota = failing(adsFailure(429, "RESOURCE_EXHAUSTED", [{ errorCode: { quotaError: "RESOURCE_EXHAUSTED" }, message: "q", details: { quotaErrorDetails: { rateScope: "DEVELOPER", retryDelay: "40000s" } } }]), 429);
    await expect(googleAdAccounts(google(quota.fetchImpl), "AT")).rejects.toMatchObject({ errorCode: "quota_exhausted" });
    const ended = failing(adsFailure(401, "UNAUTHENTICATED", [{ errorCode: { authenticationError: "OAUTH_TOKEN_EXPIRED" }, message: "expired" }]), 401);
    await expect(googleAdAccounts(google(ended.fetchImpl), "AT")).rejects.toBeInstanceOf(AdsAuthError);
    const cancelled = failing(adsFailure(403, "PERMISSION_DENIED", [{ errorCode: { authorizationError: "CUSTOMER_NOT_ENABLED" }, message: "not enabled" }]), 403);
    expect((await googleAdAccounts(google(cancelled.fetchImpl), "AT")).map((a) => a.accountId)).toEqual(["1"]);
    // Only unreadable accounts: the person is told theirs can't be reported on yet.
    const allCancelled = fake((u) => (u.pathname.endsWith("customers:listAccessibleCustomers") ? json({ resourceNames: ["customers/2"] }) : json([adsFailure(403, "PERMISSION_DENIED", [{ errorCode: { authorizationError: "CUSTOMER_NOT_ENABLED" }, message: "x" }])], 403)));
    const err = await googleAdAccounts(google(allCancelled.fetchImpl), "AT").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdsNoAccountsError);
    expect(err).toMatchObject({ reason: "not_ready" });
  });

  // It all runs inside the OAuth callback (the API has 55 s), and the list is then held in one
  // DynamoDB item (400 KB) while the person picks.
  it("look-ups stop at the sign-in's time: the first round always runs, the rest are left out and the list marked as cut", async () => {
    const accessible = Array.from({ length: 20 }, (_, i) => `customers/${7000 + i}`);
    const f = fake((u) => {
      if (u.pathname.endsWith("customers:listAccessibleCustomers")) return json({ resourceNames: accessible });
      const id = u.pathname.split("/")[3]!;
      return json([{ results: [{ customer: { id, manager: false, status: "ENABLED" } }] }]);
    });
    const accounts = await googleAdAccounts(google(f.fetchImpl), "AT", { budgetMs: 0 });
    expect(accounts.map((a) => a.accountId)).toEqual(accessible.slice(0, 8).map((r) => r.split("/")[1]));
    expect(accounts.truncated).toBe(true);
    expect(f.calls).toHaveLength(1 + 8);
    // Nothing readable in the round that ran, and others not looked at: worth another go, not "no account".
    const unreadable = fake((u) =>
      u.pathname.endsWith("customers:listAccessibleCustomers")
        ? json({ resourceNames: accessible })
        : json([adsFailure(403, "PERMISSION_DENIED", [{ errorCode: { authorizationError: "CUSTOMER_NOT_ENABLED" }, message: "x" }])], 403),
    );
    await expect(googleAdAccounts(google(unreadable.fetchImpl), "AT", { budgetMs: 0 })).rejects.toBeInstanceOf(AdsRetryableError);
  });

  it("a manager with thousands of clients: the list stops at what the sign-in can hold", async () => {
    const f = fake((u, init) => {
      if (u.pathname.endsWith("customers:listAccessibleCustomers")) return json({ resourceNames: ["customers/100"] });
      if (!queryOf(init).includes("FROM customer_client")) return json([{ results: [{ customer: { id: "100", manager: true, status: "ENABLED" } }] }]);
      const results = Array.from({ length: 4000 }, (_, i) => ({ customerClient: { id: String(200000 + i), descriptiveName: `Client ${"ü".repeat(40)} ${i}`, currencyCode: "EUR", timeZone: "Europe/Berlin", manager: false, status: "ENABLED" } }));
      return json([{ results }]);
    });
    const accounts = await googleAdAccounts(google(f.fetchImpl), "AT");
    expect(accounts.truncated).toBe(true);
    expect(accounts.length).toBeGreaterThan(1000);
    expect(accounts.length).toBeLessThan(4000);
    expect(new TextEncoder().encode(JSON.stringify(accounts)).length).toBeLessThanOrEqual(AD_ACCOUNT_LIST_MAX_BYTES);
    expect(accounts[0]).toMatchObject({ accountId: "200000", loginCustomerId: "100" });
  });
});

describe("Google sign-in", () => {
  it("asks for consent again by default; can send someone through with the account chooser only", () => {
    const def = new URL(googleAuthorizeUrl(google(fetch), "https://app/cb", "st"));
    expect(def.searchParams.get("prompt")).toBe("select_account consent");
    const chooser = new URL(googleAuthorizeUrl(google(fetch), "https://app/cb", "st", "challenge", { forceConsent: false }));
    expect(chooser.searchParams.get("prompt")).toBe("select_account");
    expect(chooser.searchParams.get("access_type")).toBe("offline");
    expect(chooser.searchParams.get("code_challenge")).toBe("challenge");
    expect(new URL(adsenseAuthorizeUrl({ clientId: "cid", clientSecret: "csec" }, "https://app/cb", "st", undefined, { forceConsent: false })).searchParams.get("prompt")).toBe("select_account");
    expect(new URL(adsenseAuthorizeUrl({ clientId: "cid", clientSecret: "csec" }, "https://app/cb", "st", undefined, { forceConsent: true })).searchParams.get("prompt")).toBe("select_account consent");
  });

  it("a refresh: ended grant, a grant without the reporting permission, and bizinsights' own client refused are told apart", async () => {
    const answering = (body: unknown, status: number) => fake(() => json(body, status)).fetchImpl;
    const ended = await googleRefresh(google(answering({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400)), "RT").catch((e: unknown) => e);
    expect(ended).toBeInstanceOf(AdsAuthError);
    expect(ended).toMatchObject({ errorCode: "auth_expired" });
    await expect(googleRefresh(google(answering({ error: "invalid_scope" }, 400)), "RT")).rejects.toMatchObject({ errorCode: "scope_missing" });
    const ours = await googleRefresh(google(answering({ error: "invalid_client", error_description: "Unauthorized" }, 401)), "RT").catch((e: unknown) => e);
    expect(ours).not.toBeInstanceOf(AdsAuthError);
    expect(ours).toMatchObject({ errorCode: "not_configured" });
    await expect(googleRefresh(google(answering({ error: "rate_limit_exceeded" }, 429)), "RT")).rejects.toBeInstanceOf(AdsRateLimitedError);
    await expect(googleRefresh(google(answering({ error: "backend_error" }, 503)), "RT")).rejects.toBeInstanceOf(AdsRetryableError);

    const scopes = "https://www.googleapis.com/auth/adsense.readonly openid";
    const granted = answering({ access_token: "AT", expires_in: 3599, scope: scopes }, 200);
    await expect(googleRefresh(google(granted), "RT", { requiredScope: "https://www.googleapis.com/auth/adwords" })).rejects.toMatchObject({ errorCode: "scope_missing" });
    expect(await googleRefresh(google(granted), "RT", { requiredScope: "https://www.googleapis.com/auth/adsense.readonly" })).toMatchObject({ accessToken: "AT", grantedScopes: scopes.split(" ") });
    // Google not listing scopes says nothing about them.
    expect(await googleRefresh(google(answering({ access_token: "AT", expires_in: 3599 }, 200)), "RT", { requiredScope: "x" })).toMatchObject({ accessToken: "AT" });
  });

  it("who signed in: a passing hiccup is tried again, the id read under either name, the client checked as aud or azp", async () => {
    let n = 0;
    const flaky: FetchLike = async () => {
      n++;
      if (n === 1) throw new TypeError("fetch failed");
      return json({ aud: "cid", sub: "10987654321" });
    };
    expect(await googleUserId(google(flaky), "AT")).toBe("10987654321");
    let m = 0;
    const busy = fake(() => (++m === 1 ? json({ error: "backend_error" }, 503) : json({ azp: "cid", user_id: "555" })));
    expect(await googleUserId(google(busy.fetchImpl), "AT")).toBe("555");
    const down = fake(() => json({ error: "backend_error" }, 503));
    await expect(googleUserId(google(down.fetchImpl), "AT")).rejects.toBeInstanceOf(AdsRetryableError);
    expect(down.calls).toHaveLength(2);
    const other = fake(() => json({ aud: "someone-else", azp: "someone-else", sub: "1" }));
    await expect(googleUserId(google(other.fetchImpl), "AT")).rejects.toBeInstanceOf(AdsAuthError);
    const bad = fake(() => json({ aud: "cid", sub: "not-digits" }));
    expect(await googleUserId(google(bad.fetchImpl), "AT")).toBeNull();
  });

  it("who signed in, when tokeninfo leaves it out: Google's userinfo, only for a token that carries openid", async () => {
    const withOpenid = fake((u) =>
      u.pathname === "/tokeninfo" ? json({ aud: "cid", scope: "https://www.googleapis.com/auth/adsense.readonly openid" }) : json({ sub: "112233445566" }),
    );
    expect(await googleUserId(google(withOpenid.fetchImpl), "AT")).toBe("112233445566");
    const userinfo = withOpenid.calls.find((c) => c.url.host === "openidconnect.googleapis.com")!;
    expect(userinfo.url.pathname).toBe("/v1/userinfo");
    // The token goes in the header, never the address.
    expect(new Headers(userinfo.init?.headers).get("authorization")).toBe("Bearer AT");
    expect(userinfo.url.search).toBe("");
    // A token without openid (connected before it was asked for): no further call, the person stays unknown.
    const without = fake(() => json({ aud: "cid", scope: "https://www.googleapis.com/auth/adsense.readonly" }));
    expect(await googleUserId(google(without.fetchImpl), "AT")).toBeNull();
    expect(without.calls).toHaveLength(1);
    // userinfo refusing (or down) leaves it unknown rather than failing the connect.
    const refused = fake((u) => (u.pathname === "/tokeninfo" ? json({ aud: "cid", scope: "openid" }) : json({ error: "invalid_token" }, 401)));
    expect(await googleUserId(google(refused.fetchImpl), "AT")).toBeNull();
  });
});

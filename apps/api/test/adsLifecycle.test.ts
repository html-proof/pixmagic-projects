import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { systemDb } from "@app/db";
import { adAccessToken, checkAdLogins, encryptAdTokens, googleAdsOperationsToday, logger, metaDataDeletion, metaDeauthorized, pauseGoogleAds, type FetchLike } from "@app/core";
import { adErrorMessage, pkceChallenge } from "@app/shared";
import { clean, createStore, createWorkspace, deletionCode, setup, signIn, teardown, type TestCtx } from "./helpers.js";

/**
 * "Continue with Google Ads" / "Continue with Meta Ads" beyond the first connect: PKCE, who signed
 * in, refresh tokens Google doesn't resend or replaces, giving access back on disconnect, a Meta login
 * kept connected while it reaches no ad account yet, the accounts the Nango release connected until
 * they are moved off it, and the live Google Ads report.
 */

let ctx: TestCtx;
beforeAll(async () => (ctx = await setup()));
afterAll(async () => teardown(ctx));

const KEYS = {
  META_APP_ID: "meta_app",
  META_APP_SECRET: "meta_secret",
  GOOGLE_ADS_CLIENT_ID: "g_client",
  GOOGLE_ADS_CLIENT_SECRET: "g_secret",
  GOOGLE_ADS_ENABLED: "1",
  META_CONFIG_ID: "",
  // Only the accounts the Nango release connected need its key (their own describe sets it).
  NANGO_SECRET_KEY: "",
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface GoogleSeen {
  exchanges: URLSearchParams[];
  refreshes: string[];
  revoked: string[];
  reportQueries: string[];
}

/**
 * Google's OAuth endpoints, tokeninfo, Google Ads and AdSense. `refreshToken` is what a code
 * exchange hands out (null: none, as on a repeat consent); `rotateTo` is what a refresh hands back.
 */
function googlePlatform(seen: GoogleSeen, opts: { refreshToken?: string | null; rotateTo?: string; sub?: string | null; accounts?: string[]; refreshFails?: boolean } = {}): FetchLike {
  return async (input, init) => {
    const u = new URL(String(input));
    if (u.host === "oauth2.googleapis.com" && u.pathname === "/token") {
      const form = new URLSearchParams(String(init?.body));
      if (form.get("grant_type") === "authorization_code") {
        seen.exchanges.push(form);
        const refresh = opts.refreshToken === undefined ? "G_REFRESH_1" : opts.refreshToken;
        const scope = form.get("redirect_uri")!.includes("/adsense/") ? "https://www.googleapis.com/auth/adsense.readonly" : "https://www.googleapis.com/auth/adwords";
        return json({ access_token: "G_ACCESS", expires_in: 3599, scope, ...(refresh ? { refresh_token: refresh } : {}) });
      }
      seen.refreshes.push(form.get("refresh_token")!);
      if (opts.refreshFails) return json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400);
      return json({ access_token: "G_ACCESS_2", expires_in: 3599, ...(opts.rotateTo ? { refresh_token: opts.rotateTo } : {}) });
    }
    if (u.host === "oauth2.googleapis.com" && u.pathname === "/tokeninfo") {
      return opts.sub === null ? json({ error: "invalid_token" }, 400) : json({ aud: "g_client", sub: opts.sub ?? "100200300", scope: "x" });
    }
    if (u.host === "oauth2.googleapis.com" && u.pathname === "/revoke") {
      seen.revoked.push(new URLSearchParams(String(init?.body)).get("token")!);
      return new Response("{}", { status: 200 });
    }
    if (u.pathname.endsWith("customers:listAccessibleCustomers")) return json({ resourceNames: (opts.accounts ?? ["111"]).map((a) => `customers/${a}`) });
    if (u.pathname.endsWith("googleAds:searchStream")) {
      const id = u.pathname.split("/")[3]!;
      const query = (JSON.parse(String(init?.body)) as { query: string }).query;
      if (query.endsWith("FROM customer")) return json([{ results: [{ customer: { id, descriptiveName: `Account ${id}`, currencyCode: "USD", timeZone: "UTC", manager: false } }] }]);
      seen.reportQueries.push(query);
      if (query.startsWith("SELECT metrics.")) return json([{ results: [{ metrics: { costMicros: "30000000", impressions: "3000", clicks: "60", conversions: 3, conversionsValue: 150 } }] }]);
      return json([{ results: [{ campaign: { id: "7", name: "Search - brand", status: "ENABLED", advertisingChannelType: "SEARCH" }, campaignBudget: { amountMicros: "10000000" }, metrics: { costMicros: "30000000", impressions: "3000", clicks: "60", conversions: 3, conversionsValue: 150 } }] }]);
    }
    if (u.host === "adsense.googleapis.com" && u.pathname === "/v2/accounts") return json({ accounts: [{ name: "accounts/pub-77", displayName: "Shop site", timeZone: { id: "UTC" }, state: "READY" }] });
    return json({ error: { message: `unexpected ${u.host}${u.pathname}` } }, 400);
  };
}

/** Meta's token endpoints, permissions, /me and two ad accounts; records permission revocations. */
function metaPlatform(revoked: string[]): FetchLike {
  return async (input, init) => {
    const u = new URL(String(input));
    if (u.pathname.endsWith("/oauth/access_token")) {
      return u.searchParams.get("grant_type") === "fb_exchange_token" ? json({ access_token: "META_LONG", expires_in: 5_184_000 }) : json({ access_token: "META_SHORT", expires_in: 3600 });
    }
    if (u.pathname.endsWith("/me/permissions/ads_read") && init?.method === "DELETE") {
      revoked.push(new Headers(init.headers).get("authorization")!.replace(/^Bearer /, ""));
      return json({ success: true });
    }
    if (u.pathname.endsWith("/me/permissions")) return json({ data: [{ permission: "ads_read", status: "granted" }] });
    if (u.pathname.endsWith("/me")) return json({ id: "5550001" });
    if (u.pathname.endsWith("/me/adaccounts")) {
      return json({ data: [{ id: "act_1", name: "Shop ads", currency: "USD", timezone_name: "UTC" }, { id: "act_2", name: "EU ads", currency: "EUR", timezone_name: "Europe/Paris" }] });
    }
    return json({ error: { message: `unexpected ${u.pathname}` } }, 400);
  };
}

let headers: Record<string, string>;
let cookie: string;
let ws: string;
let storeId: string;

beforeEach(async () => {
  await clean(ctx);
  ctx.setEnv(KEYS);
  const u = await signIn(ctx, "ads-life-owner", "owner@x.com");
  headers = u.headers;
  cookie = u.cookie;
  ws = await createWorkspace(ctx, headers);
  storeId = (await createStore(ws, "ads-life.myshopify.com", ["read_orders"], { currency: "USD" })).id;
});

/** Start a connect for `store` and follow the platform back to our callback; when it offers a choice, take every account. */
async function connect(provider: "meta" | "google" | "adsense", store = storeId) {
  const start = await ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/stores/${store}/ads/${provider}/connect`, headers });
  expect(start.statusCode).toBe(200);
  const url = new URL(start.json().url);
  const state = url.searchParams.get("state")!;
  const cb = await ctx.app.inject({ method: "GET", url: `/ads/${provider}/callback?${new URLSearchParams({ state, code: "CODE" })}`, headers: { cookie: `${cookie}; ads_oauth_state=${state}` } });
  expect(cb.statusCode).toBe(302);
  const location = new URL(cb.headers.location as string);
  const pick = location.searchParams.get("choose");
  if (pick) {
    const pending = `/workspaces/${ws}/stores/${store}/ads/pending/${pick}`;
    const list = await ctx.app.inject({ method: "GET", url: pending, headers });
    const ids = (list.json().accounts as Array<{ accountId: string }>).map((a) => a.accountId);
    expect((await ctx.app.inject({ method: "POST", url: pending, headers, payload: { accountIds: ids } })).statusCode).toBe(200);
  }
  return { url, location };
}

/** Start a connect for `store` and follow the platform back to our callback, choosing nothing: where it sends the browser. */
async function signInBack(provider: "meta" | "google" | "adsense", store = storeId) {
  const start = await ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/stores/${store}/ads/${provider}/connect`, headers });
  expect(start.statusCode).toBe(200);
  const state = new URL(start.json().url).searchParams.get("state")!;
  const cb = await ctx.app.inject({ method: "GET", url: `/ads/${provider}/callback?${new URLSearchParams({ state, code: "CODE" })}`, headers: { cookie: `${cookie}; ads_oauth_state=${state}` } });
  expect(cb.statusCode).toBe(302);
  return new URL(cb.headers.location as string);
}

const disconnect = (id: string, store = storeId) => ctx.app.inject({ method: "DELETE", url: `/workspaces/${ws}/stores/${store}/ads/connections/${id}`, headers });
const fresh = (): GoogleSeen => ({ exchanges: [], refreshes: [], revoked: [], reportQueries: [] });
const expire = (ids: string[]) => systemDb.adConnection.updateMany({ where: { id: { in: ids } }, data: { accessTokenExpiresAt: new Date(Date.now() - 60_000) } });

describe("Continue with Google Ads: the sign-in", () => {
  it("PKCE ties the code to this sign-in; who signed in and what they granted are kept; the browser never sees a token", async () => {
    const seen = fresh();
    ctx.setFetch(googlePlatform(seen));
    const { url, location } = await connect("google");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.pathname).toBe("/dashboard");
    // The verifier was never in the browser, yet the exchange carried the one that matches the challenge.
    const verifier = seen.exchanges[0]!.get("code_verifier")!;
    expect(verifier).toBeTruthy();
    expect(pkceChallenge(verifier)).toBe(url.searchParams.get("code_challenge"));
    expect(url.toString()).not.toContain(verifier);

    const row = await systemDb.adConnection.findFirstOrThrow({ where: { storeId, provider: "google" } });
    expect(row).toMatchObject({ accountId: "111", externalUserId: "100200300", grantedScopes: ["https://www.googleapis.com/auth/adwords"] });
    const list = await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${storeId}/ads`, headers });
    expect(list.json().connections[0]).toMatchObject({ provider: "google", status: "active", grantedScopes: ["https://www.googleapis.com/auth/adwords"] });
    expect(list.body).not.toContain("G_REFRESH_1");
    expect(list.body).not.toContain("G_ACCESS");
    expect(list.body).not.toContain("100200300");
  });

  it("someone who gave bizinsights a working refresh token skips Google's consent screen and theirs is reused; a login it holds none for is asked with the consent screen", async () => {
    const seen = fresh();
    ctx.setFetch(googlePlatform(seen));
    const first = await connect("google");
    // The first time: the consent screen, which hands out a refresh token.
    expect(first.url.searchParams.get("prompt")).toBe("select_account consent");
    const second = (await createStore(ws, "ads-life-2.myshopify.com", ["read_orders"], { currency: "USD" })).id;
    const repeat = googlePlatform(seen, { refreshToken: null });
    ctx.setFetch(repeat);
    const { url, location } = await connect("google", second);
    // Each consent makes Google hand out another refresh token, and it ends a login's oldest past 100:
    // only the account chooser this time, and Google sends none.
    expect(url.searchParams.get("prompt")).toBe("select_account");
    expect(location.pathname).toBe("/dashboard");
    const row = await systemDb.adConnection.findFirstOrThrow({ where: { storeId: second, provider: "google" } });
    await expire([row.id]);
    await adAccessToken(await systemDb.adConnection.findUniqueOrThrow({ where: { id: row.id } }), repeat);
    expect(seen.refreshes).toEqual(["G_REFRESH_1"]);

    // They pick another Google login, one bizinsights holds no refresh token for: Google sent none.
    ctx.setFetch(googlePlatform(fresh(), { refreshToken: null, sub: "999" }));
    const third = (await createStore(ws, "ads-life-3.myshopify.com", ["read_orders"], { currency: "USD" })).id;
    const start = await ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/stores/${third}/ads/google/connect`, headers });
    const state = new URL(start.json().url).searchParams.get("state")!;
    const cb = await ctx.app.inject({ method: "GET", url: `/ads/google/callback?state=${state}&code=C`, headers: { cookie: `${cookie}; ads_oauth_state=${state}` } });
    // Sent back to Google, with the consent screen this time, under a new state for this browser.
    const again = new URL(cb.headers.location as string);
    expect(again.origin).toBe("https://accounts.google.com");
    expect(again.searchParams.get("prompt")).toBe("select_account consent");
    const state2 = again.searchParams.get("state")!;
    expect(state2).not.toBe(state);
    // (The used state's removal comes first; the browser keeps the last value set.)
    const jar = [...String(cb.headers["set-cookie"]).matchAll(/ads_oauth_state=([^;]*)/g)].map((m) => m[1]);
    expect(jar.at(-1)).toContain(state2);
    expect(await systemDb.adConnection.count({ where: { storeId: third } })).toBe(0);
    // Google still sending none after its consent screen: the person is told to try again.
    const cb2 = await ctx.app.inject({ method: "GET", url: `/ads/google/callback?state=${state2}&code=C2`, headers: { cookie: `${cookie}; ads_oauth_state=${state2}` } });
    expect(new URL(cb2.headers.location as string).searchParams.get("error")).toBe("no_refresh_token");

    // With it, the login connects.
    ctx.setFetch(googlePlatform(fresh(), { refreshToken: "G_REFRESH_999", sub: "999" }));
    const start3 = await ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/stores/${third}/ads/google/connect`, headers });
    const s3 = new URL(start3.json().url).searchParams.get("state")!;
    const bounce = await ctx.app.inject({ method: "GET", url: `/ads/google/callback?state=${s3}&code=C3`, headers: { cookie: `${cookie}; ads_oauth_state=${s3}` } });
    expect(new URL(bounce.headers.location as string).pathname).toBe("/dashboard");
    expect((await systemDb.adConnection.findFirstOrThrow({ where: { storeId: third } })).externalUserId).toBe("999");
  });

  it("a refresh token Google replaces is stored for every account that shares it", async () => {
    const seen = fresh();
    const rotating = googlePlatform(seen, { accounts: ["111", "222"], rotateTo: "G_REFRESH_2" });
    ctx.setFetch(rotating);
    await connect("google");
    const rows = await systemDb.adConnection.findMany({ where: { storeId, provider: "google" }, orderBy: { accountId: "asc" } });
    expect(rows).toHaveLength(2);
    await expire(rows.map((r) => r.id));
    await adAccessToken(await systemDb.adConnection.findUniqueOrThrow({ where: { id: rows[0]!.id } }), rotating);
    // The other account got the new access token too; once that runs out, it refreshes with the replacement, not the retired token.
    const second = await systemDb.adConnection.findUniqueOrThrow({ where: { id: rows[1]!.id } });
    expect(second.accessTokenExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    await expire([second.id]);
    await adAccessToken(await systemDb.adConnection.findUniqueOrThrow({ where: { id: second.id } }), googlePlatform(seen));
    expect(seen.refreshes).toEqual(["G_REFRESH_1", "G_REFRESH_2"]);
  });
});

describe("Google Ads before Google approves bizinsights for real accounts", () => {
  it("is 'Coming soon' until switched on, and a Test-access project is named as the reason, not 'no accounts'", async () => {
    ctx.setEnv({ ...KEYS, GOOGLE_ADS_ENABLED: "" });
    const list = await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${storeId}/ads`, headers });
    expect(list.json().configured).toMatchObject({ google: false, adsense: true });
    expect((await ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/stores/${storeId}/ads/google/connect`, headers })).statusCode).toBe(503);

    ctx.setEnv(KEYS);
    const seen = fresh();
    const base = googlePlatform(seen);
    ctx.setFetch(async (input, init) => {
      const u = new URL(String(input));
      if (u.pathname.endsWith("googleAds:searchStream")) {
        return json([{ error: { code: 403, message: "denied", status: "PERMISSION_DENIED", details: [{ errors: [{ errorCode: { authorizationError: "CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION" } }] }] } }], 403);
      }
      return base(input, init);
    });
    const start = await ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/stores/${storeId}/ads/google/connect`, headers });
    const state = new URL(start.json().url).searchParams.get("state")!;
    const cb = await ctx.app.inject({ method: "GET", url: `/ads/google/callback?state=${state}&code=C`, headers: { cookie: `${cookie}; ads_oauth_state=${state}` } });
    const location = new URL(cb.headers.location as string);
    expect(location.pathname).toBe("/settings/ads");
    expect(location.searchParams.get("error")).toBe("not_approved");
    expect(location.searchParams.get("provider")).toBe("google");
    expect(await systemDb.adConnection.count()).toBe(0);
  });
});

describe("the sign-in's state cookie", () => {
  /** The ads_oauth_state value a response sets, if any. */
  const stateCookie = (res: { headers: Record<string, string> }) => /ads_oauth_state=([^;]*)/.exec(res.headers["set-cookie"] ?? "")?.[1] ?? null;

  it("pressing the button twice doesn't void the first sign-in: either can come back, once each, only to this browser", async () => {
    const seen = fresh();
    ctx.setFetch(googlePlatform(seen));
    const press = (cookieJar: string | null) =>
      ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/stores/${storeId}/ads/google/connect`, headers: cookieJar ? { ...headers, cookie: `${cookie}; ads_oauth_state=${cookieJar}` } : headers });
    const first = await press(null);
    const jar1 = stateCookie(first)!;
    const second = await press(jar1);
    const jar2 = stateCookie(second)!;
    const s1 = new URL(first.json().url).searchParams.get("state")!;
    const s2 = new URL(second.json().url).searchParams.get("state")!;
    expect(jar2.split(".")).toEqual([s2, s1]);

    // The person finishes the FIRST sign-in (the second tab was abandoned).
    const back = (state: string, jar: string) => ctx.app.inject({ method: "GET", url: `/ads/google/callback?state=${state}&code=C`, headers: { cookie: `${cookie}; ads_oauth_state=${jar}` } });
    const done = await back(s1, jar2);
    expect(new URL(done.headers.location as string).pathname).toBe("/dashboard");
    // The used one is gone; the other is still pending for this browser.
    expect(stateCookie(done)).toBe(s2);
    // Replaying the first is refused; a state this browser never started is refused.
    expect(new URL((await back(s1, s2)).headers.location as string).searchParams.get("error")).toBe("state_mismatch");
    expect(new URL((await back(s2, "someone-elses-state-0123456789ab")).headers.location as string).searchParams.get("error")).toBe("state_mismatch");
  });
});

describe("disconnecting gives access back to the platform, only when nothing else relies on it", () => {
  it("Google: Google Ads and AdSense share one person's grant, so it is revoked with the last of them", async () => {
    const seen = fresh();
    ctx.setFetch(googlePlatform(seen));
    await connect("google");
    await connect("adsense");
    const g = await systemDb.adConnection.findFirstOrThrow({ where: { storeId, provider: "google" } });
    const a = await systemDb.adConnection.findFirstOrThrow({ where: { storeId, provider: "adsense" } });
    const first = await disconnect(g.id);
    expect(first.json()).toEqual({ ok: true, revoked: "still_used" });
    expect(seen.revoked).toEqual([]);
    const last = await disconnect(a.id);
    expect(last.json()).toEqual({ ok: true, revoked: "revoked" });
    expect(seen.revoked).toEqual(["G_REFRESH_1"]);
    expect(await systemDb.adConnection.count()).toBe(0);
    const audit = await systemDb.auditLog.findMany({ where: { action: "ads.disconnected" }, orderBy: { createdAt: "asc" } });
    expect(audit.map((x) => (x.metadata as { revoked: string }).revoked)).toEqual(["still_used", "revoked"]);
  });

  it("Meta: ads_read is dropped (and nothing else) when the last account from that login goes", async () => {
    const revoked: string[] = [];
    ctx.setFetch(metaPlatform(revoked));
    await connect("meta");
    const rows = await systemDb.adConnection.findMany({ where: { storeId, provider: "meta" }, orderBy: { accountId: "asc" } });
    expect(rows.map((r) => r.externalUserId)).toEqual(["5550001", "5550001"]);
    expect((await disconnect(rows[0]!.id)).json().revoked).toBe("still_used");
    expect(revoked).toEqual([]);
    expect((await disconnect(rows[1]!.id)).json().revoked).toBe("revoked");
    expect(revoked).toEqual(["META_LONG"]);
  });

  it("when Google wouldn't say who signed in, nothing is revoked (it can't be told whether another connection relies on it)", async () => {
    const seen = fresh();
    ctx.setFetch(googlePlatform(seen, { sub: null }));
    await connect("google");
    const g = await systemDb.adConnection.findFirstOrThrow({ where: { storeId, provider: "google" } });
    expect(g.externalUserId).toBeNull();
    expect((await disconnect(g.id)).json()).toEqual({ ok: true, revoked: "unknown_person" });
    expect(seen.revoked).toEqual([]);
  });
});

describe("review fixes: grants nobody can vouch for are never revoked", () => {
  it("an older AdSense connection with no known person keeps the grant; it learns its person at its next refresh", async () => {
    const seen = fresh();
    // The older connection: made before identities were kept (tokeninfo didn't say).
    ctx.setFetch(googlePlatform(seen, { sub: null }));
    await connect("adsense");
    const old = await systemDb.adConnection.findFirstOrThrow({ where: { storeId, provider: "adsense" } });
    expect(old.externalUserId).toBeNull();
    // The same person connects Google Ads now, and their sub is known.
    ctx.setFetch(googlePlatform(seen));
    await connect("google");
    const g = await systemDb.adConnection.findFirstOrThrow({ where: { storeId, provider: "google" } });
    expect(g.externalUserId).toBe("100200300");
    expect((await disconnect(g.id)).json().revoked).toBe("still_used");
    expect(seen.revoked).toEqual([]);

    // The older row's next refresh learns who granted it.
    await expire([old.id]);
    await adAccessToken(await systemDb.adConnection.findUniqueOrThrow({ where: { id: old.id } }), googlePlatform(seen));
    expect((await systemDb.adConnection.findUniqueOrThrow({ where: { id: old.id } })).externalUserId).toBe("100200300");
  });

  it("a reconnect whose person can't be looked up forgets the previous person instead of inheriting them", async () => {
    ctx.setFetch(googlePlatform(fresh()));
    await connect("google");
    expect((await systemDb.adConnection.findFirstOrThrow({ where: { storeId, provider: "google" } })).externalUserId).toBe("100200300");
    const seen = fresh();
    ctx.setFetch(googlePlatform(seen, { sub: null, refreshToken: "G_REFRESH_OTHER" }));
    await connect("google");
    const row = await systemDb.adConnection.findFirstOrThrow({ where: { storeId, provider: "google" } });
    expect(row.externalUserId).toBeNull();
    expect((await disconnect(row.id)).json().revoked).toBe("unknown_person");
    expect(seen.revoked).toEqual([]);
  });

  it("a Google login with no Google Ads account is told so, not 'try again'", async () => {
    const base = googlePlatform(fresh());
    ctx.setFetch(async (input, init) => {
      const u = new URL(String(input));
      if (u.pathname.endsWith("customers:listAccessibleCustomers")) {
        return json({ error: { code: 401, message: "The user's Google Account isn't associated with any Google Ads accounts.", status: "UNAUTHENTICATED", details: [{ errors: [{ errorCode: { authenticationError: "NOT_ADS_USER" } }] }] } }, 401);
      }
      return base(input, init);
    });
    const start = await ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/stores/${storeId}/ads/google/connect`, headers });
    const state = new URL(start.json().url).searchParams.get("state")!;
    const cb = await ctx.app.inject({ method: "GET", url: `/ads/google/callback?state=${state}&code=C`, headers: { cookie: `${cookie}; ads_oauth_state=${state}` } });
    expect(new URL(cb.headers.location as string).searchParams.get("error")).toBe("no_accounts");
  });

  it("a login that reaches only an empty manager account, or an account Google won't report on yet, is told which", async () => {
    const base = googlePlatform(fresh());
    const callbackError = async (searchStream: (query: string) => Response) => {
      ctx.setFetch(async (input, init) => {
        const u = new URL(String(input));
        if (u.pathname.endsWith("googleAds:searchStream")) return searchStream((JSON.parse(String(init?.body)) as { query: string }).query);
        return base(input, init);
      });
      const start = await ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/stores/${storeId}/ads/google/connect`, headers });
      const state = new URL(start.json().url).searchParams.get("state")!;
      const cb = await ctx.app.inject({ method: "GET", url: `/ads/google/callback?state=${state}&code=C`, headers: { cookie: `${cookie}; ads_oauth_state=${state}` } });
      return new URL(cb.headers.location as string).searchParams.get("error");
    };
    const managerOnly = await callbackError((q) => (q.endsWith("FROM customer") ? json([{ results: [{ customer: { id: "111", descriptiveName: "Manager", manager: true } }] }]) : json([{ results: [] }])));
    expect(managerOnly).toBe("manager_only");
    const notReady = await callbackError(() => json([{ error: { message: "The customer account can't be accessed because it is not yet enabled or has been deactivated.", status: "PERMISSION_DENIED" } }], 403));
    expect(notReady).toBe("account_not_ready");
    expect(await systemDb.adConnection.count()).toBe(0);
  });
});

describe("Continue with Meta Ads: a login with no ad account yet", () => {
  /**
   * Meta for a login whose /me/adaccounts lists `accounts` (none: the token inspector answers
   * `granular`), or doesn't answer (`down`), or no longer takes the token (`ended`).
   */
  const metaWith = (
    revoked: string[],
    opts: { accounts?: Array<{ id: string; name: string }>; granular?: Array<{ scope: string; target_ids?: string[] }>; down?: boolean; ended?: boolean } = {},
  ): FetchLike => {
    const base = metaPlatform(revoked);
    return async (input, init) => {
      const u = new URL(String(input));
      if (u.pathname.endsWith("/me/adaccounts")) {
        if (opts.ended) return json({ error: { message: "Error validating access token: Session has expired", type: "OAuthException", code: 190 } }, 400);
        if (opts.down) return json({ error: { message: "An unexpected error has occurred. Please retry your request later.", type: "OAuthException", code: 2 } }, 500);
        return json({ data: (opts.accounts ?? []).map((a) => ({ ...a, currency: "USD", timezone_name: "UTC", account_status: 1 })) });
      }
      if (u.pathname.endsWith("/debug_token")) return json({ data: { is_valid: true, granular_scopes: opts.granular ?? [{ scope: "ads_read" }] } });
      return base(input, init);
    };
  };
  const listed = async () => (await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${storeId}/ads`, headers })).json();
  const logins = async () => (await listed()).logins as Array<{ id: string; reason: string }>;
  const loginUrl = (id: string) => `/workspaces/${ws}/stores/${storeId}/ads/logins/${id}`;
  const deps = (fetchImpl: FetchLike) => ({ coord: ctx.deps.coord, queues: ctx.deps.queues, fetchImpl });

  it("stays connected, never refused, saying whether the login reaches no ad account or shared none on Facebook's screen", async () => {
    const revoked: string[] = [];
    ctx.setFetch(metaWith(revoked));
    const first = await signInBack("meta");
    expect(first.pathname).toBe("/settings/ads");
    expect(Object.fromEntries(first.searchParams)).toEqual({ waiting: "no_ads_account", provider: "meta", store: storeId });
    // The login holds bizinsights' own token, sealed like a connection's; nothing of Nango.
    const row = await systemDb.adLogin.findFirstOrThrow({ where: { storeId } });
    expect(row).toMatchObject({ provider: "meta", reason: "no_ads_account", sourceLoginId: null, nangoIntegrationKey: null, externalUserId: "5550001", grantedScopes: ["ads_read"] });
    expect(row.accessTokenEnc).toMatch(/^v\d+\./);
    expect(row.accessTokenEnc).not.toContain("META_LONG");
    expect(row.accessTokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 59 * 86_400_000);
    expect((await systemDb.auditLog.findFirstOrThrow({ where: { action: "ads.login_connected" } })).metadata).toEqual({ provider: "meta", reason: "no_ads_account" });
    // Kept, so its grant isn't given back.
    expect(revoked).toEqual([]);

    // A second sign-in replaces it; the first one's grant is kept, since the same person's new login relies on it.
    ctx.setFetch(metaWith(revoked, { granular: [{ scope: "ads_read", target_ids: [] }] }));
    const second = await signInBack("meta");
    expect(second.searchParams.get("waiting")).toBe("none_shared");
    expect(await systemDb.adLogin.findMany({ where: { storeId } })).toEqual([expect.objectContaining({ id: row.id, reason: "none_shared", sourceLoginId: null, externalUserId: "5550001" })]);
    expect(revoked).toEqual([]);
    expect(await systemDb.adConnection.count()).toBe(0);
  });

  it("names the Facebook login on the card and logs what Meta said about it, without the name", async () => {
    const base = metaPlatform([]);
    ctx.setFetch(async (input, init) => {
      const u = new URL(String(input));
      if (u.pathname.endsWith("/me/adaccounts")) return json({ data: [] });
      if (u.pathname.endsWith("/me") && u.searchParams.get("fields") === "id,name") return json({ id: "5550001", name: "Sebastian Thomas" });
      if (u.pathname.endsWith("/debug_token")) return json({ data: { type: "USER", is_valid: true, user_id: "5550001", scopes: ["ads_read"], granular_scopes: [{ scope: "ads_read" }] } });
      if (u.pathname.endsWith("/roles")) return json({ data: [{ user: "5550001", role: "administrators" }] });
      return base(input, init);
    });
    const logged: unknown[][] = [];
    const info = vi.spyOn(logger, "info").mockImplementation((...a: unknown[]) => void logged.push(a));
    let back: URL | undefined;
    try {
      back = await signInBack("meta");
    } finally {
      info.mockRestore();
    }
    expect(back!.searchParams.get("waiting")).toBe("no_ads_account");
    const line = logged.find((a) => a[1] === "ads: nothing to connect for this login");
    expect(line?.[0]).toMatchObject({ reason: "no_ads_account", provider: "meta", diagnosis: { metaUserId: "5550001", appRole: "administrators", token: { type: "USER", granted: { ads_read: "all" } } } });
    expect(JSON.stringify(line?.[0])).not.toContain("Sebastian");
    const list = await listed();
    expect(list.connections).toEqual([]);
    expect(list.logins).toEqual([expect.objectContaining({ provider: "meta", name: "Sebastian Thomas", reason: "no_ads_account", connectedBy: expect.objectContaining({ you: true }) })]);
    // Never a token or the platform's ids.
    expect(JSON.stringify(list.logins)).not.toMatch(/5550001|sourceLoginId|nango|Enc|META_LONG/i);
    expect(await systemDb.adConnection.count()).toBe(0);
  });

  it("'Check for ad accounts' asks Meta now and connects what it lists; the login's row goes, its grant stays with the accounts", async () => {
    const revoked: string[] = [];
    ctx.setFetch(metaWith(revoked));
    await signInBack("meta");
    const [login] = await logins();
    const check = (h = headers) => ctx.app.inject({ method: "POST", url: `${loginUrl(login!.id)}/check`, headers: h, payload: {} });
    expect((await check()).json()).toEqual({ waiting: true, reason: "no_ads_account" });
    // Only its workspace can ask.
    const other = await signIn(ctx, "ads-life-other", "other@x.com");
    expect((await check(other.headers)).statusCode).toBe(404);

    // The person gets an ad account.
    ctx.setFetch(metaWith(revoked, { accounts: [{ id: "act_9", name: "New ads" }] }));
    ctx.deps.queues.clear();
    expect((await check()).json()).toEqual({ connected: 1 });
    const row = await systemDb.adConnection.findFirstOrThrow({ where: { storeId } });
    expect(row).toMatchObject({ provider: "meta", accountId: "act_9", source: "direct", sourceLoginId: null, externalUserId: "5550001" });
    expect(await adAccessToken(row)).toBe("META_LONG");
    expect(await logins()).toEqual([]);
    expect(ctx.deps.queues.sent.sync).toEqual([expect.objectContaining({ kind: "ads", connectionId: row.id })]);
    expect(revoked).toEqual([]);
  });

  it("the cron tick connects them by itself, and leaves more than it connects unasked for the person's choice", async () => {
    ctx.setFetch(metaWith([]));
    await signInBack("meta");
    const later = Date.now() + 2 * 3600_000;
    // Not due yet: nothing is asked.
    expect(await checkAdLogins(deps(metaWith([])))).toEqual({ checked: 0, connected: 0, ended: 0 });
    const eleven = Array.from({ length: 11 }, (_, i) => ({ id: `act_${i + 1}`, name: `Ads ${i + 1}` }));
    expect(await checkAdLogins(deps(metaWith([], { accounts: eleven })), { now: later })).toEqual({ checked: 1, connected: 0, ended: 0 });
    expect((await logins())[0]).toMatchObject({ reason: "choose" });
    expect(await systemDb.adConnection.count()).toBe(0);
    const two = [
      { id: "act_1", name: "Shop ads" },
      { id: "act_2", name: "EU ads" },
    ];
    expect(await checkAdLogins(deps(metaWith([], { accounts: two })), { now: later + 2 * 3600_000 })).toEqual({ checked: 1, connected: 1, ended: 0 });
    expect((await systemDb.adConnection.findMany({ where: { storeId }, orderBy: { accountId: "asc" } })).map((r) => [r.accountId, r.source])).toEqual([
      ["act_1", "direct"],
      ["act_2", "direct"],
    ]);
    expect(await logins()).toEqual([]);
  });

  it("Meta not answering in time keeps the login too, asked again sooner; an access that ended lets it go", async () => {
    ctx.setFetch(metaWith([], { down: true }));
    expect((await signInBack("meta")).searchParams.get("waiting")).toBe("unanswered");
    expect(await checkAdLogins(deps(metaWith([], { down: true })), { now: Date.now() + 15 * 60_000 })).toEqual({ checked: 1, connected: 0, ended: 0 });
    // Meta no longer takes the token: nothing left to wait with.
    expect(await checkAdLogins(deps(metaWith([], { ended: true })), { now: Date.now() + 30 * 60_000 })).toEqual({ checked: 1, connected: 0, ended: 1 });
    expect(await logins()).toEqual([]);
  });

  it("disconnecting it gives the grant back; only its workspace can", async () => {
    const revoked: string[] = [];
    ctx.setFetch(metaWith(revoked));
    await signInBack("meta");
    const [login] = await logins();
    const other = await signIn(ctx, "ads-life-other", "other@x.com");
    expect((await ctx.app.inject({ method: "DELETE", url: loginUrl(login!.id), headers: other.headers })).statusCode).toBe(404);
    const del = await ctx.app.inject({ method: "DELETE", url: loginUrl(login!.id), headers });
    expect(del.json()).toEqual({ ok: true, revoked: "revoked" });
    expect(revoked).toEqual(["META_LONG"]);
    expect(await logins()).toEqual([]);
    expect((await systemDb.auditLog.findFirstOrThrow({ where: { action: "ads.login_disconnected" } })).metadata).toEqual({ provider: "meta", revoked: "revoked" });
  });

  it("is let go once accounts are connected with another sign-in, keeping the person's grant for them", async () => {
    const revoked: string[] = [];
    ctx.setFetch(metaWith(revoked));
    await signInBack("meta");
    ctx.setFetch(metaWith(revoked, { accounts: [{ id: "act_1", name: "Shop ads" }] }));
    expect((await signInBack("meta")).pathname).toBe("/dashboard");
    expect(await logins()).toEqual([]);
    expect(revoked).toEqual([]);
    expect(await systemDb.adConnection.count()).toBe(1);
  });

  it("goes when the person removes bizinsights on Facebook, or asks for their data to be deleted", async () => {
    ctx.setFetch(metaWith([]));
    await signInBack("meta");
    expect(await metaDeauthorized("5550001", ctx.deps.coord)).toBe(0);
    expect(await logins()).toEqual([]);
    await signInBack("meta");
    expect(await systemDb.adLogin.count()).toBe(1);
    await metaDataDeletion("5550001", ctx.deps.coord);
    expect(await systemDb.adLogin.count()).toBe(0);
  });
});

describe("the Google Ads report", () => {
  const reportUrl = (connection: string, q: Record<string, string> = {}) =>
    `/workspaces/${ws}/stores/${storeId}/ads/google/report?${new URLSearchParams({ connection, from: "2026-09-01", to: "2026-09-30", ...q })}`;

  it("asks Google for exactly those dates: account totals and campaigns with status, type and budget; cached", async () => {
    const seen = fresh();
    ctx.setFetch(googlePlatform(seen));
    await connect("google");
    const conn = await systemDb.adConnection.findFirstOrThrow({ where: { storeId, provider: "google" } });
    const res = await ctx.app.inject({ method: "GET", url: reportUrl(conn.id), headers });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.cached).toBe(false);
    expect(body.account).toMatchObject({ accountId: "111", currency: "USD" });
    expect(body.report.totals).toMatchObject({ spend: 30, impressions: 3000, clicks: 60, conversions: 3, conversionValue: 150, roas: 5 });
    expect(body.report.rows).toEqual([expect.objectContaining({ id: "7", name: "Search - brand", status: "ENABLED", channel: "SEARCH", dailyBudget: 10, spend: 30, cpc: 0.5 })]);
    expect(seen.reportQueries.every((q) => q.includes("BETWEEN '2026-09-01' AND '2026-09-30'"))).toBe(true);
    expect(res.body).not.toContain("G_ACCESS");
    const again = await ctx.app.inject({ method: "GET", url: reportUrl(conn.id), headers });
    expect(again.json().cached).toBe(true);
    expect(seen.reportQueries).toHaveLength(2);
  });

  it("is only for the workspace and store the account belongs to, refuses unknown levels and bad dates", async () => {
    ctx.setFetch(googlePlatform(fresh()));
    await connect("google");
    const conn = await systemDb.adConnection.findFirstOrThrow({ where: { storeId, provider: "google" } });
    const other = await signIn(ctx, "ads-life-other", "other@x.com");
    const otherWs = await createWorkspace(ctx, other.headers, "Other");
    const otherStore = (await createStore(otherWs, "ads-life-other.myshopify.com", ["read_orders"])).id;
    const cross = await ctx.app.inject({ method: "GET", url: `/workspaces/${otherWs}/stores/${otherStore}/ads/google/report?connection=${conn.id}&from=2026-09-01&to=2026-09-30`, headers: other.headers });
    expect(cross.statusCode).toBe(404);
    // Someone outside the workspace can't tell it exists.
    expect((await ctx.app.inject({ method: "GET", url: reportUrl(conn.id), headers: other.headers })).statusCode).toBe(404);
    const bad: Array<Record<string, string>> = [{ level: "keyword" }, { from: "2026-09-30", to: "2026-09-01" }, { from: "2026-02-31" }];
    for (const q of bad) {
      expect((await ctx.app.inject({ method: "GET", url: reportUrl(conn.id, q), headers })).statusCode).toBe(400);
    }
    for (const level of ["ad_group", "device", "country"]) {
      expect((await ctx.app.inject({ method: "GET", url: reportUrl(conn.id, { level }), headers })).statusCode).toBe(200);
    }
  });

  it("access Google took back marks the account 'reconnect' and says so, instead of showing old numbers", async () => {
    ctx.setFetch(googlePlatform(fresh()));
    await connect("google");
    const conn = await systemDb.adConnection.findFirstOrThrow({ where: { storeId, provider: "google" } });
    await expire([conn.id]);
    ctx.setFetch(googlePlatform(fresh(), { refreshFails: true }));
    const res = await ctx.app.inject({ method: "GET", url: reportUrl(conn.id), headers });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("reconnect");
    expect((await systemDb.adConnection.findUniqueOrThrow({ where: { id: conn.id } })).status).toBe("reconnect");
  });
});

describe("the Meta Ads report's splits", () => {
  it("placement, device and country are accepted views", async () => {
    const revoked: string[] = [];
    ctx.setFetch(async (input, init) => {
      const u = new URL(String(input));
      if (u.pathname.endsWith("/act_1/insights")) {
        const b = u.searchParams.get("breakdowns");
        if (!b) return json({ data: [{ spend: "10", impressions: "100", reach: "50" }] });
        return json({ data: [{ publisher_platform: "facebook", platform_position: "feed", impression_device: "iphone", country: "AU", spend: "10", impressions: "100", reach: "50" }] });
      }
      return metaPlatform(revoked)(input, init);
    });
    await connect("meta");
    const conn = await systemDb.adConnection.findFirstOrThrow({ where: { storeId, accountId: "act_1" } });
    const names: string[] = [];
    for (const level of ["placement", "device", "country"]) {
      const res = await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${storeId}/ads/meta/report?connection=${conn.id}&level=${level}&from=2026-09-01&to=2026-09-30`, headers });
      expect(res.statusCode).toBe(200);
      names.push(res.json().report.rows[0].name);
    }
    expect(names).toEqual(["Facebook · Feed", "iPhone", "Australia"]);
  });
});

describe("access given back when nothing uses it", () => {
  it("Meta: a disconnect after the person's token expired takes ads_read back with bizinsights' app token, for that person", async () => {
    const revoked: string[] = [];
    ctx.setFetch(metaPlatform(revoked));
    await connect("meta");
    const rows = await systemDb.adConnection.findMany({ where: { storeId, provider: "meta" }, orderBy: { accountId: "asc" } });
    await disconnect(rows[0]!.id);
    // The other account's token has run out (Meta's last about 60 days).
    await systemDb.adConnection.update({ where: { id: rows[1]!.id }, data: { accessTokenExpiresAt: new Date(Date.now() - 86_400_000) } });
    const appTokenCalls: Array<{ path: string; token: string }> = [];
    ctx.setFetch(async (input, init) => {
      const u = new URL(String(input));
      const token = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
      if (init?.method === "DELETE" && u.pathname.endsWith("/me/permissions/ads_read")) return json({ error: { message: "Error validating access token: Session has expired", type: "OAuthException", code: 190 } }, 400);
      if (init?.method === "DELETE" && u.pathname.endsWith("/5550001/permissions/ads_read")) {
        appTokenCalls.push({ path: u.pathname, token });
        return json({ success: true });
      }
      return json({ error: { message: `unexpected ${u.pathname}` } }, 400);
    });
    const res = await disconnect(rows[1]!.id);
    expect(res.json()).toEqual({ ok: true, revoked: "revoked" });
    expect(appTokenCalls).toEqual([{ path: "/v26.0/5550001/permissions/ads_read", token: "meta_app|meta_secret" }]);
  });

  it("cancelling the account choice gives the sign-in's grant back, unless the same person relies on it elsewhere", async () => {
    const revoked: string[] = [];
    ctx.setFetch(metaPlatform(revoked));
    const start = await ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/stores/${storeId}/ads/meta/connect`, headers });
    const state = new URL(start.json().url).searchParams.get("state")!;
    const cb = await ctx.app.inject({ method: "GET", url: `/ads/meta/callback?${new URLSearchParams({ state, code: "CODE" })}`, headers: { cookie: `${cookie}; ads_oauth_state=${state}` } });
    const pick = new URL(cb.headers.location as string).searchParams.get("choose")!;
    expect(pick).toBeTruthy();
    expect((await ctx.app.inject({ method: "DELETE", url: `/workspaces/${ws}/stores/${storeId}/ads/pending/${pick}`, headers })).json()).toEqual({ ok: true });
    expect(revoked).toEqual(["META_LONG"]);
    expect(await systemDb.adConnection.count()).toBe(0);

    // Connected on another store by the same person: their grant stays when a later choice is cancelled.
    await connect("meta");
    const other = (await createStore(ws, "ads-life-2.myshopify.com", ["read_orders"], { currency: "USD" })).id;
    const start2 = await ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/stores/${other}/ads/meta/connect`, headers });
    const state2 = new URL(start2.json().url).searchParams.get("state")!;
    const cb2 = await ctx.app.inject({ method: "GET", url: `/ads/meta/callback?${new URLSearchParams({ state: state2, code: "CODE" })}`, headers: { cookie: `${cookie}; ads_oauth_state=${state2}` } });
    const pick2 = new URL(cb2.headers.location as string).searchParams.get("choose")!;
    await ctx.app.inject({ method: "DELETE", url: `/workspaces/${ws}/stores/${other}/ads/pending/${pick2}`, headers });
    expect(revoked).toEqual(["META_LONG"]);
  });

  it("a sign-in whose read permission was left unticked gives its grant back", async () => {
    const revoked: string[] = [];
    const base = metaPlatform(revoked);
    ctx.setFetch(async (input, init) => {
      const u = new URL(String(input));
      if (u.pathname.endsWith("/me/permissions")) return json({ data: [{ permission: "public_profile", status: "granted" }, { permission: "ads_read", status: "declined" }] });
      return base(input, init);
    });
    const back = await signInBack("meta");
    expect(Object.fromEntries(back.searchParams)).toEqual({ error: "permission_missing", provider: "meta", store: storeId });
    expect(revoked).toEqual(["META_LONG"]);
    expect(await systemDb.adConnection.count()).toBe(0);
    expect(await systemDb.adLogin.count()).toBe(0);
  });

  it("cancelling one choice keeps the grant while another choice of the same person waits", async () => {
    const revoked: string[] = [];
    ctx.setFetch(metaPlatform(revoked));
    const first = (await signInBack("meta")).searchParams.get("choose")!;
    const second = (await signInBack("meta")).searchParams.get("choose")!;
    expect(first).toBeTruthy();
    expect(second).not.toBe(first);
    const pending = (pick: string) => `/workspaces/${ws}/stores/${storeId}/ads/pending/${pick}`;
    expect((await ctx.app.inject({ method: "DELETE", url: pending(second), headers })).json()).toEqual({ ok: true });
    // The first choice still needs the person's ads_read.
    expect(revoked).toEqual([]);
    const chosen = await ctx.app.inject({ method: "POST", url: pending(first), headers, payload: { accountIds: ["act_1"] } });
    expect(chosen.json()).toEqual({ provider: "meta", connected: 1 });
    expect(revoked).toEqual([]);
  });

  it("a Google sign-in that finds nothing to connect gives its grant back", async () => {
    const seen = fresh();
    const base = googlePlatform(seen);
    ctx.setFetch(async (input, init) => {
      const u = new URL(String(input));
      if (u.pathname.endsWith("customers:listAccessibleCustomers")) return json({ resourceNames: [] });
      return base(input, init);
    });
    const start = await ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/stores/${storeId}/ads/google/connect`, headers });
    const state = new URL(start.json().url).searchParams.get("state")!;
    const cb = await ctx.app.inject({ method: "GET", url: `/ads/google/callback?state=${state}&code=C`, headers: { cookie: `${cookie}; ads_oauth_state=${state}` } });
    expect(new URL(cb.headers.location as string).searchParams.get("error")).toBe("no_accounts");
    expect(seen.revoked).toEqual(["G_REFRESH_1"]);
  });
});

describe("a Google grant that no longer covers reporting", () => {
  it("is found at the token refresh: the connection asks for a reconnect with the permission ticked", async () => {
    const seen = fresh();
    ctx.setFetch(googlePlatform(seen));
    await connect("google");
    const conn = await systemDb.adConnection.findFirstOrThrow({ where: { storeId, provider: "google" } });
    await expire([conn.id]);
    const base = googlePlatform(seen);
    ctx.setFetch(async (input, init) => {
      const u = new URL(String(input));
      // The person unticked the Google Ads permission on Google's own account page: the refresh lists what is left.
      if (u.host === "oauth2.googleapis.com" && u.pathname === "/token") return json({ access_token: "G_ACCESS_2", expires_in: 3599, scope: "openid https://www.googleapis.com/auth/userinfo.email" });
      return base(input, init);
    });
    const res = await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${storeId}/ads/google/report?connection=${conn.id}&from=2026-09-01&to=2026-09-30`, headers });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("reconnect");
    expect(await systemDb.adConnection.findUniqueOrThrow({ where: { id: conn.id } })).toMatchObject({ status: "reconnect", errorCode: "scope_missing" });
    expect(seen.reportQueries).toEqual([]);
  });
});

describe("the Google Ads report compared, and Google's daily allowance", () => {
  const reportUrl = (connection: string, q: Record<string, string> = {}) =>
    `/workspaces/${ws}/stores/${storeId}/ads/google/report?${new URLSearchParams({ connection, from: "2026-09-01", to: "2026-09-30", ...q })}`;

  it("the comparison's dates asked of Google too, its figures by id; the operations counted like a sync's", async () => {
    const seen = fresh();
    ctx.setFetch(googlePlatform(seen));
    await connect("google");
    const conn = await systemDb.adConnection.findFirstOrThrow({ where: { storeId, provider: "google" } });
    const before = await googleAdsOperationsToday(ctx.deps.coord);
    const res = await ctx.app.inject({ method: "GET", url: reportUrl(conn.id, { cfrom: "2026-08-01", cto: "2026-08-31" }), headers });
    expect(res.statusCode).toBe(200);
    expect(res.json().report.comparison).toMatchObject({ since: "2026-08-01", until: "2026-08-31", totals: { spend: 30 }, rows: [{ id: "7", spend: 30, cpc: 0.5 }] });
    expect(res.json().report.comparison.rows[0].name).toBeUndefined();
    expect(seen.reportQueries.some((q) => q.includes("BETWEEN '2026-08-01' AND '2026-08-31'"))).toBe(true);
    expect(await googleAdsOperationsToday(ctx.deps.coord)).toBe(before + seen.reportQueries.length);
  });

  it("a sign-in's account listing counts against the allowance; while it's used up, no sign-in starts, and one started before comes back rate_limited with nothing exchanged", async () => {
    const seen = fresh();
    ctx.setFetch(googlePlatform(seen));
    const before = await googleAdsOperationsToday(ctx.deps.coord);
    await connect("google");
    // listAccessibleCustomers and the one customer's details.
    expect(await googleAdsOperationsToday(ctx.deps.coord)).toBe(before + 2);

    // Started just before the day's allowance ran out.
    const start = await ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/stores/${storeId}/ads/google/connect`, headers });
    const state = new URL(start.json().url).searchParams.get("state")!;
    await pauseGoogleAds(ctx.deps.coord, null);
    const exchanges = seen.exchanges.length;
    const refused = await ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/stores/${storeId}/ads/google/connect`, headers });
    expect(refused.statusCode).toBe(503);
    expect(refused.json()).toEqual({ error: "rate_limited", message: adErrorMessage("quota_exhausted", "google") });
    expect(refused.headers["set-cookie"] ?? "").not.toContain("ads_oauth_state");
    // AdSense doesn't spend Google Ads operations: it still starts.
    expect((await ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/stores/${storeId}/ads/adsense/connect`, headers })).statusCode).toBe(200);
    const cb = await ctx.app.inject({ method: "GET", url: `/ads/google/callback?${new URLSearchParams({ state, code: "CODE" })}`, headers: { cookie: `${cookie}; ads_oauth_state=${state}` } });
    const location = new URL(cb.headers.location as string);
    expect(location.pathname).toBe("/settings/ads");
    expect(Object.fromEntries(location.searchParams)).toEqual({ error: "rate_limited", provider: "google", store: storeId });
    expect(seen.exchanges).toHaveLength(exchanges);
  });

  it("while Google says the day's allowance is used up, the report says so in plain words and asks Google nothing", async () => {
    const seen = fresh();
    ctx.setFetch(googlePlatform(seen));
    await connect("google");
    const conn = await systemDb.adConnection.findFirstOrThrow({ where: { storeId, provider: "google" } });
    await pauseGoogleAds(ctx.deps.coord, null);
    const res = await ctx.app.inject({ method: "GET", url: reportUrl(conn.id), headers });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "quota_exhausted", message: adErrorMessage("quota_exhausted", "google") });
    expect(seen.reportQueries).toEqual([]);
    // bizinsights' limit, not the account's.
    expect((await systemDb.adConnection.findUniqueOrThrow({ where: { id: conn.id } })).status).toBe("active");
  });
});

describe("someone whose login powers ad accounts leaves", () => {
  /** A Meta connection powered by `userId`'s login (Meta's person 5550001), in `store`. */
  async function connectedBy(userId: string, workspaceId: string, store: string, accountId: string) {
    const tokens = encryptAdTokens(store, "meta", { accessToken: "META_LONG", refreshToken: null, expiresAt: new Date(Date.now() + 30 * 86_400_000) });
    return systemDb.adConnection.create({
      data: { workspaceId, storeId: store, provider: "meta", accountId, accountName: accountId, currency: "USD", timezone: "UTC", connectedByUserId: userId, externalUserId: "5550001", ...tokens },
    });
  }

  it("removed from the workspace: the accounts they connected here wait for someone else to reconnect them; elsewhere theirs keep working", async () => {
    const admin = await signIn(ctx, "ads-life-admin", "admin@x.com");
    const member = await systemDb.membership.create({ data: { workspaceId: ws, userId: admin.user.id, role: "admin" } });
    const here = await connectedBy(admin.user.id, ws, storeId, "act_1");
    // Their own business, with their own store: the same Meta login powers it.
    const theirWs = await createWorkspace(ctx, admin.headers, "Admin's own");
    const theirStore = (await createStore(theirWs, "admins-own.myshopify.com", ["read_orders"])).id;
    const theirs = await connectedBy(admin.user.id, theirWs, theirStore, "act_9");
    const revoked: string[] = [];
    ctx.setFetch(metaPlatform(revoked));

    expect((await ctx.app.inject({ method: "DELETE", url: `/workspaces/${ws}/team/members/${member.id}`, headers })).statusCode).toBe(200);
    expect(await systemDb.adConnection.findUniqueOrThrow({ where: { id: here.id } })).toMatchObject({ status: "reconnect", errorCode: "connector_left", accessTokenEnc: "", connectedByUserId: null });
    expect(await systemDb.adConnection.findUniqueOrThrow({ where: { id: theirs.id } })).toMatchObject({ status: "active", connectedByUserId: admin.user.id });
    // Their grant still powers their own store: not taken back.
    expect(revoked).toEqual([]);
    const list = await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${storeId}/ads`, headers });
    expect(list.json().connections[0]).toMatchObject({ status: "reconnect", errorCode: "connector_left", message: expect.stringContaining("no longer has access"), connectedBy: null });
  });

  it("removed through the older members route too", async () => {
    const admin = await signIn(ctx, "ads-life-admin2", "admin2@x.com");
    const member = await systemDb.membership.create({ data: { workspaceId: ws, userId: admin.user.id, role: "admin" } });
    const here = await connectedBy(admin.user.id, ws, storeId, "act_1");
    const revoked: string[] = [];
    ctx.setFetch(metaPlatform(revoked));
    expect((await ctx.app.inject({ method: "DELETE", url: `/workspaces/${ws}/members/${member.id}`, headers })).statusCode).toBe(200);
    expect(await systemDb.adConnection.findUniqueOrThrow({ where: { id: here.id } })).toMatchObject({ status: "reconnect", errorCode: "connector_left" });
    // Nothing else relies on that grant: ads_read goes back to Meta.
    expect(revoked).toEqual(["META_LONG"]);
  });

  it("their bizinsights account deleted: every account their login powers waits for a reconnect, and the grant goes back", async () => {
    const admin = await signIn(ctx, "ads-life-leaver", "leaver@x.com");
    await systemDb.membership.create({ data: { workspaceId: ws, userId: admin.user.id, role: "admin" } });
    const a = await connectedBy(admin.user.id, ws, storeId, "act_1");
    const b = await connectedBy(admin.user.id, ws, storeId, "act_2");
    const revoked: string[] = [];
    ctx.setFetch(metaPlatform(revoked));
    const code = await deletionCode(ctx, admin.headers, "leaver@x.com");
    const res = await ctx.app.inject({ method: "POST", url: "/auth/account/delete", headers: admin.headers, payload: { confirm: "DELETE", code } });
    expect(res.statusCode).toBe(200);
    expect(await systemDb.user.findUnique({ where: { id: admin.user.id } })).toBeNull();
    // Who granted them stays, so a data deletion request from that person still finds them.
    for (const id of [a.id, b.id]) expect(await systemDb.adConnection.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "reconnect", errorCode: "connector_left", accessTokenEnc: "", externalUserId: "5550001" });
    expect(revoked).toEqual(["META_LONG"]);
  });

  it("their account deleted while Meta doesn't answer: the account is still deleted, and the grant is left (best effort)", async () => {
    const admin = await signIn(ctx, "ads-life-leaver2", "leaver2@x.com");
    await systemDb.membership.create({ data: { workspaceId: ws, userId: admin.user.id, role: "admin" } });
    const a = await connectedBy(admin.user.id, ws, storeId, "act_1");
    ctx.setFetch(async () => {
      throw new TypeError("fetch failed");
    });
    const code = await deletionCode(ctx, admin.headers, "leaver2@x.com");
    const res = await ctx.app.inject({ method: "POST", url: "/auth/account/delete", headers: admin.headers, payload: { confirm: "DELETE", code } });
    expect(res.statusCode).toBe(200);
    expect(await systemDb.user.findUnique({ where: { id: admin.user.id } })).toBeNull();
    expect(await systemDb.adConnection.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ status: "reconnect", errorCode: "connector_left", accessTokenEnc: "" });
  });

  it("a hidden account waiting for a reconnect: showing it queues nothing and never says 'Synchronizing'; reconnecting queues its catch-up", async () => {
    const admin = await signIn(ctx, "ads-life-admin3", "admin3@x.com");
    const member = await systemDb.membership.create({ data: { workspaceId: ws, userId: admin.user.id, role: "admin" } });
    const here = await connectedBy(admin.user.id, ws, storeId, "act_1");
    await systemDb.adConnection.update({ where: { id: here.id }, data: { enabled: false } });
    ctx.setFetch(metaPlatform([]));
    expect((await ctx.app.inject({ method: "DELETE", url: `/workspaces/${ws}/team/members/${member.id}`, headers })).statusCode).toBe(200);

    ctx.deps.queues.clear();
    const show = await ctx.app.inject({ method: "PATCH", url: `/workspaces/${ws}/stores/${storeId}/ads/connections/${here.id}`, headers, payload: { enabled: true } });
    expect(show.json().connection).toMatchObject({ enabled: true, status: "reconnect", syncRequestedAt: null });
    expect(ctx.deps.queues.sent.sync ?? []).toEqual([]);

    // Even a request left over from before (a job skipped before it could end it) doesn't hold up the reconnect's catch-up.
    await systemDb.adConnection.update({ where: { id: here.id }, data: { syncRequestedAt: new Date() } });
    await connect("meta");
    expect(ctx.deps.queues.sent.sync).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "ads", connectionId: here.id, trigger: "request" })]));
    expect(await systemDb.adConnection.findUniqueOrThrow({ where: { id: here.id } })).toMatchObject({ status: "active", errorCode: null, syncRequestedAt: expect.any(Date) });
  });

  it("an account hidden while its sync is on its way stops saying 'Synchronizing', and showing it again queues its catch-up", async () => {
    const conn = await connectedBy((await systemDb.user.findFirstOrThrow({ where: { email: "owner@x.com" } })).id, ws, storeId, "act_1");
    ctx.deps.queues.clear();
    expect((await ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/stores/${storeId}/ads/sync`, headers })).json().queued).toBe(1);
    const patch = (enabled: boolean) => ctx.app.inject({ method: "PATCH", url: `/workspaces/${ws}/stores/${storeId}/ads/connections/${conn.id}`, headers, payload: { enabled } });
    expect((await patch(false)).json().connection).toMatchObject({ enabled: false, syncRequestedAt: null });
    const shown = await patch(true);
    expect(shown.json().connection).toMatchObject({ enabled: true, syncRequestedAt: expect.any(String) });
    expect(ctx.deps.queues.sent.sync).toHaveLength(2);
  });
});

describe("an account the Nango release connected, not moved off Nango yet", () => {
  const NANGO_KEY = "nango-secret-0123456789abcdef0123456789";
  const INTEGRATION = "bizinsights-meta-ads";
  beforeEach(() => ctx.setEnv({ ...KEYS, NANGO_SECRET_KEY: NANGO_KEY }));

  /** bizinsights' old Nango environment in front of `platform`: a connection's tokens (GET /connections/:id) and deleting it. */
  function nangoIn(platform: FetchLike) {
    const n = { held: new Map<string, string>(), reads: [] as Array<{ id: string; key: string | null; refreshToken: string | null }>, deleted: [] as string[] };
    const fetchImpl: FetchLike = async (input, init) => {
      const u = new URL(String(input));
      if (u.host !== "api.nango.dev") return platform(input, init);
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${NANGO_KEY}`);
      const id = decodeURIComponent(/^\/connections\/([^/]+)$/.exec(u.pathname)?.[1] ?? "");
      const token = n.held.get(id);
      if (!token || u.searchParams.get("provider_config_key") !== INTEGRATION) return json({ error: { code: "not_found", message: "Connection not found" } }, 404);
      if (init?.method === "DELETE") {
        n.deleted.push(id);
        n.held.delete(id);
        return json({ success: true });
      }
      n.reads.push({ id, key: u.searchParams.get("provider_config_key"), refreshToken: u.searchParams.get("refresh_token") });
      return json({ connection_id: id, provider_config_key: INTEGRATION, credentials: { type: "OAUTH2", access_token: token, raw: {} } });
    };
    return { fetchImpl, n };
  }

  /** A Meta account as the Nango release stored it: a sealed reference to its Nango connection, never a token. */
  async function connectedThroughNango(accountId: string, connectionId: string, over: Record<string, unknown> = {}) {
    const owner = await systemDb.user.findFirstOrThrow({ where: { email: "owner@x.com" } });
    const sealed = encryptAdTokens(storeId, "meta", { accessToken: JSON.stringify({ n: connectionId, k: INTEGRATION }), refreshToken: null, expiresAt: null });
    return systemDb.adConnection.create({
      data: { workspaceId: ws, storeId, provider: "meta", accountId, accountName: accountId, currency: "USD", timezone: "UTC", connectedByUserId: owner.id, externalUserId: "5550001", source: "nango", sourceLoginId: connectionId, ...sealed, ...over },
    });
  }

  it("Settings says how it is read; disconnecting it gives the grant back with the token Nango held, then deletes the Nango connection", async () => {
    const revoked: string[] = [];
    const { fetchImpl, n } = nangoIn(metaPlatform(revoked));
    n.held.set("conn-old", "META_AT_NANGO");
    ctx.setFetch(fetchImpl);
    const a = await connectedThroughNango("act_1", "conn-old");
    const b = await connectedThroughNango("act_2", "conn-old");
    const list = await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${storeId}/ads`, headers });
    expect(list.json().connections.map((c: { source: string }) => c.source)).toEqual(["nango", "nango"]);
    expect(list.body).not.toContain("conn-old");

    // The other account still reads through the same Nango connection: nothing is given back or deleted.
    expect((await disconnect(a.id)).json()).toEqual({ ok: true, revoked: "still_used" });
    expect(n.reads).toEqual([]);
    expect(n.deleted).toEqual([]);

    expect((await disconnect(b.id)).json()).toEqual({ ok: true, revoked: "revoked" });
    // Its tokens read once (the refresh token asked for too), the grant given back with them, then Nango's copy deleted.
    expect(n.reads).toEqual([{ id: "conn-old", key: INTEGRATION, refreshToken: "true" }]);
    expect(revoked).toEqual(["META_AT_NANGO"]);
    expect(n.deleted).toEqual(["conn-old"]);
    expect(await systemDb.adConnection.count()).toBe(0);
  });

  it("connecting the same account with bizinsights' own sign-in makes the row its own, and lets the Nango connection go without revoking the grant", async () => {
    const revoked: string[] = [];
    const { fetchImpl, n } = nangoIn(metaPlatform(revoked));
    n.held.set("conn-old", "META_AT_NANGO");
    ctx.setFetch(fetchImpl);
    const a = await connectedThroughNango("act_1", "conn-old");
    const b = await connectedThroughNango("act_2", "conn-old", { status: "reconnect", errorCode: "auth_expired" });
    await systemDb.adCampaignDaily.create({ data: { workspaceId: ws, storeId, connectionId: a.id, provider: "meta", accountId: "act_1", campaignId: "c", campaignName: "C", day: "2026-10-27", spend: 5 } });

    // Both accounts are known already: nothing to choose.
    expect((await connect("meta")).location.pathname).toBe("/dashboard");
    const rows = await systemDb.adConnection.findMany({ where: { storeId }, orderBy: { accountId: "asc" } });
    // The same rows, with their days; bizinsights' own sealed token now, nothing at Nango.
    expect(rows.map((r) => [r.id, r.source, r.sourceLoginId, r.status])).toEqual([
      [a.id, "direct", null, "active"],
      [b.id, "direct", null, "active"],
    ]);
    expect(await adAccessToken(rows[0]!)).toBe("META_LONG");
    expect(await systemDb.adCampaignDaily.count({ where: { connectionId: a.id } })).toBe(1);
    // The grant is the same person's, which the rows now hold: never revoked. Only Nango's copy goes.
    expect(revoked).toEqual([]);
    expect(n.deleted).toEqual(["conn-old"]);
  });

  it("someone removed from the workspace: an account they connected through Nango waits for a reconnect too, and its Nango connection goes with the grant", async () => {
    const admin = await signIn(ctx, "ads-life-admin4", "admin4@x.com");
    const member = await systemDb.membership.create({ data: { workspaceId: ws, userId: admin.user.id, role: "admin" } });
    const revoked: string[] = [];
    const { fetchImpl, n } = nangoIn(metaPlatform(revoked));
    n.held.set("conn-admin", "META_AT_NANGO");
    ctx.setFetch(fetchImpl);
    const row = await connectedThroughNango("act_1", "conn-admin", { connectedByUserId: admin.user.id });
    expect((await ctx.app.inject({ method: "DELETE", url: `/workspaces/${ws}/team/members/${member.id}`, headers })).statusCode).toBe(200);
    expect(await systemDb.adConnection.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: "reconnect", errorCode: "connector_left", accessTokenEnc: "", source: "nango" });
    expect(revoked).toEqual(["META_AT_NANGO"]);
    expect(n.deleted).toEqual(["conn-admin"]);
  });
});

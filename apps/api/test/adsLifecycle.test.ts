import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { systemDb } from "@app/db";
import { adAccessToken, encryptAdTokens, forgetNangoToken, googleAdsOperationsToday, logger, pauseGoogleAds, type FetchLike } from "@app/core";
import { adErrorMessage, type AdProvider } from "@app/shared";
import { clean, createStore, createWorkspace, deletionCode, setup, signIn, teardown, type TestCtx } from "./helpers.js";
import { connectThroughNango, fakeNango, NANGO_ENV, type FakeNango, type NangoPlatform } from "./nangoFake.js";

/**
 * "Continue with Google Ads" / "Continue with Meta Ads" beyond the first connect: who signed in, giving
 * access back on disconnect (through Nango, and for the connections made before Nango), the tokens of
 * a connection made before Nango until it is moved, and the live Google Ads report.
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
  ...NANGO_ENV,
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface GoogleSeen {
  refreshes: string[];
  revoked: string[];
  reportQueries: string[];
}

/**
 * Google's token endpoint (renewing a connection made before Nango: `rotateTo` is what a refresh hands
 * back), tokeninfo for those tokens, revoke, Google Ads and AdSense. Nango's own tokens are answered by
 * the fake Nango in front of it.
 */
function googlePlatform(seen: GoogleSeen, opts: { rotateTo?: string; sub?: string | null; accounts?: string[]; refreshFails?: boolean } = {}): FetchLike {
  return async (input, init) => {
    const u = new URL(String(input));
    if (u.host === "oauth2.googleapis.com" && u.pathname === "/token") {
      const form = new URLSearchParams(String(init?.body));
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

/** Meta's permissions, /me and two ad accounts; records permission revocations (by the token they were made with). */
function metaPlatform(revoked: string[]): FetchLike {
  return async (input, init) => {
    const u = new URL(String(input));
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
let ws: string;
let storeId: string;
let nango: FakeNango;

beforeEach(async () => {
  await clean(ctx);
  ctx.setEnv(KEYS);
  forgetNangoToken();
  nango = fakeNango();
  usePlatform(async () => json({ error: { message: "no platform in this test" } }, 400));
  const u = await signIn(ctx, "ads-life-owner", "owner@x.com");
  headers = u.headers;
  ws = await createWorkspace(ctx, headers);
  storeId = (await createStore(ws, "ads-life.myshopify.com", ["read_orders"], { currency: "USD" })).id;
});

/** The platform's own API (Nango's answered by the fake Nango in front of it). */
const usePlatform = (platform: FetchLike) => ctx.setFetch(nango.fetch(platform));

/** "Continue with …" for `store` through Nango; when it offers a choice, take every account. */
async function connect(provider: NangoPlatform, store = storeId) {
  const flow = await connectThroughNango(ctx, nango, { base: `/workspaces/${ws}/stores/${store}`, provider, headers });
  expect(flow.start.statusCode).toBe(200);
  const finish = flow.finish!;
  const pick = finish.json().choose as string | undefined;
  if (pick) {
    const pending = `/workspaces/${ws}/stores/${store}/ads/pending/${pick}`;
    const list = await ctx.app.inject({ method: "GET", url: pending, headers });
    const ids = (list.json().accounts as Array<{ accountId: string }>).map((a) => a.accountId);
    expect((await ctx.app.inject({ method: "POST", url: pending, headers, payload: { accountIds: ids } })).statusCode).toBe(200);
  }
  return { finish, connectionId: flow.connectionId! };
}

/** A finish that ended without a connection: its error code. */
async function connectError(provider: NangoPlatform) {
  const { finish } = await connectThroughNango(ctx, nango, { base: `/workspaces/${ws}/stores/${storeId}`, provider, headers });
  expect(finish!.statusCode).toBeGreaterThanOrEqual(400);
  return finish!.json().error as string;
}

/**
 * Accounts connected by bizinsights' own sign-in before every platform went through Nango: their
 * tokens sealed on the rows (one sign-in's accounts share them), as the old callback stored them.
 */
async function connectedBeforeNango(provider: AdProvider, accounts: string[], tokens: { access: string; refresh: string | null; expiresAt?: Date }, extra: { externalUserId?: string | null; store?: string } = {}) {
  const store = extra.store ?? storeId;
  const enc = encryptAdTokens(store, provider, { accessToken: tokens.access, refreshToken: tokens.refresh, expiresAt: tokens.expiresAt ?? new Date(Date.now() + 3600_000) });
  const rows = [];
  for (const accountId of accounts) {
    rows.push(
      await systemDb.adConnection.create({
        data: { workspaceId: ws, storeId: store, provider, accountId, accountName: `Account ${accountId}`, currency: "USD", timezone: "UTC", externalUserId: extra.externalUserId ?? null, ...enc },
      }),
    );
  }
  return rows;
}

const disconnect = (id: string, store = storeId) => ctx.app.inject({ method: "DELETE", url: `/workspaces/${ws}/stores/${store}/ads/connections/${id}`, headers });
const fresh = (): GoogleSeen => ({ refreshes: [], revoked: [], reportQueries: [] });
const expire = (ids: string[]) => systemDb.adConnection.updateMany({ where: { id: { in: ids } }, data: { accessTokenExpiresAt: new Date(Date.now() - 60_000) } });

describe("Continue with Google Ads: the sign-in", () => {
  it("who signed in and what they granted are kept; the browser never sees a token or the Nango connection", async () => {
    usePlatform(googlePlatform(fresh()));
    const { finish, connectionId } = await connect("google");
    expect(finish.json()).toEqual({ connected: 1, provider: "google" });
    const row = await systemDb.adConnection.findFirstOrThrow({ where: { storeId, provider: "google" } });
    expect(row).toMatchObject({ accountId: "111", externalUserId: "100200300", grantedScopes: ["https://www.googleapis.com/auth/adwords", "openid"], source: "nango", refreshTokenEnc: null });
    const list = await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${storeId}/ads`, headers });
    expect(list.json().connections[0]).toMatchObject({ provider: "google", status: "active", source: "nango", grantedScopes: ["https://www.googleapis.com/auth/adwords", "openid"] });
    expect(list.body).not.toContain("G_ACCESS");
    expect(list.body).not.toContain("100200300");
    expect(list.body).not.toContain(connectionId);
  });

  it("a connection made before Nango renews its own tokens until it is moved: a refresh token Google replaces is stored for every account that shares it", async () => {
    const seen = fresh();
    const rotating = googlePlatform(seen, { rotateTo: "G_REFRESH_2" });
    usePlatform(rotating);
    const rows = await connectedBeforeNango("google", ["111", "222"], { access: "G_OLD", refresh: "G_REFRESH_1" }, { externalUserId: "100200300" });
    await expire(rows.map((r) => r.id));
    expect(await adAccessToken(await systemDb.adConnection.findUniqueOrThrow({ where: { id: rows[0]!.id } }), rotating)).toBe("G_ACCESS_2");
    // The other account got the new access token too; once that runs out, it refreshes with the replacement, not the retired token.
    const second = await systemDb.adConnection.findUniqueOrThrow({ where: { id: rows[1]!.id } });
    expect(second.accessTokenExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    await expire([second.id]);
    await adAccessToken(await systemDb.adConnection.findUniqueOrThrow({ where: { id: second.id } }), googlePlatform(seen));
    expect(seen.refreshes).toEqual(["G_REFRESH_1", "G_REFRESH_2"]);
    // Nango never saw them: they move only with the sweep (adsMigrate.test.ts in apps/worker).
    expect(nango.imports).toEqual([]);
  });
});

describe("Google Ads before Google approves bizinsights for real accounts", () => {
  it("is 'Coming soon' until switched on, and a Test-access project is named as the reason, not 'no accounts'", async () => {
    ctx.setEnv({ ...KEYS, GOOGLE_ADS_ENABLED: "" });
    const list = await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${storeId}/ads`, headers });
    expect(list.json().configured).toMatchObject({ google: false, adsense: true });
    expect((await ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/stores/${storeId}/ads/google/nango/session`, headers, payload: {} })).statusCode).toBe(503);

    ctx.setEnv(KEYS);
    const base = googlePlatform(fresh());
    usePlatform(async (input, init) => {
      const u = new URL(String(input));
      if (u.pathname.endsWith("googleAds:searchStream")) {
        return json([{ error: { code: 403, message: "denied", status: "PERMISSION_DENIED", details: [{ errors: [{ errorCode: { authorizationError: "CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION" } }] }] } }], 403);
      }
      return base(input, init);
    });
    expect(await connectError("google")).toBe("not_approved");
    expect(await systemDb.adConnection.count()).toBe(0);
    expect(nango.deleted).toHaveLength(1);
  });
});

describe("disconnecting gives access back to the platform, only when nothing else relies on it", () => {
  it("Google: Google Ads and AdSense share one person's grant, so it is revoked with the last of them", async () => {
    const seen = fresh();
    usePlatform(googlePlatform(seen));
    const google = await connect("google");
    const adsense = await connect("adsense");
    const g = await systemDb.adConnection.findFirstOrThrow({ where: { storeId, provider: "google" } });
    const a = await systemDb.adConnection.findFirstOrThrow({ where: { storeId, provider: "adsense" } });
    const first = await disconnect(g.id);
    expect(first.json()).toEqual({ ok: true, revoked: "still_used" });
    expect(seen.revoked).toEqual([]);
    // Its own Nango connection goes all the same, with the tokens Nango held.
    expect(nango.deleted).toEqual([google.connectionId]);
    const last = await disconnect(a.id);
    expect(last.json()).toEqual({ ok: true, revoked: "revoked" });
    expect(seen.revoked).toEqual(["AS_ACCESS"]);
    expect(nango.deleted).toEqual([google.connectionId, adsense.connectionId]);
    expect(await systemDb.adConnection.count()).toBe(0);
    const audit = await systemDb.auditLog.findMany({ where: { action: "ads.disconnected" }, orderBy: { createdAt: "asc" } });
    expect(audit.map((x) => (x.metadata as { revoked: string }).revoked)).toEqual(["still_used", "revoked"]);
  });

  it("Meta: ads_read is dropped (and nothing else) when the last account from that login goes", async () => {
    const revoked: string[] = [];
    usePlatform(metaPlatform(revoked));
    const { connectionId } = await connect("meta");
    const rows = await systemDb.adConnection.findMany({ where: { storeId, provider: "meta" }, orderBy: { accountId: "asc" } });
    expect(rows.map((r) => r.externalUserId)).toEqual(["5550001", "5550001"]);
    expect((await disconnect(rows[0]!.id)).json().revoked).toBe("still_used");
    expect(revoked).toEqual([]);
    expect(nango.deleted).toEqual([]);
    expect((await disconnect(rows[1]!.id)).json().revoked).toBe("revoked");
    expect(revoked).toEqual(["META_LONG_SECRET"]);
    expect(nango.deleted).toEqual([connectionId]);
  });

  it("when Google wouldn't say who signed in, nothing is revoked (it can't be told whether another connection relies on it)", async () => {
    const seen = fresh();
    usePlatform(googlePlatform(seen, { sub: null }));
    nango.googleSub = null;
    const { connectionId } = await connect("google");
    const g = await systemDb.adConnection.findFirstOrThrow({ where: { storeId, provider: "google" } });
    expect(g.externalUserId).toBeNull();
    expect((await disconnect(g.id)).json()).toEqual({ ok: true, revoked: "unknown_person" });
    expect(seen.revoked).toEqual([]);
    expect(nango.deleted).toEqual([connectionId]);
  });

  it("a connection made before Nango: revoked with its own refresh token when nothing else relies on it", async () => {
    const seen = fresh();
    usePlatform(googlePlatform(seen));
    const [old] = await connectedBeforeNango("adsense", ["pub-77"], { access: "AS_OLD", refresh: "AS_REFRESH" }, { externalUserId: "100200300" });
    expect((await disconnect(old!.id)).json()).toEqual({ ok: true, revoked: "revoked" });
    expect(seen.revoked).toEqual(["AS_REFRESH"]);
    expect(nango.deleted).toEqual([]);
  });
});

describe("review fixes: grants nobody can vouch for are never revoked", () => {
  it("an older AdSense connection with no known person keeps the grant; it learns its person at its next refresh", async () => {
    const seen = fresh();
    usePlatform(googlePlatform(seen));
    // The older connection: made before identities were kept, and before Nango.
    const [old] = await connectedBeforeNango("adsense", ["pub-77"], { access: "AS_OLD", refresh: "AS_REFRESH" });
    expect(old!.externalUserId).toBeNull();
    // The same person connects Google Ads now, through Nango, and their sub is known.
    await connect("google");
    const g = await systemDb.adConnection.findFirstOrThrow({ where: { storeId, provider: "google" } });
    expect(g.externalUserId).toBe("100200300");
    expect((await disconnect(g.id)).json().revoked).toBe("still_used");
    expect(seen.revoked).toEqual([]);

    // The older row's next refresh learns who granted it (here, already learned while checking the grant).
    await expire([old!.id]);
    await adAccessToken(await systemDb.adConnection.findUniqueOrThrow({ where: { id: old!.id } }), googlePlatform(seen));
    expect((await systemDb.adConnection.findUniqueOrThrow({ where: { id: old!.id } })).externalUserId).toBe("100200300");
  });

  it("a reconnect whose person can't be looked up forgets the previous person instead of inheriting them", async () => {
    usePlatform(googlePlatform(fresh()));
    await connect("google");
    expect((await systemDb.adConnection.findFirstOrThrow({ where: { storeId, provider: "google" } })).externalUserId).toBe("100200300");
    const seen = fresh();
    usePlatform(googlePlatform(seen, { sub: null }));
    nango.googleSub = null;
    await connect("google");
    const row = await systemDb.adConnection.findFirstOrThrow({ where: { storeId, provider: "google" } });
    expect(row.externalUserId).toBeNull();
    expect((await disconnect(row.id)).json().revoked).toBe("unknown_person");
    expect(seen.revoked).toEqual([]);
  });

  it("a Google login with no Google Ads account is told so, not 'try again'", async () => {
    const base = googlePlatform(fresh());
    usePlatform(async (input, init) => {
      const u = new URL(String(input));
      if (u.pathname.endsWith("customers:listAccessibleCustomers")) {
        return json({ error: { code: 401, message: "The user's Google Account isn't associated with any Google Ads accounts.", status: "UNAUTHENTICATED", details: [{ errors: [{ errorCode: { authenticationError: "NOT_ADS_USER" } }] }] } }, 401);
      }
      return base(input, init);
    });
    expect(await connectError("google")).toBe("no_accounts");
    // With `email` in the grant the card names the Google account Google picked; the log never does.
    nango.googleEmail = "shop.owner@gmail.com";
    const logged: unknown[][] = [];
    const info = vi.spyOn(logger, "info").mockImplementation((...a: unknown[]) => void logged.push(a));
    let finish: Awaited<ReturnType<typeof connectThroughNango>>["finish"] = null;
    try {
      ({ finish } = await connectThroughNango(ctx, nango, { base: `/workspaces/${ws}/stores/${storeId}`, provider: "google", headers }));
    } finally {
      info.mockRestore();
    }
    expect(finish!.json()).toMatchObject({ error: "no_accounts", detail: { login: "shop.owner@gmail.com" } });
    expect(JSON.stringify(logged)).not.toContain("shop.owner");
  });

  it("a login that reaches only an empty manager account, or an account Google won't report on yet, is told which", async () => {
    const base = googlePlatform(fresh());
    const errorWith = async (searchStream: (query: string) => Response) => {
      usePlatform(async (input, init) => {
        const u = new URL(String(input));
        if (u.pathname.endsWith("googleAds:searchStream")) return searchStream((JSON.parse(String(init?.body)) as { query: string }).query);
        return base(input, init);
      });
      return connectError("google");
    };
    const managerOnly = await errorWith((q) => (q.endsWith("FROM customer") ? json([{ results: [{ customer: { id: "111", descriptiveName: "Manager", manager: true } }] }]) : json([{ results: [] }])));
    expect(managerOnly).toBe("manager_only");
    const notReady = await errorWith(() => json([{ error: { message: "The customer account can't be accessed because it is not yet enabled or has been deactivated.", status: "PERMISSION_DENIED" } }], 403));
    expect(notReady).toBe("account_not_ready");
    expect(await systemDb.adConnection.count()).toBe(0);
  });
});

describe("Continue with Meta Ads: a login with nothing to connect", () => {
  /** Meta's sign-in finishing when /me/adaccounts is empty and Meta's token inspector answers `granular`. */
  const errorWith = async (granular: Array<{ scope: string; target_ids?: string[] }>) => {
    const base = metaPlatform([]);
    usePlatform(async (input, init) => {
      const u = new URL(String(input));
      if (u.pathname.endsWith("/me/adaccounts")) return json({ data: [] });
      if (u.pathname.endsWith("/debug_token")) return json({ data: { is_valid: true, granular_scopes: granular } });
      return base(input, init);
    });
    return connectError("meta");
  };

  it("says whether the login reaches no ad account or shared none on Facebook's screen", async () => {
    expect(await errorWith([{ scope: "ads_read" }])).toBe("no_accounts");
    expect(await errorWith([{ scope: "ads_read", target_ids: [] }])).toBe("none_shared");
    expect(await systemDb.adConnection.count()).toBe(0);
  });

  it("names the Facebook login for the card and logs what Meta said about it, without the name", async () => {
    const base = metaPlatform([]);
    usePlatform(async (input, init) => {
      const u = new URL(String(input));
      if (u.pathname.endsWith("/me/adaccounts")) return json({ data: [] });
      if (u.pathname.endsWith("/me") && u.searchParams.get("fields") === "id,name") return json({ id: "5550001", name: "Sebastian Thomas" });
      if (u.pathname.endsWith("/debug_token")) return json({ data: { type: "USER", is_valid: true, user_id: "5550001", scopes: ["ads_read"], granular_scopes: [{ scope: "ads_read" }] } });
      if (u.pathname.endsWith("/roles")) return json({ data: [{ user: "5550001", role: "administrators" }] });
      return base(input, init);
    });
    const logged: unknown[][] = [];
    const info = vi.spyOn(logger, "info").mockImplementation((...a: unknown[]) => void logged.push(a));
    let finish: Awaited<ReturnType<typeof connectThroughNango>>["finish"] = null;
    try {
      ({ finish } = await connectThroughNango(ctx, nango, { base: `/workspaces/${ws}/stores/${storeId}`, provider: "meta", headers }));
    } finally {
      info.mockRestore();
    }
    expect(finish!.statusCode).toBe(409);
    expect(finish!.json()).toMatchObject({ error: "no_accounts", detail: { login: "Sebastian Thomas" } });
    const line = logged.find((a) => a[1] === "ads: nothing to connect for this login");
    expect(line?.[0]).toMatchObject({ reason: "no_ads_account", provider: "meta", diagnosis: { metaUserId: "5550001", appRole: "administrators", token: { type: "USER", granted: { ads_read: "all" } } } });
    expect(JSON.stringify(line?.[0])).not.toContain("Sebastian");
    expect(await systemDb.adConnection.count()).toBe(0);
  });
});

describe("the Google Ads report", () => {
  const reportUrl = (connection: string, q: Record<string, string> = {}) =>
    `/workspaces/${ws}/stores/${storeId}/ads/google/report?${new URLSearchParams({ connection, from: "2026-09-01", to: "2026-09-30", ...q })}`;

  it("asks Google for exactly those dates: account totals and campaigns with status, type and budget; cached", async () => {
    const seen = fresh();
    usePlatform(googlePlatform(seen));
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
    usePlatform(googlePlatform(fresh()));
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
    usePlatform(googlePlatform(fresh()));
    const { connectionId } = await connect("google");
    const conn = await systemDb.adConnection.findFirstOrThrow({ where: { storeId, provider: "google" } });
    // Nango can't renew the grant any more (the person removed bizinsights at Google).
    nango.connections.get(connectionId)!.dead = true;
    forgetNangoToken(connectionId);
    const res = await ctx.app.inject({ method: "GET", url: reportUrl(conn.id), headers });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("reconnect");
    expect((await systemDb.adConnection.findUniqueOrThrow({ where: { id: conn.id } })).status).toBe("reconnect");
  });
});

describe("the Meta Ads report's splits", () => {
  it("placement, device and country are accepted views", async () => {
    const revoked: string[] = [];
    usePlatform(async (input, init) => {
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
  it("Meta: a disconnect after the person's token ended takes ads_read back with bizinsights' app token, for that person", async () => {
    const revoked: string[] = [];
    usePlatform(metaPlatform(revoked));
    const { connectionId } = await connect("meta");
    const rows = await systemDb.adConnection.findMany({ where: { storeId, provider: "meta" }, orderBy: { accountId: "asc" } });
    await disconnect(rows[0]!.id);
    // The token Nango held has run out (Meta's last about 60 days) and can't be renewed.
    nango.connections.get(connectionId)!.dead = true;
    forgetNangoToken(connectionId);
    const appTokenCalls: Array<{ path: string; token: string }> = [];
    usePlatform(async (input, init) => {
      const u = new URL(String(input));
      const token = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
      if (init?.method === "DELETE" && u.pathname.endsWith("/5550001/permissions/ads_read")) {
        appTokenCalls.push({ path: u.pathname, token });
        return json({ success: true });
      }
      return json({ error: { message: `unexpected ${u.pathname}` } }, 400);
    });
    const res = await disconnect(rows[1]!.id);
    expect(res.json()).toEqual({ ok: true, revoked: "revoked" });
    expect(appTokenCalls).toEqual([{ path: "/v26.0/5550001/permissions/ads_read", token: "meta_app|meta_secret" }]);
    expect(nango.deleted).toEqual([connectionId]);
  });

  it("cancelling the account choice gives the sign-in's grant back, unless the same person relies on it elsewhere", async () => {
    const revoked: string[] = [];
    usePlatform(metaPlatform(revoked));
    const choice = await connectThroughNango(ctx, nango, { base: `/workspaces/${ws}/stores/${storeId}`, provider: "meta", headers });
    const pick = choice.finish!.json().choose as string;
    expect(pick).toBeTruthy();
    expect((await ctx.app.inject({ method: "DELETE", url: `/workspaces/${ws}/stores/${storeId}/ads/pending/${pick}`, headers })).json()).toEqual({ ok: true });
    expect(revoked).toEqual(["META_LONG_SECRET"]);
    expect(nango.deleted).toEqual([choice.connectionId]);
    expect(await systemDb.adConnection.count()).toBe(0);

    // Connected on another store by the same person: their grant stays when a later choice is cancelled.
    await connect("meta");
    const other = (await createStore(ws, "ads-life-2.myshopify.com", ["read_orders"], { currency: "USD" })).id;
    const second = await connectThroughNango(ctx, nango, { base: `/workspaces/${ws}/stores/${other}`, provider: "meta", headers });
    const pick2 = second.finish!.json().choose as string;
    await ctx.app.inject({ method: "DELETE", url: `/workspaces/${ws}/stores/${other}/ads/pending/${pick2}`, headers });
    expect(revoked).toEqual(["META_LONG_SECRET"]);
    // The cancelled sign-in's own Nango connection goes all the same.
    expect(nango.deleted).toEqual([choice.connectionId, second.connectionId]);
  });

  it("a Google sign-in that finds nothing to connect gives its grant back", async () => {
    const seen = fresh();
    const base = googlePlatform(seen);
    usePlatform(async (input, init) => {
      const u = new URL(String(input));
      if (u.pathname.endsWith("customers:listAccessibleCustomers")) return json({ resourceNames: [] });
      return base(input, init);
    });
    expect(await connectError("google")).toBe("no_accounts");
    expect(seen.revoked).toEqual(["G_ACCESS"]);
    expect(nango.deleted).toHaveLength(1);
  });
});

describe("a Google grant that no longer covers reporting", () => {
  it("a connection made before Nango finds it at its token refresh: it asks for a reconnect with the permission ticked", async () => {
    const seen = fresh();
    const [conn] = await connectedBeforeNango("google", ["111"], { access: "G_OLD", refresh: "G_REFRESH_1", expiresAt: new Date(Date.now() - 60_000) }, { externalUserId: "100200300" });
    const base = googlePlatform(seen);
    usePlatform(async (input, init) => {
      const u = new URL(String(input));
      // The person unticked the Google Ads permission on Google's own account page: the refresh lists what is left.
      if (u.host === "oauth2.googleapis.com" && u.pathname === "/token") return json({ access_token: "G_ACCESS_2", expires_in: 3599, scope: "openid https://www.googleapis.com/auth/userinfo.email" });
      return base(input, init);
    });
    const res = await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${storeId}/ads/google/report?connection=${conn!.id}&from=2026-09-01&to=2026-09-30`, headers });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("reconnect");
    expect(await systemDb.adConnection.findUniqueOrThrow({ where: { id: conn!.id } })).toMatchObject({ status: "reconnect", errorCode: "scope_missing" });
    expect(seen.reportQueries).toEqual([]);
  });
});

describe("the Google Ads report compared, and Google's daily allowance", () => {
  const reportUrl = (connection: string, q: Record<string, string> = {}) =>
    `/workspaces/${ws}/stores/${storeId}/ads/google/report?${new URLSearchParams({ connection, from: "2026-09-01", to: "2026-09-30", ...q })}`;

  it("the comparison's dates asked of Google too, its figures by id; the operations counted like a sync's", async () => {
    const seen = fresh();
    usePlatform(googlePlatform(seen));
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

  it("a sign-in's account listing counts against the allowance; while it's used up, no sign-in is started", async () => {
    usePlatform(googlePlatform(fresh()));
    const before = await googleAdsOperationsToday(ctx.deps.coord);
    await connect("google");
    // listAccessibleCustomers and the one customer's details.
    expect(await googleAdsOperationsToday(ctx.deps.coord)).toBe(before + 2);

    await pauseGoogleAds(ctx.deps.coord, null);
    const sessions = nango.sessions.length;
    const start = await ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/stores/${storeId}/ads/google/nango/session`, headers, payload: {} });
    expect(start.statusCode).toBe(503);
    expect(start.json()).toEqual({ error: "rate_limited", message: adErrorMessage("quota_exhausted", "google") });
    expect(nango.sessions).toHaveLength(sessions);
    // AdSense doesn't spend Google Ads operations: it still starts.
    expect((await ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/stores/${storeId}/ads/adsense/nango/session`, headers, payload: {} })).statusCode).toBe(200);
  });

  it("while Google says the day's allowance is used up, the report says so in plain words and asks Google nothing", async () => {
    const seen = fresh();
    usePlatform(googlePlatform(seen));
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
  /** A Meta connection made before Nango, powered by `userId`'s login (Meta's person 5550001), in `store`. */
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
    usePlatform(metaPlatform(revoked));

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
    usePlatform(metaPlatform(revoked));
    expect((await ctx.app.inject({ method: "DELETE", url: `/workspaces/${ws}/members/${member.id}`, headers })).statusCode).toBe(200);
    expect(await systemDb.adConnection.findUniqueOrThrow({ where: { id: here.id } })).toMatchObject({ status: "reconnect", errorCode: "connector_left" });
    // Nothing else relies on that grant: ads_read goes back to Meta.
    expect(revoked).toEqual(["META_LONG"]);
  });

  it("removed: an account they connected through Nango waits for a reconnect too, and its Nango connection goes with the grant", async () => {
    const admin = await signIn(ctx, "ads-life-admin4", "admin4@x.com");
    const member = await systemDb.membership.create({ data: { workspaceId: ws, userId: admin.user.id, role: "admin" } });
    const revoked: string[] = [];
    usePlatform(metaPlatform(revoked));
    const flow = await connectThroughNango(ctx, nango, { base: `/workspaces/${ws}/stores/${storeId}`, provider: "meta", headers: admin.headers });
    const pick = flow.finish!.json().choose as string;
    expect((await ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/stores/${storeId}/ads/pending/${pick}`, headers: admin.headers, payload: { accountIds: ["act_1"] } })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "DELETE", url: `/workspaces/${ws}/team/members/${member.id}`, headers })).statusCode).toBe(200);
    expect(await systemDb.adConnection.findFirstOrThrow({ where: { accountId: "act_1" } })).toMatchObject({ status: "reconnect", errorCode: "connector_left", accessTokenEnc: "", source: "nango" });
    expect(revoked).toEqual(["META_LONG_SECRET"]);
    expect(nango.deleted).toEqual([flow.connectionId]);
  });

  it("their bizinsights account deleted: every account their login powers waits for a reconnect, and the grant goes back", async () => {
    const admin = await signIn(ctx, "ads-life-leaver", "leaver@x.com");
    await systemDb.membership.create({ data: { workspaceId: ws, userId: admin.user.id, role: "admin" } });
    const a = await connectedBy(admin.user.id, ws, storeId, "act_1");
    const b = await connectedBy(admin.user.id, ws, storeId, "act_2");
    const revoked: string[] = [];
    usePlatform(metaPlatform(revoked));
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
    usePlatform(metaPlatform([]));
    expect((await ctx.app.inject({ method: "DELETE", url: `/workspaces/${ws}/team/members/${member.id}`, headers })).statusCode).toBe(200);

    ctx.deps.queues.clear();
    const show = await ctx.app.inject({ method: "PATCH", url: `/workspaces/${ws}/stores/${storeId}/ads/connections/${here.id}`, headers, payload: { enabled: true } });
    expect(show.json().connection).toMatchObject({ enabled: true, status: "reconnect", syncRequestedAt: null });
    expect(ctx.deps.queues.sent.sync ?? []).toEqual([]);

    // Even a request left over from before (a job skipped before it could end it) doesn't hold up the reconnect's catch-up.
    await systemDb.adConnection.update({ where: { id: here.id }, data: { syncRequestedAt: new Date() } });
    await connect("meta");
    expect(ctx.deps.queues.sent.sync).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "ads", connectionId: here.id, trigger: "request" })]));
    expect(await systemDb.adConnection.findUniqueOrThrow({ where: { id: here.id } })).toMatchObject({ status: "active", errorCode: null, syncRequestedAt: expect.any(Date), source: "nango" });
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

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { systemDb } from "@app/db";
import { adAccessToken, syncAdConnection, type AdsSyncData, type FetchLike } from "@app/core";
import { addDays, localDay } from "@app/shared";
import { clean, createStore, createWorkspace, setup, signIn, teardown, type TestCtx } from "./helpers.js";

/**
 * "Continue with Meta" / "Continue with Google Ads" / "Continue with Google AdSense": connecting
 * ad accounts to a store, and what the dashboard shows from them.
 */

let ctx: TestCtx;
beforeAll(async () => (ctx = await setup()));
afterAll(async () => teardown(ctx));

const KEYS = {
  META_APP_ID: "meta_app",
  META_APP_SECRET: "meta_secret",
  GOOGLE_ADS_CLIENT_ID: "g_client",
  GOOGLE_ADS_CLIENT_SECRET: "g_secret",
  GOOGLE_ADS_DEVELOPER_TOKEN: "g_dev",
};
const NO_KEYS = Object.fromEntries(Object.keys(KEYS).map((k) => [k, ""]));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Meta's token endpoints, permissions and ad accounts, as seen by the callback. */
const metaPlatformWith =
  (adsRead: "granted" | "declined"): FetchLike =>
  async (input) => {
    const u = new URL(String(input));
    if (u.pathname.endsWith("/me/permissions")) return json({ data: [{ permission: "public_profile", status: "granted" }, { permission: "ads_read", status: adsRead }] });
    return metaPlatform(input);
  };

const metaPlatform: FetchLike = async (input) => {
  const u = new URL(String(input));
  if (u.pathname.endsWith("/oauth/access_token")) {
    return u.searchParams.get("grant_type") === "fb_exchange_token" ? json({ access_token: "META_LONG_SECRET", expires_in: 5_184_000 }) : json({ access_token: "META_SHORT" });
  }
  if (u.pathname.endsWith("/me/permissions")) return json({ data: [{ permission: "ads_read", status: "granted" }] });
  if (u.pathname.endsWith("/me/adaccounts")) {
    return json({ data: [{ id: "act_1", name: "Shop ads", currency: "USD", timezone_name: "UTC" }, { id: "act_2", name: "EU ads", currency: "EUR", timezone_name: "Europe/Paris" }] });
  }
  return json({ error: { message: `unexpected ${u.pathname}` } }, 400);
};

/** Google's token endpoint and AdSense: one account, and a report by day and site in `currency`. */
const adsensePlatform =
  (currency = "USD", rows: string[][] = []): FetchLike =>
  async (input) => {
    const u = new URL(String(input));
    if (u.host === "oauth2.googleapis.com") return json({ access_token: "AS_ACCESS", refresh_token: "AS_REFRESH_SECRET", expires_in: 3599 });
    if (u.pathname === "/v2/accounts") return json({ accounts: [{ name: "accounts/pub-77", displayName: "Shop site", timeZone: { id: "UTC" }, state: "READY" }] });
    if (u.pathname === "/v2/accounts/pub-77/reports:generate") {
      return json({
        headers: [
          { name: "DATE", type: "DIMENSION" },
          { name: "DOMAIN_CODE", type: "DIMENSION" },
          { name: "ESTIMATED_EARNINGS", type: "METRIC_CURRENCY", currencyCode: currency },
          { name: "PAGE_VIEWS", type: "METRIC_TALLY" },
          { name: "IMPRESSIONS", type: "METRIC_TALLY" },
          { name: "CLICKS", type: "METRIC_TALLY" },
        ],
        rows: rows.map((r) => ({ cells: r.map((value) => ({ value })) })),
      });
    }
    return json({ error: { message: `unexpected ${u.pathname}` } }, 400);
  };

let headers: Record<string, string>;
let cookie: string;
let ws: string;
let storeId: string;

beforeEach(async () => {
  await clean(ctx);
  ctx.setEnv(KEYS);
  const u = await signIn(ctx, "ads-owner", "owner@x.com");
  headers = u.headers;
  cookie = u.cookie;
  ws = await createWorkspace(ctx, headers);
  storeId = (await createStore(ws, "ads-shop.myshopify.com", ["read_orders"], { currency: "USD" })).id;
});

const connect = (provider: string, h = headers) => ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/stores/${storeId}/ads/${provider}/connect`, headers: h });

/** Start a connect and follow the platform back to our callback. */
async function connectFlow(provider: "meta" | "google" | "adsense", query: Record<string, string> = { code: "CODE" }) {
  const start = await connect(provider);
  expect(start.statusCode).toBe(200);
  const state = new URL(start.json().url).searchParams.get("state")!;
  const cb = await ctx.app.inject({
    method: "GET",
    url: `/ads/${provider}/callback?${new URLSearchParams({ state, ...query })}`,
    headers: { cookie: `${cookie}; ads_oauth_state=${state}` },
  });
  return { start, cb, state };
}

const pendingUrl = (pick: string) => `/workspaces/${ws}/stores/${storeId}/ads/pending/${pick}`;
const pickOf = (location: string) => new URL(location).searchParams.get("choose");

/** Connect, and when the platform shows several accounts, choose them all (as the picker does by default). */
async function connectAll(provider: "meta" | "google" | "adsense") {
  const flow = await connectFlow(provider);
  const pick = pickOf(flow.cb.headers.location as string);
  if (pick) {
    const list = await ctx.app.inject({ method: "GET", url: pendingUrl(pick), headers });
    const ids = (list.json().accounts as Array<{ accountId: string }>).map((a) => a.accountId);
    const done = await ctx.app.inject({ method: "POST", url: pendingUrl(pick), headers, payload: { accountIds: ids } });
    expect(done.statusCode).toBe(200);
  }
  return flow;
}

describe("connecting ad accounts", () => {
  it("says when a platform isn't set up, instead of sending people to an error page", async () => {
    ctx.setEnv(NO_KEYS);
    const list = await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${storeId}/ads`, headers });
    expect(list.json()).toEqual({ configured: { meta: false, google: false, adsense: false }, connections: [] });
    const res = await connect("meta");
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("not_configured");
  });

  it("Continue with Meta Ads: read-only access, the person chooses accounts, each saved with an encrypted token, history fetched", async () => {
    ctx.setFetch(metaPlatform);
    const { start, cb } = await connectFlow("meta");
    const url = new URL(start.json().url);
    expect(url.origin).toBe("https://www.facebook.com");
    expect(url.searchParams.get("scope")).toBe("ads_read");
    expect(url.searchParams.get("auth_type")).toBe("rerequest");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:3001/api/ads/meta/callback");

    // Two accounts: nothing is connected until the person chooses, on the integrations page.
    expect(cb.statusCode).toBe(302);
    const location = new URL(cb.headers.location as string);
    expect(location.pathname).toBe("/settings/ads");
    expect(location.searchParams.get("store")).toBe(storeId);
    const pick = location.searchParams.get("choose")!;
    expect(await systemDb.adConnection.count()).toBe(0);
    const offered = await ctx.app.inject({ method: "GET", url: pendingUrl(pick), headers });
    expect(offered.statusCode).toBe(200);
    expect(offered.body).not.toContain("META_LONG_SECRET");
    expect(offered.body).not.toContain("Enc");
    expect(offered.json()).toMatchObject({ provider: "meta", accounts: [{ accountId: "act_1", name: "Shop ads", currency: "USD", connected: false }, { accountId: "act_2", connected: false }] });
    const chose = await ctx.app.inject({ method: "POST", url: pendingUrl(pick), headers, payload: { accountIds: ["act_1", "act_2"] } });
    expect(chose.json()).toEqual({ provider: "meta", connected: 2 });

    const rows = await systemDb.adConnection.findMany({ where: { storeId }, orderBy: { accountId: "asc" } });
    expect(rows.map((r) => [r.provider, r.accountId, r.accountName, r.currency, r.enabled, r.status])).toEqual([
      ["meta", "act_1", "Shop ads", "USD", true, "active"],
      ["meta", "act_2", "EU ads", "EUR", true, "active"],
    ]);
    expect(JSON.stringify(rows)).not.toContain("META_LONG_SECRET");
    expect(await adAccessToken(rows[0]!)).toBe("META_LONG_SECRET");
    expect(rows[0]!.accessTokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 59 * 86_400_000);

    // 90 days of history per new account, on the sync queue.
    const jobs = ctx.deps.queues.sent.sync as unknown as AdsSyncData[];
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({ kind: "ads", connectionId: rows[0]!.id, until: localDay(new Date(), "UTC"), since: addDays(localDay(new Date(), "UTC"), -89) });
    expect(await systemDb.auditLog.count({ where: { action: "ads.connected" } })).toBe(1);

    // The list the settings page shows: no tokens.
    const list = await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${storeId}/ads`, headers });
    expect(list.body).not.toContain("Enc");
    expect(list.json().connections[0]).toMatchObject({ provider: "meta", accountId: "act_1", enabled: true, status: "active" });
    expect(list.json().connections[0].accessExpiresAt).toBeTruthy();
  });

  it("Continue with Google: offline access, a manager's client reached through it", async () => {
    ctx.setFetch(async (input, init) => {
      const u = new URL(String(input));
      if (u.host === "oauth2.googleapis.com") return json({ access_token: "G_ACCESS", refresh_token: "G_REFRESH_SECRET", expires_in: 3599 });
      if (u.pathname.endsWith("customers:listAccessibleCustomers")) return json({ resourceNames: ["customers/900"] });
      const query = (JSON.parse(String(init?.body)) as { query: string }).query;
      if (query.endsWith("FROM customer")) return json([{ results: [{ customer: { id: "900", descriptiveName: "Agency", manager: true } }] }]);
      return json([{ results: [{ customerClient: { id: "901", descriptiveName: "Store search", currencyCode: "USD", timeZone: "UTC", manager: false } }] }]);
    });
    const { start, cb } = await connectFlow("google");
    const url = new URL(start.json().url);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/adwords");
    // One account: nothing to choose, straight to the numbers.
    expect(cb.headers.location).toBe(`http://localhost:3001/dashboard?adsConnected=google&accounts=1&store=${storeId}`);
    const row = await systemDb.adConnection.findFirstOrThrow({ where: { storeId, provider: "google" } });
    expect(row).toMatchObject({ accountId: "901", accountName: "Store search", loginCustomerId: "900" });
    expect(row.refreshTokenEnc).toBeTruthy();
    expect(JSON.stringify(row)).not.toContain("G_REFRESH_SECRET");
  });

  it("Continue with Google AdSense: needs only the Google OAuth client, asks read-only, saves the account", async () => {
    // No developer token: Google Ads can't connect, AdSense can.
    ctx.setEnv({ ...NO_KEYS, GOOGLE_ADS_CLIENT_ID: "g_client", GOOGLE_ADS_CLIENT_SECRET: "g_secret" });
    const list = await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${storeId}/ads`, headers });
    expect(list.json().configured).toEqual({ meta: false, google: false, adsense: true });
    expect((await connect("google")).statusCode).toBe(503);

    ctx.setFetch(adsensePlatform());
    const { start, cb } = await connectFlow("adsense");
    const url = new URL(start.json().url);
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/adsense.readonly");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:3001/api/ads/adsense/callback");
    expect(cb.headers.location).toBe(`http://localhost:3001/dashboard?adsConnected=adsense&accounts=1&store=${storeId}`);

    const row = await systemDb.adConnection.findFirstOrThrow({ where: { storeId } });
    expect(row).toMatchObject({ provider: "adsense", accountId: "pub-77", accountName: "Shop site", currency: null, timezone: "UTC", enabled: true });
    expect(row.refreshTokenEnc).toBeTruthy();
    expect(JSON.stringify(row)).not.toContain("AS_REFRESH_SECRET");
    expect(await adAccessToken(row)).toBe("AS_ACCESS");
    const jobs = ctx.deps.queues.sent.sync as unknown as AdsSyncData[];
    expect(jobs).toEqual([expect.objectContaining({ kind: "ads", connectionId: row.id, since: addDays(localDay(new Date(), "UTC"), -89) })]);
  });

  it("a Google login with no AdSense account is told so", async () => {
    ctx.setFetch(async (input) => {
      const u = new URL(String(input));
      if (u.host === "oauth2.googleapis.com") return json({ access_token: "AT", refresh_token: "RT", expires_in: 3599 });
      return json({ error: { code: 403, message: "User does not have an AdSense account.", status: "PERMISSION_DENIED" } }, 403);
    });
    const { cb } = await connectFlow("adsense");
    expect(cb.headers.location).toContain("error=no_accounts");
    expect(cb.headers.location).toContain("provider=adsense");
    expect(await systemDb.adConnection.count()).toBe(0);
  });

  it("choosing accounts: only the ticked ones are connected, a choice is this person's and works once", async () => {
    ctx.setFetch(metaPlatform);
    const { cb } = await connectFlow("meta");
    const pick = pickOf(cb.headers.location as string)!;
    // Someone else in the workspace can't see or use it.
    const other = await signIn(ctx, "ads-admin", "admin@x.com");
    const me = await systemDb.user.findFirstOrThrow({ where: { email: "admin@x.com" } });
    await systemDb.membership.create({ data: { workspaceId: ws, userId: me.id, role: "admin" } });
    expect((await ctx.app.inject({ method: "GET", url: pendingUrl(pick), headers: other.headers })).statusCode).toBe(404);
    // An account that wasn't offered is refused, and the choice survives the mistake.
    const bad = await ctx.app.inject({ method: "POST", url: pendingUrl(pick), headers, payload: { accountIds: ["act_1", "act_999"] } });
    expect(bad.statusCode).toBe(400);
    const ok = await ctx.app.inject({ method: "POST", url: pendingUrl(pick), headers, payload: { accountIds: ["act_2"] } });
    expect(ok.json()).toEqual({ provider: "meta", connected: 1 });
    expect((await systemDb.adConnection.findMany()).map((r) => r.accountId)).toEqual(["act_2"]);
    expect((await ctx.app.inject({ method: "POST", url: pendingUrl(pick), headers, payload: { accountIds: ["act_1"] } })).statusCode).toBe(404);

    // Reconnecting shows the one already chosen as connected, and Cancel drops the sign-in.
    const again = await connectFlow("meta");
    const pick2 = pickOf(again.cb.headers.location as string)!;
    const list = await ctx.app.inject({ method: "GET", url: pendingUrl(pick2), headers });
    expect(list.json().accounts.map((a: { accountId: string; connected: boolean }) => [a.accountId, a.connected])).toEqual([["act_1", false], ["act_2", true]]);
    expect((await ctx.app.inject({ method: "DELETE", url: pendingUrl(pick2), headers })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "GET", url: pendingUrl(pick2), headers })).statusCode).toBe(404);
    expect(await systemDb.adConnection.count()).toBe(1);
  });

  it("the choice decides what shows: an unticked connected account is hidden, a ticked hidden one comes back", async () => {
    ctx.setFetch(metaPlatform);
    await connectAll("meta");
    await systemDb.adConnection.updateMany({ where: { accountId: "act_1" }, data: { enabled: false } });
    // A third account appears, so reconnecting asks again.
    ctx.setFetch(async (input) => {
      const u = new URL(String(input));
      if (u.pathname.endsWith("/me/adaccounts")) return json({ data: [{ id: "act_1", currency: "USD" }, { id: "act_2", currency: "EUR" }, { id: "act_3", currency: "USD" }] });
      return metaPlatform(input);
    });
    const { cb } = await connectFlow("meta");
    const pick = pickOf(cb.headers.location as string)!;
    ctx.deps.queues.clear();
    const ok = await ctx.app.inject({ method: "POST", url: pendingUrl(pick), headers, payload: { accountIds: ["act_1", "act_3"] } });
    expect(ok.json()).toEqual({ provider: "meta", connected: 2 });
    const rows = await systemDb.adConnection.findMany({ orderBy: { accountId: "asc" } });
    expect(rows.map((r) => [r.accountId, r.enabled])).toEqual([["act_1", true], ["act_2", false], ["act_3", true]]);
    // The two shown ones are fetched; the hidden one is left alone.
    expect((ctx.deps.queues.sent.sync as unknown as AdsSyncData[]).map((j) => j.connectionId).sort()).toEqual([rows[0]!.id, rows[2]!.id].sort());
  });

  it("a reconnect that sees nothing new skips the choice and goes back to the dashboard", async () => {
    ctx.setFetch(metaPlatform);
    await connectAll("meta");
    await systemDb.adConnection.updateMany({ data: { status: "reconnect", lastError: "Session has expired" } });
    const { cb } = await connectFlow("meta");
    expect(cb.headers.location).toBe(`http://localhost:3001/dashboard?adsConnected=meta&accounts=2&store=${storeId}`);
    expect((await systemDb.adConnection.findMany()).every((r) => r.status === "active" && r.lastError === null)).toBe(true);
  });

  it("a permission left unticked on the platform's screen is named, and nothing is connected", async () => {
    ctx.setFetch(metaPlatformWith("declined"));
    const meta = await connectFlow("meta");
    expect(meta.cb.headers.location).toContain("error=permission_missing");
    expect(meta.cb.headers.location).toContain("provider=meta");
    ctx.setFetch(async (input) => {
      const u = new URL(String(input));
      if (u.host === "oauth2.googleapis.com") return json({ access_token: "AT", refresh_token: "RT", expires_in: 3599, scope: "openid email" });
      return json({ error: { message: "should not be asked" } }, 500);
    });
    const sense = await connectFlow("adsense");
    expect(sense.cb.headers.location).toContain("error=permission_missing");
    expect(await systemDb.adConnection.count()).toBe(0);
  });

  it("Facebook Login for Business: a configuration id replaces scope when it's set", async () => {
    ctx.setEnv({ ...KEYS, META_CONFIG_ID: "cfg_123" });
    const url = new URL((await connect("meta")).json().url);
    expect(url.searchParams.get("config_id")).toBe("cfg_123");
    expect(url.searchParams.get("scope")).toBeNull();
  });

  it("refresh can be for one platform", async () => {
    ctx.setFetch(metaPlatform);
    await connectAll("meta");
    ctx.setFetch(adsensePlatform());
    await connectAll("adsense");
    ctx.deps.queues.clear();
    const one = await ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/stores/${storeId}/ads/sync`, headers, payload: { provider: "adsense" } });
    expect(one.json().queued).toBe(1);
    const all = await ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/stores/${storeId}/ads/sync`, headers });
    expect(all.json().queued).toBe(3);
    const list = await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${storeId}/ads`, headers });
    expect(list.json().connections.map((c: { provider: string; permission: string }) => [c.provider, c.permission])).toEqual([
      ["adsense", "https://www.googleapis.com/auth/adsense.readonly"],
      ["meta", "ads_read"],
      ["meta", "ads_read"],
    ]);
  });

  it("refuses a callback that isn't this browser's, isn't this person's, or was cancelled", async () => {
    ctx.setFetch(metaPlatform);
    // Cancelled on Meta's screen.
    const denied = await connectFlow("meta", { error: "access_denied", error_reason: "user_denied" });
    expect(denied.cb.headers.location).toContain("error=denied");
    // A state from another browser (no cookie).
    const start = await connect("meta");
    const state = new URL(start.json().url).searchParams.get("state")!;
    const noCookie = await ctx.app.inject({ method: "GET", url: `/ads/meta/callback?state=${state}&code=C`, headers: { cookie } });
    expect(noCookie.headers.location).toContain("error=state_mismatch");
    // Someone else signed in by the time it comes back.
    const other = await signIn(ctx, "someone-else", "else@x.com");
    const start2 = await connect("meta");
    const state2 = new URL(start2.json().url).searchParams.get("state")!;
    const wrongUser = await ctx.app.inject({ method: "GET", url: `/ads/meta/callback?state=${state2}&code=C`, headers: { cookie: `${other.cookie}; ads_oauth_state=${state2}` } });
    expect(wrongUser.headers.location).toContain("error=session_mismatch");
    // Used once only.
    const replay = await ctx.app.inject({ method: "GET", url: `/ads/meta/callback?state=${state2}&code=C`, headers: { cookie: `${cookie}; ads_oauth_state=${state2}` } });
    expect(replay.headers.location).toContain("error=state_expired");
    expect(await systemDb.adConnection.count()).toBe(0);
  });

  it("lets owners and admins connect, hide and disconnect; analysts and viewers only look", async () => {
    ctx.setFetch(metaPlatform);
    await connectAll("meta");
    const [a, b] = await systemDb.adConnection.findMany({ where: { storeId }, orderBy: { accountId: "asc" } });
    await systemDb.adCampaignDaily.create({ data: { workspaceId: ws, storeId, connectionId: b!.id, provider: "meta", accountId: "act_2", campaignId: "c", campaignName: "C", day: "2026-10-01", spend: 5 } });

    ctx.deps.queues.clear();
    const hide = await ctx.app.inject({ method: "PATCH", url: `/workspaces/${ws}/stores/${storeId}/ads/connections/${a!.id}`, headers, payload: { enabled: false } });
    expect(hide.json().connection.enabled).toBe(false);
    const show = await ctx.app.inject({ method: "PATCH", url: `/workspaces/${ws}/stores/${storeId}/ads/connections/${a!.id}`, headers, payload: { enabled: true } });
    expect(show.json().connection.enabled).toBe(true);
    expect(ctx.deps.queues.sent.sync).toHaveLength(1);

    const sync = await ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/stores/${storeId}/ads/sync`, headers });
    expect(sync.json().queued).toBe(2);

    const del = await ctx.app.inject({ method: "DELETE", url: `/workspaces/${ws}/stores/${storeId}/ads/connections/${b!.id}`, headers });
    expect(del.statusCode).toBe(200);
    expect(await systemDb.adCampaignDaily.count()).toBe(0);
    expect(await systemDb.adConnection.count()).toBe(1);

    const me = await systemDb.user.findFirstOrThrow({ where: { email: "owner@x.com" } });
    await systemDb.membership.update({ where: { workspaceId_userId: { workspaceId: ws, userId: me.id } }, data: { role: "analyst" } });
    expect((await connect("meta")).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: "DELETE", url: `/workspaces/${ws}/stores/${storeId}/ads/connections/${a!.id}`, headers })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${storeId}/ads`, headers })).statusCode).toBe(200);
  });
});

describe("ads on the dashboard", () => {
  it("adds up spend and results for the dates, in one currency, against the store's sales", async () => {
    ctx.setFetch(metaPlatform);
    await connectAll("meta");
    const usd = await systemDb.adConnection.findFirstOrThrow({ where: { storeId, accountId: "act_1" } });
    const eur = await systemDb.adConnection.findFirstOrThrow({ where: { storeId, accountId: "act_2" } });
    const today = localDay(new Date(), "UTC");
    const day = (n: number) => addDays(today, -n);
    const base = { workspaceId: ws, storeId, provider: "meta" };
    await systemDb.adCampaignDaily.createMany({
      data: [
        { ...base, connectionId: usd.id, accountId: "act_1", campaignId: "1", campaignName: "Spring", day: day(1), spend: 30, impressions: 3000, clicks: 60, conversions: 3, conversionValue: 120 },
        { ...base, connectionId: usd.id, accountId: "act_1", campaignId: "2", campaignName: "Retarget", day: day(2), spend: 10, impressions: 1000, clicks: 40, conversions: 1, conversionValue: 60 },
        // The period before (days 7..13 for "last 7 days").
        { ...base, connectionId: usd.id, accountId: "act_1", campaignId: "1", campaignName: "Spring", day: day(9), spend: 20, impressions: 2000, clicks: 50, conversions: 1, conversionValue: 40 },
        // Euros: listed, never added to dollars.
        { ...base, connectionId: eur.id, accountId: "act_2", campaignId: "9", campaignName: "EU", day: day(1), spend: 999, clicks: 1 },
      ],
    });
    await systemDb.dailyStoreMetrics.create({ data: { workspaceId: ws, storeId, day: day(1), grossSales: 400, orders: 4 } });

    const res = await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${storeId}/overview?preset=7d`, headers });
    const ads = res.json().modules.ads;
    expect(ads.currency).toBe("USD");
    expect(ads.current).toMatchObject({ spend: 40, clicks: 100, impressions: 4000, conversions: 4, conversionValue: 180, cpc: 0.4, costPerConversion: 10, roas: 4.5 });
    expect(ads.previous).toMatchObject({ spend: 20, conversions: 1 });
    expect(ads.deltas.spend).toBe(1);
    expect(ads.series).toHaveLength(7);
    expect(ads.series.find((d: { day: string }) => d.day === day(1)).spend).toBe(30);
    expect(ads.campaigns.map((c: { name: string; spend: number }) => [c.name, c.spend])).toEqual([["Spring", 30], ["Retarget", 10]]);
    expect(ads.byProvider).toEqual([expect.objectContaining({ provider: "meta", spend: 40 })]);
    expect(ads.seriesByProvider).toEqual([{ provider: "meta", series: expect.any(Array) }]);
    expect(ads.seriesByProvider[0].series.find((d: { day: string }) => d.day === day(1))).toMatchObject({ spend: 30, conversionValue: 120 });
    expect(res.json().modules.ad_connections).toEqual({ meta: 2, google: 0, adsense: 0, hidden: 0 });
    // Only what this server can connect is offered (all three keys are set in these tests).
    expect(res.json().modules.ad_configured).toEqual({ meta: true, google: true, adsense: true });
    expect(ads.accounts.map((a: { accountId: string; counted: boolean }) => [a.accountId, a.counted])).toEqual([["act_1", true], ["act_2", false]]);
    // $40 of ads against $400 of net sales.
    expect(ads.shareOfSales).toBe(0.1);

    // Hidden accounts leave the dashboard; none left, no ads module.
    await systemDb.adConnection.updateMany({ where: { storeId }, data: { enabled: false } });
    const after = await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${storeId}/overview?preset=7d`, headers });
    expect(after.json().modules.ads).toBeUndefined();
    // Still connected, just hidden: the dashboard can tell that apart from "never connected".
    expect(after.json().modules.ad_connections).toEqual({ meta: 2, google: 0, adsense: 0, hidden: 2 });
  });
});

describe("AdSense on the dashboard", () => {
  it("shows earnings on their own, never added to ad spend, and disconnecting removes them", async () => {
    const today = localDay(new Date(), "UTC");
    const day = (n: number) => addDays(today, -n);
    // An ad account that spends...
    ctx.setFetch(metaPlatform);
    await connectAll("meta");
    const usd = await systemDb.adConnection.findFirstOrThrow({ where: { storeId, accountId: "act_1" } });
    await systemDb.adCampaignDaily.create({ data: { workspaceId: ws, storeId, connectionId: usd.id, provider: "meta", accountId: "act_1", campaignId: "1", campaignName: "Spring", day: day(1), spend: 30, clicks: 10 } });
    // ...and an AdSense account that earns, synced through the real client.
    ctx.setFetch(
      adsensePlatform("USD", [
        [day(1), "ads-shop.example.com", "12.5", "5000", "9000", "20"],
        [day(1), "blog.example.com", "2.5", "1000", "2000", "5"],
        [day(9), "ads-shop.example.com", "5", "2500", "4000", "8"],
      ]),
    );
    await connectFlow("adsense");
    const sense = await systemDb.adConnection.findFirstOrThrow({ where: { storeId, provider: "adsense" } });
    await syncAdConnection(sense.id, day(13), today, ctx.deps.fetchImpl);
    const synced = await systemDb.adConnection.findUniqueOrThrow({ where: { id: sense.id } });
    expect(synced).toMatchObject({ currency: "USD", status: "active" });
    expect(await systemDb.adsenseDaily.count({ where: { connectionId: sense.id } })).toBe(3);
    await systemDb.dailyStoreMetrics.create({ data: { workspaceId: ws, storeId, day: day(1), grossSales: 300, orders: 3 } });

    const res = await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${storeId}/overview?preset=7d`, headers });
    const m = res.json().modules;
    // Spend is only the Meta account's.
    expect(m.ads.current.spend).toBe(30);
    expect(m.ads.accounts.map((a: { provider: string }) => a.provider)).toEqual(["meta", "meta"]);
    expect(m.adsense.currency).toBe("USD");
    expect(m.adsense.current).toMatchObject({ earnings: 15, pageViews: 6000, impressions: 11000, clicks: 25, pageRpm: 2.5 });
    expect(m.adsense.previous).toMatchObject({ earnings: 5, pageViews: 2500 });
    expect(m.adsense.deltas.earnings).toBe(2);
    expect(m.adsense.sites.map((s: { site: string; earnings: number }) => [s.site, s.earnings])).toEqual([["ads-shop.example.com", 12.5], ["blog.example.com", 2.5]]);
    expect(m.adsense.series).toHaveLength(7);
    expect(m.adsense.vsSales).toBe(0.05);
    expect(m.adsense.accounts).toEqual([expect.objectContaining({ provider: "adsense", accountId: "pub-77", counted: true })]);

    const del = await ctx.app.inject({ method: "DELETE", url: `/workspaces/${ws}/stores/${storeId}/ads/connections/${sense.id}`, headers });
    expect(del.statusCode).toBe(200);
    expect(await systemDb.adsenseDaily.count()).toBe(0);
    const after = await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${storeId}/overview?preset=7d`, headers });
    expect(after.json().modules.adsense).toBeUndefined();
    expect(after.json().modules.ads.current.spend).toBe(30);
  });
});

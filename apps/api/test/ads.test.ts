import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { systemDb } from "@app/db";
import { adAccessToken, type AdsSyncData, type FetchLike } from "@app/core";
import { addDays, localDay } from "@app/shared";
import { clean, createStore, createWorkspace, setup, signIn, teardown, type TestCtx } from "./helpers.js";

/**
 * "Continue with Meta" / "Continue with Google": connecting ad accounts to a store, and what the
 * dashboard shows from them.
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

/** Meta's token endpoints and ad accounts, as seen by the callback. */
const metaPlatform: FetchLike = async (input) => {
  const u = new URL(String(input));
  if (u.pathname.endsWith("/oauth/access_token")) {
    return u.searchParams.get("grant_type") === "fb_exchange_token" ? json({ access_token: "META_LONG_SECRET", expires_in: 5_184_000 }) : json({ access_token: "META_SHORT" });
  }
  if (u.pathname.endsWith("/me/adaccounts")) {
    return json({ data: [{ id: "act_1", name: "Shop ads", currency: "USD", timezone_name: "UTC" }, { id: "act_2", name: "EU ads", currency: "EUR", timezone_name: "Europe/Paris" }] });
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
async function connectFlow(provider: "meta" | "google", query: Record<string, string> = { code: "CODE" }) {
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

describe("connecting ad accounts", () => {
  it("says when a platform isn't set up, instead of sending people to an error page", async () => {
    ctx.setEnv(NO_KEYS);
    const list = await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${storeId}/ads`, headers });
    expect(list.json()).toEqual({ configured: { meta: false, google: false }, connections: [] });
    const res = await connect("meta");
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("not_configured");
  });

  it("Continue with Meta: read-only access, every ad account saved with an encrypted token, history fetched", async () => {
    ctx.setFetch(metaPlatform);
    const { start, cb } = await connectFlow("meta");
    const url = new URL(start.json().url);
    expect(url.origin).toBe("https://www.facebook.com");
    expect(url.searchParams.get("scope")).toBe("ads_read");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:3001/api/ads/meta/callback");

    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe(`http://localhost:3001/settings/ads?connected=meta&accounts=2&store=${storeId}`);
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
    expect(cb.headers.location).toContain("connected=google&accounts=1");
    const row = await systemDb.adConnection.findFirstOrThrow({ where: { storeId, provider: "google" } });
    expect(row).toMatchObject({ accountId: "901", accountName: "Store search", loginCustomerId: "900" });
    expect(row.refreshTokenEnc).toBeTruthy();
    expect(JSON.stringify(row)).not.toContain("G_REFRESH_SECRET");
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
    await connectFlow("meta");
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
    await connectFlow("meta");
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
    expect(ads.accounts.map((a: { accountId: string; counted: boolean }) => [a.accountId, a.counted])).toEqual([["act_1", true], ["act_2", false]]);
    // $40 of ads against $400 of net sales.
    expect(ads.shareOfSales).toBe(0.1);

    // Hidden accounts leave the dashboard; none left, no ads module.
    await systemDb.adConnection.updateMany({ where: { storeId }, data: { enabled: false } });
    const after = await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${storeId}/overview?preset=7d`, headers });
    expect(after.json().modules.ads).toBeUndefined();
  });
});

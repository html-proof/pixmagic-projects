import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { systemDb } from "@app/db";
import { adAccessToken, forgetNangoToken, syncAdConnection, type AdsSyncData, type FetchLike } from "@app/core";
import { addDays, adErrorMessage, LEGACY_GRANTS, localDay, META_OBJECT_FIELDS } from "@app/shared";
import { clean, createStore, createWorkspace, setup, signIn, teardown, type TestCtx } from "./helpers.js";
import { connectThroughNango, fakeNango, NANGO_ENV, type FakeNango, type NangoPlatform } from "./nangoFake.js";

/**
 * "Continue with Meta Ads" / "Google Ads" / "Google AdSense": connecting ad accounts to a store through
 * Nango (docs/nango.md), and what the dashboard shows from them. The Nango round trip's own checks are
 * adsNango.test.ts; here it is the way in, as a merchant takes it.
 */

let ctx: TestCtx;
beforeAll(async () => (ctx = await setup()));
afterAll(async () => teardown(ctx));
afterEach(() => vi.restoreAllMocks());

const KEYS = {
  META_APP_ID: "meta_app",
  META_APP_SECRET: "meta_secret",
  GOOGLE_ADS_CLIENT_ID: "g_client",
  GOOGLE_ADS_CLIENT_SECRET: "g_secret",
  GOOGLE_ADS_ENABLED: "1",
  // Meta hasn't granted Advanced Access to ads_read: only the app's testers can connect (reset for every test).
  META_ADS_ADVANCED_ACCESS: "",
  META_CONFIG_ID: "",
  ...NANGO_ENV,
};
const NO_KEYS = Object.fromEntries(Object.keys(KEYS).map((k) => [k, ""]));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Meta's permissions and ad accounts, as seen by the finish. */
const metaPlatformWith =
  (adsRead: "granted" | "declined"): FetchLike =>
  async (input) => {
    const u = new URL(String(input));
    if (u.pathname.endsWith("/me/permissions")) return json({ data: [{ permission: "public_profile", status: "granted" }, { permission: "ads_read", status: adsRead }] });
    return metaPlatform(input);
  };

const metaPlatform: FetchLike = async (input) => {
  const u = new URL(String(input));
  if (u.pathname.endsWith("/me/permissions")) return json({ data: [{ permission: "ads_read", status: "granted" }] });
  if (u.pathname.endsWith("/me/adaccounts")) {
    return json({ data: [{ id: "act_1", name: "Shop ads", currency: "USD", timezone_name: "UTC" }, { id: "act_2", name: "EU ads", currency: "EUR", timezone_name: "Europe/Paris" }] });
  }
  if (u.pathname.endsWith("/me")) return json({ id: "4242" });
  return json({ error: { message: `unexpected ${u.pathname}` } }, 400);
};

/** AdSense: one account, and a report by day and site in `currency`. */
const adsensePlatform =
  (currency = "USD", rows: string[][] = []): FetchLike =>
  async (input) => {
    const u = new URL(String(input));
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
let nango: FakeNango;

beforeEach(async () => {
  await clean(ctx);
  ctx.setEnv(KEYS);
  forgetNangoToken();
  nango = fakeNango();
  usePlatform(async () => json({ error: { message: "no platform in this test" } }, 400));
  const u = await signIn(ctx, "ads-owner", "owner@x.com");
  headers = u.headers;
  cookie = u.cookie;
  ws = await createWorkspace(ctx, headers);
  storeId = (await createStore(ws, "ads-shop.myshopify.com", ["read_orders"], { currency: "USD" })).id;
});

/** The platform's own API (Nango's answered by the fake Nango in front of it). */
const usePlatform = (platform: FetchLike) => ctx.setFetch(nango.fetch(platform));

/** "Continue with …" pressed: the Nango connect session. */
const connect = (provider: string, h = headers) => ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/stores/${storeId}/ads/${provider}/nango/session`, headers: h, payload: {} });

/** Connect as a merchant does: the session, authorizing at Nango, the consent coming back, the finish. */
async function connectFlow(provider: NangoPlatform) {
  const flow = await connectThroughNango(ctx, nango, { base: `/workspaces/${ws}/stores/${storeId}`, provider, headers });
  expect(flow.start.statusCode).toBe(200);
  return { ...flow, finish: flow.finish! };
}

const pendingUrl = (pick: string) => `/workspaces/${ws}/stores/${storeId}/ads/pending/${pick}`;
const pickOf = (finish: { json(): { choose?: string } }) => finish.json().choose ?? null;

/** Connect, and when the platform shows several accounts, choose them all (as the picker does by default). */
async function connectAll(provider: NangoPlatform) {
  const flow = await connectFlow(provider);
  const pick = pickOf(flow.finish);
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
    expect(list.json()).toEqual({
      configured: { meta: false, google: false, adsense: false },
      restricted: { meta: false, google: false, adsense: false },
      connections: [],
      // Sign-ins connected with no ad account yet: none here.
      logins: [],
      // The Google Ads demo (docs/ads-demo.md) is offered only when switched on; the real sign-in says what it lacks.
      demo: { google: false },
      missing: { google: ["GOOGLE_ADS_CLIENT_ID", "GOOGLE_ADS_CLIENT_SECRET", "GOOGLE_ADS_ENABLED"] },
    });
    const res = await connect("meta");
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("not_configured");
    expect(nango.sessions).toHaveLength(0);
  });

  it("offers only a platform whose integration Nango really holds", async () => {
    nango.integrations.delete("google");
    const list = await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${storeId}/ads`, headers });
    expect(list.json().configured).toEqual({ meta: true, google: false, adsense: true });
    expect((await connect("google")).json().error).toBe("not_configured");
    expect(nango.sessions).toHaveLength(0);
  });

  it("says Meta only lets the app's testers in until Meta grants Advanced Access to ads_read, and still offers the button", async () => {
    const restricted = async () => (await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${storeId}/ads`, headers })).json().restricted;
    // Facebook shows everyone else "Feature Unavailable" and never comes back.
    // Google Ads shows "Google hasn't verified this app" until Google verifies the adwords scope; AdSense never.
    expect(await restricted()).toEqual({ meta: true, google: true, adsense: false });
    expect((await connect("meta")).statusCode).toBe(200);
    expect((await connect("google")).statusCode).toBe(200);
    ctx.setEnv({ ...KEYS, META_ADS_ADVANCED_ACCESS: "1", GOOGLE_ADS_OAUTH_VERIFIED: "1" });
    expect(await restricted()).toEqual({ meta: false, google: false, adsense: false });
  });

  it("Continue with Meta Ads: read-only access, the person chooses accounts, each read through Nango, history fetched", async () => {
    usePlatform(metaPlatform);
    const { start, finish, connectionId } = await connectFlow("meta");
    // The session can connect only Meta's integration, asks Meta again for a permission declined before, and carries ids only.
    expect(nango.sessions[0]).toMatchObject({ allowed_integrations: ["bizinsights-meta-ads"], integrations_config_defaults: { "bizinsights-meta-ads": { authorization_params: { auth_type: "rerequest" } } } });
    expect(start.body).not.toContain("META_LONG_SECRET");

    // Two accounts: nothing is connected until the person chooses, on the integrations page.
    expect(finish.statusCode).toBe(200);
    const pick = pickOf(finish)!;
    expect(pick).toBeTruthy();
    expect(await systemDb.adConnection.count()).toBe(0);
    const offered = await ctx.app.inject({ method: "GET", url: pendingUrl(pick), headers });
    expect(offered.statusCode).toBe(200);
    expect(offered.body).not.toContain("META_LONG_SECRET");
    expect(offered.body).not.toContain("Enc");
    expect(offered.json()).toMatchObject({ provider: "meta", accounts: [{ accountId: "act_1", name: "Shop ads", currency: "USD", connected: false }, { accountId: "act_2", connected: false }] });
    const chose = await ctx.app.inject({ method: "POST", url: pendingUrl(pick), headers, payload: { accountIds: ["act_1", "act_2"] } });
    expect(chose.json()).toEqual({ provider: "meta", connected: 2 });

    const rows = await systemDb.adConnection.findMany({ where: { storeId }, orderBy: { accountId: "asc" } });
    expect(rows.map((r) => [r.provider, r.accountId, r.accountName, r.currency, r.enabled, r.status, r.source, r.sourceLoginId])).toEqual([
      ["meta", "act_1", "Shop ads", "USD", true, "active", "nango", connectionId],
      ["meta", "act_2", "EU ads", "EUR", true, "active", "nango", connectionId],
    ]);
    // No token is kept here: only which Nango connection to ask, sealed.
    expect(JSON.stringify(rows)).not.toContain("META_LONG_SECRET");
    expect(rows.every((r) => r.refreshTokenEnc === null)).toBe(true);
    expect(await adAccessToken(rows[0]!)).toBe("META_LONG_SECRET");
    expect(rows[0]!.accessTokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 59 * 86_400_000);

    // 90 days of history per new account, on the sync queue.
    const jobs = ctx.deps.queues.sent.sync as unknown as AdsSyncData[];
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({ kind: "ads", connectionId: rows[0]!.id, until: localDay(new Date(), "UTC"), since: addDays(localDay(new Date(), "UTC"), -89) });
    expect(await systemDb.auditLog.findFirst({ where: { action: "ads.connected" } })).toMatchObject({ metadata: { provider: "meta", accounts: 2, source: "nango" } });

    // The list the settings page shows: no tokens, and not the Nango connection either.
    const list = await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${storeId}/ads`, headers });
    expect(list.body).not.toContain("Enc");
    expect(list.body).not.toContain(connectionId!);
    expect(list.json().connections[0]).toMatchObject({ provider: "meta", accountId: "act_1", enabled: true, status: "active", source: "nango" });
    expect(list.json().connections[0].accessExpiresAt).toBeTruthy();
  });

  it("Continue with Google Ads: through Nango too, a manager's client reached through it", async () => {
    usePlatform(async (input, init) => {
      const u = new URL(String(input));
      if (u.pathname.endsWith("customers:listAccessibleCustomers")) return json({ resourceNames: ["customers/900"] });
      const query = (JSON.parse(String(init?.body)) as { query: string }).query;
      if (query.endsWith("FROM customer")) return json([{ results: [{ customer: { id: "900", descriptiveName: "Agency", manager: true } }] }]);
      return json([{ results: [{ customerClient: { id: "901", descriptiveName: "Store search", currencyCode: "USD", timeZone: "UTC", manager: false } }] }]);
    });
    const { finish, connectionId } = await connectFlow("google");
    expect(nango.sessions[0]).toMatchObject({ allowed_integrations: ["bizinsights-google-ads"] });
    // One account: nothing to choose, straight to the numbers.
    expect(finish.json()).toEqual({ connected: 1, provider: "google" });
    const row = await systemDb.adConnection.findFirstOrThrow({ where: { storeId, provider: "google" } });
    expect(row).toMatchObject({ accountId: "901", accountName: "Store search", loginCustomerId: "900", source: "nango", sourceLoginId: connectionId, refreshTokenEnc: null, externalUserId: "100200300" });
    expect(row.grantedScopes).toContain("https://www.googleapis.com/auth/adwords");
    expect(await adAccessToken(row)).toBe("G_ACCESS");
  });

  it("Continue with Google AdSense: needs only the Google OAuth client, asks read-only, saves the account", async () => {
    // Google Ads not switched on (its Cloud project isn't approved for real accounts yet): AdSense still connects.
    ctx.setEnv({ ...KEYS, GOOGLE_ADS_ENABLED: "" });
    const list = await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${storeId}/ads`, headers });
    expect(list.json().configured).toEqual({ meta: true, google: false, adsense: true });
    expect((await connect("google")).statusCode).toBe(503);

    usePlatform(adsensePlatform());
    const { finish } = await connectFlow("adsense");
    expect(finish.json()).toEqual({ connected: 1, provider: "adsense" });

    const row = await systemDb.adConnection.findFirstOrThrow({ where: { storeId } });
    expect(row).toMatchObject({ provider: "adsense", accountId: "pub-77", accountName: "Shop site", currency: null, timezone: "UTC", enabled: true, source: "nango" });
    expect(await adAccessToken(row)).toBe("AS_ACCESS");
    const jobs = ctx.deps.queues.sent.sync as unknown as AdsSyncData[];
    expect(jobs).toEqual([expect.objectContaining({ kind: "ads", connectionId: row.id, since: addDays(localDay(new Date(), "UTC"), -89) })]);
  });

  it("a Google login with no AdSense account is told so, and its Nango connection isn't kept", async () => {
    usePlatform(async () => json({ error: { code: 403, message: "User does not have an AdSense account.", status: "PERMISSION_DENIED" } }, 403));
    const { finish, connectionId } = await connectFlow("adsense");
    expect(finish.statusCode).toBe(409);
    expect(finish.json().error).toBe("no_accounts");
    expect(await systemDb.adConnection.count()).toBe(0);
    expect(nango.deleted).toEqual([connectionId]);
  });

  it("an AdSense answer with no account, or only closed ones, is told apart, and neither Nango connection is kept", async () => {
    usePlatform(async () => json({}));
    const none = await connectFlow("adsense");
    expect(none.finish.statusCode).toBe(409);
    expect(none.finish.json().error).toBe("no_accounts");
    usePlatform(async () => json({ accounts: [{ name: "accounts/pub-9", displayName: "Old site", state: "CLOSED" }] }));
    const closed = await connectFlow("adsense");
    expect(closed.finish.statusCode).toBe(409);
    expect(closed.finish.json().error).toBe("account_not_ready");
    expect(await systemDb.adConnection.count()).toBe(0);
    expect(nango.deleted).toEqual([none.connectionId, closed.connectionId]);
  });

  it("choosing accounts: only the ticked ones are connected, a choice is this person's and works once", async () => {
    usePlatform(metaPlatform);
    const { finish } = await connectFlow("meta");
    const pick = pickOf(finish)!;
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

    // Reconnecting shows the one already chosen as connected, and Cancel drops the sign-in and its Nango connection.
    const again = await connectFlow("meta");
    const pick2 = pickOf(again.finish)!;
    const list = await ctx.app.inject({ method: "GET", url: pendingUrl(pick2), headers });
    expect(list.json().accounts.map((a: { accountId: string; connected: boolean }) => [a.accountId, a.connected])).toEqual([["act_1", false], ["act_2", true]]);
    expect((await ctx.app.inject({ method: "DELETE", url: pendingUrl(pick2), headers })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "GET", url: pendingUrl(pick2), headers })).statusCode).toBe(404);
    expect(await systemDb.adConnection.count()).toBe(1);
    expect(nango.deleted).toEqual([again.connectionId]);
  });

  it("the choice decides what shows: an unticked connected account is hidden, a ticked hidden one comes back", async () => {
    usePlatform(metaPlatform);
    await connectAll("meta");
    // Their first syncs have run (a sync someone is waiting for isn't asked for twice).
    await systemDb.adConnection.updateMany({ data: { syncRequestedAt: null } });
    await systemDb.adConnection.updateMany({ where: { accountId: "act_1" }, data: { enabled: false } });
    // A third account appears, so reconnecting asks again.
    usePlatform(async (input) => {
      const u = new URL(String(input));
      if (u.pathname.endsWith("/me/adaccounts")) return json({ data: [{ id: "act_1", currency: "USD" }, { id: "act_2", currency: "EUR" }, { id: "act_3", currency: "USD" }] });
      return metaPlatform(input);
    });
    const { finish } = await connectFlow("meta");
    const pick = pickOf(finish)!;
    ctx.deps.queues.clear();
    const ok = await ctx.app.inject({ method: "POST", url: pendingUrl(pick), headers, payload: { accountIds: ["act_1", "act_3"] } });
    expect(ok.json()).toEqual({ provider: "meta", connected: 2 });
    const rows = await systemDb.adConnection.findMany({ orderBy: { accountId: "asc" } });
    expect(rows.map((r) => [r.accountId, r.enabled])).toEqual([["act_1", true], ["act_2", false], ["act_3", true]]);
    // The two shown ones are fetched; the hidden one is left alone.
    expect((ctx.deps.queues.sent.sync as unknown as AdsSyncData[]).map((j) => j.connectionId).sort()).toEqual([rows[0]!.id, rows[2]!.id].sort());
  });

  it("a reconnect that sees nothing new skips the choice, keeps the rows and their days, and adds no duplicate", async () => {
    usePlatform(metaPlatform);
    await connectAll("meta");
    const before = await systemDb.adConnection.findMany({ orderBy: { accountId: "asc" } });
    await systemDb.adCampaignDaily.create({ data: { workspaceId: ws, storeId, connectionId: before[0]!.id, provider: "meta", accountId: "act_1", campaignId: "c", campaignName: "C", day: "2026-10-01", spend: 5 } });
    await systemDb.adConnection.updateMany({ data: { status: "reconnect", lastError: "Session has expired" } });
    const { finish, connectionId } = await connectFlow("meta");
    expect(finish.json()).toEqual({ connected: 2, provider: "meta" });
    const after = await systemDb.adConnection.findMany({ orderBy: { accountId: "asc" } });
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
    expect(after.every((r) => r.status === "active" && r.lastError === null && r.sourceLoginId === connectionId)).toBe(true);
    expect(await systemDb.adCampaignDaily.count()).toBe(1);
    // The Nango connection the accounts read through before is let go.
    expect(nango.deleted).toEqual([before[0]!.sourceLoginId]);
  });

  it("a permission left unticked on the platform's screen is named, and nothing is connected", async () => {
    usePlatform(metaPlatformWith("declined"));
    const meta = await connectFlow("meta");
    expect(meta.finish.statusCode).toBe(409);
    expect(meta.finish.json().error).toBe("permission_missing");
    expect(await systemDb.adConnection.count()).toBe(0);
    expect(nango.deleted).toEqual([meta.connectionId]);
  });

  it("Facebook Login for Business: Nango is asked to send the configuration id", async () => {
    ctx.setEnv({ ...KEYS, META_CONFIG_ID: "cfg_123" });
    expect((await connect("meta")).statusCode).toBe(200);
    expect(nango.sessions[0]).toMatchObject({ integrations_config_defaults: { "bizinsights-meta-ads": { authorization_params: { config_id: "cfg_123" } } } });
  });

  it("refresh can be for one platform", async () => {
    usePlatform(metaPlatform);
    await connectAll("meta");
    usePlatform(adsensePlatform());
    await connectAll("adsense");
    // Connecting asked for each account's catch-up: Refresh while those are on their way sends nothing more.
    ctx.deps.queues.clear();
    expect((await ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/stores/${storeId}/ads/sync`, headers })).json().queued).toBe(0);
    expect(ctx.deps.queues.sent.sync).toEqual([]);
    // Once they have landed, Refresh brings each up to date again.
    await systemDb.adConnection.updateMany({ data: { syncRequestedAt: null } });
    const one = await ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/stores/${storeId}/ads/sync`, headers, payload: { provider: "adsense" } });
    expect(one.json().queued).toBe(1);
    const all = await ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/stores/${storeId}/ads/sync`, headers });
    // The AdSense account's is on its way already.
    expect(all.json().queued).toBe(2);
    expect((ctx.deps.queues.sent.sync as unknown as AdsSyncData[]).every((j) => j.trigger === "request")).toBe(true);
    const list = await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${storeId}/ads`, headers });
    expect(list.json().connections.map((c: { provider: string; permission: string }) => [c.provider, c.permission])).toEqual([
      ["adsense", "https://www.googleapis.com/auth/adsense.readonly"],
      ["meta", "ads_read"],
      ["meta", "ads_read"],
    ]);
  });

  it("the old direct sign-in is gone: its start answers nothing, and a browser coming back to its callback is asked to connect again", async () => {
    usePlatform(metaPlatform);
    expect((await ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/stores/${storeId}/ads/meta/connect`, headers })).statusCode).toBe(404);
    const back = await ctx.app.inject({ method: "GET", url: "/ads/meta/callback?state=old-state&code=CODE", headers: { cookie: `${cookie}; ads_oauth_state=old-state` } });
    expect(back.statusCode).toBe(302);
    expect(back.headers.location).toBe("http://localhost:3001/settings/ads?error=state_expired&provider=meta");
    expect((await ctx.app.inject({ method: "GET", url: "/ads/elsewhere/callback?code=C" })).headers.location).toBe("http://localhost:3001/settings/ads?error=unknown_provider");
    expect(await systemDb.adConnection.count()).toBe(0);
  });

  it("lets owners and admins connect, hide and disconnect; analysts and viewers only look", async () => {
    usePlatform(metaPlatform);
    await connectAll("meta");
    const [a, b] = await systemDb.adConnection.findMany({ where: { storeId }, orderBy: { accountId: "asc" } });
    await systemDb.adCampaignDaily.create({ data: { workspaceId: ws, storeId, connectionId: b!.id, provider: "meta", accountId: "act_2", campaignId: "c", campaignName: "C", day: "2026-10-01", spend: 5 } });
    // Their first syncs have run.
    await systemDb.adConnection.updateMany({ data: { syncRequestedAt: null } });

    ctx.deps.queues.clear();
    const hide = await ctx.app.inject({ method: "PATCH", url: `/workspaces/${ws}/stores/${storeId}/ads/connections/${a!.id}`, headers, payload: { enabled: false } });
    expect(hide.json().connection.enabled).toBe(false);
    const show = await ctx.app.inject({ method: "PATCH", url: `/workspaces/${ws}/stores/${storeId}/ads/connections/${a!.id}`, headers, payload: { enabled: true } });
    expect(show.json().connection.enabled).toBe(true);
    // Shown again: it catches up on what it missed, and its card says so.
    expect(ctx.deps.queues.sent.sync).toEqual([expect.objectContaining({ kind: "ads", connectionId: a!.id, trigger: "request" })]);
    expect(show.json().connection.syncRequestedAt).toBeTruthy();

    // The one on its way isn't asked for twice.
    const sync = await ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/stores/${storeId}/ads/sync`, headers });
    expect(sync.json().queued).toBe(1);

    const del = await ctx.app.inject({ method: "DELETE", url: `/workspaces/${ws}/stores/${storeId}/ads/connections/${b!.id}`, headers });
    expect(del.statusCode).toBe(200);
    expect(await systemDb.adCampaignDaily.count()).toBe(0);
    expect(await systemDb.adConnection.count()).toBe(1);
    // The other account still reads through the same Nango connection: it stays.
    expect(nango.deleted).toEqual([]);

    const me = await systemDb.user.findFirstOrThrow({ where: { email: "owner@x.com" } });
    await systemDb.membership.update({ where: { workspaceId_userId: { workspaceId: ws, userId: me.id } }, data: { role: "analyst", permissions: [...LEGACY_GRANTS.analyst] } });
    expect((await connect("meta")).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: "DELETE", url: `/workspaces/${ws}/stores/${storeId}/ads/connections/${a!.id}`, headers })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${storeId}/ads`, headers })).statusCode).toBe(200);
  });
});

describe("ads on the dashboard", () => {
  it("adds up spend and results for the dates, in one currency, against the store's sales", async () => {
    usePlatform(metaPlatform);
    await connectAll("meta");
    const usd = await systemDb.adConnection.findFirstOrThrow({ where: { storeId, accountId: "act_1" } });
    const eur = await systemDb.adConnection.findFirstOrThrow({ where: { storeId, accountId: "act_2" } });
    const today = localDay(new Date(), "UTC");
    const day = (n: number) => addDays(today, -n);
    // What its first sync records: the 90 days it fetched.
    await systemDb.adConnection.update({ where: { id: usd.id }, data: { historyFrom: day(89), syncedThrough: today, lastSyncedAt: new Date() } });
    const base = { workspaceId: ws, storeId, provider: "meta" };
    await systemDb.adCampaignDaily.createMany({
      data: [
        { ...base, connectionId: usd.id, accountId: "act_1", campaignId: "1", campaignName: "Spring", day: day(1), spend: 30, impressions: 3000, clicks: 60, linkClicks: 60, conversions: 3, conversionValue: 120, purchases: 3, purchaseValue: 120 },
        { ...base, connectionId: usd.id, accountId: "act_1", campaignId: "2", campaignName: "Retarget", day: day(2), spend: 10, impressions: 1000, clicks: 40, linkClicks: 40, conversions: 1, conversionValue: 60, purchases: 1, purchaseValue: 60 },
        // The period before (days 7..13 for "last 7 days").
        { ...base, connectionId: usd.id, accountId: "act_1", campaignId: "1", campaignName: "Spring", day: day(9), spend: 20, impressions: 2000, clicks: 50, linkClicks: 50, conversions: 1, conversionValue: 40, purchases: 1, purchaseValue: 40 },
        // Euros: listed, never added to dollars.
        { ...base, connectionId: eur.id, accountId: "act_2", campaignId: "9", campaignName: "EU", day: day(1), spend: 999, clicks: 1 },
      ],
    });
    await systemDb.dailyStoreMetrics.create({ data: { workspaceId: ws, storeId, day: day(1), grossSales: 400, orders: 4 } });

    const res = await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${storeId}/overview?preset=7d`, headers });
    const ads = res.json().modules.ads;
    expect(ads.currency).toBe("USD");
    expect(ads.current).toMatchObject({ spend: 40, clicks: 100, impressions: 4000, conversions: 4, conversionValue: 180, cpc: 0.4, costPerConversion: 10, roas: 4.5 });
    expect(ads.previous).toMatchObject({ spend: 20, conversions: 1, imported: true });
    expect(ads.historyFrom).toBe(day(89));
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
    usePlatform(metaPlatform);
    await connectAll("meta");
    const usd = await systemDb.adConnection.update({ where: { id: (await systemDb.adConnection.findFirstOrThrow({ where: { storeId, accountId: "act_1" } })).id }, data: { historyFrom: day(89), syncedThrough: today, lastSyncedAt: new Date() } });
    await systemDb.adCampaignDaily.create({ data: { workspaceId: ws, storeId, connectionId: usd.id, provider: "meta", accountId: "act_1", campaignId: "1", campaignName: "Spring", day: day(1), spend: 30, clicks: 10 } });
    // ...and an AdSense account that earns, synced through the real client.
    usePlatform(
      adsensePlatform("USD", [
        [day(1), "ads-shop.example.com", "12.5", "5000", "9000", "20"],
        [day(1), "blog.example.com", "2.5", "1000", "2000", "5"],
        [day(9), "ads-shop.example.com", "5", "2500", "4000", "8"],
      ]),
    );
    await connectFlow("adsense");
    const sense = await systemDb.adConnection.findFirstOrThrow({ where: { storeId, provider: "adsense" } });
    await syncAdConnection(sense.id, day(13), today, ctx.deps.fetchImpl);
    await systemDb.adConnection.update({ where: { id: sense.id }, data: { syncedThrough: today } });
    const synced = await systemDb.adConnection.findUniqueOrThrow({ where: { id: sense.id } });
    // The sync fetched every day from day(13) on: that is where its history starts.
    expect(synced).toMatchObject({ currency: "USD", status: "active", historyFrom: day(13) });
    expect(await systemDb.adsenseDaily.count({ where: { connectionId: sense.id } })).toBe(3);
    await systemDb.dailyStoreMetrics.create({ data: { workspaceId: ws, storeId, day: day(1), grossSales: 300, orders: 3 } });

    const res = await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${storeId}/overview?preset=7d`, headers });
    const m = res.json().modules;
    // Spend is only the Meta account's.
    expect(m.ads.current.spend).toBe(30);
    expect(m.ads.accounts.map((a: { provider: string }) => a.provider)).toEqual(["meta", "meta"]);
    expect(m.adsense.currency).toBe("USD");
    expect(m.adsense.current).toMatchObject({ earnings: 15, pageViews: 6000, impressions: 11000, clicks: 25, pageRpm: 2.5 });
    expect(m.adsense.previous).toMatchObject({ earnings: 5, pageViews: 2500, imported: true });
    expect(m.adsense.historyFrom).toBe(day(13));
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

describe("the Meta Ads report", () => {
  /** Meta's insights for act_1 by level, and effective_status by id; everything else as the connect flow sees it. */
  const reportPlatform =
    (calls: string[], opts: { revoked?: boolean } = {}): FetchLike =>
    async (input) => {
      const u = new URL(String(input));
      if (u.pathname.endsWith("/act_1/insights")) {
        calls.push(`insights:${u.searchParams.get("level")}`);
        if (opts.revoked) return json({ error: { message: "Error validating access token: The user has not authorized application", code: 190 } }, 400);
        expect(u.searchParams.get("use_unified_attribution_setting")).toBe("true");
        expect(JSON.parse(u.searchParams.get("time_range")!)).toEqual({ since: "2026-09-01", until: "2026-09-30" });
        expect(u.searchParams.get("time_increment")).toBeNull();
        const level = u.searchParams.get("level");
        if (level === "account") {
          return json({
            data: [
              {
                spend: "120.50",
                impressions: "10000",
                reach: "4000",
                frequency: "2.5",
                clicks: "300",
                inline_link_clicks: "200",
                actions: [
                  { action_type: "omni_purchase", value: "6" },
                  { action_type: "purchase", value: "6" },
                ],
                action_values: [{ action_type: "omni_purchase", value: "482" }],
              },
            ],
          });
        }
        return json({
          data: [
            { campaign_id: "12", campaign_name: "Retarget", spend: "20.50", impressions: "2000", reach: "900", frequency: "2.22", clicks: "50", inline_link_clicks: "20" },
            {
              campaign_id: "11",
              campaign_name: "Spring sale",
              spend: "100",
              impressions: "8000",
              reach: "3500",
              frequency: "2.29",
              clicks: "250",
              inline_link_clicks: "180",
              actions: [{ action_type: "omni_purchase", value: "6" }],
              action_values: [{ action_type: "omni_purchase", value: "482" }],
            },
          ],
        });
      }
      // Delivery statuses, from the account's list of campaigns (Graph v26.0 refuses the multiple-id lookup).
      if (u.pathname.endsWith("/act_1/campaigns")) {
        calls.push(`status:${u.searchParams.get("fields")}`);
        return json({ data: [{ id: "12", effective_status: "CAMPAIGN_PAUSED" }, { id: "11", effective_status: "ACTIVE" }, { id: "10", effective_status: "ARCHIVED" }] });
      }
      return metaPlatform(input);
    };

  async function connectedMeta() {
    usePlatform(metaPlatform);
    await connectAll("meta");
    return systemDb.adConnection.findFirstOrThrow({ where: { storeId, accountId: "act_1" } });
  }
  const reportUrl = (connection: string, q: Record<string, string> = {}) =>
    `/workspaces/${ws}/stores/${storeId}/ads/meta/report?${new URLSearchParams({ connection, from: "2026-09-01", to: "2026-09-30", ...q })}`;

  it("asks Meta for exactly those dates: account reach, campaigns biggest first with their status, read-only, cached", async () => {
    const conn = await connectedMeta();
    const calls: string[] = [];
    usePlatform(reportPlatform(calls));
    const res = await ctx.app.inject({ method: "GET", url: reportUrl(conn.id), headers });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(res.body).not.toContain("META_LONG_SECRET");
    expect(body.account).toMatchObject({ id: conn.id, accountId: "act_1", name: "Shop ads", currency: "USD" });
    expect(body.cached).toBe(false);
    // Reach for the account is Meta's own, de-duplicated figure: not 3500 + 900.
    expect(body.report.totals).toMatchObject({ spend: 120.5, impressions: 10000, reach: 4000, frequency: 2.5, linkClicks: 200, purchases: 6, purchaseValue: 482, cpm: 12.05, costPerLinkClick: 0.6 });
    expect(body.report.totals.roas).toBeCloseTo(4, 1);
    expect(body.report.rows.map((r: { id: string; name: string; status: string; spend: number }) => [r.id, r.name, r.status, r.spend])).toEqual([
      ["11", "Spring sale", "ACTIVE", 100],
      ["12", "Retarget", "CAMPAIGN_PAUSED", 20.5],
    ]);
    expect(body.report.rows[0]).toMatchObject({ purchases: 6, purchaseValue: 482, costPerPurchase: 16.67, roas: 4.82, linkCtr: 180 / 8000 });
    expect(body.report.rows[1]).toMatchObject({ purchases: 0, costPerPurchase: null, roas: 0 });
    // The account's campaigns counted by state, from the same list the statuses came from.
    expect(body.report.campaigns).toEqual({ active: 1, paused: 0, other: 2, total: 3, complete: true });
    expect(calls.sort()).toEqual(["insights:account", "insights:campaign", `status:${META_OBJECT_FIELDS.campaign}`]);

    // Asked again: from the cache, not from Meta.
    const again = await ctx.app.inject({ method: "GET", url: reportUrl(conn.id), headers });
    expect(again.json().cached).toBe(true);
    expect(again.json().report).toEqual(body.report);
    expect(calls).toHaveLength(3);
  });

  it("is only for the workspace and store the account belongs to", async () => {
    const conn = await connectedMeta();
    usePlatform(reportPlatform([]));
    const other = await signIn(ctx, "ads-other", "other@y.com");
    const otherWs = await createWorkspace(ctx, other.headers, "Other");
    const otherStore = (await createStore(otherWs, "other-shop.myshopify.com", ["read_orders"], { currency: "USD" })).id;
    // Someone else, with this workspace's address: not a member, and not told the workspace exists.
    expect((await ctx.app.inject({ method: "GET", url: reportUrl(conn.id), headers: other.headers })).statusCode).toBe(404);
    // Their own workspace and store, with this store's connection id: no such account there.
    const cross = await ctx.app.inject({
      method: "GET",
      url: `/workspaces/${otherWs}/stores/${otherStore}/ads/meta/report?${new URLSearchParams({ connection: conn.id, from: "2026-09-01", to: "2026-09-30" })}`,
      headers: other.headers,
    });
    expect(cross.statusCode).toBe(404);
  });

  it("access Meta took back marks the account 'reconnect' and says so, instead of showing old numbers as current", async () => {
    const conn = await connectedMeta();
    usePlatform(reportPlatform([], { revoked: true }));
    const res = await ctx.app.inject({ method: "GET", url: reportUrl(conn.id), headers });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("reconnect");
    expect((await systemDb.adConnection.findUniqueOrThrow({ where: { id: conn.id } })).status).toBe("reconnect");
    // From then on it doesn't ask Meta at all until it's reconnected.
    const calls: string[] = [];
    usePlatform(reportPlatform(calls));
    expect((await ctx.app.inject({ method: "GET", url: reportUrl(conn.id), headers })).statusCode).toBe(409);
    expect(calls).toEqual([]);
  });

  it("refuses dates that aren't a real range of up to a year, and levels it doesn't know", async () => {
    const conn = await connectedMeta();
    usePlatform(reportPlatform([]));
    const bad: Array<Record<string, string>> = [{ from: "2026-09-30", to: "2026-09-01" }, { from: "2024-01-01", to: "2026-09-30" }, { from: "2026-02-31" }, { level: "account" }];
    for (const q of bad) {
      expect((await ctx.app.inject({ method: "GET", url: reportUrl(conn.id, q), headers })).statusCode).toBe(400);
    }
    expect((await ctx.app.inject({ method: "GET", url: reportUrl(conn.id, { level: "ad" }), headers })).statusCode).toBe(200);
  });
});

describe("what Settings shows of a connection", () => {
  const listAds = (h = headers) => ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${storeId}/ads`, headers: h });

  it("every field: the status worded by its own code (or the status's own words), the platform's reason only cleaned, who connected it", async () => {
    usePlatform(metaPlatform);
    await connectAll("meta");
    const me = await systemDb.user.update({ where: { email: "owner@x.com" }, data: { displayName: "Olive Owner" } });
    const [a, b] = await systemDb.adConnection.findMany({ where: { storeId }, orderBy: { accountId: "asc" } });
    await systemDb.adConnection.update({
      where: { id: a!.id },
      data: {
        status: "unavailable",
        errorCode: "account_closed",
        lastError: `Ad account ${"x".repeat(40)} is closed, see https://www.facebook.com/business/help?id=1 for more`,
        accountStatus: "closed",
        accountStatusDetail: "Because of the account was closed for good",
        consecutiveFailures: 2,
        historyFrom: "2026-07-01",
        syncedThrough: "2026-10-10",
      },
    });
    // A code left from an earlier failure, by a writer that changed only the status; connected by someone not in the workspace.
    await systemDb.adConnection.update({ where: { id: b!.id }, data: { status: "reconnect", errorCode: "temporary", connectedByUserId: "someone-gone" } });
    const res = await listAds();
    expect(res.body).not.toContain("Enc");
    const [ca, cb] = res.json().connections;
    expect(ca).toMatchObject({
      id: a!.id,
      provider: "meta",
      accountId: "act_1",
      accountName: "Shop ads",
      currency: "USD",
      timezone: "UTC",
      enabled: true,
      status: "unavailable",
      errorCode: "account_closed",
      message: adErrorMessage("account_closed", "meta"),
      accountStatus: "closed",
      accountStatusDetail: "Because of the account was closed for good",
      consecutiveFailures: 2,
      historyFrom: "2026-07-01",
      syncedThrough: "2026-10-10",
      // Connecting asked for its catch-up: the card says "Synchronizing" until it lands.
      syncRequestedAt: expect.any(String),
      permission: "ads_read",
      loginCustomerId: null,
      connectedBy: { name: "Olive Owner", email: me.email, you: true },
      sites: [],
      availableSites: [],
    });
    expect(ca.lastError).toBe("Ad account […] is closed, see [link] for more");
    expect(cb).toMatchObject({ status: "reconnect", errorCode: "temporary", message: adErrorMessage("auth_expired", "meta"), connectedBy: null });

    // A member who may look but not manage integrations sees who, not their address.
    const viewer = await signIn(ctx, "ads-viewer", "viewer@x.com");
    await systemDb.membership.create({ data: { workspaceId: ws, userId: viewer.user.id, role: "analyst", permissions: ["marketing.ads"] } });
    const seen = (await listAds(viewer.headers)).json().connections[0];
    expect(seen.connectedBy).toEqual({ name: "Olive Owner", email: null, you: false });
    // Working: nothing to say.
    await systemDb.adConnection.update({ where: { id: a!.id }, data: { status: "active", errorCode: null } });
    expect((await listAds()).json().connections[0]).toMatchObject({ status: "active", errorCode: null, message: null });
  });

  it("a Google Ads account reached through a manager says which, as Google writes it", async () => {
    usePlatform(metaPlatform);
    await connectAll("meta");
    const a = await systemDb.adConnection.findFirstOrThrow({ where: { storeId, accountId: "act_1" } });
    await systemDb.adConnection.update({ where: { id: a.id }, data: { provider: "google", accountId: "9876543210", loginCustomerId: "1234567890" } });
    const google = (await listAds()).json().connections.find((c: { provider: string }) => c.provider === "google");
    expect(google).toMatchObject({ loginCustomerId: "123-456-7890", accessExpiresAt: null, permission: "https://www.googleapis.com/auth/adwords" });
  });

  it("AdSense: the store's sites are chosen from the ones AdSense reported (host names only); a change brings the account up to date", async () => {
    usePlatform(adsensePlatform());
    await connectAll("adsense");
    const conn = await systemDb.adConnection.findFirstOrThrow({ where: { storeId, provider: "adsense" } });
    await systemDb.adConnection.update({ where: { id: conn.id }, data: { syncRequestedAt: null } });
    const base = { workspaceId: ws, storeId, connectionId: conn.id, accountId: "pub-77", earnings: 1 };
    await systemDb.adsenseDaily.createMany({
      data: [
        { ...base, site: "shop.example.com", day: "2026-10-01" },
        { ...base, site: "shop.example.com", day: "2026-10-02" },
        { ...base, site: "blog.example.com", day: "2026-10-01" },
        // A day AdSense wouldn't split by site.
        { ...base, site: "", day: "2026-09-01" },
      ],
    });
    expect((await listAds()).json().connections[0]).toMatchObject({ sites: [], availableSites: ["blog.example.com", "shop.example.com"] });

    const url = `/workspaces/${ws}/stores/${storeId}/ads/connections/${conn.id}`;
    ctx.deps.queues.clear();
    const chosen = await ctx.app.inject({ method: "PATCH", url, headers, payload: { sites: [" Shop.Example.com ", "shop.example.com", "new.example.com."] } });
    expect(chosen.statusCode).toBe(200);
    expect(chosen.json().connection).toMatchObject({ sites: ["new.example.com", "shop.example.com"], availableSites: ["blog.example.com", "new.example.com", "shop.example.com"], syncRequestedAt: expect.any(String) });
    expect(ctx.deps.queues.sent.sync).toEqual([expect.objectContaining({ kind: "ads", connectionId: conn.id, trigger: "request" })]);
    expect(await systemDb.auditLog.count({ where: { action: "ads.sites_changed", targetId: conn.id } })).toBe(1);

    // The same sites again: nothing changed, nothing to fetch.
    await systemDb.adConnection.update({ where: { id: conn.id }, data: { syncRequestedAt: null } });
    ctx.deps.queues.clear();
    expect((await ctx.app.inject({ method: "PATCH", url, headers, payload: { sites: ["shop.example.com", "new.example.com"] } })).statusCode).toBe(200);
    expect(ctx.deps.queues.sent.sync).toEqual([]);

    // Not a host name, more than 200, or nothing to change: refused, and nothing stored.
    for (const payload of [{ sites: ["not a host!"] }, { sites: ["a.com,b.com"] }, { sites: ["DOMAIN_CODE==x.com"] }, { sites: Array.from({ length: 201 }, (_, i) => `s${i}.example.com`) }, {}]) {
      const bad = await ctx.app.inject({ method: "PATCH", url, headers, payload });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error).toBe("validation");
    }
    expect((await systemDb.adConnection.findUniqueOrThrow({ where: { id: conn.id } })).sites).toEqual(["new.example.com", "shop.example.com"]);
    // Every site again.
    expect((await ctx.app.inject({ method: "PATCH", url, headers, payload: { sites: [] } })).json().connection.sites).toEqual([]);

    // Only AdSense accounts have sites.
    usePlatform(metaPlatform);
    await connectAll("meta");
    const meta = await systemDb.adConnection.findFirstOrThrow({ where: { storeId, provider: "meta" } });
    const refused = await ctx.app.inject({ method: "PATCH", url: `/workspaces/${ws}/stores/${storeId}/ads/connections/${meta.id}`, headers, payload: { sites: ["shop.example.com"] } });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toBe("validation");
  });
});

describe("the account choice", () => {
  it("says which accounts are connected and which are shown (only those are ticked again), and each one's state at the platform", async () => {
    usePlatform(metaPlatform);
    await connectAll("meta");
    await systemDb.adConnection.updateMany({ where: { accountId: "act_1" }, data: { enabled: false } });
    usePlatform(async (input) => {
      const u = new URL(String(input));
      if (u.pathname.endsWith("/me/adaccounts")) {
        return json({
          data: [
            { id: "act_1", name: "Shop ads", currency: "USD", timezone_name: "UTC", account_status: 1 },
            { id: "act_2", name: "EU ads", currency: "EUR", timezone_name: "Europe/Paris", account_status: 1 },
            { id: "act_3", name: "Old ads", currency: "USD", timezone_name: "UTC", account_status: 2, disable_reason: 3 },
          ],
        });
      }
      return metaPlatform(input);
    });
    const { finish } = await connectFlow("meta");
    const list = await ctx.app.inject({ method: "GET", url: pendingUrl(pickOf(finish)!), headers });
    expect(list.json()).toMatchObject({
      provider: "meta",
      truncated: false,
      accounts: [
        { accountId: "act_1", connected: true, enabled: false, status: "active", statusDetail: null },
        { accountId: "act_2", connected: true, enabled: true, status: "active" },
        { accountId: "act_3", connected: false, enabled: null, status: "disabled", statusDetail: "Because of a payment problem" },
      ],
    });
    // Choosing it stores what Meta said about the account.
    await ctx.app.inject({ method: "POST", url: pendingUrl(pickOf(finish)!), headers, payload: { accountIds: ["act_2", "act_3"] } });
    expect(await systemDb.adConnection.findFirstOrThrow({ where: { accountId: "act_3" } })).toMatchObject({ accountStatus: "disabled", accountStatusDetail: "Because of a payment problem" });
  });

  it("a list the platform cut short goes to the choice, which says so", async () => {
    usePlatform(async (input) => {
      const u = new URL(String(input));
      if (u.pathname.endsWith("/me/adaccounts")) {
        // An agency login: Meta always has another page.
        const n = Number(u.searchParams.get("after") ?? 0) + 1;
        return json({ data: [{ id: `act_${n}`, name: `Client ${n}`, currency: "USD", timezone_name: "UTC" }], paging: { next: `https://graph.facebook.com/v26.0/me/adaccounts?after=${n}` } });
      }
      return metaPlatform(input);
    });
    const { finish } = await connectFlow("meta");
    const pick = pickOf(finish);
    expect(pick).toBeTruthy();
    const list = (await ctx.app.inject({ method: "GET", url: pendingUrl(pick!), headers })).json();
    expect(list.truncated).toBe(true);
    expect(list.accounts.length).toBeGreaterThan(1);
  });
});

describe("starting a sign-in", () => {
  it("is limited to 10 in 10 minutes per person, whichever platform", async () => {
    for (let i = 0; i < 10; i++) expect((await connect("meta")).statusCode).toBe(200);
    const over = await connect("google");
    expect(over.statusCode).toBe(429);
    expect(over.json().error).toBe("rate_limited");
    expect(over.headers["retry-after"]).toBe("600");
  });
});

describe("Refresh", () => {
  it("catches up every account that can be read, asks the others only whether they're back, and leaves one waiting for a reconnect", async () => {
    usePlatform(metaPlatform);
    await connectAll("meta");
    usePlatform(adsensePlatform());
    await connectAll("adsense");
    await systemDb.adConnection.updateMany({ data: { syncRequestedAt: null } });
    await systemDb.adConnection.updateMany({ where: { accountId: "act_1" }, data: { status: "permission", errorCode: "no_access" } });
    await systemDb.adConnection.updateMany({ where: { accountId: "act_2" }, data: { status: "reconnect", errorCode: "auth_expired" } });
    ctx.deps.queues.clear();
    const res = await ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/stores/${storeId}/ads/sync`, headers });
    expect(res.json()).toEqual({ queued: 2 });
    const jobs = ctx.deps.queues.sent.sync as unknown as AdsSyncData[];
    const act1 = await systemDb.adConnection.findFirstOrThrow({ where: { accountId: "act_1" } });
    const sense = await systemDb.adConnection.findFirstOrThrow({ where: { provider: "adsense" } });
    expect(jobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ connectionId: act1.id, healthOnly: true, trigger: "request" }),
        expect.objectContaining({ connectionId: sense.id, trigger: "request" }),
      ]),
    );
    expect(jobs.find((j) => j.connectionId === sense.id)!.healthOnly).toBeUndefined();
    // Both cards say "Synchronizing"; the one waiting for a reconnect doesn't.
    expect((await systemDb.adConnection.findMany({ where: { syncRequestedAt: { not: null } } })).map((r) => r.id).sort()).toEqual([act1.id, sense.id].sort());
  });
});

describe("the sign-in coming back with a platform problem", () => {
  /** Google's revoke (recorded), and Google Ads answering `ads` for the account list. Nango's token is G_ACCESS. */
  const googleWith = (ads: () => Response, revoked: string[]): FetchLike => async (input, init) => {
    const u = new URL(String(input));
    if (u.host === "oauth2.googleapis.com" && u.pathname === "/revoke") {
      revoked.push(new URLSearchParams(String(init?.body)).get("token")!);
      return json({});
    }
    return ads();
  };

  it("says when to try again (rate limited, or no answer), and gives the grant it made back to Google", async () => {
    const revoked: string[] = [];
    usePlatform(googleWith(() => json({ error: { code: 429, message: "Too many requests", status: "RESOURCE_EXHAUSTED" } }, 429), revoked));
    const first = await connectFlow("google");
    expect([first.finish.statusCode, first.finish.json().error]).toEqual([503, "rate_limited"]);
    usePlatform(googleWith(() => json({ error: { code: 503, message: "The service is currently unavailable.", status: "UNAVAILABLE" } }, 503), revoked));
    const second = await connectFlow("google");
    expect([second.finish.statusCode, second.finish.json().error]).toEqual([503, "temporarily_unavailable"]);
    // Nothing connected, nothing else relies on that person's grant: given back each time, and the Nango connections deleted.
    expect(revoked).toEqual(["G_ACCESS", "G_ACCESS"]);
    expect(nango.deleted).toEqual([first.connectionId, second.connectionId]);
    expect(await systemDb.adConnection.count()).toBe(0);
  });

  it("a platform taken off this server mid sign-in is ours to say, and nothing is connected", async () => {
    const revoked: string[] = [];
    usePlatform(googleWith(() => json({ error: { message: "unexpected" } }, 400), revoked));
    const start = await connect("google");
    expect(start.statusCode).toBe(200);
    ctx.setEnv({ ...KEYS, NANGO_PROVIDERS: "meta,adsense" });
    const finish = await ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/stores/${storeId}/ads/google/nango/finish`, headers, payload: { nonce: start.json().nonce, connectionId: "conn-x" } });
    expect([finish.statusCode, finish.json().error]).toEqual([503, "not_configured"]);
    expect(await systemDb.adConnection.count()).toBe(0);
  });
});

describe("the AdSense report", () => {
  /** AdSense's report by `level`, limited to whatever DOMAIN_CODE filter is asked; `refuse`: AdSense won't filter this account by site. */
  const adsenseReports = (seen: URL[], opts: { refuse?: boolean } = {}): FetchLike => async (input) => {
    const u = new URL(String(input));
    if (u.pathname === "/v2/accounts/pub-77/reports:generate") {
      seen.push(u);
      if (opts.refuse && u.searchParams.has("filters")) return json({ error: { code: 400, message: "Invalid filter: DOMAIN_CODE", status: "INVALID_ARGUMENT" } }, 400);
      return json({
        headers: [
          { name: "DOMAIN_CODE", type: "DIMENSION" },
          { name: "ESTIMATED_EARNINGS", type: "METRIC_CURRENCY", currencyCode: "USD" },
          { name: "PAGE_VIEWS", type: "METRIC_TALLY" },
          { name: "IMPRESSIONS", type: "METRIC_TALLY" },
          { name: "CLICKS", type: "METRIC_TALLY" },
        ],
        rows: [{ cells: [{ value: "shop.example.com" }, { value: "12.50" }, { value: "5000" }, { value: "9000" }, { value: "20" }] }],
        totals: { cells: [{}, { value: "12.50" }, { value: "5000" }, { value: "9000" }, { value: "20" }] },
        totalMatchedRows: "1",
      });
    }
    return adsensePlatform()(input);
  };

  async function connectedAdsense() {
    usePlatform(adsensePlatform());
    await connectAll("adsense");
    return systemDb.adConnection.findFirstOrThrow({ where: { storeId, provider: "adsense" } });
  }
  const reportUrl = (connection: string, q: Record<string, string> = {}) => `/workspaces/${ws}/stores/${storeId}/ads/adsense/report?${new URLSearchParams({ connection, from: "2026-09-01", to: "2026-09-30", ...q })}`;

  it("by site, limited to the store's sites (echoed), with AdSense's own totals; cached", async () => {
    const conn = await connectedAdsense();
    await systemDb.adConnection.update({ where: { id: conn.id }, data: { sites: ["shop.example.com"] } });
    const seen: URL[] = [];
    usePlatform(adsenseReports(seen));
    const res = await ctx.app.inject({ method: "GET", url: reportUrl(conn.id), headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      account: { id: conn.id, accountId: "pub-77", name: "Shop site" },
      today: expect.any(String),
      cached: false,
      report: { level: "site", since: "2026-09-01", until: "2026-09-30", currency: "USD", truncated: false, sites: ["shop.example.com"], rows: [{ id: "shop.example.com", earnings: 12.5 }], totals: { earnings: 12.5, pageViews: 5000, pageRpm: 2.5 } },
    });
    expect(res.body).not.toContain("AS_ACCESS");
    expect(seen[0]!.searchParams.getAll("filters")).toEqual(["DOMAIN_CODE==shop.example.com"]);
    expect((await ctx.app.inject({ method: "GET", url: reportUrl(conn.id), headers })).json().cached).toBe(true);
    expect(seen).toHaveLength(1);
    // Other sites chosen: another report, asked of AdSense again.
    await systemDb.adConnection.update({ where: { id: conn.id }, data: { sites: ["shop.example.com", "blog.example.com"] } });
    expect((await ctx.app.inject({ method: "GET", url: reportUrl(conn.id), headers })).json()).toMatchObject({ cached: false, report: { sites: ["shop.example.com", "blog.example.com"] } });
    // Country and device type are levels too; anything else isn't.
    for (const level of ["country", "platform"]) expect((await ctx.app.inject({ method: "GET", url: reportUrl(conn.id, { level }), headers })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "GET", url: reportUrl(conn.id, { level: "keyword" }), headers })).statusCode).toBe(400);
  });

  it("AdSense refusing to limit the account to the store's sites answers an error, never every site's earnings", async () => {
    const conn = await connectedAdsense();
    await systemDb.adConnection.update({ where: { id: conn.id }, data: { sites: ["shop.example.com"] } });
    const seen: URL[] = [];
    usePlatform(adsenseReports(seen, { refuse: true }));
    const res = await ctx.app.inject({ method: "GET", url: reportUrl(conn.id), headers });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("adsense_error");
    expect(res.body).not.toContain("12.5");
    expect(seen.every((u) => u.searchParams.has("filters"))).toBe(true);
  });

  it("an unknown connection, or one of another platform, is not found", async () => {
    await connectedAdsense();
    usePlatform(metaPlatform);
    await connectAll("meta");
    const meta = await systemDb.adConnection.findFirstOrThrow({ where: { storeId, provider: "meta" } });
    for (const id of ["nope", meta.id]) {
      const res = await ctx.app.inject({ method: "GET", url: reportUrl(id), headers });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("not_found");
    }
  });
});

describe("the Meta Ads report compared with other dates", () => {
  /** Meta's insights: the account and campaign levels, with a spend of `spend[since]` for each range. */
  const insights = (asked: string[], spend: Record<string, string>): FetchLike => async (input) => {
    const u = new URL(String(input));
    if (u.pathname.endsWith("/act_1/insights")) {
      const range = JSON.parse(u.searchParams.get("time_range")!) as { since: string; until: string };
      asked.push(`${u.searchParams.get("level")}:${range.since}`);
      if (u.searchParams.get("level") === "account") return json({ data: [{ spend: spend[range.since], impressions: "1000", reach: "400" }] });
      return json({ data: [{ campaign_id: "11", campaign_name: "Spring sale", spend: spend[range.since], impressions: "1000", reach: "400", inline_link_clicks: "10" }] });
    }
    if (u.pathname.endsWith("/act_1/campaigns")) {
      asked.push("statuses");
      return json({ data: [{ id: "11", effective_status: "ACTIVE" }] });
    }
    return metaPlatform(input);
  };
  const reportUrl = (connection: string, q: Record<string, string>) => `/workspaces/${ws}/stores/${storeId}/ads/meta/report?${new URLSearchParams({ connection, from: "2026-09-01", to: "2026-09-30", ...q })}`;

  it("both ranges at once, each cached on its own; the comparison's totals and rows by id", async () => {
    usePlatform(metaPlatform);
    await connectAll("meta");
    const conn = await systemDb.adConnection.findFirstOrThrow({ where: { storeId, accountId: "act_1" } });
    const asked: string[] = [];
    usePlatform(insights(asked, { "2026-09-01": "100", "2026-08-01": "80" }));
    const res = await ctx.app.inject({ method: "GET", url: reportUrl(conn.id, { cfrom: "2026-08-01", cto: "2026-08-30" }), headers });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.cached).toBe(false);
    expect(body.report).toMatchObject({ since: "2026-09-01", until: "2026-09-30", totals: { spend: 100 }, rows: [{ id: "11", name: "Spring sale", status: "ACTIVE", spend: 100 }] });
    expect(body.report.comparison).toMatchObject({ since: "2026-08-01", until: "2026-08-30", totals: { spend: 80, reach: 400 }, rows: [{ id: "11", spend: 80, linkClicks: 10 }] });
    // Only figures beside each id: no names or statuses again.
    expect(body.report.comparison.rows[0].name).toBeUndefined();
    // Delivery statuses are read for the report's own rows only (they're list calls on Meta's rate limit).
    expect(asked.sort()).toEqual(["account:2026-08-01", "account:2026-09-01", "campaign:2026-08-01", "campaign:2026-09-01", "statuses"]);
    // The range on its own comes from the cache now.
    const alone = await ctx.app.inject({ method: "GET", url: reportUrl(conn.id, {}), headers });
    expect(alone.json()).toMatchObject({ cached: true, report: { totals: { spend: 100 } } });
    expect(alone.json().report.comparison).toBeUndefined();
    expect(asked).toHaveLength(5);
    // The comparison's dates asked as a report of their own: never the status-less copy, read again with statuses.
    const own = await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${storeId}/ads/meta/report?${new URLSearchParams({ connection: conn.id, from: "2026-08-01", to: "2026-08-30" })}`, headers });
    expect(own.json()).toMatchObject({ cached: false, report: { totals: { spend: 80 }, rows: [{ id: "11", status: "ACTIVE" }] } });
    expect(asked).toHaveLength(8);
    // Comparison dates that aren't a real range of up to a year, or only one of them: refused.
    const bad: Array<Record<string, string>> = [{ cfrom: "2026-08-30", cto: "2026-08-01" }, { cfrom: "2026-08-01" }, { cfrom: "2024-01-01", cto: "2026-08-01" }, { cto: "2026-08-01" }];
    for (const q of bad) {
      expect((await ctx.app.inject({ method: "GET", url: reportUrl(conn.id, q), headers })).statusCode).toBe(400);
    }
  });

  it("a report Meta is still preparing when the request's time is up says so, apart from Meta being busy", async () => {
    usePlatform(metaPlatform);
    await connectAll("meta");
    const conn = await systemDb.adConnection.findFirstOrThrow({ where: { storeId, accountId: "act_1" } });
    // Meta asks for a report job ("reduce the amount of data"), and by then the request's time has gone.
    const real = Date.now.bind(Date);
    let skew = 0;
    vi.spyOn(Date, "now").mockImplementation(() => real() + skew);
    try {
      usePlatform(async (input) => {
        const u = new URL(String(input));
        if (u.pathname.endsWith("/act_1/insights")) {
          skew = 45_000;
          return json({ error: { message: "Please reduce the amount of data you're asking for, then retry your request", code: 1 } }, 500);
        }
        return metaPlatform(input);
      });
      const res = await ctx.app.inject({ method: "GET", url: reportUrl(conn.id, { cfrom: "2026-08-01", cto: "2026-08-30" }), headers });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: "meta_report_pending", message: "Meta is still preparing this report. Try again in a minute." });
    } finally {
      vi.restoreAllMocks();
    }
    // Nothing about the account: it stays as it was.
    expect((await systemDb.adConnection.findUniqueOrThrow({ where: { id: conn.id } })).status).toBe("active");
    // Meta itself throttling is "busy".
    usePlatform(async (input) => (new URL(String(input)).pathname.endsWith("/act_1/insights") ? json({ error: { message: "User request limit reached", code: 17 } }, 400) : metaPlatform(input)));
    const busy = await ctx.app.inject({ method: "GET", url: reportUrl(conn.id, {}), headers });
    expect(busy.statusCode).toBe(503);
    expect(busy.json().error).toBe("meta_busy");
  });
});

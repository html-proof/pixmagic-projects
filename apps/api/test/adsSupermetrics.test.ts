import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { systemDb } from "@app/db";
import { syncAdConnection, type FetchLike } from "@app/core";
import { clean, createStore, createWorkspace, setup, signIn, teardown, type TestCtx } from "./helpers.js";

/**
 * "Connect through Supermetrics" (docs/supermetrics.md): the login link round trip, the accounts it
 * connects, syncing them through Supermetrics' Data API, their sync records, and giving the login back
 * when nothing uses it any more. Supermetrics is a fake shaped like its documented API.
 */

let ctx: TestCtx;
beforeAll(async () => (ctx = await setup()));
afterAll(async () => teardown(ctx));

const KEY = "sm_test_key_0123456789abcdef";
const SM = { SUPERMETRICS_API_KEY: KEY, SUPERMETRICS_SOURCES: "meta,google,adsense", META_APP_ID: "", META_APP_SECRET: "", GOOGLE_ADS_CLIENT_ID: "", GOOGLE_ADS_CLIENT_SECRET: "", GOOGLE_ADS_ENABLED: "" };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface FakeSupermetrics {
  fetchImpl: FetchLike;
  links: Array<Record<string, unknown>>;
  revoked: string[];
  queries: Array<Record<string, unknown>>;
  paths: string[];
  /** Set to make the link come back without a sign-in. */
  unused: boolean;
  licensed: boolean;
  accounts: Array<{ account_id: string; name: string }>;
}

/** Supermetrics' Management and Data APIs, enough for one Meta login with `accounts`. */
function supermetrics(): FakeSupermetrics {
  const s: FakeSupermetrics = {
    links: [],
    revoked: [],
    queries: [],
    paths: [],
    unused: false,
    licensed: true,
    accounts: [{ account_id: "555", name: "Shop FB" }],
    fetchImpl: async (input, init) => {
      const u = new URL(String(input));
      if (u.host !== "api.supermetrics.com") return json({ error: { message: `unexpected ${u.host}` } }, 400);
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${KEY}`);
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
      const method = init?.method ?? "GET";
      s.paths.push(`${method} ${u.pathname}`);
      if (u.pathname === "/query/accounts") return s.licensed ? json({ data: [] }) : json({ meta: {}, error: { code: "LICENSE_ACCESS_DATA_SOURCE", message: "Not in licence" } }, 403);
      if (u.pathname === "/ds/login/link" && method === "POST") {
        s.links.push(body!);
        return json({ data: { link_id: `lnk_${s.links.length}`, status_code: "OPEN", ds_id: body!.ds_id, login_url: "https://hub.supermetrics.com/login/link/xyz" } }, 201);
      }
      const link = /^\/ds\/login\/link\/(lnk_\d+)(\/close)?$/.exec(u.pathname);
      if (link) return json({ data: { link_id: link[1], status_code: "CLOSED", ...(s.unused ? {} : { login_id: "login_9", login_username: "owner@fb" }) } });
      if (u.pathname === "/ds/login/login_9" && method === "GET") return json({ data: { login_id: "login_9", username: "owner@fb", display_name: "Owner", ds_info: { ds_id: "FA" }, is_refreshable: true } });
      if (u.pathname === "/ds/login/login_9" && method === "DELETE") {
        s.revoked.push("login_9");
        return json({ data: { result: true } });
      }
      if (u.pathname === "/ds/login/login_9/accounts") return json({ meta: { paginate: { offset: 0, limit: 1000, total: s.accounts.length } }, data: s.accounts });
      if (u.pathname === "/query/data/json") {
        s.queries.push(body!);
        const fields = body!.fields as string[];
        const row: Record<string, unknown> = fields.includes("adcampaign_id")
          ? { Date: "2026-10-20", adcampaign_id: "77", adcampaign_name: "Sale", cost: 12.5, impressions: 900, Clicks: 30, inline_link_clicks: 20, action_omni_purchase: 2, purchase_conversion_value: 150 }
          : { Date: "2026-10-20", currency: "AUD", timezone_name: "Australia/Melbourne", account_status: "ACTIVE", profile: "Shop FB", cost: 12.5, impressions: 900, Clicks: 30, inline_link_clicks: 20, action_omni_purchase: 2, purchase_conversion_value: 150 };
        return json({ meta: { status_code: "SUCCESS", query: { fields: fields.map((id, i) => ({ id, field_id: id, data_column: i })) } }, data: [fields.map((f) => row[f] ?? null)] });
      }
      return json({ error: { code: "NOT_FOUND", message: `unexpected ${method} ${u.pathname}` } }, 404);
    },
  };
  return s;
}

let headers: Record<string, string>;
let cookie: string;
let ws: string;
let storeId: string;
let sm: FakeSupermetrics;

beforeEach(async () => {
  await clean(ctx);
  ctx.setEnv(SM);
  sm = supermetrics();
  ctx.setFetch(sm.fetchImpl);
  const u = await signIn(ctx, "sm-owner", "owner@x.com");
  headers = u.headers;
  cookie = u.cookie;
  ws = await createWorkspace(ctx, headers);
  storeId = (await createStore(ws, "sm-shop.myshopify.com", ["read_orders"], { currency: "AUD" })).id;
});

const adsUrl = () => `/workspaces/${ws}/stores/${storeId}/ads`;
const start = (provider = "meta", payload: Record<string, unknown> = {}) => ctx.app.inject({ method: "POST", url: `${adsUrl()}/${provider}/supermetrics/connect`, headers, payload });

/** Start a Supermetrics sign-in and come back to the callback with its state (and this browser's cookie). */
async function flow(provider = "meta") {
  const res = await start(provider);
  expect(res.statusCode).toBe(200);
  const redirect = new URL(String(sm.links.at(-1)!.redirect_url));
  const state = redirect.searchParams.get("state")!;
  const cb = await ctx.app.inject({ method: "GET", url: `/ads/supermetrics/callback?${new URLSearchParams({ state })}`, headers: { cookie: `${cookie}; ads_sm_state=${state}` } });
  return { res, cb, state, redirect };
}

describe("connecting through Supermetrics", () => {
  it("is offered only with bizinsights' Supermetrics key, for the platforms its licence lists", async () => {
    expect((await ctx.app.inject({ method: "GET", url: adsUrl(), headers })).json().supermetrics).toEqual({ meta: true, google: true, adsense: true });
    ctx.setEnv({ SUPERMETRICS_SOURCES: "meta" });
    expect((await ctx.app.inject({ method: "GET", url: adsUrl(), headers })).json().supermetrics).toEqual({ meta: true, google: false, adsense: false });
    expect((await start("google")).statusCode).toBe(503);
    ctx.setEnv({ SUPERMETRICS_API_KEY: "" });
    expect((await ctx.app.inject({ method: "GET", url: adsUrl(), headers })).json().supermetrics).toEqual({ meta: false, google: false, adsense: false });
    const off = await start("meta");
    expect(off.statusCode).toBe(503);
    expect(off.json().error).toBe("not_configured");
    expect(sm.links).toHaveLength(0);
  });

  it("sends the browser to Supermetrics' own page with a link for the platform that comes back to bizinsights", async () => {
    const res = await start("meta");
    expect(res.statusCode).toBe(200);
    expect(res.json().url).toBe("https://hub.supermetrics.com/login/link/xyz");
    expect(String(res.headers["set-cookie"])).toContain("ads_sm_state=");
    const [link] = sm.links;
    expect(link).toMatchObject({ ds_id: "FA" });
    expect(String(link!.redirect_url)).toMatch(/^http:\/\/localhost:3001\/api\/ads\/supermetrics\/callback\?state=[A-Za-z0-9_-]{16,64}$/);
    // The team's own list of links names the workspace and store, never the person.
    expect(String(link!.description)).toContain(ws);
    expect(String(link!.description)).not.toContain("owner@x.com");
  });

  it("refuses a platform the team's licence doesn't include, before anyone signs in", async () => {
    sm.licensed = false;
    const res = await start("adsense");
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("not_licensed");
    expect(sm.links).toHaveLength(0);
  });

  it("connects the account the login reaches, read through that login, and lands on the dashboard", async () => {
    const { cb } = await flow("meta");
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe(`http://localhost:3001/dashboard?adsConnected=meta&accounts=1&store=${storeId}&via=supermetrics`);
    // The link is read from Supermetrics by its id (never from the browser) and closed.
    expect(sm.paths).toEqual(expect.arrayContaining(["GET /ds/login/link/lnk_1", "PUT /ds/login/link/lnk_1/close", "GET /ds/login/login_9", "GET /ds/login/login_9/accounts"]));
    const conn = await systemDb.adConnection.findFirstOrThrow({ where: { storeId } });
    expect(conn).toMatchObject({ provider: "meta", accountId: "act_555", accountName: "Shop FB", source: "supermetrics", sourceLoginId: "login_9", externalUserId: null, grantedScopes: [], refreshTokenEnc: null });
    // The login's username is sealed, never stored as it is.
    expect(conn.accessTokenEnc).not.toContain("owner@fb");
    expect(await systemDb.auditLog.findFirst({ where: { action: "ads.connected" } })).toMatchObject({ metadata: expect.objectContaining({ provider: "meta", source: "supermetrics" }) });

    const list = (await ctx.app.inject({ method: "GET", url: adsUrl(), headers })).json();
    expect(list.connections[0]).toMatchObject({ accountId: "act_555", source: "supermetrics", permission: null, accessExpiresAt: null });
    expect(JSON.stringify(list)).not.toContain("owner@fb");
  });

  it("syncs through Supermetrics: the days stored in the account's currency, the attempt and its record kept", async () => {
    await flow("meta");
    const conn = await systemDb.adConnection.findFirstOrThrow({ where: { storeId } });
    const res = await syncAdConnection(conn.id, "2026-10-20", "2026-10-20", sm.fetchImpl, { trigger: "request" });
    expect(res).toMatchObject({ skipped: false, stored: 1, since: "2026-10-20", until: "2026-10-20" });
    // Every query names the login's username and this one account, and nothing else.
    expect(sm.queries.length).toBe(2);
    for (const q of sm.queries) expect(q).toMatchObject({ ds_id: "FA", ds_user: "owner@fb", ds_accounts: ["555"] });
    const after = await systemDb.adConnection.findUniqueOrThrow({ where: { id: conn.id } });
    expect(after).toMatchObject({ status: "active", currency: "AUD", timezone: "Australia/Melbourne", accountStatus: "active" });
    expect(after.lastSyncAttemptAt).not.toBeNull();
    const days = await systemDb.adCampaignDaily.findMany({ where: { connectionId: conn.id } });
    expect(days.map((d) => [d.campaignId, Number(d.spend), d.currency, Number(d.purchases)])).toEqual([["77", 12.5, "AUD", 2]]);

    const syncs = await ctx.app.inject({ method: "GET", url: `${adsUrl()}/connections/${conn.id}/syncs`, headers });
    expect(syncs.statusCode).toBe(200);
    expect(syncs.json().runs).toEqual([expect.objectContaining({ trigger: "request", outcome: "synced", rows: 1, since: "2026-10-20", until: "2026-10-20", source: "supermetrics" })]);
  });

  it("a sync Supermetrics refuses because the login ended asks for a reconnect, recorded as such", async () => {
    await flow("meta");
    const conn = await systemDb.adConnection.findFirstOrThrow({ where: { storeId } });
    const expired: FetchLike = async () => json({ meta: {}, error: { code: "QUERY_AUTH_EXPIRED", message: "Login expired" } }, 400);
    await expect(syncAdConnection(conn.id, "2026-10-20", "2026-10-20", expired, { trigger: "request" })).rejects.toThrow();
    expect(await systemDb.adConnection.findUniqueOrThrow({ where: { id: conn.id } })).toMatchObject({ status: "reconnect", errorCode: "auth_expired" });
    const runs = (await ctx.app.inject({ method: "GET", url: `${adsUrl()}/connections/${conn.id}/syncs`, headers })).json().runs;
    expect(runs[0]).toMatchObject({ outcome: "failed", reason: "auth_expired" });
    expect(runs[0].message).toMatch(/Reconnect/);

    // Reconnecting asks the same platform user to sign in again.
    const again = await start("meta", { reconnect: conn.id });
    expect(again.statusCode).toBe(200);
    expect(sm.links.at(-1)).toMatchObject({ ds_id: "FA", require_username: "owner@fb" });
  });

  it("several accounts wait for the person's choice; cancelling gives the login back", async () => {
    sm.accounts = [
      { account_id: "555", name: "Shop FB" },
      { account_id: "556", name: "Other brand" },
    ];
    const { cb } = await flow("meta");
    const location = new URL(String(cb.headers.location));
    expect(location.pathname).toBe("/settings/ads");
    expect(location.searchParams.get("via")).toBe("supermetrics");
    const pick = location.searchParams.get("choose")!;
    const pending = await ctx.app.inject({ method: "GET", url: `${adsUrl()}/pending/${pick}`, headers });
    expect(pending.json().accounts.map((a: { accountId: string }) => a.accountId)).toEqual(["act_555", "act_556"]);
    const cancel = await ctx.app.inject({ method: "DELETE", url: `${adsUrl()}/pending/${pick}`, headers });
    expect(cancel.statusCode).toBe(200);
    expect(sm.revoked).toEqual(["login_9"]);
    expect(await systemDb.adConnection.count({ where: { storeId } })).toBe(0);
  });

  it("disconnecting the last account read through a login ends that login; not before", async () => {
    sm.accounts = [
      { account_id: "555", name: "Shop FB" },
      { account_id: "556", name: "Other brand" },
    ];
    const { cb } = await flow("meta");
    const pick = new URL(String(cb.headers.location)).searchParams.get("choose")!;
    const done = await ctx.app.inject({ method: "POST", url: `${adsUrl()}/pending/${pick}`, headers, payload: { accountIds: ["act_555", "act_556"] } });
    expect(done.json()).toEqual({ provider: "meta", connected: 2 });
    const [a, b] = await systemDb.adConnection.findMany({ where: { storeId }, orderBy: { accountId: "asc" } });
    const first = await ctx.app.inject({ method: "DELETE", url: `${adsUrl()}/connections/${a!.id}`, headers });
    expect(first.json()).toEqual({ ok: true, revoked: "still_used" });
    expect(sm.revoked).toEqual([]);
    const last = await ctx.app.inject({ method: "DELETE", url: `${adsUrl()}/connections/${b!.id}`, headers });
    expect(last.json()).toEqual({ ok: true, revoked: "revoked" });
    expect(sm.revoked).toEqual(["login_9"]);
  });

  it("refuses a callback this browser didn't start, and says so when the link wasn't used to sign in", async () => {
    await start("meta");
    const state = new URL(String(sm.links[0]!.redirect_url)).searchParams.get("state")!;
    const foreign = await ctx.app.inject({ method: "GET", url: `/ads/supermetrics/callback?state=${state}`, headers: { cookie } });
    expect(new URL(String(foreign.headers.location)).searchParams.get("error")).toBe("state_mismatch");
    expect(sm.paths.filter((p) => p.includes("/ds/login/link/"))).toEqual([]);

    sm.unused = true;
    const { cb } = await flow("meta");
    const back = new URL(String(cb.headers.location));
    expect(back.searchParams.get("error")).toBe("denied");
    expect(back.searchParams.get("via")).toBe("supermetrics");
    expect(await systemDb.adConnection.count({ where: { storeId } })).toBe(0);
  });

  it("another workspace's member can't read a connection's syncs", async () => {
    await flow("meta");
    const conn = await systemDb.adConnection.findFirstOrThrow({ where: { storeId } });
    const other = await signIn(ctx, "sm-stranger", "stranger@x.com");
    await createWorkspace(ctx, other.headers);
    const res = await ctx.app.inject({ method: "GET", url: `${adsUrl()}/connections/${conn.id}/syncs`, headers: other.headers });
    expect([403, 404]).toContain(res.statusCode);
  });
});

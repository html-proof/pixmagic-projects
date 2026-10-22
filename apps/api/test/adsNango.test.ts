import { createHmac } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { systemDb } from "@app/db";
import { encryptAdTokens, forgetNangoToken, sweepNangoOrphans, syncAdConnection, type FetchLike } from "@app/core";
import { LEGACY_GRANTS } from "@app/shared";
import { clean, cookiesFrom, createStore, createWorkspace, setup, signIn, teardown, type TestCtx } from "./helpers.js";

/**
 * Connecting Meta Ads and AdSense through Nango (docs/nango.md): the connect session, the finish that
 * checks the connection with Nango before trusting it, the account choice, syncing with the token Nango
 * keeps, giving the grant back and deleting the Nango connection, Nango's signed webhooks, and keeping
 * one workspace's sign-in away from another's. Nango, Meta and Google are fakes shaped like their APIs.
 */

let ctx: TestCtx;
beforeAll(async () => (ctx = await setup()));
afterAll(async () => teardown(ctx));
afterEach(() => vi.restoreAllMocks());

const NANGO_KEY = "nango-secret-0123456789abcdef0123456789";
const WEBHOOK_KEY = "nango-webhook-signing-key-0123";
const KEYS = {
  META_APP_ID: "meta_app",
  META_APP_SECRET: "meta_secret",
  META_CONFIG_ID: "cfg_123",
  GOOGLE_ADS_CLIENT_ID: "g_client",
  GOOGLE_ADS_CLIENT_SECRET: "g_secret",
  GOOGLE_ADS_ENABLED: "",
  NANGO_SECRET_KEY: NANGO_KEY,
  NANGO_WEBHOOK_SECRET: WEBHOOK_KEY,
  NANGO_PROVIDERS: "meta,adsense",
  SUPERMETRICS_API_KEY: "",
};

/** When the Meta token Nango holds ends (about 60 days out). */
const META_EXPIRY = new Date(Date.now() + 50 * 86_400_000).toISOString();

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface Conn {
  key: string;
  tags: Record<string, string>;
  token: string;
  dead?: boolean;
}

interface World {
  fetchImpl: FetchLike;
  sessions: Array<Record<string, unknown>>;
  connections: Map<string, Conn>;
  deleted: string[];
  metaRevoked: number;
  googleRevoked: string[];
  tokenFetches: number;
  /** Meta: the ad accounts the login reaches, and whether ads_read was granted. */
  metaAccounts: Array<{ id: string; name: string }>;
  adsRead: "granted" | "declined";
  /** Google: which client the token was issued to. */
  googleAud: string;
  /** Google's tokeninfo names the person (as it does for some tokens); false: only userinfo does, for a token with openid. */
  tokeninfoSub: boolean;
}

/** Nango's API, Meta's Graph API and Google's tokeninfo/revoke/AdSense, enough for one sign-in of each. */
function world(): World {
  const w: World = {
    sessions: [],
    connections: new Map(),
    deleted: [],
    metaRevoked: 0,
    googleRevoked: [],
    tokenFetches: 0,
    metaAccounts: [{ id: "act_1", name: "Shop ads" }],
    adsRead: "granted",
    googleAud: "g_client",
    tokeninfoSub: true,
    fetchImpl: async (input, init) => {
      const u = new URL(String(input));
      const method = init?.method ?? "GET";
      if (u.host === "api.nango.dev") {
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${NANGO_KEY}`);
        if (u.pathname === "/connect/sessions" && method === "POST") {
          w.sessions.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return json({ data: { token: `nango_connect_session_${w.sessions.length}`, expires_at: "2099-01-01T00:00:00Z" } }, 201);
        }
        if (u.pathname === "/connections" && method === "GET") {
          const id = u.searchParams.get("connectionId")!;
          const c = w.connections.get(id);
          return json({ connections: c ? [{ id: 1, connection_id: id, provider: c.key.includes("meta") ? "facebook" : "google", provider_config_key: c.key, created: "2026-10-22T00:00:00Z", tags: c.tags }] : [] });
        }
        const one = /^\/connections\/([^/]+)$/.exec(u.pathname);
        if (one) {
          const id = decodeURIComponent(one[1]!);
          const c = w.connections.get(id);
          if (!c || c.key !== u.searchParams.get("provider_config_key")) return json({ error: { code: "not_found", message: "Connection not found" } }, 404);
          if (method === "DELETE") {
            w.deleted.push(id);
            w.connections.delete(id);
            return json({ success: true });
          }
          w.tokenFetches++;
          if (c.dead) return json({ error: { code: "invalid_credentials", message: "refresh failed" } }, 424);
          return json({ connection_id: id, provider_config_key: c.key, credentials: { type: "OAUTH2", access_token: c.token, expires_at: c.key.includes("meta") ? META_EXPIRY : "2099-01-01T00:00:00Z", raw: {} } });
        }
        return json({ error: { code: "not_found", message: `unexpected ${method} ${u.pathname}` } }, 404);
      }
      if (u.host === "graph.facebook.com") {
        // Every Meta call is signed with bizinsights' own app secret: a token from another app would fail here.
        expect(u.searchParams.get("appsecret_proof") ?? new URLSearchParams(String(init?.body ?? "")).get("appsecret_proof")).toBeTruthy();
        if (u.pathname.endsWith("/me/permissions/ads_read") && method === "DELETE") {
          w.metaRevoked++;
          return json({ success: true });
        }
        if (u.pathname.endsWith("/me/permissions")) return json({ data: [{ permission: "ads_read", status: w.adsRead }] });
        if (u.pathname.endsWith("/me/adaccounts")) return json({ data: w.metaAccounts.map((a) => ({ ...a, currency: "USD", timezone_name: "UTC", account_status: 1 })) });
        if (u.pathname.endsWith("/me")) return json({ id: "4242" });
        return json({ error: { message: `unexpected ${u.pathname}`, code: 100 } }, 400);
      }
      if (u.host === "oauth2.googleapis.com" && u.pathname === "/tokeninfo") {
        return json({ aud: w.googleAud, ...(w.tokeninfoSub ? { sub: "100200300" } : {}), scope: "https://www.googleapis.com/auth/adsense.readonly openid" });
      }
      if (u.host === "openidconnect.googleapis.com" && u.pathname === "/v1/userinfo") {
        return new Headers(init?.headers).get("authorization")?.startsWith("Bearer ") ? json({ sub: "100200300" }) : json({ error: "invalid_token" }, 401);
      }
      if (u.host === "oauth2.googleapis.com" && u.pathname === "/revoke") {
        w.googleRevoked.push(new URLSearchParams(String(init?.body)).get("token")!);
        return json({});
      }
      if (u.host === "adsense.googleapis.com" && u.pathname === "/v2/accounts") return json({ accounts: [{ name: "accounts/pub-77", displayName: "Shop site", timeZone: { id: "UTC" }, state: "READY" }] });
      if (u.host === "adsense.googleapis.com" && u.pathname === "/v2/accounts/pub-77/reports:generate") {
        return json({
          headers: [
            { name: "DATE", type: "DIMENSION" },
            { name: "DOMAIN_CODE", type: "DIMENSION" },
            { name: "ESTIMATED_EARNINGS", type: "METRIC_CURRENCY", currencyCode: "USD" },
            { name: "PAGE_VIEWS", type: "METRIC_TALLY" },
            { name: "IMPRESSIONS", type: "METRIC_TALLY" },
            { name: "CLICKS", type: "METRIC_TALLY" },
          ],
          rows: [{ cells: ["2026-10-20", "shop.example.com", "12.34", "1000", "800", "9"].map((value) => ({ value })) }],
        });
      }
      return json({ error: { message: `unexpected ${u.host}${u.pathname}` } }, 400);
    },
  };
  return w;
}

let headers: Record<string, string>;
let ws: string;
let storeId: string;
let w: World;

beforeEach(async () => {
  await clean(ctx);
  forgetNangoToken();
  ctx.setEnv(KEYS);
  w = world();
  ctx.setFetch(w.fetchImpl);
  const u = await signIn(ctx, "nango-owner", "owner@x.com");
  headers = u.headers;
  ws = await createWorkspace(ctx, headers);
  storeId = (await createStore(ws, "nango-shop.myshopify.com", ["read_orders"], { currency: "USD" })).id;
});

const adsUrl = (w2 = ws, s = storeId) => `/workspaces/${w2}/stores/${s}/ads`;
const session = (provider: string, h = headers, w2 = ws, s = storeId) => ctx.app.inject({ method: "POST", url: `${adsUrl(w2, s)}/${provider}/nango/session`, headers: h, payload: {} });
const finish = (provider: string, payload: Record<string, unknown>, h = headers, w2 = ws, s = storeId) => ctx.app.inject({ method: "POST", url: `${adsUrl(w2, s)}/${provider}/nango/finish`, headers: h, payload });

/** What Nango does when the person authorizes in the Connect UI: a connection carrying the session's tags. */
function authorize(sessionIndex: number, connectionId = `conn-${sessionIndex}`, token = `TOKEN_${sessionIndex}`) {
  const s = w.sessions[sessionIndex]!;
  w.connections.set(connectionId, { key: (s.allowed_integrations as string[])[0]!, tags: s.tags as Record<string, string>, token });
  return connectionId;
}

/** Start a session, authorize it at "Nango", and finish it. */
async function connectThrough(provider: string) {
  const res = await session(provider);
  expect(res.statusCode).toBe(200);
  const connectionId = authorize(w.sessions.length - 1);
  const done = await finish(provider, { nonce: res.json().nonce, connectionId });
  return { res, done, connectionId, nonce: res.json().nonce as string };
}

const sign = (raw: string, key = WEBHOOK_KEY) => createHmac("sha256", key).update(raw).digest("hex");
const webhook = (body: unknown, signature?: string) => {
  const raw = JSON.stringify(body);
  return ctx.app.inject({ method: "POST", url: "/webhooks/nango", headers: { "content-type": "application/json", "x-nango-hmac-sha256": signature ?? sign(raw) }, payload: raw });
};

describe("which platforms go through Nango", () => {
  it("those NANGO_PROVIDERS lists, once the key is set and the platform's own app is set up", async () => {
    expect((await ctx.app.inject({ method: "GET", url: adsUrl(), headers })).json().nango).toEqual({ meta: true, google: false, adsense: true });
    ctx.setEnv({ NANGO_PROVIDERS: "adsense" });
    expect((await ctx.app.inject({ method: "GET", url: adsUrl(), headers })).json().nango).toEqual({ meta: false, google: false, adsense: true });
    expect((await session("meta")).json().error).toBe("not_configured");
    // Meta's own app keys missing: its tokens couldn't be checked or read, so it isn't offered.
    ctx.setEnv({ NANGO_PROVIDERS: "meta,adsense", META_APP_SECRET: "" });
    expect((await ctx.app.inject({ method: "GET", url: adsUrl(), headers })).json().nango.meta).toBe(false);
    ctx.setEnv({ NANGO_SECRET_KEY: "" });
    expect((await ctx.app.inject({ method: "GET", url: adsUrl(), headers })).json().nango).toEqual({ meta: false, google: false, adsense: false });
    expect((await session("adsense")).statusCode).toBe(503);
    expect(w.sessions).toHaveLength(0);
  });
});

describe("a connect session", () => {
  it("is limited to the platform's integration, tagged with ids only, and carries Meta's Login for Business configuration", async () => {
    const res = await session("meta");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ token: "nango_connect_session_1", nonce: expect.stringMatching(/^[A-Za-z0-9_-]{16,64}$/) });
    const [s] = w.sessions;
    expect(s!.allowed_integrations).toEqual(["bizinsights-meta-ads"]);
    expect(s!.integrations_config_defaults).toEqual({ "bizinsights-meta-ads": { authorization_params: { config_id: "cfg_123" } } });
    const me = await systemDb.user.findFirstOrThrow({ where: { email: "owner@x.com" } });
    expect(s!.tags).toEqual({ end_user_id: me.id, organization_id: ws, bi_store: storeId, bi_provider: "meta", bi_session: res.json().nonce });
    // No email or name goes to Nango.
    expect(JSON.stringify(s)).not.toContain("owner@x.com");
  });

  it("needs integrations.manage and a verified email", async () => {
    const me = await systemDb.user.findFirstOrThrow({ where: { email: "owner@x.com" } });
    await systemDb.membership.update({ where: { workspaceId_userId: { workspaceId: ws, userId: me.id } }, data: { role: "analyst", permissions: [...LEGACY_GRANTS.analyst] } });
    expect((await session("meta")).statusCode).toBe(403);
    const other = await signIn(ctx, "nango-unverified", "unverified@x.com", false);
    const theirWs = await createWorkspace(ctx, other.headers);
    const theirStore = (await createStore(theirWs, "theirs.myshopify.com", ["read_orders"])).id;
    const res = await session("meta", other.headers, theirWs, theirStore);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("email_unverified");
    expect(w.sessions).toHaveLength(0);
  });
});

describe("finishing a Nango sign-in", () => {
  it("connects the one AdSense account, keeping only which Nango connection to ask, and syncs with Nango's token", async () => {
    const { done, connectionId } = await connectThrough("adsense");
    expect(done.statusCode).toBe(200);
    expect(done.json()).toEqual({ connected: 1, provider: "adsense" });
    const row = await systemDb.adConnection.findFirstOrThrow({ where: { storeId } });
    expect(row).toMatchObject({ provider: "adsense", accountId: "pub-77", source: "nango", sourceLoginId: connectionId, externalUserId: "100200300", refreshTokenEnc: null, accessTokenExpiresAt: null });
    // A sealed reference, never the platform's token.
    expect(row.accessTokenEnc).toMatch(/^v\d+\./);
    expect(row.accessTokenEnc).not.toContain("TOKEN_0");
    const audit = await systemDb.auditLog.findFirstOrThrow({ where: { action: "ads.connected" } });
    expect(audit.metadata).toMatchObject({ provider: "adsense", source: "nango" });
    // Its catch-up was queued, and the API answer says how it is read.
    expect(ctx.deps.queues.sent.sync).toEqual([expect.objectContaining({ kind: "ads", connectionId: row.id })]);
    const listed = (await ctx.app.inject({ method: "GET", url: adsUrl(), headers })).json().connections[0];
    expect(listed).toMatchObject({ source: "nango", permission: "https://www.googleapis.com/auth/adsense.readonly", accessExpiresAt: null });

    forgetNangoToken();
    const before = w.tokenFetches;
    const result = await syncAdConnection(row.id, "2026-10-20", "2026-10-20", w.fetchImpl, { trigger: "request" });
    expect(result).toMatchObject({ skipped: false });
    expect(w.tokenFetches).toBe(before + 1);
    const days = await systemDb.adsenseDaily.findMany({ where: { connectionId: row.id } });
    expect(days).toHaveLength(1);
    expect(Number(days[0]!.earnings)).toBeCloseTo(12.34);
  });

  it("holds several Meta accounts for the person's choice, then connects the chosen ones through the same Nango connection", async () => {
    w.metaAccounts = [
      { id: "act_1", name: "Shop ads" },
      { id: "act_2", name: "EU ads" },
    ];
    const { done, connectionId } = await connectThrough("meta");
    expect(done.statusCode).toBe(200);
    const pick = done.json().choose as string;
    expect(pick).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    const listed = await ctx.app.inject({ method: "GET", url: `${adsUrl()}/pending/${pick}`, headers });
    expect(listed.json().accounts.map((a: { accountId: string }) => a.accountId)).toEqual(["act_1", "act_2"]);
    const chosen = await ctx.app.inject({ method: "POST", url: `${adsUrl()}/pending/${pick}`, headers, payload: { accountIds: ["act_1", "act_2"] } });
    expect(chosen.json().connected).toBe(2);
    const rows = await systemDb.adConnection.findMany({ where: { storeId }, orderBy: { accountId: "asc" } });
    expect(rows.map((r) => [r.source, r.sourceLoginId, r.externalUserId])).toEqual([
      ["nango", connectionId, "4242"],
      ["nango", connectionId, "4242"],
    ]);
    // One sign-in: one sealed credential for both.
    expect(rows[0]!.accessTokenEnc).toBe(rows[1]!.accessTokenEnc);
    // Meta's token ends (Nango can't move that): the 60-day warning and Settings' countdown know when.
    expect(rows.map((r) => r.accessTokenExpiresAt?.toISOString())).toEqual([META_EXPIRY, META_EXPIRY]);
    expect((await ctx.app.inject({ method: "GET", url: adsUrl(), headers })).json().connections[0].accessExpiresAt).toBe(META_EXPIRY);
  });

  it("cancelling the choice gives the grant back and deletes the Nango connection", async () => {
    w.metaAccounts = [
      { id: "act_1", name: "Shop ads" },
      { id: "act_2", name: "EU ads" },
    ];
    const { done, connectionId } = await connectThrough("meta");
    const cancel = await ctx.app.inject({ method: "DELETE", url: `${adsUrl()}/pending/${done.json().choose}`, headers });
    expect(cancel.statusCode).toBe(200);
    expect(w.metaRevoked).toBe(1);
    expect(w.deleted).toEqual([connectionId]);
    expect(await systemDb.adConnection.count()).toBe(0);
  });

  it("cancelling one choice keeps the grant while another choice of the same person waits", async () => {
    w.metaAccounts = [
      { id: "act_1", name: "Shop ads" },
      { id: "act_2", name: "EU ads" },
    ];
    const first = await connectThrough("meta");
    const second = await connectThrough("meta");
    const cancel = await ctx.app.inject({ method: "DELETE", url: `${adsUrl()}/pending/${second.done.json().choose}`, headers });
    expect(cancel.statusCode).toBe(200);
    // The second connection goes, but the person's ads_read stays: the first choice needs it.
    expect(w.deleted).toEqual([second.connectionId]);
    expect(w.metaRevoked).toBe(0);
    const chosen = await ctx.app.inject({ method: "POST", url: `${adsUrl()}/pending/${first.done.json().choose}`, headers, payload: { accountIds: ["act_1"] } });
    expect(chosen.json().connected).toBe(1);
  });

  it("moving an account from a direct sign-in to Nango keeps the same person's grant", async () => {
    const direct = encryptAdTokens(storeId, "adsense", { accessToken: "DIRECT_ACCESS", refreshToken: "DIRECT_REFRESH", expiresAt: new Date(Date.now() + 3_600_000) });
    await systemDb.adConnection.create({ data: { workspaceId: ws, storeId, provider: "adsense", accountId: "pub-77", ...direct, source: "direct", externalUserId: "100200300" } });
    const { done, connectionId } = await connectThrough("adsense");
    expect(done.json()).toEqual({ connected: 1, provider: "adsense" });
    const row = await systemDb.adConnection.findFirstOrThrow({ where: { storeId } });
    expect(row).toMatchObject({ source: "nango", sourceLoginId: connectionId });
    // The grant the Nango connection now holds is the same person's: never revoked.
    expect(w.googleRevoked).toEqual([]);
    expect(w.deleted).toEqual([]);
  });

  it("refuses a connection this session didn't make, and leaves it alone", async () => {
    const res = await session("adsense");
    // Someone else's connection, tagged for another session.
    w.connections.set("someone-else", { key: "bizinsights-google-adsense", tags: { bi_session: "x".repeat(32) }, token: "THEIRS" });
    const done = await finish("adsense", { nonce: res.json().nonce, connectionId: "someone-else" });
    expect(done.statusCode).toBe(403);
    expect(done.json().error).toBe("state_mismatch");
    expect(w.deleted).toEqual([]);
    expect(w.tokenFetches).toBe(0);
    // The session is used up: it can't be tried again with another id.
    authorize(0, "conn-late");
    expect((await finish("adsense", { nonce: res.json().nonce, connectionId: "conn-late" })).json().error).toBe("state_expired");
  });

  it("is answered for the person who started it only", async () => {
    const res = await session("adsense");
    const connectionId = authorize(0);
    const other = await signIn(ctx, "nango-other", "other@x.com");
    const theirWs = await createWorkspace(ctx, other.headers);
    const theirStore = (await createStore(theirWs, "theirs.myshopify.com", ["read_orders"])).id;
    // Through their own workspace and store, with this session's nonce: refused, nothing connected anywhere.
    const stolen = await finish("adsense", { nonce: res.json().nonce, connectionId }, other.headers, theirWs, theirStore);
    expect(stolen.statusCode).toBe(403);
    expect(stolen.json().error).toBe("session_mismatch");
    // Through this workspace's address: not a member.
    expect((await finish("adsense", { nonce: res.json().nonce, connectionId }, other.headers)).statusCode).toBe(404);
    expect(await systemDb.adConnection.count()).toBe(0);
  });

  it("lets the connection go when the read permission wasn't granted", async () => {
    w.adsRead = "declined";
    const { done, connectionId } = await connectThrough("meta");
    expect(done.statusCode).toBe(409);
    expect(done.json().error).toBe("permission_missing");
    expect(w.deleted).toEqual([connectionId]);
    expect(await systemDb.adConnection.count()).toBe(0);
  });

  it("refuses a Google token issued to another client (the Nango integration isn't bizinsights' own), on our side", async () => {
    w.googleAud = "someone_elses_client";
    const { done, connectionId } = await connectThrough("adsense");
    expect(done.statusCode).toBe(503);
    expect(done.json().error).toBe("not_configured");
    expect(w.deleted).toEqual([connectionId]);
    expect(await systemDb.adConnection.count()).toBe(0);
  });

  it("closing the Connect UI uses the session up", async () => {
    const res = await session("adsense");
    expect((await ctx.app.inject({ method: "POST", url: `${adsUrl()}/adsense/nango/cancel`, headers, payload: { nonce: res.json().nonce } })).statusCode).toBe(200);
    authorize(0);
    expect((await finish("adsense", { nonce: res.json().nonce, connectionId: "conn-0" })).json().error).toBe("state_expired");
  });
});

describe("disconnecting a Nango connection", () => {
  it("gives the grant back and deletes the Nango connection with the last account reading through it", async () => {
    w.metaAccounts = [
      { id: "act_1", name: "Shop ads" },
      { id: "act_2", name: "EU ads" },
    ];
    const { done, connectionId } = await connectThrough("meta");
    await ctx.app.inject({ method: "POST", url: `${adsUrl()}/pending/${done.json().choose}`, headers, payload: { accountIds: ["act_1", "act_2"] } });
    const [a, b] = await systemDb.adConnection.findMany({ where: { storeId }, orderBy: { accountId: "asc" } });
    const first = await ctx.app.inject({ method: "DELETE", url: `${adsUrl()}/connections/${a!.id}`, headers });
    expect(first.json().revoked).toBe("still_used");
    expect(w.deleted).toEqual([]);
    const last = await ctx.app.inject({ method: "DELETE", url: `${adsUrl()}/connections/${b!.id}`, headers });
    expect(last.json().revoked).toBe("revoked");
    expect(w.metaRevoked).toBe(1);
    expect(w.deleted).toEqual([connectionId]);
  });

  it("keeps the person's grant while a direct connection of theirs still uses it", async () => {
    const { connectionId } = await connectThrough("adsense");
    const row = await systemDb.adConnection.findFirstOrThrow({ where: { storeId } });
    // The same Google person connected AdSense directly to another store of this workspace.
    const other = (await createStore(ws, "second.myshopify.com", ["read_orders"])).id;
    const direct = encryptAdTokens(other, "adsense", { accessToken: "DIRECT_ACCESS", refreshToken: "DIRECT_REFRESH", expiresAt: new Date(Date.now() + 3_600_000) });
    await systemDb.adConnection.create({ data: { workspaceId: ws, storeId: other, provider: "adsense", accountId: "pub-77", ...direct, source: "direct", externalUserId: "100200300" } });
    const del = await ctx.app.inject({ method: "DELETE", url: `${adsUrl()}/connections/${row.id}`, headers });
    expect(del.json().revoked).toBe("still_used");
    expect(w.googleRevoked).toEqual([]);
    // The Nango connection itself is no longer used by anything: it goes.
    expect(w.deleted).toEqual([connectionId]);
  });

  it("knows whose Google grant it is through openid when tokeninfo doesn't say, and takes it back on disconnect", async () => {
    // Production 2026-10-22: tokeninfo named nobody for an adsense.readonly-only token, so a disconnect couldn't revoke.
    w.tokeninfoSub = false;
    const { connectionId } = await connectThrough("adsense");
    const row = await systemDb.adConnection.findFirstOrThrow({ where: { storeId } });
    expect(row.externalUserId).toBe("100200300");
    const del = await ctx.app.inject({ method: "DELETE", url: `${adsUrl()}/connections/${row.id}`, headers });
    expect(del.json().revoked).toBe("revoked");
    expect(w.googleRevoked).toHaveLength(1);
    expect(w.deleted).toEqual([connectionId]);
  });

  it("another workspace can't disconnect it", async () => {
    await connectThrough("adsense");
    const row = await systemDb.adConnection.findFirstOrThrow({ where: { storeId } });
    const other = await signIn(ctx, "nango-other", "other@x.com");
    const theirWs = await createWorkspace(ctx, other.headers);
    const theirStore = (await createStore(theirWs, "theirs.myshopify.com", ["read_orders"])).id;
    expect((await ctx.app.inject({ method: "DELETE", url: `${adsUrl(theirWs, theirStore)}/connections/${row.id}`, headers: other.headers })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: "DELETE", url: `${adsUrl()}/connections/${row.id}`, headers: other.headers })).statusCode).toBe(404);
    expect(await systemDb.adConnection.count()).toBe(1);
    expect(w.deleted).toEqual([]);
  });
});

describe("Nango's webhooks", () => {
  it("are refused unsigned, wrongly signed, or with no signing key set", async () => {
    const body = { type: "auth", operation: "refresh", success: false, connectionId: "conn-0", providerConfigKey: "bizinsights-google-adsense" };
    expect((await webhook(body, "0".repeat(64))).statusCode).toBe(401);
    expect((await webhook(body, sign(JSON.stringify(body), "wrong"))).statusCode).toBe(401);
    ctx.setEnv({ NANGO_WEBHOOK_SECRET: "" });
    expect((await webhook(body)).statusCode).toBe(503);
  });

  it("a renewal that failed for now changes nothing; one the platform refused puts the accounts on 'reconnect', once", async () => {
    const { connectionId } = await connectThrough("adsense");
    const body = { from: "nango", type: "auth", operation: "refresh", success: false, connectionId, providerConfigKey: "bizinsights-google-adsense", environment: "prod", error: { type: "refresh_token_external_error" } };
    // Nango gives a working token again when asked: a passing failure.
    expect((await webhook(body)).statusCode).toBe(200);
    expect(await systemDb.adConnection.findFirstOrThrow({ where: { storeId } })).toMatchObject({ status: "active" });
    // The grant is gone: Nango can't renew it.
    w.connections.get(connectionId)!.dead = true;
    expect((await webhook({ ...body, error: { type: "refresh_exhausted" } })).statusCode).toBe(200);
    const row = await systemDb.adConnection.findFirstOrThrow({ where: { storeId } });
    expect(row).toMatchObject({ status: "reconnect", errorCode: "auth_expired" });
    // Sent again (Nango retries): acknowledged, nothing more happens.
    expect((await webhook(body)).statusCode).toBe(200);
    // Other webhook types are acknowledged and left alone.
    expect((await webhook({ type: "sync", connectionId, providerConfigKey: "bizinsights-google-adsense" })).statusCode).toBe(200);
    // Nango's recovery webhook, with a token that works again: the accounts come back.
    w.connections.get(connectionId)!.dead = false;
    expect((await webhook({ ...body, success: true, error: undefined })).statusCode).toBe(200);
    expect(await systemDb.adConnection.findFirstOrThrow({ where: { storeId } })).toMatchObject({ status: "active", errorCode: null });
  });

  it("a connection made but never finished is let go after the grace period", async () => {
    const res = await session("adsense");
    const connectionId = authorize(0);
    expect((await webhook({ type: "auth", operation: "creation", success: true, connectionId, providerConfigKey: "bizinsights-google-adsense", tags: {} })).statusCode).toBe(200);
    expect(await sweepNangoOrphans(ctx.deps.coord, w.fetchImpl)).toBe(0);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 25 * 60_000);
    expect(await sweepNangoOrphans(ctx.deps.coord, w.fetchImpl)).toBe(1);
    expect(w.deleted).toEqual([connectionId]);
    expect(res.statusCode).toBe(200);
  });

  it("a finished connection is never swept", async () => {
    const { connectionId } = await connectThrough("adsense");
    await webhook({ type: "auth", operation: "creation", success: true, connectionId, providerConfigKey: "bizinsights-google-adsense" });
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 25 * 60_000);
    expect(await sweepNangoOrphans(ctx.deps.coord, w.fetchImpl)).toBe(0);
    expect(w.deleted).toEqual([]);
  });
});

describe("bizinsights' address for Nango's OAuth callback", () => {
  it("forwards the platform's answer to Nango's callback, query and all, only for the signed-in person who started the session in this browser", async () => {
    const started = await session("adsense");
    const browser = `${headers.cookie}; ${cookiesFrom(started)}`;
    expect(browser).toContain("ads_nango_state=");
    const res = await ctx.app.inject({ method: "GET", url: "/ads/nango/oauth-callback?code=abc&state=xyz", headers: { cookie: browser } });
    expect(res.statusCode).toBe(308);
    expect(res.headers.location).toBe("https://api.nango.dev/oauth/callback?code=abc&state=xyz");
    // Another browser (a consent given on a page the session token was handed to): never reaches Nango.
    const elsewhere = await ctx.app.inject({ method: "GET", url: "/ads/nango/oauth-callback?code=abc&state=xyz" });
    expect(elsewhere.statusCode).toBe(302);
    expect(elsewhere.headers.location).toContain("/settings/ads?error=state_mismatch");
    // The session cookie with nobody signed in (signed out since, or a browser it was copied to): refused.
    const signedOut = await ctx.app.inject({ method: "GET", url: "/ads/nango/oauth-callback?code=abc&state=xyz", headers: { cookie: cookiesFrom(started) } });
    expect(signedOut.statusCode).toBe(302);
    expect(signedOut.headers.location).toContain("/settings/ads?error=state_mismatch");
    // Someone else signed in, holding this browser's session cookie: refused too.
    const other = await signIn(ctx, "nango-other", "other@x.com");
    const mixed = await ctx.app.inject({ method: "GET", url: "/ads/nango/oauth-callback?code=abc", headers: { cookie: `${other.cookie}; ${cookiesFrom(started)}` } });
    expect(mixed.statusCode).toBe(302);
    ctx.setEnv({ NANGO_SECRET_KEY: "" });
    expect((await ctx.app.inject({ method: "GET", url: "/ads/nango/oauth-callback?code=abc", headers: { cookie: browser } })).statusCode).toBe(404);
  });
});

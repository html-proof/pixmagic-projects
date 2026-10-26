import { createHmac } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { systemDb } from "@app/db";
import { checkAdLogins, encryptAdTokens, forgetNangoIntegrations, forgetNangoToken, logger, metaDataDeletion, metaDeauthorized, sweepNangoOrphans, syncAdConnection, type FetchLike } from "@app/core";
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
  /** Meta doesn't answer for the login's ad accounts (an outage). */
  metaAccountsDown?: boolean;
  adsRead: "granted" | "declined";
  /** Meta: the secret of the app the tokens were issued to, when it matters. A proof made with another is refused, as Meta does. */
  metaTokenAppSecret?: string;
  /** Google: which client the token was issued to. */
  googleAud: string;
  /** Google's tokeninfo names the person (as it does for some tokens); false: only userinfo does, for a token with openid. */
  tokeninfoSub: boolean;
  /** The integrations bizinsights' Nango environment holds. */
  integrations: string[];
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
    integrations: ["bizinsights-meta-ads", "bizinsights-google-ads", "bizinsights-google-adsense"],
    fetchImpl: async (input, init) => {
      const u = new URL(String(input));
      const method = init?.method ?? "GET";
      if (u.host === "api.nango.dev") {
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${NANGO_KEY}`);
        if (u.pathname === "/integrations" && method === "GET") {
          return json({ data: w.integrations.map((k) => ({ unique_key: k, display_name: k, provider: k.includes("meta") ? "facebook" : "google", created_at: "2026-10-22T00:00:00Z", updated_at: "2026-10-22T00:00:00Z" })) });
        }
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
        const proof = u.searchParams.get("appsecret_proof") ?? new URLSearchParams(String(init?.body ?? "")).get("appsecret_proof");
        expect(proof).toBeTruthy();
        const token = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
        if (w.metaTokenAppSecret !== undefined && proof !== createHmac("sha256", w.metaTokenAppSecret).update(token).digest("hex")) {
          return json({ error: { message: "Invalid appsecret_proof provided in the API argument", type: "GraphMethodException", code: 100 } }, 400);
        }
        if (u.pathname.endsWith("/me/permissions/ads_read") && method === "DELETE") {
          w.metaRevoked++;
          return json({ success: true });
        }
        if (u.pathname.endsWith("/me/permissions")) return json({ data: [{ permission: "ads_read", status: w.adsRead }] });
        if (u.pathname.endsWith("/me/adaccounts")) {
          if (w.metaAccountsDown) return json({ error: { message: "An unexpected error has occurred. Please retry your request later.", type: "OAuthException", code: 2 } }, 500);
          return json({ data: w.metaAccounts.map((a) => ({ ...a, currency: "USD", timezone_name: "UTC", account_status: 1 })) });
        }
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

/** What each platform sends back to the OAuth callback after its consent screen: Google names the scopes granted, Meta doesn't. */
const CONSENT: Record<string, string> = {
  meta: "code=AQmeta-code&state=nango-state",
  adsense: `code=4%2Fgoogle-code&state=nango-state&scope=${encodeURIComponent("https://www.googleapis.com/auth/adsense.readonly openid")}`,
  google: `code=4%2Fgoogle-code&state=nango-state&scope=${encodeURIComponent("https://www.googleapis.com/auth/adwords openid")}`,
};
const callback = (query: string, cookie?: string) => ctx.app.inject({ method: "GET", url: `/ads/nango/oauth-callback?${query}`, headers: cookie ? { cookie } : {} });

/** A browser's cookies after each answer: a later cookie replaces an earlier one of the same name. */
function jar(...parts: string[]) {
  const cookies = new Map<string, string>();
  for (const pair of parts.flatMap((p) => p.split("; ")).filter((p) => p.includes("="))) cookies.set(pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1));
  return [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
}

/** Start a session in a browser signed in with `h`: the session, its nonce, and the browser's cookies after it. */
async function start(provider: string, h = headers, w2 = ws, s = storeId) {
  const res = await session(provider, h, w2, s);
  expect(res.statusCode).toBe(200);
  return { res, nonce: res.json().nonce as string, browser: jar(h.cookie!, cookiesFrom(res)) };
}

/** The platform's consent coming back through the callback in `browser`: forwarded to Nango, with the browser's cookies after it (its receipt). */
async function consent(provider: string, browser: string) {
  const res = await callback(CONSENT[provider]!, browser);
  expect(res.statusCode).toBe(308);
  return jar(browser, cookiesFrom(res));
}

/** Start a session, authorize it at "Nango" (the consent coming back through the callback in this browser), and finish it. */
async function connectThrough(provider: string) {
  const { res, nonce, browser } = await start(provider);
  const connectionId = authorize(w.sessions.length - 1);
  const after = await consent(provider, browser);
  const done = await finish(provider, { nonce, connectionId }, { ...headers, cookie: after });
  return { res, done, connectionId, nonce };
}

const sign = (raw: string, key = WEBHOOK_KEY) => createHmac("sha256", key).update(raw).digest("hex");
const webhook = (body: unknown, signature?: string) => {
  const raw = JSON.stringify(body);
  return ctx.app.inject({ method: "POST", url: "/webhooks/nango", headers: { "content-type": "application/json", "x-nango-hmac-sha256": signature ?? sign(raw) }, payload: raw });
};

describe("which platforms can be connected", () => {
  it("those NANGO_PROVIDERS lists, once the key is set, the platform's own app is set up, and Nango holds its integration", async () => {
    const configured = async () => (await ctx.app.inject({ method: "GET", url: adsUrl(), headers })).json().configured;
    expect(await configured()).toEqual({ meta: true, google: false, adsense: true });
    ctx.setEnv({ NANGO_PROVIDERS: "adsense" });
    expect(await configured()).toEqual({ meta: false, google: false, adsense: true });
    expect((await session("meta")).json().error).toBe("not_configured");
    // Meta's own app keys missing: its tokens couldn't be checked or read, so it isn't offered.
    ctx.setEnv({ NANGO_PROVIDERS: "meta,adsense", META_APP_SECRET: "" });
    expect((await configured()).meta).toBe(false);
    // The integration missing in Nango (nango-setup.mjs not run): not offered either, once Nango is asked again.
    ctx.setEnv({ META_APP_SECRET: "meta_secret" });
    w.integrations = ["bizinsights-meta-ads"];
    expect(await configured()).toEqual({ meta: true, google: false, adsense: true });
    await forgetNangoIntegrations(ctx.deps.coord);
    expect(await configured()).toEqual({ meta: true, google: false, adsense: false });
    expect((await session("adsense")).json().error).toBe("not_configured");
    ctx.setEnv({ NANGO_SECRET_KEY: "" });
    expect(await configured()).toEqual({ meta: false, google: false, adsense: false });
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
    const { nonce, browser } = await start("adsense");
    const after = await consent("adsense", browser);
    // Someone else's connection, tagged for another session.
    w.connections.set("someone-else", { key: "bizinsights-google-adsense", tags: { bi_session: "x".repeat(32) }, token: "THEIRS" });
    const done = await finish("adsense", { nonce, connectionId: "someone-else" }, { ...headers, cookie: after });
    expect(done.statusCode).toBe(403);
    expect(done.json().error).toBe("state_mismatch");
    expect(w.deleted).toEqual([]);
    expect(w.tokenFetches).toBe(0);
    // The session is used up: it can't be tried again with another id.
    authorize(0, "conn-late");
    expect((await finish("adsense", { nonce, connectionId: "conn-late" }, { ...headers, cookie: after })).json().error).toBe("state_expired");
  });

  it("refuses a connection whose consent didn't come back through this browser: someone else's consent can't land on this store", async () => {
    // A starts a session for their store, and hands the platform's consent link (Nango's state) to B.
    const a = await start("meta");
    const connectionId = authorize(0);
    // B, signed in with an open Meta session of their own in their browser, approves on that link: the
    // consent is forwarded, but noted against B's own session, never A's.
    const other = await signIn(ctx, "nango-victim", "victim@x.com");
    const theirWs = await createWorkspace(ctx, other.headers);
    const theirStore = (await createStore(theirWs, "victim.myshopify.com", ["read_orders"])).id;
    const b = await start("meta", other.headers, theirWs, theirStore);
    await consent("meta", b.browser);
    // Nango made the connection under A's session (its tags are A's): A's finish is refused, without a receipt or with one forged in A's browser.
    const refused = await finish("meta", { nonce: a.nonce, connectionId }, { ...headers, cookie: a.browser });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe("state_mismatch");
    const a2 = await start("meta");
    authorize(2, "conn-forged");
    const forged = await finish("meta", { nonce: a2.nonce, connectionId: "conn-forged" }, { ...headers, cookie: jar(a2.browser, `ads_nango_consent=${a2.nonce}`) });
    expect(forged.json().error).toBe("state_mismatch");
    // Nothing attached to A's store, the connection left alone (it isn't A's to give back), no token read.
    expect(await systemDb.adConnection.count()).toBe(0);
    expect(w.deleted).toEqual([]);
    expect(w.tokenFetches).toBe(0);
  });

  it("a receipt from one session doesn't finish another", async () => {
    const first = await start("adsense");
    const after = await consent("adsense", first.browser);
    const second = await start("adsense", { ...headers, cookie: after });
    const connectionId = authorize(1);
    const done = await finish("adsense", { nonce: second.nonce, connectionId }, { ...headers, cookie: second.browser });
    expect(done.json().error).toBe("state_mismatch");
    expect(await systemDb.adConnection.count()).toBe(0);
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

  it("refuses a Meta token Meta won't take our appsecret_proof for (the Nango integration holds other keys), on our side", async () => {
    w.metaTokenAppSecret = "another_apps_secret";
    const { done, connectionId } = await connectThrough("meta");
    expect(done.statusCode).toBe(503);
    expect(done.json().error).toBe("not_configured");
    expect(w.deleted).toEqual([connectionId]);
    expect(await systemDb.adConnection.count()).toBe(0);
    // The same keys on both sides: it connects.
    w.metaTokenAppSecret = KEYS.META_APP_SECRET;
    const again = await connectThrough("meta");
    expect(again.done.statusCode).toBe(200);
    expect(again.done.json().connected).toBe(1);
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

describe("a Meta login with no ad account yet", () => {
  const logins = async () => (await ctx.app.inject({ method: "GET", url: adsUrl(), headers })).json().logins as Array<{ id: string; reason: string }>;
  const check = (id: string) => ctx.app.inject({ method: "POST", url: `${adsUrl()}/logins/${id}/check`, headers, payload: {} });
  const deps = () => ({ coord: ctx.deps.coord, queues: ctx.deps.queues, fetchImpl: w.fetchImpl });

  it("stays connected instead of being refused, and its ad accounts are connected through the same Nango connection once Meta lists them", async () => {
    w.metaAccounts = [];
    const { done, connectionId } = await connectThrough("meta");
    expect(done.statusCode).toBe(200);
    expect(done.json()).toEqual({ connected: 0, waiting: true, reason: "no_ads_account", provider: "meta" });
    expect(w.deleted).toEqual([]);
    expect(w.metaRevoked).toBe(0);
    const [login] = await logins();
    expect(login).toMatchObject({ provider: "meta", reason: "no_ads_account" });
    expect((await systemDb.auditLog.findFirstOrThrow({ where: { action: "ads.login_connected" } })).metadata).toMatchObject({ provider: "meta", reason: "no_ads_account" });

    // Still none: it keeps waiting.
    expect((await check(login!.id)).json()).toEqual({ waiting: true, reason: "no_ads_account" });
    // The person gets an ad account: "Check for ad accounts" connects it, and the login's row goes.
    w.metaAccounts = [{ id: "act_9", name: "New ads" }];
    expect((await check(login!.id)).json()).toEqual({ connected: 1 });
    const row = await systemDb.adConnection.findFirstOrThrow({ where: { storeId } });
    expect(row).toMatchObject({ provider: "meta", accountId: "act_9", source: "nango", sourceLoginId: connectionId, externalUserId: "4242" });
    expect(await logins()).toEqual([]);
    expect(w.deleted).toEqual([]);
    expect(ctx.deps.queues.sent.sync).toEqual([expect.objectContaining({ kind: "ads", connectionId: row.id })]);
  });

  it("the cron tick connects them by itself, and leaves more than it connects unasked for the person's choice", async () => {
    w.metaAccounts = [];
    await connectThrough("meta");
    const later = Date.now() + 2 * 3600_000;
    // Not due yet: nothing is asked.
    expect(await checkAdLogins(deps())).toEqual({ checked: 0, connected: 0, ended: 0 });
    w.metaAccounts = Array.from({ length: 11 }, (_, i) => ({ id: `act_${i + 1}`, name: `Ads ${i + 1}` }));
    expect(await checkAdLogins(deps(), { now: later })).toEqual({ checked: 1, connected: 0, ended: 0 });
    expect((await logins())[0]).toMatchObject({ reason: "choose" });
    expect(await systemDb.adConnection.count()).toBe(0);
    w.metaAccounts = [
      { id: "act_1", name: "Shop ads" },
      { id: "act_2", name: "EU ads" },
    ];
    expect(await checkAdLogins(deps(), { now: later + 2 * 3600_000 })).toEqual({ checked: 1, connected: 1, ended: 0 });
    expect((await systemDb.adConnection.findMany({ where: { storeId }, orderBy: { accountId: "asc" } })).map((r) => r.accountId)).toEqual(["act_1", "act_2"]);
    expect(await logins()).toEqual([]);
  });

  it("Meta not answering in time keeps the login too, asked again sooner; an access that ended lets it go", async () => {
    w.metaAccountsDown = true;
    const { done, connectionId } = await connectThrough("meta");
    expect(done.json()).toMatchObject({ waiting: true, reason: "unanswered" });
    expect(await checkAdLogins(deps(), { now: Date.now() + 15 * 60_000 })).toEqual({ checked: 1, connected: 0, ended: 0 });
    // Nango can't renew the token any more: let go, nothing left to wait with.
    w.connections.get(connectionId)!.dead = true;
    forgetNangoToken();
    expect(await checkAdLogins(deps(), { now: Date.now() + 30 * 60_000 })).toEqual({ checked: 1, connected: 0, ended: 1 });
    expect(await logins()).toEqual([]);
  });

  it("disconnecting it gives the grant back and deletes the Nango connection", async () => {
    w.metaAccounts = [];
    const { connectionId } = await connectThrough("meta");
    const [login] = await logins();
    const other = await signIn(ctx, "nango-other", "other@x.com");
    expect((await ctx.app.inject({ method: "DELETE", url: `${adsUrl()}/logins/${login!.id}`, headers: other.headers })).statusCode).toBe(404);
    const del = await ctx.app.inject({ method: "DELETE", url: `${adsUrl()}/logins/${login!.id}`, headers });
    expect(del.json()).toEqual({ ok: true, revoked: "revoked" });
    expect(w.metaRevoked).toBe(1);
    expect(w.deleted).toEqual([connectionId]);
    expect(await logins()).toEqual([]);
  });

  it("is let go once accounts are connected with another sign-in, keeping the person's grant for them", async () => {
    w.metaAccounts = [];
    const waiting = await connectThrough("meta");
    w.metaAccounts = [{ id: "act_1", name: "Shop ads" }];
    const again = await connectThrough("meta");
    expect(again.done.json()).toEqual({ connected: 1, provider: "meta" });
    expect(await logins()).toEqual([]);
    expect(w.deleted).toEqual([waiting.connectionId]);
    expect(w.metaRevoked).toBe(0);
  });

  it("goes with its Nango connection, with the person removing bizinsights on Facebook, or asking for their data to be deleted", async () => {
    w.metaAccounts = [];
    const first = await connectThrough("meta");
    // Never swept as a connection nobody finished.
    await webhook({ type: "auth", operation: "creation", success: true, connectionId: first.connectionId, providerConfigKey: "bizinsights-meta-ads" });
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 25 * 60_000);
    expect(await sweepNangoOrphans(ctx.deps.coord, w.fetchImpl)).toBe(0);
    vi.restoreAllMocks();
    expect((await webhook({ from: "nango", type: "auth", operation: "deletion", success: true, connectionId: first.connectionId, providerConfigKey: "bizinsights-meta-ads", environment: "prod" })).statusCode).toBe(200);
    expect(await logins()).toEqual([]);

    await connectThrough("meta");
    expect(await metaDeauthorized("4242", ctx.deps.coord)).toBe(0);
    expect(await logins()).toEqual([]);
    await connectThrough("meta");
    await metaDataDeletion("4242", ctx.deps.coord);
    expect(await systemDb.adLogin.count()).toBe(0);
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
    // Another browser (a consent given on a page the session token was handed to): never reaches Nango.
    const elsewhere = await callback(CONSENT.adsense!);
    expect(elsewhere.statusCode).toBe(302);
    expect(elsewhere.headers.location).toContain("/settings/ads?error=state_mismatch");
    // The session cookie with nobody signed in (signed out since, or a browser it was copied to): refused.
    const signedOut = await callback(CONSENT.adsense!, cookiesFrom(started));
    expect(signedOut.statusCode).toBe(302);
    expect(signedOut.headers.location).toContain("/settings/ads?error=state_mismatch");
    // Someone else signed in, holding this browser's session cookie: refused too.
    const other = await signIn(ctx, "nango-other", "other@x.com");
    const mixed = await callback(CONSENT.adsense!, `${other.cookie}; ${cookiesFrom(started)}`);
    expect(mixed.statusCode).toBe(302);
    // Its own person, in its own browser: forwarded, with a receipt for this session.
    const res = await callback(CONSENT.adsense!, browser);
    expect(res.statusCode).toBe(308);
    expect(res.headers.location).toBe(`https://api.nango.dev/oauth/callback?${CONSENT.adsense}`);
    expect(cookiesFrom(res)).toBe(`ads_nango_consent=${started.json().nonce}`);
    ctx.setEnv({ NANGO_SECRET_KEY: "" });
    expect((await callback(CONSENT.adsense!, browser)).statusCode).toBe(404);
  });

  it("forwards one consent per session: a second one is refused", async () => {
    const { browser } = await start("adsense");
    expect((await callback(CONSENT.adsense!, browser)).statusCode).toBe(308);
    const again = await callback(CONSENT.adsense!, browser);
    expect(again.statusCode).toBe(302);
    expect(again.headers.location).toContain("/settings/ads?error=state_mismatch");
  });

  it("forwards a consent only for a platform the person has an open session for", async () => {
    // Only an AdSense session open: Meta's consent (no scope named) and a Google Ads one are refused.
    const { browser } = await start("adsense");
    for (const query of [CONSENT.meta!, CONSENT.google!, "code=4%2Fgoogle-code&state=nango-state&scope=openid"]) {
      const res = await callback(query, browser);
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toContain("/settings/ads?error=state_mismatch");
    }
    // Its own platform's still goes through: the refusals used nothing up.
    expect((await callback(CONSENT.adsense!, browser)).statusCode).toBe(308);
  });

  it("uses up the newest open session of the consent's platform, each once", async () => {
    const meta = await start("meta");
    const older = await start("adsense", { ...headers, cookie: meta.browser });
    const newer = await start("adsense", { ...headers, cookie: older.browser });
    // This browser holds all three, newest first: each AdSense consent uses up one AdSense session, the newest first.
    const r1 = await callback(CONSENT.adsense!, newer.browser);
    expect(cookiesFrom(r1)).toBe(`ads_nango_consent=${newer.nonce}`);
    const r2 = await callback(CONSENT.adsense!, jar(newer.browser, cookiesFrom(r1)));
    expect(cookiesFrom(r2)).toBe(`ads_nango_consent=${older.nonce}.${newer.nonce}`);
    expect((await callback(CONSENT.adsense!, newer.browser)).statusCode).toBe(302);
    // The Meta session is still there for Meta's consent.
    expect((await callback(CONSENT.meta!, newer.browser)).statusCode).toBe(308);
  });

  it("a declined consent (no code) goes on to Nango and uses nothing up", async () => {
    const { browser } = await start("meta");
    const declined = await callback("error=access_denied&error_reason=user_denied&state=nango-state", browser);
    expect(declined.statusCode).toBe(308);
    expect(cookiesFrom(declined)).toBe("");
    expect((await callback(CONSENT.meta!, browser)).statusCode).toBe(308);
  });

  it("the whole flow in one browser connects both platforms", async () => {
    for (const provider of ["meta", "adsense"]) {
      const { done } = await connectThrough(provider);
      expect(done.statusCode).toBe(200);
      expect(done.json()).toEqual({ connected: 1, provider });
    }
    expect(await systemDb.adConnection.count()).toBe(2);
  });
});

describe("a sign-in closed without a connection", () => {
  const CLOSED = "ads: sign-in closed without a connection";
  const close = (provider: string, payload: Record<string, unknown>, h = headers, w2 = ws, s = storeId) => ctx.app.inject({ method: "POST", url: `${adsUrl(w2, s)}/${provider}/nango/cancel`, headers: h, payload });

  /** The lines closed sign-ins leave in the log while `run` runs. */
  async function closedLines(run: () => Promise<void>) {
    const lines: unknown[] = [];
    vi.spyOn(logger, "info").mockImplementation((obj: unknown, msg?: string) => void (msg === CLOSED && lines.push(obj)));
    await run();
    return lines;
  }

  it("is logged with its platform, how long it was open and how the window ended: nothing came back when the platform never answered (Facebook's Feature Unavailable)", async () => {
    const lines = await closedLines(async () => {
      const { nonce } = await start("meta");
      expect((await close("meta", { nonce, ended: "closed" })).statusCode).toBe(200);
    });
    expect(lines).toEqual([{ provider: "meta", storeId, ended: "closed", openSeconds: expect.any(Number), answered: "none" }]);
  });

  it("names the platform's refusal (Cancel on its screen), and says when its consent came back before the window closed", async () => {
    const lines = await closedLines(async () => {
      const declined = await start("meta");
      expect((await callback("error=access_denied&error_reason=user_denied&error_description=Permissions+error&state=nango-state", declined.browser)).statusCode).toBe(308);
      await close("meta", { nonce: declined.nonce, ended: "window_closed" });
      const granted = await start("adsense");
      await consent("adsense", granted.browser);
      await close("adsense", { nonce: granted.nonce, ended: "closed" });
    });
    expect(lines).toEqual([
      { provider: "meta", storeId, ended: "window_closed", openSeconds: expect.any(Number), answered: "refused", platformError: "access_denied", platformReason: "user_denied" },
      { provider: "adsense", storeId, ended: "closed", openSeconds: expect.any(Number), answered: "consent" },
    ]);
    // Only the codes are kept, never the platform's own text.
    expect(JSON.stringify(lines)).not.toContain("Permissions");
  });

  it("an odd or missing 'ended' is logged as unknown; someone else's session is neither used up nor logged", async () => {
    const mine = await start("meta");
    const other = await signIn(ctx, "nango-closer", "closer@x.com");
    const otherWs = await createWorkspace(ctx, other.headers);
    const otherStore = (await createStore(otherWs, "closer-shop.myshopify.com", ["read_orders"], { currency: "USD" })).id;
    const lines = await closedLines(async () => {
      expect((await close("meta", { nonce: mine.nonce }, other.headers, otherWs, otherStore)).statusCode).toBe(200);
      await close("meta", { nonce: mine.nonce, ended: "<script>" });
    });
    expect(lines).toEqual([{ provider: "meta", storeId, ended: "unknown", openSeconds: expect.any(Number), answered: "none" }]);
  });
});

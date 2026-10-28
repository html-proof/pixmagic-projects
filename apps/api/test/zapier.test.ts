import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { raiseAlert } from "@app/core";
import { systemDb } from "@app/db";
import { sha256Hex } from "@app/shared";
import { clean, createStore, createWorkspace, ORIGIN, setup, signIn, teardown, type TestCtx } from "./helpers.js";

/**
 * Zapier (docs/zapier.md): bizinsights as the OAuth provider of its Zapier app, and Zapier's own API.
 * The consent page's calls as the member's session, the token endpoint as Zapier's server, and
 * /zapier/* with the bearer tokens it issues. Real Postgres; nothing leaves the process.
 */

let ctx: TestCtx;
const CLIENT_ID = "bizinsights-zapier-test";
const CLIENT_SECRET = randomBytes(32).toString("base64url");
const REDIRECT = "https://zapier.com/dashboard/auth/oauth/return/App4242CLIAPI/";
const ZAPIER_ENV = { ZAPIER_CLIENT_ID: CLIENT_ID, ZAPIER_CLIENT_SECRET: CLIENT_SECRET, ZAPIER_REDIRECT_URI: REDIRECT, ZAPIER_INVITE_URL: "https://zapier.com/developer/public-invite/1/abc/" };
const HOOK = "https://hooks.zapier.com/hooks/standard/123/abcdef/";

beforeAll(async () => {
  ctx = await setup();
  ctx.setEnv(ZAPIER_ENV);
});
beforeEach(async () => {
  await clean(ctx);
  ctx.setEnv(ZAPIER_ENV);
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => teardown(ctx));

const authorizeQuery = (o: Record<string, string> = {}) => new URLSearchParams({ client_id: CLIENT_ID, redirect_uri: REDIRECT, response_type: "code", state: "zapier-state-1", ...o }).toString();

async function business(uid: string, email: string, name: string, shop: string) {
  const owner = await signIn(ctx, uid, email);
  const ws = await createWorkspace(ctx, owner.headers, name);
  const store = await createStore(ws, shop, ["read_orders"], { name });
  return { owner, ws, store };
}

/** Allow on the consent page: the redirect back to Zapier, and its code. */
async function allow(headers: Record<string, string>, ws: string, storeId: string, o: Record<string, string> = {}) {
  const res = await ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/stores/${storeId}/zapier/authorize`, headers, payload: { client_id: CLIENT_ID, redirect_uri: REDIRECT, response_type: "code", state: "zapier-state-1", ...o } });
  return res;
}
async function codeFor(headers: Record<string, string>, ws: string, storeId: string) {
  const res = await allow(headers, ws, storeId);
  expect(res.statusCode, res.body).toBe(200);
  return new URL(res.json().redirect).searchParams.get("code")!;
}

/** Zapier's server at the token endpoint: form-encoded, the secret in the body unless `basic`. */
async function token(fields: Record<string, string>, opts: { basic?: boolean; secret?: string; clientId?: string } = {}) {
  const id = opts.clientId ?? CLIENT_ID;
  const secret = opts.secret ?? CLIENT_SECRET;
  const form = new URLSearchParams({ ...fields, ...(opts.basic ? {} : { client_id: id, client_secret: secret }) });
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (opts.basic) headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString("base64")}`;
  return ctx.app.inject({ method: "POST", url: "/oauth/token", headers, payload: form.toString() });
}

async function connect(headers: Record<string, string>, ws: string, storeId: string) {
  const code = await codeFor(headers, ws, storeId);
  const res = await token({ grant_type: "authorization_code", code, redirect_uri: REDIRECT });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { access_token: string; refresh_token: string; expires_in: number; token_type: string };
}

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const zget = (t: string, url: string) => ctx.app.inject({ method: "GET", url, headers: bearer(t) });
const zpost = (t: string, url: string, payload: unknown) => ctx.app.inject({ method: "POST", url, headers: bearer(t), payload });

describe("connecting Zapier (OAuth 2.0, authorization code)", () => {
  it("consent, code, tokens: the happy path, with the state passed back untouched and only hashes stored", async () => {
    const { owner, ws, store } = await business("owner-z", "owner@zap.test", "Zap Shop", "zap.myshopify.com");
    const page = await ctx.app.inject({ method: "GET", url: `/oauth/zapier/authorize?${authorizeQuery()}`, headers: owner.headers });
    expect(page.statusCode, page.body).toBe(200);
    expect(page.json().workspaces).toEqual([{ id: ws, name: "Zap Shop", allowed: true, stores: [{ id: store.id, name: "Zap Shop", shopDomain: "zap.myshopify.com" }] }]);
    expect(new URL(page.json().cancelUrl).searchParams.get("error")).toBe("access_denied");

    const allowed = await allow(owner.headers, ws, store.id, { state: "a b&c=d/é" });
    expect(allowed.statusCode, allowed.body).toBe(200);
    const back = new URL(allowed.json().redirect);
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
    expect(back.searchParams.get("state")).toBe("a b&c=d/é");
    const code = back.searchParams.get("code")!;
    expect(code).toMatch(/^zac_[A-Za-z0-9_-]{40,}$/);

    const res = await token({ grant_type: "authorization_code", code, redirect_uri: REDIRECT });
    expect(res.statusCode, res.body).toBe(200);
    const t = res.json();
    expect(t).toMatchObject({ token_type: "Bearer", expires_in: 3600 });
    expect(t.access_token).toMatch(/^zat_/);
    expect(t.refresh_token).toMatch(/^zrt_/);

    const me = await zget(t.access_token, "/zapier/me");
    expect(me.statusCode, me.body).toBe(200);
    expect(me.json()).toMatchObject({ store: { id: store.id, name: "Zap Shop", shop_domain: "zap.myshopify.com" }, workspace: { id: ws, name: "Zap Shop" }, connected_by: "owner@zap.test" });

    // Hashes only: neither token is anywhere in the database.
    const rows = await systemDb.zapierToken.findMany();
    expect(rows.map((r) => r.tokenHash).sort()).toEqual([sha256Hex(t.access_token), sha256Hex(t.refresh_token)].sort());
    expect(JSON.stringify(rows)).not.toContain(t.access_token.slice(4));
    expect(await systemDb.auditLog.count({ where: { workspaceId: ws, action: "zapier.connected" } })).toBe(1);
    // The tenant role can't read them at all (only the API's own connection checks tokens).
    const [grants] = await systemDb.$queryRaw<Array<{ tokens: boolean }>>`SELECT has_table_privilege('app_rls', 'public.zapier_tokens', 'SELECT') AS tokens`;
    expect(grants).toEqual({ tokens: false });
  });

  it("takes the client's secret in HTTP Basic too, and JSON bodies; refuses both ways at once", async () => {
    const { owner, ws, store } = await business("owner-b", "owner@basic.test", "Basic", "basic.myshopify.com");
    const res = await token({ grant_type: "authorization_code", code: await codeFor(owner.headers, ws, store.id), redirect_uri: REDIRECT }, { basic: true });
    expect(res.statusCode, res.body).toBe(200);
    const json = await ctx.app.inject({
      method: "POST",
      url: "/oauth/token",
      payload: { grant_type: "authorization_code", code: await codeFor(owner.headers, ws, store.id), redirect_uri: REDIRECT, client_id: CLIENT_ID, client_secret: CLIENT_SECRET },
    });
    expect(json.statusCode, json.body).toBe(200);
    const both = await ctx.app.inject({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}` },
      payload: new URLSearchParams({ grant_type: "authorization_code", code: await codeFor(owner.headers, ws, store.id), redirect_uri: REDIRECT, client_secret: CLIENT_SECRET }).toString(),
    });
    expect(both.statusCode).toBe(400);
    expect(both.json().error).toBe("invalid_request");
  });

  it("refuses a redirect_uri that isn't exactly Zapier's, on the page, on Allow and at the token endpoint", async () => {
    const { owner, ws, store } = await business("owner-r", "owner@redirect.test", "Redirect", "redirect.myshopify.com");
    for (const wrong of [`${REDIRECT}x`, REDIRECT.replace("https:", "http:"), "https://evil.example/cb", REDIRECT.slice(0, -1)]) {
      const page = await ctx.app.inject({ method: "GET", url: `/oauth/zapier/authorize?${authorizeQuery({ redirect_uri: wrong })}`, headers: owner.headers });
      expect(page.statusCode, wrong).toBe(400);
      expect(page.json().error).toBe("invalid_redirect_uri");
      // No redirect anywhere in the refusal.
      expect(page.body).not.toContain("cancelUrl");
      const post = await allow(owner.headers, ws, store.id, { redirect_uri: wrong });
      expect(post.statusCode, wrong).toBe(400);
    }
    expect((await ctx.app.inject({ method: "GET", url: `/oauth/zapier/authorize?${authorizeQuery({ client_id: "someone-else" })}`, headers: owner.headers })).json().error).toBe("invalid_client");
    expect((await ctx.app.inject({ method: "GET", url: `/oauth/zapier/authorize?${authorizeQuery({ response_type: "token" })}`, headers: owner.headers })).json().error).toBe("unsupported_response_type");
    const code = await codeFor(owner.headers, ws, store.id);
    const res = await token({ grant_type: "authorization_code", code, redirect_uri: "https://zapier.com/dashboard/auth/oauth/return/Other/" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_grant");
  });

  it("a code works once: a second use is refused and revokes what the first issued", async () => {
    const { owner, ws, store } = await business("owner-c", "owner@code.test", "Code", "code.myshopify.com");
    const code = await codeFor(owner.headers, ws, store.id);
    const first = await token({ grant_type: "authorization_code", code, redirect_uri: REDIRECT });
    expect(first.statusCode).toBe(200);
    const again = await token({ grant_type: "authorization_code", code, redirect_uri: REDIRECT });
    expect(again.statusCode).toBe(400);
    expect(again.json().error).toBe("invalid_grant");
    expect((await zget(first.json().access_token, "/zapier/me")).statusCode).toBe(401);
    expect((await systemDb.zapierGrant.findFirstOrThrow()).revokedReason).toBe("code_reused");
  });

  it("a code expires after five minutes", async () => {
    const { owner, ws, store } = await business("owner-e", "owner@expired.test", "Expired", "expired.myshopify.com");
    const code = await codeFor(owner.headers, ws, store.id);
    const later = Date.now() + 5 * 60_000 + 1_000;
    vi.spyOn(Date, "now").mockReturnValue(later);
    const res = await token({ grant_type: "authorization_code", code, redirect_uri: REDIRECT });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_grant");
    expect(await systemDb.zapierGrant.count()).toBe(0);
  });

  it("refresh tokens rotate; one reused after the grace period revokes the whole connection", async () => {
    const { owner, ws, store } = await business("owner-f", "owner@refresh.test", "Refresh", "refresh.myshopify.com");
    const t1 = await connect(owner.headers, ws, store.id);
    const r2 = await token({ grant_type: "refresh_token", refresh_token: t1.refresh_token });
    expect(r2.statusCode, r2.body).toBe(200);
    const t2 = r2.json();
    expect(t2.refresh_token).not.toBe(t1.refresh_token);
    expect((await zget(t2.access_token, "/zapier/me")).statusCode).toBe(200);
    // Within the grace (two of Zapier's tasks refreshing at once): answered too.
    const sibling = await token({ grant_type: "refresh_token", refresh_token: t1.refresh_token });
    expect(sibling.statusCode, sibling.body).toBe(200);
    const r3 = await token({ grant_type: "refresh_token", refresh_token: t2.refresh_token });
    expect(r3.statusCode).toBe(200);
    // A spent one, presented two minutes later: copied, so everything of the connection stops.
    await systemDb.zapierToken.updateMany({ where: { tokenHash: sha256Hex(t1.refresh_token) }, data: { usedAt: new Date(Date.now() - 120_000) } });
    const reuse = await token({ grant_type: "refresh_token", refresh_token: t1.refresh_token });
    expect(reuse.statusCode).toBe(400);
    expect(reuse.json().error).toBe("invalid_grant");
    expect((await zget(r3.json().access_token, "/zapier/me")).statusCode).toBe(401);
    expect((await token({ grant_type: "refresh_token", refresh_token: r3.json().refresh_token })).json().error).toBe("invalid_grant");
    expect((await systemDb.zapierGrant.findFirstOrThrow()).revokedReason).toBe("refresh_token_reused");
  });

  it("refuses a wrong client secret or client id (401 invalid_client), in the body or in Basic", async () => {
    const { owner, ws, store } = await business("owner-s", "owner@secret.test", "Secret", "secret.myshopify.com");
    const code = await codeFor(owner.headers, ws, store.id);
    for (const opts of [{ secret: "wrong-secret" }, { secret: `${CLIENT_SECRET}x` }, { clientId: "other-client" }, { basic: true, secret: "wrong" }]) {
      const res = await token({ grant_type: "authorization_code", code, redirect_uri: REDIRECT }, opts);
      expect(res.statusCode, JSON.stringify(opts)).toBe(401);
      expect(res.json().error).toBe("invalid_client");
    }
    // The code wasn't spent by the refusals.
    expect((await token({ grant_type: "authorization_code", code, redirect_uri: REDIRECT })).statusCode).toBe(200);
    expect((await token({ grant_type: "password", username: "x" })).json().error).toBe("unsupported_grant_type");
  });

  it("is off until the owner sets it up: not_configured, after asking who is calling", async () => {
    const { owner, ws, store } = await business("owner-n", "owner@off.test", "Off", "off.myshopify.com");
    const t = await connect(owner.headers, ws, store.id);
    ctx.setEnv({ ZAPIER_CLIENT_ID: "", ZAPIER_CLIENT_SECRET: "", ZAPIER_REDIRECT_URI: "" });
    expect((await token({ grant_type: "refresh_token", refresh_token: t.refresh_token })).statusCode).toBe(503);
    expect((await ctx.app.inject({ method: "GET", url: `/oauth/zapier/authorize?${authorizeQuery()}`, headers: owner.headers })).json().error).toBe("not_configured");
    expect((await ctx.app.inject({ method: "GET", url: `/oauth/zapier/authorize?${authorizeQuery()}`, headers: ORIGIN })).statusCode).toBe(401);
    const me = await zget(t.access_token, "/zapier/me");
    expect(me.statusCode).toBe(503);
    expect(me.json().error).toBe("not_configured");
    expect((await ctx.app.inject({ method: "GET", url: "/zapier/me" })).statusCode).toBe(401);
  });
});

describe("who Zapier's tokens act as", () => {
  it("a member who loses Manage integrations, or whose access is revoked: 401, and no refresh", async () => {
    const { owner, ws, store } = await business("owner-m", "owner@member.test", "Members", "members.myshopify.com");
    const manager = await signIn(ctx, "manager-m", "manager@member.test");
    const m = await systemDb.membership.create({ data: { workspaceId: ws, userId: manager.user.id, role: "manager", permissions: ["integrations.status", "integrations.manage", "marketing.ads"] } });
    const t = await connect(manager.headers, ws, store.id);
    expect((await zget(t.access_token, "/zapier/me")).statusCode).toBe(200);

    await systemDb.membership.update({ where: { id: m.id }, data: { permissions: ["integrations.status", "marketing.ads"] } });
    const me = await zget(t.access_token, "/zapier/me");
    expect(me.statusCode).toBe(401);
    expect(me.json().error).toBe("invalid_token");
    expect(me.headers["www-authenticate"]).toContain("invalid_token");
    expect((await token({ grant_type: "refresh_token", refresh_token: t.refresh_token })).json().error).toBe("invalid_grant");

    // Given back: it works again (nothing was revoked). Then the membership revoked: 401 again.
    await systemDb.membership.update({ where: { id: m.id }, data: { permissions: ["integrations.status", "integrations.manage", "marketing.ads"] } });
    expect((await zget(t.access_token, "/zapier/me")).statusCode).toBe(200);
    await systemDb.membership.update({ where: { id: m.id }, data: { revokedAt: new Date() } });
    expect((await zget(t.access_token, "/zapier/me")).statusCode).toBe(401);

    // A member without the permission can't allow Zapier at all.
    await systemDb.membership.update({ where: { id: m.id }, data: { revokedAt: null, permissions: ["integrations.status"] } });
    expect((await allow(manager.headers, ws, store.id)).statusCode).toBe(403);
    const page = await ctx.app.inject({ method: "GET", url: `/oauth/zapier/authorize?${authorizeQuery()}`, headers: manager.headers });
    expect(page.json().workspaces[0].allowed).toBe(false);
    expect(owner).toBeTruthy();
  });

  it("removing the member revokes their connections; so does deleting the store's data", async () => {
    const { owner, ws, store } = await business("owner-x", "owner@remove.test", "Remove", "remove.myshopify.com");
    const admin = await signIn(ctx, "admin-x", "admin@remove.test");
    const m = await systemDb.membership.create({ data: { workspaceId: ws, userId: admin.user.id, role: "admin" } });
    const t = await connect(admin.headers, ws, store.id);
    expect((await zpost(t.access_token, "/zapier/hooks", { event: "alert_raised", targetUrl: HOOK })).statusCode).toBe(201);
    const removed = await ctx.app.inject({ method: "DELETE", url: `/workspaces/${ws}/team/members/${m.id}`, headers: owner.headers });
    expect(removed.statusCode, removed.body).toBe(200);
    expect((await zget(t.access_token, "/zapier/me")).statusCode).toBe(401);
    expect(await systemDb.zapierHook.count()).toBe(0);
    expect((await systemDb.zapierGrant.findFirstOrThrow()).revokedReason).toBe("member_removed");

    const own = await connect(owner.headers, ws, store.id);
    const gone = await ctx.app.inject({ method: "DELETE", url: `/workspaces/${ws}/stores/${store.id}`, headers: owner.headers });
    expect(gone.statusCode, gone.body).toBe(200);
    expect((await zget(own.access_token, "/zapier/me")).statusCode).toBe(401);
    expect(await systemDb.zapierGrant.count({ where: { storeId: store.id } })).toBe(0);
  });

  it("session cookies, shared links and workspace API keys never reach /zapier, and zat_ tokens nothing else", async () => {
    const { owner, ws, store } = await business("owner-k", "owner@keys.test", "Keys", "keys.myshopify.com");
    const secret = `sk_${randomBytes(24).toString("hex")}`;
    await systemDb.apiKey.create({ data: { workspaceId: ws, name: "k", prefix: secret.slice(0, 8), keyHash: sha256Hex(secret), createdById: owner.user.id } });
    expect((await ctx.app.inject({ method: "GET", url: "/zapier/me", headers: owner.headers })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: "GET", url: "/zapier/me", headers: bearer(secret) })).statusCode).toBe(401);
    const t = await connect(owner.headers, ws, store.id);
    expect((await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores`, headers: bearer(t.access_token) })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: "GET", url: "/me", headers: bearer(t.access_token) })).statusCode).toBe(401);
    // A refresh token is no access token.
    expect((await zget(t.refresh_token, "/zapier/me")).statusCode).toBe(401);
  });

  it("an expired access token is a 401 however often Zapier sends one; only made-up tokens are rate-limited", async () => {
    const { owner, ws, store } = await business("owner-t", "owner@expiry.test", "Expiry", "expiry.myshopify.com");
    const t = await connect(owner.headers, ws, store.id);
    await systemDb.zapierToken.updateMany({ where: { tokenHash: sha256Hex(t.access_token) }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const statuses = new Set<number>();
    for (let i = 0; i < 130; i++) statuses.add((await zget(t.access_token, "/zapier/me")).statusCode);
    expect([...statuses]).toEqual([401]);
    const madeUp = new Set<number>();
    for (let i = 0; i < 130; i++) madeUp.add((await zget(`zat_${randomBytes(32).toString("base64url")}`, "/zapier/me")).statusCode);
    expect([...madeUp].sort()).toEqual([401, 429]);
    // The refresh still works for the expired one's connection.
    expect((await token({ grant_type: "refresh_token", refresh_token: t.refresh_token })).statusCode).toBe(200);
  });

  it("one business's connection never sees or changes another's (404)", async () => {
    const a = await business("owner-a", "owner@a.test", "Alpha", "alpha.myshopify.com");
    const b = await business("owner-bb", "owner@b.test", "Beta", "beta.myshopify.com");
    const ta = await connect(a.owner.headers, a.ws, a.store.id);
    const tb = await connect(b.owner.headers, b.ws, b.store.id);
    const hookB = (await zpost(tb.access_token, "/zapier/hooks", { event: "alert_raised", targetUrl: HOOK })).json().id;
    await raiseAlert({ workspaceId: b.ws, storeId: b.store.id, severity: "warning", code: "webhook_failed", message: "internal detail of beta" }, ctx.mailer, ctx.deps.fetchImpl);

    expect((await ctx.app.inject({ method: "DELETE", url: `/zapier/hooks/${hookB}`, headers: bearer(ta.access_token) })).statusCode).toBe(404);
    expect(await systemDb.zapierHook.count({ where: { id: hookB } })).toBe(1);
    const samples = await zget(ta.access_token, "/zapier/samples/alert_raised");
    expect(samples.statusCode).toBe(200);
    expect(samples.body).not.toContain(b.store.id);
    expect(samples.json()).toEqual([]);
    // A's owner, naming B's store in A's workspace, or B's workspace: never B's connections.
    expect((await ctx.app.inject({ method: "GET", url: `/workspaces/${a.ws}/stores/${b.store.id}/zapier`, headers: a.owner.headers })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: "GET", url: `/workspaces/${b.ws}/stores/${b.store.id}/zapier`, headers: a.owner.headers })).statusCode).toBe(404);
    const grantB = await systemDb.zapierGrant.findFirstOrThrow({ where: { workspaceId: b.ws } });
    expect((await ctx.app.inject({ method: "DELETE", url: `/workspaces/${a.ws}/stores/${a.store.id}/zapier/connections/${grantB.id}`, headers: a.owner.headers })).statusCode).toBe(404);
    expect((await zget(tb.access_token, "/zapier/me")).statusCode).toBe(200);
    // B's own samples: its alert, worded as the bell words it, never its internal message.
    const own = await zget(tb.access_token, "/zapier/samples/alert_raised");
    expect(own.json()).toHaveLength(1);
    expect(own.json()[0].data.title).toBe("An update from Shopify couldn't be processed");
    expect(own.body).not.toContain("internal detail");
  });
});

describe("Zapier's triggers (REST hooks)", () => {
  it("subscribes only to Zapier's own https hook addresses (SSRF)", async () => {
    const { owner, ws, store } = await business("owner-h", "owner@hooks.test", "Hooks", "hooks.myshopify.com");
    const t = await connect(owner.headers, ws, store.id);
    for (const targetUrl of [
      "http://hooks.zapier.com/hooks/standard/1/a/",
      "https://hooks.zapier.com.evil.example/hooks/standard/1/a/",
      "https://evil.example/hooks/standard/1/a/",
      "https://127.0.0.1/hooks/standard/1/a/",
      "https://169.254.169.254/latest/meta-data/",
      "https://hooks.zapier.com:8443/hooks/standard/1/a/",
      "https://user:pass@hooks.zapier.com/hooks/standard/1/a/",
      "https://hooks.zapier.com/other/path",
      "file:///etc/passwd",
    ]) {
      const res = await zpost(t.access_token, "/zapier/hooks", { event: "alert_raised", targetUrl });
      expect(res.statusCode, targetUrl).toBe(400);
      expect(res.json().error, targetUrl).toBe("invalid_target");
    }
    expect(await systemDb.zapierHook.count()).toBe(0);
    const ok = await zpost(t.access_token, "/zapier/hooks", { event: "ad_spend_threshold", targetUrl: HOOK, platform: "meta", period: "month", amount: "500" });
    expect(ok.statusCode, ok.body).toBe(201);
    expect((await systemDb.zapierHook.findFirstOrThrow()).inputs).toEqual({ platform: "meta", period: "month", amount: 500 });
    expect((await zpost(t.access_token, "/zapier/hooks", { event: "ad_spend_threshold", targetUrl: HOOK, period: "week", amount: 5 })).statusCode).toBe(400);
    const del = await ctx.app.inject({ method: "DELETE", url: `/zapier/hooks/${ok.json().id}`, headers: bearer(t.access_token) });
    expect(del.statusCode).toBe(200);
    expect(await systemDb.zapierHook.count()).toBe(0);
  });

  it("a trigger needs its data permission: advertising for ad triggers", async () => {
    const { ws, store } = await business("owner-p", "owner@perm.test", "Perm", "perm.myshopify.com");
    const manager = await signIn(ctx, "manager-p", "manager@perm.test");
    await systemDb.membership.create({ data: { workspaceId: ws, userId: manager.user.id, role: "manager", permissions: ["integrations.status", "integrations.manage"] } });
    const t = await connect(manager.headers, ws, store.id);
    const res = await zpost(t.access_token, "/zapier/hooks", { event: "ad_spend_threshold", targetUrl: HOOK, period: "day", amount: 10 });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("no_permission");
    expect((await zget(t.access_token, "/zapier/search/ad-performance")).statusCode).toBe(403);
    expect((await zpost(t.access_token, "/zapier/hooks", { event: "alert_raised", targetUrl: HOOK })).statusCode).toBe(201);
  });

  it("an alert raised for the store becomes one event, worded as the bell words it, queued for each trigger", async () => {
    const { owner, ws, store } = await business("owner-al", "owner@alert.test", "Alerts", "alerts.myshopify.com");
    const t = await connect(owner.headers, ws, store.id);
    await zpost(t.access_token, "/zapier/hooks", { event: "alert_raised", targetUrl: HOOK });
    await zpost(t.access_token, "/zapier/hooks", { event: "alert_raised", targetUrl: `${HOOK}2/` });
    ctx.deps.queues.clear();
    await raiseAlert({ workspaceId: ws, storeId: store.id, severity: "critical", code: "sync_orders_failed", message: "We couldn't sync orders: secret db detail" }, ctx.mailer, ctx.deps.fetchImpl, ctx.deps.queues);
    // Raised again while open: no second alert, no second event.
    await raiseAlert({ workspaceId: ws, storeId: store.id, severity: "critical", code: "sync_orders_failed", message: "again" }, ctx.mailer, ctx.deps.fetchImpl, ctx.deps.queues);
    const events = await systemDb.zapierEvent.findMany();
    expect(events).toHaveLength(1);
    const payload = events[0]!.payload as { event: string; store: { id: string }; data: Record<string, unknown> };
    expect(payload).toMatchObject({ event: "alert_raised", store: { id: store.id }, data: { severity: "critical", area: "shopify", title: "Couldn't sync your orders" } });
    expect(JSON.stringify(payload)).not.toContain("secret db detail");
    expect(await systemDb.zapierDelivery.count({ where: { status: "pending" } })).toBe(2);
    expect(ctx.deps.queues.sent.sync.filter((j) => (j as unknown as { kind: string }).kind === "zapier")).toHaveLength(2);
  });

  it("a store with no trigger writes nothing for its alerts", async () => {
    const { ws, store } = await business("owner-q", "owner@quiet.test", "Quiet", "quiet.myshopify.com");
    await raiseAlert({ workspaceId: ws, storeId: store.id, severity: "warning", code: "webhook_failed", message: "x" }, ctx.mailer, ctx.deps.fetchImpl, ctx.deps.queues);
    expect(await systemDb.zapierEvent.count()).toBe(0);
  });
});

describe("Zapier's searches", () => {
  async function adAccount(workspaceId: string, storeId: string, provider: string, accountId: string, currency: string) {
    return systemDb.adConnection.create({
      data: { workspaceId, storeId, provider, accountId, accountName: `Account ${accountId}`, currency, accessTokenEnc: "x", tokenKeyVersion: 1, lastSyncedAt: new Date(), syncedThrough: "2026-10-20" },
    });
  }
  async function day(c: { id: string; workspaceId: string; storeId: string; provider: string; accountId: string; currency: string | null }, d: string, spend: number, purchaseValue: number | null = null) {
    await systemDb.adCampaignDaily.create({
      data: { workspaceId: c.workspaceId, storeId: c.storeId, connectionId: c.id, provider: c.provider, accountId: c.accountId, campaignId: "c1", campaignName: "Camp", day: d, spend, impressions: 1000, clicks: 50, conversions: 3, purchaseValue, currency: c.currency },
    });
  }

  it("totals the stored figures for the dates, says how fresh they are, and never adds up two currencies", async () => {
    const { owner, ws, store } = await business("owner-sr", "owner@search.test", "Search", "search.myshopify.com");
    const t = await connect(owner.headers, ws, store.id);
    expect((await zget(t.access_token, "/zapier/search/ad-performance?since=2026-10-01&until=2026-10-20")).json()).toEqual([]);
    const meta = await adAccount(ws, store.id, "meta", "act_1", "AUD");
    await day(meta, "2026-10-10", 100.5, 400);
    await day(meta, "2026-10-11", 50.25, 100);
    const res = await zget(t.access_token, "/zapier/search/ad-performance?platform=meta&since=2026-10-01&until=2026-10-20");
    expect(res.statusCode, res.body).toBe(200);
    const [r] = res.json();
    expect(r).toMatchObject({ platform: "meta", spend: 150.75, currency: "AUD", mixed_currencies: null, impressions: 2000, clicks: 100, platform_attributed_purchase_value: 500, platform_attributed_roas: 3.32, data_through: "2026-10-20" });
    expect(r.freshness_note).toMatch(/last sync/);
    expect(r.attribution_note).toMatch(/not the store's revenue/);

    const google = await adAccount(ws, store.id, "google", "123", "USD");
    await day(google, "2026-10-10", 10);
    const mixed = (await zget(t.access_token, "/zapier/search/ad-performance?since=2026-10-01&until=2026-10-20")).json()[0];
    expect(mixed.spend).toBeNull();
    expect(mixed.mixed_currencies).toEqual(["AUD", "USD"]);
    expect(mixed.accounts).toHaveLength(2);
    expect((await zget(t.access_token, "/zapier/search/ad-performance?since=2026-10-20&until=2026-10-01")).statusCode).toBe(400);
    expect((await zget(t.access_token, "/zapier/search/adsense-earnings?since=2026-10-01&until=2026-10-20")).json()).toEqual([]);
  });
});

describe("Settings → Integrations' Zapier card", () => {
  it("lists who connected Zapier, its triggers and deliveries; the setup checklist only for owners and admins; Disconnect revokes", async () => {
    const { owner, ws, store } = await business("owner-ui", "owner@ui.test", "Card", "card.myshopify.com");
    const t = await connect(owner.headers, ws, store.id);
    await zpost(t.access_token, "/zapier/hooks", { event: "alert_raised", targetUrl: HOOK });
    await raiseAlert({ workspaceId: ws, storeId: store.id, severity: "warning", code: "webhook_failed", message: "x" }, ctx.mailer, ctx.deps.fetchImpl);
    const card = await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${store.id}/zapier`, headers: owner.headers });
    expect(card.statusCode, card.body).toBe(200);
    const body = card.json();
    expect(body.configured).toBe(true);
    expect(body.inviteUrl).toBe(ZAPIER_ENV.ZAPIER_INVITE_URL);
    expect(body.setup).toEqual({ ZAPIER_CLIENT_ID: true, ZAPIER_CLIENT_SECRET: true, ZAPIER_REDIRECT_URI: true, ZAPIER_INVITE_URL: true });
    expect(body.connections).toHaveLength(1);
    expect(body.connections[0].authorizedBy.email).toBe("owner@ui.test");
    expect(body.connections[0].triggers.map((h: { event: string }) => h.event)).toEqual(["alert_raised"]);
    expect(body.deliveries[0]).toMatchObject({ event: "alert_raised", status: "pending", label: "Sending" });
    expect(card.body).not.toContain(CLIENT_SECRET);

    const viewer = await signIn(ctx, "viewer-ui", "viewer@ui.test");
    await systemDb.membership.create({ data: { workspaceId: ws, userId: viewer.user.id, role: "viewer", permissions: ["integrations.status"] } });
    const seen = await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${store.id}/zapier`, headers: viewer.headers });
    expect(seen.json().setup).toBeNull();
    const grantId = body.connections[0].id;
    expect((await ctx.app.inject({ method: "DELETE", url: `/workspaces/${ws}/stores/${store.id}/zapier/connections/${grantId}`, headers: viewer.headers })).statusCode).toBe(403);

    const off = await ctx.app.inject({ method: "DELETE", url: `/workspaces/${ws}/stores/${store.id}/zapier/connections/${grantId}`, headers: owner.headers });
    expect(off.statusCode, off.body).toBe(200);
    expect((await zget(t.access_token, "/zapier/me")).statusCode).toBe(401);
    expect(await systemDb.zapierHook.count()).toBe(0);
    expect(await systemDb.zapierDelivery.count({ where: { status: "cancelled", errorCode: "grant_revoked" } })).toBe(1);
    expect(await systemDb.auditLog.count({ where: { workspaceId: ws, action: "zapier.disconnected" } })).toBe(1);
    expect((await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${store.id}/zapier`, headers: owner.headers })).json().connections).toEqual([]);
  });

  it("says plainly that Zapier isn't set up while the owner hasn't configured it", async () => {
    const { owner, ws, store } = await business("owner-ns", "owner@notset.test", "NotSet", "notset.myshopify.com");
    ctx.setEnv({ ZAPIER_CLIENT_ID: "", ZAPIER_CLIENT_SECRET: "", ZAPIER_REDIRECT_URI: "", ZAPIER_INVITE_URL: "" });
    const card = (await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/stores/${store.id}/zapier`, headers: owner.headers })).json();
    expect(card).toMatchObject({ configured: false, inviteUrl: null, setup: { ZAPIER_CLIENT_ID: false, ZAPIER_CLIENT_SECRET: false, ZAPIER_REDIRECT_URI: false, ZAPIER_INVITE_URL: false } });
  });
});

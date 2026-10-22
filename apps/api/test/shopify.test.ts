import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { systemDb } from "@app/db";
import { signShopifyQuery, signWebhookBody } from "@app/shared";
import { encryptTokenFields, getAccessToken, INLINE_PAYLOAD_LIMIT } from "@app/core";
import { clean, createStore, createWorkspace, setup, signIn, teardown, type TestCtx } from "./helpers.js";

let ctx: TestCtx;
beforeAll(async () => (ctx = await setup()));
afterAll(async () => teardown(ctx));
beforeEach(async () => clean(ctx));

const SECRET = "test_secret";

async function startInstall(verified = true) {
  const { headers, cookie } = await signIn(ctx, "owner", "owner@x.com", verified);
  const ws = await createWorkspace(ctx, headers);
  const res = await ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/shopify/install`, headers, payload: { shop: "Demo-Shop" } });
  return { res, ws, cookie, headers };
}

function callbackUrl(params: Record<string, string>) {
  const hmac = signShopifyQuery(params, SECRET);
  return `/shopify/callback?${new URLSearchParams({ ...params, hmac })}`;
}

describe("Shopify OAuth", () => {
  it("requires a verified email before connecting", async () => {
    const { res } = await startInstall(false);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("email_unverified");
  });

  it("rejects non-myshopify domains", async () => {
    const { headers } = await signIn(ctx, "o2", "o2@x.com");
    const ws = await createWorkspace(ctx, headers);
    const res = await ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/shopify/install`, headers, payload: { shop: "evil.com" } });
    expect(res.statusCode).toBe(400);
  });

  it("completes the authorization code grant and stores encrypted tokens + granted scopes", async () => {
    const { res, ws, cookie } = await startInstall();
    expect(res.statusCode).toBe(200);
    const url = new URL(res.json().url);
    expect(url.host).toBe("demo-shop.myshopify.com");
    const state = url.searchParams.get("state")!;
    const stateCookie = `shopify_oauth_state=${state}`;

    ctx.setFetch(async (input, init) => {
      expect(String(input)).toBe("https://demo-shop.myshopify.com/admin/oauth/access_token");
      const body = JSON.parse(String(init?.body));
      // An expiring offline token: Shopify flags a non-expiring one as deprecated.
      expect(body).toMatchObject({ code: "authcode", client_secret: SECRET, expiring: "1" });
      return new Response(
        JSON.stringify({ access_token: "shpat_PLAINTEXT", scope: "read_orders", expires_in: 3600, refresh_token: "shprt_PLAINTEXT", refresh_token_expires_in: 7_776_000 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const cb = await ctx.app.inject({
      method: "GET",
      url: callbackUrl({ code: "authcode", shop: "demo-shop.myshopify.com", state, timestamp: String(Math.floor(Date.now() / 1000)) }),
      headers: { cookie: `${cookie}; ${stateCookie}` },
    });
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toMatch(/\/onboarding\?step=sync&store=/);

    const store = await systemDb.store.findUniqueOrThrow({ where: { shopDomain: "demo-shop.myshopify.com" } });
    expect(store.workspaceId).toBe(ws);
    expect(store.grantedScopes).toEqual(["read_orders"]);
    expect(store.accessTokenEnc).toBeTruthy();
    expect(store.refreshTokenEnc).toBeTruthy();
    expect(store.accessTokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 59 * 60_000);
    expect(JSON.stringify(store)).not.toContain("PLAINTEXT");
    expect(await getAccessToken(store, ctx.deps.coord)).toBe("shpat_PLAINTEXT");

    // Initial sync seeded: shop + orders (no products since read_products wasn't granted).
    const jobs = await systemDb.syncJob.findMany({ where: { storeId: store.id } });
    expect(jobs.map((j) => j.kind).sort()).toEqual(["orders", "shop"]);
    expect(ctx.deps.queues.sent.sync).toHaveLength(1);
    expect(await systemDb.auditLog.count({ where: { action: "store.connected" } })).toBe(1);

    // State is single-use.
    const replay = await ctx.app.inject({
      method: "GET",
      url: callbackUrl({ code: "authcode", shop: "demo-shop.myshopify.com", state, timestamp: String(Math.floor(Date.now() / 1000)) }),
      headers: { cookie: `${cookie}; ${stateCookie}` },
    });
    expect(replay.headers.location).toContain("error=state_expired");
  });

  it("puts a re-authorization's token on the store even when the connect goes no further", async () => {
    const { res, ws, cookie } = await startInstall();
    const store = await createStore(ws, "demo-shop.myshopify.com", ["read_orders"], { shopifyAppKey: "default" });
    const hour = new Date(Date.now() + 3600_000);
    await systemDb.store.update({
      where: { id: store.id },
      data: encryptTokenFields(store.id, { accessToken: "shpat_OLD", refreshToken: "shprt_OLD", scopes: ["read_orders"], accessTokenExpiresAt: hour, refreshTokenExpiresAt: hour }),
    });
    const state = new URL(res.json().url).searchParams.get("state")!;
    // Shopify answers without read_orders, so this connect stops there. It has retired shprt_OLD all
    // the same, and a store left on it would lose its access within the hour.
    ctx.setFetch(async () =>
      new Response(JSON.stringify({ access_token: "shpat_NEW", scope: "read_products", expires_in: 3600, refresh_token: "shprt_NEW", refresh_token_expires_in: 7_776_000 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const cb = await ctx.app.inject({
      method: "GET",
      url: callbackUrl({ code: "authcode", shop: "demo-shop.myshopify.com", state, timestamp: String(Math.floor(Date.now() / 1000)) }),
      headers: { cookie: `${cookie}; shopify_oauth_state=${state}` },
    });
    expect(cb.headers.location).toContain("error=missing_required_scopes");
    expect(await getAccessToken(store, ctx.deps.coord)).toBe("shpat_NEW");
  });

  it.each([
    ["bad hmac", (p: Record<string, string>) => `/shopify/callback?${new URLSearchParams({ ...p, hmac: "deadbeef" })}`, "invalid_hmac"],
    ["shop mismatch", (p: Record<string, string>) => callbackUrl({ ...p, shop: "other.myshopify.com" }), "shop_mismatch"],
    ["stale timestamp", (p: Record<string, string>) => callbackUrl({ ...p, timestamp: "1000" }), "stale_request"],
  ])("rejects callback with %s", async (_n, build, err) => {
    const { res, cookie } = await startInstall();
    const state = new URL(res.json().url).searchParams.get("state")!;
    const p = { code: "c", shop: "demo-shop.myshopify.com", state, timestamp: String(Math.floor(Date.now() / 1000)) };
    const cb = await ctx.app.inject({ method: "GET", url: build(p), headers: { cookie: `${cookie}; shopify_oauth_state=${state}` } });
    expect(cb.headers.location).toContain(`error=${err}`);
    expect(await systemDb.store.count()).toBe(0);
  });

  describe("one-click connect (managed install)", () => {
    function launchUrl(shop = "demo-shop.myshopify.com") {
      const params = { shop, host: "aG9zdA", timestamp: String(Math.floor(Date.now() / 1000)) };
      return `/shopify/launch?${new URLSearchParams({ ...params, hmac: signShopifyQuery(params, SECRET) })}`;
    }
    // The inject helper joins multiple Set-Cookie headers with ", ".
    const cookieValue = (setCookie: string | undefined, name: string) => setCookie?.match(new RegExp(`(?:^|, )${name}=([^;]+)`))?.[1];

    async function start() {
      const { headers, cookie } = await signIn(ctx, "owner", "owner@x.com");
      const ws = await createWorkspace(ctx, headers);
      const res = await ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/shopify/start`, headers, payload: {} });
      return { res, ws, cookie, headers };
    }

    it("start returns Shopify's install link and remembers the workspace in this browser", async () => {
      const { res } = await start();
      expect(res.statusCode).toBe(200);
      expect(res.json().url).toMatch(/^https:\/\/admin\.shopify\.com\/oauth\/install\?client_id=/);
      expect(cookieValue(res.headers["set-cookie"], "shopify_pending")).toBeTruthy();
    });

    it("launch after install redirects to authorize, and the callback connects the store to that workspace", async () => {
      const { res, ws, cookie } = await start();
      const pending = cookieValue(res.headers["set-cookie"], "shopify_pending")!;

      const launch = await ctx.app.inject({ method: "GET", url: launchUrl(), headers: { cookie: `${cookie}; shopify_pending=${pending}` } });
      expect(launch.statusCode).toBe(302);
      const auth = new URL(String(launch.headers.location));
      expect(auth.host).toBe("demo-shop.myshopify.com");
      expect(auth.pathname).toBe("/admin/oauth/authorize");
      const state = auth.searchParams.get("state")!;
      expect(cookieValue(launch.headers["set-cookie"], "shopify_oauth_state")).toBe(state);

      ctx.setFetch(async () =>
        new Response(JSON.stringify({ access_token: "shpat_x", scope: "read_orders", expires_in: 3600, refresh_token: "shprt_x", refresh_token_expires_in: 7776000 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
      const cb = await ctx.app.inject({
        method: "GET",
        url: callbackUrl({ code: "authcode", shop: "demo-shop.myshopify.com", state, timestamp: String(Math.floor(Date.now() / 1000)) }),
        headers: { cookie: `${cookie}; shopify_oauth_state=${state}` },
      });
      expect(cb.headers.location).toMatch(/\/onboarding\?step=sync&store=/);
      expect((await systemDb.store.findUniqueOrThrow({ where: { shopDomain: "demo-shop.myshopify.com" } })).workspaceId).toBe(ws);
    });

    it("launch rejects a bad signature without connecting anything", async () => {
      const res = await ctx.app.inject({ method: "GET", url: "/shopify/launch?shop=demo-shop.myshopify.com&hmac=deadbeef" });
      // A browser entry point, so the merchant gets the connect page and an explanation rather
      // than raw JSON. The signature is still not accepted: no authorize redirect is issued.
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("http://localhost:3001/onboarding?error=launch_unverified");
      expect(await systemDb.store.findUnique({ where: { shopDomain: "demo-shop.myshopify.com" } })).toBeNull();
    });

    it("launch rejects a signed link whose shop is malformed", async () => {
      const res = await ctx.app.inject({ method: "GET", url: "/shopify/launch?shop=not-a-store&hmac=deadbeef" });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("http://localhost:3001/onboarding?error=launch_unverified");
    });

    it("launch without a session authorizes the store at once (App Store requirement 2.3.2)", async () => {
      // The rest of the install-from-Shopify flow is in shopifyInstall.test.ts.
      const res = await ctx.app.inject({ method: "GET", url: launchUrl() });
      expect(res.statusCode).toBe(302);
      expect(new URL(String(res.headers.location)).pathname).toBe("/admin/oauth/authorize");
    });

    it("a one-click connect started by someone else's session doesn't carry over to this one", async () => {
      const { res } = await start();
      const pending = cookieValue(res.headers["set-cookie"], "shopify_pending")!;
      const other = await signIn(ctx, "other", "other@x.com");
      await createWorkspace(ctx, other.headers, "One");
      await createWorkspace(ctx, other.headers, "Two");
      const launch = await ctx.app.inject({ method: "GET", url: launchUrl(), headers: { cookie: `${other.cookie}; shopify_pending=${pending}` } });
      const state = new URL(String(launch.headers.location)).searchParams.get("state")!;
      // Authorized as an install: where the store goes is decided by the callback, not the stray choice.
      expect(JSON.parse((await ctx.deps.coord.take(`oauth:state:${state}`))!)).toMatchObject({ mode: "install", shop: "demo-shop.myshopify.com" });
    });
  });

  const tokenFetch = () =>
    ctx.setFetch(async () =>
      new Response(JSON.stringify({ access_token: "shpat_x", scope: "read_orders", expires_in: 3600, refresh_token: "shprt_x", refresh_token_expires_in: 7776000 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

  it("callback leaves a store another account connected in the meantime, and opens the dashboard saying so", async () => {
    const { res, ws, cookie } = await startInstall();
    const state = new URL(res.json().url).searchParams.get("state")!;
    const rival = await signIn(ctx, "rival", "rival@x.com");
    const rivalWs = await createWorkspace(ctx, rival.headers, "Rival");
    await createStore(rivalWs, "demo-shop.myshopify.com", ["read_orders"]);
    tokenFetch();
    const cb = await ctx.app.inject({
      method: "GET",
      url: callbackUrl({ code: "c", shop: "demo-shop.myshopify.com", state, timestamp: String(Math.floor(Date.now() / 1000)) }),
      headers: { cookie: `${cookie}; shopify_oauth_state=${state}` },
    });
    expect(cb.headers.location).toBe(`http://localhost:3001/dashboard?ws=${ws}&taken=demo-shop.myshopify.com`);
    expect((await systemDb.store.findUniqueOrThrow({ where: { shopDomain: "demo-shop.myshopify.com" } })).workspaceId).toBe(rivalWs);
  });

  describe("a store already connected to another workspace", () => {
    const SHOP = "demo-shop.myshopify.com";
    const launchUrl = () => {
      const params = { shop: SHOP, host: "aG9zdA", timestamp: String(Math.floor(Date.now() / 1000)) };
      return `/shopify/launch?${new URLSearchParams({ ...params, hmac: signShopifyQuery(params, SECRET) })}`;
    };
    /** A one-click connect from `ws` that comes back from Shopify with SHOP: where the launch sends the browser. */
    async function oneClick(signedIn: { cookie: string; headers: Record<string, string> }, ws: string, from?: "settings") {
      const start = await ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/shopify/start`, headers: signedIn.headers, payload: from ? { from } : {} });
      const pending = String(start.headers["set-cookie"]).match(/shopify_pending=([^;]+)/)![1];
      const launch = await ctx.app.inject({ method: "GET", url: launchUrl(), headers: { cookie: `${signedIn.cookie}; shopify_pending=${pending}` } });
      expect(launch.statusCode).toBe(302);
      return String(launch.headers.location);
    }

    it("opens it for someone who is a member there, whichever way they connect", async () => {
      const me = await signIn(ctx, "owner", "owner@x.com");
      const home = await createWorkspace(ctx, me.headers, "Home");
      const store = await createStore(home, SHOP, ["read_orders"], { accessTokenEnc: "v1:x", shopifyAppKey: "default" });
      const second = await createWorkspace(ctx, me.headers, "Second");
      const dashboard = `http://localhost:3001/dashboard?ws=${home}&store=${store.id}`;

      expect(await oneClick(me, second)).toBe(dashboard);
      const typed = await ctx.app.inject({ method: "POST", url: `/workspaces/${second}/shopify/install`, headers: me.headers, payload: { shop: SHOP } });
      expect(typed.statusCode).toBe(200);
      expect(typed.json().url).toBe(dashboard);
      // Nothing moved or was authorized again.
      expect((await systemDb.store.findUniqueOrThrow({ where: { id: store.id } })).workspaceId).toBe(home);
      expect(await systemDb.auditLog.count({ where: { action: "store.connected" } })).toBe(0);
    });

    it("sends anyone else to their own dashboard, or back to Settings when they connected from there", async () => {
      const owner = await signIn(ctx, "owner", "owner@x.com");
      const theirs = await createWorkspace(ctx, owner.headers, "Theirs");
      await createStore(theirs, SHOP, ["read_orders"], { accessTokenEnc: "v1:x", shopifyAppKey: "default" });
      const other = await signIn(ctx, "other", "other@x.com");
      const mine = await createWorkspace(ctx, other.headers, "Mine");

      expect(await oneClick(other, mine)).toBe(`http://localhost:3001/dashboard?ws=${mine}&taken=${SHOP}`);
      expect(await oneClick(other, mine, "settings")).toBe("http://localhost:3001/settings/stores?error=store_taken");
      // A membership that was revoked opens nothing.
      await systemDb.membership.create({ data: { workspaceId: theirs, userId: other.user.id, role: "viewer", revokedAt: new Date() } });
      expect(await oneClick(other, mine)).toBe(`http://localhost:3001/dashboard?ws=${mine}&taken=${SHOP}`);
    });
  });

  it("revives a store uninstalled from another workspace, dropping its old data", async () => {
    const former = await signIn(ctx, "former", "former@x.com");
    const oldWs = await createWorkspace(ctx, former.headers, "Old");
    const old = await createStore(oldWs, "demo-shop.myshopify.com", [], { status: "uninstalled", uninstalledAt: new Date(), lastSyncedAt: new Date(), pixelInstalled: true });
    // Its old rows carry the old workspace_id, which RLS would hide from the new one.
    const base = { workspaceId: oldWs, storeId: old.id };
    await systemDb.product.create({ data: { ...base, shopifyId: "1", title: "Old tee", shopifyUpdatedAt: new Date() } });
    await systemDb.productVariant.create({ data: { ...base, productShopifyId: "1", shopifyId: "11", title: "M", price: 10, shopifyUpdatedAt: new Date() } });
    await systemDb.syncJob.create({ data: { ...base, kind: "orders", status: "succeeded" } });

    const { res, ws, cookie } = await startInstall();
    expect(res.statusCode).toBe(200);
    const state = new URL(res.json().url).searchParams.get("state")!;
    tokenFetch();
    const cb = await ctx.app.inject({
      method: "GET",
      url: callbackUrl({ code: "c", shop: "demo-shop.myshopify.com", state, timestamp: String(Math.floor(Date.now() / 1000)) }),
      headers: { cookie: `${cookie}; shopify_oauth_state=${state}` },
    });
    expect(cb.headers.location).toContain(`/onboarding?step=sync&store=${old.id}`);

    const store = await systemDb.store.findUniqueOrThrow({ where: { id: old.id } });
    expect(store).toMatchObject({ workspaceId: ws, status: "syncing", uninstalledAt: null, lastSyncedAt: null, pixelInstalled: false });
    expect(await systemDb.product.count({ where: { storeId: old.id } })).toBe(0);
    expect(await systemDb.productVariant.count({ where: { storeId: old.id } })).toBe(0);
    const jobs = await systemDb.syncJob.findMany({ where: { storeId: old.id } });
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs.every((j) => j.workspaceId === ws && j.status === "queued")).toBe(true);
  });

  it("callback still accepts connect state written without a mode", async () => {
    const { headers, cookie, user } = await signIn(ctx, "legacy", "legacy@x.com");
    const ws = await createWorkspace(ctx, headers);
    await ctx.deps.coord.put("oauth:state:legacystate", JSON.stringify({ userId: user.id, workspaceId: ws, shop: "demo-shop.myshopify.com" }), 600);
    tokenFetch();
    const cb = await ctx.app.inject({
      method: "GET",
      url: callbackUrl({ code: "c", shop: "demo-shop.myshopify.com", state: "legacystate", timestamp: String(Math.floor(Date.now() / 1000)) }),
      headers: { cookie: `${cookie}; shopify_oauth_state=legacystate` },
    });
    expect(cb.headers.location).toMatch(/\/onboarding\?step=sync&store=/);
    expect((await systemDb.store.findUniqueOrThrow({ where: { shopDomain: "demo-shop.myshopify.com" } })).workspaceId).toBe(ws);
  });

  it("the retired public sign-up endpoints are gone", async () => {
    for (const path of ["/auth/shopify/start", "/auth/shopify/finish", "/auth/shopify/claim", "/auth/shopify/cancel"]) {
      const res = await ctx.app.inject({ method: "POST", url: path, payload: {} });
      expect(res.statusCode, path).toBe(404);
    }
  });

  it("rejects callback when the browser state cookie is missing", async () => {
    const { res, cookie } = await startInstall();
    const state = new URL(res.json().url).searchParams.get("state")!;
    const cb = await ctx.app.inject({
      method: "GET",
      url: callbackUrl({ code: "c", shop: "demo-shop.myshopify.com", state, timestamp: String(Math.floor(Date.now() / 1000)) }),
      headers: { cookie },
    });
    expect(cb.headers.location).toContain("error=state_mismatch");
  });

  describe("refusals are logged", () => {
    /** Log lines written while `fn` runs, parsed. The suite runs with LOG_LEVEL=silent otherwise. */
    async function logsOf(fn: () => Promise<unknown>) {
      const prev = process.env.LOG_LEVEL;
      process.env.LOG_LEVEL = "info";
      const lines: Array<Record<string, unknown>> = [];
      const take = (s: unknown) => lines.push(JSON.parse(String(s)) as Record<string, unknown>);
      const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")].map((s) => s.mockImplementation(take));
      try {
        await fn();
      } finally {
        spies.forEach((s) => s.mockRestore());
        process.env.LOG_LEVEL = prev;
      }
      return lines;
    }
    const now = () => String(Math.floor(Date.now() / 1000));

    it("a callback with a bad signature: one line with the reason and the link's shape, no secrets", async () => {
      const q = new URLSearchParams({ code: "CODE_VALUE_42", shop: "demo-shop.myshopify.com", state: "st", timestamp: now(), hmac: "badc0ffee0ddf00d" });
      const lines = await logsOf(async () => {
        const cb = await ctx.app.inject({ method: "GET", url: `/shopify/callback?${q}`, headers: { "sec-fetch-dest": "document" } });
        expect(cb.headers.location).toContain("error=invalid_hmac");
      });
      const refused = lines.filter((l) => l.event === "shopify_callback_rejected");
      expect(refused).toHaveLength(1);
      expect(refused[0]).toMatchObject({
        level: "warn",
        reason: "invalid_hmac",
        params: ["code", "hmac", "shop", "state", "timestamp"],
        hmacPresent: true,
        shop: "demo-shop.myshopify.com",
        app: null,
        appsChecked: expect.any(Number),
        fetchDest: "document",
      });
      const all = JSON.stringify(lines);
      expect(all).not.toContain("badc0ffee0ddf00d");
      expect(all).not.toContain("CODE_VALUE_42");
      expect(all).not.toContain(SECRET);
    });

    it("a callback refused after its signature checked out names the app that signed it", async () => {
      const lines = await logsOf(async () => {
        const cb = await ctx.app.inject({ method: "GET", url: callbackUrl({ code: "CODE_VALUE_42", shop: "demo-shop.myshopify.com", state: "st", timestamp: now() }) });
        expect(cb.headers.location).toContain("error=state_mismatch");
      });
      const refused = lines.filter((l) => l.event === "shopify_callback_rejected");
      expect(refused).toHaveLength(1);
      expect(refused[0]).toMatchObject({ reason: "state_mismatch", app: "default", hmacPresent: true, fetchDest: null });
      expect(refused[0]).not.toHaveProperty("appsChecked");
      expect(JSON.stringify(lines)).not.toContain("CODE_VALUE_42");
    });

    it("a launch with a bad signature: one line with the reason and the link's shape, no secrets", async () => {
      const q = new URLSearchParams({ shop: "demo-shop.myshopify.com", host: "aG9zdA", timestamp: now(), id_token: "ID_TOKEN_VALUE", session: "SESSION_VALUE", hmac: "badc0ffee0ddf00d" });
      const lines = await logsOf(async () => {
        const res = await ctx.app.inject({ method: "GET", url: `/shopify/launch?${q}`, headers: { "sec-fetch-dest": "iframe" } });
        expect(res.headers.location).toBe("http://localhost:3001/onboarding?error=launch_unverified");
      });
      const refused = lines.filter((l) => l.event === "shopify_launch_rejected");
      expect(refused).toHaveLength(1);
      expect(refused[0]).toMatchObject({
        level: "warn",
        reason: "invalid_hmac",
        params: ["hmac", "host", "id_token", "session", "shop", "timestamp"],
        hmacPresent: true,
        shop: "demo-shop.myshopify.com",
        app: null,
        fetchDest: "iframe",
      });
      const all = JSON.stringify(lines);
      for (const secret of ["badc0ffee0ddf00d", "ID_TOKEN_VALUE", "SESSION_VALUE", SECRET]) expect(all).not.toContain(secret);
    });

    it("a launch with no signature at all says so", async () => {
      const lines = await logsOf(() => ctx.app.inject({ method: "GET", url: "/shopify/launch?shop=demo-shop.myshopify.com" }));
      const refused = lines.filter((l) => l.event === "shopify_launch_rejected");
      expect(refused).toHaveLength(1);
      expect(refused[0]).toMatchObject({ reason: "invalid_hmac", params: ["shop"], hmacPresent: false, app: null });
    });
  });
});

describe("webhook security & idempotency", () => {
  const body = JSON.stringify({ id: 1, name: "#1001" });
  const send = (headers: Record<string, string>, payload = body) =>
    ctx.app.inject({ method: "POST", url: "/webhooks/shopify", headers: { "content-type": "application/json", ...headers }, payload });
  const good = (id: string) => ({
    "x-shopify-hmac-sha256": signWebhookBody(body, SECRET),
    "x-shopify-topic": "orders/create",
    "x-shopify-shop-domain": "w.myshopify.com",
    "x-shopify-webhook-id": id,
  });

  it("rejects missing or forged signatures", async () => {
    expect((await send({ ...good("a"), "x-shopify-hmac-sha256": "" })).statusCode).toBe(401);
    expect((await send({ ...good("a"), "x-shopify-hmac-sha256": signWebhookBody(body, "wrong") })).statusCode).toBe(401);
    // Body tampered after signing
    expect((await send(good("a"), JSON.stringify({ id: 2 }))).statusCode).toBe(401);
    expect(await systemDb.webhookEvent.count()).toBe(0);
  });

  it("accepts valid webhooks once and acknowledges duplicates", async () => {
    const { headers } = await signIn(ctx, "o", "o@x.com");
    const ws = await createWorkspace(ctx, headers);
    await createStore(ws, "w.myshopify.com", ["read_orders"]);
    const r1 = await send(good("wh-1"));
    expect(r1.statusCode).toBe(200);
    // Until a consumer picks it up, the row alone can't prove the first attempt's message was
    // queued, so a redelivery right behind it is asked to come back rather than acknowledged.
    expect((await send(good("wh-1"))).statusCode).toBe(503);
    await systemDb.webhookEvent.update({ where: { webhookId: "wh-1" }, data: { status: "running", attempts: 1 } });
    const r2 = await send(good("wh-1"));
    expect(r2.statusCode).toBe(200);
    expect(r2.json().duplicate).toBe(true);
    expect(await systemDb.webhookEvent.count()).toBe(1);
    expect(ctx.deps.queues.sent.webhooks).toHaveLength(1);
  });

  // The row is committed before the queue send. A connection drop after the commit (500), or the
  // request being cut off before the send, leaves it queued and untouched with no message.
  const recorded = (id: string, extra: { status?: "queued" | "running" | "succeeded" | "failed"; attempts?: number; ageMs?: number } = {}) =>
    systemDb.webhookEvent.create({
      data: {
        webhookId: id,
        topic: "orders/create",
        shopDomain: "w.myshopify.com",
        status: extra.status,
        attempts: extra.attempts,
        receivedAt: new Date(Date.now() - (extra.ageMs ?? 60_000)),
      },
    });

  it("queues a retry of a delivery that was recorded but never reached the queue", async () => {
    const { headers } = await signIn(ctx, "o", "o@x.com");
    await createStore(await createWorkspace(ctx, headers), "w.myshopify.com", ["read_orders"]);
    const lost = await recorded("wh-lost");

    const r = await send(good("wh-lost"));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
    expect(ctx.deps.queues.sent.webhooks).toHaveLength(1);
    expect(ctx.deps.queues.sent.webhooks[0]).toMatchObject({ eventId: lost.id, topic: "orders/create", payload: JSON.parse(body) });
    expect(await systemDb.webhookEvent.count()).toBe(1);

    // The re-arm took a lease, so a retry right behind it queues no second copy. Nor is it
    // acknowledged: had the re-arming request been cut off before its send, that would lose it.
    expect((await send(good("wh-lost"))).statusCode).toBe(503);
    expect(ctx.deps.queues.sent.webhooks).toHaveLength(1);
  });

  it.each([
    ["succeeded", { status: "succeeded" as const, attempts: 1 }],
    ["failed", { status: "failed" as const, attempts: 6 }],
    ["running", { status: "running" as const, attempts: 1 }],
    ["waiting out a retry", { status: "queued" as const, attempts: 2 }],
  ])("acknowledges a retry of a delivery %s as a duplicate", async (_n, state) => {
    await recorded("wh-done", state);
    const r = await send(good("wh-done"));
    expect(r.statusCode).toBe(200);
    expect(r.json().duplicate).toBe(true);
    expect(ctx.deps.queues.sent.webhooks).toHaveLength(0);
  });

  // Shopify's first retry can come about a second after it gave up at 5s. The first attempt may
  // have died before its send, so a 200 now would end the retries with nothing queued.
  it.each([1_500, 5_000])("asks Shopify to retry a delivery recorded %ims ago that nothing has picked up", async (ageMs) => {
    const ev = await recorded("wh-young", { ageMs });
    const r = await send(good("wh-young"));
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ error: "in_progress" });
    expect(ctx.deps.queues.sent.webhooks).toHaveLength(0);
    // Left as it was, so a retry once the window has passed re-arms it.
    expect(await systemDb.webhookEvent.findUniqueOrThrow({ where: { id: ev.id } })).toMatchObject({ status: "queued", attempts: 0, receivedAt: ev.receivedAt });
  });

  it("asks Shopify to retry when the recorded row was forgotten under it", async () => {
    await recorded("wh-gone");
    // The INSERT that beat this one had its queue send fail and deleted its row again, between
    // this request's conflict and its read. Nothing is queued, so this must not be acknowledged.
    // A spy on a Prisma delegate can't be restored (that deletes the method from the delegate's
    // proxy) or reset (it never saw the original), so it is left passing through to the original.
    const findUnique = systemDb.webhookEvent.findUnique;
    const findSpy = vi.spyOn(systemDb.webhookEvent, "findUnique").mockImplementation(findUnique).mockResolvedValueOnce(null as never);
    const r = await send(good("wh-gone"));
    expect(r.statusCode).toBe(503);
    expect(findSpy).toHaveBeenCalledTimes(1);
    expect(ctx.deps.queues.sent.webhooks).toHaveLength(0);
  });

  it("keeps a re-armed row whose send fails, for the message that may still be behind it", async () => {
    expect((await send(good("wh-live"))).statusCode).toBe(200);
    const [original] = ctx.deps.queues.sent.webhooks;
    // The original message is waiting out a DB outage (its attempt never counted) when Shopify's
    // retry re-arms the row, and the queue send of the copy fails.
    const age = () => systemDb.webhookEvent.update({ where: { webhookId: "wh-live" }, data: { receivedAt: new Date(Date.now() - 60_000) } });
    await age();
    const sendSpy = vi.spyOn(ctx.deps.queues.webhooks, "send").mockRejectedValueOnce(new Error("queue unavailable"));
    try {
      expect((await send(good("wh-live"))).statusCode).toBe(500);
    } finally {
      sendSpy.mockRestore();
    }
    // Still there, or the original message would be skipped as unknown and the event lost.
    expect(await systemDb.webhookEvent.findUnique({ where: { id: original!.eventId } })).toMatchObject({ status: "queued", attempts: 0 });

    // The failed re-arm's lease holds off the next retry without acknowledging it (as it would
    // after a re-arm cut off before its send); once the lease lapses, a retry queues the delivery.
    expect((await send(good("wh-live"))).statusCode).toBe(503);
    await age();
    expect((await send(good("wh-live"))).json()).toEqual({ ok: true });
    expect(ctx.deps.queues.sent.webhooks.map((j) => j.eventId)).toEqual([original!.eventId, original!.eventId]);
  });

  it("gives a re-queued large payload its own blob, so neither copy deletes the other's", async () => {
    const big = JSON.stringify({ id: 1, name: "#1001", note: "x".repeat(INLINE_PAYLOAD_LIMIT) });
    const bigHeaders = { ...good("wh-big"), "x-shopify-hmac-sha256": signWebhookBody(big, SECRET) };
    expect((await send(bigHeaders, big)).statusCode).toBe(200);
    // The first message is still waiting out a backoff (the DB was down, so its attempt was never
    // counted) when Shopify's retry arrives: both copies end up in the queue.
    await systemDb.webhookEvent.update({ where: { webhookId: "wh-big" }, data: { receivedAt: new Date(Date.now() - 60_000) } });
    expect((await send(bigHeaders, big)).json()).toEqual({ ok: true });

    const [first, second] = ctx.deps.queues.sent.webhooks;
    expect(second!.eventId).toBe(first!.eventId);
    expect(first!.payloadKey).toBeTruthy();
    expect(second!.payloadKey).not.toBe(first!.payloadKey);
    expect(await ctx.deps.payloads.get(first!.payloadKey!)).toBe(big);
    expect(await ctx.deps.payloads.get(second!.payloadKey!)).toBe(big);
  });

  it("answers 500 when the queue send fails, and queues Shopify's retry", async () => {
    const sendSpy = vi.spyOn(ctx.deps.queues.webhooks, "send").mockRejectedValueOnce(new Error("queue unavailable"));
    try {
      expect((await send(good("wh-q"))).statusCode).toBe(500);
      const retry = await send(good("wh-q"));
      expect(retry.statusCode).toBe(200);
      expect(retry.json().duplicate).toBeUndefined();
      expect(ctx.deps.queues.sent.webhooks).toHaveLength(1);
      expect(await systemDb.webhookEvent.count()).toBe(1);
    } finally {
      sendSpy.mockRestore();
    }
  });
});

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { systemDb } from "@app/db";
import { encryptTokenFields, getAccessToken } from "@app/core";
import { signShopifyQuery, signWebhookBody } from "@app/shared";
import { clean, createStore, setup, signIn, teardown, testBrowser, type TestCtx } from "./helpers.js";

/**
 * Several Shopify apps: the default one (test_key / test_secret) and "client", a
 * custom-distribution app for client-shop.myshopify.com (client_key / client_secret,
 * configured in test-support/env.ts).
 */
let ctx: TestCtx;
beforeAll(async () => (ctx = await setup()));
afterAll(async () => teardown(ctx));
beforeEach(async () => clean(ctx));

const CLIENT_SHOP = "client-shop.myshopify.com";
const now = () => String(Math.floor(Date.now() / 1000));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const signedQuery = (params: Record<string, string>, secret: string) => new URLSearchParams({ ...params, hmac: signShopifyQuery(params, secret) });

/** Fake Shopify token endpoint that only accepts the given app's credentials. */
function fakeShopifyFor(clientId: string, secret: string) {
  ctx.setFetch(async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.client_id !== clientId || body.client_secret !== secret) return json({ error: "invalid_client" }, 401);
    if (body.grant_type === "refresh_token") {
      return json({ access_token: "shpat_REFRESHED", scope: "read_orders", expires_in: 3600, refresh_token: "shprt_NEXT", refresh_token_expires_in: 7776000 });
    }
    // The offline leg. Both exchanges send an identical body, so key on the code the test
    // supplies ("u" for the per-user leg, "o" for the offline one) as Shopify effectively does.
    if (body.code === "o") {
      return json({ access_token: "shpat_CLIENT", scope: "read_orders,read_products" });
    }
    return json({
      access_token: "shpua_x",
      scope: "read_orders,read_products",
      associated_user: { id: 1, email: "owner@client.com", email_verified: true, first_name: "Cleo", last_name: "Client", account_owner: true, collaborator: false },
    });
  });
}

function approve(b: ReturnType<typeof testBrowser>, authorizeUrl: string, code: string, secret: string) {
  const u = new URL(authorizeUrl);
  return b.get(`/shopify/callback?${signedQuery({ code, shop: u.host, state: u.searchParams.get("state")!, timestamp: now() }, secret)}`);
}

describe("several Shopify apps", () => {
  it("a client's store signs up and connects through its own app", async () => {
    fakeShopifyFor("client_key", "client_secret");
    const b = testBrowser(ctx);
    const start = await b.post("/auth/shopify/start", { email: "owner@client.com", shop: "client-shop" });
    const authorize = new URL(start.json().url);
    expect(authorize.host).toBe(CLIENT_SHOP);
    expect(authorize.searchParams.get("client_id")).toBe("client_key");

    const user = await approve(b, start.json().url, "u", "client_secret");
    const offline = await approve(b, user.headers.location!, "o", "client_secret");
    expect(offline.headers.location).toBe("http://localhost:3001/start?step=finish");
    expect((await b.post("/auth/shopify/finish", {})).json().status).toBe("signed_in");
    await b.signIn("otp-owner@client.com", "owner@client.com");
    const claim = await b.post("/auth/shopify/claim");
    expect(claim.statusCode).toBe(200);

    const store = await systemDb.store.findUniqueOrThrow({ where: { shopDomain: CLIENT_SHOP } });
    expect(store.shopifyAppKey).toBe("client");
    expect(await getAccessToken(store, ctx.deps.coord)).toBe("shpat_CLIENT");
  });

  it("other stores keep using the default app", async () => {
    const b = testBrowser(ctx);
    const start = await b.post("/auth/shopify/start", { email: "x@y.com", shop: "someone-else" });
    expect(new URL(start.json().url).searchParams.get("client_id")).toBe("test_key");
    const managed = await b.post("/auth/shopify/start", { email: "x@y.com" });
    expect(managed.json().url).toContain("client_id=test_key");
  });

  /**
   * Until the main app passes Shopify's review it may only be installed on stores in our own
   * developer organization (SHOPIFY_DEFAULT_APP_SHOPS). Sending anyone else to it ends on
   * Shopify's "This installation link can't be used" page, so those merchants must be routed
   * to the app distributed to their store, or told plainly that there isn't one yet.
   */
  describe("while the main app is limited to named stores", () => {
    const DEV_SHOP = "dev-store.myshopify.com";
    beforeEach(() => ctx.setEnv({ SHOPIFY_DEFAULT_APP_SHOPS: DEV_SHOP }));
    afterEach(() => ctx.setEnv({ SHOPIFY_DEFAULT_APP_SHOPS: "" }));

    it("still sends the client's store to its own app", async () => {
      const b = testBrowser(ctx);
      const start = await b.post("/auth/shopify/start", { email: "owner@client.com", shop: "client-shop" });
      expect(new URL(start.json().url).searchParams.get("client_id")).toBe("client_key");
    });

    it("still installs on a store the main app is distributed to", async () => {
      const b = testBrowser(ctx);
      const start = await b.post("/auth/shopify/start", { email: "x@y.com", shop: "dev-store" });
      expect(new URL(start.json().url).searchParams.get("client_id")).toBe("test_key");
    });

    it("refuses a store no app of ours can be installed on", async () => {
      const b = testBrowser(ctx);
      const res = await b.post("/auth/shopify/start", { email: "x@y.com", shop: "someone-else" });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("app_unavailable");
    });

    it("asks for the store address instead of Shopify's store picker", async () => {
      const b = testBrowser(ctx);
      const res = await b.post("/auth/shopify/start", { email: "x@y.com" });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("shop_required");
      // The same applies to one-click connect for a signed-in user.
      const { headers } = await signIn(ctx, "o", "o@x.com");
      const ws = (await ctx.app.inject({ method: "POST", url: "/workspaces", headers, payload: { name: "W" } })).json().workspace.id;
      const oneClick = await ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/shopify/start`, headers, payload: {} });
      expect(oneClick.statusCode).toBe(400);
      expect(oneClick.json().error).toBe("shop_required");
      // Naming the store still works: it goes to the app distributed to it.
      const named = await ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/shopify/install`, headers, payload: { shop: "client-shop" } });
      expect(new URL(named.json().url).searchParams.get("client_id")).toBe("client_key");
    });

    it("refuses a rejected store without disturbing the signup already in the browser", async () => {
      const b = testBrowser(ctx);
      await b.post("/auth/shopify/start", { email: "x@y.com", shop: "client-shop" });
      expect((await b.post("/auth/shopify/start", { email: "x@y.com", shop: "someone-else" })).statusCode).toBe(400);
      // The first signup is still the one this browser holds.
      fakeShopifyFor("client_key", "client_secret");
      const start = await b.post("/auth/shopify/start", { email: "x@y.com", shop: "client-shop" });
      expect(new URL(start.json().url).host).toBe(CLIENT_SHOP);
    });
  });

  it("refuses a callback signed by a different app than the one the flow started with", async () => {
    fakeShopifyFor("client_key", "client_secret");
    const b = testBrowser(ctx);
    const start = await b.post("/auth/shopify/start", { email: "owner@client.com", shop: "client-shop" });
    const res = await approve(b, start.json().url, "u", "test_secret"); // default app's signature
    expect(res.headers.location).toContain("error=app_mismatch");
    // And a signature from no app at all is simply invalid.
    const start2 = await b.post("/auth/shopify/start", { email: "owner@client.com", shop: "client-shop" });
    expect((await approve(b, start2.json().url, "u", "not-our-secret")).headers.location).toContain("error=invalid_hmac");
  });

  it("the app launched from Shopify decides which app the signup continues with", async () => {
    const b = testBrowser(ctx);
    await b.post("/auth/shopify/start", { email: "owner@client.com" });
    const launch = await b.get(`/shopify/launch?${signedQuery({ shop: CLIENT_SHOP, host: "aG9zdA", timestamp: now() }, "client_secret")}`);
    expect(launch.statusCode).toBe(302);
    expect(new URL(launch.headers.location!).searchParams.get("client_id")).toBe("client_key");
    // A launch signed by no app of ours is rejected: the merchant is sent to /start with an
    // explanation, never to an authorize URL.
    const forged = await b.get(`/shopify/launch?${signedQuery({ shop: CLIENT_SHOP, timestamp: now() }, "nope")}`);
    expect(forged.statusCode).toBe(302);
    expect(forged.headers.location).toBe("http://localhost:3001/start?error=launch_unverified");
  });

  it("signed-in users connecting the client's store from the app also use its app", async () => {
    const { headers } = await signIn(ctx, "o", "o@x.com");
    const ws = (await ctx.app.inject({ method: "POST", url: "/workspaces", headers, payload: { name: "W" } })).json().workspace.id;
    const res = await ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/shopify/install`, headers, payload: { shop: "client-shop" } });
    expect(new URL(res.json().url).searchParams.get("client_id")).toBe("client_key");
  });

  it("accepts webhooks signed by any of our apps and says which one", async () => {
    const body = JSON.stringify({ id: 1 });
    const send = (secret: string, id: string) =>
      ctx.app.inject({
        method: "POST",
        url: "/webhooks/shopify",
        headers: {
          "content-type": "application/json",
          "x-shopify-hmac-sha256": signWebhookBody(body, secret),
          "x-shopify-topic": "app/uninstalled",
          "x-shopify-shop-domain": CLIENT_SHOP,
          "x-shopify-webhook-id": id,
        },
        payload: body,
      });
    expect((await send("client_secret", "w1")).statusCode).toBe(200);
    expect((await send("test_secret", "w2")).statusCode).toBe(200);
    expect((await send("forged", "w3")).statusCode).toBe(401);
    expect(ctx.deps.queues.sent.webhooks.map((j) => j.app)).toEqual(["client", "default"]);
  });

  it("refreshes a store's token with the app it connected through", async () => {
    const { headers } = await signIn(ctx, "o", "o@x.com");
    const ws = (await ctx.app.inject({ method: "POST", url: "/workspaces", headers, payload: { name: "W" } })).json().workspace.id;
    const store = await createStore(ws, CLIENT_SHOP, ["read_orders"], { shopifyAppKey: "client" });
    await systemDb.store.update({
      where: { id: store.id },
      data: encryptTokenFields(store.id, {
        accessToken: "shpat_OLD",
        refreshToken: "shprt_OLD",
        scopes: ["read_orders"],
        accessTokenExpiresAt: new Date(Date.now() - 1000),
        refreshTokenExpiresAt: new Date(Date.now() + 86_400_000),
      }),
    });
    fakeShopifyFor("client_key", "client_secret");
    const fresh = await systemDb.store.findUniqueOrThrow({ where: { id: store.id } });
    expect(await getAccessToken(fresh, ctx.deps.coord, ctx.deps.fetchImpl)).toBe("shpat_REFRESHED");
  });
});

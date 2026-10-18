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
    return json({ access_token: "shpat_CLIENT", scope: "read_orders,read_products" });
  });
}

/** A signed-in, verified owner in a browser (cookies kept), with a workspace of their own. */
async function owner() {
  const b = testBrowser(ctx);
  await b.signIn("o", "o@x.com");
  const ws = (await b.post("/workspaces", { name: "W" })).json().workspace.id as string;
  return { b, ws, install: (shop: string) => b.post(`/workspaces/${ws}/shopify/install`, { shop }) };
}

function approve(b: ReturnType<typeof testBrowser>, authorizeUrl: string, secret: string) {
  const u = new URL(authorizeUrl);
  return b.get(`/shopify/callback?${signedQuery({ code: "c", shop: u.host, state: u.searchParams.get("state")!, timestamp: now() }, secret)}`);
}

describe("several Shopify apps", () => {
  it("a client's store connects through its own app", async () => {
    fakeShopifyFor("client_key", "client_secret");
    const { b, ws, install } = await owner();
    const start = await install("client-shop");
    const authorize = new URL(start.json().url);
    expect(authorize.host).toBe(CLIENT_SHOP);
    expect(authorize.searchParams.get("client_id")).toBe("client_key");

    const cb = await approve(b, start.json().url, "client_secret");
    expect(cb.headers.location).toMatch(/\/onboarding\?step=sync&store=/);
    const store = await systemDb.store.findUniqueOrThrow({ where: { shopDomain: CLIENT_SHOP } });
    expect(store.workspaceId).toBe(ws);
    expect(store.shopifyAppKey).toBe("client");
    expect(await getAccessToken(store, ctx.deps.coord)).toBe("shpat_CLIENT");
  });

  it("a store installed from the App Store app's listing is authorized and kept on that app", async () => {
    fakeShopifyFor("public_key", "public_secret");
    const b = testBrowser(ctx);
    const shop = "listing-shop.myshopify.com";
    const launch = await b.get(`/shopify/launch?${signedQuery({ shop, host: "aG9zdA", timestamp: now() }, "public_secret")}`);
    expect(launch.statusCode).toBe(302);
    const authorize = new URL(String(launch.headers.location));
    expect(`${authorize.origin}${authorize.pathname}`).toBe(`https://${shop}/admin/oauth/authorize`);
    expect(authorize.searchParams.get("client_id")).toBe("public_key");

    const cb = await approve(b, authorize.toString(), "public_secret");
    expect(cb.statusCode).toBe(302);
    const store = await systemDb.store.findUniqueOrThrow({ where: { shopDomain: shop } });
    expect(store.shopifyAppKey).toBe("public");
    expect(await getAccessToken(store, ctx.deps.coord)).toBe("shpat_CLIENT");

    // Its webhooks are signed with that app's secret, for whichever store installed it.
    const payload = JSON.stringify({ id: 1 });
    const hook = await ctx.app.inject({
      method: "POST",
      url: "/webhooks/shopify",
      headers: {
        "content-type": "application/json",
        "x-shopify-topic": "products/update",
        "x-shopify-shop-domain": shop,
        "x-shopify-webhook-id": "wh-public-1",
        "x-shopify-hmac-sha256": signWebhookBody(payload, "public_secret"),
      },
      payload,
    });
    expect(hook.statusCode).toBe(200);
  });

  describe("a shop with two of our apps installed", () => {
    const shop = "two-apps.myshopify.com";
    const launch = (secret: string) => testBrowser(ctx).get(`/shopify/launch?${signedQuery({ shop, host: "aG9zdA", timestamp: now() }, secret)}`);
    /** A store connected through `app`, in an account (a workspace that isn't waiting for a claim). */
    async function connected(app: string, extra: Record<string, unknown> = {}, awaitingClaim = false) {
      const ws = await systemDb.workspace.create({ data: { name: "Acct", awaitingClaim } });
      return createStore(ws.id, shop, ["read_orders"], { accessTokenEnc: "v1:x", shopifyAppKey: app, ...extra });
    }

    it("opening the other app doesn't move a store that works through its own", async () => {
      const store = await connected("default");
      const res = await launch("public_secret");
      expect(res.headers.location).toMatch(/\/onboarding\?step=sync&store=/);
      expect((await systemDb.store.findUniqueOrThrow({ where: { id: store.id } })).shopifyAppKey).toBe("default");
    });

    it("an unclaimed store is authorized again through the app it works with, not the one opened", async () => {
      await connected("default", {}, true);
      const authorize = new URL(String((await launch("public_secret")).headers.location));
      expect(authorize.pathname).toBe("/admin/oauth/authorize");
      expect(authorize.searchParams.get("client_id")).toBe("test_key");
    });

    it("a store whose own app Shopify refuses is authorized through the app opened", async () => {
      const store = await connected("public", { status: "error" });
      await systemDb.syncJob.create({
        data: { workspaceId: store.workspaceId, storeId: store.id, kind: "shop", status: "failed", error: "Shopify rejected our access (403); merchant must reconnect" },
      });
      const authorize = new URL(String((await launch("test_secret")).headers.location));
      expect(authorize.pathname).toBe("/admin/oauth/authorize");
      expect(authorize.searchParams.get("client_id")).toBe("test_key");
    });
  });

  it("other stores keep using the default app", async () => {
    const { b, ws, install } = await owner();
    expect(new URL((await install("someone-else")).json().url).searchParams.get("client_id")).toBe("test_key");
    const oneClick = await b.post(`/workspaces/${ws}/shopify/start`);
    expect(oneClick.json().url).toContain("client_id=test_key");
  });

  /**
   * A merchant who installed from the App Store listing must never be sent to the main app, which
   * Shopify hasn't approved for their store; everyone else carries on as before.
   */
  describe("a workspace whose stores came through the App Store app", () => {
    const LISTED = "listed-shop.myshopify.com";
    const DIRECT = "direct-shop.myshopify.com";
    const clientId = (url: string) => new URL(url).searchParams.get("client_id");
    afterEach(() => ctx.setEnv({ SHOPIFY_APP_STORE_PREVIEW_SHOPS: "" }));

    it("is marked as such on /me, and only that one", async () => {
      const { b, ws } = await owner();
      const other = (await b.post("/workspaces", { name: "Other" })).json().workspace.id as string;
      await createStore(ws, LISTED, ["read_orders"], { shopifyAppKey: "public" });
      await createStore(other, DIRECT, ["read_orders"], { shopifyAppKey: "default" });
      const flags = Object.fromEntries((await b.get("/me")).json().workspaces.map((w: { id: string; appStore: boolean }) => [w.id, w.appStore]));
      expect(flags).toEqual({ [ws]: true, [other]: false });
    });

    it("adds stores through the App Store app, by Shopify's picker or by name", async () => {
      const { b, ws, install } = await owner();
      await createStore(ws, LISTED, ["read_orders"], { shopifyAppKey: "public", status: "uninstalled" });
      expect((await b.post(`/workspaces/${ws}/shopify/start`)).json().url).toBe("https://admin.shopify.com/oauth/install?client_id=public_key");
      expect(clientId((await install("another-shop")).json().url)).toBe("public_key");
      // A client's store still goes to its own app.
      expect(clientId((await install("client-shop")).json().url)).toBe("client_key");
    });

    it("reconnects a store through the app it came through", async () => {
      const { ws, install } = await owner();
      // The App Store reviewer's test store: on the main app, shown as an App Store install.
      ctx.setEnv({ SHOPIFY_APP_STORE_PREVIEW_SHOPS: DIRECT });
      await createStore(ws, DIRECT, ["read_orders"], { shopifyAppKey: "default", status: "error" });
      expect(clientId((await install("direct-shop")).json().url)).toBe("test_key");
      expect(clientId((await install("new-shop")).json().url)).toBe("public_key");
    });

    it("leaves a workspace with a main-app store on the main app", async () => {
      const { b, ws, install } = await owner();
      await createStore(ws, DIRECT, ["read_orders"], { shopifyAppKey: "default" });
      await createStore(ws, LISTED, ["read_orders"], { shopifyAppKey: "public" });
      expect((await b.post(`/workspaces/${ws}/shopify/start`)).json().url).toContain("client_id=test_key");
      expect(clientId((await install("new-shop")).json().url)).toBe("test_key");
      // Its App Store store reconnects through the App Store app all the same.
      expect(clientId((await install("listed-shop")).json().url)).toBe("public_key");
    });
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
      const { install } = await owner();
      expect(new URL((await install("client-shop")).json().url).searchParams.get("client_id")).toBe("client_key");
    });

    it("still installs on a store the main app is distributed to", async () => {
      const { install } = await owner();
      expect(new URL((await install("dev-store")).json().url).searchParams.get("client_id")).toBe("test_key");
    });

    it("refuses a store no app of ours can be installed on", async () => {
      const { install } = await owner();
      const res = await install("someone-else");
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("app_unavailable");
    });

    it("asks for the store address instead of Shopify's store picker", async () => {
      const { b, ws, install } = await owner();
      const oneClick = await b.post(`/workspaces/${ws}/shopify/start`);
      expect(oneClick.statusCode).toBe(400);
      expect(oneClick.json().error).toBe("shop_required");
      // Naming the store still works: it goes to the app distributed to it.
      expect(new URL((await install("client-shop")).json().url).searchParams.get("client_id")).toBe("client_key");
    });
  });

  it("refuses a callback signed by a different app than the one the flow started with", async () => {
    fakeShopifyFor("client_key", "client_secret");
    const { b, install } = await owner();
    const start = await install("client-shop");
    const res = await approve(b, start.json().url, "test_secret"); // default app's signature
    expect(res.headers.location).toContain("error=app_mismatch");
    // And a signature from no app at all is simply invalid.
    const start2 = await install("client-shop");
    expect((await approve(b, start2.json().url, "not-our-secret")).headers.location).toContain("error=invalid_hmac");
    expect(await systemDb.store.count()).toBe(0);
  });

  it("the app launched from Shopify decides which app a one-click connect continues with", async () => {
    const { b, ws } = await owner();
    await b.post(`/workspaces/${ws}/shopify/start`);
    const launch = await b.get(`/shopify/launch?${signedQuery({ shop: CLIENT_SHOP, host: "aG9zdA", timestamp: now() }, "client_secret")}`);
    expect(launch.statusCode).toBe(302);
    expect(new URL(launch.headers.location!).searchParams.get("client_id")).toBe("client_key");
    // A launch signed by no app of ours is rejected with an explanation, never an authorize URL.
    const forged = await b.get(`/shopify/launch?${signedQuery({ shop: CLIENT_SHOP, timestamp: now() }, "nope")}`);
    expect(forged.statusCode).toBe(302);
    expect(forged.headers.location).toBe("http://localhost:3001/onboarding?error=launch_unverified");
  });

  it("accepts webhooks signed by any of our apps and says which one", async () => {
    const body = JSON.stringify({ id: 1, myshopify_domain: CLIENT_SHOP });
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

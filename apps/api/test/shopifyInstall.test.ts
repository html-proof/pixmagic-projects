import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { systemDb } from "@app/db";
import { signShopifyQuery } from "@app/shared";
import { getAccessToken } from "@app/core";
import { clean, createStore, createWorkspace, setup, signIn, teardown, testBrowser, type TestCtx } from "./helpers.js";

/**
 * Installing from Shopify (the App Store listing, or a reinstall from the admin): App Store
 * requirements 2.3.2-2.3.4 say the app authorizes with OAuth at once, before any other step, and
 * then shows its UI. No bizinsights login exists at that point, so the store lands in a workspace
 * of its own that the merchant adds to their account afterwards (the claim).
 */

let ctx: TestCtx;
beforeAll(async () => (ctx = await setup()));
afterAll(async () => teardown(ctx));
beforeEach(async () => clean(ctx));

const SECRET = "test_secret";
const SHOP = "demo-shop.myshopify.com";
const now = () => String(Math.floor(Date.now() / 1000));

function launchUrl(shop = SHOP) {
  const params = { shop, host: "aG9zdA", timestamp: now() };
  return `/shopify/launch?${new URLSearchParams({ ...params, hmac: signShopifyQuery(params, SECRET) })}`;
}
function callbackUrl(state: string, shop = SHOP, code = "authcode") {
  const params = { code, shop, state, timestamp: now() };
  return `/shopify/callback?${new URLSearchParams({ ...params, hmac: signShopifyQuery(params, SECRET) })}`;
}
const tokenFetch = (token = "shpat_installed", scope = "read_orders,read_products") =>
  ctx.setFetch(async () => new Response(JSON.stringify({ access_token: token, scope }), { status: 200, headers: { "content-type": "application/json" } }));

/** Launch from Shopify, follow the authorize redirect back to the callback; returns the browser and the final response. */
async function install(browser = testBrowser(ctx), shop = SHOP) {
  const launch = await browser.get(launchUrl(shop));
  expect(launch.statusCode).toBe(302);
  const authorize = new URL(String(launch.headers.location));
  expect(authorize.host).toBe(shop);
  expect(authorize.pathname).toBe("/admin/oauth/authorize");
  tokenFetch();
  const cb = await browser.get(callbackUrl(authorize.searchParams.get("state")!, shop));
  return { browser, cb };
}

describe("installing from Shopify", () => {
  it("authorizes at once, with nobody signed in, instead of asking for a login first", async () => {
    const res = await testBrowser(ctx).get(launchUrl());
    expect(res.statusCode).toBe(302);
    const url = new URL(String(res.headers.location));
    expect(`${url.origin}${url.pathname}`).toBe(`https://${SHOP}/admin/oauth/authorize`);
    expect(url.searchParams.get("client_id")).toBe("test_key");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:3001/api/shopify/callback");
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(await systemDb.store.count()).toBe(0);
  });

  it("stores the token in a workspace of the store's own, starts the import and opens the app", async () => {
    const { browser, cb } = await install();
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe("http://localhost:3001/claim");
    expect(browser.jar.get("shopify_claim")).toBeTruthy();

    const store = await systemDb.store.findUniqueOrThrow({ where: { shopDomain: SHOP } });
    expect(store.status).toBe("syncing");
    expect(await getAccessToken(store, ctx.deps.coord)).toBe("shpat_installed");
    const ws = await systemDb.workspace.findUniqueOrThrow({ where: { id: store.workspaceId }, include: { memberships: true, subscription: true } });
    expect(ws.name).toBe("Demo Shop");
    // Nobody can see it until it is claimed.
    expect(ws.memberships).toEqual([]);
    expect(ws.subscription?.plan).toBe("free");
    expect((await systemDb.syncJob.findMany({ where: { storeId: store.id } })).map((j) => j.kind).sort()).toEqual(["orders", "products", "shop", "variants"]);
    const connected = await systemDb.auditLog.findFirstOrThrow({ where: { action: "store.connected" } });
    expect(connected.actorUserId).toBeNull();
    expect(connected.metadata).toMatchObject({ shop: SHOP, via: "shopify_install" });
  });

  it("lets the person who installed it add it to their account, once", async () => {
    const { browser } = await install();
    const offer = await browser.get("/shopify/claim");
    expect(offer.statusCode).toBe(200);
    expect(offer.json()).toMatchObject({ shop: SHOP, claimable: true });

    // Signing in is needed to claim it.
    const anon = await browser.post("/shopify/claim");
    expect(anon.statusCode).toBe(401);

    const user = await browser.signIn("merchant", "merchant@x.com");
    const claimed = await browser.post("/shopify/claim");
    expect(claimed.statusCode).toBe(200);
    const store = await systemDb.store.findUniqueOrThrow({ where: { shopDomain: SHOP } });
    expect(claimed.json()).toEqual({ workspace: { id: store.workspaceId, name: "Demo Shop", role: "owner" }, storeId: store.id });
    const member = await systemDb.membership.findUniqueOrThrow({ where: { workspaceId_userId: { workspaceId: store.workspaceId, userId: user.id } } });
    expect(member.role).toBe("owner");
    expect(await systemDb.auditLog.count({ where: { action: "workspace.claimed", actorUserId: user.id } })).toBe(1);

    // The claim is spent: the cookie is gone and the dashboard is theirs.
    expect(browser.jar.has("shopify_claim")).toBe(false);
    expect((await browser.post("/shopify/claim")).statusCode).toBe(404);
    const overview = await browser.get(`/workspaces/${store.workspaceId}/stores`);
    expect(overview.statusCode).toBe(200);
  });

  it("asks for a confirmed email before adding the store to an account", async () => {
    const { browser } = await install();
    await browser.signIn("unverified", "unverified@x.com", false);
    const res = await browser.post("/shopify/claim");
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("email_unverified");
    // Still offered once they have confirmed it.
    expect((await browser.get("/shopify/claim")).json().claimable).toBe(true);
  });

  it("never gives a store two owners: a second claim for it is refused", async () => {
    const first = await install();
    // The same store opened from the admin in another browser gets its own claim cookie.
    const other = testBrowser(ctx);
    expect((await other.get(launchUrl())).headers.location).toBe("http://localhost:3001/claim");

    await first.browser.signIn("first", "first@x.com");
    expect((await first.browser.post("/shopify/claim")).statusCode).toBe(200);

    await other.signIn("second", "second@x.com");
    expect((await other.get("/shopify/claim")).json().claimable).toBe(false);
    const res = await other.post("/shopify/claim");
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("already_claimed");
    const store = await systemDb.store.findUniqueOrThrow({ where: { shopDomain: SHOP } });
    expect(await systemDb.membership.count({ where: { workspaceId: store.workspaceId } })).toBe(1);
  });

  it("refuses a claim without the browser's cookie", async () => {
    await install();
    const stranger = testBrowser(ctx);
    await stranger.signIn("stranger", "stranger@x.com");
    expect((await stranger.get("/shopify/claim")).statusCode).toBe(404);
    const res = await stranger.post("/shopify/claim");
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("claim_expired");
  });

  it("opens an installed store without authorizing again", async () => {
    const { browser } = await install();
    await browser.signIn("owner", "owner@x.com");
    await browser.post("/shopify/claim");
    const store = await systemDb.store.findUniqueOrThrow({ where: { shopDomain: SHOP } });

    const again = await browser.get(launchUrl());
    expect(again.statusCode).toBe(302);
    expect(again.headers.location).toBe(`http://localhost:3001/onboarding?step=sync&store=${store.id}`);
    // Signed out, the same link goes to the dashboard by way of sign-in (the page asks for it).
    expect((await testBrowser(ctx).get(launchUrl())).headers.location).toBe(`http://localhost:3001/onboarding?step=sync&store=${store.id}`);
  });

  it("authorizes again on reinstall and keeps the store in its workspace", async () => {
    const { headers } = await signIn(ctx, "owner", "owner@x.com");
    const ws = await createWorkspace(ctx, headers);
    const old = await createStore(ws, SHOP, ["read_orders"], { status: "uninstalled", uninstalledAt: new Date(), shopifyAppKey: "default" });

    const { cb } = await install();
    expect(cb.headers.location).toBe(`http://localhost:3001/onboarding?step=sync&store=${old.id}`);
    const store = await systemDb.store.findUniqueOrThrow({ where: { id: old.id } });
    expect(store).toMatchObject({ workspaceId: ws, status: "syncing", uninstalledAt: null });
    expect(await getAccessToken(store, ctx.deps.coord)).toBe("shpat_installed");
    expect(await systemDb.workspace.count()).toBe(1);
  });

  it("authorizes again when Shopify refuses the token it holds", async () => {
    const { headers } = await signIn(ctx, "owner", "owner@x.com");
    const ws = await createWorkspace(ctx, headers);
    const store = await createStore(ws, SHOP, ["read_orders"], { status: "error", accessTokenEnc: "v1:x", shopifyAppKey: "default" });
    await systemDb.syncJob.create({ data: { workspaceId: ws, storeId: store.id, kind: "orders", status: "failed", error: "Shopify auth error 401" } });
    const res = await testBrowser(ctx).get(launchUrl());
    expect(new URL(String(res.headers.location)).pathname).toBe("/admin/oauth/authorize");
  });

  it("authorizes an unverified visitor too, rather than stopping at sign-up", async () => {
    const browser = testBrowser(ctx);
    await browser.signIn("unv", "unv@x.com", false);
    const res = await browser.get(launchUrl());
    expect(new URL(String(res.headers.location)).pathname).toBe("/admin/oauth/authorize");
  });

  it("connects a new store to the one workspace a signed-in person manages, as before", async () => {
    const browser = testBrowser(ctx);
    await browser.signIn("solo", "solo@x.com");
    const ws = (await browser.post("/workspaces", { name: "Solo" })).json().workspace.id as string;
    const { cb } = await install(browser);
    const store = await systemDb.store.findUniqueOrThrow({ where: { shopDomain: SHOP } });
    expect(store.workspaceId).toBe(ws);
    expect(cb.headers.location).toBe(`http://localhost:3001/onboarding?step=sync&store=${store.id}`);
    expect(await systemDb.workspace.count()).toBe(1);
  });

  it("lets an account connect a store nobody has claimed, and drops the empty workspace it leaves", async () => {
    await install();
    const unclaimedWs = (await systemDb.store.findUniqueOrThrow({ where: { shopDomain: SHOP } })).workspaceId;

    const { headers, cookie } = await signIn(ctx, "later", "later@x.com");
    const ws = await createWorkspace(ctx, headers, "Later");
    const start = await ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/shopify/install`, headers, payload: { shop: SHOP } });
    expect(start.statusCode).toBe(200);
    const state = new URL(start.json().url).searchParams.get("state")!;
    tokenFetch("shpat_connected");
    const cb = await ctx.app.inject({ method: "GET", url: callbackUrl(state), headers: { cookie: `${cookie}; shopify_oauth_state=${state}` } });
    expect(cb.headers.location).toMatch(/\/onboarding\?step=sync&store=/);

    const store = await systemDb.store.findUniqueOrThrow({ where: { shopDomain: SHOP } });
    expect(store.workspaceId).toBe(ws);
    expect(await systemDb.workspace.findUnique({ where: { id: unclaimedWs } })).toBeNull();
  });

  it("keeps a claimed store out of reach of anyone else's connect", async () => {
    const { browser } = await install();
    await browser.signIn("owner", "owner@x.com");
    await browser.post("/shopify/claim");

    const { headers } = await signIn(ctx, "rival", "rival@x.com");
    const ws = await createWorkspace(ctx, headers, "Rival");
    const res = await ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/shopify/install`, headers, payload: { shop: SHOP } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("store_taken");
  });

  it("sends a failed install back to the page that explains it", async () => {
    const browser = testBrowser(ctx);
    const launch = await browser.get(launchUrl());
    const state = new URL(String(launch.headers.location)).searchParams.get("state")!;
    ctx.setFetch(async () => new Response("nope", { status: 400 }));
    const cb = await browser.get(callbackUrl(state));
    expect(cb.headers.location).toBe("http://localhost:3001/claim?error=exchange_failed");
    expect(await systemDb.store.count()).toBe(0);
    expect(await systemDb.workspace.count()).toBe(0);
  });
});

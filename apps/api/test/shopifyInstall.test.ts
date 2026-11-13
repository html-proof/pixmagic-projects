import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { systemDb } from "@app/db";
import { signShopifyQuery, signWebhookBody } from "@app/shared";
import { getAccessToken, recordDataRequest } from "@app/core";
// The worker's own handler, for what it does with an uninstall queued before a reinstall.
import { processWebhook } from "@app/worker";
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

describe("opened inside Shopify's admin", () => {
  // The admin frames the app URL (embedded=1) although the app is non-embedded; a redirect there
  // lands on pages that refuse framing ("bizinsights.io refused to connect").
  const framed = (url: string) => ctx.app.inject({ method: "GET", url, headers: { "sec-fetch-dest": "iframe" } });

  it("answers a framed launch with a page only that store's admin may frame, reopening the launch as the whole tab", async () => {
    const url = launchUrl();
    const res = await framed(url);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    const csp = String(res.headers["content-security-policy"]);
    expect(csp).toContain(`frame-ancestors https://${SHOP} https://admin.shopify.com`);
    expect(res.headers["x-frame-options"]).toBeUndefined();
    expect(res.body).toContain('<meta name="shopify-api-key" content="test_key">');
    const target = `http://localhost:3001/api${url}`;
    expect(res.body).toContain(`href="${target.replace(/&/g, "&#38;")}" target="_top"`);
    expect(res.body).toContain(`open(${JSON.stringify(target)},"_top")`);
    // Nothing was authorized or stored yet: that happens on the top-level request.
    expect(await systemDb.store.count()).toBe(0);
  });

  it("goes on as usual once the same link is opened as the whole tab", async () => {
    const res = await ctx.app.inject({ method: "GET", url: launchUrl(), headers: { "sec-fetch-dest": "document" } });
    expect(res.statusCode).toBe(302);
    expect(new URL(String(res.headers.location)).pathname).toBe("/admin/oauth/authorize");
  });

  it("still refuses an unsigned framed launch, and every other page still refuses framing", async () => {
    const res = await framed(`/shopify/launch?shop=${SHOP}&timestamp=${now()}&hmac=bad`);
    expect(res.statusCode).toBe(302);
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(String(res.headers["content-security-policy"])).toContain("frame-ancestors 'none'");
  });
});

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
    expect(ws.awaitingClaim).toBe(true);
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
    expect((await systemDb.workspace.findUniqueOrThrow({ where: { id: store.workspaceId } })).awaitingClaim).toBe(false);
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
    // The same store opened from the admin in another browser gets its own claim cookie, once
    // Shopify has approved it there too.
    const { browser: other, cb } = await install(testBrowser(ctx));
    expect(cb.headers.location).toBe("http://localhost:3001/claim");

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

  it("authorizes again on reinstall and, for the account's own manager, keeps the store in its workspace", async () => {
    const browser = testBrowser(ctx);
    await browser.signIn("owner", "owner@x.com");
    const ws = (await browser.post("/workspaces", { name: "Acme" })).json().workspace.id as string;
    await browser.post("/workspaces", { name: "Second" });
    const old = await createStore(ws, SHOP, ["read_orders"], { status: "uninstalled", uninstalledAt: new Date(), shopifyAppKey: "default" });

    const { cb } = await install(browser);
    expect(cb.headers.location).toBe(`http://localhost:3001/onboarding?step=sync&store=${old.id}`);
    const store = await systemDb.store.findUniqueOrThrow({ where: { id: old.id } });
    expect(store).toMatchObject({ workspaceId: ws, status: "syncing", uninstalledAt: null });
    expect(await getAccessToken(store, ctx.deps.coord)).toBe("shpat_installed");
    expect(await systemDb.workspace.count()).toBe(2);
  });

  it("doesn't hand a store back to the account it was uninstalled from when someone else installs it", async () => {
    // Uninstalling is how a merchant cuts an account (an agency, a former partner) off.
    const { headers } = await signIn(ctx, "former", "former@x.com");
    const oldWs = await createWorkspace(ctx, headers, "Former");
    const old = await createStore(oldWs, SHOP, ["read_orders"], { status: "uninstalled", uninstalledAt: new Date(), shopifyAppKey: "default" });
    await systemDb.product.create({ data: { workspaceId: oldWs, storeId: old.id, shopifyId: "1", title: "Old tee", shopifyUpdatedAt: new Date() } });

    const { cb, browser } = await install();
    expect(cb.headers.location).toBe("http://localhost:3001/claim");
    const store = await systemDb.store.findUniqueOrThrow({ where: { id: old.id } });
    expect(store.workspaceId).not.toBe(oldWs);
    expect((await systemDb.workspace.findUniqueOrThrow({ where: { id: store.workspaceId } })).awaitingClaim).toBe(true);
    // The old account keeps its workspace but not the store, nor its copy of the store's data.
    expect(await systemDb.store.count({ where: { workspaceId: oldWs } })).toBe(0);
    expect(await systemDb.product.count({ where: { storeId: old.id } })).toBe(0);
    expect((await browser.get("/shopify/claim")).json().claimable).toBe(true);
  });

  it("goes through Shopify again before offering an unclaimed store to another browser", async () => {
    await install();
    const jobs = await systemDb.syncJob.count();
    // A signed launch link alone (it can be replayed for ten minutes) earns no claim.
    const res = await testBrowser(ctx).get(launchUrl());
    expect(new URL(String(res.headers.location)).pathname).toBe("/admin/oauth/authorize");
    expect(res.headers["set-cookie"] ?? "").not.toContain("shopify_claim=");
    // Approved there: the claim, the fresher token, and no second import.
    const { cb } = await install(testBrowser(ctx));
    expect(cb.headers.location).toBe("http://localhost:3001/claim");
    expect(await systemDb.syncJob.count()).toBe(jobs);
  });

  it("never offers a workspace that merely has no members", async () => {
    // A workspace the app didn't make for an install, left without members (an edge case).
    const ws = await systemDb.workspace.create({ data: { name: "Orphan" } });
    await createStore(ws.id, SHOP, ["read_orders"], { accessTokenEnc: "v1:x", shopifyAppKey: "default" });
    const res = await testBrowser(ctx).get(launchUrl());
    expect(res.headers.location).toMatch(/\/onboarding\?step=sync&store=/);
    const { headers } = await signIn(ctx, "taker", "taker@x.com");
    const mine = await createWorkspace(ctx, headers, "Mine");
    const taken = await ctx.app.inject({ method: "POST", url: `/workspaces/${mine}/shopify/install`, headers, payload: { shop: SHOP, from: "settings" } });
    expect(taken.json().error).toBe("store_taken");
    expect((await systemDb.store.findUniqueOrThrow({ where: { shopDomain: SHOP } })).workspaceId).toBe(ws.id);
  });

  it("a claim for a store connected to an account another way since has expired", async () => {
    const { browser } = await install();
    const { headers, cookie } = await signIn(ctx, "later", "later@x.com");
    const ws = await createWorkspace(ctx, headers, "Later");
    const start = await ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/shopify/install`, headers, payload: { shop: SHOP } });
    const state = new URL(start.json().url).searchParams.get("state")!;
    tokenFetch();
    await ctx.app.inject({ method: "GET", url: callbackUrl(state), headers: { cookie: `${cookie}; shopify_oauth_state=${state}` } });
    expect((await browser.get("/shopify/claim")).statusCode).toBe(404);
    await browser.signIn("first", "first@x.com");
    expect((await browser.post("/shopify/claim")).json().error).toBe("claim_expired");
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
    const installed = await systemDb.store.findUniqueOrThrow({ where: { shopDomain: SHOP } });
    const unclaimedWs = installed.workspaceId;
    // A customer's data request arrived before anyone claimed the store: it must not be lost.
    const pending = await recordDataRequest(installed, { requestId: "1", customerId: "7", email: "pat@example.com" });

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
    expect(await systemDb.dataRequest.findUniqueOrThrow({ where: { id: pending.request.id } })).toMatchObject({ workspaceId: ws, customerId: "7" });
  });

  it("keeps a claimed store out of reach of anyone else's connect", async () => {
    const { browser } = await install();
    await browser.signIn("owner", "owner@x.com");
    await browser.post("/shopify/claim");

    const { headers } = await signIn(ctx, "rival", "rival@x.com");
    const ws = await createWorkspace(ctx, headers, "Rival");
    const res = await ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/shopify/install`, headers, payload: { shop: SHOP, from: "settings" } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("store_taken");
    // From onboarding: on to the rival's own dashboard, which says the store is someone else's.
    const onboarding = await ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/shopify/install`, headers, payload: { shop: SHOP } });
    expect(onboarding.json().url).toBe(`http://localhost:3001/dashboard?ws=${ws}&taken=${SHOP}`);
    const store = await systemDb.store.findUniqueOrThrow({ where: { shopDomain: SHOP } });
    expect(store.workspaceId).not.toBe(ws);
    expect(await systemDb.membership.count({ where: { workspaceId: store.workspaceId } })).toBe(1);
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

describe("uninstalled and installed again seconds apart (App Review's test)", () => {
  // Shopify revokes the token at once, but its app/uninstalled waits in the queue for the worker,
  // so the reinstall's launch can arrive while the store still looks installed (production,
  // 2026-10-18: the launch opened the dashboard, then the worker wiped the token).
  const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  /**
   * Shopify after the reinstall: the code exchange issues `issues`, and its Admin API takes only
   * the tokens in `accepts`. Returns the tokens presented to the Admin API, in order.
   */
  function shopify({ accepts, issues = "shpat_reinstalled" }: { accepts: string[]; issues?: string }) {
    const presented: string[] = [];
    ctx.setFetch(async (input, init) => {
      const url = String(input);
      if (url === `https://${SHOP}/admin/oauth/access_token`) return json({ access_token: issues, scope: "read_orders,read_products" });
      if (url.startsWith(`https://${SHOP}/admin/api/`)) {
        const token = new Headers(init?.headers).get("x-shopify-access-token") ?? "";
        presented.push(token);
        return accepts.includes(token)
          ? json({ data: { currentAppInstallation: { id: "gid://shopify/AppInstallation/2" } } })
          : json({ errors: "[API] Invalid API key or access token (unrecognized login or wrong password)" }, 401);
      }
      throw new Error(`unexpected call to ${url}`);
    });
    return presented;
  }

  /** Shopify's app/uninstalled, received and queued (not processed); returns the queued job. */
  async function uninstallQueued() {
    const body = JSON.stringify({ id: 1, myshopify_domain: SHOP });
    const res = await ctx.app.inject({
      method: "POST",
      url: "/webhooks/shopify",
      headers: {
        "content-type": "application/json",
        "x-shopify-hmac-sha256": signWebhookBody(body, SECRET),
        "x-shopify-topic": "app/uninstalled",
        "x-shopify-shop-domain": SHOP,
        "x-shopify-webhook-id": "uninstall-1",
        "x-shopify-triggered-at": new Date(Date.now() - 1000).toISOString(),
      },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    const job = ctx.deps.queues.sent.webhooks.find((j) => j.topic === "app/uninstalled")!;
    expect(await systemDb.webhookEvent.findUniqueOrThrow({ where: { id: job.eventId } })).toMatchObject({ status: "queued" });
    return job;
  }

  /** A store installed from Shopify a while ago (token shpat_installed), claimed if `claim`. */
  async function installedEarlier(claim: boolean) {
    const { browser } = await install();
    if (claim) {
      await browser.signIn("owner", "owner@x.com");
      await browser.post("/shopify/claim");
    }
    const store = await systemDb.store.update({ where: { shopDomain: SHOP }, data: { status: "active", installedAt: minutesAgo(30) } });
    return { browser, store };
  }

  it("authorizes a claimed store again instead of opening it, and the queued uninstall then leaves the new installation alone", async () => {
    const { browser, store } = await installedEarlier(true);
    const uninstall = await uninstallQueued();
    const presented = shopify({ accepts: ["shpat_reinstalled"] });

    const launch = await browser.get(launchUrl());
    const authorize = new URL(String(launch.headers.location));
    expect(`${authorize.origin}${authorize.pathname}`).toBe(`https://${SHOP}/admin/oauth/authorize`);
    expect(authorize.searchParams.get("client_id")).toBe("test_key");
    expect(presented).toEqual(["shpat_installed"]);

    const cb = await browser.get(callbackUrl(authorize.searchParams.get("state")!));
    expect(cb.headers.location).toBe(`http://localhost:3001/onboarding?step=sync&store=${store.id}`);
    const reinstalled = await systemDb.store.findUniqueOrThrow({ where: { id: store.id } });
    expect(reinstalled).toMatchObject({ workspaceId: store.workspaceId, status: "syncing", uninstalledAt: null });
    expect(reinstalled.installedAt!.getTime()).toBeGreaterThan(Date.parse(uninstall.triggeredAt!));
    expect(await getAccessToken(reinstalled, ctx.deps.coord)).toBe("shpat_reinstalled");

    // The worker gets to the uninstall: it predates an installation Shopify honours, so it's set aside.
    await processWebhook(uninstall, ctx.deps);
    const after = await systemDb.store.findUniqueOrThrow({ where: { id: store.id } });
    expect(after).toMatchObject({ status: "syncing", uninstalledAt: null });
    expect(await getAccessToken(after, ctx.deps.coord)).toBe("shpat_reinstalled");
    expect(await systemDb.webhookEvent.findUniqueOrThrow({ where: { id: uninstall.eventId } })).toMatchObject({ status: "succeeded" });
    expect(await systemDb.auditLog.count({ where: { action: "store.uninstalled" } })).toBe(0);
    // And the store opens from Shopify now, without another authorization.
    expect((await browser.get(launchUrl())).headers.location).toBe(`http://localhost:3001/onboarding?step=sync&store=${store.id}`);
  });

  it("records the approval of a store nobody has claimed as its installation, so the queued uninstall leaves it alone too", async () => {
    const { store } = await installedEarlier(false);
    const uninstall = await uninstallQueued();
    shopify({ accepts: ["shpat_reinstalled"] });
    const jobs = await systemDb.syncJob.count();

    const browser = testBrowser(ctx);
    const launch = await browser.get(launchUrl());
    const authorize = new URL(String(launch.headers.location));
    expect(authorize.pathname).toBe("/admin/oauth/authorize");
    const cb = await browser.get(callbackUrl(authorize.searchParams.get("state")!));
    expect(cb.headers.location).toBe("http://localhost:3001/claim");
    const reinstalled = await systemDb.store.findUniqueOrThrow({ where: { id: store.id } });
    expect(reinstalled.installedAt!.getTime()).toBeGreaterThan(Date.parse(uninstall.triggeredAt!));
    // Still no second import for a store opened again before anyone claimed it.
    expect(await systemDb.syncJob.count()).toBe(jobs);

    await processWebhook(uninstall, ctx.deps);
    const after = await systemDb.store.findUniqueOrThrow({ where: { id: store.id } });
    expect(after).toMatchObject({ status: "active", uninstalledAt: null });
    expect(await getAccessToken(after, ctx.deps.coord)).toBe("shpat_reinstalled");
    expect((await browser.get("/shopify/claim")).json()).toMatchObject({ shop: SHOP, claimable: true });
  });

  it("still opens a store whose token Shopify accepts, asking Shopify once and authorizing nothing", async () => {
    const { browser, store } = await installedEarlier(true);
    const presented = shopify({ accepts: ["shpat_installed"] });
    const launch = await browser.get(launchUrl());
    expect(launch.headers.location).toBe(`http://localhost:3001/onboarding?step=sync&store=${store.id}`);
    expect(launch.headers["set-cookie"] ?? "").not.toContain("shopify_oauth_state=");
    expect(presented).toEqual(["shpat_installed"]);
  });

  it("opens the store as before when Shopify can't be asked", async () => {
    const { browser, store } = await installedEarlier(true);
    ctx.setFetch(async () => {
      throw new TypeError("fetch failed");
    });
    const launch = await browser.get(launchUrl());
    expect(launch.headers.location).toBe(`http://localhost:3001/onboarding?step=sync&store=${store.id}`);
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { systemDb } from "@app/db";
import { encryptTokenFields, getAccessToken } from "@app/core";
import { signShopifyQuery } from "@app/shared";
import { clean, createStore, setup, signIn, teardown, testBrowser, type TestCtx } from "./helpers.js";

let ctx: TestCtx;
beforeAll(async () => (ctx = await setup()));
afterAll(async () => teardown(ctx));
beforeEach(async () => clean(ctx));

const SECRET = "test_secret";
const SHOP = "demo-shop.myshopify.com";
const APP = "http://localhost:3001";
const now = () => String(Math.floor(Date.now() / 1000));

type Browser = ReturnType<typeof testBrowser>;

function callbackUrl(params: Record<string, string>) {
  return `/shopify/callback?${new URLSearchParams({ ...params, hmac: signShopifyQuery(params, SECRET) })}`;
}

function launchUrl(shop = SHOP, timestamp = now()) {
  const params = { shop, host: "aG9zdA", timestamp };
  return `/shopify/launch?${new URLSearchParams({ ...params, hmac: signShopifyQuery(params, SECRET) })}`;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * Fake Shopify token endpoint: the per-user (online) exchange returns the staff account that
 * approved; the offline exchange returns the store token.
 *
 * Both exchanges send an identical body - Shopify tells them apart by the authorization code,
 * since online vs offline is decided by `grant_options[]=per-user` on the authorize URL. So this
 * fixture keys on the code the test supplies ("usercode" then "offcode"), as Shopify effectively
 * does. It used to key on `expiring: 1`, which no longer exists.
 */
function fakeShopify(opts: { email?: string; emailVerified?: boolean; scope?: string; accessToken?: string; failOffline?: boolean } = {}) {
  const calls: string[] = [];
  ctx.setFetch(async (input, init) => {
    expect(String(input)).toMatch(/^https:\/\/[a-z0-9-]+\.myshopify\.com\/admin\/oauth\/access_token$/);
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ client_id: "test_key", client_secret: SECRET });
    if (body.code === "offcode") {
      calls.push(`offline:${body.code}`);
      if (opts.failOffline) return json({ error: "invalid_request" }, 400);
      // A permanent offline token: no expires_in, no refresh_token.
      return json({
        access_token: opts.accessToken ?? "shpat_SIGNUP_PLAINTEXT",
        scope: opts.scope ?? "read_orders,read_products",
      });
    }
    calls.push(`online:${body.code}`);
    return json({
      access_token: "shpua_ONLINE_PLAINTEXT",
      scope: "read_orders,read_products",
      expires_in: 86399,
      associated_user_scope: "read_orders,read_products",
      associated_user: {
        id: 902541635,
        first_name: "Mia",
        last_name: "Merchant",
        email: opts.email ?? "merchant@x.com",
        email_verified: opts.emailVerified ?? true,
        account_owner: true,
        locale: "en",
        collaborator: false,
      },
    });
  });
  return calls;
}

/** Shopify's side of an authorize redirect: the merchant approves and comes back to our callback. */
function approve(b: Browser, authorizeUrl: string, code: string) {
  const u = new URL(authorizeUrl);
  expect(u.pathname).toBe("/admin/oauth/authorize");
  return b.get(callbackUrl({ code, shop: u.host, state: u.searchParams.get("state")!, timestamp: now() }));
}

/** start (with a store address) → per-user grant → offline grant, ending on /start?step=finish. */
async function connectViaShopify(b: Browser, email: string, shop = "demo-shop") {
  const start = await b.post("/auth/shopify/start", { email, shop });
  expect(start.statusCode).toBe(200);
  const user = await approve(b, start.json().url, "usercode");
  expect(user.statusCode).toBe(302);
  const offline = await approve(b, user.headers.location!, "offcode");
  expect(offline.headers.location).toBe(`${APP}/start?step=finish`);
  return offline;
}

/** The signup record as stored (read without consuming it). */
async function peekSignup(b: Browser) {
  const key = `signup:${b.jar.get("shopify_signup")}`;
  const raw = await ctx.deps.coord.take(key);
  if (raw) await ctx.deps.coord.put(key, raw, 1800);
  return raw;
}

const claim = (b: Browser) => b.post("/auth/shopify/claim");

/** Move the signup's first sign-in token 3 minutes into the past (past finish's re-issue window). */
async function ageTokenIssue(b: Browser) {
  const key = `signup:${b.jar.get("shopify_signup")}`;
  const rec = JSON.parse((await ctx.deps.coord.take(key))!);
  await ctx.deps.coord.put(key, JSON.stringify({ ...rec, tokenIssuedAt: Date.now() - 3 * 60_000 }), 600);
}

describe("Continue with Shopify: sign-up", () => {
  it("start → per-user grant → offline grant → finish → session → claim connects the store", async () => {
    const calls = fakeShopify();
    const b = testBrowser(ctx);

    const start = await b.post("/auth/shopify/start", { email: " Merchant@X.com ", shop: "Demo-Shop" });
    expect(start.statusCode).toBe(200);
    const authUser = new URL(start.json().url);
    expect(authUser.host).toBe(SHOP);
    expect(authUser.searchParams.get("grant_options[]")).toBe("per-user");
    expect(authUser.searchParams.get("scope")).toContain("read_orders");
    expect(b.jar.get("shopify_signup")).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(b.jar.get("shopify_oauth_state")).toBe(authUser.searchParams.get("state"));
    const signupCookie = start.headers["set-cookie"]!.split(", ").find((s) => s.startsWith("shopify_signup="))!;
    for (const attr of ["Max-Age=1800", "Path=/", "HttpOnly", "SameSite=Lax"]) expect(signupCookie).toContain(attr);

    // Leg 1 (who approved) bounces straight on to leg 2 (the store token), with fresh state.
    const user = await approve(b, start.json().url, "usercode");
    expect(user.statusCode).toBe(302);
    const authOffline = new URL(user.headers.location!);
    expect(authOffline.host).toBe(SHOP);
    expect(authOffline.searchParams.get("grant_options[]")).toBeNull();
    expect(authOffline.searchParams.get("state")).not.toBe(authUser.searchParams.get("state"));
    expect(b.jar.get("shopify_oauth_state")).toBe(authOffline.searchParams.get("state"));

    const offline = await approve(b, user.headers.location!, "offcode");
    expect(offline.headers.location).toBe(`${APP}/start?step=finish`);
    expect(calls).toEqual(["online:usercode", "offline:offcode"]);

    // Tokens wait for the claim encrypted; nothing on the record is a usable secret.
    const raw = (await peekSignup(b))!;
    expect(raw).toContain("merchant@x.com");
    expect(raw).not.toContain("PLAINTEXT");

    const finish = await b.post("/auth/shopify/finish", {});
    expect(finish.statusCode).toBe(200);
    expect(finish.json()).toEqual({ status: "signed_in", customToken: "custom-otp-merchant@x.com", email: "merchant@x.com" });

    // The web app signs in with the custom token and exchanges the ID token for a session.
    const me = await b.signIn("otp-merchant@x.com", "merchant@x.com");
    const res = await claim(b);
    expect(res.statusCode).toBe(200);
    const { next, workspaceId, storeId } = res.json();
    expect(next).toBe(`/onboarding?step=sync&store=${storeId}`);
    expect(b.jar.has("shopify_signup")).toBe(false);

    const store = await systemDb.store.findUniqueOrThrow({ where: { shopDomain: SHOP } });
    expect(store.id).toBe(storeId);
    expect(store.workspaceId).toBe(workspaceId);
    expect(store.status).toBe("syncing");
    expect(store.grantedScopes).toEqual(["read_orders", "read_products"]);
    expect(JSON.stringify(store)).not.toContain("PLAINTEXT");
    expect(await getAccessToken(store, ctx.deps.coord)).toBe("shpat_SIGNUP_PLAINTEXT");

    const ws = await systemDb.workspace.findUniqueOrThrow({ where: { id: workspaceId }, include: { memberships: true, subscription: true } });
    expect(ws.name).toBe("Demo Shop");
    expect(ws.memberships.map((m) => [m.userId, m.role])).toEqual([[me.id, "owner"]]);
    expect(ws.subscription?.plan).toBe("free");
    expect(await systemDb.auditLog.count({ where: { workspaceId, action: "workspace.created" } })).toBe(1);
    const connected = await systemDb.auditLog.findFirstOrThrow({ where: { workspaceId, action: "store.connected" } });
    expect(connected.metadata).toMatchObject({ shop: SHOP, via: "shopify_signup" });

    const jobs = await systemDb.syncJob.findMany({ where: { storeId } });
    expect(jobs.map((j) => j.kind).sort()).toEqual(["orders", "products", "shop", "variants"]);
    // Everything that doesn't need the store's time zone starts now; orders waits for `shop`.
    expect(ctx.deps.queues.sent.sync.map((j) => j.kind).sort()).toEqual(["products", "shop", "variants"]);
    expect((await systemDb.user.findUniqueOrThrow({ where: { id: me.id } })).displayName).toBe("Mia Merchant");

    // Single use: the record is gone (and so is the cookie).
    const again = await claim(b);
    expect(again.statusCode).toBe(400);
    expect(again.json().error).toBe("signup_expired");
    const meRes = await b.get("/me");
    expect(meRes.json().workspaces).toEqual([{ id: workspaceId, name: "Demo Shop", role: "owner" }]);
  });

  it("managed install: start without a store → Shopify install → launch → grants → claim", async () => {
    fakeShopify();
    const b = testBrowser(ctx);
    const start = await b.post("/auth/shopify/start", { email: "merchant@x.com" });
    expect(start.statusCode).toBe(200);
    expect(start.json().url).toBe("https://admin.shopify.com/oauth/install?client_id=test_key");
    expect(b.jar.has("shopify_signup")).toBe(true);
    expect(b.jar.has("shopify_oauth_state")).toBe(false);

    // Shopify opens the app URL for the store the merchant picked.
    const launch = await b.get(launchUrl());
    expect(launch.statusCode).toBe(302);
    const auth = new URL(launch.headers.location!);
    expect(auth.host).toBe(SHOP);
    expect(auth.searchParams.get("grant_options[]")).toBe("per-user");

    const user = await approve(b, launch.headers.location!, "usercode");
    const offline = await approve(b, user.headers.location!, "offcode");
    expect(offline.headers.location).toBe(`${APP}/start?step=finish`);
    expect((await b.post("/auth/shopify/finish")).json().status).toBe("signed_in");
    await b.signIn("otp-merchant@x.com", "merchant@x.com");
    const res = await claim(b);
    expect(res.statusCode).toBe(200);
    expect((await systemDb.store.findUniqueOrThrow({ where: { shopDomain: SHOP } })).workspaceId).toBe(res.json().workspaceId);
  });

  it("a stale launch link doesn't continue a signup", async () => {
    const b = testBrowser(ctx);
    await b.post("/auth/shopify/start", { email: "merchant@x.com" });
    const launch = await b.get(launchUrl(SHOP, String(Math.floor(Date.now() / 1000) - 3600)));
    expect(launch.headers.location).toBe(`${APP}/start?shop=${SHOP}`);
  });

  it("different Shopify email → verify_email → OTP for the typed email → claim", async () => {
    fakeShopify({ email: "staff@x.com" });
    const b = testBrowser(ctx);
    await connectViaShopify(b, "owner@x.com");
    const minted = ctx.auth.customTokens.length;

    const finish = await b.post("/auth/shopify/finish", {});
    expect(finish.json()).toEqual({ status: "verify_email", email: "owner@x.com", shopifyEmail: "staff@x.com" });
    expect(ctx.auth.customTokens).toHaveLength(minted);

    expect((await b.post("/auth/otp/request", { email: "owner@x.com" })).statusCode).toBe(200);
    const code = /(\d{6})/.exec(ctx.mailer.sent.at(-1)!.subject)![1]!;
    const verify = await b.post("/auth/otp/verify", { email: "owner@x.com", code });
    expect(verify.json().customToken).toBe("custom-otp-owner@x.com");
    const owner = await b.signIn("otp-owner@x.com", "owner@x.com");

    const res = await claim(b);
    expect(res.statusCode).toBe(200);
    const m = await systemDb.membership.findFirstOrThrow({ where: { workspaceId: res.json().workspaceId } });
    expect(m.userId).toBe(owner.id);
  });

  it("useShopifyEmail signs in as the Shopify account's verified email", async () => {
    fakeShopify({ email: "staff@x.com" });
    const b = testBrowser(ctx);
    await connectViaShopify(b, "owner@x.com");
    expect((await b.post("/auth/shopify/finish", {})).json().status).toBe("verify_email");

    const finish = await b.post("/auth/shopify/finish", { useShopifyEmail: true });
    expect(finish.json()).toEqual({ status: "signed_in", customToken: "custom-otp-staff@x.com", email: "staff@x.com" });
    await b.signIn("otp-staff@x.com", "staff@x.com");
    const res = await claim(b);
    expect(res.statusCode).toBe(200);
  });

  it("an unverified Shopify email is never trusted", async () => {
    // Even when it matches the typed email.
    fakeShopify({ email: "owner@x.com", emailVerified: false });
    const b = testBrowser(ctx);
    await connectViaShopify(b, "owner@x.com");
    const minted = ctx.auth.customTokens.length;

    expect((await b.post("/auth/shopify/finish", {})).json()).toEqual({ status: "verify_email", email: "owner@x.com", shopifyEmail: null });
    expect((await b.post("/auth/shopify/finish", { useShopifyEmail: true })).json().status).toBe("verify_email");
    expect(ctx.auth.customTokens).toHaveLength(minted);

    // A session for the typed email still needs that email proven (here: verified sign-in).
    await b.signIn("unverified-owner", "owner@x.com", false);
    const res = await claim(b);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("email_mismatch");
  });

  it("finish and claim need this browser's signup cookie", async () => {
    fakeShopify();
    const b = testBrowser(ctx);
    await connectViaShopify(b, "merchant@x.com");
    const nonce = b.jar.get("shopify_signup")!;

    b.jar.delete("shopify_signup");
    const finish = await b.post("/auth/shopify/finish", {});
    expect(finish.statusCode).toBe(400);
    expect(finish.json().error).toBe("signup_expired");
    b.jar.set("shopify_signup", "not-a-real-signup-nonce-000000000");
    expect((await b.post("/auth/shopify/finish", {})).json().error).toBe("signup_expired");

    // Another browser (even signed in with the right email) can't claim it.
    const other = testBrowser(ctx);
    await other.signIn("otp-merchant@x.com", "merchant@x.com");
    const res = await claim(other);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("signup_expired");

    // The real browser still can.
    b.jar.set("shopify_signup", nonce);
    expect((await b.post("/auth/shopify/finish", {})).json().status).toBe("signed_in");
    await b.signIn("otp-merchant@x.com", "merchant@x.com");
    expect((await claim(b)).statusCode).toBe(200);
  });

  it("callbacks need the signup cookie the state was issued to", async () => {
    fakeShopify();
    const a = testBrowser(ctx);
    const startA = await a.post("/auth/shopify/start", { email: "a@x.com", shop: "demo-shop" });
    const b = testBrowser(ctx);
    await b.post("/auth/shopify/start", { email: "b@x.com", shop: "demo-shop" });

    // B replays A's authorize response with A's state cookie but its own signup.
    b.jar.set("shopify_oauth_state", a.jar.get("shopify_oauth_state")!);
    const foreign = await approve(b, startA.json().url, "usercode");
    expect(foreign.headers.location).toBe(`${APP}/start?error=state_mismatch`);

    // No signup cookie at all.
    const c = testBrowser(ctx);
    const startC = await c.post("/auth/shopify/start", { email: "c@x.com", shop: "demo-shop" });
    c.jar.delete("shopify_signup");
    const missing = await approve(c, startC.json().url, "usercode");
    expect(missing.headers.location).toBe(`${APP}/start?error=signup_expired`);
  });

  it("callback state is single use", async () => {
    fakeShopify();
    const b = testBrowser(ctx);
    const start = await b.post("/auth/shopify/start", { email: "merchant@x.com", shop: "demo-shop" });
    const state1 = b.jar.get("shopify_oauth_state")!;
    const user = await approve(b, start.json().url, "usercode");
    expect(user.statusCode).toBe(302);

    const offlineState = b.jar.get("shopify_oauth_state")!;
    b.jar.set("shopify_oauth_state", state1);
    const replay = await approve(b, start.json().url, "usercode");
    expect(replay.headers.location).toBe(`${APP}/start?error=state_expired`);

    b.jar.set("shopify_oauth_state", offlineState);
    expect((await approve(b, user.headers.location!, "offcode")).headers.location).toBe(`${APP}/start?step=finish`);
    b.jar.set("shopify_oauth_state", offlineState);
    expect((await approve(b, user.headers.location!, "offcode")).headers.location).toBe(`${APP}/start?error=state_expired`);
  });

  it("signup callbacks keep the HMAC, timestamp and shop checks", async () => {
    fakeShopify();
    const b = testBrowser(ctx);
    const start = await b.post("/auth/shopify/start", { email: "merchant@x.com", shop: "demo-shop" });
    const state = new URL(start.json().url).searchParams.get("state")!;
    const p = { code: "c", shop: SHOP, state, timestamp: now() };

    const forged = await b.get(`/shopify/callback?${new URLSearchParams({ ...p, hmac: "deadbeef" })}`);
    expect(forged.headers.location).toBe(`${APP}/start?error=invalid_hmac`);
    const stale = await b.get(callbackUrl({ ...p, timestamp: "1000" }));
    expect(stale.headers.location).toBe(`${APP}/start?error=stale_request`);
    b.jar.set("shopify_oauth_state", state);
    const otherShop = await b.get(callbackUrl({ ...p, shop: "other.myshopify.com" }));
    expect(otherShop.headers.location).toBe(`${APP}/start?error=shop_mismatch`);
  });

  it("refuses a store token without the required scopes", async () => {
    fakeShopify({ scope: "read_products" });
    const b = testBrowser(ctx);
    const start = await b.post("/auth/shopify/start", { email: "merchant@x.com", shop: "demo-shop" });
    const user = await approve(b, start.json().url, "usercode");
    const offline = await approve(b, user.headers.location!, "offcode");
    expect(offline.headers.location).toBe(`${APP}/start?error=missing_required_scopes`);
    expect((await b.post("/auth/shopify/finish", {})).json().error).toBe("signup_expired");
  });

  it("reports a failed code exchange without leaking anything", async () => {
    fakeShopify({ failOffline: true });
    const b = testBrowser(ctx);
    const start = await b.post("/auth/shopify/start", { email: "merchant@x.com", shop: "demo-shop" });
    const user = await approve(b, start.json().url, "usercode");
    const offline = await approve(b, user.headers.location!, "offcode");
    expect(offline.headers.location).toBe(`${APP}/start?error=exchange_failed`);
  });

  it("a double-submitted finish succeeds both times", async () => {
    fakeShopify();
    const b = testBrowser(ctx);
    await connectViaShopify(b, "merchant@x.com");
    const [r1, r2] = await Promise.all([b.post("/auth/shopify/finish", {}), b.post("/auth/shopify/finish", {})]);
    expect([r1.json().status, r2.json().status]).toEqual(["signed_in", "signed_in"]);
    await b.signIn("otp-merchant@x.com", "merchant@x.com");
    expect((await claim(b)).statusCode).toBe(200);
  });

  it("finish hands out a sign-in token only briefly, and doesn't extend the signup's life", async () => {
    fakeShopify();
    const b = testBrowser(ctx);
    await connectViaShopify(b, "merchant@x.com");
    const before = JSON.parse((await peekSignup(b))!);
    expect((await b.post("/auth/shopify/finish", {})).json().status).toBe("signed_in");
    const after = JSON.parse((await peekSignup(b))!);
    expect(after.expiresAt).toBe(before.expiresAt);
    expect(after.tokenIssuedAt).toBeGreaterThan(0);
    // A retry right away is fine...
    expect((await b.post("/auth/shopify/finish", {})).json().status).toBe("signed_in");

    // ...but minutes later (a browser left behind) it no longer mints sessions: the email has to be
    // proven again by code. Not "start again", though: the first session may simply have failed to
    // mint (our database down for a few minutes), and that mustn't cost both Shopify approvals.
    await ageTokenIssue(b);
    const minted = ctx.auth.customTokens.length;
    const late = await b.post("/auth/shopify/finish", { useShopifyEmail: true });
    expect(late.statusCode).toBe(200);
    expect(late.json()).toEqual({ status: "verify_email", email: "merchant@x.com", shopifyEmail: null, reason: "reissue_expired" });
    expect(ctx.auth.customTokens).toHaveLength(minted);
  });

  it("after the re-issue window, an email code still finishes the signup (for the email Shopify proved)", async () => {
    // The merchant chose their Shopify email, so that's the account the first finish signed in.
    fakeShopify({ email: "staff@x.com" });
    const b = testBrowser(ctx);
    await connectViaShopify(b, "owner@x.com");
    expect((await b.post("/auth/shopify/finish", { useShopifyEmail: true })).json().status).toBe("signed_in");
    // ...and then /auth/session failed until the window had passed.
    await ageTokenIssue(b);

    const late = await b.post("/auth/shopify/finish", { useShopifyEmail: true });
    expect(late.json()).toEqual({ status: "verify_email", email: "staff@x.com", shopifyEmail: null, reason: "reissue_expired" });
    expect((await b.post("/auth/otp/request", { email: "staff@x.com" })).statusCode).toBe(200);
    const code = /(\d{6})/.exec(ctx.mailer.sent.at(-1)!.subject)![1]!;
    expect((await b.post("/auth/otp/verify", { email: "staff@x.com", code })).json().customToken).toBe("custom-otp-staff@x.com");
    await b.signIn("otp-staff@x.com", "staff@x.com");
    const res = await claim(b);
    expect(res.statusCode).toBe(200);
    expect((await systemDb.store.findUniqueOrThrow({ where: { shopDomain: SHOP } })).workspaceId).toBe(res.json().workspaceId);
  });

  it("cancel and logout forget the signup in this browser", async () => {
    fakeShopify();
    const b = testBrowser(ctx);
    await connectViaShopify(b, "merchant@x.com");
    const first = b.jar.get("shopify_signup")!;
    const cancel = await b.post("/auth/shopify/cancel");
    expect(cancel.statusCode).toBe(200);
    expect(b.jar.get("shopify_signup")).toBeUndefined();
    expect(await ctx.deps.coord.take(`signup:${first}`)).toBeNull();
    expect((await b.post("/auth/shopify/finish", {})).json().error).toBe("signup_expired");

    const b2 = testBrowser(ctx);
    await connectViaShopify(b2, "merchant@x.com");
    const nonce = b2.jar.get("shopify_signup")!;
    await b2.signIn("someone", "someone@x.com");
    expect((await b2.post("/auth/logout")).statusCode).toBe(200);
    expect(b2.jar.get("shopify_signup")).toBeUndefined();
    expect(await ctx.deps.coord.take(`signup:${nonce}`)).toBeNull();
  });

  it("validates start and only accepts it from the web app", async () => {
    const b = testBrowser(ctx);
    expect((await b.post("/auth/shopify/start", { email: "nope" })).statusCode).toBe(400);
    const badShop = await b.post("/auth/shopify/start", { email: "m@x.com", shop: "evil.com" });
    expect(badShop.statusCode).toBe(400);
    expect(badShop.json().error).toBe("invalid_shop");
    // An empty store field means "no store address".
    expect((await b.post("/auth/shopify/start", { email: "m@x.com", shop: "" })).json().url).toMatch(/^https:\/\/admin\.shopify\.com\//);

    const crossSite = await ctx.app.inject({
      method: "POST",
      url: "/auth/shopify/start",
      headers: { origin: "https://evil.example" },
      payload: { email: "m@x.com" },
    });
    expect(crossSite.statusCode).toBe(403);
  });

  it("rate limits start per IP", async () => {
    const b = testBrowser(ctx);
    for (let i = 0; i < 20; i++) expect((await b.post("/auth/shopify/start", { email: `m${i}@x.com` })).statusCode).toBe(200);
    expect((await b.post("/auth/shopify/start", { email: "m@x.com" })).statusCode).toBe(429);
  });
});

describe("Continue with Shopify: claim", () => {
  it("a different signed-in user in the same browser is refused, and the signup stays claimable", async () => {
    fakeShopify();
    const b = testBrowser(ctx);
    await connectViaShopify(b, "merchant@x.com");
    expect((await b.post("/auth/shopify/finish", {})).json().status).toBe("signed_in");

    await b.signIn("someone-else", "other@x.com");
    const res = await claim(b);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("email_mismatch");
    expect(await systemDb.store.count()).toBe(0);

    await b.signIn("otp-merchant@x.com", "merchant@x.com");
    expect((await claim(b)).statusCode).toBe(200);
  });

  it("refuses a store connected to someone else's workspace (409)", async () => {
    const { headers } = await signIn(ctx, "rival", "rival@x.com");
    const rivalWs = (await ctx.app.inject({ method: "POST", url: "/workspaces", headers, payload: { name: "Rival" } })).json().workspace.id;
    const rivalStore = await createStore(rivalWs, SHOP, ["read_orders"]);

    fakeShopify();
    const b = testBrowser(ctx);
    await connectViaShopify(b, "merchant@x.com");
    await b.post("/auth/shopify/finish", {});
    await b.signIn("otp-merchant@x.com", "merchant@x.com");
    const res = await claim(b);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: "store_taken",
      message: "This store is already connected to another Insights account. Ask its owner to invite you.",
    });
    const store = await systemDb.store.findUniqueOrThrow({ where: { shopDomain: SHOP } });
    expect(store.workspaceId).toBe(rivalWs);
    expect(store.accessTokenEnc).toBe(rivalStore.accessTokenEnc);
    expect(await systemDb.workspace.count()).toBe(1);
    expect((await systemDb.user.findUniqueOrThrow({ where: { email: "merchant@x.com" } })).displayName).toBeNull();
  });

  it("revives a store that was uninstalled from another workspace", async () => {
    const { headers } = await signIn(ctx, "former", "former@x.com");
    const oldWs = (await ctx.app.inject({ method: "POST", url: "/workspaces", headers, payload: { name: "Old" } })).json().workspace.id;
    const old = await createStore(oldWs, SHOP, [], { status: "uninstalled", uninstalledAt: new Date() });

    fakeShopify();
    const b = testBrowser(ctx);
    await connectViaShopify(b, "merchant@x.com");
    await b.post("/auth/shopify/finish", {});
    await b.signIn("otp-merchant@x.com", "merchant@x.com");
    const res = await claim(b);
    expect(res.statusCode).toBe(200);
    expect(res.json().storeId).toBe(old.id);
    const store = await systemDb.store.findUniqueOrThrow({ where: { id: old.id } });
    expect(store.workspaceId).toBe(res.json().workspaceId);
    expect(store.workspaceId).not.toBe(oldWs);
    expect(store.status).toBe("syncing");
    expect(store.uninstalledAt).toBeNull();
  });

  /** A merchant who already has an account and this store in their workspace. */
  async function returningMerchant(storeExtra: Record<string, unknown> = {}, role: "owner" | "analyst" = "owner") {
    const owner = await signIn(ctx, "otp-merchant@x.com", "merchant@x.com");
    const ws = (await ctx.app.inject({ method: "POST", url: "/workspaces", headers: owner.headers, payload: { name: "Mine" } })).json().workspace.id;
    let store = await createStore(ws, SHOP, ["read_orders"], storeExtra);
    store = await systemDb.store.update({
      where: { id: store.id },
      data: encryptTokenFields(store.id, {
        accessToken: "shpat_OLD",
        refreshToken: "shprt_OLD",
        scopes: ["read_orders"],
        accessTokenExpiresAt: new Date(Date.now() + 3600_000),
        refreshTokenExpiresAt: null,
      }),
    });
    if (role !== "owner") {
      // The signing-in merchant is only an analyst there; someone else owns it.
      await systemDb.membership.updateMany({ where: { workspaceId: ws }, data: { role } });
    }
    ctx.deps.queues.clear();
    return { ws, store };
  }

  async function signUpAgain() {
    fakeShopify({ accessToken: "shpat_NEW" });
    const b = testBrowser(ctx);
    await connectViaShopify(b, "merchant@x.com");
    expect((await b.post("/auth/shopify/finish", {})).json().status).toBe("signed_in");
    await b.signIn("otp-merchant@x.com", "merchant@x.com");
    return claim(b);
  }

  it("a returning manager re-authorizes: same workspace, fresh tokens, straight to the dashboard", async () => {
    const { ws, store } = await returningMerchant();
    const res = await signUpAgain();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ next: "/dashboard", workspaceId: ws, storeId: store.id });
    expect(await systemDb.workspace.count()).toBe(1);
    const after = await systemDb.store.findUniqueOrThrow({ where: { id: store.id } });
    expect(after.status).toBe("active");
    expect(after.grantedScopes).toEqual(["read_orders", "read_products"]);
    expect(await getAccessToken(after, ctx.deps.coord)).toBe("shpat_NEW");
    expect(ctx.deps.queues.sent.sync).toHaveLength(0);
  });

  it("re-authorizing a store in error starts a fresh import", async () => {
    const { store } = await returningMerchant({ status: "error" });
    const res = await signUpAgain();
    expect(res.json().next).toBe(`/onboarding?step=sync&store=${store.id}`);
    expect((await systemDb.store.findUniqueOrThrow({ where: { id: store.id } })).status).toBe("syncing");
    expect(ctx.deps.queues.sent.sync.map((j) => j.kind).sort()).toEqual(["products", "shop", "variants"]);
  });

  it("re-authorizing a store whose import died starts a fresh one, though its dead rows remain", async () => {
    const { ws, store } = await returningMerchant({ status: "syncing" });
    const ago = (min: number) => new Date(Date.now() - min * 60_000);
    // What a chain that died mid-outage leaves: a row a retry rewrote to "queued", and one still
    // "running" that has not moved in hours. Counting them read as an import in progress.
    await systemDb.syncJob.create({ data: { workspaceId: ws, storeId: store.id, kind: "orders", status: "queued", createdAt: ago(300), startedAt: ago(290) } });
    await systemDb.syncJob.create({ data: { workspaceId: ws, storeId: store.id, kind: "products", status: "running", createdAt: ago(300), startedAt: ago(290), lastActivityAt: ago(120) } });

    const res = await signUpAgain();
    expect(res.json().next).toBe(`/onboarding?step=sync&store=${store.id}`);
    const sent = ctx.deps.queues.sent.sync;
    expect(sent.map((j) => j.kind).sort()).toEqual(["products", "shop", "variants"]);
    // The shop job starts the new orders job, not the dead one.
    const orders = await systemDb.syncJob.findFirstOrThrow({ where: { storeId: store.id, kind: "orders", status: "queued", startedAt: null } });
    expect(sent.find((j) => j.kind === "shop")?.waitingJobIds).toEqual([orders.id]);
  });

  it("re-authorizing a store mid-import leaves the import running", async () => {
    const { ws, store } = await returningMerchant({ status: "syncing" });
    await systemDb.syncJob.create({
      data: { workspaceId: ws, storeId: store.id, kind: "orders", status: "running", createdAt: new Date(Date.now() - 50 * 60_000), startedAt: new Date(Date.now() - 50 * 60_000), lastActivityAt: new Date() },
    });
    const res = await signUpAgain();
    expect(res.json().next).toBe("/dashboard");
    expect(ctx.deps.queues.sent.sync).toHaveLength(0);
  });

  /**
   * A reinstall after `app/uninstalled` must come back into the store's own workspace and keep its
   * history. `connectStore` treats an uninstalled row as unconnected (so a shop its previous owner
   * abandoned can be claimed), which also hides it from `signupWorkspace` — and that only ever
   * returns a workspace the user owns *alone*. Both cases below therefore used to land in a brand-new
   * workspace, which `attachStore` reads as a move and purges the store's orders and metrics; with no
   * `read_all_orders` only the last BACKFILL_DAYS could ever be re-imported.
   */
  async function uninstalledWithHistory(role: "owner" | "admin", colleagues: number) {
    const { ws, store } = await returningMerchant({ status: "uninstalled", uninstalledAt: new Date() });
    if (role === "admin") await systemDb.membership.updateMany({ where: { workspaceId: ws }, data: { role: "admin" } });
    for (let i = 0; i < colleagues; i++) {
      const mate = await signIn(ctx, `mate${i}`, `mate${i}@x.com`);
      await systemDb.membership.create({ data: { workspaceId: ws, userId: mate.user.id, role: "analyst" } });
    }
    await systemDb.order.create({
      data: {
        workspaceId: ws,
        storeId: store.id,
        shopifyId: "900001",
        name: "#1001",
        currency: "AUD",
        localDay: "2026-01-15",
        shopifyCreatedAt: new Date("2026-01-15T02:00:00Z"),
        shopifyUpdatedAt: new Date("2026-01-15T02:00:00Z"),
        subtotal: "100.00",
        totalDiscounts: "0.00",
        totalTax: "10.00",
        totalShipping: "5.00",
        totalPrice: "115.00",
      },
    });
    return { ws, store };
  }

  it("a reinstall keeps the store in its own workspace and keeps its history (workspace has other members)", async () => {
    const { ws, store } = await uninstalledWithHistory("owner", 1);

    const res = await signUpAgain();

    expect(res.statusCode).toBe(200);
    expect(res.json().storeId).toBe(store.id);
    expect(res.json().workspaceId).toBe(ws);
    const after = await systemDb.store.findUniqueOrThrow({ where: { id: store.id } });
    expect(after.workspaceId).toBe(ws);
    expect(after.status).toBe("syncing");
    expect(after.uninstalledAt).toBeNull();
    // The decisive assertions: no new workspace, and the history survived (no purge).
    expect(await systemDb.workspace.count()).toBe(1);
    expect(await systemDb.order.count({ where: { storeId: store.id } })).toBe(1);
    expect(await getAccessToken(after, ctx.deps.coord)).toBe("shpat_NEW");
  });

  it("a reinstall by an admin (not the owner) keeps the store in its own workspace and keeps its history", async () => {
    const { ws, store } = await uninstalledWithHistory("admin", 0);

    const res = await signUpAgain();

    expect(res.json().workspaceId).toBe(ws);
    expect((await systemDb.store.findUniqueOrThrow({ where: { id: store.id } })).workspaceId).toBe(ws);
    expect(await systemDb.workspace.count()).toBe(1);
    expect(await systemDb.order.count({ where: { storeId: store.id } })).toBe(1);
  });

  it("a member who can't manage stores is signed in without touching the store's tokens", async () => {
    const { ws, store } = await returningMerchant({}, "analyst");
    const res = await signUpAgain();
    expect(res.json()).toEqual({ next: "/dashboard", workspaceId: ws, storeId: store.id });
    const after = await systemDb.store.findUniqueOrThrow({ where: { id: store.id } });
    expect(after.accessTokenEnc).toBe(store.accessTokenEnc);
    expect(await getAccessToken(after, ctx.deps.coord)).toBe("shpat_OLD");
  });

  it("never connects into a workspace other people belong to: a new workspace is created instead", async () => {
    // The account may have been set up (and others invited) before its email was proven.
    const owner = await signIn(ctx, "otp-merchant@x.com", "merchant@x.com");
    const shared = (await ctx.app.inject({ method: "POST", url: "/workspaces", headers: owner.headers, payload: { name: "Shared" } })).json().workspace.id;
    const other = await signIn(ctx, "intruder", "intruder@x.com");
    await systemDb.membership.create({ data: { workspaceId: shared, userId: other.user.id, role: "admin" } });

    const res = await signUpAgain();
    expect(res.statusCode).toBe(200);
    expect(res.json().workspaceId).not.toBe(shared);
    const ws = await systemDb.workspace.findUniqueOrThrow({ where: { id: res.json().workspaceId }, include: { memberships: true } });
    expect(ws.name).toBe("Demo Shop");
    expect(ws.memberships.map((m) => m.userId)).toEqual([owner.user.id]);
  });

  it("reviving a store from another workspace drops its old data so the new workspace starts clean", async () => {
    const { headers } = await signIn(ctx, "former", "former@x.com");
    const oldWs = (await ctx.app.inject({ method: "POST", url: "/workspaces", headers, payload: { name: "Old" } })).json().workspace.id;
    const old = await createStore(oldWs, SHOP, [], { status: "uninstalled", uninstalledAt: new Date(), lastSyncedAt: new Date(), pixelInstalled: true });
    const base = { workspaceId: oldWs, storeId: old.id };
    await systemDb.product.create({ data: { ...base, shopifyId: "1", title: "Old tee", shopifyUpdatedAt: new Date() } });
    await systemDb.productVariant.create({ data: { ...base, productShopifyId: "1", shopifyId: "11", title: "M", price: 10, shopifyUpdatedAt: new Date() } });
    await systemDb.syncJob.create({ data: { ...base, kind: "orders", status: "succeeded" } });

    const res = await signUpAgain();
    expect(res.statusCode).toBe(200);
    expect(res.json().storeId).toBe(old.id);
    expect(await systemDb.product.count({ where: { storeId: old.id } })).toBe(0);
    expect(await systemDb.productVariant.count({ where: { storeId: old.id } })).toBe(0);
    const jobs = await systemDb.syncJob.findMany({ where: { storeId: old.id } });
    expect(jobs.every((j) => j.workspaceId === res.json().workspaceId && j.status === "queued")).toBe(true);
    const store = await systemDb.store.findUniqueOrThrow({ where: { id: old.id } });
    expect(store.lastSyncedAt).toBeNull();
    expect(store.pixelInstalled).toBe(false);
  });

  it("a crash while connecting keeps the signup so 'Try again' can finish it", async () => {
    fakeShopify();
    const b = testBrowser(ctx);
    await connectViaShopify(b, "merchant@x.com");
    expect((await b.post("/auth/shopify/finish", {})).json().status).toBe("signed_in");
    await b.signIn("otp-merchant@x.com", "merchant@x.com");

    const send = ctx.deps.queues.sync.send;
    ctx.deps.queues.sync.send = async () => {
      throw new Error("queue unavailable");
    };
    try {
      const res = await claim(b);
      expect(res.statusCode).toBe(500);
    } finally {
      ctx.deps.queues.sync.send = send;
    }
    expect(b.jar.get("shopify_signup")).toBeTruthy();
    expect((await systemDb.store.findUniqueOrThrow({ where: { shopDomain: SHOP } })).status).toBe("error");

    const retry = await claim(b);
    expect(retry.statusCode).toBe(200);
    expect(retry.json().next).toMatch(/^\/onboarding\?step=sync&store=/);
    expect((await systemDb.store.findUniqueOrThrow({ where: { shopDomain: SHOP } })).status).toBe("syncing");
    expect(ctx.deps.queues.sent.sync.map((j) => j.kind).sort()).toEqual(["products", "shop", "variants"]);
    expect(b.jar.get("shopify_signup")).toBeUndefined();
  });

  it("connects into the user's existing workspace when they have one but not this store", async () => {
    const owner = await signIn(ctx, "otp-merchant@x.com", "merchant@x.com");
    const ws = (await ctx.app.inject({ method: "POST", url: "/workspaces", headers: owner.headers, payload: { name: "Mine" } })).json().workspace.id;
    const res = await signUpAgain();
    expect(res.statusCode).toBe(200);
    expect(res.json().workspaceId).toBe(ws);
    expect(await systemDb.workspace.count()).toBe(1);
  });
});

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { encryptTokenFields, resetEnvCache, type FetchLike } from "@app/core";
import { systemDb } from "@app/db";
import { buildApp } from "../src/app.js";
import { firebaseAuthProvider, isLocalUrl } from "../src/authProvider.js";
import { clean, createStore, createWorkspace, ORIGIN, setup, signIn, teardown, type TestCtx } from "./helpers.js";

/**
 * Regressions found by the full test pass (2026-10-06). Each case failed before its fix.
 */

let ctx: TestCtx;
beforeAll(async () => (ctx = await setup()));
afterAll(async () => teardown(ctx));
beforeEach(async () => clean(ctx));

describe("global per-IP limit", () => {
  /** The app with a limiter that has already run out for everyone. */
  const exhausted = () => buildApp({ ...ctx.deps, globalLimit: async () => false });

  it("does not throttle Shopify webhooks or the pixel, which have their own checks", async () => {
    const app = exhausted();
    // Shopify sends every store's webhooks from a few addresses: a 429 here would push all of
    // them into Shopify's retry-then-disable path. An unsigned delivery gets its 401, not a 429.
    const hook = await app.request("/webhooks/shopify", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    expect(hook.status).toBe(401);
    const pixel = await app.request("/pixel/no-such-key", { method: "POST", body: JSON.stringify({ events: [] }) });
    expect(pixel.status).not.toBe(429);
    expect((await app.request("/healthz")).status).toBe(200);
  });

  it("still throttles everything else", async () => {
    expect((await exhausted().request("/me")).status).toBe(429);
  });
});

describe("sign-in requests must come from the app (login CSRF)", () => {
  it("refuses a cross-site POST to /auth/session even without a session cookie", async () => {
    // A text/plain form from another site parses as JSON too, so without this an attacker could
    // sign a visitor's browser in to the attacker's account.
    const crossSite: Array<Record<string, string>> = [{}, { origin: "https://evil.example" }, { referer: "https://evil.example/page" }];
    for (const headers of crossSite) {
      const res = await ctx.app.inject({ method: "POST", url: "/auth/session", headers: { "content-type": "text/plain", ...headers }, payload: JSON.stringify({ idToken: "idt|attacker|evil@x.com|1" }) });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("csrf");
    }
    expect(await systemDb.user.count()).toBe(0);
  });

  it("refuses cross-site code and link sign-ins, and accepts them from the app", async () => {
    const calls = [
      { url: "/auth/otp/request", payload: { email: "a@x.com" } },
      { url: "/auth/otp/verify", payload: { email: "a@x.com", code: "123456" } },
      { url: "/auth/email-link/verify", payload: { email: "a@x.com", oobCode: "link-a@x.com" } },
    ];
    for (const { url, payload } of calls) {
      const res = await ctx.app.inject({ method: "POST", url, headers: { origin: "https://evil.example" }, payload });
      expect(res.statusCode, url).toBe(403);
    }
    expect(ctx.mailer.sent).toHaveLength(0);
    const ok = await ctx.app.inject({ method: "POST", url: "/auth/otp/request", headers: ORIGIN, payload: { email: "a@x.com" } });
    expect(ok.statusCode).toBe(200);
    expect(ctx.mailer.sent).toHaveLength(1);
  });
});

describe("a Firebase account re-created for an existing email", () => {
  const session = (uid: string, email: string, verified: boolean) =>
    ctx.app.inject({ method: "POST", url: "/auth/session", headers: ORIGIN, payload: { idToken: `idt|${uid}|${email}|${verified ? 1 : 0}` } });

  it("signs in to the same user when Firebase has verified the address", async () => {
    const { user, headers } = await signIn(ctx, "old-uid", "owner@x.com");
    const ws = await createWorkspace(ctx, headers);
    // Deleted and re-created in Firebase (or an emulator restart): same email, new uid. This was a
    // unique-constraint 500 on every sign-in.
    const res = await session("new-uid", "Owner@X.com", true);
    expect(res.statusCode).toBe(200);
    expect(res.json().user.id).toBe(user.id);
    const after = await systemDb.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.firebaseUid).toBe("new-uid");
    expect(await systemDb.user.count()).toBe(1);
    // Still the owner of everything they had.
    const me = await ctx.app.inject({ method: "GET", url: "/me", headers: { cookie: "__session=sess|new-uid|owner@x.com|1" } });
    expect(me.json().workspaces.map((w: { id: string }) => w.id)).toEqual([ws]);
  });

  it("does not hand the account to an unverified newcomer", async () => {
    const { user } = await signIn(ctx, "old-uid", "owner@x.com");
    const res = await session("squatter", "owner@x.com", false);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("email_in_use");
    expect((await systemDb.user.findUniqueOrThrow({ where: { id: user.id } })).firebaseUid).toBe("old-uid");
  });
});

describe("Firebase Auth emulator setting", () => {
  afterEach(() => {
    delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
    process.env.APP_URL = "http://localhost:3001";
    resetEnvCache();
  });

  it("recognises local app URLs only", () => {
    for (const url of ["http://localhost:3001", "http://127.0.0.1:8789", "http://[::1]:8787", "http://app.localhost", "http://insights.test"]) expect(isLocalUrl(url), url).toBe(true);
    for (const url of ["https://insights.imeseban.workers.dev", "https://localhost.evil.com", "not a url"]) expect(isLocalUrl(url), url).toBe(false);
  });

  it("refuses to run against the emulator on a deployed app URL", () => {
    // The emulator accepts unsigned tokens: carried to production, it would be an auth bypass.
    process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099";
    process.env.APP_URL = "https://insights.imeseban.workers.dev";
    resetEnvCache();
    expect(() => firebaseAuthProvider()).toThrow(/must never be configured on a deployed app/);
    process.env.APP_URL = "http://localhost:8787";
    resetEnvCache();
    expect(() => firebaseAuthProvider()).not.toThrow();
  });
});

describe("pixel timestamps", () => {
  it("drops events dated in the future", async () => {
    const u = await signIn(ctx, "u1", "a@x.com");
    const store = await createStore(await createWorkspace(ctx, u.headers), "p.myshopify.com", ["read_orders"]);
    const event = (id: string, at: Date) => ({ id, name: "page_viewed", clientId: "c1", timestamp: at.toISOString(), path: "/" });
    const post = (events: unknown[]) =>
      ctx.app.inject({ method: "POST", url: `/pixel/${store.pixelIngestKey}`, headers: { "content-type": "text/plain" }, payload: JSON.stringify({ events }) });

    const future = new Date(Date.now() + 3 * 86400_000);
    expect((await post([event("f1", future)])).json()).toEqual({ ok: true, accepted: 0 });
    // Mixed batch: the honest event still counts.
    expect((await post([event("f2", future), event("n1", new Date())])).json().accepted).toBe(1);
    expect(await systemDb.funnelVisit.count({ where: { storeId: store.id, day: future.toISOString().slice(0, 10) } })).toBe(0);
  });
});

describe("billing", () => {
  const gql = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
  const subscribeOk: FetchLike = async () =>
    gql({ appSubscriptionCreate: { confirmationUrl: "https://admin.shopify.com/charges/confirm", userErrors: [], appSubscription: { id: "gid://shopify/AppSubscription/1" } } });

  it("keeps the plan in force until Shopify approves the change", async () => {
    const u = await signIn(ctx, "u1", "a@x.com");
    const ws = await createWorkspace(ctx, u.headers);
    const store = await createStore(ws, "b.myshopify.com", ["read_orders"]);
    await systemDb.store.update({
      where: { id: store.id },
      data: encryptTokenFields(store.id, { accessToken: "shpat_x", scopes: ["read_orders"], accessTokenExpiresAt: null, refreshToken: null, refreshTokenExpiresAt: null }),
    });
    ctx.setFetch(subscribeOk);

    const res = await ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/billing/subscribe`, headers: u.headers, payload: { plan: "growth", storeId: store.id } });
    expect(res.statusCode).toBe(200);
    expect(res.json().confirmationUrl).toMatch(/^https:\/\/admin\.shopify\.com\//);

    // Sent to Shopify is not approved: an abandoned or declined approval must not read as Growth.
    const billing = await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/billing`, headers: u.headers });
    expect(billing.json().subscription).toEqual({ plan: "free", status: "active", pendingPlan: "growth" });
    expect(await systemDb.subscription.findUniqueOrThrow({ where: { workspaceId: ws } })).toMatchObject({ pendingChargeId: "gid://shopify/AppSubscription/1", shopifyChargeId: null });
  });
});

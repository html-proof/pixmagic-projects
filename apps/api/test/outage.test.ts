import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { systemDb, withDb } from "@app/db";
import { signShopifyQuery } from "@app/shared";
import { clean, createWorkspace, ORIGIN, setup, signIn, teardown, testBrowser, type TestCtx } from "./helpers.js";
import { FirebaseUnavailableError } from "../src/authProvider.js";

/**
 * The production database sits behind a tunnel that drops for seconds to minutes at a time. A
 * signed-in merchant must come out of that still signed in, with a page that says "try again"
 * rather than a sign-in form, the sign-up flow or raw JSON.
 */

let ctx: TestCtx;
beforeAll(async () => (ctx = await setup()));
afterAll(async () => teardown(ctx));
beforeEach(async () => clean(ctx));

const SECRET = "test_secret";
const SHOP = "demo-shop.myshopify.com";
const APP = "http://localhost:3001";
const now = () => String(Math.floor(Date.now() / 1000));
const RETRY_ONBOARDING = `${APP}/onboarding?shop=${SHOP}&error=temporarily_unavailable`;

/** Run `fn` with the database unreachable (nothing listens on port 1), as while the tunnel is down. */
const dbDown = <T>(fn: () => Promise<T>) => withDb({ system: "postgresql://app:app@127.0.0.1:1/outage_test" }, fn);

/** Make one query fail the way a dropped tunnel does, while everything before it worked. */
async function dropping<T>(delegate: object, method: string, fn: () => Promise<T>): Promise<T> {
  const d = delegate as Record<string, unknown>;
  const original = d[method];
  d[method] = async () => {
    throw new Error("Connection terminated unexpectedly");
  };
  try {
    return await fn();
  } finally {
    d[method] = original;
  }
}

function launchUrl() {
  const params = { shop: SHOP, host: "aG9zdA", timestamp: now() };
  return `/shopify/launch?${new URLSearchParams({ ...params, hmac: signShopifyQuery(params, SECRET) })}`;
}

function callbackUrl(state: string, code = "authcode") {
  const params = { code, shop: SHOP, state, timestamp: now() };
  return `/shopify/callback?${new URLSearchParams({ ...params, hmac: signShopifyQuery(params, SECRET) })}`;
}

/** Fake Shopify token endpoint; returns the list of codes exchanged. */
function tokenFetch() {
  const exchanged: string[] = [];
  ctx.setFetch(async (_input, init) => {
    exchanged.push(JSON.parse(String(init?.body)).code);
    return new Response(JSON.stringify({ access_token: "shpat_x", scope: "read_orders" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return exchanged;
}

/** The last value a response set for cookie `name` (a deletion followed by a set counts as set). */
const lastCookie = (setCookie: string | undefined, name: string) =>
  [...(setCookie ?? "").matchAll(new RegExp(`(?:^|, )${name}=([^;]*)`, "g"))].at(-1)?.[1];

describe("while the database is unreachable", () => {
  it("/me says so (503) instead of signing the user out (401)", async () => {
    const { cookie } = await signIn(ctx, "u1", "a@x.com");
    const me = await dbDown(() => ctx.app.inject({ method: "GET", url: "/me", headers: { cookie } }));
    expect(me.statusCode).toBe(503);
    expect(me.json().error).toBe("db_unavailable");

    // Without a session, or with a forged one, it is still a plain 401: neither needs the database.
    expect((await dbDown(() => ctx.app.inject({ method: "GET", url: "/me" }))).statusCode).toBe(401);
    const forged = await dbDown(() => ctx.app.inject({ method: "GET", url: "/me", headers: { cookie: "__session=garbage" } }));
    expect(forged.statusCode).toBe(401);
  });

  it("/auth/whoami says so too, so the homepage never takes a merchant for a visitor", async () => {
    const { cookie } = await signIn(ctx, "u1", "a@x.com");
    const who = await dbDown(() => ctx.app.inject({ method: "GET", url: "/auth/whoami", headers: { cookie } }));
    expect(who.statusCode).toBe(503);
    expect((await dbDown(() => ctx.app.inject({ method: "GET", url: "/auth/whoami" }))).json()).toEqual({ user: null, workspaces: [] });
  });

  it("sign-out still clears the session cookie", async () => {
    const { headers } = await signIn(ctx, "u1", "a@x.com");
    const res = await dbDown(() => ctx.app.inject({ method: "POST", url: "/auth/logout", headers }));
    expect(res.statusCode).toBe(200);
    expect(res.headers["set-cookie"]).toMatch(/__session=;.*Max-Age=0/);
  });

  it("a fresh sign-in says 'try again' (503) instead of a bare 500, and signs in once the database is back", async () => {
    // Production hit exactly this: Docker on the database host stopped, and every sign-in was a 500.
    const session = () => ctx.app.inject({ method: "POST", url: "/auth/session", headers: ORIGIN, payload: { idToken: "idt|u1|a@x.com|1" } });
    const during = await dbDown(session);
    expect(during.statusCode).toBe(503);
    expect(during.json().error).toBe("db_unavailable");
    expect(during.headers["set-cookie"]).toBeUndefined();

    const after = await session();
    expect(after.statusCode).toBe(200);
    expect(after.json().user.email).toBe("a@x.com");
  });

  it("asking for a sign-in code says 'try again' (503) instead of a bare 500, and sends nothing", async () => {
    // Production hit this on /start's "Confirm your email" panel during a tunnel drop.
    const request = () =>
      ctx.app.inject({ method: "POST", url: "/auth/otp/request", headers: ORIGIN, payload: { email: "a@x.com" } });
    const before = ctx.mailer.sent.length;
    const during = await dbDown(request);
    expect(during.statusCode).toBe(503);
    expect(during.json().error).toBe("db_unavailable");
    expect(ctx.mailer.sent).toHaveLength(before);

    expect((await request()).statusCode).toBe(200);
    expect(ctx.mailer.sent).toHaveLength(before + 1);
  });

  it("checking a sign-in code says 'try again' (503) and leaves the code usable", async () => {
    await ctx.app.inject({ method: "POST", url: "/auth/otp/request", headers: ORIGIN, payload: { email: "a@x.com" } });
    const code = /(\d{6})/.exec(ctx.mailer.sent.at(-1)!.subject)![1]!;
    const verify = () => ctx.app.inject({ method: "POST", url: "/auth/otp/verify", headers: ORIGIN, payload: { email: "a@x.com", code } });
    const during = await dbDown(verify);
    expect(during.statusCode).toBe(503);
    expect(during.json().error).toBe("db_unavailable");

    expect((await verify()).statusCode).toBe(200);
  });

  it("a fresh sign-in says 'try again' when Firebase can't mint the session cookie", async () => {
    const create = ctx.auth.createSessionCookie;
    ctx.auth.createSessionCookie = async () => {
      throw new FirebaseUnavailableError("Identity Toolkit :createSessionCookie unreachable: fetch failed");
    };
    try {
      const res = await ctx.app.inject({ method: "POST", url: "/auth/session", headers: ORIGIN, payload: { idToken: "idt|u1|a@x.com|1" } });
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe("auth_unavailable");
    } finally {
      ctx.auth.createSessionCookie = create;
    }
  });

  it("a sign-in too old for a session says 'try again', not 'sign in again', until the database is back", async () => {
    // "Continue with Shopify" signed in to Firebase, then /auth/session failed for over 5 minutes.
    // "Sign in again" would send the merchant to prove their email by code, which can't be
    // issued during the outage either (and each failed request spends their code budget).
    const verify = ctx.auth.verifyIdToken;
    ctx.auth.verifyIdToken = async (t) => ({ ...(await verify(t)), authTime: Math.floor(Date.now() / 1000) - 6 * 60 });
    const session = () => ctx.app.inject({ method: "POST", url: "/auth/session", headers: ORIGIN, payload: { idToken: "idt|u1|a@x.com|1" } });
    try {
      const during = await dbDown(session);
      expect(during.statusCode).toBe(503);
      expect(during.json().error).toBe("db_unavailable");

      const after = await session();
      expect(after.statusCode).toBe(401);
      expect(after.json().error).toBe("stale_sign_in");
    } finally {
      ctx.auth.verifyIdToken = verify;
    }
  });

  it("launch from the Shopify admin sends a signed-in merchant to a retry page, not into sign-up", async () => {
    const { headers, cookie } = await signIn(ctx, "owner", "owner@x.com");
    await createWorkspace(ctx, headers);
    const res = await dbDown(() => ctx.app.inject({ method: "GET", url: launchUrl(), headers: { cookie } }));
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(RETRY_ONBOARDING);
  });

  it("launch treats Firebase being unreachable the same way", async () => {
    const { cookie } = await signIn(ctx, "owner", "owner@x.com");
    const verify = ctx.auth.verifySessionCookie;
    ctx.auth.verifySessionCookie = async () => {
      throw new FirebaseUnavailableError("Could not fetch Google's token signing keys: fetch failed");
    };
    try {
      const res = await ctx.app.inject({ method: "GET", url: launchUrl(), headers: { cookie } });
      expect(res.headers.location).toBe(RETRY_ONBOARDING);
    } finally {
      ctx.auth.verifySessionCookie = verify;
    }
  });

  it("the connect callback keeps its OAuth state, so the same approval completes once the database is back", async () => {
    const { headers, cookie } = await signIn(ctx, "owner", "owner@x.com");
    const ws = await createWorkspace(ctx, headers);
    const install = await ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/shopify/install`, headers, payload: { shop: SHOP } });
    const state = new URL(install.json().url).searchParams.get("state")!;
    const exchanged = tokenFetch();
    const browser = { cookie: `${cookie}; shopify_oauth_state=${state}` };

    const during = await dbDown(() => ctx.app.inject({ method: "GET", url: callbackUrl(state), headers: browser }));
    expect(during.statusCode).toBe(302);
    // Not "You were signed out during the connection".
    expect(during.headers.location).toBe(`${APP}/onboarding?error=temporarily_unavailable&shop=${SHOP}`);
    expect(lastCookie(during.headers["set-cookie"], "shopify_oauth_state")).toBe(state);
    expect(exchanged).toEqual([]);

    const after = await ctx.app.inject({ method: "GET", url: callbackUrl(state, "authcode2"), headers: browser });
    expect(after.headers.location).toMatch(/\/onboarding\?step=sync&store=/);
    expect(exchanged).toEqual(["authcode2"]);
    expect((await systemDb.store.findUniqueOrThrow({ where: { shopDomain: SHOP } })).workspaceId).toBe(ws);
  });
});

describe("when the database drops part-way through a browser navigation", () => {
  it("launch lands on a retry page and keeps the one-click choice for the next launch", async () => {
    const b = testBrowser(ctx);
    await b.signIn("owner", "owner@x.com");
    const ws = (await b.post("/workspaces", { name: "Acme" })).json().workspace.id as string;
    expect((await b.post(`/workspaces/${ws}/shopify/start`)).statusCode).toBe(200);
    const pending = b.jar.get("shopify_pending")!;

    const failed = await dropping(systemDb.membership, "findUnique", () => b.get(launchUrl()));
    expect(failed.statusCode).toBe(302);
    expect(failed.headers.location).toBe(RETRY_ONBOARDING);
    expect(b.jar.get("shopify_pending")).toBe(pending);

    // Relaunching once the database is back still connects into the workspace /start remembered.
    const relaunch = await b.get(launchUrl());
    const authorize = new URL(relaunch.headers.location!);
    expect(authorize.pathname).toBe("/admin/oauth/authorize");
    const state = JSON.parse((await ctx.deps.coord.take(`oauth:state:${authorize.searchParams.get("state")}`))!);
    expect(state).toMatchObject({ workspaceId: ws, shop: SHOP });
  });

  it("the connect callback lands on a retry page, and connecting again finishes the job", async () => {
    const { headers, cookie } = await signIn(ctx, "owner", "owner@x.com");
    const ws = await createWorkspace(ctx, headers);
    const connect = async (code: string) => {
      const install = await ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/shopify/install`, headers, payload: { shop: SHOP } });
      const state = new URL(install.json().url).searchParams.get("state")!;
      return ctx.app.inject({ method: "GET", url: callbackUrl(state, code), headers: { cookie: `${cookie}; shopify_oauth_state=${state}` } });
    };
    tokenFetch();

    // The code is exchanged, then the connect dies half-way (here: queueing the first import).
    const send = ctx.deps.queues.sync.send;
    ctx.deps.queues.sync.send = async () => {
      throw new Error("queue unavailable");
    };
    let failed;
    try {
      failed = await connect("authcode");
    } finally {
      ctx.deps.queues.sync.send = send;
    }
    expect(failed.statusCode).toBe(302);
    expect(failed.headers.location).toBe(`${APP}/onboarding?error=temporarily_unavailable&shop=${SHOP}`);

    const retry = await connect("authcode2");
    expect(retry.headers.location).toMatch(/\/onboarding\?step=sync&store=/);
    const store = await systemDb.store.findUniqueOrThrow({ where: { shopDomain: SHOP } });
    expect(store.status).toBe("syncing");
    expect(ctx.deps.queues.sent.sync.length).toBeGreaterThan(0);
  });
});

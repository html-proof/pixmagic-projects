import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { systemDb } from "@app/db";
import { signShopifyQuery } from "@app/shared";
import { sessionCertCache } from "../src/authProvider.js";
import { retiredSessionKey } from "../src/context.js";
import { clean, createWorkspace, ORIGIN, setup, teardown, type TestCtx } from "./helpers.js";

/**
 * Sessions that survive a refresh (2026-10-10): what used to sign a merchant out when nothing
 * they did should have, and the Shopify connect that starts and ends inside the app.
 */

let ctx: TestCtx;
beforeAll(async () => (ctx = await setup()));
afterAll(async () => teardown(ctx));
beforeEach(async () => clean(ctx));

/**
 * A browser signed in to `uid`. The fake session cookie carries `device` after its four fields,
 * so two browsers of one person hold different cookies, as they do with Firebase.
 */
async function browser(uid: string, email: string, device: string) {
  const res = await ctx.app.inject({ method: "POST", url: "/auth/session", headers: ORIGIN, payload: { idToken: `idt|${uid}|${email}|1|${device}` } });
  expect(res.statusCode).toBe(200);
  const cookie = `__session=sess|${uid}|${email}|1|${device}`;
  return { cookie, headers: { cookie, ...ORIGIN } };
}
const me = (headers: Record<string, string>) => ctx.app.inject({ method: "GET", url: "/me", headers });

describe("signing out", () => {
  it("ends this browser's session only, so the same person stays signed in elsewhere", async () => {
    const laptop = await browser("u1", "a@x.com", "laptop");
    const phone = await browser("u1", "a@x.com", "phone");

    const out = await ctx.app.inject({ method: "POST", url: "/auth/logout", headers: laptop.headers });
    expect(out.statusCode).toBe(200);
    expect(out.headers["set-cookie"]).toMatch(/__session=;.*Max-Age=0/);

    // Before: logout revoked the account's Firebase tokens, and the phone was signed out on its next refresh.
    expect((await me(phone.headers)).statusCode).toBe(200);
    // The signed-out cookie stays dead even though Firebase would still accept it (a copy replayed).
    expect((await me(laptop.headers)).statusCode).toBe(401);
  });

  it("doesn't sign anyone out when the signed-out check itself can't be made", async () => {
    const { headers } = await browser("u1", "a@x.com", "laptop");
    const peek = ctx.deps.coord.peek;
    ctx.deps.coord.peek = async () => {
      throw new Error("coordinator unreachable");
    };
    try {
      const res = await me(headers);
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe("auth_unavailable");
    } finally {
      ctx.deps.coord.peek = peek;
    }
    expect((await me(headers)).statusCode).toBe(200);
  });

  it("records nothing for a cookie that isn't a real session", async () => {
    const res = await ctx.app.inject({ method: "POST", url: "/auth/logout", headers: { cookie: "__session=forged", ...ORIGIN } });
    expect(res.statusCode).toBe(200);
    expect(await ctx.deps.coord.peek(retiredSessionKey("forged"))).toBeNull();
  });
});

describe("Google's rotating session-cookie keys", () => {
  function google(sets: Array<Record<string, string>>) {
    let clock = 1_000_000;
    let fetches = 0;
    const cache = sessionCertCache(
      async () => ({ certs: sets[Math.min(fetches++, sets.length - 1)]!, maxAgeSec: 6 * 3600 }),
      60_000,
      () => clock,
    );
    return { cache, fetches: () => fetches, tick: (ms: number) => (clock += ms) };
  }

  it("looks again for a key minted after our copy, instead of rejecting a valid session for hours", async () => {
    const g = google([{ k1: "pem1" }, { k1: "pem1", k2: "pem2" }]);
    expect(await g.cache.pem("k1")).toBe("pem1");
    g.tick(5 * 60_000); // well inside the six hours Google lets us keep the copy
    expect(await g.cache.pem("k2")).toBe("pem2");
    expect(g.fetches()).toBe(2);
  });

  it("serves known keys from the copy, and asks at most once a minute about unknown ones", async () => {
    const g = google([{ k1: "pem1" }]);
    await g.cache.pem("k1");
    await g.cache.pem("k1");
    expect(await g.cache.pem("junk")).toBeNull(); // within the cooldown: no new fetch
    expect(g.fetches()).toBe(1);
    g.tick(61_000);
    expect(await g.cache.pem("junk")).toBeNull();
    expect(await g.cache.pem("junk")).toBeNull();
    expect(g.fetches()).toBe(2);
  });
});

describe("connecting Shopify from Settings", () => {
  const SECRET = "test_secret";
  const callbackUrl = (params: Record<string, string>) => `/shopify/callback?${new URLSearchParams({ ...params, hmac: signShopifyQuery(params, SECRET) })}`;

  async function startFromSettings() {
    const { cookie, headers } = await browser("owner", "owner@x.com", "laptop");
    const ws = await createWorkspace(ctx, headers);
    const res = await ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/shopify/install`, headers, payload: { shop: "demo-shop", from: "settings" } });
    expect(res.statusCode).toBe(200);
    const url = new URL(res.json().url);
    // Shopify's own OAuth: their authorize page, our state.
    expect(url.host).toBe("demo-shop.myshopify.com");
    expect(url.pathname).toBe("/admin/oauth/authorize");
    const state = url.searchParams.get("state")!;
    return { ws, state, cookie: `${cookie}; shopify_oauth_state=${state}` };
  }

  it("comes back to Settings with the store connected", async () => {
    const { ws, state, cookie } = await startFromSettings();
    ctx.setFetch(async () => new Response(JSON.stringify({ access_token: "shpat_x", scope: "read_orders" }), { status: 200 }));
    const cb = await ctx.app.inject({
      method: "GET",
      url: callbackUrl({ code: "c", shop: "demo-shop.myshopify.com", state, timestamp: String(Math.floor(Date.now() / 1000)) }),
      headers: { cookie },
    });
    const store = await systemDb.store.findUniqueOrThrow({ where: { shopDomain: "demo-shop.myshopify.com" } });
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe(`http://localhost:3001/settings/stores?connected=${store.id}`);
    expect(store.workspaceId).toBe(ws);
    // The token is kept server-side, encrypted; the browser never sees it.
    expect(cb.body).not.toContain("shpat_x");
    expect(store.accessTokenEnc).not.toContain("shpat_x");
  });

  it("brings Shopify's errors back to Settings too", async () => {
    const { state, cookie } = await startFromSettings();
    const cb = await ctx.app.inject({
      method: "GET",
      url: callbackUrl({ code: "c", shop: "other-shop.myshopify.com", state, timestamp: String(Math.floor(Date.now() / 1000)) }),
      headers: { cookie },
    });
    expect(cb.headers.location).toBe("http://localhost:3001/settings/stores?error=shop_mismatch");
  });

  it("only goes back to places it knows, never to a URL from the request", async () => {
    const { headers } = await browser("owner", "owner@x.com", "laptop");
    const ws = await createWorkspace(ctx, headers);
    const res = await ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/shopify/install`, headers, payload: { shop: "demo-shop", from: "https://evil.example" } });
    expect(res.statusCode).toBe(400);
  });
});

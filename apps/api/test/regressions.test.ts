import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { systemDb } from "@app/db";
import { buildApp } from "../src/app.js";
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
  it("refuses every cross-site sign-in, sign-up and code request, even without a session cookie", async () => {
    // A text/plain form from another site parses as JSON too, so without this an attacker could
    // sign a visitor's browser in to the attacker's account.
    ctx.auth.addUser({ sub: "attacker", email: "evil@x.com", password: "attacker-password" });
    const calls = [
      { url: "/auth/login", payload: { email: "evil@x.com", password: "attacker-password" } },
      { url: "/auth/signup", payload: { name: "E", email: "e@x.com", password: "long-enough", confirmPassword: "long-enough", acceptTerms: true } },
      { url: "/auth/signup/confirm", payload: { email: "e@x.com", code: "123456" } },
      { url: "/auth/signup/resend", payload: { email: "e@x.com" } },
      { url: "/auth/password/forgot", payload: { email: "evil@x.com" } },
      { url: "/auth/password/reset", payload: { email: "evil@x.com", code: "123456", password: "new-password", confirmPassword: "new-password" } },
      { url: "/auth/oauth/callback", payload: { state: "s", code: "c" } },
    ];
    const crossSite: Array<Record<string, string>> = [{}, { origin: "https://evil.example" }, { referer: "https://evil.example/page" }];
    for (const { url, payload } of calls) {
      for (const headers of crossSite) {
        const res = await ctx.app.inject({ method: "POST", url, headers: { "content-type": "text/plain", ...headers }, payload: JSON.stringify(payload) });
        expect(res.statusCode, url).toBe(403);
        expect(res.json().error).toBe("csrf");
        expect(res.headers["set-cookie"]).toBeUndefined();
      }
    }
    expect(await systemDb.user.count()).toBe(0);
    expect(ctx.auth.sent).toHaveLength(0);
    const ok = await ctx.app.inject({ method: "POST", url: "/auth/login", headers: ORIGIN, payload: { email: "evil@x.com", password: "attacker-password" } });
    expect(ok.statusCode).toBe(200);
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

describe("pixel paths (2026-10-17 audit)", () => {
  it("accepts the long paths the pixel sends, instead of refusing the whole batch", async () => {
    const u = await signIn(ctx, "u1", "a@x.com");
    const store = await createStore(await createWorkspace(ctx, u.headers), "p.myshopify.com", ["read_orders"]);
    const at = new Date().toISOString();
    // The pixel sends location.pathname cut to 2048 characters; the API used to stop at 512, and the
    // pixel ignores a refused batch, so the other events in it (other shoppers) were lost too.
    const long = `/collections/${"a".repeat(1500)}`;
    const events = [
      { id: "l1", name: "page_viewed", clientId: "c1", timestamp: at, path: long },
      { id: "l2", name: "page_viewed", clientId: "c2", timestamp: at, path: "/" },
    ];
    const res = await ctx.app.inject({ method: "POST", url: `/pixel/${store.pixelIngestKey}`, headers: { "content-type": "text/plain" }, payload: JSON.stringify({ events }) });
    expect(res.json()).toEqual({ ok: true, accepted: 2 });
    const visits = await systemDb.funnelVisit.findMany({ where: { storeId: store.id } });
    expect(visits).toHaveLength(2);
    for (const v of visits) expect((v.entryPath ?? "").length).toBeLessThanOrEqual(200);
  });
});

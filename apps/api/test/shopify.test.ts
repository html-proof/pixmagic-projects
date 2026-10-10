import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { systemDb } from "@app/db";
import { signShopifyQuery, signWebhookBody } from "@app/shared";
import { getAccessToken, INLINE_PAYLOAD_LIMIT } from "@app/core";
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
      expect(body).toMatchObject({ code: "authcode", client_secret: SECRET });
      expect(body).not.toHaveProperty("expiring");
      return new Response(
        JSON.stringify({ access_token: "shpat_PLAINTEXT", scope: "read_orders" }),
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

    it("launch without a session (or signup) sends the visitor to the in-app connect page with the shop", async () => {
      // Shopify connects only from inside the app: that page signs the visitor in (or up) first.
      const res = await ctx.app.inject({ method: "GET", url: launchUrl() });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toMatch(/\/onboarding\?shop=demo-shop\.myshopify\.com$/);
    });

    it("launch for a signed-in but unverified user still goes to onboarding", async () => {
      const { cookie } = await signIn(ctx, "unv", "unv@x.com", false);
      const res = await ctx.app.inject({ method: "GET", url: launchUrl(), headers: { cookie } });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toMatch(/\/onboarding\?shop=demo-shop\.myshopify\.com$/);
    });
  });

  const tokenFetch = () =>
    ctx.setFetch(async () =>
      new Response(JSON.stringify({ access_token: "shpat_x", scope: "read_orders", expires_in: 3600, refresh_token: "shprt_x", refresh_token_expires_in: 7776000 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

  it("callback refuses a store another workspace connected in the meantime", async () => {
    const { res, cookie } = await startInstall();
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
    expect(cb.headers.location).toMatch(/\/onboarding\?error=store_taken$/);
    expect((await systemDb.store.findUniqueOrThrow({ where: { shopDomain: "demo-shop.myshopify.com" } })).workspaceId).toBe(rivalWs);
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

  // The row is committed before the queue send. A tunnel drop after the commit (500), or Shopify
  // giving up at 5s and the Worker being cancelled, leaves it queued and untouched with no message.
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

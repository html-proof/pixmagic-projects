import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { systemDb } from "@app/db";
import { CLIENT_IP_HEADER } from "../src/context.js";
import { signWebhookBody } from "@app/shared";
import { buildApp } from "../src/app.js";
import { LIMITS } from "../src/rateLimit.js";
import { clean, createStore, createWorkspace, ORIGIN, setup, signIn, teardown, type TestCtx } from "./helpers.js";

/**
 * Security audit (2026-10-10): each case covers a control added or tightened by it.
 */

let ctx: TestCtx;
beforeAll(async () => (ctx = await setup()));
afterAll(async () => teardown(ctx));
beforeEach(async () => clean(ctx));

describe("API response headers", () => {
  const expectHardened = (headers: Record<string, string>) => {
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["cache-control"]).toBe("no-store");
    expect(headers["content-security-policy"]).toBe("default-src 'none'; frame-ancestors 'none'");
    expect(headers["x-frame-options"]).toBe("DENY");
  };

  it("are set on success, not found, auth failures and early rejections", async () => {
    expectHardened((await ctx.app.inject({ method: "GET", url: "/healthz" })).headers);
    expectHardened((await ctx.app.inject({ method: "GET", url: "/no-such-route" })).headers);
    expectHardened((await ctx.app.inject({ method: "GET", url: "/me" })).headers);
    expectHardened((await ctx.app.inject({ method: "POST", url: "/auth/login", headers: { origin: "https://evil.example" }, payload: {} })).headers);
    const limited = await buildApp({ ...ctx.deps, globalLimit: async () => false }).request("/me");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("leave the pixel's own CORS answer alone", async () => {
    const res = await ctx.app.inject({ method: "POST", url: "/pixel/no-such-key", payload: JSON.stringify({ events: [] }) });
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("never allow credentialed cross-origin reads of the API", async () => {
    const { headers } = await signIn(ctx, "u", "u@x.com");
    const res = await ctx.app.inject({ method: "GET", url: "/me", headers: { ...headers, origin: "https://evil.example" } });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
  });
});

describe("rate limits on email-sending and creation endpoints", () => {
  it("caps invitations per workspace (each one is an email from our domain)", async () => {
    const { headers } = await signIn(ctx, "o", "o@x.com");
    const ws = await createWorkspace(ctx, headers);
    const invite = (i: number) =>
      ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/invitations`, headers, payload: { email: `p${i}@x.com`, role: "viewer" } });
    for (let i = 0; i < LIMITS.invitations.max; i++) expect((await invite(i)).statusCode).toBe(200);
    expect((await invite(999)).statusCode).toBe(429);
    expect(ctx.mailer.sent).toHaveLength(LIMITS.invitations.max);
  });

  it("caps new workspaces per user", async () => {
    const { headers } = await signIn(ctx, "o", "o@x.com");
    for (let i = 0; i < LIMITS.workspaceCreate.max; i++) await createWorkspace(ctx, headers, `W${i}`);
    const res = await ctx.app.inject({ method: "POST", url: "/workspaces", headers, payload: { name: "One too many" } });
    expect(res.statusCode).toBe(429);
    // Someone else is not affected.
    const other = await signIn(ctx, "p", "p@x.com");
    expect(await createWorkspace(ctx, other.headers, "Mine")).toBeTruthy();
  });

  it("caps new API keys per workspace", async () => {
    const { headers } = await signIn(ctx, "o", "o@x.com");
    const ws = await createWorkspace(ctx, headers);
    const create = () => ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/api-keys`, headers, payload: { name: "k" } });
    for (let i = 0; i < LIMITS.apiKeyCreate.max; i++) expect((await create()).statusCode).toBe(200);
    expect((await create()).statusCode).toBe(429);
  });
});

describe("emailed code guessing and sending", () => {
  const reset = (code: string, ip = "1.1.1.1", email = "victim@x.com") =>
    ctx.app.inject({
      method: "POST",
      url: "/auth/password/reset",
      headers: { ...ORIGIN, [CLIENT_IP_HEADER]: ip },
      payload: { email, code, password: "a-new-password", confirmPassword: "a-new-password" },
    });

  it("caps guesses per IP, so even the right code is refused once they're spent (Cognito's own lockout comes on top)", async () => {
    ctx.auth.addUser({ sub: "v", email: "victim@x.com" });
    await ctx.app.inject({ method: "POST", url: "/auth/password/forgot", headers: ORIGIN, payload: { email: "victim@x.com" } });
    const right = ctx.auth.code("reset", "victim@x.com");
    const wrong = right === "000000" ? "111111" : "000000";
    // Spread over addresses, so the per-address cap (resetVerifyEmail) doesn't come into it.
    for (let i = 0; i < LIMITS.codeVerifyIp.max; i++) expect((await reset(wrong, "1.1.1.1", `guess${i}@x.com`)).json().error).toBe("invalid_code");
    expect((await reset(right)).statusCode).toBe(429);
    // Another IP is not affected.
    expect((await reset(right, "9.9.9.9")).statusCode).toBe(200);
  });

  it("caps the codes sent to one address, whichever IP asks", async () => {
    ctx.auth.addUser({ sub: "v", email: "victim@x.com" });
    for (let i = 0; i < LIMITS.codeEmail.max; i++) {
      const res = await ctx.app.inject({ method: "POST", url: "/auth/password/forgot", headers: { ...ORIGIN, [CLIENT_IP_HEADER]: `10.0.0.${i}` }, payload: { email: "victim@x.com" } });
      expect(res.statusCode).toBe(200);
    }
    const more = await ctx.app.inject({ method: "POST", url: "/auth/password/forgot", headers: { ...ORIGIN, [CLIENT_IP_HEADER]: "10.0.1.1" }, payload: { email: "victim@x.com" } });
    expect(more.statusCode).toBe(429);
    expect(ctx.auth.sent.filter((s) => s.email === "victim@x.com")).toHaveLength(LIMITS.codeEmail.max);
  });
});

describe("webhooks that name their shop", () => {
  const send = (topic: string, headerShop: string, payload: unknown, id: string) => {
    const raw = JSON.stringify(payload);
    return ctx.app.inject({
      method: "POST",
      url: "/webhooks/shopify",
      headers: {
        "content-type": "application/json",
        "x-shopify-hmac-sha256": signWebhookBody(raw, "test_secret"),
        "x-shopify-topic": topic,
        "x-shopify-shop-domain": headerShop,
        "x-shopify-webhook-id": id,
      },
      payload: raw,
    });
  };

  it("refuse a signed body replayed with another store's headers", async () => {
    const { headers } = await signIn(ctx, "o", "o@x.com");
    const ws = await createWorkspace(ctx, headers);
    await createStore(ws, "victim.myshopify.com", ["read_orders"]);
    // A genuine, Shopify-signed uninstall for the attacker's store, re-sent as the victim's.
    expect((await send("app/uninstalled", "victim.myshopify.com", { id: 1, myshopify_domain: "attacker.myshopify.com" }, "r1")).statusCode).toBe(401);
    expect((await send("shop/redact", "victim.myshopify.com", { shop_id: 1, shop_domain: "attacker.myshopify.com" }, "r2")).statusCode).toBe(401);
    expect((await send("customers/redact", "victim.myshopify.com", { shop_domain: "Attacker.myshopify.com", customer: { id: 5 } }, "r3")).statusCode).toBe(401);
    expect(await systemDb.webhookEvent.count()).toBe(0);
    expect(ctx.deps.queues.sent.webhooks).toHaveLength(0);
  });

  it("accept them for their own store, and topics that name no shop as before", async () => {
    expect((await send("app/uninstalled", "s.myshopify.com", { id: 1, myshopify_domain: "S.myshopify.com" }, "a1")).statusCode).toBe(200);
    expect((await send("shop/redact", "s.myshopify.com", { shop_id: 1, shop_domain: "s.myshopify.com" }, "a2")).statusCode).toBe(200);
    expect((await send("orders/create", "s.myshopify.com", { id: 7, name: "#7" }, "a3")).statusCode).toBe(200);
    expect(ctx.deps.queues.sent.webhooks).toHaveLength(3);
  });
});

describe("object-level authorization on writes (IDOR)", () => {
  async function twoTenants() {
    const a = await signIn(ctx, "ua", "a@x.com");
    const b = await signIn(ctx, "ub", "b@x.com");
    const wsA = await createWorkspace(ctx, a.headers, "A");
    const wsB = await createWorkspace(ctx, b.headers, "B");
    const storeB = await createStore(wsB, "b.myshopify.com", ["read_orders"]);
    return { a, b, wsA, wsB, storeB };
  }

  it("cannot touch another workspace's store, member or key through its ids", async () => {
    const { a, b, wsA, wsB, storeB } = await twoTenants();
    const memberB = await systemDb.membership.findFirstOrThrow({ where: { workspaceId: wsB } });
    const keyB = (await ctx.app.inject({ method: "POST", url: `/workspaces/${wsB}/api-keys`, headers: b.headers, payload: { name: "k" } })).json().key.id as string;

    // Straight at the other workspace: not a member, so it doesn't exist.
    const direct = [
      { method: "DELETE", url: `/workspaces/${wsB}/stores/${storeB.id}` },
      { method: "POST", url: `/workspaces/${wsB}/stores/${storeB.id}/resync` },
      { method: "PATCH", url: `/workspaces/${wsB}`, payload: { name: "pwned" } },
      { method: "PATCH", url: `/workspaces/${wsB}/members/${memberB.id}`, payload: { role: "viewer" } },
      { method: "DELETE", url: `/workspaces/${wsB}/api-keys/${keyB}` },
      { method: "POST", url: `/workspaces/${wsB}/invitations`, payload: { email: "spy@x.com", role: "admin" } },
    ];
    // Through one's own workspace with the other's object ids.
    const smuggled = [
      { method: "DELETE", url: `/workspaces/${wsA}/stores/${storeB.id}` },
      { method: "POST", url: `/workspaces/${wsA}/stores/${storeB.id}/resync` },
      { method: "PATCH", url: `/workspaces/${wsA}/members/${memberB.id}`, payload: { role: "viewer" } },
      { method: "DELETE", url: `/workspaces/${wsA}/members/${memberB.id}` },
      { method: "DELETE", url: `/workspaces/${wsA}/api-keys/${keyB}` },
    ];
    for (const r of [...direct, ...smuggled]) {
      const res = await ctx.app.inject({ ...r, headers: a.headers });
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(404);
    }

    expect((await systemDb.store.findUniqueOrThrow({ where: { id: storeB.id } })).status).toBe("active");
    expect((await systemDb.workspace.findUniqueOrThrow({ where: { id: wsB } })).name).toBe("B");
    expect((await systemDb.membership.findUniqueOrThrow({ where: { id: memberB.id } })).role).toBe("owner");
    expect((await systemDb.apiKey.findUniqueOrThrow({ where: { id: keyB } })).revokedAt).toBeNull();
    expect(await systemDb.invitation.count()).toBe(0);
  });
});

describe("row level security coverage", () => {
  it("is enabled, with a policy, on every table that holds a workspace's rows", async () => {
    const tables = await systemDb.$queryRaw<Array<{ name: string; rls: boolean; policies: number }>>`
      SELECT c.relname AS name, c.relrowsecurity AS rls,
             (SELECT COUNT(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
      WHERE c.relkind = 'r'
        AND (c.relname = 'workspaces' OR EXISTS (
          SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'workspace_id' AND NOT a.attisdropped))`;
    expect(tables.length).toBeGreaterThan(10);
    // A migration that adds a tenant table without RLS (the app_rls role is granted every new
    // table by default privileges) would let one workspace read another's rows: fail it here.
    expect(tables.filter((t) => !t.rls || t.policies === 0).map((t) => t.name)).toEqual([]);
  });

  it("gives the tenant role no way around it, and nothing on the sign-in tables", async () => {
    const [role] = await systemDb.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'app_rls'`;
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
    const owned = await systemDb.$queryRaw<Array<{ tablename: string }>>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tableowner = 'app_rls'`;
    expect(owned).toEqual([]);
    const [grants] = await systemDb.$queryRaw<Array<{ seen: boolean; identities: boolean; events: boolean; sessions: boolean; accounts: boolean; refresh: boolean }>>`
      SELECT has_table_privilege('app_rls', 'public.pixel_events_seen', 'SELECT') AS seen,
             has_table_privilege('app_rls', 'public.auth_identities', 'SELECT') AS identities,
             has_table_privilege('app_rls', 'public.auth_events', 'SELECT') AS events,
             has_table_privilege('app_rls', 'public.user_sessions', 'SELECT') AS sessions,
             has_table_privilege('app_rls', 'public.auth_accounts', 'SELECT') AS accounts,
             has_table_privilege('app_rls', 'public.auth_refresh_tokens', 'SELECT') AS refresh`;
    expect(grants).toEqual({ seen: false, identities: false, events: false, sessions: false, accounts: false, refresh: false });
  });
});

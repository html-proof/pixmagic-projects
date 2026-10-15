import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { systemDb, type Prisma } from "@app/db";
import { cancelScheduled, ensurePlatformWebhook, newLinkToken, waEncrypt, type FetchLike } from "@app/core";
import { sha256Hex, signMetaBody, TEMPLATE_LIBRARY, whatsappConfigSchema } from "@app/shared";
import { clean, createStore, createWorkspace, setup, signIn, teardown, type TestCtx } from "./helpers.js";

/**
 * WhatsApp routes: connecting a number, the merchant's views and actions (always scoped to their
 * own workspace), Meta's webhook (signature first), and the customer's tracking and review pages.
 */

let ctx: TestCtx;
beforeAll(async () => (ctx = await setup()));
afterAll(async () => teardown(ctx));

const PLATFORM = { WHATSAPP_APP_SECRET: "platform_secret", WHATSAPP_WEBHOOK_VERIFY_TOKEN: "platform-verify-token", WHATSAPP_APP_ID: "123", WHATSAPP_CONFIG_ID: "456" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Meta, as a manual connection's checks see it. */
const graph: FetchLike = async (input, init) => {
  const u = new URL(String(input));
  const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
  if (auth !== "Bearer EAAG_valid_system_user_token_0123456789") return json({ error: { code: 190, message: "Invalid OAuth access token", type: "OAuthException" } }, 401);
  if (u.pathname.endsWith("/1111111111/phone_numbers")) return json({ data: [{ id: "2222222222" }] });
  if (u.pathname.endsWith("/2222222222") && u.searchParams.get("fields")?.includes("display_phone_number")) {
    return json({ id: "2222222222", display_phone_number: "+91 98765 00000", verified_name: "Green Leaf", quality_rating: "GREEN", platform_type: "CLOUD_API", name_status: "APPROVED" });
  }
  if (u.pathname.endsWith("/2222222222")) return json({ id: "2222222222", messaging_limit_tier: "TIER_1K" });
  if (u.pathname.endsWith("/1111111111") && init?.method === "GET") return json({ id: "1111111111", name: "Green Leaf WABA" });
  if (u.pathname.endsWith("/subscribed_apps")) return json({ success: true });
  if (u.pathname.endsWith("/message_templates")) {
    return json({ data: TEMPLATE_LIBRARY.slice(0, 3).map((t, i) => ({ id: `t${i}`, name: t.name, language: "en", category: t.category, status: "APPROVED", components: [{ type: "BODY", text: t.body }] })) });
  }
  if (u.pathname.endsWith("/messages")) return json({ messages: [{ id: "wamid.T1" }] });
  return json({ error: { message: `unexpected ${u.pathname}` } }, 400);
};

async function owner(uid = "u1", email = "o@shop.test") {
  const s = await signIn(ctx, uid, email);
  const ws = await createWorkspace(ctx, s.headers);
  const store = await createStore(ws, `${uid}.myshopify.com`, ["read_orders"], { name: "Green Leaf", currency: "INR" });
  return { ...s, ws, store, base: `/workspaces/${ws}/stores/${store.id}/whatsapp` };
}

async function connectManual(o: Awaited<ReturnType<typeof owner>>) {
  ctx.setFetch(graph);
  return ctx.app.inject({
    method: "POST",
    url: `${o.base}/manual`,
    headers: o.headers,
    payload: { wabaId: "1111111111", phoneNumberId: "2222222222", accessToken: "EAAG_valid_system_user_token_0123456789", appSecret: "0123456789abcdef0123456789abcdef" },
  });
}

/** An order on the store's timeline, with its tracking link token. */
async function trackedOrder(storeId: string, workspaceId: string, over: Partial<Prisma.OrderTrackingUncheckedCreateInput> = {}) {
  const track = newLinkToken();
  const review = newLinkToken();
  const t = await systemDb.orderTracking.create({
    data: {
      workspaceId,
      storeId,
      shopifyOrderId: String(Math.floor(Math.random() * 1e9)),
      orderName: "#1042",
      tokenHash: track.hash,
      tokenEnc: waEncrypt(storeId, "track", track.token),
      reviewTokenHash: review.hash,
      reviewTokenEnc: waEncrypt(storeId, "review", review.token),
      currency: "INR",
      totalPrice: 1499,
      items: [{ productId: "10", title: "Kerala Saree", quantity: 1 }],
      orderCreatedAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
      ...over,
    },
  });
  return { t, token: track.token, reviewToken: review.token };
}

beforeEach(async () => {
  await clean(ctx);
  ctx.setEnv({ ...PLATFORM });
  ctx.setFetch(async () => {
    throw new Error("unexpected network call in test");
  });
});

describe("connecting WhatsApp", () => {
  it("connects with the merchant's own app, stores the token encrypted, and never returns it", async () => {
    const o = await owner();
    const res = await connectManual(o);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.connection).toMatchObject({ mode: "manual", displayPhoneNumber: "+91 98765 00000", verifiedName: "Green Leaf", registered: true, status: "active", messagingLimitTier: "TIER_1K" });
    expect(res.body).not.toContain("EAAG_valid");
    expect(res.body).not.toContain("0123456789abcdef0123456789abcdef");
    expect(body.connection.verifyToken).toMatch(/^wa_vt_/);
    const row = await systemDb.whatsappConnection.findFirstOrThrow({ where: { storeId: o.store.id } });
    expect(row.accessTokenEnc).not.toContain("EAAG");
    expect(row.appSecretEnc).not.toContain("0123456789abcdef");
    expect(await systemDb.whatsappTemplate.count({ where: { storeId: o.store.id } })).toBe(3);
    expect(await systemDb.auditLog.count({ where: { workspaceId: o.ws, action: "whatsapp.connected" } })).toBe(1);

    // The overview shows real status, and only managers see the verify token.
    const view = await ctx.app.inject({ method: "GET", url: o.base, headers: o.headers });
    expect(view.json().setup).toMatchObject({ connected: true, registered: true, webhookVerified: false, consentBasis: "none" });
  });

  it("refuses a token Meta rejects, and a number from another account", async () => {
    const o = await owner();
    ctx.setFetch(graph);
    const bad = await ctx.app.inject({ method: "POST", url: `${o.base}/manual`, headers: o.headers, payload: { wabaId: "1111111111", phoneNumberId: "2222222222", accessToken: "EAAGwrong_token_value_000000000000", appSecret: "0123456789abcdef0123456789abcdef" } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe("token_rejected");
    const other = await ctx.app.inject({ method: "POST", url: `${o.base}/manual`, headers: o.headers, payload: { wabaId: "1111111111", phoneNumberId: "9999999999", accessToken: "EAAG_valid_system_user_token_0123456789", appSecret: "0123456789abcdef0123456789abcdef" } });
    expect(other.json().error).toBe("phone_not_in_account");
    expect(await systemDb.whatsappConnection.count()).toBe(0);
  });

  /**
   * Meta as the guided flow sees it: the token's app and accounts (debug_token), the account's
   * numbers, and the app's webhook settings, whose POST runs the verify handshake against
   * Insights the way Meta does.
   */
  function guidedMeta(opts: { scopes?: string[]; otherWebhook?: string; listAccounts?: boolean } = {}) {
    const subscribed: Array<Record<string, string>> = [];
    const fetch: FetchLike = async (input, init) => {
      const u = new URL(String(input));
      const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
      if (u.pathname.endsWith("/777/subscriptions")) {
        if (auth !== "Bearer 777|0123456789abcdef0123456789abcdef") return json({ error: { code: 101, message: "Error validating client secret.", type: "OAuthException" } }, 400);
        if (init?.method === "GET") {
          return json({ data: opts.otherWebhook ? [{ object: "whatsapp_business_account", callback_url: opts.otherWebhook, active: true }] : [] });
        }
        const q = Object.fromEntries(u.searchParams);
        const hs = await ctx.app.inject({ method: "GET", url: `/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(q.verify_token ?? "")}&hub.challenge=meta-check` });
        if (hs.body !== "meta-check") return json({ error: { code: 2200, message: "Callback verification failed", type: "OAuthException" } }, 400);
        subscribed.push(q);
        return json({ success: true });
      }
      if (auth !== "Bearer EAAG_valid_system_user_token_0123456789") return json({ error: { code: 190, message: "Invalid OAuth access token", type: "OAuthException" } }, 401);
      if (u.pathname.endsWith("/debug_token")) {
        const scopes = opts.scopes ?? ["whatsapp_business_management", "whatsapp_business_messaging"];
        return json({
          data: { app_id: "777", is_valid: true, scopes, granular_scopes: opts.listAccounts === false ? [] : scopes.map((scope) => ({ scope, target_ids: ["1111111111"] })) },
        });
      }
      if (u.pathname.endsWith("/1111111111/phone_numbers")) {
        return json({ data: [{ id: "2222222222", display_phone_number: "+91 98765 00000", verified_name: "Green Leaf", platform_type: "CLOUD_API" }] });
      }
      return graph(input, init);
    };
    return { fetch, subscribed };
  }

  it("finds the numbers a token reaches, from the token alone", async () => {
    const o = await owner();
    ctx.setFetch(guidedMeta().fetch);
    const res = await ctx.app.inject({ method: "POST", url: `${o.base}/manual/discover`, headers: o.headers, payload: { accessToken: "EAAG_valid_system_user_token_0123456789" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      appId: "777",
      accounts: [{ id: "1111111111", name: "Green Leaf WABA", numbers: [{ id: "2222222222", displayPhoneNumber: "+91 98765 00000", verifiedName: "Green Leaf", registered: true }] }],
    });
    expect(await systemDb.whatsappConnection.count()).toBe(0);

    const bad = await ctx.app.inject({ method: "POST", url: `${o.base}/manual/discover`, headers: o.headers, payload: { accessToken: "EAAGwrong_token_value_000000000000" } });
    expect(bad.json().error).toBe("token_rejected");

    ctx.setFetch(guidedMeta({ scopes: ["whatsapp_business_management"] }).fetch);
    const scoped = await ctx.app.inject({ method: "POST", url: `${o.base}/manual/discover`, headers: o.headers, payload: { accessToken: "EAAG_valid_system_user_token_0123456789" } });
    expect(scoped.json()).toMatchObject({ error: "missing_permissions", message: expect.stringContaining("whatsapp_business_messaging") });

    // Meta doesn't always say which accounts a token was given: the page then asks for the ids.
    ctx.setFetch(guidedMeta({ listAccounts: false }).fetch);
    const unlisted = await ctx.app.inject({ method: "POST", url: `${o.base}/manual/discover`, headers: o.headers, payload: { accessToken: "EAAG_valid_system_user_token_0123456789" } });
    expect(unlisted.json()).toEqual({ appId: "777", accounts: [] });
  });

  it("points the merchant's app's webhook at Insights, so there's nothing to paste into Meta", async () => {
    const o = await owner();
    const meta = guidedMeta();
    ctx.setFetch(meta.fetch);
    const res = await ctx.app.inject({
      method: "POST",
      url: `${o.base}/manual`,
      headers: o.headers,
      payload: { wabaId: "1111111111", phoneNumberId: "2222222222", accessToken: "EAAG_valid_system_user_token_0123456789", appSecret: "0123456789abcdef0123456789abcdef" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().webhook).toBe("verified");
    expect(res.json().connection.webhookVerifiedAt).not.toBeNull();
    expect(meta.subscribed).toHaveLength(1);
    expect(meta.subscribed[0]).toMatchObject({ object: "whatsapp_business_account", callback_url: "http://localhost:4000/webhooks/whatsapp" });
    expect(meta.subscribed[0]!.fields!.split(",")).toEqual(expect.arrayContaining(["messages", "user_preferences", "message_template_status_update"]));
  });

  it("refuses an app secret from a different app, and leaves a webhook that goes elsewhere alone", async () => {
    const o = await owner();
    ctx.setFetch(guidedMeta().fetch);
    const payload = { wabaId: "1111111111", phoneNumberId: "2222222222", accessToken: "EAAG_valid_system_user_token_0123456789" };
    const wrong = await ctx.app.inject({ method: "POST", url: `${o.base}/manual`, headers: o.headers, payload: { ...payload, appSecret: "ffffffffffffffffffffffffffffffff" } });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error).toBe("wrong_app_secret");
    expect(await systemDb.whatsappConnection.count()).toBe(0);

    const meta = guidedMeta({ otherWebhook: "https://another-tool.example/hook" });
    ctx.setFetch(meta.fetch);
    const kept = await ctx.app.inject({ method: "POST", url: `${o.base}/manual`, headers: o.headers, payload: { ...payload, appSecret: "0123456789abcdef0123456789abcdef" } });
    expect(kept.statusCode).toBe(200);
    expect(kept.json().webhook).toBe("in_use");
    expect(meta.subscribed).toHaveLength(0);
    expect(kept.json().connection.verifyToken).toMatch(/^wa_vt_/);
  });

  /** Meta behind "Continue with WhatsApp": the code exchange, then the business token as above. */
  function embeddedMeta(numbers = 1, token: { appId?: string; granted?: string[] } = {}) {
    const exchanged: string[] = [];
    const fetch: FetchLike = async (input, init) => {
      const u = new URL(String(input));
      // Insights' own app inspecting the business token Embedded Signup returned.
      if (u.pathname.endsWith("/debug_token") && (init?.headers as Record<string, string> | undefined)?.authorization === "Bearer 123|platform_secret") {
        const scopes = ["whatsapp_business_management", "whatsapp_business_messaging"];
        return json({ data: { app_id: token.appId ?? "123", is_valid: true, scopes, granular_scopes: scopes.map((scope) => ({ scope, target_ids: token.granted ?? ["1111111111"] })) } });
      }
      if (u.pathname.endsWith("/oauth/access_token")) {
        exchanged.push(`${u.searchParams.get("client_id")}:${u.searchParams.get("client_secret")}:${u.searchParams.get("code")}`);
        return u.searchParams.get("code") === "es-code-123456" ? json({ access_token: "EAAG_valid_system_user_token_0123456789" }) : json({ error: { message: "bad code", type: "OAuthException" } }, 400);
      }
      if (u.pathname.endsWith("/1111111111/phone_numbers") && u.searchParams.get("fields")?.includes("verified_name")) {
        return json({ data: Array.from({ length: numbers }, (_, i) => ({ id: i ? `55555${i}0000` : "2222222222", display_phone_number: `+91 98765 0000${i}`, platform_type: "CLOUD_API" })) });
      }
      return guidedMeta().fetch(input, init);
    };
    return { fetch, exchanged };
  }

  it("connects with Continue with WhatsApp, using the ids Meta posted to the page", async () => {
    const o = await owner();
    const meta = embeddedMeta();
    ctx.setFetch(meta.fetch);
    const view = await ctx.app.inject({ method: "GET", url: o.base, headers: o.headers });
    expect(view.json().platform).toMatchObject({ embeddedSignup: true, appId: "123", configId: "456" });
    expect(JSON.stringify(view.json().platform)).not.toContain("platform_secret");

    const res = await ctx.app.inject({ method: "POST", url: `${o.base}/embedded`, headers: o.headers, payload: { code: "es-code-123456", wabaId: "1111111111", phoneNumberId: "2222222222", businessId: "9999999" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().connection).toMatchObject({ mode: "embedded", phoneNumberId: "2222222222", businessId: "9999999", verifyToken: null });
    expect(meta.exchanged).toEqual(["123:platform_secret:es-code-123456"]);
    expect(res.body).not.toContain("EAAG_valid");

    const expired = await ctx.app.inject({ method: "POST", url: `${o.base}/embedded`, headers: o.headers, payload: { code: "es-code-expired", wabaId: "1111111111", phoneNumberId: "2222222222" } });
    expect(expired.json().error).toBe("exchange_failed");
  });

  it("won't take the browser's word for the account: it must be one this sign-up granted to Insights' app", async () => {
    const o = await owner();
    ctx.setFetch(embeddedMeta(1, { granted: ["3333333333"] }).fetch);
    const other = await ctx.app.inject({ method: "POST", url: `${o.base}/embedded`, headers: o.headers, payload: { code: "es-code-123456", wabaId: "1111111111", phoneNumberId: "2222222222" } });
    expect(other.statusCode).toBe(400);
    expect(other.json().error).toBe("waba_not_granted");
    ctx.setFetch(embeddedMeta(1, { appId: "999" }).fetch);
    const foreign = await ctx.app.inject({ method: "POST", url: `${o.base}/embedded`, headers: o.headers, payload: { code: "es-code-123456", wabaId: "1111111111", phoneNumberId: "2222222222" } });
    expect(foreign.json().error).toBe("wrong_app");
    expect(await systemDb.whatsappConnection.count()).toBe(0);
  });

  it("asks Meta which number was shared when the page never heard, and won't guess between two", async () => {
    const o = await owner();
    ctx.setFetch(embeddedMeta().fetch);
    const res = await ctx.app.inject({ method: "POST", url: `${o.base}/embedded`, headers: o.headers, payload: { code: "es-code-123456" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().connection).toMatchObject({ mode: "embedded", wabaId: "1111111111", phoneNumberId: "2222222222" });

    await systemDb.whatsappTemplate.deleteMany({});
    await systemDb.whatsappConnection.deleteMany({});
    ctx.setFetch(embeddedMeta(2).fetch);
    const two = await ctx.app.inject({ method: "POST", url: `${o.base}/embedded`, headers: o.headers, payload: { code: "es-code-123456" } });
    expect(two.json().error).toBe("number_unknown");
    expect(await systemDb.whatsappConnection.count()).toBe(0);

    const half = await ctx.app.inject({ method: "POST", url: `${o.base}/embedded`, headers: o.headers, payload: { code: "es-code-123456", wabaId: "1111111111" } });
    expect(half.statusCode).toBe(400);
  });

  /** A number Embedded Signup just added: not on the Cloud API yet. `hasPin`: it already has a two-step PIN. */
  function newNumberMeta(opts: { hasPin?: boolean } = {}) {
    const pins: string[] = [];
    const inner = embeddedMeta();
    const fetch: FetchLike = async (input, init) => {
      const u = new URL(String(input));
      if (u.pathname.endsWith("/2222222222/register")) {
        if (opts.hasPin) return json({ error: { code: 133005, message: "Two step verification PIN Mismatch", type: "OAuthException" } }, 400);
        pins.push((JSON.parse(String(init?.body)) as { pin: string }).pin);
        return json({ success: true });
      }
      if (u.pathname.endsWith("/2222222222") && u.searchParams.get("fields")?.includes("display_phone_number")) {
        return json({ id: "2222222222", display_phone_number: "+91 98765 00000", verified_name: "Green Leaf", quality_rating: "UNKNOWN", platform_type: "NOT_APPLICABLE", name_status: "APPROVED" });
      }
      return inner.fetch(input, init);
    };
    return { fetch, pins };
  }
  const embeddedPayload = { code: "es-code-123456", wabaId: "1111111111", phoneNumberId: "2222222222" };

  it("registers a new number straight after Meta's sign-up, with a PIN only owners and admins can see", async () => {
    const o = await owner();
    const meta = newNumberMeta();
    ctx.setFetch(meta.fetch);
    const res = await ctx.app.inject({ method: "POST", url: `${o.base}/embedded`, headers: o.headers, payload: { ...embeddedPayload, event: "FINISH" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().registration).toBe("registered");
    expect(res.json().connection).toMatchObject({ registered: true, status: "active", hasPin: true });
    expect(meta.pins).toHaveLength(1);
    expect(meta.pins[0]).toMatch(/^\d{6}$/);
    expect(res.body).not.toContain(meta.pins[0]);
    const row = await systemDb.whatsappConnection.findFirstOrThrow({ where: { storeId: o.store.id } });
    expect(row.pinEnc).toBeTruthy();
    expect(row.pinEnc).not.toContain(meta.pins[0]);

    const shown = await ctx.app.inject({ method: "POST", url: `${o.base}/pin`, headers: o.headers });
    expect(shown.json()).toEqual({ pin: meta.pins[0] });
    expect(shown.headers["cache-control"]).toBe("no-store");
    expect(await systemDb.auditLog.count({ where: { action: "whatsapp.pin_viewed" } })).toBe(1);

    const me = await systemDb.user.findFirstOrThrow({ where: { email: "o@shop.test" } });
    await systemDb.membership.update({ where: { workspaceId_userId: { workspaceId: o.ws, userId: me.id } }, data: { role: "analyst" } });
    expect((await ctx.app.inject({ method: "POST", url: `${o.base}/pin`, headers: o.headers })).statusCode).toBe(403);
  });

  it("leaves a number that has its own PIN, or isn't a new Cloud API number, for the merchant", async () => {
    const o = await owner();
    // Already protected by a PIN the merchant chose: ours is refused, and they're asked for theirs.
    ctx.setFetch(newNumberMeta({ hasPin: true }).fetch);
    const own = await ctx.app.inject({ method: "POST", url: `${o.base}/embedded`, headers: o.headers, payload: { ...embeddedPayload, event: "FINISH" } });
    expect(own.statusCode).toBe(200);
    expect(own.json().registration).toBe("pin_needed");
    expect(own.json().connection).toMatchObject({ registered: false, status: "pending", hasPin: false });

    // A WhatsApp Business app number (coexistence), or a finish Meta didn't describe: never registered here.
    for (const event of ["FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING", undefined]) {
      const meta = newNumberMeta();
      ctx.setFetch(meta.fetch);
      const res = await ctx.app.inject({ method: "POST", url: `${o.base}/embedded`, headers: o.headers, payload: { ...embeddedPayload, ...(event ? { event } : {}) } });
      expect(res.statusCode).toBe(200);
      expect(meta.pins).toEqual([]);
      expect(res.json().connection.registered).toBe(false);
    }
    expect((await ctx.app.inject({ method: "POST", url: `${o.base}/pin`, headers: o.headers })).json().error).toBe("pin_unknown");
  });

  it("points Insights' own Meta app's webhook here by itself, once", async () => {
    const subs: Array<{ object: string; callback_url: string; active: boolean; fields: Array<{ name: string }> }> = [];
    const posts: Array<Record<string, string>> = [];
    ctx.setFetch(async (input, init) => {
      const u = new URL(String(input));
      const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
      if (!u.pathname.endsWith("/123/subscriptions") || auth !== "Bearer 123|platform_secret") return json({ error: { message: "unexpected" } }, 400);
      if (init?.method === "GET") return json({ data: subs });
      const q = Object.fromEntries(u.searchParams);
      const hs = await ctx.app.inject({ method: "GET", url: `/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(q.verify_token ?? "")}&hub.challenge=c1` });
      if (hs.body !== "c1") return json({ error: { message: "Callback verification failed" } }, 400);
      posts.push(q);
      subs.splice(0, subs.length, { object: q.object!, callback_url: q.callback_url!, active: true, fields: q.fields!.split(",").map((name) => ({ name })) });
      return json({ success: true });
    });
    expect(await ensurePlatformWebhook(ctx.deps.fetchImpl)).toBe("set");
    expect(posts[0]).toMatchObject({ object: "whatsapp_business_account", callback_url: "http://localhost:4000/webhooks/whatsapp", verify_token: "platform-verify-token" });
    expect(await ensurePlatformWebhook(ctx.deps.fetchImpl)).toBe("already");
    expect(posts).toHaveLength(1);

    ctx.setEnv({ WHATSAPP_WEBHOOK_VERIFY_TOKEN: "" });
    expect(await ensurePlatformWebhook(ctx.deps.fetchImpl)).toBe("unconfigured");
  });

  it("says Embedded Signup isn't set up rather than pretending", async () => {
    ctx.setEnv({ WHATSAPP_CONFIG_ID: "", META_APP_ID: "", WHATSAPP_APP_ID: "" });
    const o = await owner();
    const view = await ctx.app.inject({ method: "GET", url: o.base, headers: o.headers });
    expect(view.json().platform).toEqual({ embeddedSignup: false });
    expect(view.json().connection).toBeNull();
    const res = await ctx.app.inject({ method: "POST", url: `${o.base}/embedded`, headers: o.headers, payload: { code: "abcdefghijkl", wabaId: "1111111111", phoneNumberId: "2222222222" } });
    expect(res.statusCode).toBe(503);
  });
});

describe("tenant isolation", () => {
  it("another workspace's member can't see or change anything", async () => {
    const a = await owner("a", "a@shop.test");
    await connectManual(a);
    const b = await signIn(ctx, "b", "b@other.test");
    await createWorkspace(ctx, b.headers, "Other");
    for (const path of ["", "/messages", "/carts", "/reviews", "/orders", "/campaigns", "/automations", "/settings", "/analytics"]) {
      const res = await ctx.app.inject({ method: "GET", url: `${a.base}${path}`, headers: b.headers });
      expect(res.statusCode, path).toBe(404);
    }
    const put = await ctx.app.inject({ method: "PUT", url: `${a.base}/settings`, headers: b.headers, payload: {} });
    expect(put.statusCode).toBe(404);
    // Their own workspace id with A's store id: still nothing.
    const bWs = (await systemDb.membership.findFirstOrThrow({ where: { user: { identities: { some: { subject: "b" } } } } })).workspaceId;
    const cross = await ctx.app.inject({ method: "GET", url: `/workspaces/${bWs}/stores/${a.store.id}/whatsapp`, headers: b.headers });
    expect(cross.statusCode).toBe(404);
  });

  it("viewers can look but not change, and API keys are read-only", async () => {
    const o = await owner();
    const v = await signIn(ctx, "v", "v@shop.test");
    await systemDb.membership.create({ data: { workspaceId: o.ws, userId: v.user.id, role: "viewer" } });
    expect((await ctx.app.inject({ method: "GET", url: o.base, headers: v.headers })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "GET", url: `${o.base}/messages`, headers: v.headers })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: "PUT", url: `${o.base}/settings`, headers: v.headers, payload: {} })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: "POST", url: `${o.base}/manual`, headers: v.headers, payload: {} })).statusCode).toBe(403);
  });
});

describe("settings", () => {
  it("won't turn a notification on without a template, and records who chose the consent basis", async () => {
    const o = await owner();
    const off = await ctx.app.inject({ method: "PUT", url: `${o.base}/settings`, headers: o.headers, payload: { notifications: { order_confirmation: { enabled: true } } } });
    expect(off.statusCode).toBe(400);
    const ok = await ctx.app.inject({
      method: "PUT",
      url: `${o.base}/settings`,
      headers: o.headers,
      payload: { transactionalBasis: "checkout_notice", notifications: { order_confirmation: { enabled: true, templateName: "insights_order_confirmation", language: "en" } } },
    });
    expect(ok.statusCode).toBe(200);
    const row = await systemDb.whatsappSettings.findUniqueOrThrow({ where: { storeId: o.store.id } });
    expect(row.basisSetByUserId).toBe(o.user.id);
    const log = await systemDb.auditLog.findFirstOrThrow({ where: { action: "whatsapp.settings_updated" } });
    expect(log.metadata).toMatchObject({ turnedOn: ["order_confirmation"], consentBasis: "checkout_notice" });
  });
});

describe("Meta's webhook", () => {
  it("answers the verification handshake only for a known verify token", async () => {
    const ok = await ctx.app.inject({ method: "GET", url: "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=platform-verify-token&hub.challenge=12345" });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe("12345");
    const bad = await ctx.app.inject({ method: "GET", url: "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=12345" });
    expect(bad.statusCode).toBe(403);

    const o = await owner();
    const token = (await connectManual(o)).json().connection.verifyToken as string;
    const mine = await ctx.app.inject({ method: "GET", url: `/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=abc` });
    expect(mine.body).toBe("abc");
    expect((await systemDb.whatsappConnection.findFirstOrThrow({ where: { storeId: o.store.id } })).webhookVerifiedAt).not.toBeNull();
  });

  const stop = (wabaId = "1111111111") =>
    JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ id: wabaId, changes: [{ field: "messages", value: { metadata: { phone_number_id: "2222222222" }, messages: [{ from: "919876543210", id: "in.1", timestamp: "1700000000", type: "text", text: { body: "STOP" } }] } }] }],
    });

  it("applies nothing without a valid signature over the raw body", async () => {
    const o = await owner();
    await connectManual(o);
    const raw = stop();
    const unsigned = await ctx.app.inject({ method: "POST", url: "/webhooks/whatsapp", headers: { "content-type": "application/json" }, payload: raw });
    expect(unsigned.statusCode).toBe(401);
    const forged = await ctx.app.inject({ method: "POST", url: "/webhooks/whatsapp", headers: { "content-type": "application/json", "x-hub-signature-256": signMetaBody(raw, "wrong") }, payload: raw });
    expect(forged.statusCode).toBe(401);
    expect(await systemDb.whatsappContact.count()).toBe(0);
  });

  it("applies a delivery signed by the store's own app secret, or by Insights' app", async () => {
    const o = await owner();
    await connectManual(o);
    const raw = stop();
    const own = await ctx.app.inject({ method: "POST", url: "/webhooks/whatsapp", headers: { "content-type": "application/json", "x-hub-signature-256": signMetaBody(raw, "0123456789abcdef0123456789abcdef") }, payload: raw });
    expect(own.statusCode).toBe(200);
    expect(await systemDb.whatsappContact.findFirstOrThrow({ where: { storeId: o.store.id } })).toMatchObject({ optedOut: true, phoneMasked: "+91 ••••••• 210" });
    const platform = await ctx.app.inject({ method: "POST", url: "/webhooks/whatsapp", headers: { "content-type": "application/json", "x-hub-signature-256": signMetaBody(raw, "platform_secret") }, payload: raw });
    expect(platform.statusCode).toBe(200);
  });

  it("one store's app secret can't speak for another store's account", async () => {
    const a = await owner("a", "a@shop.test");
    await connectManual(a);
    const b = await owner("b", "b@shop.test");
    await systemDb.whatsappConnection.create({
      data: { workspaceId: b.ws, storeId: b.store.id, mode: "manual", wabaId: "3333333333", phoneNumberId: "4444444444", accessTokenEnc: waEncrypt(b.store.id, "access", "x"), tokenKeyVersion: 1, appSecretEnc: waEncrypt(b.store.id, "app_secret", "ffffffffffffffffffffffffffffffff") },
    });
    // Signed with A's secret but about B's account.
    const raw = stop("3333333333");
    const res = await ctx.app.inject({ method: "POST", url: "/webhooks/whatsapp", headers: { "content-type": "application/json", "x-hub-signature-256": signMetaBody(raw, "0123456789abcdef0123456789abcdef") }, payload: raw });
    expect(res.statusCode).toBe(401);
    expect(await systemDb.whatsappContact.count({ where: { storeId: b.store.id } })).toBe(0);
  });
});

describe("the customer's tracking page", () => {
  it("shows the order only to someone holding its link", async () => {
    const o = await owner();
    const { t, token } = await trackedOrder(o.store.id, o.ws, { paidAt: new Date(), financialStatus: "paid", shipmentRank: 1, status: "shipped" });
    await systemDb.orderTrackingEvent.create({ data: { workspaceId: o.ws, storeId: o.store.id, trackingId: t.id, type: "shipped", occurredAt: new Date(), source: "shopify", dedupeKey: "ful:1:shipped", fulfillmentId: "1", courier: "Blue Dart", trackingNumber: "BD1", trackingUrl: "https://bluedart.test/BD1" } });
    const res = await ctx.app.inject({ method: "GET", url: `/public/track/${token}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.order).toMatchObject({ name: "#1042", status: "shipped", payment: "Paid", currency: "INR" });
    expect(body.shipments[0]).toMatchObject({ courier: "Blue Dart", trackingNumber: "BD1", trackingUrl: "https://bluedart.test/BD1" });
    expect(body.liveTracking).toBe(false);
    expect(body.steps.find((s: { key: string }) => s.key === "delivered").done).toBe(false);
    expect(body.reviewToken).toBeNull();
    expect(res.body).not.toContain(t.shopifyOrderId);
    expect(res.headers["x-robots-tag"]).toContain("noindex");

    expect((await ctx.app.inject({ method: "GET", url: `/public/track/${t.shopifyOrderId}` })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: "GET", url: `/public/track/${t.id}` })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: "GET", url: `/public/track/${"x".repeat(32)}` })).statusCode).toBe(404);
    await systemDb.orderTracking.update({ where: { id: t.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await ctx.app.inject({ method: "GET", url: `/public/track/${token}` })).statusCode).toBe(404);
  });
});

describe("reviews", () => {
  it("takes one honest review per order and product, editable, and moderation needs a policy reason", async () => {
    const o = await owner();
    const { t, reviewToken } = await trackedOrder(o.store.id, o.ws, { deliveredAt: new Date(), status: "delivered" });
    await systemDb.whatsappMessage.create({ data: { workspaceId: o.ws, storeId: o.store.id, kind: "review_reminder", trackingId: t.id, dedupeKey: "rr", scheduledFor: new Date(Date.now() + 86_400_000) } });
    const form = await ctx.app.inject({ method: "GET", url: `/public/review/${reviewToken}` });
    expect(form.json().products).toEqual([{ productId: "10", title: "Kerala Saree" }]);
    const submit = (payload: unknown) => ctx.app.inject({ method: "POST", url: `/public/review/${reviewToken}`, headers: { "content-type": "application/json" }, payload });
    expect((await submit({ reviews: [{ productId: "99", rating: 5 }] })).statusCode).toBe(400);
    expect((await submit({ reviews: [{ productId: "", rating: 6 }] })).statusCode).toBe(400);
    expect((await submit({ reviews: [{ productId: "10", rating: 2 }, { productId: "10", rating: 3 }] })).statusCode).toBe(400);
    expect((await submit({ reviewerName: "Asha", reviews: [{ productId: "", rating: 2, body: "Late and the box was damaged." }, { productId: "10", rating: 4 }] })).statusCode).toBe(200);
    expect(await systemDb.customerReview.count({ where: { trackingId: t.id } })).toBe(2);
    // Editing replaces, never duplicates.
    expect((await submit({ reviewerName: "Asha", reviews: [{ productId: "", rating: 3, body: "Late, but support sorted it out." }] })).statusCode).toBe(200);
    expect(await systemDb.customerReview.count({ where: { trackingId: t.id } })).toBe(2);
    expect((await systemDb.customerReview.findFirstOrThrow({ where: { trackingId: t.id, productId: "" } })).rating).toBe(3);
    expect((await systemDb.whatsappMessage.findFirstOrThrow({ where: { dedupeKey: "rr" } })).status).toBe("cancelled");

    const list = await ctx.app.inject({ method: "GET", url: `${o.base}/reviews`, headers: o.headers });
    expect(list.json().summary.byStatus).toEqual({ pending: 2 });
    const id = list.json().reviews[0].id;
    expect((await ctx.app.inject({ method: "PATCH", url: `${o.base}/reviews/${id}`, headers: o.headers, payload: { status: "rejected" } })).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: "PATCH", url: `${o.base}/reviews/${id}`, headers: o.headers, payload: { status: "rejected", reason: "negative" } })).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: "PATCH", url: `${o.base}/reviews/${id}`, headers: o.headers, payload: { status: "published" } })).statusCode).toBe(200);
    const pub = await ctx.app.inject({ method: "GET", url: `/public/stores/${o.store.id}/reviews` });
    expect(pub.json()).toMatchObject({ count: 1 });
    expect(pub.headers["access-control-allow-origin"]).toBe("*");
  });

  it("a cancelled order can't be reviewed, and a forged token finds nothing", async () => {
    const o = await owner();
    const { reviewToken } = await trackedOrder(o.store.id, o.ws, { cancelledAt: new Date() });
    expect((await ctx.app.inject({ method: "POST", url: `/public/review/${reviewToken}`, headers: { "content-type": "application/json" }, payload: { reviews: [{ productId: "", rating: 5 }] } })).statusCode).toBe(409);
    expect((await ctx.app.inject({ method: "GET", url: `/public/review/${sha256Hex("x").slice(0, 32)}` })).statusCode).toBe(404);
  });
});

/** A store with a registered number, verified webhooks, the seasonal offer template, and four contacts (two can get marketing). */
async function connectedStore() {
    const o = await owner();
    await connectManual(o);
    await systemDb.whatsappConnection.updateMany({ where: { storeId: o.store.id }, data: { webhookVerifiedAt: new Date() } });
    const conn = await systemDb.whatsappConnection.findFirstOrThrow({ where: { storeId: o.store.id } });
    const lib = TEMPLATE_LIBRARY.find((t) => t.name === "insights_seasonal_offer")!;
    await systemDb.whatsappTemplate.create({
      data: { workspaceId: o.ws, storeId: o.store.id, connectionId: conn.id, metaId: "s", name: lib.name, language: "en", category: "MARKETING", status: "APPROVED", components: [{ type: "BODY", text: lib.body }, { type: "BUTTONS", buttons: [{ type: "URL", text: "Go", url: "https://x.test/r/{{1}}" }] }] },
    });
    await systemDb.whatsappSettings.update({ where: { storeId: o.store.id }, data: { config: whatsappConfigSchema.parse({}) as unknown as Prisma.InputJsonValue } });
    for (const [i, status, optedOut] of [[1, "opted_in", false], [2, "opted_in", false], [3, "opted_out", true], [4, "unknown", false]] as const) {
      await systemDb.whatsappContact.create({ data: { workspaceId: o.ws, storeId: o.store.id, phoneHash: `h${i}`, phoneEnc: waEncrypt(o.store.id, "phone", `91900000000${i}`), phoneMasked: `${i}`, marketingStatus: status, marketingSource: "whatsapp_keyword", optedOut } });
    }
    return o;
}

describe("campaigns", () => {
  const draft = {
    name: "Onam sale",
    occasion: "onam",
    templateName: "insights_seasonal_offer",
    templateLanguage: "en",
    variables: { discountPercentage: "20", endDate: "15 September" },
    linkUrl: "https://shop.test/collections/onam",
    audience: { segment: "all_opted_in" },
    startAt: new Date(Date.now() + 3600_000).toISOString(),
  };

  it("counts only opted-in customers, and scheduling needs the merchant to confirm that count", async () => {
    const o = await connectedStore();
    const est = await ctx.app.inject({ method: "POST", url: `${o.base}/campaigns/estimate`, headers: o.headers, payload: { audience: {} } });
    expect(est.json().recipients).toBe(2);
    const created = await ctx.app.inject({ method: "POST", url: `${o.base}/campaigns`, headers: o.headers, payload: draft });
    expect(created.statusCode).toBe(200);
    const id = created.json().campaign.id;
    expect(created.json().campaign.status).toBe("draft");
    const stale = await ctx.app.inject({ method: "POST", url: `${o.base}/campaigns/${id}/schedule`, headers: o.headers, payload: { confirmRecipients: 5 } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: "recipients_changed", recipients: 2 });
    const ok = await ctx.app.inject({ method: "POST", url: `${o.base}/campaigns/${id}/schedule`, headers: o.headers, payload: { confirmRecipients: 2 } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().campaign).toMatchObject({ status: "scheduled", estimatedRecipients: 2 });
    expect(await systemDb.auditLog.count({ where: { action: "whatsapp.campaign_scheduled" } })).toBe(1);
    // Editing a scheduled campaign takes it back to draft: it has to be confirmed again.
    await ctx.app.inject({ method: "PATCH", url: `${o.base}/campaigns/${id}`, headers: o.headers, payload: { name: "Onam sale 2" } });
    expect((await systemDb.whatsappCampaign.findUniqueOrThrow({ where: { id } })).status).toBe("draft");
    const cancel = await ctx.app.inject({ method: "POST", url: `${o.base}/campaigns/${id}/cancel`, headers: o.headers });
    expect(cancel.json().status).toBe("cancelled");
  });

  it("won't schedule before Meta can reach the webhook (opt-outs would be lost)", async () => {
    const o = await connectedStore();
    await systemDb.whatsappConnection.updateMany({ where: { storeId: o.store.id }, data: { webhookVerifiedAt: null } });
    const id = (await ctx.app.inject({ method: "POST", url: `${o.base}/campaigns`, headers: o.headers, payload: draft })).json().campaign.id;
    const res = await ctx.app.inject({ method: "POST", url: `${o.base}/campaigns/${id}/schedule`, headers: o.headers, payload: { confirmRecipients: 2 } });
    expect(res.json().error).toBe("webhook_unverified");
  });

  it("pauses, resumes and cancels only from the states that allow it, and cancelling stops what hasn't gone out", async () => {
    const o = await connectedStore();
    const act = (id: string, action: string) => ctx.app.inject({ method: "POST", url: `${o.base}/campaigns/${id}/${action}`, headers: o.headers });
    const id = (await ctx.app.inject({ method: "POST", url: `${o.base}/campaigns`, headers: o.headers, payload: draft })).json().campaign.id;
    const early = await act(id, "pause");
    expect(early.statusCode).toBe(409);
    expect(early.json()).toEqual({ error: "invalid_state", message: "A draft campaign can't be paused." });
    await ctx.app.inject({ method: "POST", url: `${o.base}/campaigns/${id}/schedule`, headers: o.headers, payload: { confirmRecipients: 2 } });
    expect((await act(id, "pause")).json()).toEqual({ ok: true, status: "paused" });
    expect((await act(id, "pause")).statusCode).toBe(409);
    // It never started, so resuming schedules it again rather than sending.
    expect((await act(id, "resume")).json()).toEqual({ ok: true, status: "scheduled" });
    const waiting = await systemDb.whatsappMessage.create({ data: { workspaceId: o.ws, storeId: o.store.id, kind: "campaign", dedupeKey: `campaign:${id}:x`, scheduledFor: new Date(), campaignId: id, paramsEnc: "p" } });
    expect((await act(id, "cancel")).json()).toEqual({ ok: true, status: "cancelled" });
    expect(await systemDb.whatsappMessage.findUniqueOrThrow({ where: { id: waiting.id } })).toMatchObject({ status: "cancelled", reason: "campaign_cancelled", paramsEnc: null });
    expect((await act(id, "resume")).statusCode).toBe(409);
    const del = await ctx.app.inject({ method: "DELETE", url: `${o.base}/campaigns/${id}`, headers: o.headers });
    expect(del.json().error).toBe("not_draft");
    expect(await systemDb.auditLog.count({ where: { action: { in: ["whatsapp.campaign_paused", "whatsapp.campaign_resumed", "whatsapp.campaign_cancelled"] } } })).toBe(3);
  });
});

describe("message history", () => {
  async function message(o: Awaited<ReturnType<typeof owner>>, kind: string, status: string, paramsEnc: string | null = "p") {
    return systemDb.whatsappMessage.create({ data: { workspaceId: o.ws, storeId: o.store.id, kind, dedupeKey: `${kind}:${status}:${Math.random()}`, scheduledFor: new Date(), status, paramsEnc } });
  }

  it("filters by group, and offers retry only for what can be sent again", async () => {
    const o = await owner();
    await message(o, "abandoned_cart_1", "failed");
    await message(o, "abandoned_cart_2", "sent");
    await message(o, "order_confirmation", "failed", null);
    const list = await ctx.app.inject({ method: "GET", url: `${o.base}/messages?group=carts`, headers: o.headers });
    const rows = list.json().messages as Array<{ kind: string; status: string; canRetry: boolean }>;
    expect(rows.map((m) => m.kind).sort()).toEqual(["abandoned_cart_1", "abandoned_cart_2"]);
    expect(rows.find((m) => m.status === "failed")!.canRetry).toBe(true);
    expect(rows.find((m) => m.status === "sent")!.canRetry).toBe(false);
    const all = await ctx.app.inject({ method: "GET", url: `${o.base}/messages?group=nonsense`, headers: o.headers });
    expect(all.json().messages).toHaveLength(3);
  });

  it("retries a failed message, and says why one that went out or was cleared can't be", async () => {
    const o = await owner();
    const failed = await message(o, "order_confirmation", "failed");
    const sent = await message(o, "order_confirmation", "sent");
    const cleared = await message(o, "order_confirmation", "failed", null);
    const retry = (id: string) => ctx.app.inject({ method: "POST", url: `${o.base}/messages/${id}/retry`, headers: o.headers });
    expect((await retry(failed.id)).statusCode).toBe(200);
    expect((await systemDb.whatsappMessage.findUniqueOrThrow({ where: { id: failed.id } })).status).toBe("scheduled");
    const refused = await retry(sent.id);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ error: "not_retryable", message: "Only failed, skipped or cancelled messages can be retried" });
    expect((await retry(cleared.id)).json().error).toBe("not_retryable");
  });

  it("cancels a message that hasn't gone out, once, and never another store's", async () => {
    const o = await owner();
    const other = await owner("u2", "p@shop.test");
    const waiting = await message(o, "order_confirmation", "scheduled");
    const theirs = await message(other, "order_confirmation", "scheduled");
    const cancel = (id: string) => ctx.app.inject({ method: "POST", url: `${o.base}/messages/${id}/cancel`, headers: o.headers });
    expect((await cancel(waiting.id)).statusCode).toBe(200);
    expect(await systemDb.whatsappMessage.findUniqueOrThrow({ where: { id: waiting.id } })).toMatchObject({ status: "cancelled", reason: "cancelled_by_merchant" });
    expect((await cancel(waiting.id)).json().error).toBe("not_cancellable");
    expect((await cancel(theirs.id)).statusCode).toBe(409);
    expect((await systemDb.whatsappMessage.findUniqueOrThrow({ where: { id: theirs.id } })).status).toBe("scheduled");
  });

  it("refuses to cancel without saying what (it would hit every store)", async () => {
    await expect(cancelScheduled({}, "oops")).rejects.toThrow(/needs a message/);
  });
});

describe("cart reminders sent by hand", () => {
  async function cartStore() {
    const o = await connectedStore();
    const conn = await systemDb.whatsappConnection.findFirstOrThrow({ where: { storeId: o.store.id } });
    const lib = TEMPLATE_LIBRARY.find((t) => t.name === "insights_cart_reminder")!;
    await systemDb.whatsappTemplate.create({
      data: { workspaceId: o.ws, storeId: o.store.id, connectionId: conn.id, metaId: "c", name: lib.name, language: "en", category: "MARKETING", status: "APPROVED", components: [{ type: "BODY", text: lib.body }] },
    });
    const config = whatsappConfigSchema.parse({ notifications: { abandoned_cart_1: { enabled: true, templateName: lib.name, language: "en", mapping: lib.mapping } } });
    await systemDb.whatsappSettings.update({ where: { storeId: o.store.id }, data: { config: config as unknown as Prisma.InputJsonValue } });
    return o;
  }

  async function checkout(o: Awaited<ReturnType<typeof owner>>, phoneHash: string, status = "open") {
    const contact = await systemDb.whatsappContact.findFirstOrThrow({ where: { storeId: o.store.id, phoneHash } });
    return systemDb.abandonedCheckout.create({
      data: {
        workspaceId: o.ws,
        storeId: o.store.id,
        checkoutToken: `ck-${phoneHash}-${status}`,
        contactId: contact.id,
        phoneMasked: contact.phoneMasked,
        currency: "INR",
        totalPrice: 2499,
        items: [],
        recoveryUrlEnc: waEncrypt(o.store.id, "recovery", "https://shop.test/checkouts/abc"),
        status,
        checkoutCreatedAt: new Date(),
        lastActivityAt: new Date(),
      },
    });
  }

  it("sends once to a customer who agreed to marketing, and says why not otherwise", async () => {
    const o = await cartStore();
    const remind = (id: string) => ctx.app.inject({ method: "POST", url: `${o.base}/carts/${id}/remind`, headers: o.headers });
    const ok = await checkout(o, "h1");
    const sent = await remind(ok.id);
    expect(sent.statusCode).toBe(200);
    expect(sent.json().status).toBe("scheduled");
    expect(await systemDb.whatsappMessage.findUniqueOrThrow({ where: { id: sent.json().messageId } })).toMatchObject({ kind: "abandoned_cart_1", checkoutId: ok.id });
    expect((await remind(ok.id)).json().error).toBe("already_reminded");
    // h4 never agreed to WhatsApp marketing, and cart reminders are marketing.
    expect((await remind((await checkout(o, "h4")).id)).json().error).toBe("no_marketing_consent");
    expect((await remind((await checkout(o, "h2", "completed")).id)).json()).toEqual({ error: "checkout_closed", message: "This checkout has been completed or has expired." });
  });
});

describe("consent summary", () => {
  it("counts Shopify SMS consent as marketing consent only when the merchant says it covers WhatsApp", async () => {
    const o = await connectedStore();
    await systemDb.whatsappContact.create({ data: { workspaceId: o.ws, storeId: o.store.id, phoneHash: "h5", phoneEnc: waEncrypt(o.store.id, "phone", "919000000005"), phoneMasked: "5", marketingStatus: "opted_in", marketingSource: "shopify_sms", optedOut: false } });
    const summary = () => ctx.app.inject({ method: "GET", url: `${o.base}/contacts/summary`, headers: o.headers }).then((r) => r.json());
    expect(await summary()).toEqual({ contacts: 5, marketingEligible: 2, optedInViaShopifySms: 1, marketingOptedOut: 0, optedOutOfEverything: 1 });
    await systemDb.whatsappSettings.update({ where: { storeId: o.store.id }, data: { config: whatsappConfigSchema.parse({ smsConsentCountsForMarketing: true }) as unknown as Prisma.InputJsonValue } });
    expect((await summary()).marketingEligible).toBe(3);
  });
});

describe("tracked links", () => {
  it("redirects and counts a click once, and link previews don't count", async () => {
    const o = await owner();
    await systemDb.whatsappMessage.create({
      data: { workspaceId: o.ws, storeId: o.store.id, kind: "campaign", dedupeKey: "k", scheduledFor: new Date(), status: "delivered", clickCode: "abcdefghij12", clickUrlEnc: waEncrypt(o.store.id, "click", "https://shop.test/sale") },
    });
    const preview = await ctx.app.inject({ method: "GET", url: "/r/abcdefghij12", headers: { "user-agent": "WhatsApp/2.23.20.0 A" } });
    expect(preview.statusCode).toBe(302);
    expect((await systemDb.whatsappMessage.findFirstOrThrow({ where: { clickCode: "abcdefghij12" } })).clickedAt).toBeNull();
    const click = await ctx.app.inject({ method: "GET", url: "/r/abcdefghij12", headers: { "user-agent": "Mozilla/5.0" } });
    expect(click.headers.location).toBe("https://shop.test/sale");
    expect((await systemDb.whatsappMessage.findFirstOrThrow({ where: { clickCode: "abcdefghij12" } })).clickedAt).not.toBeNull();
    expect((await ctx.app.inject({ method: "GET", url: "/r/nosuchcode00" })).statusCode).toBe(404);
  });
});

describe("limits and automations", () => {
  it("rate-limits test sends per store", async () => {
    const o = await owner();
    await connectManual(o);
    const send = () => ctx.app.inject({ method: "POST", url: `${o.base}/test`, headers: o.headers, payload: { templateName: TEMPLATE_LIBRARY[0]!.name, language: "en", phone: "+91 98765 43210" } });
    for (let i = 0; i < 10; i++) expect((await send()).statusCode).toBe(200);
    expect((await send()).statusCode).toBe(429);
    // Test sends never create a customer contact.
    expect(await systemDb.whatsappContact.count()).toBe(0);
  });

  it("refuses an automation that would undo another one", async () => {
    const o = await owner();
    await connectManual(o);
    const lib = TEMPLATE_LIBRARY[0]!;
    const send = await ctx.app.inject({
      method: "POST",
      url: `${o.base}/automations`,
      headers: o.headers,
      payload: { name: "Thanks", enabled: true, trigger: "order_created", action: { type: "send_template", templateName: lib.name, language: "en", mapping: lib.mapping } },
    });
    expect(send.statusCode).toBe(200);
    const undo = await ctx.app.inject({ method: "POST", url: `${o.base}/automations`, headers: o.headers, payload: { name: "Quiet", enabled: true, trigger: "order_created", action: { type: "cancel_pending", kinds: ["automation"] } } });
    expect(undo.statusCode).toBe(409);
    const missing = await ctx.app.inject({ method: "POST", url: `${o.base}/automations`, headers: o.headers, payload: { name: "X", enabled: false, trigger: "order_created", action: { type: "send_template", templateName: "nope", language: "en" } } });
    expect(missing.json().error).toBe("template_missing");
  });

  it("tests a rule without acting, and sends its template only to a valid number", async () => {
    const o = await owner();
    await connectManual(o);
    const lib = TEMPLATE_LIBRARY[0]!;
    const rule = await ctx.app.inject({
      method: "POST",
      url: `${o.base}/automations`,
      headers: o.headers,
      payload: { name: "Thanks", enabled: false, trigger: "order_created", action: { type: "send_template", templateName: lib.name, language: "en", mapping: lib.mapping } },
    });
    const test = (payload: object) => ctx.app.inject({ method: "POST", url: `${o.base}/automations/${rule.json().id}/test`, headers: o.headers, payload });
    const dry = await test({});
    expect(dry.json()).toMatchObject({ valid: true, wouldRun: true, order: null, testMessageId: null });
    expect((await test({ phone: "not a number" })).json().error).toBe("invalid_phone");
    const sent = await test({ phone: "+91 98765 43210" });
    expect(sent.json().testMessageId).toEqual(expect.any(String));
    // Each test that ran is in the rule's history; the refused number never got that far.
    expect(await systemDb.whatsappAutomationRun.count({ where: { outcome: "test" } })).toBe(2);
  });
});


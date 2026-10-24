import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { systemDb } from "@app/db";
import { dispatchCampaign, processWebhookEvent, sendWaMessage, whatsappOnShopifyEvent, type FetchLike } from "@app/core";
import { LEGACY_GRANTS, signMetaBody } from "@app/shared";
import { clean, createStore, createWorkspace, setup, signIn, teardown, type TestCtx } from "./helpers.js";

/**
 * WhatsApp Automation end to end, with Meta's Graph API and Nango faked: connecting with Embedded
 * Signup (the code exchange, the token inspector, the account and number, the token kept at Nango,
 * webhooks, registration), the PIN step, tenant isolation, Meta's webhooks (signature, dedupe,
 * statuses out of order, STOP), sending, workflows from Shopify events, campaigns, custom events and
 * disconnecting. No message leaves the machine.
 */

let ctx: TestCtx;
beforeAll(async () => (ctx = await setup()));
afterAll(async () => teardown(ctx));

const APP_ID = "555000111";
const APP_SECRET = "wa_app_secret_for_tests";
const WABA = "1020304050";
const PHONE = "9080706050";
const TOKEN = "EAAGbusinessTokenForTests";
const ENV = {
  WHATSAPP_APP_ID: APP_ID,
  WHATSAPP_APP_SECRET: APP_SECRET,
  WHATSAPP_CONFIG_ID: "cfg_123",
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: "verify_tok_123",
  WHATSAPP_API_VERSION: "v26.0",
  NANGO_SECRET_KEY: "nango_secret_for_tests",
};
const OFF = Object.fromEntries(Object.keys(ENV).map((k) => [k, ""]));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface Fake {
  nango: Map<string, { apiKey: string; tags: Record<string, string> }>;
  nangoDeleted: string[];
  integrationMade: boolean;
  registered: Set<string>;
  /** A PIN the number already has (registration with another one is refused, as Meta does). */
  existingPin: string | null;
  sends: Array<Record<string, unknown>>;
  templates: Array<Record<string, unknown>>;
  codes: Record<string, string>;
  scopes: string[];
  grantedWabas: string[];
  appId: string;
  phones: Array<{ id: string; display_phone_number: string; verified_name: string }>;
  sendError: { status: number; body: unknown } | null;
  subscribed: boolean;
  fetch: FetchLike;
}

function fakeMeta(): Fake {
  const f: Fake = {
    nango: new Map(),
    nangoDeleted: [],
    integrationMade: false,
    registered: new Set(),
    existingPin: null,
    sends: [],
    templates: [{ id: "t1", name: "order_confirmation", language: "en", category: "UTILITY", status: "APPROVED", components: [{ type: "BODY", text: "Hi {{1}}, your order {{2}} is confirmed. Thank you!" }] }],
    codes: { good_code_1234567890: TOKEN },
    scopes: ["whatsapp_business_management", "whatsapp_business_messaging", "public_profile"],
    grantedWabas: [WABA],
    appId: APP_ID,
    phones: [{ id: PHONE, display_phone_number: "+61 400 000 001", verified_name: "Acme" }],
    sendError: null,
    subscribed: false,
    fetch: async (input, init) => {
      const u = new URL(String(input));
      const method = init?.method ?? "GET";
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      if (u.host === "api.nango.dev") {
        expect(auth).toBe(`Bearer ${ENV.NANGO_SECRET_KEY}`);
        if (u.pathname === "/integrations/whatsapp-business") return f.integrationMade ? json({ data: { unique_key: "whatsapp-business", provider: "whatsapp-business" } }) : json({ error: { code: "not_found" } }, 404);
        if (u.pathname === "/integrations" && method === "POST") {
          expect(JSON.parse(String(init?.body))).toMatchObject({ unique_key: "whatsapp-business", provider: "whatsapp-business" });
          f.integrationMade = true;
          return json({ data: {} }, 201);
        }
        if (u.pathname === "/connections" && method === "POST") {
          const b = JSON.parse(String(init?.body)) as { connection_id: string; provider_config_key: string; credentials: { type: string; apiKey: string }; tags: Record<string, string> };
          expect(b.provider_config_key).toBe("whatsapp-business");
          expect(b.credentials.type).toBe("API_KEY");
          f.nango.set(b.connection_id, { apiKey: b.credentials.apiKey, tags: b.tags });
          return json({}, 201);
        }
        const m = /^\/connections\/([^/]+)$/.exec(u.pathname);
        if (m && method === "GET") {
          const c = f.nango.get(decodeURIComponent(m[1]!));
          return c ? json({ credentials: { type: "API_KEY", apiKey: c.apiKey } }) : json({ error: { code: "not_found" } }, 404);
        }
        if (m && method === "DELETE") {
          f.nangoDeleted.push(decodeURIComponent(m[1]!));
          f.nango.delete(decodeURIComponent(m[1]!));
          return new Response(null, { status: 204 });
        }
        throw new Error(`unexpected Nango call ${method} ${u.pathname}`);
      }
      if (u.host !== "graph.facebook.com") throw new Error(`unexpected call ${u}`);
      // Tokens travel in the header, never the URL.
      expect(u.searchParams.has("access_token")).toBe(false);
      const path = u.pathname.replace(/^\/v26\.0\//, "");
      if (path === "oauth/access_token") {
        expect(u.searchParams.get("client_secret")).toBe(APP_SECRET);
        const t = f.codes[u.searchParams.get("code") ?? ""];
        return t ? json({ access_token: t, token_type: "bearer" }) : json({ error: { message: "Invalid verification code", type: "OAuthException", code: 100 } }, 400);
      }
      if (path === "debug_token") {
        expect(auth).toBe(`Bearer ${APP_ID}|${APP_SECRET}`);
        return json({ data: { app_id: f.appId, is_valid: true, scopes: f.scopes, granular_scopes: f.scopes.filter((s) => s.startsWith("whatsapp")).map((scope) => ({ scope, target_ids: f.grantedWabas })) } });
      }
      // Every business-token call is the business's own and carries the proof.
      expect(auth).toBe(`Bearer ${TOKEN}`);
      expect(u.searchParams.get("appsecret_proof")).toMatch(/^[0-9a-f]{64}$/);
      if (path === WABA) return json({ id: WABA, name: "Acme WhatsApp" });
      if (path === `${WABA}/phone_numbers`) return json({ data: f.phones.map((p) => ({ ...p, platform_type: f.registered.has(p.id) ? "CLOUD_API" : "NOT_APPLICABLE", quality_rating: "GREEN" })) });
      if (path === `${WABA}/subscribed_apps` && method === "POST") {
        f.subscribed = true;
        return json({ success: true });
      }
      if (path === `${WABA}/subscribed_apps` && method === "GET") return json({ data: f.subscribed ? [{ whatsapp_business_api_data: { id: APP_ID } }] : [] });
      if (path === `${WABA}/subscribed_apps` && method === "DELETE") {
        f.subscribed = false;
        return json({ success: true });
      }
      if (path === `${WABA}/message_templates` && method === "GET") return json({ data: f.templates });
      if (path === `${WABA}/message_templates` && method === "POST") {
        const b = JSON.parse(String(init?.body)) as Record<string, unknown>;
        f.templates.push({ ...b, id: `t${f.templates.length + 1}`, status: "PENDING" });
        return json({ id: `t${f.templates.length}`, status: "PENDING", category: b.category });
      }
      const phone = f.phones.find((p) => path === p.id || path.startsWith(`${p.id}/`));
      if (phone && path === phone.id) {
        return json({ ...phone, platform_type: f.registered.has(phone.id) ? "CLOUD_API" : "NOT_APPLICABLE", quality_rating: "GREEN", messaging_limit_tier: "TIER_1K", status: "CONNECTED" });
      }
      if (phone && path === `${phone.id}/register`) {
        const { pin } = JSON.parse(String(init?.body)) as { pin: string };
        if (f.existingPin && pin !== f.existingPin) return json({ error: { message: "Two step verification PIN Mismatch", code: 133005 } }, 400);
        f.registered.add(phone.id);
        return json({ success: true });
      }
      if (phone && path === `${phone.id}/messages`) {
        if (f.sendError) return json(f.sendError.body, f.sendError.status);
        const b = JSON.parse(String(init?.body)) as Record<string, unknown>;
        f.sends.push(b);
        return json({ messaging_product: "whatsapp", messages: [{ id: `wamid.${f.sends.length}` }] });
      }
      throw new Error(`unexpected Graph call ${method} ${path}`);
    },
  };
  return f;
}

let meta: Fake;
beforeEach(async () => {
  await clean(ctx);
  ctx.setEnv(ENV);
  meta = fakeMeta();
  ctx.setFetch(meta.fetch);
});

async function owner(shop = "acme.myshopify.com", uid = "owner") {
  const o = await signIn(ctx, uid, `${uid}@acme.test`);
  const ws = await createWorkspace(ctx, o.headers);
  const store = await createStore(ws, shop, ["read_orders", "read_customers"], { name: "Acme Store", timezone: "Australia/Melbourne" });
  return { ...o, ws, store, base: `/workspaces/${ws}/stores/${store.id}/whatsapp` };
}

const call = (method: string, url: string, headers: Record<string, string>, payload?: unknown) => ctx.app.inject({ method, url, headers, ...(payload !== undefined ? { payload } : {}) });

async function connect(o: Awaited<ReturnType<typeof owner>>, finish: Record<string, unknown> = {}) {
  const start = await call("POST", `${o.base}/connect/start`, o.headers);
  expect(start.statusCode).toBe(200);
  const { nonce } = start.json();
  return call("POST", `${o.base}/connect/finish`, o.headers, { nonce, code: "good_code_1234567890", flow: "cloud_api", wabaId: WABA, phoneNumberId: PHONE, businessId: "777", ...finish });
}

/** Run every queued WhatsApp job the way the worker does (sends and webhook deliveries), until none is left. */
async function drain() {
  for (let i = 0; i < 20; i++) {
    const jobs = ctx.deps.queues.sent.sync.splice(0) as unknown as Array<{ kind: string; messageId?: string; eventId?: string; campaignId?: string; storeId?: string }>;
    if (!jobs.length) return;
    for (const j of jobs) {
      if (j.kind === "whatsapp") await sendWaMessage(j.messageId!, ctx.deps);
      else if (j.kind === "whatsapp_webhook") await processWebhookEvent(j.eventId!, ctx.deps);
      else if (j.kind === "whatsapp_dispatch") await dispatchCampaign({ campaignId: j.campaignId!, storeId: j.storeId! }, ctx.deps);
    }
  }
}

const signedWebhook = (body: unknown) => {
  const raw = JSON.stringify(body);
  return call("POST", "/webhooks/whatsapp", { "content-type": "application/json", "x-hub-signature-256": signMetaBody(raw, APP_SECRET) }, raw);
};

describe("connecting", () => {
  it("says it isn't switched on until every setting is there, and names them only to who can fix it", async () => {
    ctx.setEnv(OFF);
    const o = await owner();
    const r = (await call("GET", o.base, o.headers)).json();
    expect(r.platform).toEqual({ ready: false, missing: ["WHATSAPP_APP_ID", "WHATSAPP_CONFIG_ID", "WHATSAPP_APP_SECRET", "WHATSAPP_WEBHOOK_VERIFY_TOKEN", "NANGO_SECRET_KEY"] });
    expect(r.connection).toBeNull();
    expect((await call("POST", `${o.base}/connect/start`, o.headers)).json()).toMatchObject({ error: "not_configured" });
  });

  it("connects with Embedded Signup: token to Nango, webhooks, registration, templates", async () => {
    const o = await owner();
    const res = await connect(o);
    expect(res.statusCode).toBe(200);
    const { connection } = res.json();
    expect(connection).toMatchObject({ status: "active", wabaId: WABA, wabaName: "Acme WhatsApp", phoneNumberId: PHONE, displayPhoneNumber: "+61 400 000 001", registered: true, subscribed: true, hasPin: true, dailyConversationLimit: 1000 });
    // The token is at Nango, under the store's own connection, tagged with ids only.
    expect(meta.integrationMade).toBe(true);
    expect(meta.nango.get(`wa-${o.store.id}`)).toEqual({ apiKey: TOKEN, tags: { end_user_id: o.user.id, organization_id: o.ws, bi_store: o.store.id, bi_provider: "whatsapp", bi_waba: WABA } });
    const row = await systemDb.waConnection.findUniqueOrThrow({ where: { storeId: o.store.id } });
    expect(JSON.stringify(row)).not.toContain(TOKEN);
    expect(row.pinEnc).toBeTruthy();
    expect(await systemDb.waTemplate.count({ where: { storeId: o.store.id, status: "APPROVED" } })).toBe(1);
    expect(await systemDb.auditLog.count({ where: { workspaceId: o.ws, action: "whatsapp.connected" } })).toBe(1);
    // Nothing the browser sees carries a token or the PIN.
    const overview = await call("GET", o.base, o.headers);
    expect(overview.body).not.toContain(TOKEN);
    expect(overview.json().checklist).toMatchObject({ connected: true, registered: true, subscribed: true, approvedTemplates: 1, consentChosen: false });
    // The PIN is shown to owners only, and audited.
    const pin = await call("POST", `${o.base}/pin`, o.headers);
    expect(pin.json().pin).toMatch(/^\d{6}$/);
    expect(await systemDb.auditLog.count({ where: { workspaceId: o.ws, action: "whatsapp.pin_viewed" } })).toBe(1);
  });

  it("refuses a sign-in it didn't start, an expired code, another app's token, missing permissions and an account not granted", async () => {
    const o = await owner();
    const other = await signIn(ctx, "intruder", "intruder@acme.test");
    await systemDb.membership.create({ data: { workspaceId: o.ws, userId: other.user.id, role: "admin" } });
    const { nonce } = (await call("POST", `${o.base}/connect/start`, o.headers)).json();
    // The nonce is the starter's own.
    expect((await call("POST", `${o.base}/connect/finish`, other.headers, { nonce, code: "good_code_1234567890", wabaId: WABA, phoneNumberId: PHONE })).json().error).toBe("state_mismatch");
    // And single-use: taken by that try.
    expect((await call("POST", `${o.base}/connect/finish`, o.headers, { nonce, code: "good_code_1234567890", wabaId: WABA, phoneNumberId: PHONE })).json().error).toBe("state_mismatch");
    expect((await connect(o, { code: "expired_code_1234567890" })).json().error).toBe("code_rejected");
    meta.appId = "999";
    expect((await connect(o)).json().error).toBe("wrong_app");
    meta.appId = APP_ID;
    meta.scopes = ["whatsapp_business_management"];
    expect((await connect(o)).json().error).toBe("permission_missing");
    meta.scopes = ["whatsapp_business_management", "whatsapp_business_messaging"];
    expect((await connect(o, { wabaId: "1111111111" })).json().error).toBe("waba_not_granted");
    expect(await systemDb.waConnection.count()).toBe(0);
    // Nothing was handed to Nango for any of them.
    expect(meta.nango.size).toBe(0);
  });

  it("asks for the number's own PIN when it has one, and finishes with it", async () => {
    const o = await owner();
    meta.existingPin = "246810";
    const { connection } = (await connect(o)).json();
    expect(connection).toMatchObject({ status: "action_required", step: "pin_required", registered: false, hasPin: false });
    expect((await call("POST", `${o.base}/connect/pin`, o.headers, { pin: "111111" })).json().error).toBe("pin_mismatch");
    const done = await call("POST", `${o.base}/connect/pin`, o.headers, { pin: "246810" });
    expect(done.json().connection).toMatchObject({ status: "active", step: null, registered: true });
  });

  it("lets the merchant choose among several numbers", async () => {
    const o = await owner();
    meta.phones.push({ id: "9080706051", display_phone_number: "+61 400 000 002", verified_name: "Acme 2" });
    const { connection } = (await connect(o, { phoneNumberId: null })).json();
    expect(connection).toMatchObject({ status: "action_required", step: "choose_number", phoneNumberId: null });
    const numbers = (await call("GET", `${o.base}/connect/numbers`, o.headers)).json().numbers;
    expect(numbers.map((n: { id: string }) => n.id)).toEqual([PHONE, "9080706051"]);
    const chosen = await call("POST", `${o.base}/connect/number`, o.headers, { phoneNumberId: "9080706051" });
    expect(chosen.json().connection).toMatchObject({ status: "active", phoneNumberId: "9080706051", registered: true });
  });
});

describe("tenant isolation", () => {
  it("keeps one workspace's WhatsApp out of another's reach", async () => {
    const a = await owner();
    await connect(a);
    const b = await owner("other.myshopify.com", "owner2");
    // B can't read or act on A's store by its id.
    for (const [m, path] of [
      ["GET", a.base],
      ["GET", `${a.base}/messages`],
      ["POST", `${a.base}/connect/start`],
      ["DELETE", a.base],
      ["POST", `${a.base}/pin`],
    ] as const) {
      expect((await call(m, path, b.headers)).statusCode, `${m} ${path}`).toBe(404);
    }
    // And the same number can't be connected to B's store too.
    expect((await connect(b)).json().error).toBe("number_in_use");
    expect((await systemDb.waConnection.findUniqueOrThrow({ where: { storeId: a.store.id } })).status).toBe("active");
  });

  it("lets members do only what they were granted", async () => {
    const o = await owner();
    await connect(o);
    const v = await signIn(ctx, "viewer", "viewer@acme.test");
    await systemDb.membership.create({ data: { workspaceId: o.ws, userId: v.user.id, role: "viewer", permissions: [...LEGACY_GRANTS.viewer, "marketing.campaigns"] } });
    const r = await call("GET", o.base, v.headers);
    expect(r.statusCode).toBe(200);
    expect(r.json().can).toEqual({ connect: false, manage: false, contacts: false, pin: false });
    expect(r.json().platform.missing).toBeUndefined();
    expect((await call("GET", `${o.base}/contacts`, v.headers)).statusCode).toBe(403);
    expect((await call("POST", `${o.base}/connect/start`, v.headers)).statusCode).toBe(403);
    expect((await call("DELETE", o.base, v.headers)).statusCode).toBe(403);
    expect((await call("PUT", `${o.base}/settings`, v.headers, { orderUpdates: "checkout_notice" })).statusCode).toBe(403);
  });
});

describe("Meta's webhooks", () => {
  it("answers the verification handshake only with bizinsights' verify token", async () => {
    const ok = await call("GET", "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify_tok_123&hub.challenge=abc123", {});
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe("abc123");
    expect((await call("GET", "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=abc123", {})).statusCode).toBe(403);
  });

  it("stores a signed delivery once, applies statuses forward only, and records STOP", async () => {
    const o = await owner();
    await connect(o);
    await call("PUT", `${o.base}/settings`, o.headers, { orderUpdates: "checkout_notice", testPhone: "+61411222333" });
    // A message to a customer, sent (accepted by Meta).
    const sent = await call("POST", `${o.base}/messages`, o.headers, {
      requestId: "8a6e0f2e-1f39-4c5a-9a1e-6f9e2b0c1d11",
      to: { phone: "+61 412 345 678" },
      message: { kind: "template", template: { name: "order_confirmation", language: "en" }, mapping: { body: [{ source: "customer_first_name" }, { source: "custom_text", text: "#1001" }], buttons: [] } },
    });
    expect(sent.statusCode).toBe(202);
    await drain();
    const m = await systemDb.waMessage.findFirstOrThrow({ where: { storeId: o.store.id, source: "manual" } });
    expect(m).toMatchObject({ status: "accepted", wamid: "wamid.1", payloadEnc: null });
    expect(meta.sends[0]).toMatchObject({ to: "61412345678", type: "template", biz_opaque_callback_data: m.id, template: { name: "order_confirmation", language: { code: "en" } } });

    const status = (s: string, ts: number) => ({
      object: "whatsapp_business_account",
      entry: [{ id: WABA, changes: [{ field: "messages", value: { metadata: { phone_number_id: PHONE }, statuses: [{ id: "wamid.1", status: s, timestamp: String(ts), biz_opaque_callback_data: m.id }] } }] }],
    });
    // Unsigned: refused before anything is read.
    expect((await call("POST", "/webhooks/whatsapp", { "content-type": "application/json", "x-hub-signature-256": "sha256=00" }, JSON.stringify(status("read", 3)))).statusCode).toBe(401);
    // Delivered arrives before sent; then a late failure. Meta also redelivers the same body.
    expect((await signedWebhook(status("delivered", 1_800_000_002))).statusCode).toBe(200);
    expect((await signedWebhook(status("delivered", 1_800_000_002))).json()).toMatchObject({ duplicate: true });
    expect((await signedWebhook(status("sent", 1_800_000_001))).statusCode).toBe(200);
    expect((await signedWebhook(status("failed", 1_800_000_003))).statusCode).toBe(200);
    expect(await systemDb.waWebhookEvent.count()).toBe(3);
    await drain();
    const after = await systemDb.waMessage.findUniqueOrThrow({ where: { id: m.id } });
    expect(after.status).toBe("delivered");
    expect(after.sentAt?.getTime()).toBe(1_800_000_001_000);
    expect(after.deliveredAt?.getTime()).toBe(1_800_000_002_000);
    expect(await systemDb.waMessageEvent.count({ where: { messageId: m.id } })).toBe(3);
    // Processed deliveries keep no body.
    expect(await systemDb.waWebhookEvent.count({ where: { status: "processed", bodyEnc: null } })).toBe(3);

    // The customer replies STOP: nothing more is sent to them, and their waiting message is cancelled.
    await call("POST", `${o.base}/messages`, o.headers, {
      requestId: "8a6e0f2e-1f39-4c5a-9a1e-6f9e2b0c1d12",
      to: { phone: "+61412345678" },
      message: { kind: "template", template: { name: "order_confirmation", language: "en" }, mapping: { body: [{ source: "customer_first_name" }, { source: "custom_text", text: "#1002" }], buttons: [] } },
    });
    await signedWebhook({
      object: "whatsapp_business_account",
      entry: [{ id: WABA, changes: [{ field: "messages", value: { metadata: { phone_number_id: PHONE }, messages: [{ id: "wamid.in1", from: "61412345678", timestamp: "1800000010", type: "text", text: { body: "STOP" } }] } }] }],
    });
    // The webhook is applied before the queued send runs.
    const jobs = ctx.deps.queues.sent.sync.splice(0) as unknown as Array<{ kind: string; messageId?: string; eventId?: string }>;
    for (const j of jobs.filter((x) => x.kind === "whatsapp_webhook")) await processWebhookEvent(j.eventId!, ctx.deps);
    for (const j of jobs.filter((x) => x.kind === "whatsapp")) await sendWaMessage(j.messageId!, ctx.deps);
    const contact = await systemDb.waContact.findFirstOrThrow({ where: { storeId: o.store.id } });
    expect(contact.optedOut).toBe(true);
    expect(await systemDb.waConsentEvent.count({ where: { contactId: contact.id, source: "whatsapp_stop" } })).toBe(1);
    expect(await systemDb.waMessage.count({ where: { storeId: o.store.id, direction: "in" } })).toBe(1);
    expect(meta.sends).toHaveLength(1);
    const refused = await call("POST", `${o.base}/messages`, o.headers, {
      requestId: "8a6e0f2e-1f39-4c5a-9a1e-6f9e2b0c1d13",
      to: { contactId: contact.id },
      message: { kind: "template", template: { name: "order_confirmation", language: "en" }, mapping: { body: [{ source: "customer_first_name" }, { source: "custom_text", text: "#1003" }], buttons: [] } },
    });
    expect(refused.json().error).toBe("opted_out");
  });
});

describe("sending", () => {
  it("retries rate limits, holds for a reconnect, and never repeats a send that got no answer", async () => {
    const o = await owner();
    await connect(o);
    await call("PUT", `${o.base}/settings`, o.headers, { orderUpdates: "checkout_notice", testPhone: "+61411222333" });
    const send = (id: string) =>
      call("POST", `${o.base}/messages`, o.headers, {
        requestId: id,
        to: { phone: "+61412345678" },
        message: { kind: "template", template: { name: "order_confirmation", language: "en" }, mapping: { body: [{ source: "customer_first_name" }, { source: "custom_text", text: "#1" }], buttons: [] } },
      });
    // Rate limited: back to the queue for later, one attempt spent.
    meta.sendError = { status: 400, body: { error: { message: "Rate limit hit", code: 130429 } } };
    await send("8a6e0f2e-1f39-4c5a-9a1e-6f9e2b0c1d21");
    await drain();
    let m = await systemDb.waMessage.findFirstOrThrow({ where: { storeId: o.store.id } });
    expect(m).toMatchObject({ status: "queued", attempts: 1 });
    expect(m.sendAfter.getTime()).toBeGreaterThan(Date.now() + 20_000);
    // The same click twice makes one message.
    await send("8a6e0f2e-1f39-4c5a-9a1e-6f9e2b0c1d21");
    expect(await systemDb.waMessage.count({ where: { storeId: o.store.id } })).toBe(1);

    // Meta no longer accepts the token: the connection waits for a reconnect, the message is held.
    meta.sendError = { status: 401, body: { error: { message: "Error validating access token", type: "OAuthException", code: 190 } } };
    await systemDb.waMessage.update({ where: { id: m.id }, data: { sendAfter: new Date() } });
    await sendWaMessage(m.id, ctx.deps);
    m = await systemDb.waMessage.findUniqueOrThrow({ where: { id: m.id } });
    expect(m).toMatchObject({ status: "queued", reason: "waiting_for_connection" });
    expect((await systemDb.waConnection.findUniqueOrThrow({ where: { storeId: o.store.id } })).status).toBe("reconnect");
    expect(await systemDb.alert.count({ where: { storeId: o.store.id, code: "wa_reconnect", resolvedAt: null } })).toBe(1);

    // Reconnecting puts it back; a send with no answer is failed as uncertain and never repeated by itself.
    expect((await connect(o)).json().connection.status).toBe("active");
    expect(await systemDb.alert.count({ where: { storeId: o.store.id, code: "wa_reconnect", resolvedAt: null } })).toBe(0);
    meta.sendError = null;
    const realFetch = meta.fetch;
    ctx.setFetch(async (input, init) => {
      if (new URL(String(input)).pathname.endsWith(`${PHONE}/messages`)) throw new TypeError("socket hang up");
      return realFetch(input, init);
    });
    await systemDb.waMessage.update({ where: { id: m.id }, data: { sendAfter: new Date() } });
    await sendWaMessage(m.id, ctx.deps);
    m = await systemDb.waMessage.findUniqueOrThrow({ where: { id: m.id } });
    expect(m).toMatchObject({ status: "failed", reason: "uncertain" });
    ctx.setFetch(realFetch);
    // The merchant may retry it.
    const retried = await call("POST", `${o.base}/messages/${m.id}/retry`, o.headers);
    expect(retried.json().message.status).toBe("queued");
    await drain();
    expect((await systemDb.waMessage.findUniqueOrThrow({ where: { id: m.id } })).status).toBe("accepted");
  });

  it("refuses a free-form reply outside the customer's 24-hour window", async () => {
    const o = await owner();
    await connect(o);
    const r = await call("POST", `${o.base}/messages`, o.headers, { requestId: "8a6e0f2e-1f39-4c5a-9a1e-6f9e2b0c1d31", to: { phone: "+61412345678" }, message: { kind: "text", body: "Hello!" } });
    expect(r.json().error).toBe("outside_window");
  });
});

describe("templates", () => {
  it("submits a template for review, refuses one Meta would, and follows Meta's decision", async () => {
    const o = await owner();
    await connect(o);
    const bad = await call("POST", `${o.base}/templates`, o.headers, { name: "x", language: "en", category: "UTILITY", header: { type: "none" }, body: "{{1}} is here", bodyExamples: ["a"] });
    expect(bad.json().error).toBe("invalid_template");
    const good = await call("POST", `${o.base}/templates`, o.headers, {
      name: "Shipping update",
      language: "en",
      category: "UTILITY",
      header: { type: "none" },
      body: "Hi {{1}}, your order {{2}} has shipped today.",
      bodyExamples: ["Priya", "#1042"],
    });
    expect(good.statusCode).toBe(201);
    expect(good.json().template).toMatchObject({ name: "shipping_update", status: "PENDING", madeHere: true });
    expect(meta.templates.at(-1)).toMatchObject({ name: "shipping_update", category: "UTILITY", components: [{ type: "BODY", example: { body_text: [["Priya", "#1042"]] } }] });
    await signedWebhook({ object: "whatsapp_business_account", entry: [{ id: WABA, changes: [{ field: "message_template_status_update", value: { event: "APPROVED", message_template_id: "t2", message_template_name: "shipping_update", message_template_language: "en" } }] }] });
    await drain();
    expect((await systemDb.waTemplate.findFirstOrThrow({ where: { storeId: o.store.id, name: "shipping_update" } })).status).toBe("APPROVED");
  });
});

describe("workflows", () => {
  const order = (over: Record<string, unknown> = {}) => ({
    id: 5001,
    name: "#1001",
    created_at: new Date().toISOString(),
    processed_at: new Date().toISOString(),
    total_price: "80.00",
    currency: "AUD",
    phone: "+61412345678",
    customer: { id: 77, first_name: "Pat", orders_count: 1 },
    shipping_address: { country_code: "AU", first_name: "Pat" },
    line_items: [{ title: "Cardamom 200g", quantity: 1, price: "80.00" }],
    tags: "",
    checkout_token: "chk_1",
    order_status_url: "https://acme.example/orders/abc",
    ...over,
  });

  it("runs once per order, only when its conditions hold, and only after the store chose how customers agree", async () => {
    const o = await owner();
    await connect(o);
    const create = await call("POST", `${o.base}/workflows`, o.headers, {
      name: "Order confirmation",
      trigger: "order_created",
      conditions: [{ field: "order_total", op: "gte", value: 50 }],
      template: { name: "order_confirmation", language: "en" },
      mapping: { body: [{ source: "customer_first_name" }, { source: "order_number" }], buttons: [] },
      timing: { mode: "after_trigger", minutes: 0 },
    });
    expect(create.statusCode).toBe(201);
    const id = create.json().workflow.id;
    // Utility messages need the store's consent choice first.
    const refused = await call("POST", `${o.base}/workflows/${id}/activate`, o.headers);
    expect(refused.json()).toMatchObject({ error: "workflow_problems" });
    await call("PUT", `${o.base}/settings`, o.headers, { orderUpdates: "checkout_notice" });
    expect((await call("POST", `${o.base}/workflows/${id}/activate`, o.headers)).json().workflow.status).toBe("active");

    const store = await systemDb.store.findUniqueOrThrow({ where: { id: o.store.id } });
    await whatsappOnShopifyEvent(store, "orders/create", order(), ctx.deps);
    await whatsappOnShopifyEvent(store, "orders/create", order(), ctx.deps); // Shopify redelivers
    await whatsappOnShopifyEvent(store, "orders/create", order({ id: 5002, name: "#1002", total_price: "20.00" }), ctx.deps);
    await drain();
    const runs = await systemDb.waWorkflowRun.findMany({ where: { workflowId: id }, orderBy: { subjectKey: "asc" } });
    expect(runs.map((r) => [r.subjectKey, r.outcome])).toEqual([
      ["order:5001", "scheduled"],
      ["order:5002", "skipped"],
    ]);
    expect(runs[1]!.reason).toContain("Order total is at least 50");
    expect(meta.sends).toHaveLength(1);
    expect(meta.sends[0]).toMatchObject({ to: "61412345678", template: { components: [{ type: "body", parameters: [{ type: "text", text: "Pat" }, { type: "text", text: "#1001" }] }] } });

    // The workflow's page shows each run with what happened to its message.
    const detail = (await call("GET", `${o.base}/workflows/${id}`, o.headers)).json();
    expect(detail.runs.map((r: { outcome: string }) => r.outcome).sort()).toEqual(["scheduled", "skipped"]);
    expect(detail.workflow.stats).toMatchObject({ sent: 1, skipped: 1 });
  });

  it("cancels a waiting reminder when the checkout becomes an order", async () => {
    const o = await owner();
    meta.templates.push({ id: "t9", name: "checkout_reminder", language: "en", category: "MARKETING", status: "APPROVED", components: [{ type: "BODY", text: "Hi {{1}}, you left items in your cart at {{2}}." }] });
    await connect(o);
    await call("PUT", `${o.base}/settings`, o.headers, { orderUpdates: "checkout_notice", shopifySmsConsent: true });
    const wf = (
      await call("POST", `${o.base}/workflows`, o.headers, {
        name: "Checkout reminder",
        trigger: "checkout_abandoned",
        template: { name: "checkout_reminder", language: "en" },
        mapping: { body: [{ source: "customer_first_name" }, { source: "store_name" }], buttons: [] },
        timing: { mode: "after_trigger", minutes: 60 },
        sendWindow: null,
      })
    ).json().workflow;
    expect((await call("POST", `${o.base}/workflows/${wf.id}/activate`, o.headers)).statusCode).toBe(200);
    const store = await systemDb.store.findUniqueOrThrow({ where: { id: o.store.id } });
    const checkout = { token: "chk_1", phone: "+61412345678", updated_at: new Date().toISOString(), buyer_accepts_sms_marketing: true, customer: { id: 77, first_name: "Pat" }, line_items: [{ title: "Tea", quantity: 1 }], total_price: "10.00" };
    await whatsappOnShopifyEvent(store, "checkouts/update", checkout, ctx.deps);
    const m = await systemDb.waMessage.findFirstOrThrow({ where: { workflowId: wf.id } });
    expect(m.status).toBe("queued");
    // Shopify's SMS consent covered WhatsApp (the store said so): recorded, with its source.
    expect(await systemDb.waConsentEvent.count({ where: { source: "shopify_sms" } })).toBe(1);
    await whatsappOnShopifyEvent(store, "orders/create", order(), ctx.deps);
    expect((await systemDb.waMessage.findUniqueOrThrow({ where: { id: m.id } })).status).toBe("cancelled");
  });
});

describe("campaigns", () => {
  it("sends an approved marketing template to opted-in customers only, after the exact count is confirmed", async () => {
    const o = await owner();
    meta.templates.push({ id: "t8", name: "store_promotion", language: "en", category: "MARKETING", status: "APPROVED", components: [{ type: "BODY", text: "Hi {{1}}, something new at {{2}} this week." }] });
    await connect(o);
    // Two customers who agreed (START), one who didn't.
    for (const [from, words] of [
      ["61411000001", "START"],
      ["61411000002", "START"],
      ["61411000003", "hello"],
    ] as const) {
      await signedWebhook({ object: "whatsapp_business_account", entry: [{ id: WABA, changes: [{ field: "messages", value: { metadata: { phone_number_id: PHONE }, messages: [{ id: `wamid.in.${from}`, from, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: words } }] } }] }] });
    }
    await drain();
    const estimate = await call("POST", `${o.base}/campaigns/estimate`, o.headers, { audience: { countries: ["AU"] } });
    expect(estimate.json().count).toBe(2);
    const made = await call("POST", `${o.base}/campaigns`, o.headers, { name: "Spring", template: { name: "store_promotion", language: "en" }, mapping: { body: [{ source: "customer_first_name" }, { source: "store_name" }], buttons: [] }, audience: { countries: ["AU"] } });
    const id = made.json().campaign.id;
    expect((await call("POST", `${o.base}/campaigns/${id}/schedule`, o.headers, { scheduledAt: null, confirmRecipients: 3 })).json().error).toBe("recipients_changed");
    const scheduled = await call("POST", `${o.base}/campaigns/${id}/schedule`, o.headers, { scheduledAt: null, confirmRecipients: 2 });
    expect(scheduled.json().campaign.status).toBe("sending");
    await drain();
    expect(meta.sends.map((s) => s.to).sort()).toEqual(["61411000001", "61411000002"]);
    const detail = (await call("GET", `${o.base}/campaigns/${id}`, o.headers)).json();
    expect(detail.report).toMatchObject({ total: 2, sent: 2 });
    // Still sending (the sweep marks it completed): it can be cancelled, which stops nothing already sent.
    expect((await call("POST", `${o.base}/campaigns/${id}/cancel`, o.headers)).statusCode).toBe(200);
    expect((await systemDb.waCampaign.findUniqueOrThrow({ where: { id } })).status).toBe("cancelled");
  });
});

describe("custom events", () => {
  it("starts a workflow from the store's own tool with its event key", async () => {
    const o = await owner();
    meta.templates.push({ id: "t7", name: "appointment_reminder", language: "en", category: "UTILITY", status: "APPROVED", components: [{ type: "BODY", text: "Hi {{1}}, see you on {{2}} at {{3}} for your visit." }] });
    await connect(o);
    await call("PUT", `${o.base}/settings`, o.headers, { orderUpdates: "checkout_notice" });
    const wf = (
      await call("POST", `${o.base}/workflows`, o.headers, {
        name: "Reminder",
        trigger: "custom_event",
        eventName: "appointment_booked",
        template: { name: "appointment_reminder", language: "en" },
        mapping: { body: [{ source: "customer_first_name" }, { source: "event_date" }, { source: "event_time" }], buttons: [] },
        timing: { mode: "before_event", minutes: 24 * 60 },
      })
    ).json().workflow;
    await call("POST", `${o.base}/workflows/${wf.id}/activate`, o.headers);
    const { key } = (await call("POST", `${o.base}/settings/event-key`, o.headers)).json();
    expect(key).toMatch(/^whev_/);
    const at = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const event = { event: "appointment_booked", eventId: "bk_1", phone: "+61412345678", firstName: "Pat", at };
    expect((await call("POST", "/whatsapp/events", { authorization: "Bearer whev_wrong" }, event)).statusCode).toBe(401);
    const r = await call("POST", "/whatsapp/events", { authorization: `Bearer ${key}` }, event);
    expect(r.json()).toEqual({ workflows: 1, scheduled: 1, skipped: 0 });
    // Sent again (a retry in the store's tool): nothing new.
    expect((await call("POST", "/whatsapp/events", { authorization: `Bearer ${key}` }, event)).json()).toEqual({ workflows: 1, scheduled: 0, skipped: 0 });
    const m = await systemDb.waMessage.findFirstOrThrow({ where: { workflowId: wf.id } });
    // A day before the appointment.
    expect(Math.abs(m.sendAfter.getTime() - (new Date(at).getTime() - 86_400_000))).toBeLessThan(1000);
  });
});

describe("disconnecting", () => {
  it("deletes bizinsights' access at Nango, cancels what was waiting, keeps the history", async () => {
    const o = await owner();
    await connect(o);
    await call("PUT", `${o.base}/settings`, o.headers, { orderUpdates: "checkout_notice" });
    await call("POST", `${o.base}/messages`, o.headers, {
      requestId: "8a6e0f2e-1f39-4c5a-9a1e-6f9e2b0c1d41",
      to: { phone: "+61412345678" },
      message: { kind: "template", template: { name: "order_confirmation", language: "en" }, mapping: { body: [{ source: "customer_first_name" }, { source: "custom_text", text: "#1" }], buttons: [] } },
    });
    expect((await call("DELETE", o.base, o.headers)).statusCode).toBe(200);
    expect(meta.nangoDeleted).toEqual([`wa-${o.store.id}`]);
    expect(meta.subscribed).toBe(false);
    const conn = await systemDb.waConnection.findUniqueOrThrow({ where: { storeId: o.store.id } });
    expect(conn).toMatchObject({ status: "disconnected", nangoConnectionId: null, phoneNumberId: null });
    expect(await systemDb.waMessage.count({ where: { storeId: o.store.id, status: "cancelled", reason: "disconnected" } })).toBe(1);
    await drain();
    expect(meta.sends).toHaveLength(0);
    // The number is free for another store now.
    const b = await owner("other.myshopify.com", "owner2");
    expect((await connect(b)).json().connection.status).toBe("active");
  });
});

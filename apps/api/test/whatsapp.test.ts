import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { systemDb, type Store } from "@app/db";
import { dispatchCampaign, encryptTokenFields, processWebhookEvent, sendQueuedMessage, waEncrypt, whatsappOnShopifyEvent } from "@app/core";
import { EVOLUTION_ENV, EVOLUTION_KEY, evolutionFake, QR_PNG, type EvolutionFake } from "../../../test-support/evolutionFake.js";
import { clean, cookiesFrom, createStore, createWorkspace, ORIGIN, setup, signIn, teardown, type TestCtx } from "./helpers.js";

/**
 * WhatsApp Automation over Evolution API (apps/api/src/routes/whatsapp.ts, whatsappWebhook.ts;
 * packages/core/src/whatsapp): connecting with the QR code WhatsApp issued, "connected" only on the
 * provider's word, the webhook's per-connection JWT, the test number and the test message's real
 * status, sends from the dashboard (consent, idempotency, attachments), customers' STOP and START,
 * automations from Shopify's events, campaigns, disconnecting, and who may see and do what. Evolution
 * API is test-support/evolutionFake.ts, which answers as Evolution 2.3.7 does.
 */

let ctx: TestCtx;
let evo: EvolutionFake;
const WEBHOOK_BASE = "https://bizinsights.test/api";
const TEST_PHONE = "+61400111222";
const CUSTOMER = "+61412345678";

beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => {
  ctx.setEnv({ EVOLUTION_API_URL: "", EVOLUTION_API_KEY: "", EVOLUTION_WEBHOOK_URL: "", META_APP_ID: "", META_APP_SECRET: "", WHATSAPP_WEBHOOK_VERIFY_TOKEN: "", WHATSAPP_CONFIG_ID: "" });
  await teardown(ctx);
});
beforeEach(async () => {
  await clean(ctx);
  evo = evolutionFake();
  ctx.setFetch(evo.fetch);
  ctx.setEnv({ ...EVOLUTION_ENV, EVOLUTION_WEBHOOK_URL: WEBHOOK_BASE });
});

type Method = "GET" | "POST" | "PUT" | "DELETE";

async function owner(uid = "u1", email = "o@shop.test") {
  const s = await signIn(ctx, uid, email);
  const ws = await createWorkspace(ctx, s.headers);
  const store = await createStore(ws, `${uid}.myshopify.com`, ["read_orders", "read_customers"], { name: "Green Leaf", currency: "AUD" });
  const base = `/workspaces/${ws}/stores/${store.id}/whatsapp`;
  const call = (method: Method, path = "", payload?: unknown, headers = s.headers) => ctx.app.inject({ method, url: `${base}${path}`, headers, ...(payload === undefined ? {} : { payload }) });
  return { ...s, ws, store, base, call };
}
type Owner = Awaited<ReturnType<typeof owner>>;

function ok<T = any>(res: { statusCode: number; body: string; json(): any }, status = 200): T { // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(res.statusCode, res.body).toBe(status);
  return res.json();
}

/** Delivers a webhook the way Evolution posts it. */
const deliver = (w: { url: string; headers: Record<string, string>; body: string }) => ctx.app.inject({ method: "POST", url: w.url, headers: w.headers, payload: w.body });

/** The instance this store's connection uses at the provider. */
async function instanceOf(o: Owner) {
  const conn = await systemDb.wappConnection.findUniqueOrThrow({ where: { storeId: o.store.id } });
  return conn.instanceName!;
}

/** Step 1-2: a QR pairing, then the phone scans and Evolution's webhook says the connection is open. */
async function connect(o: Owner, phone = "61400000099") {
  ok(await o.call("POST", "/connection", { method: "qr" }), 201);
  const name = await instanceOf(o);
  evo.open(name, phone, "Green Leaf");
  const res = await deliver(evo.webhook(name, "connection.update", { instance: name, wuid: `${phone}@s.whatsapp.net`, profileName: "Green Leaf", state: "open", statusReason: 200 }));
  expect(res.json()).toEqual({ ok: true, outcome: "applied" });
  return name;
}

const SETTINGS = {
  businessName: "Green Leaf",
  orderUpdates: "checkout_notice",
  marketingEnabled: true,
  shopifySmsConsent: false,
  sendWindow: { start: 0, end: 24 },
  timeZone: "UTC",
  dailyLimit: 200,
  perCustomerDailyLimit: 3,
  retentionDays: 90,
};

/** Step 3. */
const configure = async (o: Owner, extra: Record<string, unknown> = {}) => ok(await o.call("PUT", "/settings", { ...SETTINGS, ...extra }));

/**
 * The worker, in-process: sends what waits on the whatsapp queue, and applies stored webhook events
 * and campaign batches, until nothing is left. The pace between a linked phone's messages is waived;
 * a job SQS would deliver later (a retry, a hold: more than a campaign's few seconds) isn't due yet.
 */
async function drain(): Promise<string[]> {
  const out: string[] = [];
  for (let round = 0; round < 20; round++) {
    const sent = ctx.deps.queues.sent.whatsapp.splice(0);
    const opts = ctx.deps.queues.sentOpts.whatsapp.splice(0);
    const jobs = sent.filter((_, i) => (opts[i]?.delaySeconds ?? 0) <= 10);
    if (!jobs.length) break;
    for (const j of jobs) {
      if (j.kind === "wapp_send") {
        for (const c of await systemDb.wappConnection.findMany({ select: { id: true } })) await ctx.deps.coord.release(`wapp:pace:${c.id}`);
        out.push(await sendQueuedMessage(ctx.deps, j.messageId));
      } else if (j.kind === "wapp_event") out.push(await processWebhookEvent(ctx.deps, j.eventId));
      else out.push(await dispatchCampaign(ctx.deps, j.campaignId));
    }
  }
  return out;
}

/** Step 4: the test number verified with the code WhatsApp delivered, and a test message WhatsApp reported sent. */
async function finishSetup(o: Owner) {
  ok(await o.call("POST", "/test-number", { phone: TEST_PHONE }));
  await drain();
  const code = /is (\d{6})\./.exec(String(evo.sends.at(-1)!.body.text))![1];
  ok(await o.call("POST", "/test-number/verify", { code }));
  const { messageId } = ok(await o.call("POST", "/test-message", {}), 201);
  await drain();
  const sent = evo.sends.at(-1)!;
  await deliver(evo.webhook(sent.instance, "messages.update", { keyId: sent.id, remoteJid: `${sent.body.number}@s.whatsapp.net`, fromMe: true, status: "SERVER_ACK" }));
  await drain();
  expect(ok(await o.call("GET", `/messages/${messageId}`)).message.status).toBe("sent");
}

/** A customer's message to the store's number, as Evolution reports it. */
const inbound = (name: string, from: string, text: string, opts: { id?: string; jid?: string; fromMe?: boolean } = {}) =>
  evo.webhook(name, "messages.upsert", {
    key: { remoteJid: opts.jid ?? `${from.replace(/^\+/, "")}@s.whatsapp.net`, fromMe: opts.fromMe ?? false, id: opts.id ?? `IN${Math.random().toString(16).slice(2, 14).toUpperCase()}` },
    pushName: "Pat",
    message: { conversation: text },
    messageType: "conversation",
    messageTimestamp: Math.floor(Date.now() / 1000),
  });

/** Everything secret this store's connection holds, to look for in answers. */
async function secretsOf(o: Owner) {
  const name = await instanceOf(o);
  const inst = evo.instances.get(name)!;
  return [EVOLUTION_KEY, inst.token, inst.webhook!.jwtKey, name, QR_PNG.slice(30)];
}

describe("connecting a phone (Steps 1-2)", () => {
  it("shows the QR code Evolution issued and is connected only when the provider says the connection is open", async () => {
    const o = await owner();
    const before = ok(await o.call("GET"));
    expect(before).toMatchObject({ connection: null, platform: { evolution: true }, can: { connect: true, manage: true, contacts: true }, setup: { current: "connect" } });

    const started = await o.call("POST", "/connection", { method: "qr" });
    const { pairing } = ok(started, 201);
    expect(started.headers["cache-control"]).toBe("no-store");
    expect(pairing).toMatchObject({ status: "pairing", qr: QR_PNG, pairingCode: null });
    // One instance at the provider, made with the global key, with a key and a webhook of its own.
    const name = await instanceOf(o);
    expect(name).toMatch(/^bi_[0-9a-f]{24}$/);
    const inst = evo.instances.get(name)!;
    expect(inst).toMatchObject({ integration: "WHATSAPP-BAILEYS", state: "connecting" });
    expect(inst.token).not.toBe(EVOLUTION_KEY);
    expect(inst.webhook).toMatchObject({ url: `${WEBHOOK_BASE}/webhooks/whatsapp/evolution/${name}`, events: expect.arrayContaining(["CONNECTION_UPDATE", "MESSAGES_UPSERT", "MESSAGES_UPDATE"]) });
    expect(evo.calls[0]).toMatchObject({ method: "POST", path: "/instance/create", apikey: EVOLUTION_KEY });
    expect(evo.calls.slice(1).every((c) => c.apikey === inst.token)).toBe(true);
    // The keys are kept encrypted.
    const row = await systemDb.wappConnection.findUniqueOrThrow({ where: { storeId: o.store.id } });
    expect(row.instanceTokenEnc).not.toContain(inst.token);
    expect(row.webhookKeyEnc).not.toContain(inst.webhook!.jwtKey);

    // While the phone hasn't scanned: the provider's current code, still "pairing", however often it's asked.
    const polled = ok(await o.call("GET", "/connection/pairing")).pairing;
    expect(polled).toMatchObject({ status: "pairing", qr: QR_PNG, qrCount: 0 });
    expect((await deliver(evo.webhook(name, "qrcode.updated", { qrcode: { instance: name, pairingCode: null, code: "2@x", base64: QR_PNG } }))).json().outcome).toBe("applied");
    expect((await deliver(evo.webhook(name, "connection.update", { instance: name, state: "connecting", statusReason: 200 }))).json().outcome).toBe("applied");
    expect(ok(await o.call("GET")).connection).toMatchObject({ status: "pairing", qrCount: 1, phone: null });

    // Evolution says it's open: connected, with the number WhatsApp linked (masked).
    evo.open(name, "61400000099", "Green Leaf");
    const done = ok(await o.call("GET", "/connection/pairing")).pairing;
    expect(done).toMatchObject({ status: "connected", qr: null, profileName: "Green Leaf" });
    expect(done.phone).toMatch(/^\+61 [•]+ 099$/);
    const after = ok(await o.call("GET"));
    expect(after.connection).toMatchObject({ provider: "qr", status: "connected", statusLabel: expect.any(String) });
    expect(after.setup.current).toBe("configure");

    // No answer carries a key, the instance's name, the QR code or the full number.
    const secrets = await secretsOf(o);
    for (const res of [await o.call("GET"), await o.call("GET", "/connection/pairing"), await o.call("POST", "/connection/check")]) {
      for (const s of secrets) expect(res.body, s).not.toContain(s);
      expect(res.body).not.toContain("61400000099");
    }
  });

  it("gives a pairing code for a number, and refuses a second phone while one is linked", async () => {
    const o = await owner();
    const { pairing } = ok(await o.call("POST", "/connection", { method: "code", phone: "+61 400 000 099" }), 201);
    expect(pairing).toMatchObject({ status: "pairing", pairingCode: "WZYEH1YY", qr: QR_PNG });
    expect(evo.calls.find((c) => c.path.startsWith("/instance/connect"))).toBeTruthy();
    expect(ok(await o.call("POST", "/connection", { method: "code", phone: "12" }), 400).error).toBe("invalid_phone");
    const name = await instanceOf(o);
    evo.open(name);
    await deliver(evo.webhook(name, "connection.update", { instance: name, state: "open", wuid: "61400000099@s.whatsapp.net" }));
    expect(ok(await o.call("POST", "/connection", { method: "qr" }), 409).error).toBe("already_connected");
  });

  it("says plainly when the WhatsApp service is down, and pretends nothing", async () => {
    const o = await owner();
    evo.down = "unreachable";
    expect(ok(await o.call("POST", "/connection", { method: "qr" }), 503).error).toBe("provider_unavailable");
    const row = await systemDb.wappConnection.findUniqueOrThrow({ where: { storeId: o.store.id } });
    expect(row).toMatchObject({ status: "failed", instanceName: null, instanceTokenEnc: null });
    expect(ok(await o.call("GET")).connection).toMatchObject({ status: "failed" });
    // Without the service's settings, nothing starts.
    ctx.setEnv({ EVOLUTION_API_KEY: "" });
    evo.down = null;
    expect(ok(await o.call("GET")).platform.evolution).toBe(false);
    expect(ok(await o.call("POST", "/connection", { method: "qr" }), 503).error).toBe("provider_not_configured");
  });

  it("records the phone logging out, raises an alert, and holds messages until it is linked again", async () => {
    const o = await owner();
    const name = await connect(o);
    await configure(o);
    ok(await o.call("POST", "/messages", { phone: CUSTOMER, reason: "order_update", text: "Your order is ready.", idempotencyKey: "logout-0001", customerAsked: true }), 201);
    await deliver(evo.webhook(name, "connection.update", { instance: name, state: "close", statusReason: 401 }));
    const ov = ok(await o.call("GET"));
    expect(ov.connection).toMatchObject({ status: "logged_out" });
    expect(await systemDb.alert.count({ where: { storeId: o.store.id, code: "whatsapp_logged_out", resolvedAt: null } })).toBe(1);
    expect(await drain()).toEqual(["held"]);
    const m = await systemDb.wappMessage.findFirstOrThrow({ where: { storeId: o.store.id } });
    expect(m).toMatchObject({ status: "queued", reason: "not_connected" });
    expect(evo.sends).toHaveLength(0);
    expect(ok(await o.call("POST", "/messages", { phone: CUSTOMER, reason: "order_update", text: "Hi", idempotencyKey: "logout-0002" }), 409).error).toBe("not_connected");
    expect(ok(await o.call("POST", "/connection/reconnect"), 409).error).toBe("needs_pairing");
  });
});

describe("the provider's webhook", () => {
  it("accepts only a JWT made from this connection's own key, for this instance, in time, and each body once", async () => {
    const o = await owner();
    const name = await connect(o);
    const good = evo.webhook(name, "connection.update", { instance: name, state: "open" });
    const refused = [
      { ...good, headers: { "content-type": "application/json" } },
      evo.webhook(name, "connection.update", { state: "close", statusReason: 401 }, { key: "someone-elses-key" }),
      evo.webhook(name, "connection.update", { state: "close", statusReason: 401 }, { expiresIn: -120 }),
      { ...good, url: "/webhooks/whatsapp/evolution/bi_0123456789abcdef01234567" },
      { ...good, url: "/webhooks/whatsapp/evolution/not-an-instance" },
    ];
    for (const w of refused) {
      const res = await deliver(w);
      expect(res.statusCode, w.url).toBe(401);
      expect(res.json()).toEqual({ error: "unauthenticated" });
    }
    // Signed right, but the body names another instance.
    expect(ok(await deliver(evo.webhook(name, "connection.update", { state: "close" }, { instance: "bi_ffffffffffffffffffffffff" })), 400).error).toBe("invalid");
    // Not JSON, too big.
    expect((await deliver({ ...good, body: "{nope" })).statusCode).toBe(400);
    expect((await deliver({ ...good, body: JSON.stringify({ event: "x", instance: name, data: "x".repeat(300 * 1024) }) })).statusCode).toBe(413);
    // None of that changed the connection.
    expect(ok(await o.call("GET")).connection.status).toBe("connected");

    // A message event is stored once: Evolution's retry of the same body is a duplicate.
    const at = new Date();
    const first = await deliver(evo.webhook(name, "messages.update", { keyId: "3EB0X", fromMe: true, status: "DELIVERY_ACK" }, { at }));
    const again = await deliver(evo.webhook(name, "messages.update", { keyId: "3EB0X", fromMe: true, status: "DELIVERY_ACK" }, { at }));
    expect([first.json().outcome, again.json().outcome]).toEqual(["stored", "duplicate"]);
    expect(await systemDb.wappWebhookEvent.count({ where: { storeId: o.store.id } })).toBe(1);
    // Stored encrypted.
    const ev = await systemDb.wappWebhookEvent.findFirstOrThrow({ where: { storeId: o.store.id } });
    expect(ev.bodyEnc).not.toContain("3EB0X");
    // A message bizinsights doesn't know changes nothing; the body is dropped once applied.
    expect(await drain()).toEqual(["unknown"]);
    expect(await systemDb.wappWebhookEvent.findFirstOrThrow({ where: { storeId: o.store.id } })).toMatchObject({ status: "processed", bodyEnc: null });
  });

  it("checks Meta's signature on the Cloud API webhook and its verify token", async () => {
    ctx.setEnv({ META_APP_ID: "971575545351940", META_APP_SECRET: "meta-secret-for-tests", WHATSAPP_WEBHOOK_VERIFY_TOKEN: "verify-me", WHATSAPP_CONFIG_ID: "2228218088074576" });
    const body = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "waba-unknown", changes: [] }] });
    const sig = (b: string, key = "meta-secret-for-tests") => `sha256=${createHmac("sha256", key).update(b).digest("hex")}`;
    const post = (headers: Record<string, string>) => ctx.app.inject({ method: "POST", url: "/webhooks/whatsapp", headers: { "content-type": "application/json", ...headers }, payload: body });
    expect((await post({})).statusCode).toBe(401);
    expect((await post({ "x-hub-signature-256": sig(body, "wrong") })).statusCode).toBe(401);
    expect(ok(await post({ "x-hub-signature-256": sig(body) }))).toMatchObject({ ok: true });
    const verify = (token: string) => ctx.app.inject({ method: "GET", url: `/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=12345` });
    expect((await verify("wrong")).statusCode).toBe(403);
    const v = await verify("verify-me");
    expect([v.statusCode, v.body]).toEqual([200, "12345"]);
  });
});

describe("the test number and the test message (Step 4)", () => {
  it("verifies the number with a code sent over WhatsApp, and is done only when WhatsApp reports the test sent", async () => {
    const o = await owner();
    const name = await connect(o);
    await configure(o);
    expect(ok(await o.call("GET")).setup.current).toBe("test");
    expect(ok(await o.call("POST", "/test-message", {}), 409).error).toBe("no_test_number");

    const sent = ok(await o.call("POST", "/test-number", { phone: TEST_PHONE }));
    expect(sent.phone).toMatch(/222$/);
    expect(sent.phone).not.toContain("400111");
    expect(await drain()).toEqual(["accepted"]);
    const codeMsg = evo.sends.at(-1)!;
    expect(codeMsg).toMatchObject({ instance: name, path: "sendText", body: { number: "61400111222" } });
    const code = /is (\d{6})\./.exec(String(codeMsg.body.text))![1]!;
    expect(ok(await o.call("POST", "/test-number/verify", { code: code === "000000" ? "111111" : "000000" }), 400).error).toBe("wrong_code");
    // The code is on the phone it went to, not in bizinsights' history.
    const [codeRow] = ok(await o.call("GET", "/messages?source=verification")).messages;
    expect(codeRow.preview).toMatch(/code isn't kept here/);
    expect(JSON.stringify(ok(await o.call("GET")))).not.toContain(code);
    ok(await o.call("POST", "/test-number/verify", { code }));

    const { messageId } = ok(await o.call("POST", "/test-message", {}), 201);
    expect(await drain()).toEqual(["accepted"]);
    // Evolution took it ("PENDING"): accepted, not sent; the step isn't done on an HTTP answer.
    expect(ok(await o.call("GET", `/messages/${messageId}`)).message).toMatchObject({ status: "accepted", providerMessageId: evo.sends.at(-1)!.id });
    expect(ok(await o.call("GET")).setup.current).toBe("test");

    const report = (status: string) => deliver(evo.webhook(name, "messages.update", { keyId: evo.sends.at(-1)!.id, remoteJid: "61400111222@s.whatsapp.net", fromMe: true, status }));
    await report("SERVER_ACK");
    await drain();
    expect(ok(await o.call("GET", `/messages/${messageId}`)).message.status).toBe("sent");
    const ov = ok(await o.call("GET"));
    expect(ov.setup.current).toBeNull();
    await report("DELIVERY_ACK");
    await report("SERVER_ACK");
    await drain();
    const detail = ok(await o.call("GET", `/messages/${messageId}`));
    // A late report never moves a message back.
    expect(detail.message.status).toBe("delivered");
    expect(detail.events.map((e: { status: string }) => e.status)).toEqual(["accepted", "sent", "delivered"]);
  });

  it("verifies the linked phone's own number without a code (a code to itself never arrives)", async () => {
    const o = await owner();
    const name = await connect(o, "61400000099");
    await configure(o);
    const sendsBefore = evo.sends.length;
    const r = ok(await o.call("POST", "/test-number", { phone: "+61 400 000 099" }));
    expect(r).toMatchObject({ linkedNumber: true, expiresAt: null });
    expect(r.phone).toMatch(/099$/);
    expect(await drain()).toEqual([]);
    expect(evo.sends.length).toBe(sendsBefore);
    expect(ok(await o.call("GET", "/messages?source=verification")).messages).toEqual([]);
    const ov = ok(await o.call("GET"));
    expect(ov.settings).toMatchObject({ testIsLinkedNumber: true, testCodeExpiresAt: null });
    expect(ov.settings.testVerifiedAt).toBeTruthy();
    expect(ov.setup.current).toBe("test");

    // The test still has to be reported sent by WhatsApp.
    const { messageId } = ok(await o.call("POST", "/test-message", {}), 201);
    expect(await drain()).toEqual(["accepted"]);
    expect(evo.sends.at(-1)).toMatchObject({ instance: name, path: "sendText", body: { number: "61400000099" } });
    await deliver(evo.webhook(name, "messages.update", { keyId: evo.sends.at(-1)!.id, remoteJid: "61400000099@s.whatsapp.net", fromMe: true, status: "SERVER_ACK" }));
    await drain();
    expect(ok(await o.call("GET", `/messages/${messageId}`)).message.status).toBe("sent");
    expect(ok(await o.call("GET")).setup.current).toBeNull();

    // Another number still needs its code, and is then no longer the linked one.
    expect(ok(await o.call("POST", "/test-number", { phone: TEST_PHONE }))).toMatchObject({ linkedNumber: false });
    expect(ok(await o.call("GET")).settings).toMatchObject({ testIsLinkedNumber: false, testVerifiedAt: null });
  });

  it("allows three codes an hour and five tries at one", async () => {
    const o = await owner();
    await connect(o);
    await configure(o);
    for (let i = 0; i < 3; i++) ok(await o.call("POST", "/test-number", { phone: TEST_PHONE }));
    expect(ok(await o.call("POST", "/test-number", { phone: TEST_PHONE }), 429).error).toBe("rate_limited");
    for (let i = 0; i < 5; i++) ok(await o.call("POST", "/test-number/verify", { code: "999999" }), 400);
    expect(ok(await o.call("POST", "/test-number/verify", { code: "999999" }), 429).error).toBe("too_many_tries");
  });
});

describe("sending from the dashboard", () => {
  it("sends once per key, only with the customer's consent, and records the merchant's word as consent", async () => {
    const o = await owner();
    await connect(o);
    await configure(o, { orderUpdates: "opt_in_only" });
    const msg = (extra: Record<string, unknown> = {}) => ({ phone: CUSTOMER, reason: "order_update", text: "Your order is on its way.", idempotencyKey: "send-00000001", ...extra });

    const refused = ok(await o.call("POST", "/messages", msg()), 409);
    expect(refused).toMatchObject({ error: "not_allowed", detail: { reason: "no_consent" } });
    expect(await systemDb.wappMessage.count({ where: { storeId: o.store.id } })).toBe(0);

    const first = ok(await o.call("POST", "/messages", msg({ customerAsked: true })), 201).message;
    const again = ok(await o.call("POST", "/messages", msg({ customerAsked: true })), 201).message;
    expect(again.id).toBe(first.id);
    expect(first).toMatchObject({ status: "queued", source: "manual", preview: "Your order is on its way." });
    expect(await drain()).toEqual(["accepted"]);
    expect(evo.sends).toEqual([expect.objectContaining({ path: "sendText", body: expect.objectContaining({ number: "61412345678", text: "Your order is on its way." }) })]);
    const consent = await systemDb.wappConsentEvent.findFirstOrThrow({ where: { storeId: o.store.id } });
    expect(consent).toMatchObject({ scope: "order_updates", status: "opted_in", source: "merchant", actorUserId: o.user.id });

    // Marketing needs the customer's own yes to marketing.
    expect(ok(await o.call("POST", "/messages", msg({ reason: "marketing", text: "Sale!", idempotencyKey: "send-00000002" })), 409).detail.reason).toBe("no_marketing_consent");
    // A number not on WhatsApp is reported as such, not as sent.
    evo.notOnWhatsapp.add("61498765432");
    ok(await o.call("POST", "/messages", msg({ phone: "+61498765432", idempotencyKey: "send-00000003", customerAsked: true })), 201);
    expect(await drain()).toEqual(["skipped"]);
    expect(await systemDb.wappMessage.findFirstOrThrow({ where: { storeId: o.store.id, idempotencyKey: "manual:send-00000003" } })).toMatchObject({ status: "skipped", reason: "not_on_whatsapp" });
  });

  it("sends a real image as media, refuses a file that isn't what it claims, and never retries a send that may have gone", async () => {
    const o = await owner();
    await connect(o);
    await configure(o);
    const png = QR_PNG.split(",")[1]!;
    const base = { phone: CUSTOMER, reason: "order_update", customerAsked: true };
    expect(ok(await o.call("POST", "/messages", { ...base, idempotencyKey: "att-00000001", attachment: { name: "x.png", mime: "image/png", data: Buffer.from("not a png").toString("base64") } }), 400).error).toBe("attachment_invalid");
    const m = ok(await o.call("POST", "/messages", { ...base, idempotencyKey: "att-00000002", text: "Your receipt", attachment: { name: "receipt.png", mime: "image/png", data: png } }), 201).message;
    expect(await ctx.deps.payloads.get(`wapp-media/${m.id}`)).toBe(png);
    expect(await drain()).toEqual(["accepted"]);
    expect(evo.sends.at(-1)).toMatchObject({ path: "sendMedia", body: { mediatype: "image", mimetype: "image/png", media: png, caption: "Your receipt" } });
    expect(await ctx.deps.payloads.get(`wapp-media/${m.id}`)).toBeNull();

    evo.sendFails = "timeout";
    const t = ok(await o.call("POST", "/messages", { ...base, idempotencyKey: "att-00000003", text: "Hello" }), 201).message;
    expect(await drain()).toEqual(["failed"]);
    const failed = ok(await o.call("GET", `/messages/${t.id}`)).message;
    expect(failed).toMatchObject({ status: "failed", errorCode: "uncertain" });
    expect(failed.errorDetail).toMatch(/may have reached the customer/);
    // The merchant may send it again, deliberately.
    evo.sendFails = null;
    expect(ok(await o.call("POST", `/messages/${t.id}/retry`)).message.status).toBe("queued");
    expect(await drain()).toEqual(["accepted"]);
  });

  it("retries a send that never reached the service, and never one that may have gone", async () => {
    const o = await owner();
    await connect(o);
    await configure(o);
    ok(await o.call("POST", "/messages", { phone: CUSTOMER, reason: "order_update", text: "Hi", idempotencyKey: "retry-0000001", customerAsked: true }), 201);
    evo.sendFails = "refused";
    expect(await drain()).toEqual(["retry"]);
    const m = await systemDb.wappMessage.findFirstOrThrow({ where: { storeId: o.store.id } });
    expect(m).toMatchObject({ status: "queued", attempts: 1, errorCode: "unreachable" });
    expect(m.sendAfter.getTime()).toBeGreaterThan(Date.now() + 20_000);
    expect(evo.sends).toHaveLength(0);
    // The connection dropped after the request went out, or the service failed on it: it may be on the
    // customer's phone, so it is never sent again by itself.
    for (const [fail, key] of [["reset", "retry-0000002"], [500, "retry-0000003"]] as const) {
      evo.sendFails = fail;
      const sent = ok(await o.call("POST", "/messages", { phone: CUSTOMER, reason: "order_update", text: "Hi", idempotencyKey: key }), 201).message;
      expect(await drain()).toEqual(["failed"]);
      expect(ok(await o.call("GET", `/messages/${sent.id}`)).message).toMatchObject({ status: "failed", errorCode: "uncertain" });
    }
  });
});

describe("customers' replies", () => {
  it("honours STOP and START from anyone, and keeps only the store's customers' messages", async () => {
    const o = await owner();
    const name = await connect(o);
    await configure(o);
    // Someone who isn't a customer: their message is dropped unread; their STOP is kept by hash only.
    await deliver(inbound(name, "+61411000000", "hello, is this Sam?"));
    await deliver(inbound(name, "+61411000000", "STOP"));
    expect(await drain()).toEqual(["not_a_customer", "stop_unknown"]);
    expect(await systemDb.wappContact.count({ where: { storeId: o.store.id } })).toBe(0);
    expect(await systemDb.wappMessage.count({ where: { storeId: o.store.id } })).toBe(0);
    expect(await systemDb.wappSuppression.findFirstOrThrow({ where: { storeId: o.store.id } })).toMatchObject({ scope: "all", reason: "stop_reply" });
    // Group chats, statuses and the store's own messages start nothing.
    await deliver(inbound(name, "+61411000001", "STOP", { jid: "120363000000000000@g.us" }));
    await deliver(inbound(name, CUSTOMER, "STOP", { fromMe: true }));
    expect(await drain()).toEqual(["not_a_person", "own_message"]);

    // A customer bizinsights messaged.
    ok(await o.call("POST", "/messages", { phone: CUSTOMER, reason: "order_update", text: "Your order shipped.", idempotencyKey: "reply-0000001" }), 201);
    await drain();
    await deliver(inbound(name, CUSTOMER, "Thanks! When will it arrive?"));
    await deliver(inbound(name, CUSTOMER, "STOP"));
    expect(await drain()).toEqual(["recorded", "stop", "accepted"]);
    expect(evo.sends.at(-1)!.body.text).toBe("You won't get WhatsApp messages from Green Leaf any more. Reply START if you change your mind.");
    const inMessages = ok(await o.call("GET", "/messages?direction=in")).messages;
    expect(inMessages.map((m: { preview: string }) => m.preview)).toEqual(["STOP", "Thanks! When will it arrive?"]);
    expect(ok(await o.call("POST", "/messages", { phone: CUSTOMER, reason: "order_update", text: "Hi", idempotencyKey: "reply-0000002" }), 409).detail.reason).toBe("opted_out");
    expect(ok(await o.call("POST", "/messages", { phone: CUSTOMER, reason: "order_update", text: "Hi", idempotencyKey: "reply-0000003", customerAsked: true }), 409).error).toBe("opted_out");

    await deliver(inbound(name, CUSTOMER, "start"));
    expect(await drain()).toEqual(["start", "accepted"]);
    ok(await o.call("POST", "/messages", { phone: CUSTOMER, reason: "order_update", text: "Welcome back", idempotencyKey: "reply-0000004" }), 201);
    const history = ok(await o.call("GET", "/contacts")).contacts[0].history.map((h: { source: string; status: string }) => `${h.source}:${h.status}`);
    expect(history).toEqual(["whatsapp_start:opted_in", "whatsapp_stop:opted_out"]);
  });
});

const ORDER = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  name: `#${id}`,
  created_at: new Date().toISOString(),
  processed_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  currency: "AUD",
  total_price: "58.00",
  phone: CUSTOMER,
  customer: { id: 77, first_name: "Pat", orders_count: 1 },
  shipping_address: { first_name: "Pat", country_code: "AU", phone: CUSTOMER },
  line_items: [{ product_id: 1, title: "Linen shirt", quantity: 1, price: "58.00" }],
  ...extra,
});

describe("the do-not-message list", () => {
  it("stops tests and codes to a number that replied STOP, and a STOP survives a try that failed halfway", async () => {
    const o = await owner();
    const name = await connect(o);
    await configure(o);
    await finishSetup(o);
    // The test number replies STOP (it isn't a customer): nothing more goes to it, not even a test.
    await deliver(inbound(name, TEST_PHONE, "STOP"));
    expect(await drain()).toEqual(["stop_unknown"]);
    const { messageId } = ok(await o.call("POST", "/test-message", {}), 201);
    expect(await drain()).toEqual(["skipped"]);
    expect(ok(await o.call("GET", `/messages/${messageId}`)).message).toMatchObject({ status: "skipped", reason: "suppressed" });
    expect(ok(await o.call("POST", "/test-number", { phone: TEST_PHONE }), 409).error).toBe("suppressed");

    // A customer's STOP whose first try recorded the message and then failed: the retry still opts them out.
    ok(await o.call("POST", "/messages", { phone: CUSTOMER, reason: "order_update", text: "Shipped.", idempotencyKey: "dnm-00000001", customerAsked: true }), 201);
    await drain();
    const contact = await systemDb.wappContact.findFirstOrThrow({ where: { storeId: o.store.id } });
    const conn = await systemDb.wappConnection.findUniqueOrThrow({ where: { storeId: o.store.id } });
    await systemDb.wappMessage.create({
      data: { workspaceId: o.ws, storeId: o.store.id, connectionId: conn.id, direction: "in", contactId: contact.id, phoneHash: contact.phoneHash, phoneMasked: contact.phoneMasked, source: "inbound", type: "conversation", status: "received", providerMessageId: "INSTOP0001", acceptedAt: new Date(), finalAt: new Date(), sendAfter: new Date() },
    });
    await deliver(inbound(name, CUSTOMER, "STOP", { id: "INSTOP0001" }));
    expect(await drain()).toEqual(["stop", "accepted"]);
    expect(await systemDb.wappContact.findUniqueOrThrow({ where: { id: contact.id } })).toMatchObject({ optedOut: true });
    // Delivered once more, it changes nothing.
    await deliver(inbound(name, CUSTOMER, "STOP", { id: "INSTOP0001" }));
    expect(await drain()).toEqual(["duplicate"]);
  });
});

describe("automations from Shopify's events", () => {
  async function ready() {
    const o = await owner();
    await connect(o);
    await configure(o);
    await finishSetup(o);
    const template = ok(await o.call("POST", "/templates", { name: "Order thanks", category: "transactional", body: "Hi {{customer_first_name}}, thanks for order {{order_number}} from {{store_name}}." }), 201).template;
    const automation = ok(await o.call("POST", "/automations", { name: "Thank you", trigger: "order_created", templateId: template.id }), 201).automation;
    expect(automation).toMatchObject({ status: "draft", testMode: true, problems: [] });
    ok(await o.call("POST", `/automations/${automation.id}/activate`));
    const store = (await systemDb.store.findUniqueOrThrow({ where: { id: o.store.id } })) as Store;
    return { o, store, template, automation };
  }

  it("runs once per order, in test mode only to the verified number, then to the customer", async () => {
    const { o, store, automation } = await ready();
    evo.sends.length = 0;
    await whatsappOnShopifyEvent(store, "orders/create", ORDER(1001), ctx.deps);
    await whatsappOnShopifyEvent(store, "orders/create", ORDER(1001), ctx.deps);
    expect(await drain()).toEqual(["accepted"]);
    expect(evo.sends).toEqual([expect.objectContaining({ body: expect.objectContaining({ number: "61400111222", text: "Hi Pat, thanks for order #1001 from Green Leaf." }) })]);
    const runs = ok(await o.call("GET", `/automations/${automation.id}`)).runs;
    expect(runs).toEqual([expect.objectContaining({ subject: "Order #1001", outcome: "queued", testMode: true, messageStatus: "accepted" })]);

    // Test mode off: the customer gets it.
    ok(await o.call("PUT", `/automations/${automation.id}`, { ...automationBody(automation), testMode: false }));
    await whatsappOnShopifyEvent(store, "orders/create", ORDER(1002), ctx.deps);
    expect(await drain()).toEqual(["accepted"]);
    expect(evo.sends.at(-1)!.body).toMatchObject({ number: "61412345678", text: "Hi Pat, thanks for order #1002 from Green Leaf." });

    // Old news, an order already cancelled, a paused store: nothing goes.
    await whatsappOnShopifyEvent(store, "orders/create", ORDER(1003, { created_at: "2026-01-01T00:00:00Z", processed_at: "2026-01-01T00:00:00Z" }), ctx.deps);
    await whatsappOnShopifyEvent(store, "orders/create", ORDER(1004, { cancelled_at: new Date().toISOString() }), ctx.deps);
    ok(await o.call("POST", "/settings/pause", { paused: true }));
    await whatsappOnShopifyEvent(store, "orders/create", ORDER(1005), ctx.deps);
    expect(await drain()).toEqual([]);
    const reasons = (await systemDb.wappAutomationRun.findMany({ where: { automationId: automation.id }, orderBy: { createdAt: "asc" } })).map((r) => `${r.subjectKey}:${r.reason ?? r.outcome}`);
    expect(reasons).toEqual(["order:1001:test_mode", "order:1002:queued", "order:1003:stale_event", "order:1005:automation_paused"]);
  });

  it("finishes a run whose message an earlier try never linked, with one message", async () => {
    const { store, automation } = await ready();
    await systemDb.wappAutomationRun.create({
      data: { workspaceId: store.workspaceId, storeId: store.id, automationId: automation.id, automationVersion: 1, trigger: "order_created", subjectKey: "order:2001", subjectLabel: "Order #2001", outcome: "queued", testMode: true },
    });
    await whatsappOnShopifyEvent(store, "orders/create", ORDER(2001), ctx.deps);
    await whatsappOnShopifyEvent(store, "orders/create", ORDER(2001), ctx.deps);
    const run = await systemDb.wappAutomationRun.findUniqueOrThrow({ where: { automationId_subjectKey: { automationId: automation.id, subjectKey: "order:2001" } } });
    expect(run.messageId).not.toBeNull();
    expect(await systemDb.wappMessage.count({ where: { storeId: store.id, idempotencyKey: `auto:${automation.id}:order:2001` } })).toBe(1);
  });

  it("can't be switched on before the setup is done, and says why", async () => {
    const o = await owner();
    await connect(o);
    const template = ok(await o.call("POST", "/templates", { name: "Shipped", category: "transactional", body: "Your order {{order_number}} is on its way: {{tracking_url}}" }), 201).template;
    const a = ok(await o.call("POST", "/automations", { name: "Shipped", trigger: "order_created", templateId: template.id }), 201).automation;
    expect(a.problems).toEqual(expect.arrayContaining([expect.stringMatching(/Step 3/), expect.stringMatching(/Step 4/), expect.stringMatching(/\{\{tracking_url\}\}/)]));
    const res = ok(await o.call("POST", `/automations/${a.id}/activate`), 409);
    expect(res.error).toBe("automation_blocked");
    expect(res.detail.problems.length).toBeGreaterThanOrEqual(3);
  });
});

function automationBody(a: { name: string; trigger: string; templateId: string; conditions: unknown[]; recipient: string; delayMinutes: number; sendWindow: unknown; testMode: boolean; cooldownMinutes: number | null; description: string | null }) {
  return { name: a.name, description: a.description, trigger: a.trigger, templateId: a.templateId, conditions: a.conditions, recipient: a.recipient, delayMinutes: a.delayMinutes, sendWindow: a.sendWindow, testMode: a.testMode, ...(a.cooldownMinutes != null ? { cooldownMinutes: a.cooldownMinutes } : {}) };
}

describe("campaigns", () => {
  it("launches only with the exact count the merchant confirmed, to customers who agreed to marketing and can be greeted", async () => {
    const o = await owner();
    await connect(o);
    await configure(o);
    await finishSetup(o);
    evo.sends.length = 0;
    const marketing = ok(await o.call("POST", "/templates", { name: "Spring sale", category: "marketing", body: "Hi {{customer_first_name}}, 20% off at {{store_name}} this week. Reply STOP to unsubscribe." }), 201).template;
    const transactional = ok(await o.call("POST", "/templates", { name: "Plain", category: "transactional", body: "Hello from {{store_name}}." }), 201).template;
    for (const [phone, name] of [["+61412000001", "Sam"], ["+61412000002", "Alex"], ["+61412000004", null]] as const) {
      const { contact } = ok(await o.call("POST", "/contacts/consent", { phone, scope: "marketing", status: "opted_in", note: "Asked at the counter" }));
      if (name) await systemDb.wappContact.update({ where: { id: contact.id }, data: { firstNameEnc: waEncrypt(o.store.id, "name", name) } });
    }
    // One who agreed and then said STOP isn't in the audience.
    ok(await o.call("POST", "/contacts/consent", { phone: "+61412000003", scope: "marketing", status: "opted_in" }));
    ok(await o.call("POST", "/contacts/consent", { phone: "+61412000003", scope: "all", status: "opted_out" }));

    expect(ok(await o.call("POST", "/campaigns/estimate", { audience: {} })).count).toBe(3);
    // The template greets them by name: the one without a name is left out of the count, not dropped later.
    expect(ok(await o.call("POST", "/campaigns/estimate", { audience: {}, templateId: marketing.id })).count).toBe(2);
    expect(ok(await o.call("POST", "/campaigns", { name: "Plain", templateId: transactional.id, audience: {} }), 400).error).toBe("not_marketing");
    const c = ok(await o.call("POST", "/campaigns", { name: "Spring", templateId: marketing.id, audience: {} }), 201).campaign;
    expect(c).toMatchObject({ status: "draft", audienceLabel: "Customers who agreed to marketing messages" });
    expect(ok(await o.call("POST", `/campaigns/${c.id}/launch`, { confirmRecipients: 3 }), 409)).toMatchObject({ error: "count_changed", detail: { count: 2 } });
    expect(ok(await o.call("POST", `/campaigns/${c.id}/launch`, { confirmRecipients: 2 })).campaign.status).toBe("scheduled");
    expect(ok(await o.call("POST", `/campaigns/${c.id}/launch`, { confirmRecipients: 2 }), 409).error).toBe("not_draft");
    expect(await drain()).toEqual(["materialized", "accepted", "accepted"]);
    expect(evo.sends.map((s) => [s.body.number, s.body.text]).sort()).toEqual([
      ["61412000001", "Hi Sam, 20% off at Green Leaf this week. Reply STOP to unsubscribe."],
      ["61412000002", "Hi Alex, 20% off at Green Leaf this week. Reply STOP to unsubscribe."],
    ]);
    const report = ok(await o.call("GET", `/campaigns/${c.id}`)).campaign;
    expect(report).toMatchObject({ status: "sending", recipients: 2, confirmedRecipients: 2 });
  });
});

describe("who may see and do what", () => {
  it("keeps every store's WhatsApp to its own workspace, including its webhook", async () => {
    const a = await owner("a", "a@shop.test");
    const nameA = await connect(a);
    await configure(a);
    const m = ok(await a.call("POST", "/messages", { phone: CUSTOMER, reason: "order_update", text: "Hi", idempotencyKey: "iso-00000001", customerAsked: true }), 201).message;
    const b = await owner("b", "b@other.test");
    const nameB = await connect(b, "61400000088");

    // B can't reach A's store through A's workspace, nor through its own.
    expect((await a.call("GET", "", undefined, b.headers)).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: "GET", url: `/workspaces/${b.ws}/stores/${a.store.id}/whatsapp`, headers: b.headers })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: "GET", url: `/workspaces/${b.ws}/stores/${b.store.id}/whatsapp/messages/${m.id}`, headers: b.headers })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: "DELETE", url: `/workspaces/${a.ws}/stores/${a.store.id}/whatsapp/connection`, headers: b.headers })).statusCode).toBe(404);
    expect(ok(await b.call("GET", "/messages")).messages).toEqual([]);
    // B's connection key doesn't open A's webhook.
    const forged = evo.webhook(nameA, "connection.update", { state: "close", statusReason: 401 }, { key: evo.instances.get(nameB)!.webhook!.jwtKey });
    expect((await deliver(forged)).statusCode).toBe(401);
    expect(ok(await a.call("GET")).connection.status).toBe("connected");
  });

  it("lets a viewer look, without customers' details unless granted, and change nothing", async () => {
    const o = await owner();
    await connect(o);
    await configure(o);
    ok(await o.call("POST", "/messages", { phone: CUSTOMER, reason: "order_update", text: "Secret text", idempotencyKey: "view-00000001", customerAsked: true }), 201);
    const v = await signIn(ctx, "v", "v@shop.test");
    await systemDb.membership.create({ data: { workspaceId: o.ws, userId: v.user.id, role: "custom", permissions: ["marketing.campaigns"] } });
    const ov = ok(await o.call("GET", "", undefined, v.headers));
    expect(ov.can).toEqual({ connect: false, manage: false, contacts: false });
    expect(ov.cloudSignup).toBeNull();
    const [msg] = ok(await o.call("GET", "/messages", undefined, v.headers)).messages;
    expect(msg).toMatchObject({ preview: null, contactId: null });
    expect((await o.call("GET", "/contacts", undefined, v.headers)).statusCode).toBe(403);
    expect((await o.call("GET", `/messages?phone=${encodeURIComponent(CUSTOMER)}`, undefined, v.headers)).statusCode).toBe(403);
    for (const [method, path, payload] of [
      ["POST", "/connection", { method: "qr" }],
      ["DELETE", "/connection", undefined],
      ["PUT", "/settings", SETTINGS],
      ["POST", "/settings/pause", { paused: true }],
      ["POST", "/test-number", { phone: TEST_PHONE }],
      ["POST", "/messages", { phone: CUSTOMER, reason: "reply", text: "x", idempotencyKey: "view-00000002" }],
      ["POST", "/templates", { name: "x", category: "transactional", body: "x" }],
      ["POST", "/automations", {}],
      ["POST", "/campaigns", {}],
      ["POST", "/campaigns/estimate", { audience: {} }],
      ["POST", "/suppressions", { phone: CUSTOMER, scope: "all" }],
    ] as const) {
      expect((await o.call(method, path, payload, v.headers)).statusCode, `${method} ${path}`).toBe(403);
    }
    // Nobody without "View campaigns" sees WhatsApp at all.
    const w = await signIn(ctx, "w", "w@shop.test");
    await systemDb.membership.create({ data: { workspaceId: o.ws, userId: w.user.id, role: "custom", permissions: ["analytics.sales"] } });
    expect((await o.call("GET", "", undefined, w.headers)).statusCode).toBe(403);
    // Settings → Integrations for someone who may see how connections stand: the connection, and nothing else.
    const s = await signIn(ctx, "s", "s@shop.test");
    await systemDb.membership.create({ data: { workspaceId: o.ws, userId: s.user.id, role: "custom", permissions: ["integrations.status"] } });
    const status = ok(await o.call("GET", "", undefined, s.headers));
    expect(Object.keys(status).sort()).toEqual(["can", "connection", "platform", "store"]);
    expect(status.connection).toMatchObject({ status: "connected" });
    for (const path of ["/messages", "/automations", "/templates", "/campaigns"]) expect((await o.call("GET", path, undefined, s.headers)).statusCode, path).toBe(403);
  });

  it("never lets a shared dashboard link administer WhatsApp, whatever it was given", async () => {
    const o = await owner();
    await connect(o);
    ok(await ctx.app.inject({ method: "POST", url: `/workspaces/${o.ws}/team/invitations`, headers: o.headers, payload: { email: "guest@example.com", role: "custom", permissions: ["marketing.campaigns", "customers.list", "customers.contact", "integrations.status", "integrations.manage"] } }));
    const mail = [...ctx.mailer.sent].reverse().find((x) => x.to === "guest@example.com")!;
    const token = /#token=([A-Za-z0-9_-]+)/.exec(mail.text)![1];
    const opened = ok(await ctx.app.inject({ method: "POST", url: "/invitations/open", headers: ORIGIN, payload: { token } }));
    expect(opened.shared).toBe(true);
    const link = { cookie: cookiesFrom(await ctx.app.inject({ method: "POST", url: "/invitations/open", headers: ORIGIN, payload: { token } })), ...ORIGIN };
    const ov = ok(await o.call("GET", "", undefined, link));
    expect(ov.can).toMatchObject({ connect: false, manage: false });
    for (const [method, path, payload] of [
      ["POST", "/connection", { method: "qr" }],
      ["DELETE", "/connection", undefined],
      ["POST", "/connection/reconnect", undefined],
      ["PUT", "/settings", SETTINGS],
      ["POST", "/templates", { name: "x", category: "transactional", body: "x" }],
    ] as const) {
      expect((await o.call(method, path, payload, link)).statusCode, `${method} ${path}`).toBe(403);
    }
  });
});

describe("disconnecting", () => {
  it("logs the phone out, deletes the instance, cancels what waits, and keeps the history", async () => {
    const o = await owner();
    const name = await connect(o);
    await configure(o);
    ok(await o.call("POST", "/messages", { phone: CUSTOMER, reason: "order_update", text: "Sent", idempotencyKey: "disc-00000001", customerAsked: true }), 201);
    await drain();
    ok(await o.call("POST", "/messages", { phone: CUSTOMER, reason: "order_update", text: "Waiting", idempotencyKey: "disc-00000002" }), 201);
    const res = ok(await o.call("DELETE", "/connection"));
    expect(res.connection.status).toBe("disconnected");
    expect(evo.instances.has(name)).toBe(false);
    expect(evo.calls.slice(-2).map((c) => `${c.method} ${c.path.split("/").slice(0, 3).join("/")}`)).toEqual(["DELETE /instance/logout", "DELETE /instance/delete"]);
    const rows = await systemDb.wappMessage.findMany({ where: { storeId: o.store.id }, orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => [r.status, r.reason])).toEqual([
      ["accepted", null],
      ["cancelled", "not_connected"],
    ]);
    expect(await systemDb.wappConnection.findUniqueOrThrow({ where: { storeId: o.store.id } })).toMatchObject({ instanceName: null, instanceTokenEnc: null, webhookKeyEnc: null });
    // The old instance's webhooks no longer get in.
    expect((await deliver(evo.webhook(name, "connection.update", { state: "open" }, { key: "x" }))).statusCode).toBe(401);
    expect(ok(await o.call("DELETE", "/connection"), 404).error).toBe("not_connected");
    // Connecting again makes a new instance.
    ok(await o.call("POST", "/connection", { method: "qr" }), 201);
    expect(await instanceOf(o)).not.toBe(name);
  });
});

describe("the Customers tab: whole numbers, and the store's customers from Shopify", () => {
  /** The store as connected to Shopify (a token bizinsights can use). */
  async function connected(o: Owner, scopes = ["read_orders", "read_customers"]) {
    await systemDb.store.update({ where: { id: o.store.id }, data: encryptTokenFields(o.store.id, { accessToken: "shpat_test", scopes, accessTokenExpiresAt: null, refreshToken: null, refreshTokenExpiresAt: null }) });
  }

  /** Shopify's Admin GraphQL answering `answer` for every query, next to the Evolution fake; returns what was asked. */
  function shopify(answer: (req: { query: string; variables: Record<string, unknown> }) => unknown) {
    const asked: Array<{ query: string; variables: Record<string, unknown> }> = [];
    ctx.setFetch(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.includes(".myshopify.com/admin/api/")) return evo.fetch(input, init);
      const req = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables: Record<string, unknown> };
      asked.push(req);
      return new Response(JSON.stringify(answer(req)), { status: 200, headers: { "content-type": "application/json" } });
    });
    return asked;
  }

  /** A member of the owner's workspace with these permissions. */
  async function member(o: Owner, uid: string, permissions: string[]) {
    const m = await signIn(ctx, uid, `${uid}@shop.test`);
    await systemDb.membership.create({ data: { workspaceId: o.ws, userId: m.user.id, role: "custom", permissions } });
    return m.headers;
  }

  const search = (text: string, headers: Record<string, string>) => ({ ...headers, "x-search": encodeURIComponent(text) });
  const contactsCount = (o: Owner) => systemDb.wappContact.count({ where: { storeId: o.store.id } });

  const node = (id: number, name: string | null, extra: Record<string, unknown> = {}) => ({
    id: `gid://shopify/Customer/${id}`,
    displayName: name,
    numberOfOrders: "1",
    amountSpent: { amount: "50.00", currencyCode: "AUD" },
    defaultPhoneNumber: null,
    defaultAddress: null,
    lastOrder: null,
    ...extra,
  });
  const PAGE_ONE = [
    // The profile's own number, with Shopify's text-message consent.
    node(11, "Jane Doe", { numberOfOrders: "2", amountSpent: { amount: "120.50", currencyCode: "AUD" }, defaultPhoneNumber: { phoneNumber: "+61412345678", smsMarketingConsent: { state: "SUBSCRIBED" } } }),
    // Typed locally on the saved address: read in that address's country.
    node(12, "Bob Lee", { defaultAddress: { phone: "0498 765 432", countryCodeV2: "AU" } }),
    // Only on the last order's delivery address.
    node(13, "Ana Ruiz", { lastOrder: { phone: null, shippingAddress: { phone: "0411 000 000", countryCodeV2: "AU" }, billingAddress: null } }),
    // No country anywhere: the store's own (from Shopify's shop address), said to be assumed.
    node(14, "Lee Wong", { lastOrder: { phone: "412 555 999", shippingAddress: null, billingAddress: null } }),
    // Not a number WhatsApp could use: shown as typed.
    node(15, "Kim Park", { defaultAddress: { phone: "12345", countryCodeV2: null } }),
    node(16, "Sam Fox"),
  ];
  const answer = (nodes: unknown[], next: string | null = "CURSOR1") => ({
    data: { shop: { shopAddress: { countryCodeV2: "AU" } }, customers: { pageInfo: { hasNextPage: !!next, endCursor: next }, nodes } },
  });

  it("shows the whole number of the customers WhatsApp keeps to those allowed to see contact details, and names with profiles", async () => {
    const o = await owner();
    const recorded = await o.call("POST", "/contacts/consent", { phone: "+61 412 345 678", scope: "marketing", status: "opted_in", note: "Asked at the counter" });
    expect(recorded.headers["cache-control"]).toBe("no-store");
    const { contact } = ok(recorded);
    expect(contact.phone).toBe(CUSTOMER);
    expect(contact.phoneMasked).toMatch(/^\+61 •+ 678$/);
    await systemDb.wappContact.update({ where: { id: contact.id }, data: { firstNameEnc: waEncrypt(o.store.id, "name", "Pat") } });

    const res = await o.call("GET", "/contacts");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(ok(res).contacts).toEqual([expect.objectContaining({ id: contact.id, phone: CUSTOMER, phoneMasked: contact.phoneMasked, firstName: "Pat", marketing: "opted_in" })]);
    // Viewing them is audited (who, which store), the numbers aren't in the log.
    const log = await systemDb.auditLog.findFirstOrThrow({ where: { workspaceId: o.ws, action: "whatsapp.contacts_viewed" } });
    expect(log).toMatchObject({ actorUserId: o.user.id, targetId: o.store.id });
    expect(JSON.stringify(await systemDb.auditLog.findMany({ where: { workspaceId: o.ws } }))).not.toContain("412345678");

    // A number is searched for from a header, never the address; the old address form still works.
    expect(ok(await o.call("GET", "/contacts", undefined, search("+61 412 345 678", o.headers))).contacts).toHaveLength(1);
    expect(ok(await o.call("GET", "/contacts", undefined, search("+61 499 999 999", o.headers))).contacts).toHaveLength(0);
    expect(ok(await o.call("GET", `/contacts?phone=${encodeURIComponent(CUSTOMER)}`)).contacts).toHaveLength(1);
    expect(ok(await o.call("GET", "/contacts", undefined, search("0412", o.headers)), 400).error).toBe("invalid_phone");

    // Contact details without customer profiles: the whole number, no name.
    const contactOnly = await member(o, "m1", ["marketing.campaigns", "customers.list", "customers.contact"]);
    expect(ok(await o.call("GET", "/contacts", undefined, contactOnly)).contacts[0]).toMatchObject({ phone: CUSTOMER, firstName: null });
    const withProfiles = await member(o, "m2", ["marketing.campaigns", "customers.list", "customers.contact", "customers.profiles"]);
    expect(ok(await o.call("GET", "/contacts", undefined, withProfiles)).contacts[0]).toMatchObject({ phone: CUSTOMER, firstName: "Pat" });
    // Without "View contact information": neither list.
    const noContact = await member(o, "m3", ["marketing.campaigns", "customers.list", "customers.profiles"]);
    expect((await o.call("GET", "/contacts", undefined, noContact)).statusCode).toBe(403);
    expect((await o.call("GET", "/customers", undefined, noContact)).statusCode).toBe(403);
    // The do-not-message list keeps no whole number: still masked.
    ok(await o.call("POST", "/suppressions", { phone: CUSTOMER, scope: "marketing" }), 201);
    const [s] = ok(await o.call("GET", "/suppressions")).suppressions;
    expect(s.phone).toMatch(/^\+61 •+ 678$/);
  });

  it("lists the store's customers live from Shopify with their whole numbers and WhatsApp's records for them, and stores none of it", async () => {
    const o = await owner();
    await connected(o);
    // What WhatsApp already knows: one agreed to marketing, one opted out, one only on the do-not-message list.
    const jane = ok(await o.call("POST", "/contacts/consent", { phone: CUSTOMER, scope: "marketing", status: "opted_in" })).contact;
    const bob = ok(await o.call("POST", "/contacts/consent", { phone: "+61498765432", scope: "all", status: "opted_out" })).contact;
    ok(await o.call("POST", "/suppressions", { phone: "+61411000000", scope: "marketing" }), 201);
    const before = await contactsCount(o);
    const suppressionsBefore = await systemDb.wappSuppression.count({ where: { storeId: o.store.id } });

    const asked = shopify(() => answer(PAGE_ONE));
    const res = await o.call("GET", "/customers");
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = ok(res);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.variables).toEqual({ first: 50, after: null, query: null, sortKey: "CREATED_AT", reverse: true });
    for (const field of ["pageInfo", "defaultPhoneNumber", "defaultAddress", "lastOrder", "shopAddress", "countryCodeV2"]) expect(asked[0]!.query).toContain(field);
    expect(body).toMatchObject({ restricted: false, nextCursor: "CURSOR1", page: { count: 6, withNumber: 5, withoutCountryCode: 1 }, shown: { names: true, orders: true }, shopAdminUrl: "https://u1.myshopify.com/admin" });

    const [j, b, a, l, k, s] = body.customers;
    expect(j).toEqual({
      customerId: "11",
      name: "Jane Doe",
      adminUrl: "https://u1.myshopify.com/admin/customers/11",
      phone: CUSTOMER,
      phoneE164: CUSTOMER,
      phoneRaw: CUSTOMER,
      phoneSource: "customer",
      phoneCountryAssumed: false,
      smsSubscribed: true,
      orders: 2,
      spent: 120.5,
      currency: "AUD",
      whatsapp: { contactId: jane.id, optedOut: false, optedIn: false, marketing: "opted_in", suppressed: null, notOnWhatsapp: false, lastOutboundAt: null },
    });
    expect(b).toMatchObject({ phone: "+61498765432", phoneRaw: "0498 765 432", phoneSource: "default_address", phoneCountryAssumed: false, smsSubscribed: false, whatsapp: { contactId: bob.id, optedOut: true, marketing: "opted_out", suppressed: null } });
    expect(a).toMatchObject({ phone: "+61411000000", phoneSource: "last_order_shipping", whatsapp: { contactId: null, optedOut: false, marketing: "unknown", suppressed: "marketing" } });
    expect(l).toMatchObject({ phone: "+61412555999", phoneRaw: "412 555 999", phoneSource: "last_order", phoneCountryAssumed: true, whatsapp: null });
    expect(k).toMatchObject({ phone: "12345", phoneE164: null, phoneRaw: "12345", whatsapp: null });
    expect(s).toMatchObject({ customerId: "16", phone: null, phoneE164: null, phoneSource: null, whatsapp: null });

    // Nothing of it was written: no new contact, no new list entry, no number in the audit log.
    expect(await contactsCount(o)).toBe(before);
    expect(await systemDb.wappSuppression.count({ where: { storeId: o.store.id } })).toBe(suppressionsBefore);
    const log = await systemDb.auditLog.findFirstOrThrow({ where: { workspaceId: o.ws, action: "whatsapp.customers_viewed" } });
    expect(log).toMatchObject({ actorUserId: o.user.id, targetId: o.store.id });
    const dump = JSON.stringify(await systemDb.auditLog.findMany({ where: { workspaceId: o.ws } }));
    expect(dump).not.toContain("Jane");
    expect(dump).not.toContain("498765432");

    // The next page, with Shopify's cursor.
    const asked2 = shopify(() => answer([node(17, "Max Bell")], null));
    expect(ok(await o.call("GET", "/customers?cursor=CURSOR1"))).toMatchObject({ nextCursor: null, customers: [{ customerId: "17" }] });
    expect(asked2[0]!.variables).toMatchObject({ after: "CURSOR1", sortKey: "CREATED_AT" });
    expect((await o.call("GET", "/customers?cursor=not%20a%20cursor")).statusCode).toBe(400);

    // WhatsApp said lately that a number has no account: shown so.
    await systemDb.wappContact.update({ where: { id: jane.id }, data: { notOnWhatsappAt: new Date(Date.now() - 2 * 86_400_000) } });
    shopify(() => answer(PAGE_ONE.slice(0, 1)));
    expect(ok(await o.call("GET", "/customers")).customers[0].whatsapp.notOnWhatsapp).toBe(true);
  });

  it("searches Shopify by name, email or the whole number, without the search in the address", async () => {
    const o = await owner();
    await connected(o);
    const asked = shopify(() => answer(PAGE_ONE.slice(0, 1), null));
    ok(await o.call("GET", "/customers", undefined, search("Jane", o.headers)));
    expect(asked.at(-1)!.variables).toMatchObject({ query: "Jane", sortKey: "RELEVANCE", reverse: false });
    // Shopify's own syntax (fields, phrases, NOT) is taken as plain words.
    ok(await o.call("GET", "/customers", undefined, search('email:"bob" (x) -smith', o.headers)));
    expect(asked.at(-1)!.variables.query).toBe("email bob x smith");
    // An international number: searched as one.
    const n = asked.length;
    ok(await o.call("GET", "/customers", undefined, search("+61 412 345 678", o.headers)));
    expect(asked.length).toBe(n + 1);
    expect(asked.at(-1)!.variables.query).toBe("phone:+61412345678");
    // A local one: read in the store's country (Shopify's shop address), then searched.
    ok(await o.call("GET", "/customers", undefined, search("0412 345 678", o.headers)));
    expect(asked.length).toBe(n + 3);
    expect(asked.at(-2)!.query).toContain("WaShopCountry");
    expect(asked.at(-1)!.variables.query).toBe("phone:+61412345678");
  });

  it("gives names and order figures only with their own permissions, and a shared link may look", async () => {
    const o = await owner();
    await connected(o);
    shopify(() => answer(PAGE_ONE.slice(0, 1)));
    const contactOnly = await member(o, "c1", ["marketing.campaigns", "customers.list", "customers.contact"]);
    const seen = ok(await o.call("GET", "/customers", undefined, contactOnly));
    expect(seen.shown).toEqual({ names: false, orders: false });
    expect(seen.customers[0]).toMatchObject({ customerId: "11", name: null, adminUrl: null, orders: null, spent: null, phone: CUSTOMER });
    const everything = await member(o, "c2", ["marketing.campaigns", "customers.list", "customers.contact", "customers.profiles", "customers.orders"]);
    expect(ok(await o.call("GET", "/customers", undefined, everything)).customers[0]).toMatchObject({ name: "Jane Doe", orders: 2, phone: CUSTOMER });
    // "View campaigns" alone: no customers at all, and Shopify is never asked.
    const asked = shopify(() => answer(PAGE_ONE));
    const viewer = await member(o, "c3", ["marketing.campaigns"]);
    expect((await o.call("GET", "/customers", undefined, viewer)).statusCode).toBe(403);
    expect(asked).toHaveLength(0);

    // A shared dashboard link given the same permissions may read the list (as Customers to follow up), never change anything.
    ok(await ctx.app.inject({ method: "POST", url: `/workspaces/${o.ws}/team/invitations`, headers: o.headers, payload: { email: "guest@example.com", role: "custom", permissions: ["marketing.campaigns", "customers.list", "customers.contact"] } }));
    const mail = [...ctx.mailer.sent].reverse().find((x) => x.to === "guest@example.com")!;
    const token = /#token=([A-Za-z0-9_-]+)/.exec(mail.text)![1];
    const link = { cookie: cookiesFrom(await ctx.app.inject({ method: "POST", url: "/invitations/open", headers: ORIGIN, payload: { token } })), ...ORIGIN };
    expect(ok(await o.call("GET", "/customers", undefined, link)).customers[0]).toMatchObject({ phone: CUSTOMER, name: null });
    expect((await o.call("POST", "/contacts/consent", { phone: CUSTOMER, scope: "marketing", status: "opted_out" }, link)).statusCode).toBe(403);
  });

  it("says when Shopify withholds customers' details, and needs the store connected with access to customers", async () => {
    const o = await owner();
    // No token yet: the store isn't connected.
    expect(ok(await o.call("GET", "/customers"), 409).error).toBe("store_disconnected");
    await connected(o);
    shopify(() => ({ ...answer([node(21, null), node(22, null)]), errors: [{ message: "Access denied for displayName field", extensions: { code: "ACCESS_DENIED" } }] }));
    expect(ok(await o.call("GET", "/customers"))).toMatchObject({ restricted: true, customers: [], nextCursor: null });
    shopify(() => ({ data: null, errors: [{ message: "Access denied for customers field", extensions: { code: "ACCESS_DENIED" } }] }));
    expect(ok(await o.call("GET", "/customers"))).toMatchObject({ restricted: true, customers: [] });
    // Without read_customers: a plain refusal, and Shopify isn't asked.
    await connected(o, ["read_orders"]);
    const asked = shopify(() => answer(PAGE_ONE));
    expect(ok(await o.call("GET", "/customers"), 403).error).toBe("missing_scopes");
    expect(asked).toHaveLength(0);
  });
});

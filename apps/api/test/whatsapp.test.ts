import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { systemDb, type Store } from "@app/db";
import { dispatchCampaign, processWebhookEvent, queueMessage, sendQueuedMessage, waEncrypt, whatsappOnShopifyEvent } from "@app/core";
import { normalizePhone } from "@app/shared";
import { cloudApiFake, META_APP_SECRET, META_ENV, META_ENV_OFF, type CloudFake } from "../../../test-support/cloudApiFake.js";
import { clean, cookiesFrom, createStore, createWorkspace, ORIGIN, setup, signIn, teardown, type TestCtx } from "./helpers.js";

/**
 * WhatsApp Automation on Meta's WhatsApp Business Platform (apps/api/src/routes/whatsapp.ts,
 * whatsappWebhook.ts; packages/core/src/whatsapp): connecting through Embedded Signup (and every
 * way Meta's answer is refused), "connected" and "sent" only on Meta's word, Meta's signed webhook
 * (statuses, customers' messages, template reviews, each applied once), the test number and the test
 * message's real status, sends from the dashboard (consent, the 24-hour window, templates,
 * attachments, uncertain sends, retries, Meta's limits, an access Meta ended), customers' STOP and
 * START, automations and campaigns with templates Meta approved, tenant isolation, who may do what,
 * disconnecting, and phones linked with a QR code retired without anything lost. Meta's Graph API is
 * test-support/cloudApiFake.ts.
 */

let ctx: TestCtx;
let meta: CloudFake;
const TEST_PHONE = "+61400111222";
const CUSTOMER = "+61412345678";

beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => {
  ctx.setEnv(META_ENV_OFF);
  await teardown(ctx);
});
beforeEach(async () => {
  await clean(ctx);
  meta = cloudApiFake();
  ctx.setFetch(meta.fetch);
  ctx.setEnv(META_ENV);
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
type Signup = ReturnType<CloudFake["signup"]>;

function ok<T = any>(res: { statusCode: number; body: string; json(): any }, status = 200): T { // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(res.statusCode, res.body).toBe(status);
  return res.json();
}

/** Delivers Meta's webhook as Meta posts it. */
const deliver = (w: { url: string; headers: Record<string, string>; body: string }) => ctx.app.inject({ method: "POST", url: w.url, headers: w.headers, payload: w.body });

/** Steps 1-2: Meta's window finished (the fake's signup), then the page hands its code to bizinsights. */
async function connect(o: Owner, opts: Parameters<CloudFake["signup"]>[0] = {}): Promise<Signup> {
  const s = meta.signup(opts);
  const { connection } = ok(await o.call("POST", "/connection/cloud", { code: s.code, wabaId: s.wabaId, phoneNumberId: s.phoneNumberId, businessId: s.businessId }), 201);
  expect(connection).toMatchObject({ provider: "cloud_api", status: "connected" });
  return s;
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

/** The pace between a number's messages, waived (the tests send one after another at once). */
const releasePace = async () => {
  for (const c of await systemDb.wappConnection.findMany({ select: { id: true } })) await ctx.deps.coord.release(`wapp:pace:${c.id}`);
};

/**
 * The worker, in-process: sends what waits on the whatsapp queue, and applies stored webhook events
 * and campaign batches, until nothing is left. The pace between a number's messages is waived; a job
 * SQS would deliver later (a retry, a hold: more than a campaign's few seconds) isn't due yet.
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
        await releasePace();
        out.push(await sendQueuedMessage(ctx.deps, j.messageId));
      } else if (j.kind === "wapp_event") out.push(await processWebhookEvent(ctx.deps, j.eventId));
      else out.push(await dispatchCampaign(ctx.deps, j.campaignId));
    }
  }
  return out;
}

/** Step 4: the test number verified with the code Meta delivered, and a test message Meta reported sent. */
async function finishSetup(o: Owner) {
  ok(await o.call("POST", "/test-number", { phone: TEST_PHONE }));
  await drain();
  const code = /is (\d{6})\./.exec(meta.sends.at(-1)!.text ?? "")![1];
  ok(await o.call("POST", "/test-number/verify", { code }));
  const { messageId } = ok(await o.call("POST", "/test-message", {}), 201);
  await drain();
  ok(await deliver(meta.status(meta.sends.at(-1)!, "sent")));
  expect(ok(await o.call("GET", `/messages/${messageId}`)).message.status).toBe("sent");
}

/** A template written in bizinsights, submitted to Meta, and approved by Meta's webhook. */
async function approvedTemplate(o: Owner, t: { name: string; category: "transactional" | "marketing"; body: string }) {
  const created = ok(await o.call("POST", "/templates", t), 201).template;
  expect(created).toMatchObject({ usable: false, unusableReason: "It hasn't been submitted to Meta yet." });
  const submitted = ok(await o.call("POST", `/templates/${created.id}/submit`)).template;
  expect(submitted.meta).toMatchObject({ status: "PENDING", language: "en" });
  const atMeta = meta.templates.at(-1)!;
  expect(atMeta).toMatchObject({ name: submitted.meta.name, category: t.category === "marketing" ? "MARKETING" : "UTILITY" });
  ok(await deliver(meta.templateReview(atMeta.id, "APPROVED")));
  const approved = ok(await o.call("GET", "/templates")).templates.find((x: { id: string }) => x.id === created.id);
  expect(approved).toMatchObject({ usable: true, meta: { status: "APPROVED" } });
  return approved as { id: string; meta: { name: string } };
}

/** A customer the store knows (their consent recorded), who then writes to the store's number. */
async function customerWrites(o: Owner, s: Signup, phone: string, text: string) {
  ok(await o.call("POST", "/contacts/consent", { phone, scope: "order_updates", status: "opted_in" }));
  ok(await deliver(meta.inbound(s.phoneNumberId, phone, text)));
}

describe("connecting through Meta's Embedded Signup (Steps 1-2)", () => {
  it("is connected only once Meta answered every check, keeps the token sealed, and shows none of it", async () => {
    const o = await owner();
    const before = ok(await o.call("GET"));
    expect(before).toMatchObject({ connection: null, platform: { cloudApi: { missing: [] } }, can: { connect: true, manage: true, contacts: true }, setup: { current: "connect" }, cloudSignup: { appId: META_ENV.META_APP_ID, configId: "2228218088074576" } });

    const s = await connect(o);
    // The code exchange, Meta's token inspector, the account's numbers, its webhooks, the number's registration.
    expect(meta.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET oauth/access_token", "GET debug_token", `GET ${s.wabaId}/phone_numbers`, `POST ${s.wabaId}/subscribed_apps`, `POST ${s.phoneNumberId}/register`]);
    expect(meta.subscribed.has(s.wabaId)).toBe(true);
    const token = meta.tokenFor(s.phoneNumberId).token;
    const row = await systemDb.wappConnection.findUniqueOrThrow({ where: { storeId: o.store.id } });
    expect(row).toMatchObject({ provider: "cloud_api", status: "connected", wabaId: s.wabaId, phoneNumberId: s.phoneNumberId, instanceName: null, webhookKeyEnc: null, shard: "meta" });
    expect(row.instanceTokenEnc).toBeTruthy();
    expect(row.instanceTokenEnc).not.toContain(token);
    expect(row.tokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 59 * 86_400_000);
    const after = ok(await o.call("GET"));
    expect(after.connection).toMatchObject({ provider: "cloud_api", status: "connected", statusLabel: "Connected", profileName: "Green Leaf", phone: expect.stringMatching(/099$/) });
    expect(after.setup.current).toBe("configure");
    expect(await systemDb.auditLog.count({ where: { workspaceId: o.ws, action: "whatsapp.connected" } })).toBe(1);

    // No answer carries the token, the app secret or the full number.
    for (const res of [await o.call("GET"), await o.call("POST", "/connection/check")]) {
      for (const secret of [token, META_APP_SECRET, "61400000099"]) expect(res.body, secret).not.toContain(secret);
    }
    // Check again asks Meta about the number itself.
    expect(meta.calls.at(-1)).toMatchObject({ method: "GET", path: s.phoneNumberId });
    // A second sign-up while connected is refused.
    const again = meta.signup();
    expect(ok(await o.call("POST", "/connection/cloud", { code: again.code, wabaId: again.wabaId, phoneNumberId: again.phoneNumberId }), 409).error).toBe("already_connected");
  });

  it("refuses a sign-up for another app, without both permissions, or for a number outside the account, and changes nothing", async () => {
    const o = await owner();
    const attempt = async (opts: Parameters<CloudFake["signup"]>[0]) => {
      const s = meta.signup(opts);
      return ok(await o.call("POST", "/connection/cloud", { code: s.code, wabaId: s.wabaId, phoneNumberId: s.phoneNumberId }), 400).error;
    };
    expect(await attempt({ appId: "1111111111" })).toBe("wrong_app");
    expect(await attempt({ scopes: ["whatsapp_business_management"] })).toBe("missing_permissions");
    expect(await attempt({ inAccount: false })).toBe("phone_not_in_account");
    // An expired (or reused) code: Meta refuses it.
    const used = meta.signup();
    expect(ok(await o.call("POST", "/connection/cloud", { code: "AQ-not-a-code-0000000000000", wabaId: used.wabaId, phoneNumberId: used.phoneNumberId }), 502).error).toBe("meta_refused");
    // Nothing was subscribed, registered or kept.
    expect(meta.calls.filter((c) => c.method !== "GET")).toEqual([]);
    expect(ok(await o.call("GET")).connection).toBeNull();
  });

  it("says plainly when bizinsights' Meta app isn't set up, and offers nothing", async () => {
    const o = await owner();
    ctx.setEnv({ WHATSAPP_CONFIG_ID: "", WHATSAPP_WEBHOOK_VERIFY_TOKEN: "" });
    const ov = ok(await o.call("GET"));
    expect(ov).toMatchObject({ platform: { cloudApi: { missing: ["WHATSAPP_CONFIG_ID", "WHATSAPP_WEBHOOK_VERIFY_TOKEN"] } }, cloudSignup: null });
    const s = meta.signup();
    expect(ok(await o.call("POST", "/connection/cloud", { code: s.code, wabaId: s.wabaId, phoneNumberId: s.phoneNumberId }), 503).error).toBe("cloud_api_off");
    expect(meta.calls).toEqual([]);
  });

  it("answers a page from before QR linking was retired in words it shows", async () => {
    const o = await owner();
    for (const [method, path] of [["POST", "/connection"], ["GET", "/connection/pairing"], ["POST", "/connection/reconnect"]] as const) {
      expect(ok(await o.call(method, path, method === "POST" ? { method: "qr" } : undefined), 410), `${method} ${path}`).toMatchObject({ error: "qr_linking_retired", message: expect.stringMatching(/no longer links a WhatsApp phone/) });
    }
  });

  it("asks for a reconnect when Meta ends bizinsights' access, holds messages meanwhile, and sends them once connected again", async () => {
    const o = await owner();
    const s = await connect(o);
    await configure(o);
    await customerWrites(o, s, CUSTOMER, "Is my order ready?");
    const m = ok(await o.call("POST", "/messages", { phone: CUSTOMER, reason: "reply", text: "Yes, it is.", idempotencyKey: "reauth-0001" }), 201).message;
    meta.tokens.forEach((t) => (t.valid = false));
    expect(await drain()).toEqual(["held"]);
    expect(await systemDb.wappMessage.findUniqueOrThrow({ where: { id: m.id } })).toMatchObject({ status: "queued", reason: "not_connected" });
    const ov = ok(await o.call("GET"));
    expect(ov.connection).toMatchObject({ status: "logged_out", statusLabel: "Needs reconnecting", reasonCode: "token_expired", reason: expect.stringMatching(/Connect WhatsApp again/) });
    expect(await systemDb.alert.count({ where: { storeId: o.store.id, code: "whatsapp_reconnect", resolvedAt: null } })).toBe(1);
    expect(meta.sends).toHaveLength(0);
    expect(ok(await o.call("POST", "/messages", { phone: CUSTOMER, reason: "reply", text: "Hi", idempotencyKey: "reauth-0002" }), 409).error).toBe("not_connected");

    // The merchant goes through Meta's window again, for the same account and number.
    await connect(o, { wabaId: s.wabaId, phoneNumberId: s.phoneNumberId, registered: true });
    expect(await systemDb.alert.count({ where: { storeId: o.store.id, code: "whatsapp_reconnect", resolvedAt: null } })).toBe(0);
    await systemDb.wappMessage.update({ where: { id: m.id }, data: { sendAfter: new Date() } });
    await releasePace();
    expect(await sendQueuedMessage(ctx.deps, m.id)).toBe("accepted");
    expect(meta.sends.map((x) => x.text)).toEqual(["Yes, it is."]);
  });
});

describe("Meta's webhook", () => {
  it("checks Meta's signature before reading anything, and its verify token", async () => {
    const body = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "waba-unknown", changes: [] }] });
    const sig = (b: string, key = META_APP_SECRET) => `sha256=${createHmac("sha256", key).update(b).digest("hex")}`;
    const post = (headers: Record<string, string>) => ctx.app.inject({ method: "POST", url: "/webhooks/whatsapp", headers: { "content-type": "application/json", ...headers }, payload: body });
    expect((await post({})).statusCode).toBe(401);
    expect(ok(await post({ "x-hub-signature-256": sig(body, "wrong") }), 401)).toEqual({ error: "invalid_signature" });
    expect(ok(await post({ "x-hub-signature-256": sig(body) }))).toMatchObject({ ok: true });
    const verify = (token: string) => ctx.app.inject({ method: "GET", url: `/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=12345` });
    expect((await verify("wrong")).statusCode).toBe(403);
    const v = await verify("verify-me");
    expect([v.statusCode, v.body]).toEqual([200, "12345"]);
  });

  it("moves a message forward on Meta's reports only, records each once, and says why one failed", async () => {
    const o = await owner();
    const s = await connect(o);
    await configure(o);
    await customerWrites(o, s, CUSTOMER, "Hello?");
    const m = ok(await o.call("POST", "/messages", { phone: CUSTOMER, reason: "reply", text: "Hi Pat!", idempotencyKey: "status-0001" }), 201).message;
    expect(await drain()).toEqual(["accepted"]);
    const sent = meta.sends.at(-1)!;
    expect(sent).toMatchObject({ to: "61412345678", type: "text", text: "Hi Pat!", reference: m.id });
    // Meta took it: accepted, nothing more, until its reports say so.
    expect(ok(await o.call("GET", `/messages/${m.id}`)).message).toMatchObject({ status: "accepted", providerMessageId: sent.id });
    // Meta's reports carry whole seconds: each a few seconds on, as they come.
    for (const [i, st] of ["sent", "delivered", "read"].entries()) {
      const w = meta.status(sent, st, { at: new Date(Date.now() + 2000 * (i + 1)) });
      ok(await deliver(w));
      // Meta delivers again what it didn't get a 200 for: the same report changes nothing.
      ok(await deliver(w));
    }
    ok(await deliver(meta.status(sent, "delivered")));
    const detail = ok(await o.call("GET", `/messages/${m.id}`));
    expect(detail.message.status).toBe("read");
    expect(detail.events.map((e: { status: string }) => e.status)).toEqual(["accepted", "sent", "delivered", "read"]);

    // Failed, with Meta's code: said in plain words.
    const m2 = ok(await o.call("POST", "/messages", { phone: CUSTOMER, reason: "reply", text: "One more thing", idempotencyKey: "status-0002" }), 201).message;
    await drain();
    ok(await deliver(meta.status(meta.sends.at(-1)!, "failed", { error: { code: 131026, title: "Message undeliverable" } })));
    expect(ok(await o.call("GET", `/messages/${m2.id}`)).message).toMatchObject({ status: "failed", reason: "undeliverable", errorCode: "meta_131026", errorDetail: expect.stringMatching(/couldn't deliver it to this number/) });
  });

  it("settles a send marked uncertain once Meta reports it went", async () => {
    const o = await owner();
    const s = await connect(o);
    await configure(o);
    await customerWrites(o, s, CUSTOMER, "Hello?");
    meta.sendFails.push("reset");
    const m = ok(await o.call("POST", "/messages", { phone: CUSTOMER, reason: "reply", text: "Hi", idempotencyKey: "settle-0001" }), 201).message;
    expect(await drain()).toEqual(["failed"]);
    expect(ok(await o.call("GET", `/messages/${m.id}`)).message).toMatchObject({ status: "failed", errorCode: "uncertain" });
    // Meta had it after all: its report carries bizinsights' reference.
    ok(await deliver(meta.status({ id: "wamid.LOST0001", phoneNumberId: s.phoneNumberId, to: "61412345678", reference: m.id }, "delivered")));
    expect(ok(await o.call("GET", `/messages/${m.id}`)).message).toMatchObject({ status: "delivered", providerMessageId: "wamid.LOST0001", errorCode: null, canRetry: false });
  });
});

describe("the test number and the test message (Step 4)", () => {
  it("verifies the number with a code from the connected number, and is done only when Meta reports the test sent", async () => {
    const o = await owner();
    const s = await connect(o);
    await configure(o);
    expect(ok(await o.call("GET")).setup.current).toBe("test");
    expect(ok(await o.call("POST", "/test-message", {}), 409).error).toBe("no_test_number");

    const sent = ok(await o.call("POST", "/test-number", { phone: TEST_PHONE }));
    expect(sent.phone).toMatch(/222$/);
    expect(sent.phone).not.toContain("400111");
    expect(await drain()).toEqual(["accepted"]);
    const codeMsg = meta.sends.at(-1)!;
    expect(codeMsg).toMatchObject({ phoneNumberId: s.phoneNumberId, to: "61400111222", type: "text" });
    const code = /is (\d{6})\./.exec(codeMsg.text ?? "")![1]!;
    expect(ok(await o.call("POST", "/test-number/verify", { code: code === "000000" ? "111111" : "000000" }), 400).error).toBe("wrong_code");
    // The code is on the phone it went to, not in bizinsights' history.
    const [codeRow] = ok(await o.call("GET", "/messages?source=verification")).messages;
    expect(codeRow.preview).toMatch(/code isn't kept here/);
    expect(JSON.stringify(ok(await o.call("GET")))).not.toContain(code);
    ok(await o.call("POST", "/test-number/verify", { code }));

    const { messageId } = ok(await o.call("POST", "/test-message", {}), 201);
    expect(await drain()).toEqual(["accepted"]);
    expect(ok(await o.call("GET", `/messages/${messageId}`)).message).toMatchObject({ status: "accepted", providerMessageId: meta.sends.at(-1)!.id });
    expect(ok(await o.call("GET")).setup.current).toBe("test");
    ok(await deliver(meta.status(meta.sends.at(-1)!, "sent")));
    expect(ok(await o.call("GET", `/messages/${messageId}`)).message.status).toBe("sent");
    expect(ok(await o.call("GET")).setup.current).toBeNull();

    // A test with an approved template goes as the template, with sample values.
    const t = await approvedTemplate(o, { name: "Order thanks", category: "transactional", body: "Hi {{customer_first_name}}, thanks for shopping at {{store_name}}." });
    ok(await o.call("POST", "/test-message", { templateId: t.id }), 201);
    await drain();
    expect(meta.sends.at(-1)).toMatchObject({ type: "template", to: "61400111222", template: { name: t.meta.name, language: "en", params: ["Sam", "Green Leaf"] } });
  });

  it("says why a code didn't arrive when Meta's 24-hour window refused it", async () => {
    const o = await owner();
    await connect(o);
    await configure(o);
    ok(await o.call("POST", "/test-number", { phone: TEST_PHONE }));
    await drain();
    ok(await deliver(meta.status(meta.sends.at(-1)!, "failed", { error: { code: 131047, title: "Re-engagement message" } })));
    const [codeRow] = ok(await o.call("GET", "/messages?source=verification")).messages;
    expect(codeRow).toMatchObject({ status: "failed", reason: "outside_window", errorDetail: expect.stringMatching(/send any WhatsApp message to your business number first/) });
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
  it("sends once per key, only with consent, free text only inside the 24-hour window, a template otherwise", async () => {
    const o = await owner();
    const s = await connect(o);
    await configure(o, { orderUpdates: "opt_in_only" });
    const t = await approvedTemplate(o, { name: "Order update", category: "transactional", body: "Your order from {{store_name}} is on its way." });
    const msg = (extra: Record<string, unknown> = {}) => ({ phone: CUSTOMER, reason: "order_update", text: "Your order is on its way.", idempotencyKey: "send-00000001", ...extra });

    expect(ok(await o.call("POST", "/messages", msg()), 409)).toMatchObject({ error: "not_allowed", detail: { reason: "no_consent" } });
    // The merchant's word is recorded as consent, but Meta delivers free text only to someone who wrote in the last 24 hours.
    expect(ok(await o.call("POST", "/messages", msg({ customerAsked: true })), 409)).toMatchObject({ error: "outside_window", message: expect.stringMatching(/approved template/) });
    const consent = await systemDb.wappConsentEvent.findFirstOrThrow({ where: { storeId: o.store.id } });
    expect(consent).toMatchObject({ scope: "order_updates", status: "opted_in", source: "merchant", actorUserId: o.user.id });
    // A template Meta approved goes, once per key.
    const first = ok(await o.call("POST", "/messages", msg({ templateId: t.id, text: "" })), 201).message;
    const again = ok(await o.call("POST", "/messages", msg({ templateId: t.id, text: "" })), 201).message;
    expect(again.id).toBe(first.id);
    expect(await drain()).toEqual(["accepted"]);
    expect(meta.sends).toEqual([expect.objectContaining({ to: "61412345678", type: "template", template: { name: t.meta.name, language: "en", params: ["Green Leaf"] }, reference: first.id })]);
    // The customer writes back: free text may answer them now.
    ok(await deliver(meta.inbound(s.phoneNumberId, CUSTOMER, "Great, thanks!")));
    ok(await o.call("POST", "/messages", msg({ idempotencyKey: "send-00000002", text: "You're welcome." })), 201);
    expect(await drain()).toEqual(["accepted"]);
    expect(meta.sends.at(-1)).toMatchObject({ type: "text", text: "You're welcome." });
    // Marketing needs the customer's own yes to marketing.
    expect(ok(await o.call("POST", "/messages", msg({ reason: "marketing", text: "Sale!", idempotencyKey: "send-00000003" })), 409).detail.reason).toBe("no_marketing_consent");
  });

  it("skips free text queued for a customer whose 24 hours ran out before it went", async () => {
    const o = await owner();
    const s = await connect(o);
    await configure(o);
    await customerWrites(o, s, CUSTOMER, "Hello?");
    const m = ok(await o.call("POST", "/messages", { phone: CUSTOMER, reason: "reply", text: "Hi", idempotencyKey: "window-0001" }), 201).message;
    await systemDb.wappContact.updateMany({ where: { storeId: o.store.id }, data: { lastInboundAt: new Date(Date.now() - 25 * 3600_000) } });
    expect(await drain()).toEqual(["skipped"]);
    expect(await systemDb.wappMessage.findUniqueOrThrow({ where: { id: m.id } })).toMatchObject({ status: "skipped", reason: "outside_window" });
    expect(meta.sends).toHaveLength(0);
  });

  it("uploads a real image to Meta and sends it by id, refuses a file that isn't what it claims, and never retries a send that may have gone", async () => {
    const o = await owner();
    const s = await connect(o);
    await configure(o);
    await customerWrites(o, s, CUSTOMER, "Can I have my receipt?");
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const base = { phone: CUSTOMER, reason: "reply" };
    expect(ok(await o.call("POST", "/messages", { ...base, idempotencyKey: "att-00000001", attachment: { name: "x.png", mime: "image/png", data: Buffer.from("not a png").toString("base64") } }), 400).error).toBe("attachment_invalid");
    const m = ok(await o.call("POST", "/messages", { ...base, idempotencyKey: "att-00000002", text: "Your receipt", attachment: { name: "receipt.png", mime: "image/png", data: png } }), 201).message;
    expect(await ctx.deps.payloads.get(`wapp-media/${m.id}`)).toBe(png);
    expect(await drain()).toEqual(["accepted"]);
    expect(meta.uploads).toEqual([expect.objectContaining({ phoneNumberId: s.phoneNumberId, type: "image/png", name: "receipt.png", size: Buffer.from(png, "base64").length })]);
    expect(meta.sends.at(-1)).toMatchObject({ type: "image", mediaId: meta.uploads[0]!.id, caption: "Your receipt" });
    expect(await ctx.deps.payloads.get(`wapp-media/${m.id}`)).toBeNull();

    meta.sendFails.push("timeout");
    const t = ok(await o.call("POST", "/messages", { ...base, idempotencyKey: "att-00000003", text: "Hello" }), 201).message;
    expect(await drain()).toEqual(["failed"]);
    const failed = ok(await o.call("GET", `/messages/${t.id}`)).message;
    expect(failed).toMatchObject({ status: "failed", errorCode: "uncertain", canRetry: true });
    expect(failed.errorDetail).toMatch(/may have reached the customer/);
    // The merchant may send it again, deliberately.
    expect(ok(await o.call("POST", `/messages/${t.id}/retry`)).message.status).toBe("queued");
    expect(await drain()).toEqual(["accepted"]);
  });

  it("retries a send that never reached Meta, and never one that may have", async () => {
    const o = await owner();
    const s = await connect(o);
    await configure(o);
    await customerWrites(o, s, CUSTOMER, "Hello?");
    meta.sendFails.push("refused");
    ok(await o.call("POST", "/messages", { phone: CUSTOMER, reason: "reply", text: "Hi", idempotencyKey: "retry-0000001" }), 201);
    expect(await drain()).toEqual(["retry"]);
    const m = await systemDb.wappMessage.findFirstOrThrow({ where: { storeId: o.store.id, direction: "out" } });
    expect(m).toMatchObject({ status: "queued", attempts: 1, errorCode: "unreachable" });
    expect(m.sendAfter.getTime()).toBeGreaterThan(Date.now() + 20_000);
    expect(meta.sends).toHaveLength(0);
    // The connection dropped after the request went out, or Meta failed on it: it may be on the
    // customer's phone, so it is never sent again by itself.
    for (const [fail, key] of [["reset", "retry-0000002"], [500, "retry-0000003"]] as const) {
      meta.sendFails.push(fail);
      const sent = ok(await o.call("POST", "/messages", { phone: CUSTOMER, reason: "reply", text: "Hi", idempotencyKey: key }), 201).message;
      expect(await drain()).toEqual(["failed"]);
      expect(ok(await o.call("GET", `/messages/${sent.id}`)).message).toMatchObject({ status: "failed", errorCode: "uncertain" });
    }
  });

  it("waits out Meta's rate limit, holds the number's other messages meanwhile, and sends each once", async () => {
    const o = await owner();
    const s = await connect(o);
    await configure(o);
    await customerWrites(o, s, CUSTOMER, "Hello?");
    meta.sendFails.push({ code: 130429, message: "(#130429) Rate limit hit" });
    const m = ok(await o.call("POST", "/messages", { phone: CUSTOMER, reason: "reply", text: "First", idempotencyKey: "rate-0000001" }), 201).message;
    expect(await drain()).toEqual(["retry"]);
    const held = await systemDb.wappMessage.findUniqueOrThrow({ where: { id: m.id } });
    expect(held).toMatchObject({ status: "queued", reason: "rate_limited", errorCode: "meta_130429", attempts: 1 });
    expect(held.sendAfter.getTime()).toBeGreaterThan(Date.now() + 55_000);
    // The number's circuit is open: another message waits too, without spending a try or reaching Meta.
    const other = ok(await o.call("POST", "/messages", { phone: CUSTOMER, reason: "reply", text: "Second", idempotencyKey: "rate-0000002" }), 201).message;
    expect(await drain()).toEqual(["held"]);
    expect(await systemDb.wappMessage.findUniqueOrThrow({ where: { id: other.id } })).toMatchObject({ status: "queued", reason: "provider_unavailable", attempts: 0 });
    // A minute later: each goes once, a duplicate delivery of the job finds it taken.
    await ctx.deps.coord.take(`wapp:circuit:${s.phoneNumberId}`);
    await systemDb.wappMessage.updateMany({ where: { storeId: o.store.id }, data: { sendAfter: new Date() } });
    await releasePace();
    expect(await sendQueuedMessage(ctx.deps, m.id)).toBe("accepted");
    expect(await sendQueuedMessage(ctx.deps, m.id)).toBe("not_due");
    await releasePace();
    expect(await sendQueuedMessage(ctx.deps, other.id)).toBe("accepted");
    expect(meta.sends.map((x) => [x.reference, x.text])).toEqual([
      [m.id, "First"],
      [other.id, "Second"],
    ]);
  });
});

describe("customers' replies", () => {
  it("honours STOP and START from anyone, and keeps only the store's customers' messages", async () => {
    const o = await owner();
    const s = await connect(o);
    await configure(o);
    // Someone who isn't a customer: their message is dropped unread; their STOP is kept by hash only.
    ok(await deliver(meta.inbound(s.phoneNumberId, "+61411000000", "hello, is this Sam?")));
    ok(await deliver(meta.inbound(s.phoneNumberId, "+61411000000", "STOP")));
    expect(await systemDb.wappContact.count({ where: { storeId: o.store.id } })).toBe(0);
    expect(await systemDb.wappMessage.count({ where: { storeId: o.store.id } })).toBe(0);
    expect(await systemDb.wappSuppression.findFirstOrThrow({ where: { storeId: o.store.id } })).toMatchObject({ scope: "all", reason: "stop_reply" });

    // A customer bizinsights messaged (an approved template), who writes back, then says STOP.
    const t = await approvedTemplate(o, { name: "Shipped", category: "transactional", body: "Your order from {{store_name}} shipped." });
    ok(await o.call("POST", "/messages", { phone: CUSTOMER, reason: "order_update", templateId: t.id, idempotencyKey: "reply-0000001" }), 201);
    await drain();
    ok(await deliver(meta.inbound(s.phoneNumberId, CUSTOMER, "Thanks! When will it arrive?")));
    ok(await deliver(meta.inbound(s.phoneNumberId, CUSTOMER, "STOP")));
    expect(await drain()).toEqual(["accepted"]);
    expect(meta.sends.at(-1)).toMatchObject({ type: "text", text: "You won't get WhatsApp messages from Green Leaf any more. Reply START if you change your mind." });
    const inMessages = ok(await o.call("GET", "/messages?direction=in")).messages;
    expect(inMessages.map((m: { preview: string }) => m.preview)).toEqual(["STOP", "Thanks! When will it arrive?"]);
    expect(ok(await o.call("POST", "/messages", { phone: CUSTOMER, reason: "order_update", templateId: t.id, idempotencyKey: "reply-0000002" }), 409).detail.reason).toBe("opted_out");
    expect(ok(await o.call("POST", "/messages", { phone: CUSTOMER, reason: "order_update", templateId: t.id, idempotencyKey: "reply-0000003", customerAsked: true }), 409).error).toBe("opted_out");

    ok(await deliver(meta.inbound(s.phoneNumberId, CUSTOMER, "start")));
    expect(await drain()).toEqual(["accepted"]);
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
    const s = await connect(o);
    await configure(o);
    await finishSetup(o);
    // The test number replies STOP (it isn't a customer): nothing more goes to it, not even a test.
    ok(await deliver(meta.inbound(s.phoneNumberId, TEST_PHONE, "STOP")));
    const { messageId } = ok(await o.call("POST", "/test-message", {}), 201);
    expect(await drain()).toEqual(["skipped"]);
    expect(ok(await o.call("GET", `/messages/${messageId}`)).message).toMatchObject({ status: "skipped", reason: "suppressed" });
    expect(ok(await o.call("POST", "/test-number", { phone: TEST_PHONE }), 409).error).toBe("suppressed");

    // A customer's STOP whose first try recorded the message and then failed: the retry still opts them out.
    ok(await o.call("POST", "/contacts/consent", { phone: CUSTOMER, scope: "order_updates", status: "opted_in" }));
    const contact = await systemDb.wappContact.findFirstOrThrow({ where: { storeId: o.store.id } });
    const conn = await systemDb.wappConnection.findUniqueOrThrow({ where: { storeId: o.store.id } });
    await systemDb.wappMessage.create({
      data: { workspaceId: o.ws, storeId: o.store.id, connectionId: conn.id, direction: "in", contactId: contact.id, phoneHash: contact.phoneHash, phoneMasked: contact.phoneMasked, source: "inbound", type: "text", status: "received", providerMessageId: "wamid.INSTOP0001", acceptedAt: new Date(), finalAt: new Date(), sendAfter: new Date() },
    });
    ok(await deliver(meta.inbound(s.phoneNumberId, CUSTOMER, "STOP", { id: "wamid.INSTOP0001" })));
    expect(await drain()).toEqual(["accepted"]);
    expect(await systemDb.wappContact.findUniqueOrThrow({ where: { id: contact.id } })).toMatchObject({ optedOut: true });
    // Delivered once more, it changes nothing.
    ok(await deliver(meta.inbound(s.phoneNumberId, CUSTOMER, "STOP", { id: "wamid.INSTOP0001" })));
    expect(await drain()).toEqual([]);
  });
});

describe("automations from Shopify's events", () => {
  async function ready() {
    const o = await owner();
    await connect(o);
    await configure(o);
    await finishSetup(o);
    const template = await approvedTemplate(o, { name: "Order thanks", category: "transactional", body: "Hi {{customer_first_name}}, thanks for order {{order_number}} from {{store_name}}." });
    const automation = ok(await o.call("POST", "/automations", { name: "Thank you", trigger: "order_created", templateId: template.id }), 201).automation;
    expect(automation).toMatchObject({ status: "draft", testMode: true, problems: [] });
    ok(await o.call("POST", `/automations/${automation.id}/activate`));
    const store = (await systemDb.store.findUniqueOrThrow({ where: { id: o.store.id } })) as Store;
    return { o, store, template, automation };
  }

  it("runs once per order with the template Meta approved, in test mode only to the verified number, then to the customer", async () => {
    const { o, store, template, automation } = await ready();
    meta.sends.length = 0;
    await whatsappOnShopifyEvent(store, "orders/create", ORDER(1001), ctx.deps);
    await whatsappOnShopifyEvent(store, "orders/create", ORDER(1001), ctx.deps);
    expect(await drain()).toEqual(["accepted"]);
    expect(meta.sends).toEqual([expect.objectContaining({ to: "61400111222", type: "template", template: { name: template.meta.name, language: "en", params: ["Pat", "#1001", "Green Leaf"] } })]);
    const runs = ok(await o.call("GET", `/automations/${automation.id}`)).runs;
    expect(runs).toEqual([expect.objectContaining({ subject: "Order #1001", outcome: "queued", testMode: true, messageStatus: "accepted" })]);

    // Test mode off: the customer gets it (a template starts the conversation: no 24-hour window applies).
    ok(await o.call("PUT", `/automations/${automation.id}`, { ...automationBody(automation), testMode: false }));
    await whatsappOnShopifyEvent(store, "orders/create", ORDER(1002), ctx.deps);
    expect(await drain()).toEqual(["accepted"]);
    expect(meta.sends.at(-1)).toMatchObject({ to: "61412345678", template: { params: ["Pat", "#1002", "Green Leaf"] } });

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

  it("can't be switched on before the setup is done or before Meta approved its template, and says why", async () => {
    const o = await owner();
    await connect(o);
    const template = ok(await o.call("POST", "/templates", { name: "Shipped", category: "transactional", body: "Your order {{order_number}} is on its way: {{tracking_url}}" }), 201).template;
    const a = ok(await o.call("POST", "/automations", { name: "Shipped", trigger: "order_created", templateId: template.id }), 201).automation;
    expect(a.problems).toEqual(expect.arrayContaining([expect.stringMatching(/Step 3/), expect.stringMatching(/Step 4/), expect.stringMatching(/\{\{tracking_url\}\}/), expect.stringMatching(/submitted to Meta/)]));
    const res = ok(await o.call("POST", `/automations/${a.id}/activate`), 409);
    expect(res.error).toBe("automation_blocked");
    expect(res.detail.problems.length).toBeGreaterThanOrEqual(3);
  });
});

function automationBody(a: { name: string; trigger: string; templateId: string; conditions: unknown[]; recipient: string; delayMinutes: number; sendWindow: unknown; testMode: boolean; cooldownMinutes: number | null; description: string | null }) {
  return { name: a.name, description: a.description, trigger: a.trigger, templateId: a.templateId, conditions: a.conditions, recipient: a.recipient, delayMinutes: a.delayMinutes, sendWindow: a.sendWindow, testMode: a.testMode, ...(a.cooldownMinutes != null ? { cooldownMinutes: a.cooldownMinutes } : {}) };
}

describe("campaigns", () => {
  it("launches only with the exact count the merchant confirmed, to customers who agreed to marketing, as Meta's template", async () => {
    const o = await owner();
    await connect(o);
    await configure(o);
    await finishSetup(o);
    meta.sends.length = 0;
    const marketing = await approvedTemplate(o, { name: "Spring sale", category: "marketing", body: "Hi {{customer_first_name}}, 20% off at {{store_name}} this week. Reply STOP to unsubscribe." });
    const transactional = await approvedTemplate(o, { name: "Plain", category: "transactional", body: "Hello from {{store_name}}." });
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
    expect(meta.sends.map((x) => [x.to, x.template?.name, x.template?.params]).sort()).toEqual([
      ["61412000001", marketing.meta.name, ["Sam", "Green Leaf"]],
      ["61412000002", marketing.meta.name, ["Alex", "Green Leaf"]],
    ]);
    const report = ok(await o.call("GET", `/campaigns/${c.id}`)).campaign;
    expect(report).toMatchObject({ status: "sending", recipients: 2, confirmedRecipients: 2 });
  });
});

describe("who may see and do what", () => {
  it("keeps every store's WhatsApp to its own workspace, including Meta's reports about its messages", async () => {
    const a = await owner("a", "a@shop.test");
    const sa = await connect(a);
    await configure(a);
    await customerWrites(a, sa, CUSTOMER, "Hello?");
    const m = ok(await a.call("POST", "/messages", { phone: CUSTOMER, reason: "reply", text: "Hi", idempotencyKey: "iso-00000001" }), 201).message;
    await drain();
    const sent = meta.sends.at(-1)!;
    const b = await owner("b", "b@other.test");
    const sb = await connect(b);

    // B can't reach A's store through A's workspace, nor through its own.
    expect((await a.call("GET", "", undefined, b.headers)).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: "GET", url: `/workspaces/${b.ws}/stores/${a.store.id}/whatsapp`, headers: b.headers })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: "GET", url: `/workspaces/${b.ws}/stores/${b.store.id}/whatsapp/messages/${m.id}`, headers: b.headers })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: "DELETE", url: `/workspaces/${a.ws}/stores/${a.store.id}/whatsapp/connection`, headers: b.headers })).statusCode).toBe(404);
    expect(ok(await b.call("GET", "/messages")).messages).toEqual([]);
    // A report naming A's message under B's number (even with A's reference) changes nothing of A's.
    ok(await deliver(meta.status({ ...sent, phoneNumberId: sb.phoneNumberId }, "failed", { error: { code: 131026 } })));
    ok(await deliver(meta.status({ id: "wamid.OTHER", phoneNumberId: sb.phoneNumberId, to: sent.to, reference: m.id }, "read")));
    expect(ok(await a.call("GET", `/messages/${m.id}`)).message).toMatchObject({ status: "accepted" });
    // B can't take A's number.
    const steal = meta.signup({ wabaId: sa.wabaId, phoneNumberId: sa.phoneNumberId, registered: true });
    ok(await b.call("DELETE", "/connection"));
    expect(ok(await b.call("POST", "/connection/cloud", { code: steal.code, wabaId: steal.wabaId, phoneNumberId: steal.phoneNumberId }), 409).error).toBe("number_taken");
    expect(ok(await a.call("GET")).connection.status).toBe("connected");
  });

  it("lets a viewer look, without customers' details unless granted, and change nothing", async () => {
    const o = await owner();
    const s = await connect(o);
    await configure(o);
    await customerWrites(o, s, CUSTOMER, "Hello?");
    ok(await o.call("POST", "/messages", { phone: CUSTOMER, reason: "reply", text: "Secret text", idempotencyKey: "view-00000001" }), 201);
    const v = await signIn(ctx, "v", "v@shop.test");
    await systemDb.membership.create({ data: { workspaceId: o.ws, userId: v.user.id, role: "custom", permissions: ["marketing.campaigns"] } });
    const ov = ok(await o.call("GET", "", undefined, v.headers));
    expect(ov.can).toEqual({ connect: false, manage: false, contacts: false });
    expect(ov.cloudSignup).toBeNull();
    const msgs = ok(await o.call("GET", "/messages", undefined, v.headers)).messages;
    expect(msgs.every((x: { preview: string | null; contactId: string | null }) => x.preview === null && x.contactId === null)).toBe(true);
    expect((await o.call("GET", "/contacts", undefined, v.headers)).statusCode).toBe(403);
    expect((await o.call("GET", `/messages?phone=${encodeURIComponent(CUSTOMER)}`, undefined, v.headers)).statusCode).toBe(403);
    for (const [method, path, payload] of [
      ["POST", "/connection/cloud", { code: "AQ0000000000", wabaId: "100000", phoneNumberId: "200000" }],
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
    const st = await signIn(ctx, "s", "s@shop.test");
    await systemDb.membership.create({ data: { workspaceId: o.ws, userId: st.user.id, role: "custom", permissions: ["integrations.status"] } });
    const status = ok(await o.call("GET", "", undefined, st.headers));
    expect(Object.keys(status).sort()).toEqual(["can", "connection", "platform", "store"]);
    expect(status).toMatchObject({ connection: { status: "connected" }, platform: { cloudApi: { missing: [] } } });
    for (const path of ["/messages", "/automations", "/templates", "/campaigns"]) expect((await o.call("GET", path, undefined, st.headers)).statusCode, path).toBe(403);
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
      ["POST", "/connection/cloud", { code: "AQ0000000000", wabaId: "100000", phoneNumberId: "200000" }],
      ["DELETE", "/connection", undefined],
      ["PUT", "/settings", SETTINGS],
      ["POST", "/templates", { name: "x", category: "transactional", body: "x" }],
    ] as const) {
      expect((await o.call(method, path, payload, link)).statusCode, `${method} ${path}`).toBe(403);
    }
  });
});

describe("disconnecting", () => {
  it("forgets Meta's token, lets the number go, cancels what waits, and keeps the history", async () => {
    const o = await owner();
    const s = await connect(o);
    await configure(o);
    await customerWrites(o, s, CUSTOMER, "Hello?");
    ok(await o.call("POST", "/messages", { phone: CUSTOMER, reason: "reply", text: "Sent", idempotencyKey: "disc-00000001" }), 201);
    await drain();
    ok(await o.call("POST", "/messages", { phone: CUSTOMER, reason: "reply", text: "Waiting", idempotencyKey: "disc-00000002" }), 201);
    // Another store on the same WhatsApp Business account keeps its webhooks.
    const b = await owner("b", "b@other.test");
    await connect(b, { wabaId: s.wabaId });
    const res = ok(await o.call("DELETE", "/connection"));
    expect(res.connection).toMatchObject({ status: "disconnected", reason: "Disconnected by your team." });
    expect(meta.subscribed.has(s.wabaId)).toBe(true);
    const rows = await systemDb.wappMessage.findMany({ where: { storeId: o.store.id, direction: "out" }, orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => [r.status, r.reason])).toEqual([
      ["accepted", null],
      ["cancelled", "not_connected"],
    ]);
    expect(await systemDb.wappConnection.findUniqueOrThrow({ where: { storeId: o.store.id } })).toMatchObject({ instanceTokenEnc: null, phoneNumberId: null, tokenExpiresAt: null });
    // Meta's reports about the number no longer reach the store.
    const r = ok(await deliver(meta.inbound(s.phoneNumberId, CUSTOMER, "Hello again")));
    expect(r).toMatchObject({ applied: 0, skipped: 1 });
    expect(ok(await o.call("DELETE", "/connection"), 404).error).toBe("not_connected");
    // The account's last store on bizinsights disconnecting: Meta stops sending its webhooks here.
    ok(await b.call("DELETE", "/connection"));
    expect(meta.subscribed.has(s.wabaId)).toBe(false);
    // Connecting again starts afresh.
    await connect(o, { wabaId: s.wabaId, phoneNumberId: s.phoneNumberId, registered: true });
  });
});

describe("a phone linked with a QR code (retired 2026-10-28)", () => {
  /** A connection row from before 2026-10-28 that release 1's cleanup didn't reach (its instance went with Evolution API). */
  async function qrLinked(o: Owner) {
    return systemDb.wappConnection.create({
      data: { workspaceId: o.ws, storeId: o.store.id, provider: "qr", status: "connected", shard: "a", instanceName: "bi_0123456789abcdef01234567", instanceTokenEnc: waEncrypt(o.store.id, "instance_token", "qr-instance-token"), webhookKeyEnc: waEncrypt(o.store.id, "webhook_key", "qr-webhook-key"), phoneMasked: "+61 ••• ••• 077", connectedAt: new Date() },
    });
  }
  const queueFor = (o: Owner, conn: { id: string; provider: string }, key: string) =>
    queueMessage(ctx.deps, { store: o.store, conn, source: "manual", category: "transactional", phone: normalizePhone(CUSTOMER, null)!, payload: { text: "Your order is ready." }, idempotencyKey: key });

  it("is shown retired, sends nothing, has no webhook any more, and is retired for good when the store connects Meta", async () => {
    const o = await owner();
    const qr = await qrLinked(o);
    await configure(o);
    const ov = ok(await o.call("GET"));
    expect(ov.connection).toMatchObject({ provider: "qr", status: "disconnected", statusLabel: "Retired", reasonCode: "qr_linking_retired", reason: expect.stringMatching(/no longer links a WhatsApp phone with a QR code/) });
    expect(ov.setup.current).toBe("connect");
    expect(ok(await o.call("POST", "/connection", { method: "qr" }), 410).error).toBe("qr_linking_retired");

    // A message queued for the phone: cancelled with the reason, never sent.
    const { message: queued } = await queueFor(o, qr, "qr-queued-1");
    expect(await drain()).toEqual(["cancelled"]);
    expect(await systemDb.wappMessage.findUniqueOrThrow({ where: { id: queued.id } })).toMatchObject({ status: "cancelled", reason: "qr_linking_retired", payloadEnc: null });
    expect(meta.sends).toEqual([]);
    // Evolution API's webhook went with the service.
    expect((await ctx.app.inject({ method: "POST", url: "/webhooks/whatsapp/evolution/bi_0123456789abcdef01234567", headers: { "content-type": "application/json" }, payload: "{}" })).statusCode).toBe(404);

    // Connecting Meta retires the link: waiting messages cancelled with the reason, the instance forgotten.
    const { message: waiting } = await queueFor(o, qr, "qr-queued-2");
    ctx.deps.queues.clear();
    await connect(o);
    expect(await systemDb.wappMessage.findUniqueOrThrow({ where: { id: waiting.id } })).toMatchObject({ status: "cancelled", reason: "qr_linking_retired" });
    expect(await systemDb.auditLog.count({ where: { workspaceId: o.ws, action: "whatsapp.qr_linking_retired" } })).toBe(1);
    expect(await systemDb.alert.findFirstOrThrow({ where: { storeId: o.store.id, code: "whatsapp_qr_retired" } })).toMatchObject({ resolvedAt: expect.any(Date) });
    expect(await systemDb.wappConnection.findUniqueOrThrow({ where: { storeId: o.store.id } })).toMatchObject({ provider: "cloud_api", status: "connected", instanceName: null, webhookKeyEnc: null });
  });
});

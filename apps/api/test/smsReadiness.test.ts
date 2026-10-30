import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { systemDb, type Store } from "@app/db";
import {
  accountStatusKey,
  applySmsEvent,
  fakeSmsProvider,
  sendSmsJob,
  SmsProviderError,
  smsOnShopifyEvent,
  smsRegion,
  suppressNumber,
  upsertSmsContact,
  type FakeSmsProvider,
  type SendOutcome,
  type SmsDeps,
} from "@app/core/sms";
import { LEGACY_GRANTS, normalizePhone } from "@app/shared";
import { smsDate } from "@app/shared/sms";
import { clean, createStore, createWorkspace, ORIGIN, setup, signIn, teardown, type TestCtx } from "./helpers.js";

/**
 * Production readiness of Customer Messaging on a live platform (SMS_MODE=live, marketing on, as
 * apps/aws/src/settings.ts ships), end to end through the API: who may send, tenant isolation,
 * numbers and countries, consent and opt-outs, one text, many texts, an automation, scheduling and
 * cancelling, AWS's refusals, retries, duplicates, rate limits and delivery reports.
 *
 * Only AWS is faked, at the provider interface (core's fakeSmsProvider, answering as AWS End User
 * Messaging does, refusals included); the queue is drained here as the jobs function does
 * (sendSmsJob per {kind:"sms"} message), and delivery events go through applySmsEvent as the
 * smsEvents queue's consumer does. The AWS adapter itself is apps/aws/test/smsProvider.test.ts's.
 */

let ctx: TestCtx;
let sms: FakeSmsProvider;
let deps: SmsDeps;

const LIVE = { SMS_MODE: "live", SMS_MARKETING_ENABLED: "1", SMS_SHARED_SENDER: "", SMS_PARTS_PER_SECOND: "1000", SMS_PRICE_TABLE: JSON.stringify({ AU: 0.05 }), SMS_ACCOUNT_MONTHLY_LIMIT_USD: "20" };

beforeAll(async () => {
  ctx = await setup();
  sms = fakeSmsProvider();
  (ctx.deps as { sms?: FakeSmsProvider }).sms = sms;
  deps = { coord: ctx.deps.coord, queues: ctx.deps.queues, fetchImpl: ctx.deps.fetchImpl, mailer: ctx.deps.mailer, sms };
});
afterAll(async () => {
  ctx.setEnv({ SMS_MODE: "off", SMS_MARKETING_ENABLED: "", SMS_PARTS_PER_SECOND: "1", SMS_PRICE_TABLE: "{}" });
  await teardown(ctx);
});
beforeEach(async () => {
  await clean(ctx);
  sms.clear();
  sms.identities.clear();
  sms.accountInfo = { tier: "PRODUCTION", sandbox: false, spendLimitUsd: 100, spendLimitMaxUsd: 100 };
  ctx.setEnv(LIVE);
});
afterEach(() => vi.useRealTimers());

type Owner = Awaited<ReturnType<typeof owner>>;

async function owner(uid = "u1", email = "o@shop.test") {
  const s = await signIn(ctx, uid, email);
  const ws = await createWorkspace(ctx, s.headers);
  const store = await createStore(ws, `${uid}.myshopify.com`, ["read_orders"], { name: "Green Leaf", currency: "AUD", timezone: "Australia/Melbourne" });
  const base = `/workspaces/${ws}/stores/${store.id}/sms`;
  const call = (method: "GET" | "POST" | "PUT", path: string, payload?: unknown, headers: Record<string, string> = s.headers) => ctx.app.inject({ method, url: `${base}${path}`, headers, ...(payload === undefined ? {} : { payload }) });
  return { ...s, ws, store: store as Store, base, call };
}

/** What Set up SMS leaves behind: a sender AWS has, tagged for the workspace and verified, a limit, a basis for order updates, sending (and marketing) on. */
async function ready(o: Owner, extra: Record<string, unknown> = {}) {
  const id = `GL${o.ws.slice(-6).toUpperCase()}`;
  sms.identities.set(id, { kind: "sender_id", arn: `arn:aws:sms-voice:ap-southeast-2:1:sender-id/${id}/AU`, id, label: id, country: "AU", status: "REGISTERED", twoWay: false, optOutList: "Default", registrationStatus: "COMPLETE", tags: { "bizinsights:workspace": o.ws } });
  const put = await o.call("PUT", "/sender", { senderType: "sender_id", originationIdentity: id, countries: ["AU"], monthlyBudgetUsd: 25, hardStop: true, transactionalBasis: "checkout_notice", quietStart: 0, quietEnd: 0, maxPerCustomerDay: 5, maxMarketingPerWeek: 3, ...extra });
  expect(put.statusCode).toBe(200);
  expect((await o.call("POST", "/sender/verify")).json().sender.identityCheck).toBe("verified");
  expect((await o.call("POST", "/sender/sending", { sending: true, marketing: true })).json().sender).toMatchObject({ sendingEnabled: true, marketingEnabled: true });
  return id;
}

const SUBSCRIBED = { state: "subscribed" as const, source: "shopify_customer" as const, evidence: { test: true } };

async function customer(o: Owner, phone: string, firstName: string | null, opts: { subscribed?: boolean; country?: string } = {}) {
  const p = normalizePhone(phone, opts.country ?? "AU");
  if (!p) throw new Error(`unreadable test number ${phone}`);
  return upsertSmsContact(o.store, { phone: p, firstName, consent: opts.subscribed ? SUBSCRIBED : null });
}

/** A saved, approved message (submit + approve, as the template pages do). */
async function approved(o: Owner, name: string, category: "transactional" | "marketing", body: string) {
  const t = await o.call("POST", "/templates", { name, category, body });
  expect(t.statusCode).toBe(201);
  const id = t.json().template.id as string;
  await o.call("POST", `/templates/${id}/submit`, {});
  expect((await o.call("POST", `/templates/${id}/approve`, {})).json().template.status).toBe("approved");
  return id;
}

let seq = 0;
const rid = () => `test-req-${Date.now().toString(36)}-${++seq}`;

/** The jobs function: hand each queued SMS job to the send path, once (a job that waits re-queues itself). */
async function drain(): Promise<SendOutcome[]> {
  const batch = ctx.deps.queues.sent.sync.splice(0);
  ctx.deps.queues.sentOpts.sync.splice(0);
  const out: SendOutcome[] = [];
  for (const m of batch as unknown as Array<{ kind: string; jobId: string }>) if (m.kind === "sms") out.push(await sendSmsJob(m.jobId, deps));
  return out;
}

/** AWS's delivery event for a text it accepted, as the configuration set publishes it. */
function event(messageId: string, jobId: string, ws: string, status: string, final = true, price = 0.0581) {
  return {
    eventType: status === "DELIVERED" ? "TEXT_DELIVERED" : status === "SUCCESSFUL" ? "TEXT_SUCCESSFUL" : `TEXT_${status}`,
    eventVersion: "1.0",
    eventTimestamp: Date.now(),
    isFinal: final,
    messageId,
    messageRequestTimestamp: Date.now() - 2000,
    messageType: "TRANSACTIONAL",
    messageStatus: status,
    isoCountryCode: "AU",
    context: { job: jobId, ws },
    totalMessageParts: 1,
    totalMessagePrice: price,
    totalCarrierFee: 0,
  };
}

const jobsOf = (storeId: string) => systemDb.smsMessageJob.findMany({ where: { storeId }, orderBy: { sendAfter: "asc" } });

describe("who may send", () => {
  it("refuses every Send SMS request without a session", async () => {
    const o = await owner();
    const none = { ...ORIGIN };
    for (const [method, path, payload] of [
      ["GET", "/sends", undefined],
      ["GET", "/sends/customers", undefined],
      ["POST", "/sends/preview", { contactIds: [], templateId: "x" }],
      ["POST", "/sends", { requestId: rid(), contactIds: ["x"], templateId: "x" }],
      ["GET", "/sends/abcdefgh1", undefined],
      ["POST", "/sends/abcdefgh1/cancel", {}],
      ["POST", "/send", { templateId: "x", contactId: "y" }],
    ] as const) {
      expect((await o.call(method, path, payload, none)).statusCode, `${method} ${path}`).toBe(401);
    }
    expect(sms.sent).toHaveLength(0);
  });

  it("lets only owners and admins who may see contact details send; a viewer reads the sends without numbers", async () => {
    const o = await owner();
    await ready(o);
    const c = await customer(o, "0412 345 678", "Sam");
    const t = await approved(o, "Pickup", "transactional", "Hi {{customer_name}}, your order is ready to collect.");
    const v = await signIn(ctx, "v", "v@shop.test");
    await systemDb.membership.create({ data: { workspaceId: o.ws, userId: v.user.id, role: "viewer", permissions: [...LEGACY_GRANTS.viewer, "marketing.campaigns"] } });
    expect((await o.call("POST", "/sends", { requestId: rid(), contactIds: [c.id], templateId: t }, v.headers)).statusCode).toBe(403);
    expect((await o.call("POST", "/sends/preview", { contactIds: [c.id], templateId: t }, v.headers)).statusCode).toBe(403);
    expect((await o.call("GET", "/sends/customers", undefined, v.headers)).statusCode).toBe(403);
    expect((await o.call("GET", "/sends", undefined, v.headers)).statusCode).toBe(200);
    // A member granted contact details and campaigns, but not owner or admin, still can't send.
    const m = await signIn(ctx, "m", "m@shop.test");
    await systemDb.membership.create({ data: { workspaceId: o.ws, userId: m.user.id, role: "custom", permissions: ["marketing.campaigns", "customers.list", "customers.contact"] } });
    expect((await o.call("GET", `/sends/${"x".repeat(10)}`, undefined, m.headers)).statusCode).toBe(404);
    expect((await o.call("POST", "/sends", { requestId: rid(), contactIds: [c.id], templateId: t }, m.headers)).statusCode).toBe(403);
    expect((await o.call("POST", "/send", { templateId: t, contactId: c.id }, m.headers)).statusCode).toBe(403);
    expect(sms.sent).toHaveLength(0);
  });

  it("keeps each business's customers, messages and sends to itself", async () => {
    const a = await owner("ua", "a@shop.test");
    const b = await owner("ub", "b@other.test");
    await ready(a);
    await ready(b);
    const ac = await customer(a, "0412 345 678", "Sam");
    const at = await approved(a, "Pickup", "transactional", "Hi {{customer_name}}, your order is ready.");
    const bt = await approved(b, "Hello", "transactional", "Hi {{customer_name}}, hello from us.");
    const sent = await a.call("POST", "/sends", { requestId: rid(), contactIds: [ac.id], templateId: at });
    expect(sent.statusCode).toBe(201);
    const sendId = sent.json().send.id as string;

    // B, signed in, with A's ids in A's paths: nothing.
    for (const [method, path, payload] of [
      ["GET", "/sends", undefined],
      ["GET", `/sends/${sendId}`, undefined],
      ["POST", `/sends/${sendId}/cancel`, {}],
      ["GET", "/sends/customers", undefined],
      ["POST", "/sends", { requestId: rid(), contactIds: [ac.id], templateId: at }],
    ] as const) {
      expect((await a.call(method, path, payload, b.headers)).statusCode, `${method} ${path}`).toBe(404);
    }
    // B, in its own store, naming A's customer, A's message or A's send: not found.
    expect((await b.call("POST", "/sends", { requestId: rid(), contactIds: [ac.id], templateId: bt })).json()).toMatchObject({ error: "not_found" });
    expect((await b.call("POST", "/sends", { requestId: rid(), contactIds: [ac.id], templateId: at })).statusCode).toBe(409);
    expect((await b.call("GET", `/sends/${sendId}`)).statusCode).toBe(404);
    expect((await b.call("POST", `/sends/${sendId}/cancel`, {})).statusCode).toBe(404);
    expect((await b.call("GET", "/sends/customers")).json().customers).toEqual([]);
    expect((await b.call("GET", "/messages")).json().messages).toEqual([]);
    // A's own send is untouched and goes out from A's sender.
    await drain();
    expect(sms.sent).toHaveLength(1);
    expect(sms.sent[0]!.context).toEqual({ job: expect.any(String), ws: a.ws });
  });
});

describe("numbers, countries and consent", () => {
  it("texts E.164 numbers only in the sender's countries, and says why the others won't get it", async () => {
    expect(normalizePhone("0412 345 678", "AU")?.e164).toBe("+61412345678");
    expect(normalizePhone("+64 21 123 4567")).toMatchObject({ e164: "+64211234567", country: "NZ" });
    expect(normalizePhone("12345")).toBeNull();
    expect(normalizePhone("0412 345 678")).toBeNull();
    const o = await owner();
    await ready(o);
    const au = await customer(o, "0412 345 678", "Sam");
    const nz = await customer(o, "+64 21 123 4567", "Aroha");
    const unknown = await customer(o, "+999 123 456 789", "Zed");
    const t = await approved(o, "Pickup", "transactional", "Hi {{customer_name}}, your order is ready.");
    const preview = (await o.call("POST", "/sends/preview", { contactIds: [au.id, nz.id, unknown.id], templateId: t })).json();
    expect(preview.recipients).toMatchObject({ chosen: 3, sending: 1 });
    expect(preview.recipients.notSending).toEqual(
      expect.arrayContaining([
        { reason: "country_not_enabled", label: "Sending to this country isn't switched on", count: 1 },
        { reason: "country_unknown", label: "The number's country couldn't be told, so it isn't texted", count: 1 },
      ]),
    );
    const sent = (await o.call("POST", "/sends", { requestId: rid(), contactIds: [au.id, nz.id, unknown.id], templateId: t })).json().send;
    expect(sent.counts).toMatchObject({ queued: 1, not_sent: 2 });
    await drain();
    expect(sms.sent.map((m) => m.destination)).toEqual(["+61412345678"]);
  });

  it("sends marketing only with Shopify's SMS marketing consent, never to an opted-out number, and stops a text whose customer opts out before it goes", async () => {
    const o = await owner();
    await ready(o);
    const yes = await customer(o, "0412 000 001", "Ana", { subscribed: true });
    const no = await customer(o, "0412 000 002", "Ben");
    const out = await customer(o, "0412 000 003", "Cal", { subscribed: true });
    const later = await customer(o, "0412 000 004", "Dee", { subscribed: true });
    await suppressNumber(o.store, "+61412000003", "all", "opt_out_link");
    const promo = await approved(o, "Sale", "marketing", "{{business_name}}: 20% off today, {{customer_name}}. Opt out: {{opt_out_url}}");
    const sent = (await o.call("POST", "/sends", { requestId: rid(), contactIds: [yes.id, no.id, out.id, later.id], templateId: promo })).json().send;
    expect(sent.counts).toMatchObject({ queued: 2, not_sent: 2 });
    expect(sent.messages.filter((m: { stage: string }) => m.stage === "not_sent").map((m: { reasonLabel: string }) => m.reasonLabel).sort()).toEqual(["The customer hasn't agreed to marketing texts", "The customer opted out"]);
    // Dee opts out after it was scheduled: her text never goes.
    await suppressNumber(o.store, "+61412000004", "all", "opt_out_link");
    await drain();
    expect(sms.sent.map((m) => m.destination)).toEqual(["+61412000001"]);
    expect(sms.sent[0]).toMatchObject({ messageType: "PROMOTIONAL", body: expect.stringMatching(/^Green Leaf: 20% off today, Ana\. Opt out: http.+\/stop\?c=\w{10}$/) });
    // With the platform's marketing switch off, a marketing send is refused before anything is recorded.
    ctx.setEnv({ SMS_MARKETING_ENABLED: "" });
    const refused = await o.call("POST", "/sends", { requestId: rid(), contactIds: [yes.id], templateId: promo });
    expect(refused.json()).toMatchObject({ error: "marketing_platform_off" });
  });
});

describe("sending", () => {
  it("sends one text: preview, queue, AWS, the carrier's report, and the history in words", async () => {
    const o = await owner();
    const sender = await ready(o);
    const sam = await customer(o, "0412 345 678", "Sam");
    const t = await approved(o, "Pickup", "transactional", "Hi {{customer_name}}, order {{order_number}} is ready to collect on {{date}}. {{business_name}}");
    const body = { contactIds: [sam.id], templateId: t, values: { order_number: "#1042" } };
    const today = smsDate(new Date(), "Australia/Sydney");
    const preview = (await o.call("POST", "/sends/preview", body)).json();
    expect(preview).toMatchObject({ mode: "live", blockers: [], text: `Hi Sam, order #1042 is ready to collect on ${today}. Green Leaf`, segments: { segments: 1, encoding: "GSM" }, recipients: { sending: 1 } });
    expect(preview.cost.estimatedUsd).toBeCloseTo(0.05);

    const res = await o.call("POST", "/sends", { ...body, requestId: rid() });
    expect(res.statusCode).toBe(201);
    const send = res.json().send;
    expect(send).toMatchObject({ recipients: 1, counts: { queued: 1 }, done: false });
    expect(ctx.deps.queues.sent.sync).toEqual([{ kind: "sms", jobId: send.messages[0].id }]);
    expect(await drain()).toEqual(["accepted"]);
    expect(sms.sent).toHaveLength(1);
    expect(sms.sent[0]).toMatchObject({
      destination: "+61412345678",
      originationIdentity: sender,
      messageType: "TRANSACTIONAL",
      body: `Hi Sam, order #1042 is ready to collect on ${today}. Green Leaf`,
      maxPrice: "0.25000",
      context: { job: send.messages[0].id, ws: o.ws },
    });
    // Accepted by AWS is "Sent", not "Delivered"...
    expect((await o.call("GET", `/sends/${send.id}`)).json().send.counts).toMatchObject({ sent: 1, delivered: 0 });
    // ...until the carrier's report comes back.
    expect(await applySmsEvent(event(sms.sent[0]!.messageId, send.messages[0].id, o.ws, "DELIVERED"), deps)).toBe("applied");
    const after = (await o.call("GET", `/sends/${send.id}`)).json().send;
    expect(after).toMatchObject({ counts: { delivered: 1 }, done: true, messages: [{ stage: "delivered", stageLabel: "Delivered" }] });
    const [m] = (await o.call("GET", "/messages")).json().messages;
    expect(m).toMatchObject({ status: "delivered", statusLabel: "Delivered", purpose: "manual", priceUsd: 0.0581 });
    expect(await systemDb.smsCostRecord.count({ where: { storeId: o.store.id } })).toBe(1);
    expect(await systemDb.smsAuditLog.count({ where: { storeId: o.store.id, action: "send_created", targetId: send.id } })).toBe(1);
  });

  it("sends to many customers through the queue, paced, and tells delivered, rejected and undeliverable apart", async () => {
    ctx.setEnv({ SMS_PARTS_PER_SECOND: "2" });
    const o = await owner();
    await ready(o);
    const people = await Promise.all(["Ana", "Ben", "Cal", "Dee"].map((n, i) => customer(o, `0412 000 10${i}`, n)));
    const t = await approved(o, "Closed", "transactional", "Hi {{customer_name}}, our store is closed tomorrow. {{business_name}}");
    const send = (await o.call("POST", "/sends", { requestId: rid(), contactIds: people.map((p) => p.id), templateId: t })).json().send;
    expect(send.counts.queued).toBe(4);
    // Two parts a second: texts half a second apart.
    const jobs = await jobsOf(o.store.id);
    expect(jobs[3]!.sendAfter.getTime() - jobs[0]!.sendAfter.getTime()).toBeGreaterThanOrEqual(1400);
    expect(ctx.deps.queues.sentOpts.sync.map((x) => x?.delaySeconds ?? 0).every((d) => d <= 2)).toBe(true);
    // All four due at once: the sender's pace lets two go this second and puts the others off.
    // The pace is counted per clock second, so the clock stands still while they're tried: on a
    // busy machine four sends can take over a second and the last two would land in the next one.
    vi.useFakeTimers({ toFake: ["Date"] });
    await systemDb.smsMessageJob.updateMany({ where: { storeId: o.store.id }, data: { sendAfter: new Date() } });
    expect(await drain()).toEqual(["accepted", "accepted", "later", "later"]);
    expect(sms.sent).toHaveLength(2);
    vi.setSystemTime(Date.now() + 1100);
    await systemDb.smsMessageJob.updateMany({ where: { storeId: o.store.id, status: "scheduled" }, data: { sendAfter: new Date() } });
    expect(await drain()).toEqual(["accepted", "accepted"]);
    expect(new Set(sms.sent.map((m) => m.destination)).size).toBe(4);
    const byJob = new Map(sms.sent.map((s) => [s.context.job!, s.messageId]));
    await applySmsEvent(event(byJob.get(jobs[0]!.id)!, jobs[0]!.id, o.ws, "DELIVERED"), deps);
    await applySmsEvent(event(byJob.get(jobs[1]!.id)!, jobs[1]!.id, o.ws, "BLOCKED"), deps);
    await applySmsEvent(event(byJob.get(jobs[2]!.id)!, jobs[2]!.id, o.ws, "UNREACHABLE"), deps);
    await applySmsEvent(event(byJob.get(jobs[3]!.id)!, jobs[3]!.id, o.ws, "PENDING", false), deps);
    const after = (await o.call("GET", `/sends/${send.id}`)).json().send;
    expect(after.counts).toMatchObject({ delivered: 1, rejected: 1, undeliverable: 1, sent: 1 });
    expect(after.done).toBe(true);
  });

  it("texts the customer of a Shopify order through the same queue once an automation is on", async () => {
    const o = await owner();
    await ready(o);
    const created = await o.call("POST", "/automations", { name: "Order confirmed", trigger: "order_created", body: "Hi {{customer_name}}, thanks for order {{order_number}} with {{business_name}}!", delayMinutes: 0, conditions: [], quietStart: 0, quietEnd: 0 });
    expect(created.statusCode).toBe(201);
    const id = created.json().automation.id;
    expect((await o.call("POST", `/automations/${id}/activate`, { confirm: true })).json().automation.status).toBe("active");
    await smsOnShopifyEvent(o.store, "orders/create", { id: 901, name: "#901", currency: "AUD", created_at: new Date().toISOString(), total_price: "40.00", customer: { id: 9, first_name: "Sam" }, shipping_address: { country_code: "AU", phone: "0412 345 678" }, line_items: [] }, deps);
    // A Shopify retry of the same webhook makes no second text.
    await smsOnShopifyEvent(o.store, "orders/create", { id: 901, name: "#901", currency: "AUD", created_at: new Date().toISOString(), total_price: "40.00", customer: { id: 9, first_name: "Sam" }, shipping_address: { country_code: "AU", phone: "0412 345 678" }, line_items: [] }, deps);
    expect(await drain()).toEqual(["accepted"]);
    expect(sms.sent.map((m) => [m.destination, m.body])).toEqual([["+61412345678", "Hi Sam, thanks for order #901 with Green Leaf!"]]);
  });

  it("writes a new message on the page, saved and approved in the sender's name; order details only for one customer", async () => {
    const o = await owner();
    await ready(o);
    const [a, b] = await Promise.all([customer(o, "0412 000 201", "Ana"), customer(o, "0412 000 202", "Ben")]);
    const message = { name: "Your order", category: "transactional", body: "Hi {{customer_name}}, order {{order_number}} is ready." };
    const two = await o.call("POST", "/sends", { requestId: rid(), contactIds: [a.id, b.id], message, values: { order_number: "#7" } });
    expect(two.statusCode).toBe(400);
    expect(two.json()).toMatchObject({ error: "message_invalid", message: expect.stringMatching(/differ from customer to customer/) });
    expect(await systemDb.smsTemplate.count({ where: { storeId: o.store.id } })).toBe(0);
    const missing = await o.call("POST", "/sends", { requestId: rid(), contactIds: [a.id], message });
    expect(missing.json()).toMatchObject({ error: "message_invalid", message: expect.stringMatching(/Fill in the order number/) });
    const one = await o.call("POST", "/sends", { requestId: rid(), contactIds: [a.id], message, values: { order_number: "#7" } });
    expect(one.statusCode).toBe(201);
    const t = await systemDb.smsTemplate.findFirstOrThrow({ where: { storeId: o.store.id } });
    expect(t).toMatchObject({ name: "Your order", status: "approved", approvedVersion: 1 });
    expect(await systemDb.smsTemplateVersion.findFirst({ where: { templateId: t.id, version: 1 } })).toMatchObject({ approvedBy: o.user.id, submittedBy: o.user.id });
    await drain();
    expect(sms.sent.map((m) => m.body)).toEqual(["Hi Ana, order #7 is ready."]);
  });

  it("refuses a send while the store's setup, the SMS account or the month's limit would stop it, and says what to fix", async () => {
    const o = await owner();
    const sam = await customer(o, "0412 345 678", "Sam");
    const message = { name: "Hello", category: "transactional", body: "Hi {{customer_name}}, hello." };
    const none = await o.call("POST", "/sends", { requestId: rid(), contactIds: [sam.id], message });
    expect(none.json()).toMatchObject({ error: "setup_incomplete", message: "Your store has no SMS sender yet." });
    await ready(o);
    // The SMS account still in AWS's sandbox: only verified numbers would get it.
    sms.accountInfo = { ...sms.accountInfo, tier: "SANDBOX", sandbox: true };
    await ctx.deps.coord.take(accountStatusKey(smsRegion(null)));
    const preview = (await o.call("POST", "/sends/preview", { contactIds: [sam.id], message })).json();
    expect(preview.blockers).toEqual([expect.objectContaining({ code: "account_sandbox", message: expect.stringMatching(/still being verified/) })]);
    expect((await o.call("POST", "/sends", { requestId: rid(), contactIds: [sam.id], message })).json()).toMatchObject({ error: "account_sandbox" });
    sms.accountInfo = { ...sms.accountInfo, tier: "PRODUCTION", sandbox: false };
    await ctx.deps.coord.take(accountStatusKey(smsRegion(null)));
    // A limit too small for the text.
    await systemDb.smsSenderConfiguration.update({ where: { storeId: o.store.id }, data: { monthlyBudgetUsd: 0.01 } });
    expect((await o.call("POST", "/sends", { requestId: rid(), contactIds: [sam.id], message })).json()).toMatchObject({ error: "over_budget" });
    // Sending switched off.
    await systemDb.smsSenderConfiguration.update({ where: { storeId: o.store.id }, data: { monthlyBudgetUsd: 25, sendingEnabled: false } });
    expect((await o.call("POST", "/sends", { requestId: rid(), contactIds: [sam.id], message })).json()).toMatchObject({ error: "setup_incomplete", message: "Automatic SMS is switched off for your store." });
    expect(await systemDb.smsMessageJob.count({ where: { storeId: o.store.id } })).toBe(0);
    expect(await systemDb.smsTemplate.count({ where: { storeId: o.store.id } })).toBe(0);
  });
});

describe("scheduling", () => {
  it("holds a scheduled send until its time, and Cancel stops every text that hasn't gone", async () => {
    const o = await owner();
    await ready(o);
    const people = await Promise.all(["Ana", "Ben"].map((n, i) => customer(o, `0412 000 30${i}`, n)));
    const t = await approved(o, "Reminder", "transactional", "Hi {{customer_name}}, a reminder: your booking is tomorrow.");
    const at = new Date(Date.now() + 2 * 3600_000);
    const send = (await o.call("POST", "/sends", { requestId: rid(), contactIds: people.map((p) => p.id), templateId: t, scheduledAt: at.toISOString() })).json().send;
    expect(send.counts.queued).toBe(2);
    expect(new Date(send.scheduledAt).getTime()).toBeGreaterThanOrEqual(at.getTime() - 1000);
    expect(await systemDb.smsAuditLog.count({ where: { action: "send_scheduled", targetId: send.id } })).toBe(1);
    // Early queue deliveries wait (re-queued for later), sending nothing.
    expect(await drain()).toEqual(["later", "later"]);
    expect(sms.sent).toHaveLength(0);
    const cancelled = await o.call("POST", `/sends/${send.id}/cancel`, {});
    expect(cancelled.json().send.counts).toMatchObject({ cancelled: 2, queued: 0 });
    // Its time comes: nothing is left to send.
    await systemDb.smsMessageJob.updateMany({ where: { storeId: o.store.id }, data: { sendAfter: new Date() } });
    for (const j of await jobsOf(o.store.id)) expect(await sendSmsJob(j.id, deps)).toBe("gone");
    expect(sms.sent).toHaveLength(0);
    expect((await o.call("POST", `/sends/${send.id}/cancel`, {})).json()).toMatchObject({ error: "nothing_to_cancel" });
    expect((await o.call("POST", "/sends", { requestId: rid(), contactIds: [people[0]!.id], templateId: t, scheduledAt: new Date(Date.now() + 61 * 86400_000).toISOString() })).json()).toMatchObject({ error: "too_far_ahead" });
    expect(await systemDb.smsAuditLog.count({ where: { action: "send_cancelled", targetId: send.id } })).toBe(1);
  });
});

describe("failures, retries and duplicates", () => {
  async function oneText(o: Owner) {
    const sam = await customer(o, "0412 345 678", "Sam");
    const t = await approved(o, `Pickup ${rid()}`, "transactional", "Hi {{customer_name}}, your order is ready.");
    const send = (await o.call("POST", "/sends", { requestId: rid(), contactIds: [sam.id], templateId: t })).json().send;
    return { send, jobId: send.messages[0].id as string, contact: sam };
  }

  it("records AWS's refusals as failures in words, never as sent, and suppresses only numbers AWS can't use", async () => {
    const o = await owner();
    await ready(o);
    // What AWS answered a DryRun from this account while it is in the SMS sandbox (2026-10-25).
    sms.failNext(new SmsProviderError("ConflictException", "DESTINATION_PHONE_NUMBER_NOT_VERIFIED", 400, false, "Conflict Occurred"));
    const a = await oneText(o);
    expect(await drain()).toEqual(["failed"]);
    const m = (await o.call("GET", `/messages/${a.jobId}`)).json().message;
    expect(m).toMatchObject({ status: "failed", statusLabel: "Rejected", reasonLabel: "Until your SMS account is verified, texts only reach approved test recipients" });
    expect((await systemDb.smsContact.findUniqueOrThrow({ where: { id: a.contact.id } })).suppressedAll).toBe(false);

    sms.failNext(new SmsProviderError("ValidationException", "DESTINATION_COUNTRY_BLOCKED", 400, false, "blocked"));
    const b = await oneText(o);
    await drain();
    expect((await o.call("GET", `/messages/${b.jobId}`)).json().message).toMatchObject({ statusLabel: "Rejected", reasonLabel: "Texts to this country aren't allowed for your SMS sender" });
    expect((await systemDb.smsContact.findUniqueOrThrow({ where: { id: b.contact.id } })).suppressedAll).toBe(false);

    sms.failNext(new SmsProviderError("ValidationException", "INVALID_PHONE_NUMBER", 400, false, "invalid"));
    const c = await oneText(o);
    await drain();
    expect((await o.call("GET", `/messages/${c.jobId}`)).json().message).toMatchObject({ statusLabel: "Rejected", reasonLabel: "Not a valid mobile number" });
    expect((await systemDb.smsContact.findUniqueOrThrow({ where: { id: c.contact.id } })).suppressedAll).toBe(true);
    expect(sms.sent).toHaveLength(0);
    expect((await o.call("GET", `/sends/${c.send.id}`)).json().send.counts).toMatchObject({ rejected: 1, sent: 0, delivered: 0 });
  });

  it("never sends again on its own when AWS may have the text (a 500, a timeout)", async () => {
    const o = await owner();
    await ready(o);
    sms.failNext(new SmsProviderError("InternalServerException", null, 500, false, "boom"));
    const a = await oneText(o);
    expect(await drain()).toEqual(["uncertain"]);
    expect(await sendSmsJob(a.jobId, deps)).toBe("gone");
    expect(ctx.deps.queues.sent.sync).toHaveLength(0);
    expect((await o.call("GET", `/messages/${a.jobId}`)).json().message).toMatchObject({ status: "uncertain", statusLabel: "Unknown outcome" });
    // AWS's own event later settles it.
    await applySmsEvent(event("aws-msg-1", a.jobId, o.ws, "DELIVERED"), deps);
    expect((await o.call("GET", `/messages/${a.jobId}`)).json().message.status).toBe("delivered");
  });

  it("retries throttling with backoff and gives up after the last attempt", async () => {
    const o = await owner();
    await ready(o);
    sms.failNext(new SmsProviderError("ThrottlingException", null, 400, false, "slow down"));
    const a = await oneText(o);
    expect(await drain()).toEqual(["retry"]);
    let row = await systemDb.smsMessageJob.findUniqueOrThrow({ where: { id: a.jobId } });
    expect(row).toMatchObject({ status: "scheduled", attempts: 1, errorCode: "throttled" });
    expect(row.sendAfter.getTime()).toBeGreaterThan(Date.now() + 10_000);
    expect(ctx.deps.queues.sentOpts.sync[0]?.delaySeconds).toBeGreaterThanOrEqual(15);
    // Its time comes: it goes.
    await systemDb.smsMessageJob.update({ where: { id: a.jobId }, data: { sendAfter: new Date() } });
    expect(await drain()).toEqual(["accepted"]);
    expect(sms.sent).toHaveLength(1);

    // Throttled on every attempt: failed after the sixth, said in words.
    const b = await oneText(o);
    for (let i = 0; i < 6; i++) {
      sms.failNext(new SmsProviderError("ThrottlingException", null, 400, false, "slow down"));
      await systemDb.smsMessageJob.update({ where: { id: b.jobId }, data: { sendAfter: new Date() } });
      await sendSmsJob(b.jobId, deps);
    }
    row = await systemDb.smsMessageJob.findUniqueOrThrow({ where: { id: b.jobId } });
    expect(row).toMatchObject({ status: "failed", reason: "too_many_retries", attempts: 6 });
    expect((await o.call("GET", `/messages/${b.jobId}`)).json().message).toMatchObject({ statusLabel: "Failed", reasonLabel: "The SMS provider stayed busy for too long" });
    expect(sms.sent).toHaveLength(1);
  });

  it("makes one send of a repeated request and hands each text to AWS once, however often its job runs or its event arrives", async () => {
    const o = await owner();
    await ready(o);
    const sam = await customer(o, "0412 345 678", "Sam");
    const t = await approved(o, "Pickup", "transactional", "Hi {{customer_name}}, your order is ready.");
    const request = { requestId: rid(), contactIds: [sam.id], templateId: t };
    const [first, again] = await Promise.all([o.call("POST", "/sends", request), o.call("POST", "/sends", request)]);
    const ids = [first, again].filter((r) => r.statusCode === 201).map((r) => r.json().send.id);
    expect(ids.length).toBeGreaterThanOrEqual(1);
    expect([first, again].every((r) => r.statusCode === 201 || r.json().error === "send_in_progress")).toBe(true);
    expect((await o.call("POST", "/sends", request)).json().send.id).toBe(request.requestId);
    expect(await systemDb.smsMessageJob.count({ where: { storeId: o.store.id } })).toBe(1);
    // The queue delivers the job twice, at once.
    const [job] = await jobsOf(o.store.id);
    const outcomes = await Promise.all([sendSmsJob(job!.id, deps), sendSmsJob(job!.id, deps)]);
    expect(outcomes.sort()).toEqual(["accepted", "gone"]);
    expect(sms.sent).toHaveLength(1);
    const e = event(sms.sent[0]!.messageId, job!.id, o.ws, "DELIVERED");
    expect(await applySmsEvent(e, deps)).toBe("applied");
    expect(await applySmsEvent(e, deps)).toBe("duplicate");
    expect(await systemDb.smsCostRecord.count({ where: { jobId: job!.id } })).toBe(1);
    // A one-off text from the older page, pressed twice with the same id: one text.
    const once = { templateId: t, contactId: sam.id, requestId: rid() };
    const m1 = (await o.call("POST", "/send", once)).json().message;
    const m2 = (await o.call("POST", "/send", once)).json().message;
    expect(m2.id).toBe(m1.id);
  });

  it("limits how many sends a store makes and how many customers one send reaches", async () => {
    const o = await owner();
    await ready(o);
    const sam = await customer(o, "0412 345 678", "Sam");
    const t = await approved(o, "Pickup", "transactional", "Hi {{customer_name}}, your order is ready.");
    const tooMany = await o.call("POST", "/sends", { requestId: rid(), contactIds: Array.from({ length: 201 }, (_, i) => `c${i}`), templateId: t });
    expect(tooMany.statusCode).toBe(400);
    ctx.deps.coord.clear();
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await o.call("POST", "/sends", { requestId: rid(), contactIds: [sam.id], templateId: t })).statusCode);
    expect(codes.slice(0, 10).every((c) => c === 201)).toBe(true);
    expect(codes[10]).toBe(429);
    // The customer's own daily cap still applies to what got through.
    await drain();
    expect(sms.sent).toHaveLength(5);
  });
});

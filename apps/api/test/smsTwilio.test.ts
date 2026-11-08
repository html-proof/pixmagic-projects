import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { systemDb, type Store } from "@app/db";
import {
  applySmsEvent,
  fakeSmsProvider,
  sweepSms,
  TWILIO_INBOUND_PATH,
  twilioInboundUrl,
  twilioSignature,
  twilioStatusUrl,
  upsertSmsContact,
  type FakeSmsProvider,
  type SmsDeps,
} from "@app/core/sms";
import { normalizePhone } from "@app/shared";
import { clean, createStore, createWorkspace, setup, signIn, teardown, type TestCtx } from "./helpers.js";

/**
 * Texts through Twilio (docs/sms.md, "Twilio"), from the API's side: its two webhooks and what
 * they lead to. Twilio itself is faked at the provider interface (the adapter is
 * apps/aws/test/twilioSmsProvider.test.ts's); its webhooks are posted here signed as Twilio signs
 * them, with this test's Auth Token.
 *  - a status report is refused without a good signature, and queued otherwise in the event shape
 *    the smsEvents handler applies: delivered, or failed in words, with the number suppressed only
 *    when Twilio says it doesn't exist;
 *  - a STOP reply puts the number on the suppression list of the stores texting from that number
 *    or service (and only those), and no further text goes to it;
 *  - the sweep records Twilio's price, once.
 */

const TOKEN = "0123456789abcdef0123456789abcdef";
const NUMBER = "+61400000001";
const SERVICE = `MG${"a".repeat(32)}`;

let ctx: TestCtx;
let sms: FakeSmsProvider;
let deps: SmsDeps;

beforeAll(async () => {
  ctx = await setup();
  sms = fakeSmsProvider();
  (ctx.deps as { sms?: FakeSmsProvider }).sms = sms;
  deps = { coord: ctx.deps.coord, queues: ctx.deps.queues, fetchImpl: ctx.deps.fetchImpl, mailer: ctx.deps.mailer, sms };
});
afterAll(async () => {
  ctx.setEnv({ SMS_MODE: "off", SMS_MARKETING_ENABLED: "", TWILIO_AUTH_TOKEN: "", SMS_PARTS_PER_SECOND: "1", SMS_PRICE_TABLE: "{}" });
  await teardown(ctx);
});
beforeEach(async () => {
  await clean(ctx);
  sms.clear();
  sms.identities.clear();
  sms.accountInfo = { tier: "PRODUCTION", sandbox: false, spendLimitUsd: null, spendLimitMaxUsd: null };
  ctx.deps.queues.clear();
  ctx.setEnv({ SMS_MODE: "live", SMS_MARKETING_ENABLED: "1", SMS_SHARED_SENDER: "", SMS_PARTS_PER_SECOND: "1000", SMS_PRICE_TABLE: JSON.stringify({ AU: 0.05 }), TWILIO_AUTH_TOKEN: TOKEN });
});

/** A store whose sender is one of the platform's Twilio numbers (or a service), tagged for its workspace, checked and sending. */
async function storeTexting(uid: string, identity: string) {
  const s = await signIn(ctx, uid, `${uid}@shop.test`);
  const ws = await createWorkspace(ctx, s.headers);
  const store = (await createStore(ws, `${uid}.myshopify.com`, ["read_orders"], { name: "Green Leaf", currency: "AUD", timezone: "Australia/Melbourne" })) as Store;
  const info = identity.startsWith("MG")
    ? { kind: "pool" as const, arn: identity, id: identity, label: identity, country: null, status: "ACTIVE", twoWay: true, optOutList: null, registrationStatus: null, tags: { "bizinsights:workspace": ws } }
    : { kind: "long_code" as const, arn: identity, id: `PN${uid.padEnd(32, "0")}`, label: identity, country: "AU", status: "ACTIVE", twoWay: true, optOutList: null, registrationStatus: null, tags: { "bizinsights:workspace": ws } };
  sms.identities.set(info.arn, info);
  sms.identities.set(info.id, info);
  const base = `/workspaces/${ws}/stores/${store.id}/sms`;
  const call = (method: "GET" | "POST" | "PUT", path: string, payload?: unknown) => ctx.app.inject({ method, url: `${base}${path}`, headers: s.headers, ...(payload === undefined ? {} : { payload }) });
  const put = await call("PUT", "/sender", { senderType: info.kind, originationIdentity: identity, countries: ["AU"], monthlyBudgetUsd: 25, hardStop: true, transactionalBasis: "checkout_notice", quietStart: 0, quietEnd: 0, maxPerCustomerDay: 5, maxMarketingPerWeek: 3 });
  expect(put.statusCode).toBe(200);
  expect((await call("POST", "/sender/verify")).json().sender.identityCheck).toBe("verified");
  expect((await call("POST", "/sender/sending", { sending: true })).json().sender.sendingEnabled).toBe(true);
  const t = await call("POST", "/templates", { name: "Order update", category: "transactional", body: "Your order is on its way." });
  const templateId = t.json().template.id as string;
  await call("POST", `/templates/${templateId}/submit`, {});
  expect((await call("POST", `/templates/${templateId}/approve`, {})).json().template.status).toBe("approved");
  return { ws, store, call, templateId };
}

let seq = 0;

/** One text to a customer through the API (a one-off text goes at once): its job and the id the provider gave it. */
async function textOne(o: Awaited<ReturnType<typeof storeTexting>>, phone: string) {
  const contact = await upsertSmsContact(o.store, { phone: normalizePhone(phone, "AU")!, firstName: "Sam", consent: null });
  const r = await o.call("POST", "/send", { templateId: o.templateId, contactId: contact.id, requestId: `twilio-test-${++seq}` });
  expect(r.statusCode).toBe(200);
  const job = await systemDb.smsMessageJob.findFirstOrThrow({ where: { storeId: o.store.id, contactId: contact.id }, orderBy: { createdAt: "desc" } });
  expect(job.status).toBe("accepted");
  return { job, contact };
}

/** POST a webhook signed as Twilio signs it: the URL it called (query included), then the form's fields. */
function post(url: string, fields: Record<string, string>, token = TOKEN) {
  const form = new URLSearchParams(fields);
  const u = new URL(url);
  const path = u.pathname.replace(/^\/api/, "") + u.search;
  return ctx.app.inject({
    method: "POST",
    url: path,
    headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": twilioSignature(token, url, form) },
    payload: form.toString(),
  });
}

describe("Twilio's status reports (POST /webhooks/sms/twilio/status)", () => {
  it("refuses a report that isn't signed with the account's Auth Token, and queues nothing", async () => {
    const url = twilioStatusUrl({ job: "j1", ws: "w1" });
    const fields = { MessageSid: "SM1", MessageStatus: "delivered" };
    expect((await post(url, fields, "f".repeat(32))).statusCode).toBe(403);
    const unsigned = await ctx.app.inject({ method: "POST", url: new URL(url).pathname.replace(/^\/api/, "") + new URL(url).search, headers: { "content-type": "application/x-www-form-urlencoded" }, payload: new URLSearchParams(fields).toString() });
    expect(unsigned.statusCode).toBe(403);
    // A signed report with its query changed (another job) doesn't verify either.
    const form = new URLSearchParams(fields);
    const tampered = await ctx.app.inject({ method: "POST", url: `${new URL(url).pathname.replace(/^\/api/, "")}?job=j2&ws=w1`, headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": twilioSignature(TOKEN, url, form) }, payload: form.toString() });
    expect(tampered.statusCode).toBe(403);
    ctx.setEnv({ TWILIO_AUTH_TOKEN: "" });
    expect((await post(url, fields)).statusCode).toBe(403);
    expect(ctx.deps.queues.sent.smsEvents).toHaveLength(0);
  });

  it("queues each report as a delivery event for its job, and the handler settles the text: delivered", async () => {
    const o = await storeTexting("tw1", NUMBER);
    const { job } = await textOne(o, "+61412345601");
    expect(job.status).toBe("accepted");
    const url = twilioStatusUrl({ job: job.id, ws: job.workspaceId });
    expect((await post(url, { MessageSid: job.providerMessageId!, MessageStatus: "sent", AccountSid: "AC1", To: "+61412345601" })).statusCode).toBe(204);
    expect((await post(url, { MessageSid: job.providerMessageId!, MessageStatus: "delivered", AccountSid: "AC1", To: "+61412345601" })).statusCode).toBe(204);
    const events = ctx.deps.queues.sent.smsEvents.splice(0);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ eventType: "TEXT_DELIVERED", isFinal: true, messageId: job.providerMessageId, messageStatus: "DELIVERED", context: { job: job.id, ws: job.workspaceId } });
    expect(await applySmsEvent(events[0], deps)).toBe("applied");
    expect((await systemDb.smsMessageJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("pending");
    expect(await applySmsEvent(events[1], deps)).toBe("applied");
    expect((await systemDb.smsMessageJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("delivered");
  });

  it("an undelivered text is failed in the provider's words; only a number that doesn't exist is suppressed", async () => {
    const o = await storeTexting("tw2", NUMBER);
    const off = await textOne(o, "+61412345602");
    const gone = await textOne(o, "+61412345603");
    await post(twilioStatusUrl({ job: off.job.id, ws: off.job.workspaceId }), { MessageSid: off.job.providerMessageId!, MessageStatus: "undelivered", ErrorCode: "30003" });
    await post(twilioStatusUrl({ job: gone.job.id, ws: gone.job.workspaceId }), { MessageSid: gone.job.providerMessageId!, MessageStatus: "undelivered", ErrorCode: "30005" });
    for (const e of ctx.deps.queues.sent.smsEvents.splice(0)) expect(await applySmsEvent(e, deps)).toBe("applied");
    expect(await systemDb.smsMessageJob.findUniqueOrThrow({ where: { id: off.job.id } })).toMatchObject({ status: "failed", providerStatus: "UNREACHABLE" });
    expect(await systemDb.smsMessageJob.findUniqueOrThrow({ where: { id: gone.job.id } })).toMatchObject({ status: "failed", providerStatus: "INVALID" });
    const suppressed = await systemDb.smsSuppression.findMany({ where: { storeId: o.store.id } });
    expect(suppressed.map((s) => s.reason)).toEqual(["invalid_number"]);
  });
});

describe("replies (POST /webhooks/sms/twilio/inbound)", () => {
  it("a STOP to a number suppresses the customer for every store texting from it, and only those", async () => {
    const a = await storeTexting("tw3", NUMBER);
    const b = await storeTexting("tw4", NUMBER);
    const other = await storeTexting("tw5", "+61400000009");
    const res = await post(twilioInboundUrl(), { MessageSid: "SMin1", From: "+61412345604", To: NUMBER, Body: " Stop ", AccountSid: "AC1" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/xml");
    expect(res.body).toContain("<Response>");
    for (const s of [a, b]) expect((await systemDb.smsSuppression.findMany({ where: { storeId: s.store.id } })).map((x) => [x.reason, x.scope])).toEqual([["keyword_stop", "all"]]);
    expect(await systemDb.smsSuppression.count({ where: { storeId: other.store.id } })).toBe(0);
    // And no text goes to that customer from a store that heard the STOP.
    const contact = await upsertSmsContact(a.store, { phone: normalizePhone("+61412345604", "AU")!, firstName: "Sam", consent: null });
    await a.call("POST", "/send", { templateId: a.templateId, contactId: contact.id, requestId: "twilio-after-stop" });
    expect(sms.sent.filter((x) => x.destination === "+61412345604")).toHaveLength(0);
  });

  it("a STOP through a Messaging Service (Advanced Opt-Out's OptOutType) reaches the stores using that service", async () => {
    const a = await storeTexting("tw6", SERVICE);
    await post(twilioInboundUrl(), { MessageSid: "SMin2", From: "+61412345605", To: "+61400000077", MessagingServiceSid: SERVICE, Body: "unsubscribe me please", OptOutType: "STOP" });
    expect((await systemDb.smsSuppression.findMany({ where: { storeId: a.store.id } })).map((x) => x.reason)).toEqual(["keyword_stop"]);
  });

  it("any other reply changes nothing, and an unsigned one is refused", async () => {
    const a = await storeTexting("tw7", NUMBER);
    expect((await post(twilioInboundUrl(), { MessageSid: "SMin3", From: "+61412345606", To: NUMBER, Body: "Thanks! When does it arrive?" })).statusCode).toBe(200);
    expect((await post(twilioInboundUrl(), { MessageSid: "SMin4", From: "+61412345606", To: NUMBER, Body: "STOP" }, "e".repeat(32))).statusCode).toBe(403);
    expect(await systemDb.smsSuppression.count({ where: { storeId: a.store.id } })).toBe(0);
    expect(TWILIO_INBOUND_PATH).toBe("/webhooks/sms/twilio/inbound");
  });
});

describe("Twilio's prices (the sweep)", () => {
  it("records the price Twilio reports once the text is priced, once, and leaves the others to wait", async () => {
    const o = await storeTexting("tw8", NUMBER);
    const { job } = await textOne(o, "+61412345607");
    const waiting = await textOne(o, "+61412345608");
    const tenMinutesAgo = new Date(Date.now() - 10 * 60_000);
    await systemDb.smsMessageJob.update({ where: { id: job.id }, data: { providerMessageId: `SM${"1".repeat(32)}`, acceptedAt: tenMinutesAgo } });
    await systemDb.smsMessageJob.update({ where: { id: waiting.job.id }, data: { providerMessageId: `SM${"2".repeat(32)}`, acceptedAt: tenMinutesAgo } });
    const asked: string[] = [];
    const twilioLike = Object.assign(Object.create(null), sms, {
      messageCost: async (id: string) => {
        asked.push(id);
        return id === `SM${"1".repeat(32)}` ? { priceUsd: 0.0525, parts: 1 } : null;
      },
    }) as FakeSmsProvider;
    const r = await sweepSms({ ...deps, sms: twilioLike });
    expect(r.costs).toBe(1);
    expect(asked.sort()).toEqual([`SM${"1".repeat(32)}`, `SM${"2".repeat(32)}`]);
    expect(Number((await systemDb.smsMessageJob.findUniqueOrThrow({ where: { id: job.id } })).priceUsd)).toBeCloseTo(0.0525);
    expect(await systemDb.smsCostRecord.count({ where: { jobId: job.id } })).toBe(1);
    expect((await systemDb.smsMessageJob.findUniqueOrThrow({ where: { id: waiting.job.id } })).priceUsd).toBeNull();
    // Priced once: the next sweep asks only about the one still waiting.
    asked.length = 0;
    await sweepSms({ ...deps, sms: twilioLike });
    expect(asked).toEqual([`SM${"2".repeat(32)}`]);
    expect(await systemDb.smsCostRecord.count({ where: { jobId: job.id } })).toBe(1);
  });
});

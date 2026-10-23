import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectDb, systemDb, type Store } from "@app/db";
import { resetDb } from "@app/db/testing";
import { memoryBlobs, memoryCoord, memoryMailer, memoryQueues, resetEnvCache, type FetchLike } from "@app/core";
import {
  ACCOUNT_HOLD_KEY,
  applyOptOut,
  applySmsEvent,
  campaignAction,
  createRule,
  createTemplate,
  fakeSmsProvider,
  newOptOutCode,
  ruleAction,
  saveCampaign,
  saveSender,
  saveSetupDraft,
  sendManualSms,
  setSetupAutomation,
  sendSmsJob,
  settleStuckSends,
  smsOnShopifyEvent,
  SmsProviderError,
  startDueCampaigns,
  sweepSms,
  templateAction,
  updateTemplate,
  upsertSmsContact,
  verifySender,
  type FakeSmsProvider,
} from "@app/core/sms";
import { normalizePhone, sha256Hex } from "@app/shared";
import type { WorkerDeps } from "../src/handlers.js";
import { consume, type QueueMessage } from "../src/index.js";

/**
 * Customer Messaging end to end inside the worker: Shopify events → contacts, consent and rules →
 * the send path (AWS faked) → AWS's delivery events. Real Postgres; nothing leaves the process.
 */

const queues = memoryQueues();
const coord = memoryCoord();
let sms: FakeSmsProvider;
let deps: WorkerDeps & { sms: FakeSmsProvider };
const actor = { userId: null, ip: "127.0.0.1" };
const SENDER = "TESTSENDER";

function setMode(vars: Record<string, string>) {
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
  resetEnvCache();
}

beforeAll(() => {
  sms = fakeSmsProvider();
  deps = { coord, queues, payloads: memoryBlobs(), mailer: memoryMailer(), fetchImpl: (async () => new Response("{}")) as unknown as FetchLike, sms };
});
afterAll(async () => {
  setMode({ SMS_MODE: "off", SMS_MARKETING_ENABLED: "", SMS_PRICE_TABLE: "{}", SMS_ACCOUNT_MONTHLY_LIMIT_USD: "20", SMS_PARTS_PER_SECOND: "1" });
  await disconnectDb();
});
beforeEach(async () => {
  await resetDb();
  queues.clear();
  coord.clear();
  sms.clear();
  sms.identities.clear();
  setMode({ SMS_MODE: "live", SMS_MARKETING_ENABLED: "1", SMS_PRICE_TABLE: JSON.stringify({ AU: 0.05, NZ: 0.08, IN: 0.01, US: 0.01 }), SMS_ACCOUNT_MONTHLY_LIMIT_USD: "20", SMS_PARTS_PER_SECOND: "1000" });
});

interface StoreOpts {
  basis?: "none" | "checkout_notice" | "sms_consent";
  budget?: number;
  countries?: string[];
  marketing?: boolean;
  quiet?: [number, number];
  dltEntityId?: string | null;
  maxPerCustomerDay?: number;
}

async function setupStore(o: StoreOpts = {}): Promise<Store> {
  const ws = await systemDb.workspace.create({ data: { name: "W" } });
  const store = await systemDb.store.create({
    data: { workspaceId: ws.id, shopDomain: `s${Math.random().toString(36).slice(2, 8)}.myshopify.com`, name: "Green Leaf", currency: "AUD", grantedScopes: ["read_orders"], status: "active", timezone: "UTC", pixelIngestKey: `pk-${Math.random()}` },
  });
  // The identity is in "AWS", tagged for this workspace.
  sms.identities.set(SENDER, { kind: "sender_id", arn: `arn:aws:sms-voice:ap-southeast-2:1:sender-id/${SENDER}/AU`, id: SENDER, label: SENDER, country: "AU", status: "REGISTERED", twoWay: false, optOutList: "Default", registrationStatus: "COMPLETE", tags: { "bizinsights:workspace": ws.id } });
  await saveSender(
    store,
    {
      senderType: "sender_id",
      originationIdentity: SENDER,
      countries: o.countries ?? ["AU", "NZ"],
      monthlyBudgetUsd: o.budget ?? 50,
      hardStop: true,
      transactionalBasis: o.basis ?? "checkout_notice",
      quietStart: o.quiet?.[0] ?? 0,
      quietEnd: o.quiet?.[1] ?? 0,
      maxPerCustomerDay: o.maxPerCustomerDay ?? 5,
      maxMarketingPerWeek: 5,
      dltEntityId: o.dltEntityId ?? null,
    },
    actor,
  );
  const s = await verifySender(store, deps, actor);
  expect(s.identityCheck).toBe("verified");
  await systemDb.smsSenderConfiguration.update({ where: { storeId: store.id }, data: { sendingEnabled: true, marketingEnabled: o.marketing ?? true } });
  return store;
}

async function approvedTemplate(store: Store, body: string, category: "transactional" | "marketing" = "transactional", extra: { dltTemplateId?: string; dltText?: string; countries?: string[] } = {}) {
  const { template } = await createTemplate(store, { name: `T${Math.random().toString(36).slice(2, 7)}`, category, body, ...extra }, actor);
  await templateAction(store, template.id, "submit", actor);
  await templateAction(store, template.id, "approve", actor);
  return template;
}

// No quiet hours unless the test sets them: a rule's default (21:00-09:00 in the customer's zone)
// would hold the text whenever CI happens to run inside that window.
const ANY_HOUR = { quietStart: 0, quietEnd: 0 };

async function activeRule(store: Store, input: Record<string, unknown>) {
  const rule = await createRule(store, { dryRun: false, ...ANY_HOUR, ...input }, actor);
  await ruleAction(store, rule.id, "submit", actor);
  return ruleAction(store, rule.id, "approve", actor);
}

let seq = 9000;
const order = (over: Record<string, unknown> = {}) => ({
  id: ++seq,
  name: `#${seq}`,
  currency: "AUD",
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  cancelled_at: null,
  financial_status: "paid",
  total_price: "89.95",
  phone: null,
  tags: "",
  checkout_token: null,
  customer: { id: 77, first_name: "Sam" },
  shipping_address: { first_name: "Sam", country_code: "AU", phone: "0412 345 678" },
  line_items: [{ id: 1, product_id: 10, title: "Merino Crew", quantity: 1, price: "89.95" }],
  fulfillments: [],
  ...over,
});

const event = (store: Store, topic: string, p: unknown, webhookId = `wh-${Math.random()}`) => smsOnShopifyEvent(store, topic, p, deps, { webhookId });
const jobs = (storeId: string) => systemDb.smsMessageJob.findMany({ where: { storeId }, orderBy: { createdAt: "asc" } });

/** Run the queued SMS jobs and AWS's events, as the jobs function would. */
async function drain() {
  for (let i = 0; i < 100; i++) {
    const sync = (queues.sent.sync.splice(0) as unknown as Array<{ kind: string }>).filter((j) => j.kind === "sms");
    const events = queues.sent.smsEvents.splice(0);
    if (!sync.length && !events.length) return;
    for (const body of sync) await consume("sync", { id: "q", body, attempts: 1, ack: () => {}, retry: () => {} } as QueueMessage, deps);
    for (const body of events) await consume("smsEvents", { id: "e", body, attempts: 1, ack: () => {}, retry: () => {} } as QueueMessage, deps);
  }
}

/** Make every scheduled text due now and send it. */
async function sendDue(storeId: string) {
  await systemDb.smsMessageJob.updateMany({ where: { storeId, status: "scheduled" }, data: { sendAfter: new Date(Date.now() - 1000) } });
  for (const j of await systemDb.smsMessageJob.findMany({ where: { storeId, status: "scheduled" } })) await sendSmsJob(j.id, deps);
}

/** An AWS delivery event for a sent text. */
const awsEvent = (messageId: string, jobId: string, ws: string, status: string, isFinal: boolean, over: Record<string, unknown> = {}) => ({
  eventType: `TEXT_${status}`,
  eventVersion: "1.0",
  eventTimestamp: Date.now(),
  isFinal,
  destinationPhoneNumber: "+61412345678",
  isoCountryCode: "AU",
  messageId,
  messageRequestTimestamp: Date.now() - 2000,
  messageType: "TRANSACTIONAL",
  messageStatus: status,
  messageStatusDescription: "x",
  context: { job: jobId, ws },
  totalMessageParts: 1,
  totalMessagePrice: 0.0412,
  totalCarrierFee: 0,
  ...over,
});

describe("order events", () => {
  it("texts a new order's confirmation once, with the order's own details, and AWS's id and context", async () => {
    const store = await setupStore();
    const t = await approvedTemplate(store, "Hi {{customer_name}}, {{store_name}} got order {{order_number}} ({{currency}} {{order_total}}).");
    await activeRule(store, { name: "Confirm", trigger: "order_created", templateId: t.id });
    const o = order();
    await event(store, "orders/create", o);
    await drain();
    expect(sms.sent).toHaveLength(1);
    expect(sms.sent[0]).toMatchObject({ destination: "+61412345678", body: `Hi Sam, Green Leaf got order ${o.name} (AUD 89.95).`, messageType: "TRANSACTIONAL", originationIdentity: SENDER });
    const [job] = await jobs(store.id);
    expect(job).toMatchObject({ status: "accepted", providerMessageId: sms.sent[0]!.messageId, valuesEnc: null, segments: 1, encoding: "GSM", destinationCountry: "AU" });
    expect(sms.sent[0]!.context).toEqual({ job: job!.id, ws: store.workspaceId });
    // The contact holds the number encrypted and masked, never in the clear.
    const contact = await systemDb.smsContact.findFirstOrThrow({ where: { storeId: store.id } });
    expect(contact.phoneMasked).toMatch(/^\+61 •+ 678$/);
    expect(contact.phoneEnc).not.toContain("412345678");
  });

  it("runs the order updates Set up SMS turned on, with the business's name and the order's status", async () => {
    const store = await setupStore();
    await saveSetupDraft(store, { businessName: "IKOREX" }, actor);
    await setSetupAutomation(store, "order_created", { on: true, confirm: true }, actor);
    await setSetupAutomation(store, "fulfillment_created", { on: true, confirm: true }, actor);
    const o = order();
    await event(store, "orders/create", o);
    await event(store, "orders/fulfilled", { ...o, fulfillments: [{ id: 501, status: "success", created_at: new Date().toISOString(), tracking_url: "https://track.example.com/AB1" }] });
    await drain();
    expect(sms.sent.map((s) => s.body)).toEqual([
      `Hi Sam, your order ${o.name} has been confirmed. Thank you for shopping with IKOREX!`,
      `Good news Sam! Your IKOREX order ${o.name} is on its way. Track it: https://track.example.com/AB1`,
    ]);
    expect((await jobs(store.id)).map((j) => [j.trigger, j.status])).toEqual([
      ["order_created", "accepted"],
      ["fulfillment_created", "accepted"],
    ]);
  });

  it("sends once when Shopify delivers the same order twice, or orders/updated follows", async () => {
    const store = await setupStore();
    const t = await approvedTemplate(store, "Order {{order_number}} confirmed.");
    await activeRule(store, { name: "Confirm", trigger: "order_created", templateId: t.id });
    const o = order();
    await event(store, "orders/create", o, "wh-1");
    await event(store, "orders/create", o, "wh-1");
    await event(store, "orders/updated", o, "wh-2");
    await drain();
    expect(sms.sent).toHaveLength(1);
    expect(await jobs(store.id)).toHaveLength(1);
  });

  it("records why nothing was sent: no number, or a number that can't be placed", async () => {
    const store = await setupStore();
    const t = await approvedTemplate(store, "Order {{order_number}} confirmed.");
    await activeRule(store, { name: "Confirm", trigger: "order_created", templateId: t.id });
    await event(store, "orders/create", order({ shipping_address: { country_code: "AU" }, customer: { id: 1 } }));
    // A local number with no country to read it by.
    await event(store, "orders/create", order({ shipping_address: { phone: "0412 345 678" }, customer: { id: 2 } }));
    await drain();
    expect(sms.sent).toHaveLength(0);
    expect((await jobs(store.id)).map((j) => [j.status, j.reason])).toEqual([
      ["skipped", "no_phone"],
      ["skipped", "invalid_number"],
    ]);
  });

  it("sends no order update until the merchant chooses a basis for them", async () => {
    const store = await setupStore({ basis: "none" });
    const t = await approvedTemplate(store, "Order {{order_number}} confirmed.");
    await activeRule(store, { name: "Confirm", trigger: "order_created", templateId: t.id });
    await event(store, "orders/create", order());
    await drain();
    expect(sms.sent).toHaveLength(0);
    expect((await jobs(store.id))[0]).toMatchObject({ status: "skipped", reason: "no_transactional_basis" });
  });

  it("texts only countries the sender may reach (a wrong country code is never 'fixed')", async () => {
    const store = await setupStore({ countries: ["AU"] });
    const t = await approvedTemplate(store, "Order {{order_number}} confirmed.");
    await activeRule(store, { name: "Confirm", trigger: "order_created", templateId: t.id });
    // A +64 (New Zealand) number on an Australian address: texted as +64, so refused for this sender.
    await event(store, "orders/create", order({ shipping_address: { country_code: "AU", phone: "+64 21 123 4567" } }));
    await drain();
    expect(sms.sent).toHaveLength(0);
    expect((await jobs(store.id))[0]).toMatchObject({ status: "skipped", reason: "country_not_enabled" });
  });

  it("announces a fulfillment once with its tracking link, and cancels waiting texts when the order is cancelled", async () => {
    const store = await setupStore();
    const shipped = await approvedTemplate(store, "{{store_name}}: order {{order_number}} shipped. Track: {{tracking_url}}");
    const thanks = await approvedTemplate(store, "Thanks for order {{order_number}}!");
    await activeRule(store, { name: "Shipped", trigger: "fulfillment_created", templateId: shipped.id });
    await activeRule(store, { name: "Thanks later", trigger: "order_created", templateId: thanks.id, delayMinutes: 120 });
    const o = order({ fulfillments: [{ id: 501, status: "success", tracking_url: "https://track.example.com/AB1", created_at: new Date().toISOString() }] });
    await event(store, "orders/create", o);
    await event(store, "orders/updated", o);
    await drain();
    expect(sms.sent.map((s) => s.body)).toEqual([`Green Leaf: order ${o.name} shipped. Track: https://track.example.com/AB1`]);
    await event(store, "orders/cancelled", { ...o, cancelled_at: new Date().toISOString() });
    const later = (await jobs(store.id)).find((j) => j.trigger === "order_created")!;
    expect(later).toMatchObject({ status: "cancelled", reason: "order_cancelled" });
  });
});

describe("abandoned checkouts", () => {
  const checkout = (over: Record<string, unknown> = {}) => ({
    token: `ck-${Math.random().toString(36).slice(2, 8)}`,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    completed_at: null,
    currency: "AUD",
    total_price: "120.00",
    abandoned_checkout_url: "https://shop.example.com/checkouts/c/abc/recover",
    customer: { id: 88, first_name: "Jo", sms_marketing_consent: { state: "subscribed", opt_in_level: "single_opt_in", consent_updated_at: new Date(Date.now() - 86400_000).toISOString(), consent_collected_from: "SHOPIFY" } },
    shipping_address: { first_name: "Jo", country_code: "AU", phone: "0412 999 888" },
    line_items: [{ product_id: 1, title: "Linen Shirt", quantity: 1, price: "120.00" }],
    ...over,
  });

  async function cartSetup() {
    const store = await setupStore();
    const t = await approvedTemplate(store, "{{store_name}}: still thinking about {{product_name}}? Finish here: {{checkout_url}} Opt out: {{opt_out_url}}", "marketing");
    await activeRule(store, { name: "Cart 1h", trigger: "checkout_abandoned", templateId: t.id, delayMinutes: 60 });
    return store;
  }

  it("waits the delay, re-checks, then sends one reminder per stage with a working opt-out link", async () => {
    const store = await cartSetup();
    const ck = checkout();
    await event(store, "checkouts/create", ck);
    await event(store, "checkouts/update", ck);
    const [job] = await jobs(store.id);
    expect(job!.status).toBe("scheduled");
    expect(job!.sendAfter.getTime()).toBeGreaterThan(Date.now() + 55 * 60_000);
    await sendDue(store.id);
    await event(store, "checkouts/update", { ...ck, updated_at: new Date().toISOString() });
    await sendDue(store.id);
    expect(sms.sent).toHaveLength(1);
    expect(sms.sent[0]!.messageType).toBe("PROMOTIONAL");
    const code = /stop\?c=([A-Za-z0-9]+)/.exec(sms.sent[0]!.body)![1]!;
    expect(sms.sent[0]!.body).toContain("https://shop.example.com/checkouts/c/abc/recover");
    expect((await systemDb.smsMessageJob.findFirstOrThrow({ where: { storeId: store.id } })).optOutCodeHash).toBe(sha256Hex(code));
  });

  it("cancels the reminder when the customer buys before it is due", async () => {
    const store = await cartSetup();
    const ck = checkout();
    await event(store, "checkouts/create", ck);
    await event(store, "orders/create", order({ checkout_token: ck.token, shipping_address: ck.shipping_address, customer: ck.customer }));
    await sendDue(store.id);
    expect(sms.sent).toHaveLength(0);
    expect((await jobs(store.id)).find((j) => j.checkoutToken === ck.token)).toMatchObject({ status: "cancelled", reason: "checkout_completed" });
  });

  it("cancels it when consent is withdrawn while it waits, and re-checks consent at send time", async () => {
    const store = await cartSetup();
    const ck = checkout();
    await event(store, "checkouts/create", ck);
    await event(store, "customers_marketing_consent/update", { id: 88, phone: "+61412999888", sms_marketing_consent: { state: "unsubscribed", opt_in_level: "single_opt_in", consent_updated_at: new Date().toISOString(), consent_collected_from: "OTHER" } });
    expect((await jobs(store.id))[0]).toMatchObject({ status: "cancelled", reason: "no_marketing_consent" });
    const history = await systemDb.smsConsentRecord.findMany({ where: { storeId: store.id }, orderBy: { recordedAt: "asc" } });
    expect(history.map((h) => [h.state, h.source])).toEqual([
      ["subscribed", "shopify_checkout"],
      ["unsubscribed", "shopify_customer"],
    ]);
    // An older consent update arriving late changes nothing.
    await event(store, "customers_marketing_consent/update", { id: 88, phone: "+61412999888", sms_marketing_consent: { state: "subscribed", consent_updated_at: new Date(Date.now() - 3600_000).toISOString() } });
    expect((await systemDb.smsContact.findFirstOrThrow({ where: { storeId: store.id } })).consentState).toBe("unsubscribed");
  });

  it("never texts a checkout whose customer didn't agree to marketing (a number is not consent)", async () => {
    const store = await cartSetup();
    await event(store, "checkouts/create", checkout({ customer: { id: 89, first_name: "Al", sms_marketing_consent: { state: "not_subscribed" } } }));
    await event(store, "checkouts/create", checkout({ customer: { id: 90, first_name: "Bo" } }));
    await sendDue(store.id);
    expect(sms.sent).toHaveLength(0);
    expect((await jobs(store.id)).map((j) => j.reason)).toEqual(["no_marketing_consent", "no_marketing_consent"]);
  });

  it("stops marketing at once when the customer uses the opt-out link", async () => {
    const store = await cartSetup();
    const ck = checkout();
    await event(store, "checkouts/create", ck);
    await sendDue(store.id);
    const code = /stop\?c=([A-Za-z0-9]+)/.exec(sms.sent[0]!.body)![1]!;
    expect(await applyOptOut(code, "marketing")).toBe(true);
    const contact = await systemDb.smsContact.findFirstOrThrow({ where: { storeId: store.id } });
    expect(contact).toMatchObject({ suppressedMarketing: true, suppressedAll: false, consentState: "unsubscribed" });
    expect(await systemDb.smsSuppression.findFirstOrThrow({ where: { storeId: store.id } })).toMatchObject({ scope: "marketing", reason: "opt_out_link" });
    // A new checkout from the same number is not reminded.
    await event(store, "checkouts/create", checkout({ customer: { ...ck.customer, sms_marketing_consent: null } }));
    await sendDue(store.id);
    expect(sms.sent).toHaveLength(1);
    expect(await applyOptOut("notarealcode", "all")).toBe(false);
  });
});

describe("the send path", () => {
  async function oneJob(o: StoreOpts = {}, body = "Order {{order_number}} confirmed.") {
    const store = await setupStore(o);
    const t = await approvedTemplate(store, body);
    await activeRule(store, { name: "Confirm", trigger: "order_created", templateId: t.id });
    await event(store, "orders/create", order());
    const [job] = await jobs(store.id);
    queues.clear();
    return { store, job: job! };
  }

  it("claims a text once: two deliveries of the same queue message send it once", async () => {
    const { store, job } = await oneJob();
    const [a, b] = await Promise.all([sendSmsJob(job.id, deps), sendSmsJob(job.id, deps)]);
    expect([a, b].sort()).toEqual(["accepted", "gone"]);
    expect(sms.sent).toHaveLength(1);
    expect((await jobs(store.id))[0]!.attempts).toBe(1);
  });

  it("retries throttling with backoff, and fails after its last attempt", async () => {
    const { job } = await oneJob();
    sms.failNext(new SmsProviderError("ThrottlingException", null, 400, false, "slow down"));
    expect(await sendSmsJob(job.id, deps)).toBe("retry");
    const waiting = await systemDb.smsMessageJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(waiting).toMatchObject({ status: "scheduled", errorCode: "throttled" });
    expect(waiting.sendAfter.getTime()).toBeGreaterThan(Date.now());
    expect(queues.sentOpts.sync.at(-1)?.delaySeconds).toBeGreaterThan(0);
    await systemDb.smsMessageJob.update({ where: { id: job.id }, data: { sendAfter: new Date(), attempts: 5 } });
    sms.failNext(new SmsProviderError("ThrottlingException", null, 400, false, "slow down"));
    expect(await sendSmsJob(job.id, deps)).toBe("failed");
    expect(await systemDb.smsMessageJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: "failed", reason: "too_many_retries" });
  });

  it("never re-sends when AWS may have the text (timeout), and lets AWS's event settle it", async () => {
    const { store, job } = await oneJob();
    sms.failNext(new SmsProviderError("timeout", null, null, false, "no answer"));
    expect(await sendSmsJob(job.id, deps)).toBe("uncertain");
    expect(queues.sent.sync).toHaveLength(0);
    expect(await sendSmsJob(job.id, deps)).toBe("gone");
    expect(sms.sent).toHaveLength(0);
    // AWS had it after all: its event carries our job id and settles the outcome.
    expect(await applySmsEvent(awsEvent("aws-late-1", job.id, store.workspaceId, "DELIVERED", true), deps)).toBe("applied");
    expect(await systemDb.smsMessageJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: "delivered", providerMessageId: "aws-late-1" });
  });

  it("marks a send cut off mid-call uncertain, never sending it again", async () => {
    const { job } = await oneJob();
    await systemDb.smsMessageJob.update({ where: { id: job.id }, data: { status: "sending", claimedAt: new Date(Date.now() - 11 * 60_000) } });
    expect(await settleStuckSends()).toBe(1);
    expect(await systemDb.smsMessageJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: "uncertain", reason: "cut_off" });
  });

  it("records an AWS opt-out and suppresses the number for every later text", async () => {
    const { store, job } = await oneJob();
    sms.failNext(new SmsProviderError("ConflictException", "DESTINATION_PHONE_NUMBER_OPTED_OUT", 400, false, "opted out"));
    expect(await sendSmsJob(job.id, deps)).toBe("opted_out");
    expect(await systemDb.smsSuppression.findFirstOrThrow({ where: { storeId: store.id } })).toMatchObject({ scope: "all", reason: "aws_opt_out" });
    await event(store, "orders/create", order());
    await sendDue(store.id);
    expect(sms.sent).toHaveLength(0);
    expect((await jobs(store.id)).at(-1)).toMatchObject({ status: "skipped", reason: "suppressed" });
  });

  it("holds every text when AWS's monthly spending limit is reached, and raises an alert", async () => {
    const { store, job } = await oneJob();
    sms.failNext(new SmsProviderError("ServiceQuotaExceededException", "MONTHLY_SPEND_LIMIT_REACHED_FOR_TEXT", 400, false, "limit"));
    expect(await sendSmsJob(job.id, deps)).toBe("held");
    expect(await coord.peek(ACCOUNT_HOLD_KEY)).toBe("1");
    const held = await systemDb.smsMessageJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(held.status).toBe("scheduled");
    expect(held.sendAfter.getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);
    expect(await systemDb.alert.findFirst({ where: { storeId: store.id, code: "sms_account_limit" } })).not.toBeNull();
  });

  it("stops at the store's monthly budget (hard stop), and at the platform's ceiling", async () => {
    // 0.05 a part (the price table); a budget of 0.08 fits one text, not two.
    const store = await setupStore({ budget: 0.08 });
    const t = await approvedTemplate(store, "Order {{order_number}} confirmed.");
    await activeRule(store, { name: "Confirm", trigger: "order_created", templateId: t.id });
    await event(store, "orders/create", order());
    await event(store, "orders/create", order({ customer: { id: 5 }, shipping_address: { country_code: "AU", phone: "0412 555 000" } }));
    await sendDue(store.id);
    expect(sms.sent).toHaveLength(1);
    expect((await jobs(store.id)).map((j) => j.status)).toEqual(["accepted", "skipped"]);
    expect((await jobs(store.id))[1]!.reason).toBe("budget_reached");
    setMode({ SMS_ACCOUNT_MONTHLY_LIMIT_USD: "0.01" });
    const other = await setupStore();
    const t2 = await approvedTemplate(other, "Order {{order_number}} confirmed.");
    await activeRule(other, { name: "Confirm", trigger: "order_created", templateId: t2.id });
    await event(other, "orders/create", order());
    await sendDue(other.id);
    expect((await jobs(other.id))[0]).toMatchObject({ status: "skipped", reason: "account_limit" });
  });

  it("keeps the rule's quiet hours (in the customer's zone), and the per-customer daily cap", async () => {
    const hourNow = new Date().getUTCHours();
    const store = await setupStore({ maxPerCustomerDay: 1 });
    const t = await approvedTemplate(store, "Order {{order_number}} confirmed.");
    // Quiet from this hour for two hours; the store is in UTC and Australia has no single zone, so UTC.
    await activeRule(store, { name: "Confirm", trigger: "order_created", templateId: t.id, quietStart: hourNow, quietEnd: (hourNow + 2) % 24 });
    await event(store, "orders/create", order());
    const [job] = await jobs(store.id);
    expect(await sendSmsJob(job!.id, deps)).toBe("later");
    const moved = await systemDb.smsMessageJob.findUniqueOrThrow({ where: { id: job!.id } });
    expect(moved).toMatchObject({ status: "scheduled", reason: "quiet_hours" });
    expect(moved.sendAfter.getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);
    expect(sms.sent).toHaveLength(0);
    // The daily cap: a second rule's text to the same customer the same day is not sent.
    const other = await approvedTemplate(store, "Thanks for order {{order_number}}.");
    await activeRule(store, { name: "Thanks", trigger: "payment_completed", templateId: other.id, quietStart: 0, quietEnd: 0 });
    const t2 = await approvedTemplate(store, "Order {{order_number}} is in!");
    await activeRule(store, { name: "In", trigger: "order_created", templateId: t2.id, quietStart: 0, quietEnd: 0 });
    const o = order({ customer: { id: 31 }, shipping_address: { country_code: "AU", phone: "0412 000 111" } });
    await event(store, "orders/create", o);
    await event(store, "orders/paid", o);
    await sendDue(store.id);
    const sent = (await jobs(store.id)).filter((j) => j.ruleId && j.phoneMasked?.endsWith("111"));
    // The first rule is still in its quiet hours (scheduled); of the other two, one goes and one hits the cap.
    expect(sent.map((j) => j.status).sort()).toEqual(["accepted", "scheduled", "skipped"]);
    expect(sent.find((j) => j.status === "skipped")!.reason).toBe("frequency_cap");
  });

  it("refuses an Indian text that isn't its registered DLT template", async () => {
    const store = await setupStore({ countries: ["IN"], dltEntityId: "1101234567890" });
    const ok = await approvedTemplate(store, "Dear {{customer_name}}, order {{order_number}} is confirmed - {{store_name}}", "transactional", { dltTemplateId: "1107000000000001", dltText: "Dear {#var#}, order {#var#} is confirmed - {#var#}", countries: ["IN"] });
    // Approved before the DLT text changed at the operator: the stored registration no longer matches.
    await systemDb.smsTemplateVersion.updateMany({ where: { templateId: ok.id }, data: { dltText: "Dear {#var#}, your order {#var#} is confirmed - {#var#}" } });
    await activeRule(store, { name: "Confirm", trigger: "order_created", templateId: ok.id }).catch(() => null);
    const rule = await systemDb.smsAutomationRule.findFirstOrThrow({ where: { storeId: store.id } });
    await systemDb.smsAutomationRule.update({ where: { id: rule.id }, data: { status: "active", activeConfig: rule.config as object, activeVersion: rule.version, activeTrigger: "order_created" } });
    await event(store, "orders/create", order({ currency: "INR", shipping_address: { first_name: "Asha", country_code: "IN", phone: "098765 43210" } }));
    await sendDue(store.id);
    expect(sms.sent).toHaveLength(0);
    expect((await jobs(store.id))[0]).toMatchObject({ status: "skipped", reason: "dlt_mismatch" });
    // Matching again: sent with the DLT ids, from India's region.
    await systemDb.smsTemplateVersion.updateMany({ where: { templateId: ok.id }, data: { dltText: "Dear {#var#}, order {#var#} is confirmed - {#var#}" } });
    await event(store, "orders/create", order({ currency: "INR", customer: { id: 9 }, shipping_address: { first_name: "Asha", country_code: "IN", phone: "098765 11111" } }));
    await sendDue(store.id);
    expect(sms.sent).toHaveLength(1);
    expect(sms.sent[0]).toMatchObject({ region: "ap-south-1", dlt: { entityId: "1101234567890", templateId: "1107000000000001" } });
  });

  it("never lets a marketing text go out under the order-update basis, whatever the template was edited to", async () => {
    const store = await setupStore({ basis: "checkout_notice" });
    const promo = await approvedTemplate(store, "{{store_name}}: 10% off this week. Opt out: {{opt_out_url}}", "marketing");
    const contact = await upsertSmsContact(store, { phone: normalizePhone("+61412340000")!, consent: { state: "not_subscribed", source: "shopify_import", updatedAt: new Date(), evidence: {} } });
    // Edited to "transactional" but not approved: the approved (marketing) text and its consent rule still apply.
    await updateTemplate(store, promo.id, { name: promo.name, category: "transactional", body: "Your order is on its way." }, actor);
    expect((await systemDb.smsTemplate.findUniqueOrThrow({ where: { id: promo.id } })).category).toBe("marketing");
    const manual = await sendManualSms(store, promo.id, contact.id, {}, deps, actor);
    expect(manual).toMatchObject({ category: "marketing", status: "skipped", reason: "no_marketing_consent" });
    // A rule approved for order updates whose template is re-approved as marketing stops sending it.
    const t = await approvedTemplate(store, "Order {{order_number}} confirmed.");
    await activeRule(store, { name: "Confirm", trigger: "order_created", templateId: t.id });
    await updateTemplate(store, t.id, { name: t.name, category: "marketing", body: "Order {{order_number}} confirmed. 10% off next time! Opt out: {{opt_out_url}}" }, actor);
    await templateAction(store, t.id, "submit", actor);
    await templateAction(store, t.id, "approve", actor);
    await event(store, "orders/create", order());
    await sendDue(store.id);
    expect(sms.sent).toHaveLength(0);
    expect((await jobs(store.id)).find((j) => j.ruleId)).toMatchObject({ status: "skipped", reason: "template_category_changed" });
  });

  it("records a dry run (with its text) instead of sending, for a rule in dry-run mode and while the platform isn't live", async () => {
    const store = await setupStore();
    const t = await approvedTemplate(store, "Order {{order_number}} confirmed.");
    const rule = await createRule(store, { name: "Confirm", trigger: "order_created", templateId: t.id, ...ANY_HOUR }, actor);
    await ruleAction(store, rule.id, "submit", actor);
    await ruleAction(store, rule.id, "approve", actor);
    const o = order();
    await event(store, "orders/create", o);
    setMode({ SMS_MODE: "sandbox" });
    await event(store, "orders/create", order({ customer: { id: 3 } }));
    await drain();
    expect(sms.sent).toHaveLength(0);
    const all = await jobs(store.id);
    expect(all.map((j) => [j.status, j.reason])).toEqual([
      ["dry_run", "rule_dry_run"],
      ["dry_run", "platform_dry_run"],
    ]);
    expect(all[0]!.bodyEnc).not.toBeNull();
  });
});

describe("delivery events", () => {
  async function sentOne() {
    const store = await setupStore();
    const t = await approvedTemplate(store, "Order {{order_number}} confirmed.");
    await activeRule(store, { name: "Confirm", trigger: "order_created", templateId: t.id });
    await event(store, "orders/create", order());
    await drain();
    const [job] = await jobs(store.id);
    return { store, job: job!, messageId: job!.providerMessageId! };
  }

  it("moves a text to delivered on AWS's event, records the price once, and ignores a replay", async () => {
    const { store, job, messageId } = await sentOne();
    await queues.smsEvents.send(awsEvent(messageId, job.id, store.workspaceId, "PENDING", false, { totalMessagePrice: undefined }));
    await queues.smsEvents.send(awsEvent(messageId, job.id, store.workspaceId, "DELIVERED", true));
    await drain();
    const replay = awsEvent(messageId, job.id, store.workspaceId, "DELIVERED", true);
    expect(await applySmsEvent(replay, deps)).toBe("applied");
    expect(await applySmsEvent(replay, deps)).toBe("duplicate");
    const done = await systemDb.smsMessageJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(done).toMatchObject({ status: "delivered", providerStatus: "DELIVERED", partsBilled: 1 });
    expect(Number(done.priceUsd)).toBeCloseTo(0.0412, 6);
    expect(await systemDb.smsCostRecord.count({ where: { jobId: job.id } })).toBe(1);
    expect(await systemDb.smsDeliveryEvent.count({ where: { jobId: job.id } })).toBe(3);
  });

  it("never lets a late interim event undo a final one", async () => {
    const { store, job, messageId } = await sentOne();
    await applySmsEvent(awsEvent(messageId, job.id, store.workspaceId, "DELIVERED", true, { eventTimestamp: Date.now() }), deps);
    await applySmsEvent(awsEvent(messageId, job.id, store.workspaceId, "PENDING", false, { eventTimestamp: Date.now() - 5000 }), deps);
    expect((await systemDb.smsMessageJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("delivered");
  });

  it("fails a text the carrier refused, and keeps an invalid number off the list until the merchant lifts it", async () => {
    const { store, job, messageId } = await sentOne();
    await applySmsEvent(awsEvent(messageId, job.id, store.workspaceId, "INVALID", true), deps);
    expect(await systemDb.smsMessageJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: "failed", errorCode: "invalid" });
    expect(await systemDb.smsSuppression.findFirstOrThrow({ where: { storeId: store.id } })).toMatchObject({ reason: "invalid_number", scope: "all" });
  });

  it("ignores events that name another workspace or no message of ours, and waits for one that raced its send", async () => {
    const { store, job, messageId } = await sentOne();
    // The context names our job but another workspace: matched by message id only, which is ours, so it applies.
    expect(await applySmsEvent(awsEvent(messageId, job.id, "other-ws", "DELIVERED", true), deps)).toBe("applied");
    expect(await applySmsEvent(awsEvent("not-ours", "no-such-job", store.workspaceId, "DELIVERED", true, { messageRequestTimestamp: Date.now() - 3600_000 }), deps)).toBe("unknown_message");
    await expect(applySmsEvent(awsEvent("racing", "no-such-job-yet", store.workspaceId, "DELIVERED", true), deps)).rejects.toThrow(/before its message/);
    expect(await applySmsEvent({ hello: "world" }, deps)).toBe("ignored");
  });

  it("marks texts AWS never reported on after 74 hours as unknown", async () => {
    const { store, job } = await sentOne();
    await systemDb.smsMessageJob.update({ where: { id: job.id }, data: { acceptedAt: new Date(Date.now() - 75 * 3600_000) } });
    await sweepSms(deps);
    expect(await systemDb.smsMessageJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: "unknown", reason: "no_final_event" });
    expect(store).toBeTruthy();
  });

  it("raises the 50% and 80% budget alerts once each", async () => {
    const store = await setupStore({ budget: 0.1 });
    const t = await approvedTemplate(store, "Order {{order_number}} confirmed.");
    await activeRule(store, { name: "Confirm", trigger: "order_created", templateId: t.id });
    await event(store, "orders/create", order());
    await drain();
    const [job] = await jobs(store.id);
    await applySmsEvent(awsEvent(job!.providerMessageId!, job!.id, store.workspaceId, "DELIVERED", true, { totalMessagePrice: 0.085 }), deps);
    const codes = (await systemDb.alert.findMany({ where: { storeId: store.id } })).map((a) => a.code).sort();
    expect(codes).toEqual(["sms_budget_50", "sms_budget_80"]);
    const sender = await systemDb.smsSenderConfiguration.findUniqueOrThrow({ where: { storeId: store.id } });
    expect((sender.budgetAlerts as { levels: number[] }).levels).toEqual([50, 80]);
  });
});

describe("opt-out lists and campaigns", () => {
  it("copies AWS's opt-out list onto the suppression list of stores texting through it", async () => {
    const store = await setupStore();
    sms.optOuts.push({ e164: "+61400000001", at: new Date() });
    const r = await sweepSms(deps);
    expect(r.optOuts).toBe(1);
    const s = await systemDb.smsSuppression.findFirstOrThrow({ where: { storeId: store.id } });
    expect(s).toMatchObject({ reason: "aws_opt_out", scope: "all" });
    // The same list read again adds nothing.
    coord.clear();
    expect((await sweepSms(deps)).optOuts).toBe(0);
  });

  // 320 contacts and 300 texts, one at a time against real Postgres: 7-11 s on an idle PC, past the
  // 20 s default when the PC runner is busy (several test databases at once), so it gets its own limit.
  it("sends a 300-customer campaign once each, to subscribed customers only, paced and attributed", async () => {
    const store = await setupStore({ budget: 100 });
    const t = await approvedTemplate(store, "{{store_name}}: 20% off today with {{discount_code}}. Opt out: {{opt_out_url}}", "marketing");
    for (let i = 0; i < 320; i++) {
      const phone = normalizePhone(`+614${String(10_000_000 + i).padStart(8, "0")}`)!;
      await upsertSmsContact(store, { phone, firstName: "C", consent: i < 300 ? { state: "subscribed", source: "shopify_import", updatedAt: new Date(Date.now() - 86400_000), evidence: {} } : { state: "not_subscribed", source: "shopify_import", updatedAt: new Date(), evidence: {} } });
    }
    const c = await saveCampaign(store, null, { name: "Spring", templateId: t.id, discountCode: "SPRING20", filter: { countries: ["AU"] } }, actor);
    await campaignAction(store, c.id, "submit", actor);
    await campaignAction(store, c.id, "approve", actor);
    await expect(campaignAction(store, c.id, "schedule", actor, { confirmRecipients: 299 })).rejects.toThrow(/300/);
    await campaignAction(store, c.id, "schedule", actor, { confirmRecipients: 300 });
    expect(await startDueCampaigns(deps)).toBe(1);
    expect(await startDueCampaigns(deps)).toBe(0);
    const created = await systemDb.smsMessageJob.findMany({ where: { campaignId: c.id }, orderBy: { sendAfter: "asc" } });
    expect(created).toHaveLength(300);
    // Paced: each text a little after the one before (here 1000 parts a second).
    expect(created.at(-1)!.sendAfter.getTime()).toBeGreaterThan(created[0]!.sendAfter.getTime());
    await sendDue(store.id);
    // The same queue message twice sends nothing more.
    for (const j of created.slice(0, 5)) expect(await sendSmsJob(j.id, deps)).toBe("gone");
    expect(sms.sent).toHaveLength(300);
    expect(new Set(sms.sent.map((s) => s.destination)).size).toBe(300);
    expect(sms.sent.every((s) => s.messageType === "PROMOTIONAL" && s.body.includes("SPRING20"))).toBe(true);
    // An order from a texted customer within the window is credited to the campaign once.
    const first = sms.sent[0]!;
    const local = `0${first.destination.slice(3)}`;
    await event(store, "orders/create", order({ shipping_address: { country_code: "AU", phone: local }, customer: { id: 4242 }, total_price: "150.00" }));
    const credited = await systemDb.smsMessageJob.findMany({ where: { campaignId: c.id, attributedOrderId: { not: null } } });
    expect(credited).toHaveLength(1);
    expect(Number(credited[0]!.attributedRevenue)).toBe(150);
  }, 60_000);

  it("refuses to schedule a campaign while marketing is switched off, or beyond the budget", async () => {
    const store = await setupStore({ budget: 0.01 });
    const t = await approvedTemplate(store, "{{store_name}} sale. Opt out: {{opt_out_url}}", "marketing");
    await upsertSmsContact(store, { phone: normalizePhone("+61411111111")!, consent: { state: "subscribed", source: "shopify_import", updatedAt: new Date(), evidence: {} } });
    const c = await saveCampaign(store, null, { name: "S", templateId: t.id, filter: { countries: [] } }, actor);
    await campaignAction(store, c.id, "submit", actor);
    await campaignAction(store, c.id, "approve", actor);
    setMode({ SMS_MARKETING_ENABLED: "" });
    await expect(campaignAction(store, c.id, "schedule", actor, { confirmRecipients: 1 })).rejects.toThrow(/switched on/);
    setMode({ SMS_MARKETING_ENABLED: "1" });
    await expect(campaignAction(store, c.id, "schedule", actor, { confirmRecipients: 1 })).rejects.toThrow(/budget/);
  });

  it("generates opt-out codes that only hash to their own message", () => {
    const a = newOptOutCode();
    const b = newOptOutCode();
    expect(a.code).toMatch(/^[A-Za-z0-9]{10}$/);
    expect(a.code).not.toBe(b.code);
    expect(a.hash).toBe(sha256Hex(a.code));
  });
});

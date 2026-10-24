import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { systemDb } from "@app/db";
import { emailOnShopifyEvent, processBusinessEvent, type FetchLike } from "@app/core";
import { fakeSmsProvider, smsOnShopifyEvent, type FakeSmsProvider } from "@app/core/sms";
import { decodeCursor } from "@app/core/automations";
import { LEGACY_GRANTS } from "@app/shared";
import { clean, createStore, createWorkspace, setup, signIn, teardown, type TestCtx } from "./helpers.js";
import { dohResponse, fakeSmtp, isDoh, type FakeSmtp } from "../../../test-support/emailFakes.js";

/**
 * The Automations hub (apps/api/src/routes/automations.ts): one four-step setup and one history
 * over Customer Messaging's SMS and the email module. Who may see and change what (tenancy, each
 * channel's own permissions, API keys refused), the four steps for each channel ending in the
 * channel's own rows, controls that only move an automation the way its status allows, the merged
 * history (paging, filters, statuses that tell "accepted" from "delivered"), retries, the figures
 * and the audit trail. Real Postgres; AWS and the SMTP server are faked.
 */

let ctx: TestCtx;
let sms: FakeSmsProvider;
let smtp: FakeSmtp;

beforeAll(async () => {
  ctx = await setup();
  sms = fakeSmsProvider();
  (ctx.deps as { sms?: FakeSmsProvider }).sms = sms;
});
afterAll(async () => {
  ctx.setEnv({ SMS_MODE: "off", SMS_MARKETING_ENABLED: "" });
  await teardown(ctx);
});
beforeEach(async () => {
  await clean(ctx);
  sms.clear();
  sms.identities.clear();
  ctx.setEnv({ SMS_MODE: "sandbox", SMS_MARKETING_ENABLED: "", SMS_SHARED_SENDER: "" });
  smtp = fakeSmtp();
  ctx.deps.smtpConnect = smtp.connect;
  const dns = { "smtp.shopmail.com|A": ["93.184.216.34"] };
  ctx.setFetch((async (input) => {
    const url = new URL(String(input));
    if (isDoh(url)) return dohResponse(url, dns);
    throw new Error(`unexpected fetch ${url}`);
  }) as FetchLike);
});

async function owner(uid = "u1", email = "o@shop.test", extra: Record<string, unknown> = {}) {
  const s = await signIn(ctx, uid, email);
  const ws = await createWorkspace(ctx, s.headers);
  const store = await createStore(ws, `${uid}.myshopify.com`, ["read_orders"], { name: "Green Leaf", currency: "AUD", ...extra });
  const q = `storeId=${store.id}`;
  const call = (method: "GET" | "POST" | "PUT" | "DELETE", path: string, payload?: unknown, headers: Record<string, string> = s.headers) =>
    ctx.app.inject({ method, url: `/workspaces/${ws}/automations${path}${path.includes("?") ? "&" : "?"}${q}`, headers, ...(payload === undefined ? {} : { payload }) });
  return { ...s, ws, store, call };
}

type Owner = Awaited<ReturnType<typeof owner>>;

const shipped = { name: "Shipping update", trigger: "fulfillment_created", body: "Hi {{customer_name}}, order {{order_number}} is on its way: {{tracking_url}}", delayMinutes: 0, conditions: [] };

/** An SMTP mailbox with its address verified as a sender (the email module's own tests cover verifying it). */
async function mailbox(o: Owner) {
  const res = await ctx.app.inject({
    method: "POST",
    url: `/workspaces/${o.ws}/email/smtp/connections`,
    headers: o.headers,
    payload: { emailAddress: "billing@shopmail.com", displayName: "Billing", host: "smtp.shopmail.com", port: 587, encryption: "starttls", username: "billing@shopmail.com", password: "right-password" },
  });
  expect(res.statusCode, res.body).toBe(200);
  await systemDb.emailSenderIdentity.updateMany({ where: { workspaceId: o.ws }, data: { authorizationStatus: "verified", verifiedAt: new Date(), isDefault: true } });
  return (await systemDb.emailSenderIdentity.findFirstOrThrow({ where: { workspaceId: o.ws } })).id;
}

/** A verified SMS sender for the store, sending on (what Set up SMS leaves behind). */
async function smsSender(o: Owner) {
  sms.identities.set("GREENLEAF", { kind: "sender_id", arn: "arn:aws:sms-voice:ap-southeast-2:1:sender-id/GREENLEAF/AU", id: "GREENLEAF", label: "GREENLEAF", country: "AU", status: "REGISTERED", twoWay: false, optOutList: "Default", registrationStatus: "COMPLETE", tags: { "bizinsights:workspace": o.ws } });
  const base = `/workspaces/${o.ws}/stores/${o.store.id}/sms`;
  const put = await ctx.app.inject({ method: "PUT", url: `${base}/sender`, headers: o.headers, payload: { senderType: "sender_id", originationIdentity: "GREENLEAF", countries: ["AU"], monthlyBudgetUsd: 25, hardStop: true, transactionalBasis: "checkout_notice", quietStart: 0, quietEnd: 0, maxPerCustomerDay: 3, maxMarketingPerWeek: 2 } });
  expect(put.statusCode, put.body).toBe(200);
  expect((await ctx.app.inject({ method: "POST", url: `${base}/sender/verify`, headers: o.headers })).json().sender.identityCheck).toBe("verified");
}

const thanks = (senderIdentityId: string) => ({
  name: "Payment thanks",
  trigger: "payment_confirmed",
  senderIdentityId,
  subject: "Thanks for order {{order.id}}",
  text: "Hi {{customer.first_name | default: \"there\"}},\n\nWe've received your payment.",
  delayMinutes: 0,
});

describe("who may see and change what", () => {
  it("keeps every workspace's automations, messages and stores to itself", async () => {
    const a = await owner();
    const made = await a.call("POST", "/items/sms", shipped);
    expect(made.statusCode, made.body).toBe(201);
    const id = made.json().automation.id;
    const senderId = await mailbox(a);
    const mail = (await a.call("POST", "/items/email", thanks(senderId))).json().automation.id;

    const b = await owner("u2", "b@other.test");
    // A member of another workspace: 404 for everything of A's, as if it didn't exist.
    for (const path of ["", "/triggers", "/messages", `/items/sms/${id}`, `/items/email/${mail}`, "/stats"]) {
      const res = await ctx.app.inject({ method: "GET", url: `/workspaces/${a.ws}/automations${path}`, headers: b.headers });
      expect(res.statusCode, path).toBe(404);
    }
    // B naming A's store under its own workspace: not found. A's automations through B's own workspace and store: not found.
    expect((await ctx.app.inject({ method: "GET", url: `/workspaces/${b.ws}/automations?storeId=${a.store.id}`, headers: b.headers })).statusCode).toBe(404);
    expect((await b.call("GET", `/items/sms/${id}`)).statusCode).toBe(404);
    expect((await b.call("POST", `/items/sms/${id}/activate`, { confirm: true })).statusCode).toBe(404);
    expect((await b.call("DELETE", `/items/email/${mail}`)).statusCode).toBe(404);
    expect((await b.call("GET", "")).json().automations).toEqual([]);
    // Nothing of A's changed.
    expect((await systemDb.smsAutomationRule.findUniqueOrThrow({ where: { id } })).status).toBe("draft");
    expect((await systemDb.emailAutomationRule.findUniqueOrThrow({ where: { id: mail } })).deletedAt).toBeNull();
  });

  it("gives each member exactly their channels' permissions, and refuses API keys", async () => {
    const o = await owner();
    const id = (await o.call("POST", "/items/sms", shipped)).json().automation.id;
    // A campaigns-only member: SMS to look at, no email, no changes.
    const m = await signIn(ctx, "m", "m@shop.test");
    await systemDb.membership.create({ data: { workspaceId: o.ws, userId: m.user.id, role: "viewer", permissions: ["marketing.campaigns"] } });
    const seen = await o.call("GET", "", undefined, m.headers);
    expect(seen.statusCode).toBe(200);
    expect(seen.json().permissions).toMatchObject({ read: { sms: true, email: false }, manage: { sms: false, email: false }, connect: { sms: false, email: false }, contacts: false });
    expect(seen.json().automations.map((a: { id: string }) => a.id)).toEqual([id]);
    expect(seen.json().automations[0].actions).toEqual([]);
    for (const [method, path] of [
      ["POST", "/items/sms"],
      ["PUT", `/items/sms/${id}`],
      ["POST", `/items/sms/${id}/activate`],
      ["DELETE", `/items/sms/${id}`],
      ["POST", "/connections/sms/connect"],
      ["POST", "/items/email"],
    ] as const) {
      expect((await o.call(method, path, method === "DELETE" ? undefined : { ...shipped, confirm: true }, m.headers)).statusCode, `${method} ${path}`).toBe(403);
    }
    // No access to either channel: not let in at all.
    const none = await signIn(ctx, "n", "n@shop.test");
    await systemDb.membership.create({ data: { workspaceId: o.ws, userId: none.user.id, role: "viewer", permissions: ["reports.view"] } });
    expect((await o.call("GET", "", undefined, none.headers)).statusCode).toBe(403);
    // The audit trail is the owners' and admins'.
    expect((await o.call("GET", "/audit", undefined, m.headers)).statusCode).toBe(403);
    // A workspace API key never reaches the hub.
    const key = (await ctx.app.inject({ method: "POST", url: `/workspaces/${o.ws}/api-keys`, headers: o.headers, payload: { name: "BI" } })).json().secret as string;
    expect((await o.call("GET", "", undefined, { authorization: `Bearer ${key}` })).statusCode).toBe(403);
  });
});

describe("step 1: connections", () => {
  it("shows each channel's real state and connects SMS through AWS without any keys", async () => {
    const o = await owner();
    const first = (await o.call("GET", "/connections")).json().connections as Array<{ channel: string; state: string; actions: string[] }>;
    expect(first.map((c) => c.channel)).toEqual(["whatsapp", "sms", "email"]);
    expect(first.find((c) => c.channel === "whatsapp")).toMatchObject({ state: "elsewhere", actions: [] });
    expect(first.find((c) => c.channel === "sms")).toMatchObject({ state: "not_connected", actions: ["connect"] });
    expect(first.find((c) => c.channel === "email")).toMatchObject({ state: "not_connected", actions: ["connect"] });

    const on = await o.call("POST", "/connections/sms/connect", {});
    expect(on.statusCode, on.body).toBe(200);
    // Connected to AWS, but no sender yet: what stops texts is said, with where to fix it.
    expect(on.json().connection).toMatchObject({ state: "needs_attention", mode: "sandbox", actions: ["test", "disconnect"] });
    expect(on.json().connection.problems.map((p: { code: string }) => p.code)).toEqual(expect.arrayContaining(["no_sender", "test_mode"]));
    const off = await o.call("POST", "/connections/sms/disconnect", {});
    expect(off.json().connection).toMatchObject({ state: "not_connected", actions: ["reconnect"] });

    // AWS not answering is a failed connection, never a pretend success.
    const account = sms.account;
    sms.account = async () => {
      throw new Error("connect ETIMEDOUT");
    };
    const failed = (await o.call("POST", "/connections/sms/test", {})).json().connection;
    sms.account = account;
    expect(failed).toMatchObject({ state: "needs_attention", actions: ["reconnect"] });
    expect(failed.problems[0]).toMatchObject({ code: "connection_failed" });

    // Email: a connected mailbox with a verified sender can send.
    await mailbox(o);
    const email = (await o.call("GET", "/connections")).json().connections.find((c: { channel: string }) => c.channel === "email");
    expect(email).toMatchObject({ state: "connected", accounts: [{ label: "billing@shopmail.com", canSend: true }] });
    const test = await o.call("POST", `/connections/email/${email.accounts[0].id}/test`, {});
    expect(test.json()).toMatchObject({ ok: true });
  });
});

describe("step 2: triggers", () => {
  it("offers a trigger per channel only where it really arrives, and says why not otherwise", async () => {
    const o = await owner();
    const t = (await o.call("GET", "/triggers")).json().triggers as Array<{ key: string; channels: Record<string, { state: string; reason: string | null }> }>;
    const of = (key: string) => t.find((x) => x.key === key)!.channels;
    expect(of("order_created")).toMatchObject({ sms: { state: "ready" }, email: { state: "ready" }, whatsapp: { state: "unavailable" } });
    expect(of("payment_confirmed")).toMatchObject({ sms: { state: "ready" }, email: { state: "ready" } });
    expect(of("customer_signup")).toMatchObject({ sms: { state: "needs_setup" }, email: { state: "unavailable", reason: expect.stringMatching(/new-customer/) } });
    expect(of("external_event")).toMatchObject({ sms: { state: "unavailable" }, email: { state: "ready" } });
    expect(of("scheduled_message").sms).toMatchObject({ state: "unavailable", reason: expect.stringMatching(/campaign/) });
    expect(of("inbound_message")).toMatchObject({ sms: { state: "unavailable" }, email: { state: "unavailable" } });
    expect(t.find((x) => x.key === "scheduled_message")).toMatchObject({ instead: { href: "/messaging/campaigns" } });

    // A store connected through the App Store app gets no order events from Shopify yet: neither channel can use them.
    const listed = await owner("u3", "o3@shop.test", { shopifyAppKey: "appstore" });
    const l = (await listed.call("GET", "/triggers")).json().triggers.find((x: { key: string }) => x.key === "order_created").channels;
    expect(l.sms.state).toBe("unavailable");
    expect(l.email).toMatchObject({ state: "unavailable", reason: expect.stringMatching(/App Store app/) });
  });
});

describe("steps 3 and 4: SMS through the hub", () => {
  it("saves into Customer Messaging's own rule and template, and only moves the way its status allows", async () => {
    const o = await owner();
    const bad = await o.call("POST", "/items/sms", { ...shipped, trigger: "order_created" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: "message_invalid", message: expect.stringMatching(/tracking link/) });

    const made = (await o.call("POST", "/items/sms", shipped)).json().automation;
    expect(made).toMatchObject({ channel: "sms", trigger: "order_fulfilled", channelTrigger: "fulfillment_created", status: "draft", actions: ["activate"], editable: true });
    const rule = await systemDb.smsAutomationRule.findUniqueOrThrow({ where: { id: made.id } });
    expect(rule).toMatchObject({ storeId: o.store.id, status: "draft" });

    expect((await o.call("POST", `/items/sms/${made.id}/activate`, {})).json().error).toBe("confirm_required");
    expect((await o.call("POST", `/items/sms/${made.id}/pause`, {})).json().error).toBe("automation_state");
    const on = (await o.call("POST", `/items/sms/${made.id}/activate`, { confirm: true })).json().automation;
    expect(on).toMatchObject({ status: "active", actions: ["pause", "disable"] });
    // Turning on twice changes nothing more (no second approval, no duplicate).
    expect((await o.call("POST", `/items/sms/${made.id}/activate`, { confirm: true })).json().error).toBe("automation_state");
    expect((await o.call("POST", `/items/sms/${made.id}/pause`, {})).json().automation.status).toBe("paused");
    expect((await o.call("POST", `/items/sms/${made.id}/resume`, { confirm: true })).json().automation.status).toBe("active");
    expect((await o.call("POST", `/items/sms/${made.id}/disable`, {})).json().automation).toMatchObject({ status: "disabled", actions: ["activate"] });

    // Edited in the hub: the same rule changes, nothing new is made.
    const edited = (await o.call("PUT", `/items/sms/${made.id}`, { ...shipped, name: "Shipped!", delayMinutes: 15 })).json().automation;
    expect(edited).toMatchObject({ id: made.id, name: "Shipped!", delayMinutes: 15 });
    expect(await systemDb.smsAutomationRule.count({ where: { storeId: o.store.id } })).toBe(1);

    const gone = await o.call("DELETE", `/items/sms/${made.id}`);
    expect(gone.statusCode).toBe(200);
    expect(await systemDb.smsAutomationRule.count({ where: { id: made.id } })).toBe(0);
    expect((await o.call("GET", `/items/sms/${made.id}`)).statusCode).toBe(404);
    // WhatsApp isn't built here.
    expect((await o.call("POST", "/items/whatsapp", shipped)).json().error).toBe("channel_elsewhere");
  });
});

describe("steps 3 and 4: email through the hub", () => {
  it("writes the message as the automation's own template, checks it for its event, and switches the email module's rule", async () => {
    const o = await owner();
    const senderId = await mailbox(o);
    const unknown = await o.call("POST", "/items/email", { ...thanks(senderId), text: "Your parcel: {{order.tracking_number}}" });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toMatchObject({ error: "message_invalid", message: expect.stringMatching(/order\.tracking_number/) });
    const noEvent = await o.call("POST", "/items/email", { ...thanks(senderId), trigger: "customer_signup" });
    expect(noEvent.statusCode).toBe(400);

    const preview = (await o.call("POST", "/preview/email", { trigger: "payment_confirmed", subject: "Thanks for order {{order.id}}", text: "Hi {{customer.first_name}}" })).json();
    expect(preview.preview).toMatchObject({ subject: "Thanks for order #1001", text: expect.stringContaining("Hi Alex") });

    const made = (await o.call("POST", "/items/email", thanks(senderId))).json().automation;
    expect(made).toMatchObject({ channel: "email", trigger: "payment_confirmed", channelTrigger: "order.paid", status: "draft", editable: true, storeId: o.store.id, subject: "Thanks for order {{order.id}}" });
    const rule = await systemDb.emailAutomationRule.findUniqueOrThrow({ where: { id: made.id } });
    const template = await systemDb.emailTemplate.findUniqueOrThrow({ where: { id: rule.templateId } });
    expect(rule).toMatchObject({ eventType: "order.paid", enabled: false, storeId: o.store.id });
    expect(template).toMatchObject({ status: "active", category: "transactional", eventType: "order.paid", htmlTemplate: expect.stringContaining("<p>We&#39;ve received your payment.</p>") });

    expect((await o.call("POST", `/items/email/${made.id}/activate`, {})).json().error).toBe("confirm_required");
    expect((await o.call("POST", `/items/email/${made.id}/activate`, { confirm: true })).json().automation).toMatchObject({ status: "active", actions: ["pause"] });
    expect((await systemDb.emailAutomationRule.findUniqueOrThrow({ where: { id: made.id } })).enabled).toBe(true);
    // Off after having been on reads "Paused", not "Draft".
    expect((await o.call("POST", `/items/email/${made.id}/pause`, {})).json().automation).toMatchObject({ status: "paused", actions: ["resume"] });
    expect((await o.call("POST", `/items/email/${made.id}/disable`, {})).json().error).toBe("automation_state");

    // An edit keeps the same rule and template (a new version of it).
    await o.call("PUT", `/items/email/${made.id}`, { ...thanks(senderId), subject: "Paid: {{order.id}}" });
    const after = await systemDb.emailTemplate.findUniqueOrThrow({ where: { id: rule.templateId } });
    expect(after).toMatchObject({ subjectTemplate: "Paid: {{order.id}}", version: 2 });

    // The business's own event, from its system through the event API.
    const custom = (await o.call("POST", "/items/email", { ...thanks(senderId), name: "Booked", trigger: "external_event", customEvent: "appointment.booked", subject: "See you soon", text: "Hi {{customer.first_name}}, booking {{data.reference}} is confirmed." })).json().automation;
    expect(custom).toMatchObject({ trigger: "external_event", channelTrigger: "appointment.booked", storeId: null });
    expect((await o.call("POST", "/items/email", { ...thanks(senderId), trigger: "external_event", customEvent: "order.lost" })).statusCode).toBe(400);

    // Deleting removes the rule and archives the template it wrote.
    await o.call("DELETE", `/items/email/${made.id}`);
    expect((await systemDb.emailAutomationRule.findUniqueOrThrow({ where: { id: made.id } })).deletedAt).not.toBeNull();
    expect((await systemDb.emailTemplate.findUniqueOrThrow({ where: { id: rule.templateId } })).status).toBe("archived");
  });

  it("sends the test to the member's own address only", async () => {
    const o = await owner();
    const id = (await o.call("POST", "/items/email", thanks(await mailbox(o)))).json().automation.id;
    const sent = await o.call("POST", `/items/email/${id}/test`, {});
    expect(sent.statusCode, sent.body).toBe(200);
    expect(sent.json().message).toMatchObject({ channel: "email", kind: "test", status: "sent", subject: "[Test] Thanks for order #1001" });
    expect(smtp.delivered.at(-1)!.to).toBe("o@shop.test");
  });
});

describe("events through both engines", () => {
  it("one order, delivered twice by Shopify, is one text and one email in the history", async () => {
    const o = await owner();
    await o.call("POST", "/connections/sms/connect", {});
    await smsSender(o);
    const smsId = (await o.call("POST", "/items/sms", { name: "Paid", trigger: "payment_completed", body: "Thanks {{customer_name}}, we got your payment for {{order_number}}.", delayMinutes: 0, conditions: [] })).json().automation.id;
    await o.call("POST", `/items/sms/${smsId}/activate`, { confirm: true });
    const mailId = (await o.call("POST", "/items/email", thanks(await mailbox(o)))).json().automation.id;
    await o.call("POST", `/items/email/${mailId}/activate`, { confirm: true });

    const order = { id: 701, name: "#1701", email: "pat@example.com", currency: "AUD", financial_status: "paid", created_at: new Date().toISOString(), total_price: "40.00", customer: { id: 9, first_name: "Pat", email: "pat@example.com" }, shipping_address: { country_code: "AU", phone: "0412 345 678" }, line_items: [] };
    for (let i = 0; i < 2; i++) {
      await smsOnShopifyEvent(o.store, "orders/paid", order, ctx.deps);
      await emailOnShopifyEvent(o.store, "orders/paid", order, ctx.deps);
    }
    for (const ev of await systemDb.emailBusinessEvent.findMany({ where: { workspaceId: o.ws } })) await processBusinessEvent(ev.id, { ...ctx.deps, smtpConnect: smtp.connect });

    const h = (await o.call("GET", "/messages")).json();
    expect(h.messages.filter((m: { channel: string }) => m.channel === "sms")).toHaveLength(1);
    expect(h.messages.filter((m: { channel: string }) => m.channel === "email")).toHaveLength(1);
    expect(h.messages.find((m: { channel: string }) => m.channel === "sms")).toMatchObject({ automation: { id: smsId, name: "Paid" }, kind: "automation" });
    expect(h.messages.find((m: { channel: string }) => m.channel === "email")).toMatchObject({ automation: { id: mailId, name: "Payment thanks" }, status: "queued" });
  });
});

describe("the history", () => {
  async function seed(o: Owner) {
    const senderId = await mailbox(o);
    const sender = await systemDb.emailSenderIdentity.findUniqueOrThrow({ where: { id: senderId } });
    const at = (s: number) => new Date(Date.UTC(2026, 9, 20, 12, 0, s));
    const job = (id: string, s: number, status: string, extra: Record<string, unknown> = {}) =>
      systemDb.smsMessageJob.create({ data: { id, workspaceId: o.ws, storeId: o.store.id, dedupeKey: `k:${id}`, purpose: "automation", category: "transactional", status, sendAfter: at(s), createdAt: at(s), phoneMasked: "+61 4•• ••• 678", ...extra } });
    const mail = (id: string, s: number, status: string, extra: Record<string, unknown> = {}) =>
      systemDb.emailMessage.create({
        data: { id, workspaceId: o.ws, emailAccountId: sender.emailAccountId, senderIdentityId: senderId, kind: "automation", provider: "smtp", senderAddress: "billing@shopmail.com", recipientEnc: "x", recipientHash: `h${id}`, recipientMasked: "p••@example.com", subject: `S ${id}`, idempotencyKey: `i:${id}`, internetMessageId: `m${id}@test`, status, scheduledAt: at(s), createdAt: at(s), ...extra },
      });
    await job("s1", 1, "delivered", { acceptedAt: at(1), priceUsd: 0.05, carrierFeeUsd: 0.01 });
    await job("s2", 3, "failed", { acceptedAt: at(3), providerStatus: "BLOCKED" });
    await job("s3", 3, "failed", { reason: "too_many_retries" });
    await job("s4", 5, "accepted", { acceptedAt: at(5) });
    await job("s5", 6, "dry_run");
    await mail("e1", 2, "accepted_by_provider", { providerAcceptedAt: at(2) });
    await mail("e2", 3, "failed", { lastErrorCode: "auth_failed" });
    await mail("e3", 4, "bounced");
    await mail("e4", 6, "unknown");
    return { from: "2026-10-20", to: "2026-10-20" };
  }

  it("merges both channels newest first and pages without losing or repeating a message", async () => {
    const o = await owner();
    const r = await seed(o);
    const all = (await o.call("GET", `/messages?from=${r.from}&to=${r.to}&limit=100`)).json().messages.map((m: { channel: string; id: string }) => m.id);
    // Same instant: SMS before email; within a channel, its own order.
    expect(all).toEqual(["s5", "e4", "s4", "e3", "s3", "s2", "e2", "e1", "s1"]);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const page: { messages: Array<{ id: string }>; nextCursor: string | null } = (await o.call("GET", `/messages?from=${r.from}&to=${r.to}&limit=2${cursor ? `&cursor=${cursor}` : ""}`)).json();
      seen.push(...page.messages.map((m) => m.id));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toEqual(all);
    expect(decodeCursor("not a cursor")).toBeNull();
    expect((await o.call("GET", "/messages?cursor=bm9wZQ")).json().error).toBe("invalid_cursor");
  });

  it("tells accepted from delivered, and a carrier's refusal from a failure to send", async () => {
    const o = await owner();
    const r = await seed(o);
    const list = (await o.call("GET", `/messages?from=${r.from}&to=${r.to}`)).json().messages as Array<{ id: string; status: string; reason: string | null; costUsd: number | null; to: string | null }>;
    const by = Object.fromEntries(list.map((m) => [m.id, m])) as Record<string, (typeof list)[number]>;
    expect(by.s1).toMatchObject({ status: "delivered", costUsd: expect.closeTo(0.06, 6), to: "+61 4•• ••• 678" });
    expect(by.s2).toMatchObject({ status: "undelivered" });
    expect(by.s3).toMatchObject({ status: "failed", reason: expect.any(String) });
    expect(by.s4!.status).toBe("sent");
    expect(by.s5!.status).toBe("test_only");
    expect(by.e1!.status).toBe("sent");
    expect(by.e3!.status).toBe("undelivered");
    expect(by.e4!.status).toBe("unknown");

    const failed = (await o.call("GET", `/messages?from=${r.from}&to=${r.to}&status=failed`)).json().messages.map((m: { id: string }) => m.id);
    expect(failed.sort()).toEqual(["e2", "s3"]);
    const undelivered = (await o.call("GET", `/messages?from=${r.from}&to=${r.to}&status=undelivered&channel=sms`)).json().messages.map((m: { id: string }) => m.id);
    expect(undelivered).toEqual(["s2"]);

    // A member without "View contact information" sees statuses, not numbers or addresses.
    const m = await signIn(ctx, "m2", "m2@shop.test");
    await systemDb.membership.create({ data: { workspaceId: o.ws, userId: m.user.id, role: "viewer", permissions: [...LEGACY_GRANTS.viewer, "marketing.campaigns"] } });
    const theirs = (await o.call("GET", `/messages?from=${r.from}&to=${r.to}`, undefined, m.headers)).json();
    expect(theirs.visible).toEqual({ sms: true, email: false });
    expect(theirs.messages.every((x: { channel: string; to: string | null }) => x.channel === "sms" && x.to === null)).toBe(true);
  });

  it("retries a failed email once, by hand, and never re-sends a text", async () => {
    const o = await owner();
    const r = await seed(o);
    const list = (await o.call("GET", `/messages?from=${r.from}&to=${r.to}`)).json().messages as Array<{ id: string; retryable: boolean; retryNote: string | null }>;
    expect(list.find((m) => m.id === "e2")).toMatchObject({ retryable: true });
    expect(list.find((m) => m.id === "s3")).toMatchObject({ retryable: false, retryNote: expect.stringMatching(/retried automatically/) });
    expect(list.find((m) => m.id === "s2")).toMatchObject({ retryable: false, retryNote: expect.stringMatching(/carrier/) });
    const retried = await o.call("POST", "/messages/email/e2/retry", {});
    expect(retried.statusCode, retried.body).toBe(200);
    expect(retried.json().message).toMatchObject({ status: "queued" });
    expect(ctx.deps.queues.sent.email).toContainEqual(expect.objectContaining({ messageId: "e2" }));
    // Twice is refused: it's queued now.
    expect((await o.call("POST", "/messages/email/e2/retry", {})).json().error).toBe("not_retryable");
    expect((await o.call("POST", "/messages/sms/s3/retry", {})).json().error).toBe("not_retryable");
    expect((await o.call("POST", "/messages/email/nope/retry", {})).statusCode).toBe(404);
  });

  it("counts the period per channel and per day, with a delivery rate only where deliveries are reported", async () => {
    const o = await owner();
    const r = await seed(o);
    const s = (await o.call("GET", `/stats?from=${r.from}&to=${r.to}`)).json();
    const smsStats = s.channels.find((c: { channel: string }) => c.channel === "sms");
    const email = s.channels.find((c: { channel: string }) => c.channel === "email");
    expect(smsStats.totals).toMatchObject({ delivered: 1, undelivered: 1, failed: 1, sent: 1, test_only: 1 });
    expect(smsStats.deliveryRate).toBe(0.5);
    expect(smsStats.costUsd).toBeCloseTo(0.06, 6);
    expect(email.totals).toMatchObject({ sent: 1, failed: 1, undelivered: 1, unknown: 1 });
    expect(email.deliveryRate).toBeNull();
    expect(email.deliveryNote).toMatch(/don't report deliveries/);
    expect(s.byDay).toEqual([{ day: "2026-10-20", counts: expect.objectContaining({ delivered: 1, sent: 2 }) }]);
  });

  it("keeps the audit trail of both channels, newest first", async () => {
    const o = await owner();
    const id = (await o.call("POST", "/items/sms", shipped)).json().automation.id;
    await o.call("POST", `/items/sms/${id}/activate`, { confirm: true });
    await o.call("POST", "/items/email", thanks(await mailbox(o)));
    const a = (await o.call("GET", "/audit")).json();
    expect(a.entries.map((e: { channel: string; label: string }) => `${e.channel}: ${e.label}`)).toEqual(expect.arrayContaining(["sms: Turned an automation on", "email: Created an automation"]));
    expect(a.entries[0].at >= a.entries[a.entries.length - 1].at).toBe(true);
    expect(a.entries.every((e: { actor: string }) => e.actor !== "")).toBe(true);
  });
});

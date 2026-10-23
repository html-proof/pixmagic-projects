import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { systemDb } from "@app/db";
import { fakeSmsProvider, type FakeSmsProvider, type SmsIdentityInfo } from "@app/core/sms";
import { LEGACY_GRANTS } from "@app/shared";
import { clean, createStore, createWorkspace, setup, signIn, teardown, type TestCtx } from "./helpers.js";

/**
 * Set up SMS (apps/api/src/routes/smsSetup.ts): the connection check, the sender name (approved
 * only on AWS's word), the message, duplicate-proof test texts, and turning order updates on.
 * AWS is faked; nothing leaves the process.
 */

let ctx: TestCtx;
let sms: FakeSmsProvider;
const OWNER_INBOX = "owner@platform.test";

beforeAll(async () => {
  ctx = await setup();
  sms = fakeSmsProvider();
  (ctx.deps as { sms?: FakeSmsProvider }).sms = sms;
});
afterAll(async () => {
  ctx.setEnv({ SMS_MODE: "off", SMS_SENDER_REQUESTS_TO: "", SMS_SHARED_SENDER: "" });
  await teardown(ctx);
});
beforeEach(async () => {
  await clean(ctx);
  sms.clear();
  sms.identities.clear();
  ctx.mailer.sent.length = 0;
  ctx.setEnv({ SMS_MODE: "sandbox", SMS_MARKETING_ENABLED: "", SMS_SHARED_SENDER: "", SMS_SENDER_REQUESTS_TO: OWNER_INBOX });
});

async function owner(uid = "u1", email = "o@shop.test") {
  const s = await signIn(ctx, uid, email);
  const ws = await createWorkspace(ctx, s.headers);
  const store = await createStore(ws, `${uid}.myshopify.com`, ["read_orders"], { name: "Ikorex Store", currency: "AUD" });
  const base = `/workspaces/${ws}/stores/${store.id}/sms`;
  const call = (method: "GET" | "POST" | "PUT", path: string, payload?: unknown) => ctx.app.inject({ method, url: `${base}/setup${path}`, headers: s.headers, ...(payload === undefined ? {} : { payload }) });
  return { ...s, ws, store, base, call };
}

/** An origination identity in "AWS", found by its id and by its ARN (the setup saves the ARN). */
function inAws(i: SmsIdentityInfo) {
  sms.identities.set(i.id, i);
  sms.identities.set(i.arn, i);
}

/** A sender ID in "AWS" for a country, tagged as given, with AWS's registration status. */
function senderId(name: string, country: string, tags: Record<string, string>, registrationStatus: string | null) {
  inAws({ kind: "sender_id", arn: `arn:aws:sms-voice:ap-southeast-2:1:sender-id/${name}/${country}`, id: name, label: name, country, status: registrationStatus === "COMPLETE" ? "REGISTERED" : "UNREGISTERED", twoWay: false, optOutList: "Default", registrationStatus, tags });
}

describe("who may see and change the setup", () => {
  it("shows it to viewers without the AWS identity, lets only owners and admins change it, and hides it from other workspaces", async () => {
    const o = await owner();
    const v = await signIn(ctx, "v", "v@shop.test");
    await systemDb.membership.create({ data: { workspaceId: o.ws, userId: v.user.id, role: "viewer", permissions: [...LEGACY_GRANTS.viewer, "marketing.campaigns"] } });
    const seen = await ctx.app.inject({ method: "GET", url: `${o.base}/setup`, headers: v.headers });
    expect(seen.statusCode).toBe(200);
    expect(seen.json()).toMatchObject({ step: "connect", connection: { status: "not_connected", provider: "AWS End User Messaging SMS" }, testNumbers: [] });
    // Looking writes nothing.
    expect(await systemDb.smsSetup.count()).toBe(0);
    for (const [method, path] of [
      ["PUT", ""],
      ["POST", "/connect"],
      ["POST", "/sender/request"],
      ["POST", "/message"],
      ["POST", "/automatic"],
    ] as const) {
      expect((await ctx.app.inject({ method, url: `${o.base}/setup${path}`, headers: v.headers, payload: {} })).statusCode, path).toBe(403);
    }
    const b = await signIn(ctx, "b", "b@other.test");
    await createWorkspace(ctx, b.headers, "Other");
    expect((await ctx.app.inject({ method: "GET", url: `${o.base}/setup`, headers: b.headers })).statusCode).toBe(404);
  });
});

describe("step 1: connect", () => {
  it("is connected only when AWS answers, says why not otherwise, and never answers with a key", async () => {
    const o = await owner();
    ctx.setEnv({ SMS_MODE: "off" });
    const off = await o.call("POST", "/connect", {});
    expect(off.json()).toMatchObject({ result: { connected: false, error: "platform_off" }, setup: { connection: { status: "failed", error: "platform_off" }, done: { connect: false } } });
    ctx.setEnv({ SMS_MODE: "sandbox" });
    const on = await o.call("POST", "/connect", {});
    expect(on.json()).toMatchObject({ result: { connected: true, account: { sandbox: true } }, setup: { connection: { status: "connected" }, step: "sender", done: { connect: true } } });
    expect(JSON.stringify(on.json())).not.toMatch(/secret|AccessKey|aws_secret/i);
    // Disconnecting keeps everything, and reconnecting needs no new setup.
    const off2 = await o.call("POST", "/disconnect", {});
    expect(off2.json().connection.status).toBe("disconnected");
    expect((await o.call("POST", "/connect", {})).json().setup.connection.status).toBe("connected");
    expect(await systemDb.smsAuditLog.count({ where: { storeId: o.store.id, action: { in: ["setup_connected", "setup_connect_failed", "setup_disconnected"] } } })).toBe(4);
  });
});

describe("step 2: the sender name", () => {
  it("checks the name on the server, sends one request to the platform owner, and approves it only once AWS has it registered for this workspace", async () => {
    const o = await owner();
    expect((await o.call("PUT", "", { businessName: "IKOREX", senderName: "IKOREX STORE", country: "AU" })).statusCode).toBe(200);
    const bad = await o.call("POST", "/sender/request", {});
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: "sender_name_invalid", message: expect.stringMatching(/can't have spaces/) });
    expect(ctx.mailer.sent).toHaveLength(0);

    await o.call("PUT", "", { senderName: "IKOREX" });
    const asked = await o.call("POST", "/sender/request", {});
    expect(asked.json()).toMatchObject({ result: { status: "requested" }, setup: { senderName: { name: "IKOREX", country: "AU", status: "requested", support: "registered" }, sender: null } });
    expect(ctx.mailer.sent).toHaveLength(1);
    expect(ctx.mailer.sent[0]).toMatchObject({ to: OWNER_INBOX, subject: expect.stringMatching(/IKOREX \(AU\)/) });
    expect(ctx.mailer.sent[0]!.text).toContain(`request-sender-id --region ap-southeast-2 --sender-id IKOREX --iso-country-code AU`);
    expect(ctx.mailer.sent[0]!.text).toContain(`Key=bizinsights:workspace,Value=${o.ws}`);
    expect(ctx.mailer.sent[0]!.text).toContain("o@shop.test");
    // Asking again doesn't email again.
    await o.call("POST", "/sender/request", {});
    expect(ctx.mailer.sent).toHaveLength(1);

    // AWS has nothing yet: still requested, never approved for having been asked.
    expect((await o.call("POST", "/sender/check", {})).json().result.status).toBe("requested");
    // The owner requested it: tagged for the workspace, the Australian registration not complete.
    senderId("IKOREX", "AU", { "bizinsights:workspace": o.ws }, null);
    const pending = await o.call("POST", "/sender/check", {});
    expect(pending.json()).toMatchObject({ result: { status: "pending", registration: "REQUIRED" }, setup: { sender: null, done: { sender: false } } });
    // Registered: approved, and it becomes the store's sender, checked with AWS.
    senderId("IKOREX", "AU", { "bizinsights:workspace": o.ws }, "COMPLETE");
    const approved = await o.call("POST", "/sender/check", {});
    expect(approved.json()).toMatchObject({ result: { status: "approved", label: "IKOREX" }, setup: { senderName: { status: "approved" }, sender: { identityCheck: "verified", identityLabel: "IKOREX", countries: ["AU"], sendingEnabled: false }, done: { sender: true } } });

    // Another name in the draft starts that part over; the approved sender keeps working meanwhile.
    const changed = await o.call("PUT", "", { senderName: "IKOREXAU" });
    expect(changed.json()).toMatchObject({ senderName: { name: "IKOREXAU", status: "draft", requestedAt: null }, sender: { identityLabel: "IKOREX", identityCheck: "verified" } });
  });

  it("refuses a name AWS has for another business, and finds a number for a country without sender names", async () => {
    const a = await owner();
    const b = await owner("u2", "o2@shop.test");
    senderId("TAKEN", "GB", { "bizinsights:workspace": b.ws }, "COMPLETE");
    await a.call("PUT", "", { senderName: "TAKEN", country: "GB" });
    const taken = await a.call("POST", "/sender/request", {});
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error).toBe("sender_name_taken");
    expect((await a.call("GET", "")).json().senderName.status).toBe("unavailable");

    // The US shows numbers, not names: the request is for a number, found at AWS by its tag.
    await a.call("PUT", "", { senderName: null, country: "US" });
    const asked = await a.call("POST", "/sender/request", {});
    expect(asked.json().result.status).toBe("requested");
    expect(ctx.mailer.sent.at(-1)).toMatchObject({ subject: expect.stringMatching(/number wanted for US/) });
    // Someone else's number in the US isn't theirs.
    inAws({ kind: "toll_free", arn: "arn:aws:sms-voice:ap-southeast-2:1:phone-number/phone-b", id: "phone-b", label: "+18885550100", country: "US", status: "ACTIVE", twoWay: true, optOutList: "Default", registrationStatus: "COMPLETE", tags: { "bizinsights:workspace": b.ws } });
    expect((await a.call("POST", "/sender/check", {})).json().result.status).toBe("requested");
    inAws({ kind: "toll_free", arn: "arn:aws:sms-voice:ap-southeast-2:1:phone-number/phone-a", id: "phone-a", label: "+18885550123", country: "US", status: "ACTIVE", twoWay: true, optOutList: "Default", registrationStatus: "COMPLETE", tags: { "bizinsights:workspace": a.ws } });
    const found = await a.call("POST", "/sender/check", {});
    expect(found.json()).toMatchObject({ result: { status: "approved", label: "+18885550123" }, setup: { sender: { senderType: "toll_free", identityCheck: "verified", countries: ["US"] } } });
  });

  it("offers the platform's shared sender only while there is one AWS confirms", async () => {
    const o = await owner();
    await o.call("PUT", "", { country: "AU" });
    expect((await o.call("POST", "/sender/shared", {})).json().error).toBe("no_shared_sender");
    senderId("SHARED", "AU", { "bizinsights:shared": "true" }, "COMPLETE");
    ctx.setEnv({ SMS_SHARED_SENDER: "SHARED" });
    expect((await o.call("GET", "")).json().senderName.sharedAvailable).toBe(true);
    const used = await o.call("POST", "/sender/shared", {});
    expect(used.json().sender).toMatchObject({ identityLabel: "SHARED", identityCheck: "verified" });
  });
});

describe("steps 3 to 5: message, test, automatic texts", () => {
  /** An owner whose AU sender AWS approved, with a verified test number. */
  async function ready() {
    const o = await owner();
    await o.call("POST", "/connect", {});
    senderId("IKOREX", "AU", { "bizinsights:workspace": o.ws }, "COMPLETE");
    await o.call("PUT", "", { businessName: "IKOREX", senderName: "IKOREX", country: "AU" });
    expect((await o.call("POST", "/sender/check", {})).json().result.status).toBe("approved");
    const added = await ctx.app.inject({ method: "POST", url: `${o.base}/test-numbers`, headers: o.headers, payload: { number: "0412 345 678", country: "AU" } });
    const id = added.json().testNumber.id as string;
    await ctx.app.inject({ method: "POST", url: `${o.base}/test-numbers/${id}/verify`, headers: o.headers, payload: { code: sms.verificationCode } });
    return { ...o, testNumberId: id };
  }

  it("saves the message as a draft template, refusing details its event can't fill", async () => {
    const o = await owner();
    const alias = await o.call("POST", "/message", { body: "Order {{order_id}} confirmed" });
    expect(alias.statusCode).toBe(400);
    expect(alias.json().message).toMatch(/Did you mean \{\{order_number\}\}/);
    const tracking = await o.call("POST", "/message", { body: "Track {{tracking_url}}" });
    expect(tracking.json().message).toMatch(/can't fill \{\{tracking_url\}\}/);
    const ok = await o.call("POST", "/message", { body: "Hi {{customer_name}}, your order {{order_number}} has been {{order_status}}. Thank you for shopping with {{business_name}}!" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().setup).toMatchObject({ done: { message: true }, automations: [{ key: "order_created", templateStatus: "draft", on: false }, {}, {}, {}, { key: "appointment_reminder", unavailable: expect.any(String) }] });
    const t = await systemDb.smsTemplate.findFirstOrThrow({ where: { storeId: o.store.id } });
    expect(t).toMatchObject({ name: "New order confirmed", category: "transactional", status: "draft" });
  });

  it("sends one test text per press, says AWS accepted it (not delivered), and refuses a quick repeat", async () => {
    const o = await ready();
    await o.call("POST", "/message", { body: "Hi {{customer_name}}, your order {{order_number}} has been {{order_status}}. Thank you for shopping with {{business_name}}!" });
    const templateId = (await o.call("GET", "")).json().templateId as string;
    const press = { testNumberId: o.testNumberId, requestId: "press-0001-abcdef" };
    const first = await ctx.app.inject({ method: "POST", url: `${o.base}/templates/${templateId}/test`, headers: o.headers, payload: press });
    expect(first.statusCode).toBe(200);
    expect(first.json().message).toMatchObject({ purpose: "test", status: "accepted", text: "Hi Sam, your order #1042 has been confirmed. Thank you for shopping with IKOREX!" });
    // The same press again (a retried request): the same text, not a second one.
    const again = await ctx.app.inject({ method: "POST", url: `${o.base}/templates/${templateId}/test`, headers: o.headers, payload: press });
    expect(again.json().message.id).toBe(first.json().message.id);
    expect(sms.sent).toHaveLength(1);
    expect(sms.sent[0]!.originationIdentity).toBe("arn:aws:sms-voice:ap-southeast-2:1:sender-id/IKOREX/AU");
    // A new press straight after: refused, nothing sent.
    const repeat = await ctx.app.inject({ method: "POST", url: `${o.base}/templates/${templateId}/test`, headers: o.headers, payload: { ...press, requestId: "press-0002-abcdef" } });
    expect(repeat.statusCode).toBe(429);
    expect(repeat.json().error).toBe("test_repeat");
    expect(sms.sent).toHaveLength(1);
    expect((await o.call("GET", "")).json()).toMatchObject({ done: { test: true }, lastTest: { status: "accepted" } });
  });

  it("turns an order update on only when confirmed, approving its message and rule, and the master switch only once everything is in place", async () => {
    const o = await ready();
    const unconfirmed = await o.call("PUT", "/automations/order_created", { on: true });
    expect(unconfirmed.statusCode).toBe(400);
    expect(unconfirmed.json().error).toBe("confirm_required");
    expect((await o.call("PUT", "/automations/customer_birthday", { on: true, confirm: true })).statusCode).toBe(400);

    const on = await o.call("PUT", "/automations/order_created", { on: true, confirm: true });
    expect(on.statusCode).toBe(200);
    expect(on.json().setup.automations[0]).toMatchObject({ key: "order_created", on: true, ruleStatus: "active", templateStatus: "approved" });
    const rule = await systemDb.smsAutomationRule.findFirstOrThrow({ where: { storeId: o.store.id } });
    expect(rule).toMatchObject({ status: "active", activeTrigger: "order_created" });
    expect(rule.activeConfig).toMatchObject({ trigger: "order_created", dryRun: false, delayMinutes: 0 });
    // Approved in the owner's name, recorded as such.
    expect(await systemDb.smsAuditLog.count({ where: { storeId: o.store.id, action: "rule_approved" } })).toBe(1);

    // Editing the message of one that is on approves the new text at once.
    await o.call("PUT", "/automations/order_created", { on: true, body: "{{business_name}}: order {{order_number}} {{order_status}}. Thanks {{customer_name}}!" });
    const t = await systemDb.smsTemplate.findFirstOrThrow({ where: { storeId: o.store.id } });
    expect(t).toMatchObject({ approvedVersion: 2, status: "approved" });

    // The master switch: no basis for order updates yet, then no budget.
    const noBasis = await o.call("POST", "/automatic", { on: true });
    expect(noBasis.json().error).toBe("no_basis");
    await o.call("PUT", "", { transactionalBasis: "checkout_notice", monthlyBudgetUsd: 0 });
    expect((await o.call("POST", "/automatic", { on: true })).json().error).toBe("no_budget");
    await o.call("PUT", "", { monthlyBudgetUsd: 20 });
    const master = await o.call("POST", "/automatic", { on: true });
    expect(master.json()).toMatchObject({ sending: { on: true, monthlyBudgetUsd: 20, transactionalBasis: "checkout_notice" }, done: { automate: true } });
    expect(master.json().completedAt).not.toBeNull();

    // Off: paused, and its waiting texts cancelled.
    const off = await o.call("PUT", "/automations/order_created", { on: false });
    expect(off.json().setup.automations[0]).toMatchObject({ on: false, ruleStatus: "paused" });
    // On again resumes the same rule.
    await o.call("PUT", "/automations/order_created", { on: true, confirm: true });
    expect(await systemDb.smsAutomationRule.count({ where: { storeId: o.store.id } })).toBe(1);
    expect((await systemDb.smsAutomationRule.findFirstOrThrow({ where: { storeId: o.store.id } })).status).toBe("active");

    // Disconnecting turns sending off.
    expect((await o.call("POST", "/disconnect", {})).json().sending.on).toBe(false);
  });

  it("keeps the draft for later: the step, the names and the message", async () => {
    const o = await owner();
    await o.call("PUT", "", { step: "message", businessName: "IKOREX", senderName: "IKOREX", country: "AU", message: "Draft {{order_number}}", monthlyBudgetUsd: 15, transactionalBasis: "sms_consent" });
    expect((await o.call("GET", "")).json()).toMatchObject({ step: "message", businessName: "IKOREX", senderName: { name: "IKOREX", country: "AU", status: "draft" }, message: "Draft {{order_number}}", sending: { monthlyBudgetUsd: 15, transactionalBasis: "sms_consent", on: false } });
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { systemDb } from "@app/db";
import { fakeSmsProvider, smsOnShopifyEvent, smsWebhookCheckKey, type FakeSmsProvider } from "@app/core/sms";
import { LEGACY_GRANTS } from "@app/shared";
import { clean, createStore, createWorkspace, setup, signIn, teardown, type TestCtx } from "./helpers.js";

/**
 * Automations, the four-step builder (apps/api/src/routes/smsAutomations.ts): which triggers
 * Shopify sends for the store, the message checked for its trigger, activation only on the
 * member's confirmation and only for a trigger that arrives, edits that wait until activated,
 * pause, copy, delete, a test text, and the real state and last result. AWS is faked.
 */

let ctx: TestCtx;
let sms: FakeSmsProvider;

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
});

async function owner(uid = "u1", email = "o@shop.test", extra: Record<string, unknown> = {}, scopes = ["read_orders"]) {
  const s = await signIn(ctx, uid, email);
  const ws = await createWorkspace(ctx, s.headers);
  const store = await createStore(ws, `${uid}.myshopify.com`, scopes, { name: "Green Leaf", currency: "AUD", ...extra });
  const base = `/workspaces/${ws}/stores/${store.id}/sms`;
  const call = (method: "GET" | "POST" | "PUT" | "DELETE", path: string, payload?: unknown) =>
    ctx.app.inject({ method, url: `${base}/automations${path}`, headers: s.headers, ...(payload === undefined ? {} : { payload }) });
  return { ...s, ws, store, base, call };
}

const shipped = {
  name: "Shipping update",
  trigger: "fulfillment_created",
  body: "Hi {{customer_name}}, order {{order_number}} is on its way: {{tracking_url}}",
  delayMinutes: 0,
  conditions: [],
};

/** A verified sender for the store, sending on (what Set up SMS leaves behind). */
async function sender(o: Awaited<ReturnType<typeof owner>>) {
  sms.identities.set("GREENLEAF", { kind: "sender_id", arn: "arn:aws:sms-voice:ap-southeast-2:1:sender-id/GREENLEAF/AU", id: "GREENLEAF", label: "GREENLEAF", country: "AU", status: "REGISTERED", twoWay: false, optOutList: "Default", registrationStatus: "COMPLETE", tags: { "bizinsights:workspace": o.ws } });
  const put = await ctx.app.inject({ method: "PUT", url: `${o.base}/sender`, headers: o.headers, payload: { senderType: "sender_id", originationIdentity: "GREENLEAF", countries: ["AU"], monthlyBudgetUsd: 25, hardStop: true, transactionalBasis: "checkout_notice", quietStart: 0, quietEnd: 0, maxPerCustomerDay: 3, maxMarketingPerWeek: 2 } });
  expect(put.statusCode).toBe(200);
  expect((await ctx.app.inject({ method: "POST", url: `${o.base}/sender/verify`, headers: o.headers })).json().sender.identityCheck).toBe("verified");
}

describe("who may see and change automations", () => {
  it("lets viewers look, only owners and admins change them, and other workspaces see nothing", async () => {
    const o = await owner();
    const made = await o.call("POST", "", shipped);
    expect(made.statusCode).toBe(201);
    const id = made.json().automation.id;
    const v = await signIn(ctx, "v", "v@shop.test");
    await systemDb.membership.create({ data: { workspaceId: o.ws, userId: v.user.id, role: "viewer", permissions: [...LEGACY_GRANTS.viewer, "marketing.campaigns"] } });
    const as = (h: Record<string, string>, method: "GET" | "POST" | "PUT" | "DELETE", path: string, payload?: unknown) => ctx.app.inject({ method, url: `${o.base}/automations${path}`, headers: h, ...(payload === undefined ? {} : { payload }) });
    expect((await as(v.headers, "GET", "")).statusCode).toBe(200);
    expect((await as(v.headers, "GET", "/triggers")).statusCode).toBe(200);
    expect((await as(v.headers, "GET", `/${id}`)).statusCode).toBe(200);
    for (const [method, path] of [
      ["POST", ""],
      ["PUT", `/${id}`],
      ["POST", `/${id}/activate`],
      ["POST", `/${id}/pause`],
      ["POST", `/${id}/duplicate`],
      ["POST", `/${id}/test`],
      ["POST", "/triggers/verify"],
      ["DELETE", `/${id}`],
    ] as const) {
      expect((await as(v.headers, method, path, method === "DELETE" ? undefined : shipped)).statusCode, `${method} ${path}`).toBe(403);
    }
    const b = await signIn(ctx, "b", "b@other.test");
    await createWorkspace(ctx, b.headers, "Other");
    expect((await as(b.headers, "GET", "")).statusCode).toBe(404);
    expect((await as(b.headers, "GET", `/${id}`)).statusCode).toBe(404);
    // Another store's automation isn't found through this store.
    const other = await owner("u2", "o2@shop.test");
    expect((await other.call("GET", `/${id}`)).statusCode).toBe(404);
    expect((await other.call("DELETE", `/${id}`)).statusCode).toBe(404);
  });
});

describe("step 1: triggers", () => {
  it("offers a trigger only where Shopify sends its event for the store, and says why not otherwise", async () => {
    const o = await owner();
    const t = (await o.call("GET", "/triggers")).json();
    const state = (key: string) => t.triggers.find((x: { key: string }) => x.key === key);
    for (const key of ["order_created", "payment_completed", "fulfillment_created", "delivery_confirmed", "checkout_abandoned", "order_cancelled", "refund_issued"]) expect(state(key).state, key).toBe("ready");
    expect(state("customer_registered")).toMatchObject({ state: "needs_permission", scope: "read_customers" });
    expect(state("custom_event")).toMatchObject({ state: "unavailable", trigger: null });
    expect(state("customer_birthday").state).toBe("unavailable");
    expect(t.contactsSeen).toBe(0);

    // A store connected through the App Store app gets no order or checkout events from Shopify yet.
    const listed = await owner("u3", "o3@shop.test", { shopifyAppKey: "appstore" });
    const l = (await listed.call("GET", "/triggers")).json();
    expect(l.triggers.find((x: { key: string }) => x.key === "order_created")).toMatchObject({ state: "not_sent", reason: expect.stringMatching(/App Store app/) });

    // With read_customers granted, new accounts wait on Shopify's word about the subscription.
    const customers = await owner("u4", "o4@shop.test", {}, ["read_orders", "read_customers"]);
    const before = (await customers.call("GET", "/triggers")).json().triggers.find((x: { key: string }) => x.key === "customer_registered");
    expect(before.state).toBe("unchecked");
    await ctx.deps.coord.put(smsWebhookCheckKey(customers.store.id), JSON.stringify({ topics: { CUSTOMERS_CREATE: "subscribed", CUSTOMERS_MARKETING_CONSENT_UPDATE: "subscribed" }, created: 0, checkedAt: new Date().toISOString() }), 3600);
    const after = (await customers.call("GET", "/triggers")).json().triggers.find((x: { key: string }) => x.key === "customer_registered");
    expect(after).toMatchObject({ state: "ready", checkedAt: expect.any(String) });
  });
});

describe("step 2: the message", () => {
  it("refuses a message its trigger can't send, in plain words, and saves a good one as a draft", async () => {
    const o = await owner();
    const noTracking = await o.call("POST", "", { ...shipped, trigger: "order_created", name: "Confirm" });
    expect(noTracking.statusCode).toBe(400);
    expect(noTracking.json()).toMatchObject({ error: "message_invalid", message: expect.stringMatching(/"Order placed" texts have no tracking link/) });
    const noOptOut = await o.call("POST", "", { name: "Cart", trigger: "checkout_abandoned", body: "Come back: {{checkout_url}}", delayMinutes: 60 });
    expect(noOptOut.statusCode).toBe(400);
    expect(noOptOut.json().message).toMatch(/opt_out_url/);
    const noCode = await o.call("POST", "", { name: "Welcome", trigger: "customer_registered", body: "Welcome! Use {{discount_code}}. Opt out: {{opt_out_url}}" });
    expect(noCode.json().message).toMatch(/enter the code/);
    // A condition its event can't have is refused too.
    const badCondition = await o.call("POST", "", { ...shipped, conditions: [{ field: "tag", op: "has", value: "vip" }], trigger: "refund_issued", body: "Refunded {{order_total}}." });
    expect(badCondition.statusCode).toBe(400);

    const made = await o.call("POST", "", shipped);
    expect(made.statusCode).toBe(201);
    expect(made.json().automation).toMatchObject({ name: "Shipping update", trigger: "fulfillment_created", triggerLabel: "Order shipped or fulfilled", category: "transactional", status: "draft", pendingChanges: false, body: shipped.body, liveBody: null, lastResult: null });
    // Order updates may reach a customer several times a day (each event once); its template is the automation's own.
    expect(made.json().automation.config).toMatchObject({ maxPerCustomer: 10, capDays: 1, dryRun: false, quietStart: 21, quietEnd: 9 });
    const t = await systemDb.smsTemplate.findUniqueOrThrow({ where: { id: made.json().automation.templateId } });
    expect(t).toMatchObject({ name: "Shipping update", category: "transactional", status: "draft" });
  });
});

describe("step 4: test and activate", () => {
  it("turns on only when confirmed and the trigger arrives, puts edits live only when activated again, and pauses", async () => {
    const o = await owner();
    const id = (await o.call("POST", "", shipped)).json().automation.id;
    expect((await o.call("POST", `/${id}/activate`, {})).json().error).toBe("confirm_required");
    const on = await o.call("POST", `/${id}/activate`, { confirm: true });
    expect(on.statusCode).toBe(200);
    expect(on.json().automation).toMatchObject({ status: "active", pendingChanges: false, liveBody: shipped.body });
    const rule = await systemDb.smsAutomationRule.findUniqueOrThrow({ where: { id } });
    expect(rule).toMatchObject({ status: "active", activeTrigger: "fulfillment_created", approvedBy: o.user.id });
    expect((await systemDb.smsTemplate.findFirstOrThrow({ where: { storeId: o.store.id } })).status).toBe("approved");

    // An edit is saved, while the activated version keeps running until it's activated too.
    const edited = await o.call("PUT", `/${id}`, { ...shipped, body: "Hi {{customer_name}}, {{business_name}} shipped {{order_number}}: {{tracking_url}}", delayMinutes: 30 });
    expect(edited.json().automation).toMatchObject({ status: "active", pendingChanges: true, liveBody: shipped.body });
    expect((await systemDb.smsAutomationRule.findUniqueOrThrow({ where: { id } })).activeConfig).toMatchObject({ delayMinutes: 0 });
    const republished = await o.call("POST", `/${id}/activate`, { confirm: true });
    expect(republished.json().automation).toMatchObject({ status: "active", pendingChanges: false, liveBody: expect.stringContaining("{{business_name}} shipped") });
    expect((await systemDb.smsAutomationRule.findUniqueOrThrow({ where: { id } })).activeConfig).toMatchObject({ delayMinutes: 30 });

    const paused = await o.call("POST", `/${id}/pause`, {});
    expect(paused.json().automation.status).toBe("paused");
    expect((await o.call("POST", `/${id}/pause`, {})).statusCode).toBe(409);
    expect((await o.call("POST", `/${id}/activate`, { confirm: true })).json().automation.status).toBe("active");
    const audit = await systemDb.smsAuditLog.findMany({ where: { targetId: id }, orderBy: { createdAt: "asc" } });
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(["rule_created", "automation_activated", "automation_republished", "rule_paused"]));

    // A trigger Shopify doesn't send for the store can't be turned on.
    const listed = await owner("u5", "o5@shop.test", { shopifyAppKey: "appstore" });
    const lid = (await listed.call("POST", "", shipped)).json().automation.id;
    const refused = await listed.call("POST", `/${lid}/activate`, { confirm: true });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: "trigger_unavailable", message: expect.stringMatching(/App Store app/) });
    expect((await systemDb.smsAutomationRule.findUniqueOrThrow({ where: { id: lid } })).status).toBe("draft");
  });

  it("sends the test to a verified number only, once per press", async () => {
    const o = await owner();
    await sender(o);
    const id = (await o.call("POST", "", shipped)).json().automation.id;
    const added = (await ctx.app.inject({ method: "POST", url: `${o.base}/test-numbers`, headers: o.headers, payload: { number: "0412 345 678", country: "AU" } })).json().testNumber.id;
    expect((await o.call("POST", `/${id}/test`, { testNumberId: added, requestId: "press-0001" })).json().error).toBe("test_number_unverified");
    await ctx.app.inject({ method: "POST", url: `${o.base}/test-numbers/${added}/verify`, headers: o.headers, payload: { code: sms.verificationCode } });
    const sent = await o.call("POST", `/${id}/test`, { testNumberId: added, requestId: "press-0002" });
    expect(sent.statusCode).toBe(200);
    expect(sent.json().message).toMatchObject({ purpose: "test", status: "accepted", text: "Hi Sam, order #1042 is on its way: https://track.example.com/AB123" });
    // The same press retried returns the same text; nothing else goes.
    const again = await o.call("POST", `/${id}/test`, { testNumberId: added, requestId: "press-0002" });
    expect(again.json().message.id).toBe(sent.json().message.id);
    expect(sms.sent).toHaveLength(1);
  });
});

describe("the list", () => {
  it("shows each automation's real state, its last result, and what stops texts reaching anyone", async () => {
    const o = await owner();
    const empty = (await o.call("GET", "")).json();
    expect(empty).toMatchObject({ mode: "sandbox", automations: [] });
    expect(empty.problems.map((p: { code: string }) => p.code)).toEqual(expect.arrayContaining(["test_mode", "no_sender", "marketing_platform_off"]));

    await sender(o);
    const id = (await o.call("POST", "", { ...shipped, name: "Confirm", trigger: "order_created", body: "Hi {{customer_name}}, thanks for order {{order_number}}!" })).json().automation.id;
    await o.call("POST", `/${id}/activate`, { confirm: true });
    const order = { id: 501, name: "#1001", currency: "AUD", created_at: new Date().toISOString(), total_price: "40.00", customer: { id: 9, first_name: "Sam" }, shipping_address: { country_code: "AU", phone: "0412 345 678" }, line_items: [] };
    await smsOnShopifyEvent(o.store, "orders/create", order, ctx.deps);
    const list = (await o.call("GET", "")).json();
    const a = list.automations.find((x: { id: string }) => x.id === id);
    // Test mode: recorded, not sent; and the list says so rather than "sent".
    expect(a).toMatchObject({ status: "active", lastRunAt: expect.any(String), lastResult: { status: "dry_run", reason: "platform_dry_run", dryRun: true } });
    expect(a.last30Days.dryRun).toBe(1);
    expect(list.problems.map((p: { code: string }) => p.code)).toContain("test_mode");
    expect(list.problems.map((p: { code: string }) => p.code)).not.toContain("no_sender");
    expect(JSON.stringify(list)).not.toMatch(/412 ?345|61412/);
  });

  it("copies an automation as a draft with a message of its own, and deletes one, cancelling its waiting texts", async () => {
    const o = await owner();
    const id = (await o.call("POST", "", shipped)).json().automation.id;
    await o.call("POST", `/${id}/activate`, { confirm: true });
    const copy = await o.call("POST", `/${id}/duplicate`, {});
    expect(copy.statusCode).toBe(201);
    expect(copy.json().automation).toMatchObject({ name: "Shipping update (copy)", status: "draft", body: shipped.body });
    const original = (await o.call("GET", `/${id}`)).json().automation;
    expect(copy.json().automation.templateId).not.toBe(original.templateId);

    const rule = await systemDb.smsAutomationRule.findUniqueOrThrow({ where: { id } });
    await systemDb.smsMessageJob.create({ data: { workspaceId: o.ws, storeId: o.store.id, dedupeKey: `rule:${id}:order:1`, purpose: "automation", category: "transactional", trigger: "fulfillment_created", ruleId: id, ruleVersion: rule.activeVersion, templateId: original.templateId, templateVersion: 1, status: "scheduled", sendAfter: new Date(Date.now() + 3600_000) } });
    const gone = await o.call("DELETE", `/${id}`);
    expect(gone.json()).toEqual({ cancelled: 1 });
    expect((await o.call("GET", `/${id}`)).statusCode).toBe(404);
    expect((await systemDb.smsMessageJob.findFirstOrThrow({ where: { ruleId: id } })).status).toBe("cancelled");
    expect((await systemDb.smsTemplate.findUniqueOrThrow({ where: { id: original.templateId } })).status).toBe("archived");
    // The copy is untouched.
    expect((await o.call("GET", `/${copy.json().automation.id}`)).json().automation.status).toBe("draft");
    expect((await systemDb.smsAuditLog.findFirstOrThrow({ where: { targetId: id, action: "rule_deleted" } })).metadata).toMatchObject({ cancelled: 1 });
  });
});

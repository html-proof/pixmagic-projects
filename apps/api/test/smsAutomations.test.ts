import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { systemDb } from "@app/db";
import { accountStatusKey, fakeSmsProvider, smsOnShopifyEvent, smsRegion, smsWebhookCheckKey, type FakeSmsProvider } from "@app/core/sms";
import { LEGACY_GRANTS } from "@app/shared";
import { clean, createStore, createWorkspace, setup, signIn, teardown, type TestCtx } from "./helpers.js";

/**
 * Automations, the builder (apps/api/src/routes/smsAutomations.ts): which triggers Shopify sends
 * for the store, who it texts (a segment, chosen customers), the message checked for its trigger,
 * activation only on the member's confirmation, only for a trigger that arrives and, on a live
 * platform, only once the store's setup is done; edits that wait until activated, pause, copy,
 * delete, a test text, the readiness and checks in plain words, and the real state and last
 * result. AWS is faked.
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

    // A store connected through the first App Store app ("public") gets no order or checkout events from Shopify.
    const listed = await owner("u3", "o3@shop.test", { shopifyAppKey: "public" });
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
    const listed = await owner("u5", "o5@shop.test", { shopifyAppKey: "public" });
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
    expect(copy.json().automation).toMatchObject({ name: "Shipping update — Copy", status: "draft", body: shipped.body });
    // Copying again (the original or the copy) takes the next number.
    expect((await o.call("POST", `/${id}/duplicate`, {})).json().automation.name).toBe("Shipping update — Copy 2");
    expect((await o.call("POST", `/${copy.json().automation.id}/duplicate`, {})).json().automation.name).toBe("Shipping update — Copy 3");
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

describe("step 2: who gets it", () => {
  const order = (id: number, phone = "0412 345 678") => ({ id, name: `#${id}`, currency: "AUD", created_at: new Date().toISOString(), total_price: "40.00", customer: { id: 9, first_name: "Sam" }, shipping_address: { country_code: "AU", phone }, line_items: [] });

  it("limits an automation to a segment or to chosen customers, refusing ones that don't fit, and keeps it when another editor saves", async () => {
    const o = await owner();
    const seg = await ctx.app.inject({ method: "POST", url: `${o.base}/segments`, headers: o.headers, payload: { name: "VIP Customers", filter: { countries: [], minOrders: 5 } } });
    expect(seg.statusCode).toBe(201);
    const segmentId = seg.json().segment.id;

    const vip = await o.call("POST", "", { ...shipped, name: "VIP shipping", audience: { kind: "segment", segmentId } });
    expect(vip.statusCode).toBe(201);
    expect(vip.json().automation).toMatchObject({ segmentName: "VIP Customers", audienceLabel: `The customer whose order shipped, if they're in "VIP Customers"`, config: { audience: { kind: "segment", segmentId } } });
    // A new account has no order count to judge "5+ orders" on.
    const misfit = await o.call("POST", "", { name: "Welcome VIPs", trigger: "customer_registered", body: "Welcome {{customer_name}}! Opt out: {{opt_out_url}}", audience: { kind: "segment", segmentId } });
    expect(misfit.statusCode).toBe(400);
    expect(misfit.json()).toMatchObject({ error: "audience_invalid", message: expect.stringMatching(/customer's orders/) });
    expect((await o.call("POST", "", { ...shipped, audience: { kind: "segment", segmentId: "cnosuchsegment" } })).json().error).toBe("audience_invalid");
    expect((await o.call("POST", "", { ...shipped, audience: { kind: "customers", contactIds: ["cnosuchcontact"] } })).json().error).toBe("audience_invalid");
    // "Customer joins a segment" needs its segment.
    expect((await o.call("POST", "", { name: "Joined", trigger: "customer_segment", body: "Hi {{customer_name}}! Opt out: {{opt_out_url}}" })).statusCode).toBe(400);
    expect((await o.call("POST", "", { name: "Joined", trigger: "customer_segment", body: "Hi {{customer_name}}! Opt out: {{opt_out_url}}", audience: { kind: "segment", segmentId } })).statusCode).toBe(201);

    // The segment can't be deleted while automations use it.
    const del = await ctx.app.inject({ method: "DELETE", url: `${o.base}/segments/${segmentId}`, headers: o.headers });
    expect(del.statusCode).toBe(409);
    expect(del.json().message).toMatch(/"VIP shipping"/);

    // Chosen customers: found by first name (masked numbers), named on the automation.
    await sender(o);
    await smsOnShopifyEvent(o.store, "orders/create", order(601), ctx.deps);
    const found = (await o.call("GET", "/audience/customers?q=sa")).json().customers;
    expect(found).toEqual([expect.objectContaining({ name: "Sam", number: expect.stringMatching(/678$/), orders: 1 })]);
    expect(JSON.stringify(found)).not.toMatch(/412 ?345|61412/);
    expect((await o.call("GET", "/audience/customers?q=zed")).json().customers).toEqual([]);
    const chosen = await o.call("POST", "", { ...shipped, name: "For Sam", audience: { kind: "customers", contactIds: [found[0].id] } });
    expect(chosen.json().automation.audienceLabel).toMatch(/if they're the customer you chose$/);
    expect((await o.call("GET", `/audience/customers?ids=${found[0].id}`)).json().customers).toHaveLength(1);
    // The hub's editor sends no audience: the automation keeps its own.
    const resaved = await o.call("PUT", `/${chosen.json().automation.id}`, { ...shipped, name: "For Sam" });
    expect(resaved.json().automation.config.audience).toEqual({ kind: "customers", contactIds: [found[0].id] });

    // How many it could reach now: one customer per event, or those of the choice who may get it.
    expect((await o.call("POST", "/audience", { trigger: "order_created", audience: { kind: "trigger" } })).json()).toEqual({ customers: null, perEvent: true });
    expect((await o.call("POST", "/audience", { trigger: "order_created", audience: { kind: "segment", segmentId } })).json()).toEqual({ customers: 0, perEvent: true });
    expect((await o.call("POST", "/audience", { trigger: "order_created", audience: { kind: "customers", contactIds: [found[0].id] } })).json()).toEqual({ customers: 1, perEvent: true });
  });

  it("keeps who an automation texts when the advanced rule editor saves it, whatever it sends", async () => {
    const o = await owner();
    const segmentId = (await ctx.app.inject({ method: "POST", url: `${o.base}/segments`, headers: o.headers, payload: { name: "VIP Customers", filter: { countries: [], minOrders: 5 } } })).json().segment.id;
    const a = (await o.call("POST", "", { ...shipped, audience: { kind: "segment", segmentId } })).json().automation;
    const rule = (await ctx.app.inject({ method: "GET", url: `${o.base}/rules/${a.id}`, headers: o.headers })).json().rule;
    // The editor sends the whole rule, with the schema's default audience ("everyone") filled in.
    const put = await ctx.app.inject({ method: "PUT", url: `${o.base}/rules/${a.id}`, headers: o.headers, payload: { ...rule.config, quietStart: 22, audience: { kind: "trigger" } } });
    expect(put.statusCode).toBe(200);
    const after = await systemDb.smsAutomationRule.findUniqueOrThrow({ where: { id: a.id } });
    expect(after.config).toMatchObject({ quietStart: 22, audience: { kind: "segment", segmentId } });
    // A new rule from that editor texts the event's customer.
    const created = await ctx.app.inject({ method: "POST", url: `${o.base}/rules`, headers: o.headers, payload: { ...rule.config, name: "Another", audience: { kind: "customers", contactIds: ["cwhoever"] } } });
    expect(created.statusCode).toBe(201);
    expect((await systemDb.smsAutomationRule.findUniqueOrThrow({ where: { id: created.json().rule.id } })).config).toMatchObject({ audience: { kind: "trigger" } });
  });

  it("names customers only to members who may see contact details", async () => {
    const o = await owner();
    const v = await signIn(ctx, "v2", "v2@shop.test");
    await systemDb.membership.create({ data: { workspaceId: o.ws, userId: v.user.id, role: "viewer", permissions: [...LEGACY_GRANTS.viewer, "marketing.campaigns"] } });
    const res = await ctx.app.inject({ method: "GET", url: `${o.base}/automations/audience/customers?q=`, headers: v.headers });
    expect(res.statusCode).toBe(403);
  });

  it("texts only the customers its audience names, judged when the event happens", async () => {
    const o = await owner();
    await sender(o);
    const seg = (await ctx.app.inject({ method: "POST", url: `${o.base}/segments`, headers: o.headers, payload: { name: "Repeat", filter: { countries: [], minOrders: 2 } } })).json().segment.id;
    const id = (await o.call("POST", "", { ...shipped, name: "Repeat thanks", trigger: "order_created", body: "Thanks again {{customer_name}}!", audience: { kind: "segment", segmentId: seg } })).json().automation.id;
    await o.call("POST", `/${id}/activate`, { confirm: true });
    await smsOnShopifyEvent(o.store, "orders/create", order(701), ctx.deps);
    expect(await systemDb.smsMessageJob.count({ where: { ruleId: id } })).toBe(0);
    await smsOnShopifyEvent(o.store, "orders/create", order(702), ctx.deps);
    expect(await systemDb.smsMessageJob.findMany({ where: { ruleId: id } })).toEqual([expect.objectContaining({ status: "dry_run" })]);
    // Another customer, not chosen, gets nothing from an automation for chosen customers.
    const sam = await systemDb.smsContact.findFirstOrThrow({ where: { storeId: o.store.id } });
    const forSam = (await o.call("POST", "", { ...shipped, name: "Sam only", trigger: "order_created", body: "Hi {{customer_name}}!", audience: { kind: "customers", contactIds: [sam.id] } })).json().automation.id;
    await o.call("POST", `/${forSam}/activate`, { confirm: true });
    await smsOnShopifyEvent(o.store, "orders/create", { ...order(703, "0412 999 888"), customer: { id: 10, first_name: "Kim" } }, ctx.deps);
    await smsOnShopifyEvent(o.store, "orders/create", order(704), ctx.deps);
    expect((await systemDb.smsMessageJob.findMany({ where: { ruleId: forSam } })).map((j) => j.contactId)).toEqual([sam.id]);
  });
});

describe("readiness and the review's checks", () => {
  it("says how ready texting is, with only what's missing and where to fix it, in plain words", async () => {
    const o = await owner();
    const r = (await ctx.app.inject({ method: "GET", url: o.base, headers: o.headers })).json().readiness;
    expect(r).toMatchObject({ status: "setup_required", testMode: true, sender: false });
    expect(r.items.find((i: { key: string }) => i.key === "sender")).toMatchObject({ ok: false, label: "SMS sender", fix: { href: "/messaging/setup?step=sender" } });
    expect(r.items.find((i: { key: string }) => i.key === "test_recipient")).toMatchObject({ ok: false, optional: true });
    expect(JSON.stringify(r)).not.toMatch(/\bAWS\b/);
    const list = (await o.call("GET", "")).json();
    expect(list.readiness.status).toBe("setup_required");
    const overview = (await ctx.app.inject({ method: "GET", url: o.base, headers: o.headers })).json();
    expect(overview.thisMonth).toMatchObject({ accepted: 0, quota: null, from: expect.stringMatching(/^\d{4}-\d{2}-01$/) });

    await sender(o);
    await ctx.app.inject({ method: "POST", url: `${o.base}/sender/sending`, headers: o.headers, payload: { sending: true } });
    const ready = (await ctx.app.inject({ method: "GET", url: o.base, headers: o.headers })).json().readiness;
    // Everything the store does is done; the account is still being verified (test mode).
    expect(ready.items.filter((i: { ok: boolean; optional: boolean; key: string }) => !i.ok && !i.optional).map((i: { key: string }) => i.key)).toEqual(["account"]);
    expect(ready.status).toBe("setup_required");
  });

  it("lets an automation be switched on in test mode, but on a live platform only once the store's setup is done", async () => {
    const o = await owner();
    const id = (await o.call("POST", "", shipped)).json().automation.id;
    const sandbox = (await o.call("GET", `/${id}/checks`)).json();
    expect(sandbox.canActivate).toBe(true);
    expect(sandbox.checks.find((c: { key: string }) => c.key === "sender")).toMatchObject({ ok: false, blocking: false, message: "Your store has no SMS sender yet.", fix: { href: "/messaging/setup?step=sender" } });
    expect(sandbox.checks.find((c: { key: string }) => c.key === "account")).toMatchObject({ ok: false, blocking: false, message: expect.stringMatching(/still being verified/) });
    expect(sandbox.checks.filter((c: { ok: boolean }) => c.ok).map((c: { key: string }) => c.key)).toEqual(expect.arrayContaining(["trigger", "audience", "message", "variables", "opt_outs", "numbers"]));
    expect(JSON.stringify(sandbox)).not.toMatch(/\bAWS\b/);

    ctx.setEnv({ SMS_MODE: "live" });
    sms.accountInfo = { ...sms.accountInfo, sandbox: false, tier: "PRODUCTION" };
    const live = (await o.call("GET", `/${id}/checks`)).json();
    expect(live.canActivate).toBe(false);
    expect(live.checks.filter((c: { blocking: boolean }) => c.blocking).map((c: { key: string }) => c.key)).toEqual(["sender"]);
    const refused = await o.call("POST", `/${id}/activate`, { confirm: true });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: "setup_incomplete", message: "SMS sending isn't ready yet. Your store has no SMS sender yet." });
    expect((await systemDb.smsAutomationRule.findUniqueOrThrow({ where: { id } })).status).toBe("draft");

    await sender(o);
    expect((await o.call("GET", `/${id}/checks`)).json().checks.filter((c: { blocking: boolean }) => c.blocking).map((c: { key: string }) => c.key)).toEqual(["sender_usable"]);
    await ctx.app.inject({ method: "POST", url: `${o.base}/sender/sending`, headers: o.headers, payload: { sending: true } });
    // The account's answer from test mode is kept 10 minutes: forget it, as if they had passed.
    await ctx.deps.coord.take(accountStatusKey(smsRegion(await systemDb.smsSenderConfiguration.findUnique({ where: { storeId: o.store.id } }))));
    const done = (await o.call("GET", `/${id}/checks`)).json();
    expect(done).toMatchObject({ canActivate: true });
    expect(done.checks.find((c: { key: string }) => c.key === "account")).toMatchObject({ ok: true });
    expect((await o.call("POST", `/${id}/activate`, { confirm: true })).json().automation.status).toBe("active");
    sms.accountInfo = { ...sms.accountInfo, sandbox: true, tier: "SANDBOX" };
  });

  it("names the automation and the customer in Message History, for members who may see contact details", async () => {
    const o = await owner();
    await sender(o);
    const id = (await o.call("POST", "", { ...shipped, name: "Confirm", trigger: "order_created", body: "Hi {{customer_name}}, thanks for order {{order_number}}!" })).json().automation.id;
    await o.call("POST", `/${id}/activate`, { confirm: true });
    await smsOnShopifyEvent(o.store, "orders/create", { id: 801, name: "#801", currency: "AUD", created_at: new Date().toISOString(), total_price: "40.00", customer: { id: 9, first_name: "Sam" }, shipping_address: { country_code: "AU", phone: "0412 345 678" }, line_items: [] }, ctx.deps);
    const [m] = (await ctx.app.inject({ method: "GET", url: `${o.base}/messages?ruleId=${id}`, headers: o.headers })).json().messages;
    expect(m).toMatchObject({ automationName: "Confirm", customerName: "Sam", status: "dry_run", reasonLabel: "Test mode: recorded, not sent to the customer" });
    const detail = (await ctx.app.inject({ method: "GET", url: `${o.base}/messages/${m.id}`, headers: o.headers })).json().message;
    expect(detail).toMatchObject({ automationName: "Confirm", customerName: "Sam" });
  });
});

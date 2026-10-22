import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { systemDb } from "@app/db";
import { fakeSmsProvider, smsPhoneHash, type FakeSmsProvider } from "@app/core/sms";
import { LEGACY_GRANTS, sha256Hex } from "@app/shared";
import { clean, createStore, createWorkspace, setup, signIn, teardown, type TestCtx } from "./helpers.js";

/**
 * Customer Messaging's API: who may see and change what, tenant isolation, the sender check with
 * AWS (by tag), templates' review and versions, rules' approval, test numbers, the opt-out page's
 * endpoints, and the figures. AWS is faked; nothing leaves the process.
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

async function owner(uid = "u1", email = "o@shop.test") {
  const s = await signIn(ctx, uid, email);
  const ws = await createWorkspace(ctx, s.headers);
  const store = await createStore(ws, `${uid}.myshopify.com`, ["read_orders"], { name: "Green Leaf", currency: "AUD" });
  return { ...s, ws, store, base: `/workspaces/${ws}/stores/${store.id}/sms` };
}

/** An identity in "AWS", tagged for a workspace. */
function identity(id: string, tags: Record<string, string>) {
  sms.identities.set(id, { kind: "sender_id", arn: `arn:aws:sms-voice:ap-southeast-2:1:sender-id/${id}/AU`, id, label: id, country: "AU", status: "REGISTERED", twoWay: false, optOutList: "Default", registrationStatus: "COMPLETE", tags });
}

const senderBody = (id: string) => ({ senderType: "sender_id", originationIdentity: id, countries: ["AU"], monthlyBudgetUsd: 25, hardStop: true, transactionalBasis: "checkout_notice", quietStart: 21, quietEnd: 9, maxPerCustomerDay: 3, maxMarketingPerWeek: 2 });

describe("permissions and tenancy", () => {
  it("shows another workspace's member nothing, even with their own workspace id in the path", async () => {
    const a = await owner();
    const b = await signIn(ctx, "b", "b@other.test");
    const bWs = await createWorkspace(ctx, b.headers, "Other");
    for (const path of ["", "/sender", "/templates", "/rules", "/campaigns", "/segments", "/messages", "/analytics", "/billing", "/contacts", "/suppressions"]) {
      expect((await ctx.app.inject({ method: "GET", url: `${a.base}${path}`, headers: b.headers })).statusCode, path).toBe(404);
    }
    expect((await ctx.app.inject({ method: "PUT", url: `${a.base}/sender`, headers: b.headers, payload: senderBody("X") })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: "GET", url: `/workspaces/${bWs}/stores/${a.store.id}/sms`, headers: b.headers })).statusCode).toBe(404);
  });

  it("lets viewers look but not change anything, and keeps numbers from members without contact rights", async () => {
    const o = await owner();
    const v = await signIn(ctx, "v", "v@shop.test");
    await systemDb.membership.create({ data: { workspaceId: o.ws, userId: v.user.id, role: "viewer", permissions: [...LEGACY_GRANTS.viewer, "marketing.campaigns"] } });
    expect((await ctx.app.inject({ method: "GET", url: o.base, headers: v.headers })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "GET", url: `${o.base}/templates`, headers: v.headers })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "GET", url: `${o.base}/contacts`, headers: v.headers })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: "PUT", url: `${o.base}/sender`, headers: v.headers, payload: senderBody("X") })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: "POST", url: `${o.base}/templates`, headers: v.headers, payload: { name: "A", category: "transactional", body: "Hi" } })).statusCode).toBe(403);
    // Without "marketing.campaigns" the section isn't theirs at all.
    const w = await signIn(ctx, "w", "w@shop.test");
    await systemDb.membership.create({ data: { workspaceId: o.ws, userId: w.user.id, role: "viewer", permissions: LEGACY_GRANTS.viewer.filter((p) => p !== "marketing.campaigns") } });
    expect((await ctx.app.inject({ method: "GET", url: o.base, headers: w.headers })).statusCode).toBe(403);
  });
});

describe("sender", () => {
  it("accepts only an identity AWS tags for this workspace (or the platform's shared one), and keeps sending off until it checks out", async () => {
    const a = await owner();
    const b = await owner("u2", "o2@shop.test");
    identity("ASENDER", { "bizinsights:workspace": a.ws });
    identity("BSENDER", { "bizinsights:workspace": b.ws });
    expect((await ctx.app.inject({ method: "PUT", url: `${a.base}/sender`, headers: a.headers, payload: { ...senderBody("BSENDER") } })).statusCode).toBe(200);
    // B's sender ID typed into A's settings: AWS says it is B's.
    const stolen = await ctx.app.inject({ method: "POST", url: `${a.base}/sender/verify`, headers: a.headers });
    expect(stolen.json().sender).toMatchObject({ identityCheck: "not_allowed", sendingEnabled: false });
    expect((await ctx.app.inject({ method: "POST", url: `${a.base}/sender/sending`, headers: a.headers, payload: { sending: true } })).statusCode).toBe(409);
    await ctx.app.inject({ method: "PUT", url: `${a.base}/sender`, headers: a.headers, payload: senderBody("ASENDER") });
    const ok = await ctx.app.inject({ method: "POST", url: `${a.base}/sender/verify`, headers: a.headers });
    expect(ok.json().sender).toMatchObject({ identityCheck: "verified", registrationStatus: "complete", identityLabel: "ASENDER" });
    const on = await ctx.app.inject({ method: "POST", url: `${a.base}/sender/sending`, headers: a.headers, payload: { sending: true } });
    expect(on.json().sender.sendingEnabled).toBe(true);
    // A missing identity is reported as such.
    await ctx.app.inject({ method: "PUT", url: `${a.base}/sender`, headers: a.headers, payload: senderBody("NOSUCH") });
    expect((await ctx.app.inject({ method: "POST", url: `${a.base}/sender/verify`, headers: a.headers })).json().sender.identityCheck).toBe("not_found");
    // The shared sender works only while it is named in SMS_SHARED_SENDER.
    identity("SHARED", { "bizinsights:shared": "true" });
    await ctx.app.inject({ method: "PUT", url: `${a.base}/sender`, headers: a.headers, payload: senderBody("SHARED") });
    expect((await ctx.app.inject({ method: "POST", url: `${a.base}/sender/verify`, headers: a.headers })).json().sender.identityCheck).toBe("not_allowed");
    ctx.setEnv({ SMS_SHARED_SENDER: "SHARED" });
    expect((await ctx.app.inject({ method: "POST", url: `${a.base}/sender/verify`, headers: a.headers })).json().sender.identityCheck).toBe("verified");
  });

  it("refuses to turn sending on with a budget of 0, and records who chose the basis for order updates", async () => {
    const o = await owner();
    identity("OSENDER", { "bizinsights:workspace": o.ws });
    await ctx.app.inject({ method: "PUT", url: `${o.base}/sender`, headers: o.headers, payload: { ...senderBody("OSENDER"), monthlyBudgetUsd: 0 } });
    await ctx.app.inject({ method: "POST", url: `${o.base}/sender/verify`, headers: o.headers });
    const on = await ctx.app.inject({ method: "POST", url: `${o.base}/sender/sending`, headers: o.headers, payload: { sending: true } });
    expect(on.statusCode).toBe(409);
    expect(on.json().error).toBe("no_budget");
    const row = await systemDb.smsSenderConfiguration.findUniqueOrThrow({ where: { storeId: o.store.id } });
    expect(row.transactionalBasisBy).toBe(o.user.id);
    expect(await systemDb.smsAuditLog.count({ where: { storeId: o.store.id, action: "sender_created" } })).toBe(1);
  });
});

describe("templates", () => {
  it("refuses a marketing template without an opt-out link, and previews encoding, parts and cost", async () => {
    const o = await owner();
    const bad = await ctx.app.inject({ method: "POST", url: `${o.base}/templates`, headers: o.headers, payload: { name: "Sale", category: "marketing", body: "Big sale at {{store_name}}" } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe("template_invalid");
    const preview = await ctx.app.inject({ method: "POST", url: `${o.base}/templates/preview`, headers: o.headers, payload: { category: "transactional", body: "Hi {{customer_name}} – order {{order_number}}", countries: ["AU"] } });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ text: "Hi Sam – order #1042", segments: { encoding: "UCS2", segments: 1 } });
    // No price is invented: none was billed yet and the price list is empty.
    expect(preview.json().prices).toEqual([{ country: "AU", perPartUsd: null, source: null, estimateUsd: null, worstUsd: null }]);
  });

  it("keeps sending the approved version while an edit waits for approval, with each version in the history", async () => {
    const o = await owner();
    const created = await ctx.app.inject({ method: "POST", url: `${o.base}/templates`, headers: o.headers, payload: { name: "Shipped", category: "transactional", body: "Order {{order_number}} shipped." } });
    expect(created.statusCode).toBe(201);
    const id = created.json().template.id;
    expect((await ctx.app.inject({ method: "POST", url: `${o.base}/templates/${id}/approve`, headers: o.headers, payload: {} })).statusCode).toBe(409);
    await ctx.app.inject({ method: "POST", url: `${o.base}/templates/${id}/submit`, headers: o.headers, payload: {} });
    const approved = await ctx.app.inject({ method: "POST", url: `${o.base}/templates/${id}/approve`, headers: o.headers, payload: {} });
    expect(approved.json().template).toMatchObject({ status: "approved", approvedVersion: 1 });
    const edited = await ctx.app.inject({ method: "PUT", url: `${o.base}/templates/${id}`, headers: o.headers, payload: { name: "Shipped", category: "transactional", body: "Good news: order {{order_number}} shipped." } });
    expect(edited.json().template).toMatchObject({ status: "draft", latestVersion: 2, approvedVersion: 1, approvedBody: "Order {{order_number}} shipped." });
    const detail = await ctx.app.inject({ method: "GET", url: `${o.base}/templates/${id}`, headers: o.headers });
    expect(detail.json().versions.map((v: { version: number; status: string }) => [v.version, v.status])).toEqual([
      [2, "draft"],
      [1, "approved"],
    ]);
    expect(detail.json().history.map((h: { action: string }) => h.action)).toEqual(["template_edited", "template_approved", "template_submitted", "template_created"]);
  });
});

describe("rules", () => {
  it("won't approve a rule whose template doesn't fit its event, and approves one that does", async () => {
    const o = await owner();
    const mk = async (category: string, body: string) => {
      const t = (await ctx.app.inject({ method: "POST", url: `${o.base}/templates`, headers: o.headers, payload: { name: `T${Math.random()}`, category, body } })).json().template.id;
      await ctx.app.inject({ method: "POST", url: `${o.base}/templates/${t}/submit`, headers: o.headers, payload: {} });
      await ctx.app.inject({ method: "POST", url: `${o.base}/templates/${t}/approve`, headers: o.headers, payload: {} });
      return t;
    };
    const transactional = await mk("transactional", "Order {{order_number}} confirmed.");
    const promo = await mk("marketing", "{{store_name}}: come back! Opt out: {{opt_out_url}}");
    const wrong = await ctx.app.inject({ method: "POST", url: `${o.base}/rules`, headers: o.headers, payload: { name: "Cart", trigger: "checkout_abandoned", templateId: transactional, delayMinutes: 60 } });
    expect(wrong.statusCode).toBe(201);
    const refused = await ctx.app.inject({ method: "POST", url: `${o.base}/rules/${wrong.json().rule.id}/submit`, headers: o.headers, payload: {} });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().message).toMatch(/marketing template/);
    const rule = (await ctx.app.inject({ method: "POST", url: `${o.base}/rules`, headers: o.headers, payload: { name: "Cart", trigger: "checkout_abandoned", templateId: promo, delayMinutes: 60 } })).json().rule;
    expect(rule).toMatchObject({ status: "draft", dryRun: true, unapprovedVersion: true });
    await ctx.app.inject({ method: "POST", url: `${o.base}/rules/${rule.id}/submit`, headers: o.headers, payload: {} });
    const approved = await ctx.app.inject({ method: "POST", url: `${o.base}/rules/${rule.id}/approve`, headers: o.headers, payload: {} });
    expect(approved.json().rule).toMatchObject({ status: "active", activeVersion: 1, awaitingApproval: false });
    // An edit leaves version 1 running until version 2 is approved.
    const edited = await ctx.app.inject({ method: "PUT", url: `${o.base}/rules/${rule.id}`, headers: o.headers, payload: { name: "Cart", trigger: "checkout_abandoned", templateId: promo, delayMinutes: 120 } });
    expect(edited.json().rule).toMatchObject({ status: "active", version: 2, activeVersion: 1, unapprovedVersion: true });
    expect(edited.json().rule.activeConfig.delayMinutes).toBe(60);
    // Birthday isn't available on Shopify's data.
    const birthday = await ctx.app.inject({ method: "POST", url: `${o.base}/rules`, headers: o.headers, payload: { name: "B", trigger: "customer_birthday", templateId: promo } });
    expect(birthday.statusCode).toBe(400);
  });
});

describe("test numbers", () => {
  it("verifies a test number with AWS's code before any test text goes to it", async () => {
    const o = await owner();
    identity("OSENDER", { "bizinsights:workspace": o.ws });
    await ctx.app.inject({ method: "PUT", url: `${o.base}/sender`, headers: o.headers, payload: senderBody("OSENDER") });
    await ctx.app.inject({ method: "POST", url: `${o.base}/sender/verify`, headers: o.headers });
    const added = await ctx.app.inject({ method: "POST", url: `${o.base}/test-numbers`, headers: o.headers, payload: { number: "0412 345 678", country: "AU" } });
    expect(added.statusCode).toBe(201);
    expect(added.json().testNumber).toMatchObject({ status: "pending", number: expect.stringMatching(/^\+61 •+ 678$/) });
    const id = added.json().testNumber.id;
    const t = (await ctx.app.inject({ method: "POST", url: `${o.base}/templates`, headers: o.headers, payload: { name: "Draft", category: "transactional", body: "Order {{order_number}} confirmed." } })).json().template.id;
    expect((await ctx.app.inject({ method: "POST", url: `${o.base}/templates/${t}/test`, headers: o.headers, payload: { testNumberId: id } })).statusCode).toBe(409);
    expect((await ctx.app.inject({ method: "POST", url: `${o.base}/test-numbers/${id}/verify`, headers: o.headers, payload: { code: "000000" } })).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: "POST", url: `${o.base}/test-numbers/${id}/verify`, headers: o.headers, payload: { code: sms.verificationCode } })).json().testNumber.status).toBe("verified");
    // A draft template can be tried on the team's own verified number (it never goes to a customer).
    const sent = await ctx.app.inject({ method: "POST", url: `${o.base}/templates/${t}/test`, headers: o.headers, payload: { testNumberId: id } });
    expect(sent.statusCode).toBe(200);
    expect(sent.json().message).toMatchObject({ purpose: "test", status: "accepted", text: "Order #1042 confirmed." });
    expect(sms.sent).toHaveLength(1);
    expect(sms.sent[0]!.destination).toBe("+61412345678");
  });
});

describe("the opt-out page", () => {
  it("shows whose texts a code stops, changes nothing until confirmed, then stops them", async () => {
    const o = await owner();
    const code = "Ab3dE9xYz1";
    const hash = smsPhoneHash(o.store.id, "+61412345678");
    await systemDb.smsMessageJob.create({ data: { workspaceId: o.ws, storeId: o.store.id, dedupeKey: "k", purpose: "campaign", category: "marketing", sendAfter: new Date(), status: "accepted", phoneHash: hash, phoneMasked: "+61 •••••• 678", optOutCodeHash: sha256Hex(code) } });
    const look = await ctx.app.inject({ method: "GET", url: `/sms/u/${code}` });
    expect(look.json()).toEqual({ business: "Green Leaf", number: "+61 •••••• 678", stopped: "none" });
    expect(await systemDb.smsSuppression.count()).toBe(0);
    const stop = await ctx.app.inject({ method: "POST", url: `/sms/u/${code}`, headers: { origin: "http://localhost:3001" }, payload: { scope: "marketing" } });
    expect(stop.json()).toMatchObject({ ok: true, stopped: "marketing" });
    expect(await systemDb.smsSuppression.findFirstOrThrow({ where: { storeId: o.store.id } })).toMatchObject({ phoneHash: hash, scope: "marketing", reason: "opt_out_link" });
    expect((await ctx.app.inject({ method: "GET", url: "/sms/u/nosuchcode1" })).statusCode).toBe(404);
    // The merchant can't lift an opt-out the customer made.
    const list = await ctx.app.inject({ method: "GET", url: `${o.base}/suppressions`, headers: o.headers });
    expect(list.json().suppressions[0]).toMatchObject({ reason: "opt_out_link", liftable: false });
    expect((await ctx.app.inject({ method: "DELETE", url: `${o.base}/suppressions/${list.json().suppressions[0].id}`, headers: o.headers })).statusCode).toBe(409);
  });
});

describe("figures", () => {
  it("answers the overview, analytics and billing from the rows, with nothing invented", async () => {
    const o = await owner();
    const overview = await ctx.app.inject({ method: "GET", url: o.base, headers: o.headers });
    expect(overview.json()).toMatchObject({ mode: "sandbox", sender: null, last7Days: { requested: 0, deliveryRate: null }, spend: { totalUsd: 0, usedPct: null } });
    const analytics = await ctx.app.inject({ method: "GET", url: `${o.base}/analytics?period=7d`, headers: o.headers });
    expect(analytics.statusCode).toBe(200);
    expect(analytics.json()).toMatchObject({ totals: { requested: 0, deliveryRate: null }, costUsd: 0, attribution: { orders: 0, roi: null } });
    expect(analytics.json().attributionRule).toMatch(/not orders a text caused/);
    expect((await ctx.app.inject({ method: "GET", url: `${o.base}/analytics?period=custom&from=2026-10-30&to=2026-10-01`, headers: o.headers })).statusCode).toBe(400);
    const billing = await ctx.app.inject({ method: "GET", url: `${o.base}/billing`, headers: o.headers });
    expect(billing.json()).toMatchObject({ budgetUsd: 0, billedUsd: 0, usedPct: null, byCountry: [] });
  });
});

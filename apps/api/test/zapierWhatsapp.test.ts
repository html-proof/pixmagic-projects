import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { processWebhookEvent, sendQueuedMessage } from "@app/core";
import { systemDb } from "@app/db";
import { EVOLUTION_ENV, evolutionFake, type EvolutionFake } from "../../../test-support/evolutionFake.js";
import { clean, createStore, createWorkspace, setup, signIn, teardown, type TestCtx } from "./helpers.js";

/**
 * Zapier's action "Send WhatsApp Template Message" (docs/zapier.md; core zapier/whatsapp.ts): the
 * scope ticked on the consent page (offered to owners and admins only), the template dropdown, and a
 * Zap's message going out through the store's own WhatsApp with every rule the WhatsApp page keeps:
 * consent (a lead needs their own), STOP, templates only (on Meta's Business Platform, ones Meta
 * approved, sent by Meta's name), its values, once per key, Pause all automation, the member's
 * permission. Real Postgres; Evolution API is test-support/evolutionFake.ts; nothing leaves the process.
 */

let ctx: TestCtx;
let evo: EvolutionFake;
const CLIENT_ID = "bizinsights-zapier-test";
const CLIENT_SECRET = randomBytes(32).toString("base64url");
const REDIRECT = "https://zapier.com/dashboard/auth/oauth/return/App4242CLIAPI/";
const ZAPIER_ENV = { ZAPIER_CLIENT_ID: CLIENT_ID, ZAPIER_CLIENT_SECRET: CLIENT_SECRET, ZAPIER_REDIRECT_URI: REDIRECT, ZAPIER_INVITE_URL: "https://zapier.com/developer/public-invite/1/abc/" };
const WEBHOOK_BASE = "https://bizinsights.test/api";
const LEAD = "+61412345678";

beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => {
  ctx.setEnv({ EVOLUTION_API_URL: "", EVOLUTION_API_KEY: "", EVOLUTION_WEBHOOK_URL: "" });
  await teardown(ctx);
});
beforeEach(async () => {
  await clean(ctx);
  evo = evolutionFake();
  ctx.setFetch(evo.fetch);
  ctx.setEnv({ ...EVOLUTION_ENV, EVOLUTION_WEBHOOK_URL: WEBHOOK_BASE, ...ZAPIER_ENV });
});

type Method = "GET" | "POST" | "PUT" | "DELETE";

function ok<T = any>(res: { statusCode: number; body: string; json(): any }, status = 200): T { // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(res.statusCode, res.body).toBe(status);
  return res.json();
}

async function owner(uid = "zw-owner", email = "owner@zapwa.test") {
  const s = await signIn(ctx, uid, email);
  const ws = await createWorkspace(ctx, s.headers, "Green Leaf");
  const store = await createStore(ws, `${uid}.myshopify.com`, ["read_orders", "read_customers"], { name: "Green Leaf", currency: "AUD" });
  const base = `/workspaces/${ws}/stores/${store.id}/whatsapp`;
  const call = (method: Method, path = "", payload?: unknown, headers = s.headers) => ctx.app.inject({ method, url: `${base}${path}`, headers, ...(payload === undefined ? {} : { payload }) });
  return { ...s, ws, store, base, call };
}
type Owner = Awaited<ReturnType<typeof owner>>;

/** Delivers a webhook the way Evolution posts it. */
const deliver = (w: { url: string; headers: Record<string, string>; body: string }) => ctx.app.inject({ method: "POST", url: w.url, headers: w.headers, payload: w.body });

/** A phone linked with the QR code (Evolution's webhook says the connection is open), and Settings saved. */
async function whatsapp(o: Owner, settings: Record<string, unknown> = {}, phone = "61400000099") {
  ok(await o.call("POST", "/connection", { method: "qr" }), 201);
  const name = (await systemDb.wappConnection.findUniqueOrThrow({ where: { storeId: o.store.id } })).instanceName!;
  evo.open(name, phone, "Green Leaf");
  ok(await deliver(evo.webhook(name, "connection.update", { instance: name, wuid: `${phone}@s.whatsapp.net`, profileName: "Green Leaf", state: "open", statusReason: 200 })));
  ok(
    await o.call("PUT", "/settings", {
      businessName: "Green Leaf",
      orderUpdates: "checkout_notice",
      marketingEnabled: true,
      shopifySmsConsent: false,
      sendWindow: { start: 0, end: 24 },
      timeZone: "UTC",
      dailyLimit: 200,
      perCustomerDailyLimit: 3,
      retentionDays: 90,
      ...settings,
    }),
  );
  return name;
}

/** A template written on the WhatsApp page. */
async function template(o: Owner, t: { name: string; category: "transactional" | "marketing"; body: string; active?: boolean }) {
  return ok(await o.call("POST", "/templates", { active: true, ...t }), 201).template as { id: string; name: string };
}

/** A customer's message to the store's number, as Evolution reports it. */
const inbound = (name: string, from: string, text: string) =>
  evo.webhook(name, "messages.upsert", {
    key: { remoteJid: `${from.replace(/^\+/, "")}@s.whatsapp.net`, fromMe: false, id: `IN${Math.random().toString(16).slice(2, 14).toUpperCase()}` },
    pushName: "Pat",
    message: { conversation: text },
    messageType: "conversation",
    messageTimestamp: Math.floor(Date.now() / 1000),
  });

/** The worker, in-process: sends what waits on the whatsapp queue now, and applies stored webhook events. */
async function drain(): Promise<string[]> {
  const out: string[] = [];
  for (let round = 0; round < 10; round++) {
    const sent = ctx.deps.queues.sent.whatsapp.splice(0);
    const opts = ctx.deps.queues.sentOpts.whatsapp.splice(0);
    const jobs = sent.filter((_, i) => (opts[i]?.delaySeconds ?? 0) <= 10);
    if (!jobs.length) break;
    for (const j of jobs) {
      if (j.kind === "wapp_send") {
        for (const c of await systemDb.wappConnection.findMany({ select: { id: true } })) await ctx.deps.coord.release(`wapp:pace:${c.id}`);
        out.push(await sendQueuedMessage(ctx.deps, j.messageId));
      } else if (j.kind === "wapp_event") out.push(await processWebhookEvent(ctx.deps, j.eventId));
    }
  }
  return out;
}

const authorizeQuery = () => new URLSearchParams({ client_id: CLIENT_ID, redirect_uri: REDIRECT, response_type: "code", state: "st" }).toString();

/** Zapier connected on the consent page (with the scopes ticked), the code exchanged by Zapier's server. */
async function zapier(headers: Record<string, string>, ws: string, storeId: string, scopes: string[] = ["whatsapp_send"]) {
  const allowed = ok(await ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/stores/${storeId}/zapier/authorize`, headers, payload: { client_id: CLIENT_ID, redirect_uri: REDIRECT, response_type: "code", state: "st", scopes } }));
  const code = new URL(allowed.redirect).searchParams.get("code")!;
  const res = await ctx.app.inject({
    method: "POST",
    url: "/oauth/token",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: CLIENT_ID, client_secret: CLIENT_SECRET }).toString(),
  });
  return ok<{ access_token: string }>(res).access_token;
}

const zget = (t: string, url: string) => ctx.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${t}` } });
let keys = 0;
/** The action as Zapier posts it; a fresh Unique key unless the test gives one. */
const zsend = (t: string, payload: Record<string, unknown>) =>
  ctx.app.inject({ method: "POST", url: "/zapier/whatsapp/messages", headers: { authorization: `Bearer ${t}` }, payload: { unique_key: `lead-${++keys}`, ...payload } });

describe("allowing Zapier to send WhatsApp messages (the consent page)", () => {
  it("is offered to owners and admins only, unticked unless chosen, and kept on the connection", async () => {
    const o = await owner();
    const page = ok(await ctx.app.inject({ method: "GET", url: `/oauth/zapier/authorize?${authorizeQuery()}`, headers: o.headers }));
    expect(page.workspaces[0]).toMatchObject({ id: o.ws, allowed: true, scopes: ["whatsapp_send"] });

    // A manager who may connect Zapier, but not send from the WhatsApp page.
    const manager = await signIn(ctx, "zw-manager", "manager@zapwa.test");
    await systemDb.membership.create({ data: { workspaceId: o.ws, userId: manager.user.id, role: "manager", permissions: ["integrations.status", "integrations.manage", "marketing.campaigns"] } });
    const theirs = ok(await ctx.app.inject({ method: "GET", url: `/oauth/zapier/authorize?${authorizeQuery()}`, headers: manager.headers }));
    expect(theirs.workspaces[0]).toMatchObject({ allowed: true, scopes: [] });
    const refused = await ctx.app.inject({ method: "POST", url: `/workspaces/${o.ws}/stores/${o.store.id}/zapier/authorize`, headers: manager.headers, payload: { client_id: CLIENT_ID, redirect_uri: REDIRECT, response_type: "code", state: "st", scopes: ["whatsapp_send"] } });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().message).toContain("owners and admins");
    // Without it the manager connects as before, and the connection can't send.
    const plain = await zapier(manager.headers, o.ws, o.store.id, []);
    expect(ok(await zget(plain, "/zapier/me")).scopes).toEqual([]);
    for (const res of [await zget(plain, "/zapier/whatsapp/templates"), await zsend(plain, { template_id: "x", phone: LEAD })]) {
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("scope_missing");
    }

    const t = await zapier(o.headers, o.ws, o.store.id);
    expect(ok(await zget(t, "/zapier/me")).scopes).toEqual(["whatsapp_send"]);
    const grant = await systemDb.zapierGrant.findFirstOrThrow({ where: { userId: o.user.id } });
    expect(grant.scopes).toEqual(["whatsapp_send"]);
    expect(await systemDb.auditLog.findFirstOrThrow({ where: { action: "zapier.connected", targetId: grant.id } })).toMatchObject({ metadata: { scopes: ["whatsapp_send"] } });
    // Settings → Integrations says so.
    const card = ok(await ctx.app.inject({ method: "GET", url: `/workspaces/${o.ws}/stores/${o.store.id}/zapier`, headers: o.headers }));
    expect(card.connections.find((c: { id: string }) => c.id === grant.id).scopes).toEqual(["whatsapp_send"]);
    // Anything else in `scopes` is refused, never stored.
    const unknown = await ctx.app.inject({ method: "POST", url: `/workspaces/${o.ws}/stores/${o.store.id}/zapier/authorize`, headers: o.headers, payload: { client_id: CLIENT_ID, redirect_uri: REDIRECT, response_type: "code", state: "st", scopes: ["admin"] } });
    expect(unknown.statusCode).toBe(400);
  });
});

describe("Send WhatsApp Template Message", () => {
  it("sends a lead who agreed a template with the Zap's values, records their consent, and sends once per key", async () => {
    const o = await owner();
    const name = await whatsapp(o);
    const tmpl = await template(o, { name: "Quote ready", category: "transactional", body: "Hi {{customer_first_name}}, {{store_name}} here: your quote {{order_number}} is ready." });
    // Switched off: never listed, never sent.
    const off = await template(o, { name: "Old", category: "transactional", body: "Hello from {{store_name}}.", active: false });
    const t = await zapier(o.headers, o.ws, o.store.id);

    const list = ok(await zget(t, "/zapier/whatsapp/templates"));
    expect(list).toEqual([expect.objectContaining({ id: tmpl.id, name: "Quote ready", category: "transactional", variables: ["customer_first_name", "order_number"], automatic: ["store_name"] })]);

    const switchedOff = await zsend(t, { template_id: off.id, phone: LEAD, customer_agreed: true });
    expect(switchedOff.statusCode).toBe(409);
    expect(switchedOff.json().error).toBe("template_unavailable");

    // A number bizinsights knows only from the Zap: "Customers told at checkout" doesn't cover it.
    const noConsent = await zsend(t, { template_id: tmpl.id, phone: LEAD, values: { order_number: "Q-77" }, first_name: "Sam", customer_agreed: false });
    expect(noConsent.statusCode).toBe(409);
    expect(noConsent.json()).toMatchObject({ error: "not_allowed" });
    expect(noConsent.json().message).toContain("The customer agreed to WhatsApp messages from you");

    const missing = await zsend(t, { template_id: tmpl.id, phone: LEAD, first_name: "Sam", customer_agreed: "yes" });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ error: "missing_values" });
    expect(missing.json().message).toContain("{{order_number}}");

    const sent = await zsend(t, { template_id: tmpl.id, phone: "0412 345 678", country: "AU", values: { order_number: " Q-77\n" }, first_name: "Sam", customer_agreed: "yes", consent_note: "Meta lead form: WhatsApp box", unique_key: "lead-1", zap_id: 4242 });
    const queued = ok(sent, 201);
    expect(queued).toMatchObject({ status: "queued", duplicate: false, phone_masked: expect.stringContaining("678"), template: { id: tmpl.id, name: "Quote ready" }, consent_recorded: true });
    expect(JSON.stringify(queued)).not.toContain("412345678");
    expect(await drain()).toEqual(["accepted"]);
    // A linked phone sends the template's text, filled in.
    expect(evo.sends.at(-1)).toMatchObject({ instance: name, path: "sendText", body: { number: "61412345678", text: "Hi Sam, Green Leaf here: your quote Q-77 is ready." } });

    const message = await systemDb.wappMessage.findUniqueOrThrow({ where: { id: queued.id } });
    expect(message).toMatchObject({ source: "zapier", category: "transactional", templateId: tmpl.id, status: "accepted" });
    const contact = await systemDb.wappContact.findUniqueOrThrow({ where: { id: message.contactId! } });
    expect(contact.optedIn).toBe(true);
    expect(await systemDb.wappConsentEvent.findFirstOrThrow({ where: { contactId: contact.id } })).toMatchObject({ scope: "order_updates", status: "opted_in", source: "zapier", actorUserId: o.user.id, note: "A Zap said the customer agreed: Meta lead form: WhatsApp box" });
    expect(await systemDb.auditLog.findFirstOrThrow({ where: { action: "whatsapp.message_sent", targetId: message.id } })).toMatchObject({ actorUserId: o.user.id, metadata: { via: "zapier", zapId: "4242", recordedConsent: true } });
    // The WhatsApp page lists it as sent by Zapier.
    const listed = ok(await o.call("GET", "/messages?source=zapier")).messages;
    expect(listed.map((m: { id: string }) => m.id)).toEqual([message.id]);

    // The same key (Zapier replaying the step): the first message, nothing sent again.
    const sends = evo.sends.length;
    const again = ok(await zsend(t, { template_id: tmpl.id, phone: LEAD, values: { order_number: "Q-77" }, customer_agreed: true, unique_key: "lead-1" }));
    expect(again).toMatchObject({ id: message.id, duplicate: true });
    await drain();
    expect(evo.sends).toHaveLength(sends);

    // Zapier connected again (a new grant), or by another owner: the same key still finds the first message.
    const second = await signIn(ctx, "zw-admin2", "admin2@zapwa.test");
    await systemDb.membership.create({ data: { workspaceId: o.ws, userId: second.user.id, role: "admin" } });
    for (const tok of [await zapier(o.headers, o.ws, o.store.id), await zapier(second.headers, o.ws, o.store.id)]) {
      expect(ok(await zsend(tok, { template_id: tmpl.id, phone: LEAD, values: { order_number: "Q-77" }, customer_agreed: true, unique_key: "lead-1" }))).toMatchObject({ id: message.id, duplicate: true });
    }
    await drain();
    expect(evo.sends).toHaveLength(sends);

    // Consent stands now: the next message to that customer needs no "agreed" from the Zap.
    ok(await zsend(t, { template_id: tmpl.id, phone: LEAD, values: { order_number: "Q-78" } }), 201);
    await drain();
    expect(evo.sends.at(-1)!.body.text).toBe("Hi Sam, Green Leaf here: your quote Q-78 is ready.");

    // Another template with the same lead's key (a follow-up Zap) is another message.
    const followUp = await template(o, { name: "Follow up", category: "transactional", body: "Still thinking about it, {{customer_first_name}}? {{store_name}} is here to help." });
    expect(ok(await zsend(t, { template_id: followUp.id, phone: LEAD, unique_key: "lead-1" }), 201).duplicate).toBe(false);

    // Without a key nothing goes: the action needs one.
    const noKey = await ctx.app.inject({ method: "POST", url: "/zapier/whatsapp/messages", headers: { authorization: `Bearer ${t}` }, payload: { template_id: tmpl.id, phone: LEAD, values: { order_number: "Q-79" }, unique_key: " " } });
    expect(noKey.statusCode).toBe(400);
    expect(noKey.json().message).toContain("Unique key");
  });

  it("on Meta's Business Platform, offers and sends only templates Meta approved, by Meta's name", async () => {
    const o = await owner();
    const name = await whatsapp(o);
    // The same instance stands in for one of Evolution's WHATSAPP-BUSINESS ones: only the provider decides here.
    await systemDb.wappConnection.update({ where: { storeId: o.store.id }, data: { provider: "cloud_api", phoneNumberId: "1098765432101", wabaId: "2098765432101" } });
    const approved = await systemDb.wappTemplate.create({
      data: { workspaceId: o.ws, storeId: o.store.id, name: "Quote ready", category: "transactional", body: "Hi {{customer_first_name}}, {{store_name}} here: your quote {{order_number}} is ready.", metaName: "quote_ready", metaLanguage: "en", metaStatus: "APPROVED" },
    });
    const pending = await systemDb.wappTemplate.create({
      data: { workspaceId: o.ws, storeId: o.store.id, name: "Pending", category: "transactional", body: "Hello from {{store_name}}.", metaName: "pending_one", metaLanguage: "en", metaStatus: "PENDING" },
    });
    const notSubmitted = await template(o, { name: "Draft", category: "transactional", body: "Hello again from {{store_name}}." });
    const t = await zapier(o.headers, o.ws, o.store.id);

    expect(ok(await zget(t, "/zapier/whatsapp/templates")).map((x: { id: string }) => x.id)).toEqual([approved.id]);
    for (const id of [pending.id, notSubmitted.id]) {
      const res = await zsend(t, { template_id: id, phone: LEAD, customer_agreed: true });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("template_unavailable");
    }

    ok(await zsend(t, { template_id: approved.id, phone: LEAD, values: { order_number: "Q-77" }, first_name: "Sam", customer_agreed: true }), 201);
    expect(await drain()).toEqual(["accepted"]);
    expect(evo.sends.at(-1)).toMatchObject({
      instance: name,
      path: "sendTemplate",
      body: { name: "quote_ready", language: "en", components: [{ type: "body", parameters: [{ type: "text", text: "Sam" }, { type: "text", text: "Green Leaf" }, { type: "text", text: "Q-77" }] }] },
    });
  });

  it("keeps WhatsApp's rules: STOP, marketing consent, Pause all automation, the store's own templates, the member's permission", async () => {
    const o = await owner();
    const name = await whatsapp(o);
    const update = await template(o, { name: "Thanks", category: "transactional", body: "Thanks for your enquiry, {{store_name}} will be in touch." });
    const promo = await template(o, { name: "Promo", category: "marketing", body: "Spring sale at {{store_name}}: 20% off this week. Reply STOP to opt out." });
    const t = await zapier(o.headers, o.ws, o.store.id);

    // Marketing: only with the customer's marketing yes.
    const noMarketing = await zsend(t, { template_id: promo.id, phone: LEAD });
    expect(noMarketing.statusCode).toBe(409);
    expect(noMarketing.json().message).toContain("marketing");
    const promoSent = ok(await zsend(t, { template_id: promo.id, phone: LEAD, customer_agreed: true, consent_note: "Google Ads lead form" }), 201);
    await drain();
    expect(evo.sends.at(-1)!.body.text).toContain("Spring sale at Green Leaf");
    expect((await systemDb.wappContact.findFirstOrThrow({ where: { storeId: o.store.id } })).marketing).toBe("opted_in");
    expect(promoSent.consent_recorded).toBe(true);

    // The customer replies STOP: the Zap can't opt them back in.
    ok(await deliver(inbound(name, LEAD, "STOP")));
    await drain();
    const stopped = await zsend(t, { template_id: update.id, phone: LEAD, customer_agreed: true });
    expect(stopped.statusCode).toBe(409);
    expect(stopped.json().error).toBe("opted_out");

    // Pause all automation holds a Zap's messages too.
    ok(await o.call("POST", "/settings/pause", { paused: true }));
    const held = ok(await zsend(t, { template_id: update.id, phone: "+61412000111", customer_agreed: true }), 201);
    const before = evo.sends.length;
    await drain();
    expect(evo.sends).toHaveLength(before);
    expect(await systemDb.wappMessage.findUniqueOrThrow({ where: { id: held.id } })).toMatchObject({ status: "queued", reason: "automation_paused" });

    // Another store's template is never found.
    const other = await owner("zw-other", "other@zapwa.test");
    await whatsapp(other, {}, "61400000088");
    const theirs = await template(other, { name: "Theirs", category: "transactional", body: "Hello from {{store_name}}." });
    const cross = await zsend(t, { template_id: theirs.id, phone: "+61412000222", customer_agreed: true });
    expect(cross.statusCode).toBe(400);
    expect(cross.json().error).toBe("template_not_found");

    // An admin who connected it, demoted to a manager who may still manage integrations: no more sends.
    const admin = await signIn(ctx, "zw-admin", "admin@zapwa.test");
    const m = await systemDb.membership.create({ data: { workspaceId: o.ws, userId: admin.user.id, role: "admin" } });
    const ta = await zapier(admin.headers, o.ws, o.store.id);
    await systemDb.membership.update({ where: { id: m.id }, data: { role: "manager", permissions: ["integrations.status", "integrations.manage", "marketing.campaigns"] } });
    const demoted = await zsend(ta, { template_id: update.id, phone: "+61412000333", customer_agreed: true });
    expect(demoted.statusCode).toBe(403);
    expect(demoted.json().error).toBe("no_permission");
  });

  it("says WhatsApp isn't connected, and refuses a number that isn't one", async () => {
    const o = await owner();
    const t = await zapier(o.headers, o.ws, o.store.id);
    const res = await zsend(t, { template_id: "x", phone: LEAD, customer_agreed: true });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("not_connected");
    await whatsapp(o);
    const bad = await zsend(t, { template_id: "x", phone: "not a number 123456", customer_agreed: true });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe("invalid_phone");
  });
});

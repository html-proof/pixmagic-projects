import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectDb, systemDb, type Prisma, type Store } from "@app/db";
import { resetDb } from "@app/db/testing";
import {
  applyMetaWebhook,
  checkConnections,
  encryptTokenFields,
  memoryBlobs,
  memoryCoord,
  memoryMailer,
  memoryQueues,
  sendWhatsappMessage,
  sweepWhatsapp,
  waEncrypt,
  whatsappOnShopifyEvent,
  type FetchLike,
} from "@app/core";
import { TEMPLATE_LIBRARY, WA_MAX_ATTEMPTS, whatsappConfigSchema, type NotificationKind } from "@app/shared";
import { processWebhook, type WorkerDeps } from "../src/handlers.js";
import { consume, type QueueMessage } from "../src/index.js";

/**
 * WhatsApp end to end inside the worker: Shopify events → timeline and messages → the sender
 * (with Meta faked) → delivery callbacks. Real Postgres; nothing leaves the process.
 */

const queues = memoryQueues();
const coord = memoryCoord();
let fetchImpl: FetchLike;
let deps: WorkerDeps;

interface Sent {
  to: string;
  template: string;
  components: Array<{ type: string; parameters: Array<{ text?: string }> }>;
}
let sent: Sent[];
let metaError: { status: number; code: number; message?: string } | null;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeAll(() => {
  deps = { coord, queues, payloads: memoryBlobs(), mailer: memoryMailer(), fetchImpl: ((...a: Parameters<FetchLike>) => fetchImpl(...a)) as FetchLike };
});
afterAll(async () => disconnectDb());
beforeEach(async () => {
  await resetDb();
  queues.clear();
  coord.clear();
  sent = [];
  metaError = null;
  fetchImpl = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "graph.facebook.com" && url.pathname.endsWith("/messages")) {
      if (metaError) return json({ error: { code: metaError.code, message: metaError.message ?? "error", type: "OAuthException" } }, metaError.status);
      const b = JSON.parse(String(init?.body));
      sent.push({ to: b.to, template: b.template.name, components: b.template.components ?? [] });
      return json({ messaging_product: "whatsapp", messages: [{ id: `wamid.${sent.length}` }] });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
});

/** Library templates as Meta would hold them once approved. */
function templateComponents(name: string) {
  const t = TEMPLATE_LIBRARY.find((x) => x.name === name)!;
  const out: Array<Record<string, unknown>> = [{ type: "BODY", text: t.body }];
  const buttons: Array<Record<string, unknown>> = [];
  if (t.urlButton) buttons.push({ type: "URL", text: t.urlButton.text, url: `https://insights.test${t.urlButton.path}{{1}}` });
  if (t.stopButton) buttons.push({ type: "QUICK_REPLY", text: "Stop promotions" });
  if (buttons.length) out.push({ type: "BUTTONS", buttons });
  return out;
}

const KIND_TEMPLATE: Partial<Record<NotificationKind, string>> = {
  order_confirmation: "insights_order_confirmation",
  payment_confirmed: "insights_payment_confirmed",
  order_shipped: "insights_order_shipped",
  out_for_delivery: "insights_out_for_delivery",
  order_delivered: "insights_order_delivered",
  delivery_failed: "insights_delivery_failed",
  order_cancelled: "insights_order_cancelled",
  review_request: "insights_review_request",
  abandoned_cart_1: "insights_cart_reminder",
  abandoned_cart_2: "insights_cart_reminder",
};

async function setupStore(opts: { basis?: string; smsCounts?: boolean; kinds?: NotificationKind[]; timezone?: string; connected?: boolean } = {}) {
  const ws = await systemDb.workspace.create({ data: { name: "W" } });
  let store = await systemDb.store.create({
    data: { workspaceId: ws.id, shopDomain: `s${Math.random().toString(36).slice(2, 8)}.myshopify.com`, name: "Green Leaf", currency: "INR", grantedScopes: ["read_orders"], status: "active", timezone: opts.timezone ?? "UTC", pixelIngestKey: `pk-${Math.random()}` },
  });
  store = await systemDb.store.update({
    where: { id: store.id },
    data: encryptTokenFields(store.id, { accessToken: "shpat_x", scopes: ["read_orders"], accessTokenExpiresAt: null, refreshToken: null, refreshTokenExpiresAt: null }),
  });
  const kinds = opts.kinds ?? (Object.keys(KIND_TEMPLATE) as NotificationKind[]);
  const config = whatsappConfigSchema.parse({
    transactionalBasis: opts.basis ?? "checkout_notice",
    smsConsentCountsForMarketing: opts.smsCounts ?? false,
    // Equal ends: always open. (0 to 23 closed the window from 23:00 UTC, and the suite failed for that hour.)
    // Equal hours: no sending window, so these tests pass at any hour (0–23 held marketing during
    // 23:00 UTC). The API won't save this; "holds marketing outside the store's sending hours" sets a real one.
    sendWindowStart: 0,
    sendWindowEnd: 0,
    notifications: Object.fromEntries(
      kinds.map((k) => {
        const t = TEMPLATE_LIBRARY.find((x) => x.name === KIND_TEMPLATE[k])!;
        return [k, { enabled: true, templateName: t.name, language: "en", mapping: t.mapping }];
      }),
    ),
  });
  await systemDb.whatsappSettings.create({ data: { storeId: store.id, workspaceId: ws.id, config: config as unknown as Prisma.InputJsonValue } });
  if (opts.connected !== false) {
    const conn = await systemDb.whatsappConnection.create({
      data: {
        workspaceId: ws.id,
        storeId: store.id,
        mode: "embedded",
        wabaId: "1111111111",
        phoneNumberId: "2222222222",
        registered: true,
        status: "active",
        accessTokenEnc: waEncrypt(store.id, "access", "EAAtoken"),
        tokenKeyVersion: 1,
        webhookVerifiedAt: new Date(),
        messagingLimitTier: "TIER_1K",
      },
    });
    for (const t of TEMPLATE_LIBRARY) {
      await systemDb.whatsappTemplate.create({
        data: { workspaceId: ws.id, storeId: store.id, connectionId: conn.id, metaId: `m-${t.name}`, name: t.name, language: "en", category: t.category, status: "APPROVED", components: templateComponents(t.name) as Prisma.InputJsonValue },
      });
    }
  }
  return store;
}

let orderSeq = 5000;
const order = (over: Record<string, unknown> = {}) => ({
  id: ++orderSeq,
  name: `#${orderSeq}`,
  currency: "INR",
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  cancelled_at: null,
  financial_status: "paid",
  total_price: "1499.00",
  subtotal_price: "1499.00",
  phone: null,
  tags: "",
  checkout_token: null,
  customer: { id: 77, first_name: "Asha" },
  shipping_address: { first_name: "Asha", address1: "12 MG Road", city: "Kochi", zip: "682016", country: "India", country_code: "IN", phone: "098765 43210" },
  line_items: [{ id: 1, product_id: 10, title: "Kerala Saree", quantity: 1, price: "1499.00" }],
  fulfillments: [],
  ...over,
});

/** Run every queued WhatsApp job (and the ones they queue), like the sync queue consumer would. */
async function drain() {
  for (let i = 0; i < 50; i++) {
    const jobs = queues.sent.sync.splice(0) as unknown as Array<{ kind: string }>;
    const mine = jobs.filter((j) => j.kind === "whatsapp" || j.kind === "whatsapp_dispatch");
    if (!mine.length) return;
    for (const body of mine) {
      const msg: QueueMessage = { id: "q", body, attempts: 1, ack: () => {}, retry: () => {} };
      await consume("sync", msg, deps);
    }
  }
}

/** Make every scheduled message due now, then send. */
async function sendDue(storeId: string) {
  await systemDb.whatsappMessage.updateMany({ where: { storeId, status: "scheduled" }, data: { scheduledFor: new Date(Date.now() - 1000) } });
  for (const m of await systemDb.whatsappMessage.findMany({ where: { storeId, status: "scheduled" } })) await sendWhatsappMessage(m.id, deps);
}

const event = (store: Store, topic: string, p: unknown) => whatsappOnShopifyEvent(store, topic, p, deps);
const messages = (storeId: string) => systemDb.whatsappMessage.findMany({ where: { storeId }, orderBy: { createdAt: "asc" } });

describe("order notifications", () => {
  it("confirms a new order once, to the customer's number, with real order details", async () => {
    const store = await setupStore();
    const o = order();
    await event(store, "orders/create", o);
    await drain();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("919876543210");
    expect(sent[0]!.template).toBe("insights_order_confirmation");
    const body = sent[0]!.components.find((c) => c.type === "body")!.parameters.map((p) => p.text);
    expect(body).toEqual(["Asha", "Green Leaf", o.name, "₹1,499.00", "12 MG Road, Kochi 682016, India"]);
    const button = sent[0]!.components.find((c) => c.type === "button")!.parameters[0]!.text!;
    const tracking = await systemDb.orderTracking.findFirstOrThrow({ where: { storeId: store.id } });
    expect(tracking.tokenHash).toHaveLength(64);
    expect(button).not.toContain(String(o.id)); // an unguessable token, not the order id

    const [msg] = await messages(store.id);
    expect(msg).toMatchObject({ status: "sent", providerMessageId: "wamid.1", category: "utility", paramsEnc: null, phoneMasked: "+91 ••••••• 210" });

    // Shopify retries and the order's other topics never send it again.
    await event(store, "orders/create", o);
    await event(store, "orders/updated", { ...o, updated_at: new Date().toISOString() });
    await event(store, "orders/paid", o);
    await drain();
    expect(sent).toHaveLength(1);
    expect(await systemDb.whatsappMessage.count({ where: { storeId: store.id } })).toBe(1);
  });

  it("goes through the real webhook consumer, and a redelivered webhook repeats nothing", async () => {
    const store = await setupStore();
    const o = order();
    const ev = await systemDb.webhookEvent.create({ data: { webhookId: "wh-1", topic: "orders/create", shopDomain: store.shopDomain, storeId: store.id, workspaceId: store.workspaceId } });
    await processWebhook({ eventId: ev.id, topic: "orders/create", shop: store.shopDomain, payload: o }, deps);
    await processWebhook({ eventId: ev.id, topic: "orders/create", shop: store.shopDomain, payload: o }, deps);
    await drain();
    expect(sent).toHaveLength(1);
    expect(await systemDb.order.count({ where: { storeId: store.id } })).toBe(1);
  });

  it("sends nothing for a checkout, an order cancelled at creation, or one with no number", async () => {
    const store = await setupStore({ kinds: ["order_confirmation"] });
    await event(store, "orders/create", order({ cancelled_at: new Date().toISOString(), financial_status: "voided" }));
    await event(store, "orders/create", order({ shipping_address: { country_code: "IN" }, customer: null }));
    await drain();
    expect(sent).toHaveLength(0);
    const rows = await messages(store.id);
    expect(rows.map((r) => [r.status, r.reason])).toEqual([["skipped", "no_phone"]]);
  });

  it("holds every order update until the merchant has chosen how customers agree to them", async () => {
    const store = await setupStore({ basis: "none", kinds: ["order_confirmation"] });
    await event(store, "orders/create", order());
    await drain();
    expect(sent).toHaveLength(0);
    expect((await messages(store.id))[0]).toMatchObject({ status: "skipped", reason: "consent_basis_not_set" });
  });

  it("with the cart-attribute basis, only orders that ticked the box get updates", async () => {
    const store = await setupStore({ basis: "cart_attribute", kinds: ["order_confirmation"] });
    await event(store, "orders/create", order({ note_attributes: [{ name: "whatsapp_opt_in", value: "yes" }] }));
    await event(store, "orders/create", order({ shipping_address: { first_name: "B", country_code: "IN", phone: "+91 99999 11111" } }));
    await drain();
    expect(sent.map((s) => s.to)).toEqual(["919876543210"]);
  });

  it("confirms payment only when it comes after the order (cash on delivery)", async () => {
    const store = await setupStore({ kinds: ["order_confirmation", "payment_confirmed"] });
    const o = order({ financial_status: "pending" });
    await event(store, "orders/create", o);
    await event(store, "orders/paid", { ...o, financial_status: "paid", updated_at: new Date().toISOString() });
    await event(store, "orders/paid", { ...o, financial_status: "paid", updated_at: new Date().toISOString() });
    // A late orders/updated generated before the payment doesn't take "paid" back.
    await event(store, "orders/updated", o);
    await drain();
    expect(sent.map((s) => s.template)).toEqual(["insights_order_confirmation", "insights_payment_confirmed"]);
    expect((await systemDb.orderTracking.findFirstOrThrow({ where: { storeId: store.id } })).financialStatus).toBe("paid");
  });

  it("says so when an order is cancelled after its confirmation", async () => {
    const store = await setupStore({ kinds: ["order_confirmation", "order_cancelled"] });
    const o = order();
    await event(store, "orders/create", o);
    await drain();
    await event(store, "orders/cancelled", { ...o, cancelled_at: new Date().toISOString() });
    await drain();
    expect(sent.map((s) => s.template)).toEqual(["insights_order_confirmation", "insights_order_cancelled"]);
    expect((await systemDb.orderTracking.findFirstOrThrow({ where: { storeId: store.id } })).status).toBe("cancelled");
  });

  it("doesn't confirm an order that was cancelled before the confirmation went out", async () => {
    const store = await setupStore({ kinds: ["order_confirmation", "order_cancelled"] });
    const o = order();
    await event(store, "orders/create", o);
    await event(store, "orders/cancelled", { ...o, cancelled_at: new Date().toISOString() });
    await drain();
    expect(sent.map((s) => s.template)).toEqual(["insights_order_cancelled"]);
    expect(await systemDb.whatsappMessage.findFirstOrThrow({ where: { storeId: store.id, kind: "order_confirmation" } })).toMatchObject({ status: "cancelled", reason: "order_cancelled" });
  });
});

describe("delivery updates", () => {
  it("announces shipped, out for delivery and delivered once each, and books the review request", async () => {
    const store = await setupStore({ kinds: ["order_shipped", "out_for_delivery", "order_delivered", "review_request"] });
    const o = order();
    await event(store, "orders/create", o);
    const fulfilled = { ...o, updated_at: new Date().toISOString(), fulfillments: [{ id: 91, status: "success", created_at: new Date().toISOString(), tracking_company: "Blue Dart", tracking_number: "BD123", tracking_url: "https://bluedart.test/BD123" }] };
    await event(store, "orders/updated", fulfilled);
    await event(store, "orders/fulfilled", fulfilled);
    await event(store, "fulfillment_events/create", { id: 1, fulfillment_id: 91, order_id: o.id, status: "out_for_delivery", happened_at: new Date().toISOString() });
    await event(store, "fulfillment_events/create", { id: 2, fulfillment_id: 91, order_id: o.id, status: "delivered", happened_at: new Date().toISOString() });
    // Late and out of order: recorded, never announced.
    await event(store, "fulfillments/update", { id: 91, order_id: o.id, status: "success", shipment_status: "in_transit", created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    await drain();
    expect(sent.map((s) => s.template)).toEqual(["insights_order_shipped", "insights_out_for_delivery", "insights_order_delivered"]);
    const shipped = sent[0]!.components.find((c) => c.type === "body")!.parameters.map((p) => p.text);
    expect(shipped).toEqual(["Asha", o.name, "Blue Dart", "BD123"]);

    const tracking = await systemDb.orderTracking.findFirstOrThrow({ where: { storeId: store.id } });
    expect(tracking.status).toBe("delivered");
    expect(tracking.carrierEvents).toBe(true);
    const review = await systemDb.whatsappMessage.findFirstOrThrow({ where: { storeId: store.id, kind: "review_request" } });
    expect(review.status).toBe("scheduled");
    expect(review.scheduledFor.getTime()).toBeGreaterThan(Date.now() + 2.9 * 86_400_000);
    const events = await systemDb.orderTrackingEvent.findMany({ where: { trackingId: tracking.id } });
    expect(events.map((e) => e.type).sort()).toEqual(["delivered", "in_transit", "out_for_delivery", "paid", "placed", "shipped"]);
  });

  it("never calls an order delivered until every parcel is", async () => {
    const store = await setupStore({ kinds: ["order_delivered"] });
    const o = order();
    await event(store, "orders/create", o);
    const now = new Date().toISOString();
    await event(store, "orders/updated", { ...o, fulfillments: [{ id: 1, status: "success", created_at: now, shipment_status: "delivered", updated_at: now }, { id: 2, status: "success", created_at: now }] });
    await drain();
    expect(sent).toHaveLength(0);
    expect((await systemDb.orderTracking.findFirstOrThrow({ where: { storeId: store.id } })).deliveredAt).toBeNull();
    await event(store, "fulfillment_events/create", { id: 9, fulfillment_id: 2, order_id: o.id, status: "delivered", happened_at: now });
    await drain();
    expect(sent.map((s) => s.template)).toEqual(["insights_order_delivered"]);
  });

  it("a pending fulfillment (not shipped yet) announces nothing", async () => {
    const store = await setupStore({ kinds: ["order_shipped"] });
    const o = order();
    await event(store, "orders/create", o);
    await event(store, "orders/updated", { ...o, fulfillments: [{ id: 5, status: "pending", created_at: new Date().toISOString() }] });
    await drain();
    expect(sent).toHaveLength(0);
  });

  it("records a stale event without telling the customer", async () => {
    const store = await setupStore({ kinds: ["order_delivered"] });
    const o = order();
    await event(store, "orders/create", o);
    const old = new Date(Date.now() - 5 * 86_400_000).toISOString();
    await event(store, "fulfillment_events/create", { id: 3, fulfillment_id: 7, order_id: o.id, status: "delivered", happened_at: old });
    await drain();
    expect(sent).toHaveLength(0);
    expect((await systemDb.orderTracking.findFirstOrThrow({ where: { storeId: store.id } })).status).toBe("delivered");
  });
});

describe("abandoned carts", () => {
  const checkout = (over: Record<string, unknown> = {}) => ({
    token: `ck${Math.random().toString(36).slice(2, 10)}`,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    completed_at: null,
    currency: "INR",
    total_price: "2500.00",
    abandoned_checkout_url: "https://shop.test/123/checkouts/abc/recover?key=secret",
    buyer_accepts_sms_marketing: true,
    phone: "+91 98765 43210",
    shipping_address: { first_name: "Asha", country_code: "IN" },
    line_items: [{ title: "Saree", quantity: 1, price: "2500.00", product_id: 10 }],
    ...over,
  });

  it("reminds a consenting customer after the wait, through a tracked link, and credits the recovered order", async () => {
    const store = await setupStore({ smsCounts: true, kinds: ["abandoned_cart_1"] });
    const c = checkout();
    await event(store, "checkouts/create", c);
    const row = await systemDb.abandonedCheckout.findFirstOrThrow({ where: { storeId: store.id } });
    expect(row.recoveryUrlEnc).not.toContain("secret"); // the recovery link is stored encrypted
    const reminder = await systemDb.whatsappMessage.findFirstOrThrow({ where: { storeId: store.id } });
    expect(reminder.scheduledFor.getTime()).toBeGreaterThan(Date.now() + 55 * 60_000);
    await sendDue(store.id);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.template).toBe("insights_cart_reminder");
    const code = sent[0]!.components.find((x) => x.type === "button")!.parameters[0]!.text;
    expect((await systemDb.whatsappMessage.findFirstOrThrow({ where: { storeId: store.id } })).clickCode).toBe(code);

    await event(store, "orders/create", order({ checkout_token: c.token, total_price: "2500.00" }));
    const after = await systemDb.abandonedCheckout.findFirstOrThrow({ where: { storeId: store.id } });
    expect(after.status).toBe("recovered");
    expect(Number(after.recoveredRevenue)).toBe(2500);
  });

  it("cancels the reminder when the customer buys first (not counted as recovered)", async () => {
    const store = await setupStore({ smsCounts: true, kinds: ["abandoned_cart_1"] });
    const c = checkout();
    await event(store, "checkouts/create", c);
    await event(store, "orders/create", order({ checkout_token: c.token }));
    await sendDue(store.id);
    expect(sent).toHaveLength(0);
    expect((await systemDb.whatsappMessage.findFirstOrThrow({ where: { storeId: store.id, kind: "abandoned_cart_1" } })).status).toBe("cancelled");
    expect((await systemDb.abandonedCheckout.findFirstOrThrow({ where: { storeId: store.id } })).status).toBe("completed");
  });

  it("moves the reminder back while the customer is still shopping, and stops when checkouts/update says completed", async () => {
    const store = await setupStore({ smsCounts: true, kinds: ["abandoned_cart_1"] });
    const c = checkout();
    await event(store, "checkouts/create", c);
    const first = (await systemDb.whatsappMessage.findFirstOrThrow({ where: { storeId: store.id } })).scheduledFor;
    const later = new Date(Date.now() + 20 * 60_000).toISOString();
    await event(store, "checkouts/update", { ...c, updated_at: later });
    const moved = (await systemDb.whatsappMessage.findFirstOrThrow({ where: { storeId: store.id } })).scheduledFor;
    expect(moved.getTime()).toBeGreaterThan(first.getTime());
    // An older update arriving late changes nothing.
    await event(store, "checkouts/update", { ...c, updated_at: new Date(Date.now() - 60_000).toISOString() });
    expect((await systemDb.whatsappMessage.findFirstOrThrow({ where: { storeId: store.id } })).scheduledFor.getTime()).toBe(moved.getTime());
    await event(store, "checkouts/update", { ...c, completed_at: new Date().toISOString() });
    expect((await systemDb.whatsappMessage.findFirstOrThrow({ where: { storeId: store.id } })).status).toBe("cancelled");
  });

  it("never reminds without WhatsApp marketing consent, and never stores an anonymous checkout", async () => {
    const store = await setupStore({ smsCounts: false, kinds: ["abandoned_cart_1"] });
    await event(store, "checkouts/create", checkout());
    await event(store, "checkouts/create", checkout({ phone: null, shipping_address: { country_code: "IN" } }));
    const rows = await systemDb.abandonedCheckout.findMany({ where: { storeId: store.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "ineligible", ineligibleReason: "no_marketing_consent" });
    expect(await systemDb.whatsappMessage.count({ where: { storeId: store.id } })).toBe(0);
  });
});

describe("opt-outs and callbacks", () => {
  const inbound = (store: { id: string }, from: string, text: string) => ({
    object: "whatsapp_business_account",
    entry: [{ id: "1111111111", changes: [{ field: "messages", value: { metadata: { phone_number_id: "2222222222" }, messages: [{ from, id: `in.${Math.random()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }] } }] }],
    storeId: store.id,
  });

  it("STOP cancels what's waiting and nothing more is ever sent to that number", async () => {
    const store = await setupStore({ kinds: ["order_confirmation", "order_shipped"] });
    const o = order();
    await event(store, "orders/create", o);
    await drain();
    expect(sent).toHaveLength(1);
    await applyMetaWebhook(inbound(store, "919876543210", "STOP"), "all", deps);
    const contact = await systemDb.whatsappContact.findFirstOrThrow({ where: { storeId: store.id } });
    expect(contact).toMatchObject({ optedOut: true, marketingStatus: "opted_out", optOutSource: "whatsapp_keyword" });
    await event(store, "orders/updated", { ...o, fulfillments: [{ id: 3, status: "success", created_at: new Date().toISOString() }] });
    await drain();
    expect(sent).toHaveLength(1);
    expect((await systemDb.whatsappMessage.findFirstOrThrow({ where: { storeId: store.id, kind: "order_shipped" } })).status).toBe("cancelled");
  });

  it("delivery callbacks only move a message forward, and are applied once", async () => {
    const store = await setupStore({ kinds: ["order_confirmation"] });
    await event(store, "orders/create", order());
    await drain();
    const ts = String(Math.floor(Date.now() / 1000));
    const status = (s: string, extra: Record<string, unknown> = {}) => ({
      object: "whatsapp_business_account",
      entry: [{ id: "1111111111", changes: [{ field: "messages", value: { metadata: { phone_number_id: "2222222222" }, statuses: [{ id: "wamid.1", status: s, timestamp: ts, recipient_id: "919876543210", ...extra }] } }] }],
    });
    await applyMetaWebhook(status("delivered", { pricing: { billable: true, category: "utility" } }), "all", deps);
    await applyMetaWebhook(status("read"), "all", deps);
    await applyMetaWebhook(status("sent"), "all", deps);
    await applyMetaWebhook(status("delivered"), "all", deps);
    await applyMetaWebhook(status("failed", { errors: [{ code: 131026, title: "x" }] }), "all", deps);
    const msg = await systemDb.whatsappMessage.findFirstOrThrow({ where: { storeId: store.id } });
    expect(msg).toMatchObject({ status: "read", billable: true, pricingCategory: "utility" });
    expect(msg.readAt).not.toBeNull();
    expect(await systemDb.whatsappMessageEvent.count({ where: { messageId: msg.id } })).toBe(4); // delivered, read, sent, failed: once each
  });

  it("ignores another account's webhook unless its own signature vouched for it", async () => {
    const store = await setupStore({ kinds: ["order_confirmation"] });
    const r = await applyMetaWebhook(inbound(store, "919876543210", "STOP"), new Set(["999"]), deps);
    expect(r.applied).toBe(0);
    expect(await systemDb.whatsappContact.count({ where: { storeId: store.id, optedOut: true } })).toBe(0);
  });

  it("an unknown message id seconds old asks Meta to retry (our send is still being recorded)", async () => {
    await setupStore();
    const r = await applyMetaWebhook(
      { object: "whatsapp_business_account", entry: [{ id: "1111111111", changes: [{ field: "messages", value: { metadata: { phone_number_id: "2222222222" }, statuses: [{ id: "wamid.unknown", status: "sent", timestamp: String(Math.floor(Date.now() / 1000)) }] } }] }] },
      "all",
      deps,
    );
    expect(r.retry).toBe(true);
  });

  const preference = (phoneNumberId: string | null, value: "stop" | "resume", at = Math.floor(Date.now() / 1000)) => ({
    field: "user_preferences",
    value: { ...(phoneNumberId ? { metadata: { phone_number_id: phoneNumberId } } : {}), user_preferences: [{ wa_id: "919876543210", category: "marketing_messages", value, timestamp: at }] },
  });

  it("Meta's marketing preference and template reviews are applied", async () => {
    const store = await setupStore();
    await applyMetaWebhook(inbound(store, "919876543210", "hi"), "all", deps); // the customer wrote to the store: a contact
    await applyMetaWebhook(
      { object: "whatsapp_business_account", entry: [{ id: "1111111111", changes: [preference("2222222222", "resume"), { field: "message_template_status_update", value: { event: "REJECTED", message_template_id: "m-insights_order_shipped", message_template_name: "insights_order_shipped", message_template_language: "en", reason: "INCORRECT_CATEGORY" } }] }] },
      "all",
      deps,
    );
    expect((await systemDb.whatsappContact.findFirstOrThrow({ where: { storeId: store.id } })).marketingStatus).toBe("opted_in");
    expect((await systemDb.whatsappTemplate.findFirstOrThrow({ where: { storeId: store.id, name: "insights_order_shipped" } })).status).toBe("REJECTED");
  });

  /** A second store, in another workspace, on the same WhatsApp Business Account with its own number and app. */
  async function neighbour() {
    const other = await setupStore({ connected: false });
    const conn = await systemDb.whatsappConnection.create({
      data: {
        workspaceId: other.workspaceId,
        storeId: other.id,
        mode: "manual",
        wabaId: "1111111111",
        phoneNumberId: "3333333333",
        registered: true,
        status: "active",
        accessTokenEnc: waEncrypt(other.id, "access", "EAAother"),
        appSecretEnc: waEncrypt(other.id, "app_secret", "neighbour-secret"),
        tokenKeyVersion: 1,
        webhookVerifiedAt: new Date(),
      },
    });
    return { other, conn };
  }

  it("a manual connection's own secret vouches for that connection only, not for others on the same account", async () => {
    const victim = await setupStore({ kinds: ["order_confirmation"] });
    const { conn } = await neighbour();
    // Signed with the neighbour's secret, but naming the victim's number.
    const r = await applyMetaWebhook(inbound(victim, "919876543210", "STOP"), new Set([conn.id]), deps);
    expect(r.applied).toBe(0);
    expect(await systemDb.whatsappContact.count({ where: { storeId: victim.id } })).toBe(0);
    const victimConn = await systemDb.whatsappConnection.findFirstOrThrow({ where: { storeId: victim.id } });
    expect(victimConn.lastWebhookAt).toBeNull();
  });

  it("a marketing preference reaches only the store whose number it names, and 'resume' creates nobody", async () => {
    const store = await setupStore();
    const { other } = await neighbour();
    await applyMetaWebhook(inbound(store, "919876543210", "hi"), "all", deps); // the customer wrote to the first store only
    // The neighbour's number: the customer resumes marketing there. They are not the neighbour's contact.
    await applyMetaWebhook({ object: "whatsapp_business_account", entry: [{ id: "1111111111", changes: [preference("3333333333", "resume")] }] }, "all", deps);
    expect(await systemDb.whatsappContact.count({ where: { storeId: other.id } })).toBe(0);
    expect((await systemDb.whatsappContact.findFirstOrThrow({ where: { storeId: store.id } })).marketingStatus).not.toBe("opted_in");
    // No number named: a "stop" still reaches the contact the store has, a "resume" opts nobody in.
    await applyMetaWebhook({ object: "whatsapp_business_account", entry: [{ id: "1111111111", changes: [preference(null, "stop")] }] }, "all", deps);
    expect((await systemDb.whatsappContact.findFirstOrThrow({ where: { storeId: store.id } })).marketingStatus).toBe("opted_out");
    await applyMetaWebhook({ object: "whatsapp_business_account", entry: [{ id: "1111111111", changes: [preference(null, "resume", Math.floor(Date.now() / 1000) + 5)] }] }, "all", deps);
    expect((await systemDb.whatsappContact.findFirstOrThrow({ where: { storeId: store.id } })).marketingStatus).toBe("opted_out");
    expect(await systemDb.whatsappContact.count({ where: { storeId: other.id } })).toBe(0);
  });

  it("a START older than the customer's STOP (a late redelivery) doesn't opt them back in", async () => {
    const store = await setupStore();
    const at = (secondsAgo: number) => String(Math.floor(Date.now() / 1000) - secondsAgo);
    const msg = (text: string, ts: string) => ({
      object: "whatsapp_business_account",
      entry: [{ id: "1111111111", changes: [{ field: "messages", value: { metadata: { phone_number_id: "2222222222" }, messages: [{ from: "919876543210", id: `in.${Math.random()}`, timestamp: ts, type: "text", text: { body: text } }] } }] }],
    });
    await applyMetaWebhook(msg("STOP", at(10)), "all", deps);
    await applyMetaWebhook(msg("START", at(60)), "all", deps); // sent before the STOP, delivered after
    expect(await systemDb.whatsappContact.findFirstOrThrow({ where: { storeId: store.id } })).toMatchObject({ optedOut: true, marketingStatus: "opted_out" });
    await applyMetaWebhook(msg("START", at(0)), "all", deps); // a real, newer START
    expect(await systemDb.whatsappContact.findFirstOrThrow({ where: { storeId: store.id } })).toMatchObject({ optedOut: false, marketingStatus: "opted_in" });
  });
});

describe("sending: failures, limits and access", () => {
  it("retries rate limits with backoff, then gives up after the last attempt", async () => {
    const store = await setupStore({ kinds: ["order_confirmation"] });
    metaError = { status: 400, code: 130429 };
    await event(store, "orders/create", order());
    await drain();
    let msg = await systemDb.whatsappMessage.findFirstOrThrow({ where: { storeId: store.id } });
    expect(msg).toMatchObject({ status: "scheduled", reason: "retrying", attempts: 1, errorCode: "130429" });
    expect(msg.scheduledFor.getTime()).toBeGreaterThan(Date.now() + 20_000);
    for (let i = 1; i < WA_MAX_ATTEMPTS; i++) await sendDue(store.id);
    msg = await systemDb.whatsappMessage.findFirstOrThrow({ where: { storeId: store.id } });
    expect(msg).toMatchObject({ status: "failed", reason: "retries_exhausted", attempts: WA_MAX_ATTEMPTS });
  });

  it("an expired token marks the number for reconnecting and holds messages instead of losing them", async () => {
    const store = await setupStore({ kinds: ["order_confirmation"] });
    metaError = { status: 401, code: 190, message: "Error validating access token" };
    await event(store, "orders/create", order());
    await drain();
    expect((await systemDb.whatsappConnection.findFirstOrThrow({ where: { storeId: store.id } })).status).toBe("reconnect");
    const msg = await systemDb.whatsappMessage.findFirstOrThrow({ where: { storeId: store.id } });
    expect(msg).toMatchObject({ status: "scheduled", reason: "waiting_for_connection", attempts: 0 });
  });

  it("a permanent failure is recorded with a reason the merchant can read", async () => {
    const store = await setupStore({ kinds: ["order_confirmation"] });
    metaError = { status: 400, code: 131026 };
    await event(store, "orders/create", order());
    await drain();
    expect(await systemDb.whatsappMessage.findFirstOrThrow({ where: { storeId: store.id } })).toMatchObject({ status: "failed", errorCode: "131026" });
    expect((await systemDb.whatsappMessage.findFirstOrThrow({ where: { storeId: store.id } })).errorTitle).toMatch(/isn't on WhatsApp/);
  });

  it("paces sends per number and puts the rest back", async () => {
    const store = await setupStore({ kinds: ["order_confirmation"] });
    for (let i = 0; i < 21; i++) await coord.hit(`wa-mps:${(await systemDb.whatsappConnection.findFirstOrThrow({ where: { storeId: store.id } })).id}`, 1);
    await event(store, "orders/create", order());
    const msg = await systemDb.whatsappMessage.findFirstOrThrow({ where: { storeId: store.id } });
    expect(await sendWhatsappMessage(msg.id, deps)).toBe("rescheduled");
    expect(sent).toHaveLength(0);
  });

  it("waits for a template still in review, then skips it if it's rejected", async () => {
    const store = await setupStore({ kinds: ["order_confirmation"] });
    await systemDb.whatsappTemplate.updateMany({ where: { storeId: store.id, name: "insights_order_confirmation" }, data: { status: "PENDING" } });
    await event(store, "orders/create", order());
    await drain();
    expect(await systemDb.whatsappMessage.findFirstOrThrow({ where: { storeId: store.id } })).toMatchObject({ status: "scheduled", reason: "template_pending" });
    await systemDb.whatsappTemplate.updateMany({ where: { storeId: store.id, name: "insights_order_confirmation" }, data: { status: "REJECTED" } });
    await sendDue(store.id);
    expect(await systemDb.whatsappMessage.findFirstOrThrow({ where: { storeId: store.id } })).toMatchObject({ status: "skipped", reason: "template_not_approved" });
  });
});

describe("campaigns", () => {
  async function contacts(store: Store) {
    const mk = async (phone: string, status: string, source: string | null, optedOut = false) =>
      systemDb.whatsappContact.create({
        data: { workspaceId: store.workspaceId, storeId: store.id, phoneHash: `h${phone}`, phoneEnc: waEncrypt(store.id, "phone", phone), phoneMasked: phone.slice(-3), marketingStatus: status, marketingSource: source, optedOut },
      });
    return {
      yes: await mk("919000000001", "opted_in", "whatsapp_keyword"),
      sms: await mk("919000000002", "opted_in", "shopify_sms"),
      stopped: await mk("919000000003", "opted_out", "whatsapp_keyword", true),
      unknown: await mk("919000000004", "unknown", null),
    };
  }

  it("reaches only customers who opted in, never anyone who opted out", async () => {
    const store = await setupStore({ smsCounts: false });
    await contacts(store);
    await systemDb.whatsappCampaign.create({
      data: {
        workspaceId: store.workspaceId,
        storeId: store.id,
        name: "Onam",
        occasion: "onam",
        templateName: "insights_seasonal_offer",
        templateLanguage: "en",
        mapping: TEMPLATE_LIBRARY.find((t) => t.name === "insights_seasonal_offer")!.mapping as Prisma.InputJsonValue,
        variables: { discountPercentage: "20", endDate: "15 September" },
        linkUrl: "https://shop.test/collections/onam",
        audience: {},
        startAt: new Date(Date.now() - 60_000),
        status: "scheduled",
        approvedAt: new Date(),
      },
    });
    await sweepWhatsapp(deps);
    await drain();
    expect(sent.map((s) => s.to)).toEqual(["919000000001"]);
    expect(sent[0]!.components.find((c) => c.type === "body")!.parameters.map((p) => p.text)).toEqual(["Happy Onam", "Green Leaf", "20", "15 September"]);
    const camp = await systemDb.whatsappCampaign.findFirstOrThrow({ where: { storeId: store.id } });
    expect(camp.estimatedRecipients).toBe(1);
    await sweepWhatsapp(deps);
    expect((await systemDb.whatsappCampaign.findFirstOrThrow({ where: { storeId: store.id } })).status).toBe("completed");
  });

  it("holds marketing outside the store's sending hours", async () => {
    const store = await setupStore();
    const s = await systemDb.whatsappSettings.findUniqueOrThrow({ where: { storeId: store.id } });
    const hour = new Date().getUTCHours();
    await systemDb.whatsappSettings.update({ where: { storeId: store.id }, data: { config: { ...(s.config as object), sendWindowStart: (hour + 2) % 24, sendWindowEnd: (hour + 4) % 24 } } });
    const { yes } = await contacts(store);
    const camp = await systemDb.whatsappCampaign.create({
      data: { workspaceId: store.workspaceId, storeId: store.id, name: "N", occasion: "custom", templateName: "insights_seasonal_offer", templateLanguage: "en", mapping: TEMPLATE_LIBRARY.find((t) => t.name === "insights_seasonal_offer")!.mapping as Prisma.InputJsonValue, linkUrl: "https://shop.test", startAt: new Date(), status: "sending" },
    });
    const m = await systemDb.whatsappMessage.create({
      data: { workspaceId: store.workspaceId, storeId: store.id, contactId: yes.id, kind: "campaign", campaignId: camp.id, templateName: "insights_seasonal_offer", templateLanguage: "en", dedupeKey: "c1", scheduledFor: new Date(), paramsEnc: waEncrypt(store.id, "params", JSON.stringify({ mapping: TEMPLATE_LIBRARY.find((t) => t.name === "insights_seasonal_offer")!.mapping, values: { campaign_link_code: "abc" } })) },
    });
    expect(await sendWhatsappMessage(m.id, deps)).toBe("rescheduled");
    const after = await systemDb.whatsappMessage.findUniqueOrThrow({ where: { id: m.id } });
    expect(after.reason).toBe("outside_send_window");
    expect(after.scheduledFor.getTime()).toBeGreaterThan(Date.now() + 3600_000);
  });

  it("credits an order to the campaign message before it, once", async () => {
    const store = await setupStore({ kinds: [] });
    const contact = await systemDb.whatsappContact.create({
      data: { workspaceId: store.workspaceId, storeId: store.id, phoneHash: "x", phoneEnc: waEncrypt(store.id, "phone", "919876543210"), phoneMasked: "210", marketingStatus: "opted_in", marketingSource: "whatsapp_keyword" },
    });
    const camp = await systemDb.whatsappCampaign.create({ data: { workspaceId: store.workspaceId, storeId: store.id, name: "N", occasion: "custom", templateName: "t", templateLanguage: "en", startAt: new Date(), status: "completed" } });
    await systemDb.whatsappMessage.create({
      data: { workspaceId: store.workspaceId, storeId: store.id, contactId: contact.id, kind: "campaign", campaignId: camp.id, dedupeKey: "c", scheduledFor: new Date(), status: "delivered", sentAt: new Date(Date.now() - 3600_000) },
    });
    // The order's number is the contact's (the upsert finds it by its hash).
    const { phoneHash } = await import("@app/core");
    await systemDb.whatsappContact.update({ where: { id: contact.id }, data: { phoneHash: phoneHash(store.id, "919876543210") } });
    await event(store, "orders/create", order());
    await event(store, "orders/create", order());
    const credited = await systemDb.whatsappMessage.findFirstOrThrow({ where: { campaignId: camp.id } });
    expect(Number(credited.attributedRevenue)).toBe(1499);
    expect(credited.attributedOrderId).toBe(String(orderSeq - 1)); // the first order; the second finds nothing left to credit
  });
});

describe("automations", () => {
  it("runs a rule once per order when its conditions hold, and records why not when they don't", async () => {
    const store = await setupStore({ kinds: [] });
    const lib = TEMPLATE_LIBRARY.find((t) => t.name === "insights_order_processing")!;
    const rule = await systemDb.whatsappAutomationRule.create({
      data: {
        workspaceId: store.workspaceId,
        storeId: store.id,
        name: "Big orders",
        enabled: true,
        trigger: "order_created",
        conditions: [{ field: "order_value", op: "gte", value: 1000 }],
        action: { type: "send_template", templateName: lib.name, language: "en", mapping: lib.mapping },
      },
    });
    const big = order();
    await event(store, "orders/create", big);
    await event(store, "orders/create", big);
    await event(store, "orders/create", order({ total_price: "10.00" }));
    await drain();
    expect(sent.map((s) => s.template)).toEqual(["insights_order_processing"]);
    const runs = await systemDb.whatsappAutomationRun.findMany({ where: { ruleId: rule.id }, orderBy: { createdAt: "asc" } });
    expect(runs.map((r) => r.outcome)).toEqual(["done", "skipped"]);
    expect(runs[1]!.detail).toMatch(/order_value/);
  });
});

describe("GDPR", () => {
  it("customers/redact removes the customer's number, timelines and messages", async () => {
    const store = await setupStore({ kinds: ["order_confirmation"] });
    const o = order();
    await event(store, "orders/create", o);
    await drain();
    const ev = await systemDb.webhookEvent.create({ data: { webhookId: "r1", topic: "customers/redact", shopDomain: store.shopDomain, storeId: store.id, workspaceId: store.workspaceId } });
    await processWebhook({ eventId: ev.id, topic: "customers/redact", shop: store.shopDomain, payload: { customer: { id: 77, phone: "+919876543210" }, orders_to_redact: [o.id] } }, deps);
    expect(await systemDb.whatsappContact.count({ where: { storeId: store.id } })).toBe(0);
    expect(await systemDb.orderTracking.count({ where: { storeId: store.id } })).toBe(0);
    expect(await systemDb.whatsappMessage.count({ where: { storeId: store.id } })).toBe(0);
  });
});

describe("connection health", () => {
  it("asks Meta about each number every few hours: re-reads a healthy one, turns a revoked one to 'reconnect', and then leaves it alone", async () => {
    const store = await setupStore({ kinds: ["order_confirmation"] });
    const conn = await systemDb.whatsappConnection.findFirstOrThrow({ where: { storeId: store.id } });
    await systemDb.whatsappConnection.update({ where: { id: conn.id }, data: { lastSyncedAt: new Date(Date.now() - 7 * 3600_000), qualityRating: "GREEN" } });
    let revoked = false;
    const calls: string[] = [];
    fetchImpl = async (input) => {
      const u = new URL(String(input));
      calls.push(u.pathname);
      if (revoked) return json({ error: { code: 190, message: "Error validating access token: The user has not authorized application", type: "OAuthException" } }, 401);
      if (u.pathname.endsWith("/2222222222")) return json({ id: "2222222222", display_phone_number: "+91 98765 00000", quality_rating: "YELLOW", platform_type: "CLOUD_API", messaging_limit_tier: "TIER_1K" });
      if (u.pathname.endsWith("/1111111111/message_templates")) return json({ data: [] });
      throw new Error(`unexpected fetch ${u}`);
    };

    expect(await checkConnections(deps)).toBe(1);
    const fresh = await systemDb.whatsappConnection.findUniqueOrThrow({ where: { id: conn.id } });
    expect(fresh).toMatchObject({ status: "active", qualityRating: "YELLOW", messagingLimitTier: "TIER_1K" });
    expect(fresh.lastSyncedAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);
    // Just checked: Meta isn't asked again on the next tick.
    const before = calls.length;
    expect(await checkConnections(deps)).toBe(0);
    expect(calls).toHaveLength(before);

    // Hours later the business has removed bizinsights' access.
    await systemDb.whatsappConnection.update({ where: { id: conn.id }, data: { lastSyncedAt: new Date(Date.now() - 7 * 3600_000) } });
    coord.clear();
    revoked = true;
    await checkConnections(deps);
    expect((await systemDb.whatsappConnection.findUniqueOrThrow({ where: { id: conn.id } })).status).toBe("reconnect");
    // A connection waiting to be reconnected isn't polled: its token is known not to work.
    coord.clear();
    const after = calls.length;
    expect(await checkConnections(deps)).toBe(0);
    expect(calls).toHaveLength(after);
  });
});

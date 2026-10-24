import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectDb, systemDb, type Store } from "@app/db";
import { resetDb } from "@app/db/testing";
import { memoryBlobs, memoryCoord, memoryMailer, memoryQueues, recordWebhook, resetEnvCache, sweepWhatsapp, waEncrypt, waPhoneHash, type FetchLike } from "@app/core";
import { processWebhook, type WorkerDeps } from "../src/handlers.js";
import { consume, type QueueMessage } from "../src/index.js";
import { salesAnswer } from "./shopifySales.js";

/**
 * WhatsApp Automation inside the worker: the queue consumer's WhatsApp jobs (sends, campaign
 * batches, Meta's webhook deliveries and what happens when one keeps failing), Shopify's webhooks
 * through the real consumer into workflows, the GDPR topics, and the 15-minute sweep. Real Postgres;
 * Meta and Nango faked; nothing leaves the process.
 */

const queues = memoryQueues();
const coord = memoryCoord();
let fetchImpl: FetchLike;
let deps: WorkerDeps;
let sent: Array<Record<string, unknown>>;
let nangoDeleted: string[];

const PHONE = "9080706050";
const WABA = "1020304050";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeAll(() => {
  Object.assign(process.env, {
    WHATSAPP_APP_ID: "555000111",
    WHATSAPP_APP_SECRET: "wa_app_secret_for_tests",
    WHATSAPP_CONFIG_ID: "cfg_123",
    WHATSAPP_WEBHOOK_VERIFY_TOKEN: "verify_tok_123",
    WHATSAPP_API_VERSION: "v26.0",
    NANGO_SECRET_KEY: "nango_secret_for_tests",
  });
  resetEnvCache();
  deps = { coord, queues, payloads: memoryBlobs(), mailer: memoryMailer(), fetchImpl: ((...a: Parameters<FetchLike>) => fetchImpl(...a)) as FetchLike };
});
afterAll(async () => disconnectDb());
beforeEach(async () => {
  await resetDb();
  queues.clear();
  coord.clear();
  sent = [];
  nangoDeleted = [];
  fetchImpl = async (input, init) => {
    const sales = salesAnswer(input, init);
    if (sales) return sales;
    const url = new URL(String(input));
    if (url.hostname === "api.nango.dev") {
      if ((init?.method ?? "GET") === "DELETE") {
        nangoDeleted.push(url.pathname);
        return new Response(null, { status: 204 });
      }
      return json({ credentials: { type: "API_KEY", apiKey: "EAAGtoken" } });
    }
    if (url.hostname === "graph.facebook.com" && url.pathname.endsWith(`${PHONE}/messages`)) {
      sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return json({ messaging_product: "whatsapp", messages: [{ id: `wamid.${sent.length}` }] });
    }
    if (url.hostname === "graph.facebook.com" && url.pathname.endsWith(`${WABA}/subscribed_apps`)) return json({ success: true, data: [{ whatsapp_business_api_data: { id: "555000111" } }] });
    if (url.hostname === "graph.facebook.com" && url.pathname.endsWith(`${WABA}/message_templates`)) return json({ data: [] });
    if (url.hostname === "graph.facebook.com" && url.pathname.endsWith(PHONE)) return json({ id: PHONE, display_phone_number: "+61 400 000 001", platform_type: "CLOUD_API", quality_rating: "YELLOW" });
    throw new Error(`unexpected fetch ${url}`);
  };
});

/** A store with a working WhatsApp connection, an approved order template and a chosen consent basis. */
async function setupStore(): Promise<Store> {
  const ws = await systemDb.workspace.create({ data: { name: "W" } });
  const store = await systemDb.store.create({
    data: { workspaceId: ws.id, shopDomain: `s${Math.random().toString(36).slice(2, 8)}.myshopify.com`, grantedScopes: ["read_orders"], status: "active", timezone: "UTC", pixelIngestKey: `pk-${Math.random()}`, name: "Green Leaf" },
  });
  await systemDb.waConnection.create({
    data: { workspaceId: ws.id, storeId: store.id, status: "active", wabaId: WABA, phoneNumberId: PHONE, registered: true, nangoConnectionId: `wa-${store.id}`, subscribedAt: new Date(), lastCheckedAt: new Date() },
  });
  await systemDb.waSettings.create({ data: { workspaceId: ws.id, storeId: store.id, orderUpdates: "checkout_notice" } });
  await systemDb.waTemplate.create({
    data: { workspaceId: ws.id, storeId: store.id, wabaId: WABA, metaId: "t1", name: "order_confirmation", language: "en", category: "UTILITY", status: "APPROVED", components: [{ type: "BODY", text: "Hi {{1}}, your order {{2}} is confirmed. Thank you!" }] },
  });
  await systemDb.waWorkflow.create({
    data: {
      workspaceId: ws.id,
      storeId: store.id,
      name: "Order confirmation",
      trigger: "order_created",
      templateName: "order_confirmation",
      templateLanguage: "en",
      mapping: { body: [{ source: "customer_first_name" }, { source: "order_number" }], buttons: [] },
      status: "active",
    },
  });
  return store;
}

const order = (over: Record<string, unknown> = {}) => ({
  id: 7001,
  name: "#1001",
  created_at: new Date().toISOString(),
  processed_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  total_price: "59.00",
  subtotal_price: "59.00",
  currency: "AUD",
  financial_status: "paid",
  phone: "+61412345678",
  customer: { id: 77, first_name: "Asha", orders_count: 1 },
  shipping_address: { country_code: "AU", first_name: "Asha" },
  line_items: [{ id: 1, product_id: 11, variant_id: 12, title: "Tea", quantity: 1, price: "59.00" }],
  ...over,
});

const message = (body: unknown, attempts: number) => {
  const m = { acked: false, retried: undefined as undefined | { delaySeconds?: number } };
  const msg: QueueMessage = { id: "m1", body, attempts, ack: () => (m.acked = true), retry: (o) => (m.retried = o ?? {}) };
  return { m, msg };
};

/** Run the queued WhatsApp jobs through the real consumer until none is left. */
async function drain() {
  for (let i = 0; i < 10; i++) {
    const jobs = queues.sent.sync.splice(0) as unknown as Array<{ kind?: string }>;
    const wa = jobs.filter((j) => j.kind?.startsWith("whatsapp"));
    if (!wa.length) return;
    for (const j of wa) await consume("sync", message(j, 1).msg, deps);
  }
}

async function deliver(store: Store, topic: string, payload: unknown, id: string) {
  // Shopify's redelivery carries the same webhook id: the consumer sees the same event again.
  const ev = await systemDb.webhookEvent.upsert({ where: { webhookId: id }, create: { webhookId: id, topic, shopDomain: store.shopDomain, storeId: store.id, workspaceId: store.workspaceId }, update: {} });
  return processWebhook({ eventId: ev.id, topic, shop: store.shopDomain, payload }, deps);
}

describe("Shopify's webhooks through the consumer", () => {
  it("start the store's workflow once, however often Shopify delivers", async () => {
    const store = await setupStore();
    const o = order();
    await deliver(store, "orders/create", o, "wh-1");
    await deliver(store, "orders/create", o, "wh-1");
    await drain();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: "61412345678", type: "template", template: { name: "order_confirmation" } });
    expect(await systemDb.order.count({ where: { storeId: store.id } })).toBe(1);
    expect(await systemDb.waWorkflowRun.count({ where: { storeId: store.id } })).toBe(1);
  });

  it("do nothing for a store without WhatsApp", async () => {
    const store = await setupStore();
    await systemDb.waConnection.update({ where: { storeId: store.id }, data: { status: "disconnected", phoneNumberId: null, nangoConnectionId: null } });
    await deliver(store, "orders/create", order(), "wh-2");
    await drain();
    expect(sent).toHaveLength(0);
    expect(await systemDb.waWorkflowRun.count()).toBe(0);
    expect(await systemDb.waContact.count()).toBe(0);
  });
});

describe("Meta's webhook deliveries in the consumer", () => {
  it("are applied once; one that keeps failing is set aside and its stores told", async () => {
    const store = await setupStore();
    const owner = await systemDb.user.create({ data: { email: "owner@x.com", emailVerified: true } });
    await systemDb.membership.create({ data: { workspaceId: store.workspaceId, userId: owner.id, role: "owner" } });
    // A delivery whose stored body can't be read stands for one that keeps failing.
    const { stored } = await recordWebhook(JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: WABA, changes: [] }] }), deps);
    expect(stored).toBe(true);
    const [job] = queues.sent.sync.splice(0) as unknown as Array<{ kind: string; eventId: string }>;
    expect(job!.kind).toBe("whatsapp_webhook");
    await systemDb.waWebhookEvent.update({ where: { id: job!.eventId }, data: { bodyEnc: waEncrypt("another-id", "webhook", "{}") } });
    const first = message(job, 1);
    await consume("sync", first.msg, deps);
    // Unreadable: set aside at once (a retry would read the same bytes).
    expect((await systemDb.waWebhookEvent.findUniqueOrThrow({ where: { id: job!.eventId } })).status).toBe("dead");

    // One still waiting after every try (the queue's retries spent): the sweep sets it aside and tells the store.
    const { stored: again } = await recordWebhook(JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: WABA, changes: [{ field: "account_update", value: { event: "VERIFIED_ACCOUNT" } }] }] }), deps);
    expect(again).toBe(true);
    const [job2] = queues.sent.sync.splice(0) as unknown as Array<{ kind: string; eventId: string }>;
    await systemDb.waWebhookEvent.update({ where: { id: job2!.eventId }, data: { attempts: 6, lastError: "boom", receivedAt: new Date(Date.now() - 3600_000), enqueuedAt: new Date(Date.now() - 3600_000) } });
    const r = await sweepWhatsapp(deps);
    expect(r.webhooks).toEqual({ requeued: 0, setAside: 1 });
    expect((await systemDb.waWebhookEvent.findUniqueOrThrow({ where: { id: job2!.eventId } })).status).toBe("dead");
    expect(await systemDb.alert.count({ where: { storeId: store.id, code: "wa_webhook_failed" } })).toBe(1);
  });
});

describe("privacy", () => {
  it("customers/redact erases the customer's contact, consent, messages and runs", async () => {
    const store = await setupStore();
    await deliver(store, "orders/create", order(), "wh-3");
    await drain();
    const contact = await systemDb.waContact.findFirstOrThrow({ where: { storeId: store.id } });
    expect(contact.phoneHash).toBe(waPhoneHash(store.id, "61412345678"));
    await deliver(store, "customers/redact", { customer: { id: 77, phone: "+61412345678" }, orders_to_redact: [7001] }, "r1");
    expect(await systemDb.waContact.count({ where: { storeId: store.id } })).toBe(0);
    expect(await systemDb.waMessage.count({ where: { storeId: store.id } })).toBe(0);
    expect(await systemDb.waWorkflowRun.count({ where: { storeId: store.id } })).toBe(0);
  });

  it("shop/redact erases every WhatsApp record of the store and its token at Nango", async () => {
    const store = await setupStore();
    await deliver(store, "orders/create", order(), "wh-4");
    await drain();
    await systemDb.store.update({ where: { id: store.id }, data: { status: "uninstalled", uninstalledAt: new Date(Date.now() - 49 * 86_400_000) } });
    await deliver(store, "shop/redact", { shop_domain: store.shopDomain }, "sr1");
    for (const n of await Promise.all([
      systemDb.waConnection.count({ where: { storeId: store.id } }),
      systemDb.waContact.count({ where: { storeId: store.id } }),
      systemDb.waMessage.count({ where: { storeId: store.id } }),
      systemDb.waWorkflow.count({ where: { storeId: store.id } }),
      systemDb.waTemplate.count({ where: { storeId: store.id } }),
      systemDb.waSettings.count({ where: { storeId: store.id } }),
    ]))
      expect(n).toBe(0);
    expect(nangoDeleted).toEqual([`/connections/wa-${store.id}`]);
  });
});

describe("the sweep", () => {
  it("queues what is due, fails a cut-off send as uncertain, checks connections and keeps records only as long as it should", async () => {
    const store = await setupStore();
    const base = { workspaceId: store.workspaceId, storeId: store.id, source: "manual", type: "text" };
    const due = await systemDb.waMessage.create({ data: { ...base, idempotencyKey: "a", sendAfter: new Date(Date.now() - 60_000), payloadEnc: waEncrypt(store.id, "payload", '{"kind":"text","body":"x"}') } });
    const later = await systemDb.waMessage.create({ data: { ...base, idempotencyKey: "b", sendAfter: new Date(Date.now() + 3 * 86_400_000) } });
    const cut = await systemDb.waMessage.create({ data: { ...base, idempotencyKey: "c", status: "sending" } });
    await systemDb.waMessage.updateMany({ where: { id: cut.id }, data: { updatedAt: new Date(Date.now() - 20 * 60_000) } });
    const old = await systemDb.waMessage.create({ data: { ...base, idempotencyKey: "d", status: "delivered", finalAt: new Date(Date.now() - 400 * 86_400_000) } });
    await systemDb.waConnection.update({ where: { storeId: store.id }, data: { lastCheckedAt: new Date(Date.now() - 7 * 3600_000) } });

    const r = await sweepWhatsapp(deps);
    expect(r.due).toBe(1);
    const jobs = queues.sent.sync as unknown as Array<{ kind: string; messageId: string }>;
    expect(jobs.filter((j) => j.kind === "whatsapp").map((j) => j.messageId)).toEqual([due.id]);
    expect(jobs.some((j) => j.messageId === later.id)).toBe(false);
    expect(await systemDb.waMessage.findUniqueOrThrow({ where: { id: cut.id } })).toMatchObject({ status: "failed", reason: "uncertain" });
    expect(await systemDb.waMessage.findUnique({ where: { id: old.id } })).toBeNull();
    // The health check read the number's quality from Meta.
    expect(r.health).toBe(1);
    expect((await systemDb.waConnection.findUniqueOrThrow({ where: { storeId: store.id } })).qualityRating).toBe("YELLOW");
  });

  it("cancels what waited for a connection that has needed the merchant for 48 hours", async () => {
    const store = await setupStore();
    await systemDb.waConnection.update({ where: { storeId: store.id }, data: { status: "reconnect", reconnectSince: new Date(Date.now() - 49 * 3600_000) } });
    const m = await systemDb.waMessage.create({ data: { workspaceId: store.workspaceId, storeId: store.id, source: "manual", type: "text", idempotencyKey: "a", sendAfter: new Date(Date.now() + 3600_000) } });
    await sweepWhatsapp(deps);
    expect(await systemDb.waMessage.findUniqueOrThrow({ where: { id: m.id } })).toMatchObject({ status: "cancelled", reason: "reconnect_timeout" });
  });
});

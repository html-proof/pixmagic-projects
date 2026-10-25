import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectDb, systemDb, type Store } from "@app/db";
import { resetDb } from "@app/db/testing";
import {
  checkConnection,
  memoryBlobs,
  memoryCoord,
  memoryMailer,
  memoryQueues,
  queueMessage,
  resetEnvCache,
  saveWaSettings,
  startPairing,
  sweepWhatsapp,
  upsertContact,
  waEncrypt,
  type WhatsappJob,
} from "@app/core";
import { normalizePhone } from "@app/shared";
import { EVOLUTION_ENV, EVOLUTION_KEY, evolutionFake, type EvolutionFake } from "../../../test-support/evolutionFake.js";
import type { WorkerDeps } from "../src/handlers.js";
import { consume, type QueueMessage } from "../src/index.js";

/**
 * WhatsApp Automation inside the worker: the whatsapp queue's jobs through consume (a send never
 * throws for the provider's answer; an event that keeps failing is set aside), and the sweep that
 * recovers what a missed webhook or a crash left behind. Evolution API is test-support/evolutionFake.ts.
 */

const queues = memoryQueues();
const coord = memoryCoord();
let evo: EvolutionFake;
let deps: WorkerDeps;

beforeAll(() => {
  for (const [k, v] of Object.entries({ ...EVOLUTION_ENV, EVOLUTION_WEBHOOK_URL: "https://bizinsights.test/api" })) process.env[k] = v;
  resetEnvCache();
});
afterAll(async () => {
  for (const k of ["EVOLUTION_API_URL", "EVOLUTION_API_KEY", "EVOLUTION_WEBHOOK_URL"]) process.env[k] = "";
  resetEnvCache();
  await disconnectDb();
});
beforeEach(async () => {
  await resetDb();
  queues.clear();
  coord.clear();
  evo = evolutionFake();
  deps = { coord, queues, payloads: memoryBlobs(), mailer: memoryMailer(), fetchImpl: evo.fetch };
});

/** A store whose phone is linked (as the provider says), with settings saved. */
async function connectedStore() {
  const ws = await systemDb.workspace.create({ data: { name: "W" } });
  const user = await systemDb.user.create({ data: { email: `o${Math.random().toString(36).slice(2, 8)}@shop.test` } });
  const store = (await systemDb.store.create({
    data: { workspaceId: ws.id, shopDomain: `s${Math.random().toString(36).slice(2, 8)}.myshopify.com`, name: "Green Leaf", currency: "AUD", grantedScopes: ["read_orders"], status: "active", timezone: "UTC", pixelIngestKey: `pk-${Math.random()}` },
  })) as Store;
  await startPairing(deps, { store, userId: user.id, method: "qr" });
  let conn = await systemDb.wappConnection.findUniqueOrThrow({ where: { storeId: store.id } });
  evo.open(conn.instanceName!);
  conn = await checkConnection(deps, conn);
  expect(conn.status).toBe("connected");
  await saveWaSettings({ store, userId: user.id, data: { businessName: null, orderUpdates: "checkout_notice", marketingEnabled: false, shopifySmsConsent: false, sendWindow: { start: 0, end: 24 }, timeZone: "UTC", dailyLimit: 200, perCustomerDailyLimit: 3, retentionDays: 30 } });
  return { store, conn, user };
}

async function waiting(o: Awaited<ReturnType<typeof connectedStore>>, key = "k-1", text = "Your order is ready.") {
  const phone = normalizePhone("+61412345678", null)!;
  const contact = await upsertContact(o.store, phone);
  const { message } = await queueMessage(deps, { store: o.store, conn: o.conn, source: "manual", category: "transactional", phone, contactId: contact.id, payload: { text }, idempotencyKey: key });
  return message;
}

/** One delivery of a queue message, as SQS hands it to the jobs function. */
async function deliver(body: WhatsappJob, attempts = 1) {
  const m = { acked: false, retried: null as { delaySeconds?: number } | null };
  const msg: QueueMessage = { id: "m1", body, attempts, ack: () => (m.acked = true), retry: (o) => (m.retried = o ?? {}) };
  await consume("whatsapp", msg, deps);
  return m;
}

describe("the whatsapp queue", () => {
  it("sends a message once, and a duplicate delivery of the job finds it taken", async () => {
    const o = await connectedStore();
    const m = await waiting(o);
    expect(queues.sent.whatsapp).toEqual([{ kind: "wapp_send", messageId: m.id }]);
    expect(await deliver({ kind: "wapp_send", messageId: m.id })).toEqual({ acked: true, retried: null });
    expect(await deliver({ kind: "wapp_send", messageId: m.id })).toEqual({ acked: true, retried: null });
    expect(evo.sends).toHaveLength(1);
    expect(await systemDb.wappMessage.findUniqueOrThrow({ where: { id: m.id } })).toMatchObject({ status: "accepted", providerMessageId: evo.sends[0]!.id, payloadEnc: null });
  });

  it("puts a send back for later when the service is unreachable, and fails it plainly after the last try", async () => {
    const o = await connectedStore();
    const m = await waiting(o);
    queues.clear();
    evo.sendFails = 500;
    // The job itself succeeds: the row carries the retry, so the queue never sends the same job twice.
    expect(await deliver({ kind: "wapp_send", messageId: m.id })).toEqual({ acked: true, retried: null });
    const r = await systemDb.wappMessage.findUniqueOrThrow({ where: { id: m.id } });
    expect(r).toMatchObject({ status: "queued", attempts: 1, errorCode: "server" });
    expect(queues.sentOpts.whatsapp.at(-1)).toEqual({ delaySeconds: 30 });
    // Its last try (the linked phone's pace between messages waived): failed, with what happened.
    await systemDb.wappMessage.update({ where: { id: m.id }, data: { attempts: 5, sendAfter: new Date() } });
    await coord.release(`wapp:pace:${o.conn.id}`);
    await deliver({ kind: "wapp_send", messageId: m.id });
    expect(await systemDb.wappMessage.findUniqueOrThrow({ where: { id: m.id } })).toMatchObject({ status: "failed", reason: "gave_up", errorCode: "server" });
    expect(evo.sends).toHaveLength(0);
  });

  it("sets aside a webhook event that keeps failing, on its last try", async () => {
    const o = await connectedStore();
    const ev = await systemDb.wappWebhookEvent.create({
      data: { workspaceId: o.store.workspaceId, storeId: o.store.id, connectionId: o.conn.id, event: "MESSAGES_UPDATE", bodyHash: "h1", bodyEnc: "not-a-ciphertext", status: "pending" },
    });
    const first = await deliver({ kind: "wapp_event", eventId: ev.id });
    expect(first.acked).toBe(false);
    expect(first.retried).not.toBeNull();
    expect((await systemDb.wappWebhookEvent.findUniqueOrThrow({ where: { id: ev.id } })).status).toBe("pending");
    await deliver({ kind: "wapp_event", eventId: ev.id }, 6);
    expect(await systemDb.wappWebhookEvent.findUniqueOrThrow({ where: { id: ev.id } })).toMatchObject({ status: "dead", bodyEnc: null });
  });
});

describe("the WhatsApp sweep", () => {
  it("marks a send that never finished as uncertain instead of sending it again, and queues what is due", async () => {
    const o = await connectedStore();
    const stuck = await waiting(o, "k-stuck");
    await systemDb.$executeRaw`UPDATE wapp_messages SET status = 'sending', updated_at = (now() at time zone 'utc') - interval '20 minutes' WHERE id = ${stuck.id}`;
    const due = await waiting(o, "k-due");
    await systemDb.wappMessage.update({ where: { id: due.id }, data: { enqueuedAt: null } });
    queues.clear();
    const r = await sweepWhatsapp(deps);
    expect(r).toMatchObject({ stuckSends: 1, due: 1 });
    expect(await systemDb.wappMessage.findUniqueOrThrow({ where: { id: stuck.id } })).toMatchObject({ status: "failed", errorCode: "uncertain" });
    expect(queues.sent.whatsapp).toEqual([{ kind: "wapp_send", messageId: due.id }]);
    // Its lease: a second sweep at once does nothing.
    expect(await sweepWhatsapp(deps)).toBeNull();
  });

  it("finds a connection the provider closed without a webhook, and deletes instances nobody owns", async () => {
    const o = await connectedStore();
    evo.instances.get(o.conn.instanceName!)!.state = "close";
    // An instance left behind (bizinsights' prefix, no connection), and someone else's on the same server.
    evo.instances.set("bi_ffffffffffffffffffffffff", { name: "bi_ffffffffffffffffffffffff", id: "x", token: "t", integration: "WHATSAPP-BAILEYS", state: "close", qrCount: 0, webhook: null, ownerJid: null, profileName: null, number: null });
    evo.instances.set("someone-else", { name: "someone-else", id: "y", token: "t", integration: "WHATSAPP-BAILEYS", state: "open", qrCount: 0, webhook: null, ownerJid: null, profileName: null, number: null });
    const r = await sweepWhatsapp(deps);
    expect(r).toMatchObject({ connections: 1, instancesRemoved: 1, evolutionUnreachable: false });
    expect((await systemDb.wappConnection.findUniqueOrThrow({ where: { id: o.conn.id } })).status).toBe("reconnecting");
    expect([...evo.instances.keys()].sort()).toEqual([o.conn.instanceName, "someone-else"].sort());
    expect(evo.calls.find((c) => c.path === "/instance/delete/bi_ffffffffffffffffffffffff")?.apikey).toBe(EVOLUTION_KEY);
  });

  it("tells each connected store once when the service is down, and clears it when it answers", async () => {
    const o = await connectedStore();
    evo.down = "unreachable";
    expect(await sweepWhatsapp(deps)).toMatchObject({ evolutionUnreachable: true });
    coord.clear();
    await sweepWhatsapp(deps);
    const open = () => systemDb.alert.count({ where: { storeId: o.store.id, code: "whatsapp_provider_down", resolvedAt: null } });
    expect(await open()).toBe(1);
    // Down isn't disconnected: the connection keeps its state.
    expect((await systemDb.wappConnection.findUniqueOrThrow({ where: { id: o.conn.id } })).status).toBe("connected");
    evo.down = null;
    coord.clear();
    await sweepWhatsapp(deps);
    expect(await open()).toBe(0);
  });

  it("cancels what waits for a connection down for two days, and says so", async () => {
    const o = await connectedStore();
    const m = await waiting(o);
    await systemDb.wappConnection.update({ where: { id: o.conn.id }, data: { status: "logged_out", downSince: new Date(Date.now() - 49 * 3600_000) } });
    evo.instances.get(o.conn.instanceName!)!.state = "close";
    await sweepWhatsapp(deps);
    expect(await systemDb.wappMessage.findUniqueOrThrow({ where: { id: m.id } })).toMatchObject({ status: "cancelled", reason: "not_connected" });
    expect(await systemDb.alert.count({ where: { storeId: o.store.id, code: "whatsapp_disconnected" } })).toBe(1);
  });

  it("drops message texts after the store's retention, and gives up on webhook events after their tries", async () => {
    const o = await connectedStore();
    const old = await waiting(o, "k-old");
    await systemDb.$executeRaw`UPDATE wapp_messages SET created_at = (now() at time zone 'utc') - interval '40 days', status = 'delivered', final_at = (now() at time zone 'utc') - interval '40 days' WHERE id = ${old.id}`;
    const fresh = await waiting(o, "k-new");
    const ev = await systemDb.wappWebhookEvent.create({
      data: { workspaceId: o.store.workspaceId, storeId: o.store.id, connectionId: o.conn.id, event: "MESSAGES_UPSERT", bodyHash: "h2", bodyEnc: waEncrypt(o.store.id, "webhook", "{}"), status: "pending", attempts: 5, receivedAt: new Date(Date.now() - 3600_000) },
    });
    await sweepWhatsapp(deps);
    expect(await systemDb.wappMessage.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({ previewEnc: null, payloadEnc: null });
    expect((await systemDb.wappMessage.findUniqueOrThrow({ where: { id: fresh.id } })).previewEnc).not.toBeNull();
    expect(await systemDb.wappWebhookEvent.findUniqueOrThrow({ where: { id: ev.id } })).toMatchObject({ status: "dead", bodyEnc: null });
  });
});

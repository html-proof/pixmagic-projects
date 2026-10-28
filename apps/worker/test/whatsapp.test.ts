import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectDb, systemDb, type Store } from "@app/db";
import { resetDb } from "@app/db/testing";
import {
  connectCloudApi,
  memoryBlobs,
  memoryCoord,
  memoryMailer,
  memoryQueues,
  queueMessage,
  resetEnvCache,
  retireQrLinking,
  saveWaSettings,
  sendQueuedMessage,
  sweepWhatsapp,
  upsertContact,
  waDecrypt,
  waEncrypt,
  type WhatsappJob,
} from "@app/core";
import { normalizePhone } from "@app/shared";
import { cloudApiFake, META_ENV, META_ENV_OFF, type CloudFake } from "../../../test-support/cloudApiFake.js";
import type { WorkerDeps } from "../src/handlers.js";
import { consume, type QueueMessage } from "../src/index.js";

/**
 * WhatsApp Automation inside the worker: the whatsapp queue's jobs through consume (a send never
 * throws for Meta's answer), the sweep (sends that never finished, connections checked with Meta,
 * tokens renewed, two days down, retention), and what is left of QR linking once Evolution API is
 * gone (retireQr.ts). Meta's Graph API is test-support/cloudApiFake.ts.
 */

const queues = memoryQueues();
const coord = memoryCoord();
let meta: CloudFake;
let deps: WorkerDeps;

beforeAll(() => {
  for (const [k, v] of Object.entries(META_ENV)) process.env[k] = v;
  resetEnvCache();
});
afterAll(async () => {
  for (const [k, v] of Object.entries(META_ENV_OFF)) process.env[k] = v;
  resetEnvCache();
  await disconnectDb();
});
beforeEach(async () => {
  await resetDb();
  queues.clear();
  coord.clear();
  meta = cloudApiFake();
  deps = { coord, queues, payloads: memoryBlobs(), mailer: memoryMailer(), fetchImpl: meta.fetch };
});

async function newStore() {
  const ws = await systemDb.workspace.create({ data: { name: "W" } });
  const user = await systemDb.user.create({ data: { email: `o${Math.random().toString(36).slice(2, 8)}@shop.test` } });
  const store = (await systemDb.store.create({
    data: { workspaceId: ws.id, shopDomain: `s${Math.random().toString(36).slice(2, 8)}.myshopify.com`, name: "Green Leaf", currency: "AUD", grantedScopes: ["read_orders"], status: "active", timezone: "UTC", pixelIngestKey: `pk-${Math.random()}` },
  })) as Store;
  await saveWaSettings({ store, userId: user.id, data: { businessName: null, orderUpdates: "checkout_notice", marketingEnabled: false, shopifySmsConsent: false, sendWindow: { start: 0, end: 24 }, timeZone: "UTC", dailyLimit: 200, perCustomerDailyLimit: 3, retentionDays: 30 } });
  return { store, user };
}

/** A store connected through Meta's Embedded Signup, with settings saved. */
async function connectedStore() {
  const { store, user } = await newStore();
  const s = meta.signup();
  const conn = await connectCloudApi(deps, { store, userId: user.id, data: { code: s.code, wabaId: s.wabaId, phoneNumberId: s.phoneNumberId } });
  expect(conn.status).toBe("connected");
  return { store, conn, user, signup: s };
}

/** A message to a customer who wrote in the last 24 hours (free text may answer them). */
async function waiting(o: { store: Store; conn: { id: string; provider: string } }, key = "k-1", text = "Your order is ready.") {
  const phone = normalizePhone("+61412345678", null)!;
  const contact = await upsertContact(o.store, phone);
  await systemDb.wappContact.update({ where: { id: contact.id }, data: { lastInboundAt: new Date() } });
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
  it("sends a message once through Meta, and a duplicate delivery of the job finds it taken", async () => {
    const o = await connectedStore();
    const m = await waiting(o);
    expect(queues.sent.whatsapp).toEqual([{ kind: "wapp_send", messageId: m.id }]);
    expect(await deliver({ kind: "wapp_send", messageId: m.id })).toEqual({ acked: true, retried: null });
    expect(await deliver({ kind: "wapp_send", messageId: m.id })).toEqual({ acked: true, retried: null });
    expect(meta.sends).toHaveLength(1);
    expect(meta.sends[0]).toMatchObject({ phoneNumberId: o.signup.phoneNumberId, to: "61412345678", text: "Your order is ready.", reference: m.id });
    expect(await systemDb.wappMessage.findUniqueOrThrow({ where: { id: m.id } })).toMatchObject({ status: "accepted", providerMessageId: meta.sends[0]!.id, payloadEnc: null });
  });

  it("puts a send back for later when Meta can't be reached, and fails it plainly after the last try", async () => {
    const o = await connectedStore();
    const m = await waiting(o);
    queues.clear();
    // Refused: the request never reached Meta, so it is safe to try again.
    meta.sendFails.push("refused");
    // The job itself succeeds: the row carries the retry, so the queue never sends the same job twice.
    expect(await deliver({ kind: "wapp_send", messageId: m.id })).toEqual({ acked: true, retried: null });
    const r = await systemDb.wappMessage.findUniqueOrThrow({ where: { id: m.id } });
    expect(r).toMatchObject({ status: "queued", attempts: 1, errorCode: "unreachable" });
    expect(queues.sentOpts.whatsapp.at(-1)).toEqual({ delaySeconds: 30 });
    // Its last try (the number's pace waived): failed, with what happened.
    await systemDb.wappMessage.update({ where: { id: m.id }, data: { attempts: 5, sendAfter: new Date() } });
    await coord.release(`wapp:pace:${o.conn.id}`);
    meta.sendFails.push("refused");
    await deliver({ kind: "wapp_send", messageId: m.id });
    expect(await systemDb.wappMessage.findUniqueOrThrow({ where: { id: m.id } })).toMatchObject({ status: "failed", reason: "gave_up", errorCode: "unreachable" });
    expect(meta.sends).toHaveLength(0);
  });

  it("opens a number's circuit after five failures in a row, and holds its other messages without spending their tries", async () => {
    const o = await connectedStore();
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push((await waiting(o, `k-c${i}`)).id);
    meta.sendFails.push("refused", "refused", "refused", "refused", "refused");
    const outcomes: string[] = [];
    for (const id of ids) {
      await coord.release(`wapp:pace:${o.conn.id}`);
      outcomes.push(await sendQueuedMessage(deps, id));
    }
    expect(outcomes).toEqual(["retry", "retry", "retry", "retry", "retry", "held"]);
    expect(await systemDb.wappMessage.findUniqueOrThrow({ where: { id: ids[5]! } })).toMatchObject({ status: "queued", reason: "provider_unavailable", attempts: 0 });
    expect(meta.sends).toHaveLength(0);
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

  it("checks each connection with Meta every few hours, and asks for a reconnect once when Meta refuses the token", async () => {
    const o = await connectedStore();
    // Checked a moment ago: not asked again.
    await sweepWhatsapp(deps);
    expect(meta.calls.filter((c) => c.path === o.signup.phoneNumberId)).toHaveLength(0);
    await systemDb.wappConnection.update({ where: { id: o.conn.id }, data: { lastCheckedAt: new Date(Date.now() - 7 * 3600_000) } });
    meta.tokens.forEach((t) => (t.valid = false));
    coord.clear();
    expect(await sweepWhatsapp(deps)).toMatchObject({ connections: 1 });
    expect(await systemDb.wappConnection.findUniqueOrThrow({ where: { id: o.conn.id } })).toMatchObject({ status: "logged_out", statusReason: "token_expired" });
    coord.clear();
    await sweepWhatsapp(deps);
    expect(await systemDb.alert.count({ where: { storeId: o.store.id, code: "whatsapp_reconnect", resolvedAt: null } })).toBe(1);
  });

  it("renews Meta's token on the row in its last 30 days, and asks for a reconnect once it has run out", async () => {
    const o = await connectedStore();
    const before = await systemDb.wappConnection.update({ where: { id: o.conn.id }, data: { tokenExpiresAt: new Date(Date.now() + 10 * 86_400_000) } });
    expect(await sweepWhatsapp(deps)).toMatchObject({ cloudTokens: 1 });
    const after = await systemDb.wappConnection.findUniqueOrThrow({ where: { id: o.conn.id } });
    const renewed = waDecrypt(o.store.id, "instance_token", after.instanceTokenEnc!);
    expect(renewed).not.toBe(waDecrypt(o.store.id, "instance_token", before.instanceTokenEnc!));
    expect(meta.tokens.get(renewed)).toMatchObject({ valid: true });
    expect(after.tokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 59 * 86_400_000);
    // A token past its expiry can't be renewed: the merchant connects again.
    await systemDb.wappConnection.update({ where: { id: o.conn.id }, data: { tokenExpiresAt: new Date(Date.now() - 60_000) } });
    coord.clear();
    await sweepWhatsapp(deps);
    expect(await systemDb.wappConnection.findUniqueOrThrow({ where: { id: o.conn.id } })).toMatchObject({ status: "logged_out", statusReason: "token_expired" });
    expect(await systemDb.alert.count({ where: { storeId: o.store.id, code: "whatsapp_reconnect" } })).toBe(1);
  });

  it("cancels what waits for a connection down for two days, and says so", async () => {
    const o = await connectedStore();
    const m = await waiting(o);
    await systemDb.wappConnection.update({ where: { id: o.conn.id }, data: { status: "logged_out", downSince: new Date(Date.now() - 49 * 3600_000) } });
    await sweepWhatsapp(deps);
    expect(await systemDb.wappMessage.findUniqueOrThrow({ where: { id: m.id } })).toMatchObject({ status: "cancelled", reason: "not_connected" });
    expect(await systemDb.alert.count({ where: { storeId: o.store.id, code: "whatsapp_disconnected" } })).toBe(1);
  });

  it("drops message texts after the store's retention, and stored Evolution events once set aside", async () => {
    const o = await connectedStore();
    const old = await waiting(o, "k-old");
    await systemDb.$executeRaw`UPDATE wapp_messages SET created_at = (now() at time zone 'utc') - interval '40 days', status = 'delivered', final_at = (now() at time zone 'utc') - interval '40 days' WHERE id = ${old.id}`;
    const fresh = await waiting(o, "k-new");
    const ev = await systemDb.wappWebhookEvent.create({
      data: { workspaceId: o.store.workspaceId, storeId: o.store.id, connectionId: o.conn.id, event: "MESSAGES_UPSERT", bodyHash: "h2", bodyEnc: waEncrypt(o.store.id, "webhook", "{}"), status: "pending", receivedAt: new Date(Date.now() - 3600_000) },
    });
    await sweepWhatsapp(deps);
    expect(await systemDb.wappMessage.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({ previewEnc: null, payloadEnc: null });
    expect((await systemDb.wappMessage.findUniqueOrThrow({ where: { id: fresh.id } })).previewEnc).not.toBeNull();
    expect(await systemDb.wappWebhookEvent.findUniqueOrThrow({ where: { id: ev.id } })).toMatchObject({ status: "ignored", bodyEnc: null });
  });
});

describe("what is left of QR linking (release 2 of removing Evolution)", () => {
  /** A store whose phone was linked with a QR code before 2026-10-28, which release 1's cleanup didn't reach. */
  async function qrStore(name: string) {
    const { store, user } = await newStore();
    const conn = await systemDb.wappConnection.create({
      data: { workspaceId: store.workspaceId, storeId: store.id, provider: "qr", status: "connected", shard: "a", instanceName: name, instanceTokenEnc: waEncrypt(store.id, "instance_token", `token-${name}`), webhookKeyEnc: waEncrypt(store.id, "webhook_key", "k"), connectedAt: new Date() },
    });
    const message = await waiting({ store, conn }, `qr-${name}`);
    const template = await systemDb.wappTemplate.create({ data: { workspaceId: store.workspaceId, storeId: store.id, name: "Thanks", category: "marketing", body: "Hi. Reply STOP to unsubscribe." } });
    const automation = await systemDb.wappAutomation.create({ data: { workspaceId: store.workspaceId, storeId: store.id, name: "Thanks", trigger: "order_created", templateId: template.id, status: "active" } });
    const campaign = await systemDb.wappCampaign.create({ data: { workspaceId: store.workspaceId, storeId: store.id, name: "Sale", templateId: template.id, audience: {}, status: "scheduled", scheduledAt: new Date(Date.now() + 3600_000) } });
    return { store, user, conn, message, automation, campaign };
  }

  it("retires a QR-linked phone release 1 didn't reach, forgets every instance, sets stored events aside; a second run changes nothing", async () => {
    const a = await qrStore("bi_aaaaaaaaaaaaaaaaaaaaaaaa");
    const b = await connectedStore();
    await systemDb.wappConnection.update({ where: { id: b.conn.id }, data: { instanceName: "bi_bbbbbbbbbbbbbbbbbbbbbbbb", instanceId: "id-b", webhookKeyEnc: waEncrypt(b.store.id, "webhook_key", "k") } });
    const ev = await systemDb.wappWebhookEvent.create({ data: { workspaceId: a.store.workspaceId, storeId: a.store.id, connectionId: a.conn.id, event: "MESSAGES_UPSERT", bodyHash: "h-qr", bodyEnc: waEncrypt(a.store.id, "webhook", "{}"), status: "pending" } });

    expect(await retireQrLinking(deps)).toEqual({ retired: 1, forgotten: 2, eventsSetAside: 1 });
    expect(await systemDb.wappConnection.findUniqueOrThrow({ where: { id: a.conn.id } })).toMatchObject({ status: "disconnected", statusReason: "qr_linking_retired", instanceName: null, instanceTokenEnc: null, webhookKeyEnc: null });
    expect(await systemDb.wappMessage.findUniqueOrThrow({ where: { id: a.message.id } })).toMatchObject({ status: "cancelled", reason: "qr_linking_retired" });
    expect(await systemDb.wappAutomation.findUniqueOrThrow({ where: { id: a.automation.id } })).toMatchObject({ status: "paused" });
    expect(await systemDb.wappCampaign.findUniqueOrThrow({ where: { id: a.campaign.id } })).toMatchObject({ status: "cancelled", cancelReason: "qr_linking_retired" });
    expect(await systemDb.alert.count({ where: { storeId: a.store.id, code: "whatsapp_qr_retired", resolvedAt: null } })).toBe(1);
    expect(await systemDb.wappWebhookEvent.findUniqueOrThrow({ where: { id: ev.id } })).toMatchObject({ status: "ignored", bodyEnc: null, lastError: expect.stringMatching(/Evolution API was removed/) });
    // The Cloud API number keeps its token and sends on.
    expect(await systemDb.wappConnection.findUniqueOrThrow({ where: { id: b.conn.id } })).toMatchObject({ status: "connected", instanceName: null, instanceTokenEnc: b.conn.instanceTokenEnc });
    expect(await sendQueuedMessage(deps, (await waiting(b, "k-after")).id)).toBe("accepted");

    expect(await retireQrLinking(deps)).toEqual({ retired: 0, forgotten: 0, eventsSetAside: 0 });
    expect(await systemDb.auditLog.count({ where: { action: "whatsapp.qr_linking_retired" } })).toBe(1);
  });

  it("sets a stored Evolution event aside when its job comes, and runs from the sweep under its own lock", async () => {
    const a = await qrStore("bi_cccccccccccccccccccccccc");
    const ev = await systemDb.wappWebhookEvent.create({ data: { workspaceId: a.store.workspaceId, storeId: a.store.id, connectionId: a.conn.id, event: "MESSAGES_UPDATE", bodyHash: "h-job", bodyEnc: "x", status: "pending" } });
    expect(await deliver({ kind: "wapp_event", eventId: ev.id })).toEqual({ acked: true, retried: null });
    expect(await systemDb.wappWebhookEvent.findUniqueOrThrow({ where: { id: ev.id } })).toMatchObject({ status: "ignored", bodyEnc: null });
    await coord.acquire("whatsapp:retire-qr", 60_000);
    expect(await retireQrLinking(deps)).toBeNull();
    await coord.release("whatsapp:retire-qr");
    expect(await sweepWhatsapp(deps)).toMatchObject({ qrRetired: 1, storedEventsSetAside: 0 });
  });
});

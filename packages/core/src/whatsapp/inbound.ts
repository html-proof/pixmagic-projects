/**
 * Customers' messages to the store's number (Meta's webhook; until the last QR-linked phone is
 * gone, also Evolution's MESSAGES_UPSERT), never the store's own.
 *
 * Anyone may write to a business number, so bizinsights keeps only what concerns the store's
 * customers:
 *  - STOP and START are honoured from anyone (a number that replied STOP goes on the store's
 *    do-not-message list by its keyed hash, nothing else of it is kept);
 *  - other messages are recorded only from numbers that are already the store's contacts (a
 *    customer bizinsights messaged or whose consent was recorded), and only they can start a
 *    "customer sends a message" automation. Everything else is dropped unread.
 * Group chats, broadcasts and statuses never reach this (this checks the sender is a person).
 */
import { systemDb, type WappConnection } from "@app/db";
import { maskPhone, normalizePhone, waIsStart, waIsStop, type WaFacts } from "@app/shared";
import { logger } from "../logger.js";
import { businessNameOf, settingsOf, storeById, waEncrypt, waPhoneHash, type WaDeps } from "./common.js";
import { contactByPhone, contactFirstName, optInByReply, optOutByReply } from "./contacts.js";
import { queueMessage } from "./messages.js";
import { runAutomations } from "./automations.js";

/** A WhatsApp JID's number ("61412345678@s.whatsapp.net" → "61412345678"); null for groups, broadcasts, LIDs. */
export function jidNumber(jid: string | null | undefined): string | null {
  if (!jid) return null;
  const m = /^(\d{6,15})(?::\d+)?@s\.whatsapp\.net$/.exec(jid);
  return m ? m[1]! : null;
}

/** A customer's message, already schema-checked: the sender as a JID (Meta's `from` is put in that form). */
export interface InboundMessage {
  id: string;
  remoteJid: string;
  fromMe: boolean;
  messageType: string | null;
  text: string | null;
  at: Date;
}

/** The text of a WhatsApp message: its body, or a picture's or document's caption. */
export function textOf(message: Record<string, unknown> | null | undefined): string | null {
  if (!message) return null;
  const m = message as {
    conversation?: string;
    extendedTextMessage?: { text?: string };
    imageMessage?: { caption?: string };
    videoMessage?: { caption?: string };
    documentMessage?: { caption?: string };
    buttonsResponseMessage?: { selectedDisplayText?: string };
    listResponseMessage?: { title?: string };
  };
  const t = m.conversation ?? m.extendedTextMessage?.text ?? m.imageMessage?.caption ?? m.videoMessage?.caption ?? m.documentMessage?.caption ?? m.buttonsResponseMessage?.selectedDisplayText ?? m.listResponseMessage?.title ?? null;
  return typeof t === "string" ? t.slice(0, 4096) : null;
}

/** Applies one customer message. Returns what happened, for the job's log. */
export async function applyInbound(deps: Pick<WaDeps, "queues">, conn: WappConnection, msg: InboundMessage): Promise<string> {
  if (msg.fromMe) return "own_message";
  const digits = jidNumber(msg.remoteJid);
  if (!digits) return "not_a_person";
  const phone = normalizePhone(`+${digits}`, null);
  if (!phone) return "not_a_person";
  const store = await storeById(conn.storeId);
  if (!store || store.status === "uninstalled") return "no_store";
  const contact = await contactByPhone(store.id, phone);
  const stop = waIsStop(msg.text);
  const start = !stop && waIsStart(msg.text);

  if (!contact) {
    // Not one of the store's customers: only STOP and START are kept (as the list's entry, by hash).
    if (stop) {
      await systemDb.wappSuppression.upsert({
        where: { storeId_phoneHash_scope: { storeId: store.id, phoneHash: waPhoneHash(store.id, phone.waId), scope: "all" } },
        create: { workspaceId: store.workspaceId, storeId: store.id, phoneHash: waPhoneHash(store.id, phone.waId), phoneMasked: maskPhone(phone.e164), scope: "all", reason: "stop_reply" },
        update: {},
      });
      return "stop_unknown";
    }
    if (start) {
      await systemDb.wappSuppression.deleteMany({ where: { storeId: store.id, phoneHash: waPhoneHash(store.id, phone.waId), scope: "all", reason: "stop_reply" } });
      return "start_unknown";
    }
    return "not_a_customer";
  }

  const settings = await settingsOf(store);
  // Each message once: Meta's retries and a replayed event find it recorded. A STOP or START is
  // applied again all the same while the contact doesn't show it yet: a try that failed after the
  // message was recorded must not lose the customer's opt-out.
  let duplicate = false;
  try {
    await systemDb.wappMessage.create({
      data: {
        workspaceId: store.workspaceId,
        storeId: store.id,
        connectionId: conn.id,
        provider: conn.provider,
        direction: "in",
        contactId: contact.id,
        phoneHash: contact.phoneHash,
        phoneMasked: contact.phoneMasked,
        source: "inbound",
        type: (msg.messageType ?? "text").slice(0, 40),
        previewEnc: msg.text ? waEncrypt(store.id, "preview", msg.text.slice(0, 1000)) : null,
        status: "received",
        providerMessageId: msg.id,
        acceptedAt: msg.at,
        finalAt: msg.at,
        sendAfter: msg.at,
      },
    });
  } catch (e) {
    if ((e as { code?: string }).code !== "P2002") throw e;
    duplicate = true;
  }
  if (duplicate && !(stop && !contact.optedOut) && !(start && contact.optedOut)) return "duplicate";
  if (!contact.lastInboundAt || contact.lastInboundAt < msg.at) await systemDb.wappContact.update({ where: { id: contact.id }, data: { lastInboundAt: msg.at } });

  const name = businessNameOf(store, settings);
  if (stop) {
    const updated = await optOutByReply(contact, msg.at);
    // One confirmation, the customer's own request.
    await queueMessage(deps, {
      store,
      conn,
      source: "reply",
      category: "transactional",
      phone,
      contactId: updated.id,
      payload: { text: `You won't get WhatsApp messages from ${name} any more. Reply START if you change your mind.` },
      idempotencyKey: `stop:${contact.id}:${msg.id}`,
    }).catch((err: unknown) => logger.warn({ err, storeId: store.id }, "whatsapp STOP confirmation not queued"));
    return "stop";
  }
  if (start) {
    await optInByReply(contact, msg.at);
    await queueMessage(deps, {
      store,
      conn,
      source: "reply",
      category: "transactional",
      phone,
      contactId: contact.id,
      payload: { text: `You're subscribed to WhatsApp messages from ${name} again. Reply STOP to unsubscribe.` },
      idempotencyKey: `start:${contact.id}:${msg.id}`,
    }).catch((err: unknown) => logger.warn({ err, storeId: store.id }, "whatsapp START confirmation not queued"));
    return "start";
  }
  if (contact.optedOut) return "recorded";

  // "A customer sends a message": once per automation and customer in each cool-down window.
  const autos = await systemDb.wappAutomation.findMany({ where: { storeId: store.id, trigger: "message_received", status: "active" }, select: { id: true, cooldownMinutes: true } });
  for (const a of autos) {
    const windowMs = (a.cooldownMinutes ?? 24 * 60) * 60_000;
    const recent = await systemDb.wappAutomationRun.findFirst({ where: { automationId: a.id, contactId: contact.id, outcome: "queued", createdAt: { gte: new Date(msg.at.getTime() - windowMs) } }, select: { id: true } });
    if (recent) continue;
    const facts: WaFacts = { orderTotal: null, country: contact.country, productTitles: [], customerType: null, tags: [], messageText: msg.text };
    await runAutomations(deps, {
      store,
      trigger: "message_received",
      key: `inbound:${contact.id}:${Math.floor(msg.at.getTime() / windowMs)}`,
      label: `Message from ${contact.phoneMasked}`,
      phones: { customer: phone, shipping_address: null, billing_address: null },
      contact: {},
      values: { customer_first_name: contactFirstName(contact) ?? undefined },
      facts,
      occurredAt: msg.at,
      automationIds: [a.id],
    });
  }
  return "recorded";
}

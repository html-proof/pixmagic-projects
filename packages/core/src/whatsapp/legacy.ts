/**
 * The earlier WhatsApp feature's tables (whatsapp_*, order_trackings, abandoned_checkouts,
 * customer_reviews, 2026-10-10 to 2026-10-24). Nothing sends from them or reads them any more:
 * they stay, untouched, until a later migration drops them (docs/whatsapp.md, "The old WhatsApp
 * tables"), so a rollback to the release before the rebuild still finds them. Until then the
 * store's and the customer's privacy rights still reach them, and a store that had a connection
 * there is told it was retired.
 */
import { systemDb, type Store } from "@app/db";
import { decrypt, normalizePhone } from "@app/shared";
import { logger } from "../logger.js";
import { customerKey } from "../persist.js";
import type { CustomersRedact } from "../shopifyPayloads.js";
import { keyring } from "../tokens.js";
import { waPhoneHash } from "./common.js";

/** A value the earlier feature encrypted (its AAD: `wa:<storeId>:<kind>`). */
export const legacyDecrypt = (storeId: string, kind: "phone" | "name", ciphertext: string) => decrypt(ciphertext, keyring(), `wa:${storeId}:${kind}`);

/** customers/redact on the old tables: the customer's contact, messages, order timelines, reviews and checkouts. */
export async function redactLegacyWhatsappCustomer(store: Pick<Store, "id">, p: CustomersRedact): Promise<number> {
  const ck = p.customer?.id ? customerKey(store, String(p.customer.id)) : null;
  const phone = normalizePhone(p.customer?.phone ?? null, null);
  const or = [...(ck ? [{ customerKey: ck }] : []), ...(phone ? [{ phoneHash: waPhoneHash(store.id, phone.waId) }] : [])];
  const contacts = or.length ? await systemDb.whatsappContact.findMany({ where: { storeId: store.id, OR: or }, select: { id: true } }) : [];
  const contactIds = contacts.map((c) => c.id);
  const orderIds = (p.orders_to_redact ?? []).map(String);
  if (!contactIds.length && !orderIds.length) return 0;
  const trackings = await systemDb.orderTracking.findMany({ where: { storeId: store.id, OR: [{ contactId: { in: contactIds } }, { shopifyOrderId: { in: orderIds } }] }, select: { id: true } });
  const trackingIds = trackings.map((t) => t.id);
  const messages = await systemDb.whatsappMessage.findMany({ where: { storeId: store.id, OR: [{ contactId: { in: contactIds } }, { trackingId: { in: trackingIds } }] }, select: { id: true } });
  const messageIds = messages.map((m) => m.id);
  await systemDb.$transaction([
    systemDb.whatsappMessageEvent.deleteMany({ where: { messageId: { in: messageIds } } }),
    systemDb.whatsappMessage.deleteMany({ where: { id: { in: messageIds } } }),
    systemDb.customerReview.deleteMany({ where: { trackingId: { in: trackingIds } } }),
    systemDb.orderTrackingEvent.deleteMany({ where: { trackingId: { in: trackingIds } } }),
    systemDb.orderTracking.deleteMany({ where: { id: { in: trackingIds } } }),
    systemDb.abandonedCheckout.deleteMany({ where: { storeId: store.id, contactId: { in: contactIds } } }),
    systemDb.whatsappAutomationRun.deleteMany({ where: { storeId: store.id, subjectKey: { in: [...orderIds.map((o) => `order:${o}`), ...contactIds.map((c) => `contact:${c}`)] } } }),
    systemDb.whatsappContact.deleteMany({ where: { id: { in: contactIds } } }),
  ]);
  const n = contactIds.length + trackingIds.length + messageIds.length;
  if (n) logger.info({ storeId: store.id, contacts: contactIds.length, orders: trackingIds.length, messages: messageIds.length }, "old whatsapp data redacted for a customer");
  return n;
}

/** The number a store had connected with the earlier feature, so the page can say it was retired (null: none). */
export async function legacyConnection(storeId: string): Promise<{ displayPhoneNumber: string | null; connectedAt: Date } | null> {
  const c = await systemDb.whatsappConnection.findUnique({ where: { storeId }, select: { displayPhoneNumber: true, createdAt: true } });
  return c ? { displayPhoneNumber: c.displayPhoneNumber, connectedAt: c.createdAt } : null;
}

/** How many records the old tables still hold about one customer (for the data request export). */
export async function legacyRecordCount(storeId: string, by: { phoneHash: string | null; customerKey: string | null }): Promise<number> {
  const or = [...(by.customerKey ? [{ customerKey: by.customerKey }] : []), ...(by.phoneHash ? [{ phoneHash: by.phoneHash }] : [])];
  if (!or.length) return 0;
  const contacts = await systemDb.whatsappContact.findMany({ where: { storeId, OR: or }, select: { id: true } });
  if (!contacts.length) return 0;
  const ids = contacts.map((c) => c.id);
  const [messages, checkouts] = await Promise.all([systemDb.whatsappMessage.count({ where: { contactId: { in: ids } } }), systemDb.abandonedCheckout.count({ where: { contactId: { in: ids } } })]);
  return contacts.length + messages + checkouts;
}

/**
 * The retired WhatsApp features' tables, erase-only until a later migration drops them
 * (docs/whatsapp.md, "The old WhatsApp tables"):
 *  - 2026-10-10 to 2026-10-24: whatsapp_*, order_trackings, abandoned_checkouts, customer_reviews;
 *  - 2026-10-25: wa_* (Meta Cloud API with the token kept at Nango).
 * Nothing sends from them or reads them for the page any more; they stay so a rollback to an
 * earlier release still finds them. Until they are dropped the store's and the customer's privacy
 * rights still reach them: customers/redact and shop/redact erase there too, a data request counts
 * what they hold, and erasing a store deletes the retired token at Nango.
 */
import { systemDb, type Store } from "@app/db";
import { normalizePhone } from "@app/shared";
import { logger } from "../logger.js";
import { customerKey } from "../persist.js";
import type { CustomersRedact } from "../shopifyPayloads.js";
import { waPhoneHash } from "./common.js";

/** customers/redact on the retired tables. Returns how many records went. */
export async function redactLegacyWhatsappCustomer(store: Pick<Store, "id">, p: CustomersRedact): Promise<number> {
  const ck = p.customer?.id ? customerKey(store, String(p.customer.id)) : null;
  const phone = normalizePhone(p.customer?.phone ?? null, null);
  const hash = phone ? waPhoneHash(store.id, phone.waId) : null;
  const orderIds = (p.orders_to_redact ?? []).map(String);
  let n = 0;

  // 2026-10-10 feature.
  const or = [...(ck ? [{ customerKey: ck }] : []), ...(hash ? [{ phoneHash: hash }] : [])];
  const contacts = or.length ? await systemDb.whatsappContact.findMany({ where: { storeId: store.id, OR: or }, select: { id: true } }) : [];
  const contactIds = contacts.map((c) => c.id);
  if (contactIds.length || orderIds.length) {
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
    n += contactIds.length + trackingIds.length + messageIds.length;
  }

  // 2026-10-25 module.
  const or2 = [...(hash ? [{ phoneHash: hash }] : []), ...(p.customer?.id != null ? [{ shopifyCustomerId: String(p.customer.id) }] : [])];
  const waContacts = or2.length ? await systemDb.waContact.findMany({ where: { storeId: store.id, OR: or2 }, select: { id: true, phoneHash: true } }) : [];
  const waIds = waContacts.map((c) => c.id);
  if (waIds.length) {
    const waMessages = await systemDb.waMessage.findMany({ where: { storeId: store.id, OR: [{ contactId: { in: waIds } }, { phoneHash: { in: waContacts.map((c) => c.phoneHash) } }] }, select: { id: true } });
    const waMessageIds = waMessages.map((m) => m.id);
    await systemDb.$transaction([
      systemDb.waMessageEvent.deleteMany({ where: { messageId: { in: waMessageIds } } }),
      systemDb.waMessage.deleteMany({ where: { id: { in: waMessageIds } } }),
      systemDb.waWorkflowRun.deleteMany({ where: { storeId: store.id, contactId: { in: waIds } } }),
      systemDb.waConsentEvent.deleteMany({ where: { contactId: { in: waIds } } }),
      systemDb.waContact.deleteMany({ where: { id: { in: waIds } } }),
    ]);
    n += waIds.length + waMessageIds.length;
  }
  if (orderIds.length) n += (await systemDb.waWorkflowRun.deleteMany({ where: { storeId: store.id, subjectKey: { in: orderIds.map((o) => `order:${o}`) } } })).count;
  if (n) logger.info({ storeId: store.id, records: n }, "retired whatsapp data redacted for a customer");
  return n;
}

/** How many records the retired tables still hold about one customer (for the data request export). */
export async function legacyRecordCount(storeId: string, by: { phoneHash: string | null; customerKey: string | null; customerId?: string | null }): Promise<number> {
  let n = 0;
  const or = [...(by.customerKey ? [{ customerKey: by.customerKey }] : []), ...(by.phoneHash ? [{ phoneHash: by.phoneHash }] : [])];
  if (or.length) {
    const contacts = await systemDb.whatsappContact.findMany({ where: { storeId, OR: or }, select: { id: true } });
    if (contacts.length) {
      const ids = contacts.map((c) => c.id);
      const [messages, checkouts] = await Promise.all([systemDb.whatsappMessage.count({ where: { contactId: { in: ids } } }), systemDb.abandonedCheckout.count({ where: { contactId: { in: ids } } })]);
      n += contacts.length + messages + checkouts;
    }
  }
  const or2 = [...(by.phoneHash ? [{ phoneHash: by.phoneHash }] : []), ...(by.customerId ? [{ shopifyCustomerId: by.customerId }] : [])];
  if (or2.length) {
    const wa = await systemDb.waContact.findMany({ where: { storeId, OR: or2 }, select: { id: true } });
    if (wa.length) n += wa.length + (await systemDb.waMessage.count({ where: { storeId, contactId: { in: wa.map((c) => c.id) } } }));
  }
  return n;
}

/** The number the store had connected with the retired Cloud API module, so the page can say so (null: none). */
export async function retiredConnection(storeId: string): Promise<{ displayPhoneNumber: string | null; connectedAt: Date } | null> {
  const c = await systemDb.waConnection.findUnique({ where: { storeId }, select: { displayPhoneNumber: true, connectedAt: true, status: true } });
  return c && c.status !== "disconnected" ? { displayPhoneNumber: c.displayPhoneNumber, connectedAt: c.connectedAt } : null;
}

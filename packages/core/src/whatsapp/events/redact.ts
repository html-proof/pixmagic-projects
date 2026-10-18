/**
 * GDPR: what WhatsApp holds about a customer, erased on Shopify's customers/redact.
 */
import { systemDb, type Store } from "@app/db";
import { normalizePhone } from "@app/shared";
import { logger } from "../../logger.js";
import { customerKey } from "../../persist.js";
import type { CustomersRedact } from "../../shopifyPayloads.js";
import { phoneHash } from "../store.js";

/** customers/redact: everything WhatsApp holds about this customer goes. */
export async function redactWhatsappCustomer(store: Pick<Store, "id">, p: CustomersRedact): Promise<number> {
  const ck = p.customer?.id ? customerKey(store, String(p.customer.id)) : null;
  const phone = normalizePhone(p.customer?.phone ?? null, null);
  const contacts = await systemDb.whatsappContact.findMany({
    where: { storeId: store.id, OR: [...(ck ? [{ customerKey: ck }] : []), ...(phone ? [{ phoneHash: phoneHash(store.id, phone.waId) }] : [])] },
    select: { id: true },
  });
  const contactIds = contacts.map((c) => c.id);
  const orderIds = (p.orders_to_redact ?? []).map(String);
  if (!contactIds.length && !orderIds.length) return 0;
  const trackings = await systemDb.orderTracking.findMany({
    where: { storeId: store.id, OR: [{ contactId: { in: contactIds } }, { shopifyOrderId: { in: orderIds } }] },
    select: { id: true },
  });
  const trackingIds = trackings.map((t) => t.id);
  const messages = await systemDb.whatsappMessage.findMany({
    where: { storeId: store.id, OR: [{ contactId: { in: contactIds } }, { trackingId: { in: trackingIds } }] },
    select: { id: true },
  });
  const messageIds = messages.map((m) => m.id);
  await systemDb.$transaction([
    systemDb.whatsappMessageEvent.deleteMany({ where: { messageId: { in: messageIds } } }),
    systemDb.whatsappMessage.deleteMany({ where: { id: { in: messageIds } } }),
    systemDb.customerReview.deleteMany({ where: { trackingId: { in: trackingIds } } }),
    systemDb.orderTrackingEvent.deleteMany({ where: { trackingId: { in: trackingIds } } }),
    systemDb.orderTracking.deleteMany({ where: { id: { in: trackingIds } } }),
    systemDb.abandonedCheckout.deleteMany({ where: { storeId: store.id, contactId: { in: contactIds } } }),
    systemDb.whatsappContact.deleteMany({ where: { id: { in: contactIds } } }),
  ]);
  logger.info({ storeId: store.id, contacts: contactIds.length, orders: trackingIds.length, messages: messageIds.length }, "whatsapp data redacted for a customer");
  return contactIds.length + trackingIds.length;
}

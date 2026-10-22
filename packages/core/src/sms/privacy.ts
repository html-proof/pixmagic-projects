/**
 * GDPR for Customer Messaging: what it holds about a customer, erased on Shopify's
 * customers/redact and included in a customers/data_request export. A store's tables are erased
 * with the store by purgeStoreData (persist.ts).
 *
 * A suppression stays after an erasure: it is a keyed hash and a masked number, kept so the
 * customer's opt-out goes on being honoured.
 */
import { Prisma, systemDb, type Store } from "@app/db";
import { normalizePhone } from "@app/shared";
import { logger } from "../logger.js";
import { customerKey } from "../persist.js";
import type { CustomersRedact } from "../shopifyPayloads.js";
import { smsDecrypt, smsPhoneHash } from "./common.js";

async function contactsFor(store: Pick<Store, "id">, o: { customerId?: string | null; phone?: string | null; orderIds?: string[] }) {
  const ck = o.customerId ? customerKey(store, o.customerId) : null;
  const phone = normalizePhone(o.phone ?? null, null);
  const byOrder = o.orderIds?.length ? await systemDb.smsContactOrder.findMany({ where: { storeId: store.id, shopifyOrderId: { in: o.orderIds } }, select: { contactId: true } }) : [];
  const or: Prisma.SmsContactWhereInput[] = [
    ...(ck ? [{ customerKey: ck }] : []),
    ...(o.customerId ? [{ shopifyCustomerId: o.customerId }] : []),
    ...(phone ? [{ phoneHash: smsPhoneHash(store.id, phone.e164) }] : []),
    ...(byOrder.length ? [{ id: { in: byOrder.map((b) => b.contactId) } }] : []),
  ];
  if (!or.length) return [];
  return systemDb.smsContact.findMany({ where: { storeId: store.id, OR: or } });
}

/** customers/redact: the customer's numbers, consent history, orders seen, checkouts and texts go. */
export async function redactSmsCustomer(store: Pick<Store, "id">, p: CustomersRedact): Promise<number> {
  const contacts = await contactsFor(store, { customerId: p.customer?.id != null ? String(p.customer.id) : null, phone: p.customer?.phone ?? null, orderIds: (p.orders_to_redact ?? []).map(String) });
  const ids = contacts.map((c) => c.id);
  if (!ids.length) return 0;
  await systemDb.$transaction([
    systemDb.smsMessageJob.deleteMany({ where: { storeId: store.id, contactId: { in: ids } } }),
    systemDb.smsCampaignRecipient.deleteMany({ where: { storeId: store.id, contactId: { in: ids } } }),
    systemDb.smsCheckout.deleteMany({ where: { storeId: store.id, contactId: { in: ids } } }),
    // Consent records and orders seen go with the contact (cascade).
    systemDb.smsContact.deleteMany({ where: { id: { in: ids } } }),
  ]);
  logger.info({ storeId: store.id, contacts: ids.length }, "sms data redacted for a customer");
  return ids.length;
}

const reveal = (f: () => string | null) => {
  try {
    return f();
  } catch {
    return null;
  }
};

/** What a customers/data_request export says about SMS: numbers, consent history and texts (their words while still kept). */
export async function smsExportFor(tx: Prisma.TransactionClient, workspaceId: string, storeId: string, request: { customerKey: string | null; customerId: string | null; ordersRequested: string[] }) {
  const byOrder = request.ordersRequested.length ? await tx.smsContactOrder.findMany({ where: { workspaceId, storeId, shopifyOrderId: { in: request.ordersRequested } }, select: { contactId: true } }) : [];
  const or: Prisma.SmsContactWhereInput[] = [
    ...(request.customerKey ? [{ customerKey: request.customerKey }] : []),
    ...(request.customerId ? [{ shopifyCustomerId: request.customerId }] : []),
    ...(byOrder.length ? [{ id: { in: byOrder.map((b) => b.contactId) } }] : []),
  ];
  const contacts = or.length ? await tx.smsContact.findMany({ where: { workspaceId, storeId, OR: or }, include: { consentRecords: { orderBy: { recordedAt: "asc" } } } }) : [];
  const ids = contacts.map((c) => c.id);
  const messages = ids.length ? await tx.smsMessageJob.findMany({ where: { workspaceId, storeId, contactId: { in: ids } }, orderBy: { createdAt: "asc" } }) : [];
  return {
    contacts: contacts.map((c) => ({
      phone: reveal(() => smsDecrypt(c.storeId, "phone", c.phoneEnc)),
      firstName: c.firstNameEnc ? reveal(() => smsDecrypt(c.storeId, "name", c.firstNameEnc!)) : null,
      country: c.country,
      marketingConsent: c.consentState,
      consentUpdatedAt: c.consentUpdatedAt?.toISOString() ?? null,
      optedOut: c.suppressedAll || c.suppressedMarketing,
      consentHistory: c.consentRecords.map((r) => ({ state: r.state, purpose: r.purpose, source: r.source, at: r.effectiveAt.toISOString() })),
      firstSeenAt: c.createdAt.toISOString(),
    })),
    messages: messages.map((m) => ({
      purpose: m.purpose,
      category: m.category,
      status: m.status,
      to: m.phoneMasked,
      text: m.bodyEnc ? reveal(() => smsDecrypt(m.storeId, "body", m.bodyEnc!)) : null,
      createdAt: m.createdAt.toISOString(),
      acceptedAt: m.acceptedAt?.toISOString() ?? null,
    })),
  };
}

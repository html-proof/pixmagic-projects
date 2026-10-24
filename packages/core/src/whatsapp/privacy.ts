/**
 * WhatsApp Automation and privacy: what it holds about one customer (for Shopify's
 * customers/data_request export), erasing it (customers/redact), erasing a whole store
 * (shop/redact), and re-encrypting everything under a new key (key rotation).
 *
 * A customer is found by their number's keyed hash, or by Shopify's customer id when an event
 * carried it. Nothing is decrypted to find anyone.
 */
import { systemDb, type Store, type Tx } from "@app/db";
import { normalizePhone } from "@app/shared";
import { logger } from "../logger.js";
import type { CustomersRedact } from "../shopifyPayloads.js";
import { waDecrypt, waPhoneHash, waReencrypt, type WaSecretKind } from "./common.js";
import { redactLegacyWhatsappCustomer } from "./legacy.js";

const contactWhere = (storeId: string, by: { phoneHash?: string | null; customerId?: string | null }) => {
  const or = [...(by.phoneHash ? [{ phoneHash: by.phoneHash }] : []), ...(by.customerId ? [{ shopifyCustomerId: by.customerId }] : [])];
  return or.length ? { storeId, OR: or } : null;
};

/** customers/redact: the customer's contact, consent record, messages and workflow runs go. Returns how many records. */
export async function redactWhatsappCustomer(store: Pick<Store, "id">, p: CustomersRedact): Promise<number> {
  const phone = normalizePhone(p.customer?.phone ?? null, null);
  const where = contactWhere(store.id, { phoneHash: phone ? waPhoneHash(store.id, phone.waId) : null, customerId: p.customer?.id != null ? String(p.customer.id) : null });
  let erased = 0;
  if (where) {
    const contacts = await systemDb.waContact.findMany({ where, select: { id: true, phoneHash: true } });
    const ids = contacts.map((c) => c.id);
    const hashes = contacts.map((c) => c.phoneHash);
    if (ids.length) {
      const messages = await systemDb.waMessage.findMany({ where: { storeId: store.id, OR: [{ contactId: { in: ids } }, { phoneHash: { in: hashes } }] }, select: { id: true } });
      const messageIds = messages.map((m) => m.id);
      await systemDb.$transaction([
        systemDb.waMessageEvent.deleteMany({ where: { messageId: { in: messageIds } } }),
        systemDb.waMessage.deleteMany({ where: { id: { in: messageIds } } }),
        systemDb.waWorkflowRun.deleteMany({ where: { storeId: store.id, contactId: { in: ids } } }),
        systemDb.waConsentEvent.deleteMany({ where: { contactId: { in: ids } } }),
        systemDb.waContact.deleteMany({ where: { id: { in: ids } } }),
      ]);
      erased += ids.length + messageIds.length;
      logger.info({ storeId: store.id, contacts: ids.length, messages: messageIds.length }, "whatsapp data redacted for a customer");
    }
  }
  // Workflow runs name orders, not people: the orders Shopify asked to redact lose theirs too.
  const orders = (p.orders_to_redact ?? []).map((id) => `order:${id}`);
  if (orders.length) erased += (await systemDb.waWorkflowRun.deleteMany({ where: { storeId: store.id, subjectKey: { in: orders } } })).count;
  // What the earlier WhatsApp feature still holds until its tables are dropped.
  erased += await redactLegacyWhatsappCustomer(store, p);
  return erased;
}

/** A secret field that can no longer be read (a retired key) is reported as such, not dropped. */
function reveal(read: () => string | null): string | null {
  try {
    return read();
  } catch {
    return "[could not be decrypted]";
  }
}

/** What WhatsApp Automation holds about one customer, for the data request export. In the tenant transaction. */
export async function whatsappExportFor(tx: Tx, workspaceId: string, storeId: string, by: { phoneHash: string | null; customerId: string | null }) {
  const where = contactWhere(storeId, by);
  const contacts = where ? await tx.waContact.findMany({ where: { ...where, workspaceId } }) : [];
  const ids = contacts.map((c) => c.id);
  const [consent, messages] = ids.length
    ? await Promise.all([
        tx.waConsentEvent.findMany({ where: { workspaceId, contactId: { in: ids } }, orderBy: { occurredAt: "asc" } }),
        tx.waMessage.findMany({ where: { workspaceId, storeId, contactId: { in: ids } }, orderBy: { createdAt: "asc" }, take: 5000 }),
      ])
    : [[], []];
  return {
    contacts: contacts.map((c) => ({
      phone: reveal(() => waDecrypt(c.storeId, "phone", c.phoneEnc)),
      firstName: c.firstNameEnc ? reveal(() => waDecrypt(c.storeId, "name", c.firstNameEnc!)) : null,
      country: c.country,
      optedOut: c.optedOut,
      optedIn: c.optedIn,
      marketing: c.marketing,
      lastMessageFromCustomerAt: c.lastInboundAt?.toISOString() ?? null,
      firstSeenAt: c.createdAt.toISOString(),
    })),
    consent: consent.map((e) => ({ scope: e.scope, status: e.status, source: e.source, note: e.note, at: e.occurredAt.toISOString() })),
    messages: messages.map((m) => ({
      direction: m.direction,
      type: m.type,
      template: m.templateName,
      text: m.previewEnc ? reveal(() => waDecrypt(m.storeId, "preview", m.previewEnc!)) : null,
      status: m.status,
      createdAt: m.createdAt.toISOString(),
      sentAt: m.sentAt?.toISOString() ?? m.acceptedAt?.toISOString() ?? null,
      deliveredAt: m.deliveredAt?.toISOString() ?? null,
      readAt: m.readAt?.toISOString() ?? null,
    })),
  };
}

/** Re-encrypt every WhatsApp Automation secret with the active key (step 2 of a key rotation). Returns how many changed. */
export async function reencryptWhatsappData(): Promise<number> {
  let n = 0;
  const again = (scope: string, kind: WaSecretKind, v: string | null) => (v ? waReencrypt(scope, kind, v) : null);
  for (const c of await systemDb.waConnection.findMany({ where: { pinEnc: { not: null } }, select: { id: true, storeId: true, pinEnc: true } })) {
    const pin = again(c.storeId, "pin", c.pinEnc);
    if (pin) n += (await systemDb.waConnection.updateMany({ where: { id: c.id, pinEnc: c.pinEnc }, data: { pinEnc: pin } })).count;
  }
  for (const s of await systemDb.waSettings.findMany({ where: { testPhoneEnc: { not: null } }, select: { storeId: true, testPhoneEnc: true } })) {
    const v = again(s.storeId, "test_phone", s.testPhoneEnc);
    if (v) n += (await systemDb.waSettings.updateMany({ where: { storeId: s.storeId, testPhoneEnc: s.testPhoneEnc }, data: { testPhoneEnc: v } })).count;
  }
  let cursor: string | undefined;
  for (;;) {
    const rows: Array<{ id: string; storeId: string; phoneEnc: string; firstNameEnc: string | null }> = await systemDb.waContact.findMany({ take: 500, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}), orderBy: { id: "asc" }, select: { id: true, storeId: true, phoneEnc: true, firstNameEnc: true } });
    if (!rows.length) break;
    for (const c of rows) {
      const phone = again(c.storeId, "phone", c.phoneEnc);
      const name = again(c.storeId, "name", c.firstNameEnc);
      if (phone || name) n += (await systemDb.waContact.updateMany({ where: { id: c.id, phoneEnc: c.phoneEnc, firstNameEnc: c.firstNameEnc }, data: { ...(phone ? { phoneEnc: phone } : {}), ...(name ? { firstNameEnc: name } : {}) } })).count;
    }
    cursor = rows.at(-1)!.id;
  }
  cursor = undefined;
  for (;;) {
    const rows: Array<{ id: string; storeId: string; phoneEnc: string | null; payloadEnc: string | null; previewEnc: string | null; updatedAt: Date }> = await systemDb.waMessage.findMany({
      take: 500,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: "asc" },
      where: { OR: [{ phoneEnc: { not: null } }, { payloadEnc: { not: null } }, { previewEnc: { not: null } }] },
      select: { id: true, storeId: true, phoneEnc: true, payloadEnc: true, previewEnc: true, updatedAt: true },
    });
    if (!rows.length) break;
    for (const m of rows) {
      const phone = again(m.storeId, "phone", m.phoneEnc);
      const payload = again(m.storeId, "payload", m.payloadEnc);
      const preview = again(m.storeId, "preview", m.previewEnc);
      if (phone || payload || preview) {
        // Only over what was read: a message sent meanwhile (its payload cleared) isn't given it back.
        n += (await systemDb.waMessage.updateMany({ where: { id: m.id, phoneEnc: m.phoneEnc, payloadEnc: m.payloadEnc, previewEnc: m.previewEnc }, data: { ...(phone ? { phoneEnc: phone } : {}), ...(payload ? { payloadEnc: payload } : {}), ...(preview ? { previewEnc: preview } : {}), updatedAt: m.updatedAt } })).count;
      }
    }
    cursor = rows.at(-1)!.id;
  }
  for (const w of await systemDb.waWebhookEvent.findMany({ where: { bodyEnc: { not: null } }, select: { id: true, bodyEnc: true } })) {
    const v = again(w.id, "webhook", w.bodyEnc);
    if (v) n += (await systemDb.waWebhookEvent.updateMany({ where: { id: w.id, bodyEnc: w.bodyEnc }, data: { bodyEnc: v } })).count;
  }
  return n;
}

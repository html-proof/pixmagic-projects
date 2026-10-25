/**
 * WhatsApp Automation and privacy (docs/whatsapp.md, "Privacy and retention"): what it holds about
 * one customer (Shopify's customers/data_request export), erasing it (customers/redact), and
 * re-encrypting everything under a new key (key rotation). A customer is found by their number's
 * keyed hash or Shopify's customer id; nothing is decrypted to find anyone.
 *
 * A redacted customer's entry on the do-not-message list stays (hash and masked number only): it is
 * what keeps a STOP honoured if their number turns up on a later order.
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

/** customers/redact: the customer's contact, consent history, messages and automation runs go. Returns how many records. */
export async function redactWhatsappCustomer(store: Pick<Store, "id">, p: CustomersRedact): Promise<number> {
  const phone = normalizePhone(p.customer?.phone ?? null, null);
  const where = contactWhere(store.id, { phoneHash: phone ? waPhoneHash(store.id, phone.waId) : null, customerId: p.customer?.id != null ? String(p.customer.id) : null });
  let erased = 0;
  if (where) {
    const contacts = await systemDb.wappContact.findMany({ where, select: { id: true, phoneHash: true } });
    const ids = contacts.map((c) => c.id);
    const hashes = contacts.map((c) => c.phoneHash);
    if (ids.length) {
      const messages = await systemDb.wappMessage.findMany({ where: { storeId: store.id, OR: [{ contactId: { in: ids } }, { phoneHash: { in: hashes } }] }, select: { id: true } });
      const messageIds = messages.map((m) => m.id);
      await systemDb.$transaction([
        systemDb.wappMessageEvent.deleteMany({ where: { messageId: { in: messageIds } } }),
        systemDb.wappMessage.deleteMany({ where: { id: { in: messageIds } } }),
        systemDb.wappAutomationRun.deleteMany({ where: { storeId: store.id, contactId: { in: ids } } }),
        systemDb.wappConsentEvent.deleteMany({ where: { contactId: { in: ids } } }),
        systemDb.wappContact.deleteMany({ where: { id: { in: ids } } }),
      ]);
      erased += ids.length + messageIds.length;
      logger.info({ storeId: store.id, contacts: ids.length, messages: messageIds.length }, "whatsapp data redacted for a customer");
    }
  }
  // Automation runs name orders, not people: the orders Shopify asked to redact lose theirs too.
  const orders = (p.orders_to_redact ?? []).map((id) => `order:${id}`);
  if (orders.length) erased += (await systemDb.wappAutomationRun.deleteMany({ where: { storeId: store.id, subjectKey: { in: orders } } })).count;
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
  const contacts = where ? await tx.wappContact.findMany({ where: { ...where, workspaceId } }) : [];
  const ids = contacts.map((c) => c.id);
  const [consent, messages] = ids.length
    ? await Promise.all([
        tx.wappConsentEvent.findMany({ where: { workspaceId, contactId: { in: ids } }, orderBy: { occurredAt: "asc" } }),
        tx.wappMessage.findMany({ where: { workspaceId, storeId, contactId: { in: ids } }, orderBy: { createdAt: "asc" }, take: 5000 }),
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
      text: m.previewEnc ? reveal(() => waDecrypt(m.storeId, "preview", m.previewEnc!)) : null,
      status: m.status,
      createdAt: m.createdAt.toISOString(),
      sentAt: m.sentAt?.toISOString() ?? m.acceptedAt?.toISOString() ?? null,
      deliveredAt: m.deliveredAt?.toISOString() ?? null,
      readAt: m.readAt?.toISOString() ?? null,
    })),
  };
}

/** Re-encrypts every WhatsApp Automation secret with the active key (step 2 of a key rotation). Returns how many changed. */
export async function reencryptWhatsappData(): Promise<number> {
  let n = 0;
  const again = (scope: string, kind: WaSecretKind, v: string | null) => (v ? waReencrypt(scope, kind, v) : null);
  for (const c of await systemDb.wappConnection.findMany({ where: { OR: [{ instanceTokenEnc: { not: null } }, { webhookKeyEnc: { not: null } }, { phoneEnc: { not: null } }] } })) {
    const token = again(c.storeId, "instance_token", c.instanceTokenEnc);
    const key = again(c.storeId, "webhook_key", c.webhookKeyEnc);
    const phone = again(c.storeId, "linked_phone", c.phoneEnc);
    if (token || key || phone) {
      n += (
        await systemDb.wappConnection.updateMany({
          where: { id: c.id, instanceTokenEnc: c.instanceTokenEnc, webhookKeyEnc: c.webhookKeyEnc, phoneEnc: c.phoneEnc },
          data: { ...(token ? { instanceTokenEnc: token } : {}), ...(key ? { webhookKeyEnc: key } : {}), ...(phone ? { phoneEnc: phone } : {}) },
        })
      ).count;
    }
  }
  for (const s of await systemDb.wappSettings.findMany({ where: { testPhoneEnc: { not: null } }, select: { storeId: true, testPhoneEnc: true } })) {
    const v = again(s.storeId, "test_phone", s.testPhoneEnc);
    if (v) n += (await systemDb.wappSettings.updateMany({ where: { storeId: s.storeId, testPhoneEnc: s.testPhoneEnc }, data: { testPhoneEnc: v } })).count;
  }
  let cursor: string | undefined;
  for (;;) {
    const rows: Array<{ id: string; storeId: string; phoneEnc: string; firstNameEnc: string | null }> = await systemDb.wappContact.findMany({ take: 500, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}), orderBy: { id: "asc" }, select: { id: true, storeId: true, phoneEnc: true, firstNameEnc: true } });
    if (!rows.length) break;
    for (const c of rows) {
      const phone = again(c.storeId, "phone", c.phoneEnc);
      const name = again(c.storeId, "name", c.firstNameEnc);
      if (phone || name) n += (await systemDb.wappContact.updateMany({ where: { id: c.id, phoneEnc: c.phoneEnc, firstNameEnc: c.firstNameEnc }, data: { ...(phone ? { phoneEnc: phone } : {}), ...(name ? { firstNameEnc: name } : {}) } })).count;
    }
    cursor = rows.at(-1)!.id;
  }
  cursor = undefined;
  for (;;) {
    const rows: Array<{ id: string; storeId: string; phoneEnc: string | null; payloadEnc: string | null; previewEnc: string | null; updatedAt: Date }> = await systemDb.wappMessage.findMany({
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
        n += (await systemDb.wappMessage.updateMany({ where: { id: m.id, phoneEnc: m.phoneEnc, payloadEnc: m.payloadEnc, previewEnc: m.previewEnc }, data: { ...(phone ? { phoneEnc: phone } : {}), ...(payload ? { payloadEnc: payload } : {}), ...(preview ? { previewEnc: preview } : {}), updatedAt: m.updatedAt } })).count;
      }
    }
    cursor = rows.at(-1)!.id;
  }
  for (const w of await systemDb.wappWebhookEvent.findMany({ where: { bodyEnc: { not: null } }, select: { id: true, storeId: true, bodyEnc: true } })) {
    const v = again(w.storeId, "webhook", w.bodyEnc);
    if (v) n += (await systemDb.wappWebhookEvent.updateMany({ where: { id: w.id, bodyEnc: w.bodyEnc }, data: { bodyEnc: v } })).count;
  }
  return n;
}

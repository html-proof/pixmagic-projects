/**
 * Customers' WhatsApp numbers at a store and what they agreed to (docs/whatsapp.md, "Consent").
 * A number is stored encrypted, found by its keyed hash and shown masked. Every change of consent
 * is recorded with where it came from; STOP from a customer stops everything at once.
 */
import { systemDb, type Prisma, type WappContact } from "@app/db";
import { maskPhone, normalizePhone, type NormalizedPhone, type WaConsentFacts, type WaConsentSource, type WaMarketingState, type WaSuppressionScope } from "@app/shared";
import { logger } from "../logger.js";
import { audit } from "../notify.js";
import { waDecrypt, waEncrypt, waPhoneHash, WhatsappError } from "./common.js";

/** What an event knows about the customer behind a number. */
export interface ContactDetails {
  firstName?: string | null;
  shopifyCustomerId?: string | null;
  ordersCount?: number | null;
  totalSpent?: number | null;
  lastOrderAt?: Date | null;
}

/** The contact for a number at a store, made when it is first seen. Details only fill in or move forward. */
export async function upsertContact(store: { id: string; workspaceId: string }, phone: NormalizedPhone, d: ContactDetails = {}): Promise<WappContact> {
  const phoneHash = waPhoneHash(store.id, phone.waId);
  const firstName = d.firstName?.trim().slice(0, 60) || null;
  const known = await systemDb.wappContact.findUnique({ where: { storeId_phoneHash: { storeId: store.id, phoneHash } } });
  const details: Prisma.WappContactUpdateInput = {
    ...(firstName ? { firstNameEnc: waEncrypt(store.id, "name", firstName) } : {}),
    ...(d.shopifyCustomerId ? { shopifyCustomerId: d.shopifyCustomerId } : {}),
    ...(d.ordersCount != null && d.ordersCount >= (known?.ordersCount ?? 0) ? { ordersCount: d.ordersCount } : {}),
    ...(d.totalSpent != null && Number.isFinite(d.totalSpent) && d.totalSpent >= Number(known?.totalSpent ?? 0) ? { totalSpent: d.totalSpent } : {}),
    ...(d.lastOrderAt && (!known?.lastOrderAt || d.lastOrderAt > known.lastOrderAt) ? { lastOrderAt: d.lastOrderAt } : {}),
  };
  if (known) return Object.keys(details).length ? systemDb.wappContact.update({ where: { id: known.id }, data: details }) : known;
  try {
    return await systemDb.wappContact.create({
      data: {
        workspaceId: store.workspaceId,
        storeId: store.id,
        phoneHash,
        phoneEnc: waEncrypt(store.id, "phone", phone.e164),
        phoneMasked: maskPhone(phone.e164),
        country: phone.country,
        firstNameEnc: firstName ? waEncrypt(store.id, "name", firstName) : null,
        shopifyCustomerId: d.shopifyCustomerId ?? null,
        ordersCount: d.ordersCount ?? 0,
        totalSpent: d.totalSpent != null && Number.isFinite(d.totalSpent) ? d.totalSpent : 0,
        lastOrderAt: d.lastOrderAt ?? null,
      },
    });
  } catch (e) {
    // Two events for a new number at once: the other one made it.
    if ((e as { code?: string }).code === "P2002") return systemDb.wappContact.findUniqueOrThrow({ where: { storeId_phoneHash: { storeId: store.id, phoneHash } } });
    throw e;
  }
}

export async function contactByPhone(storeId: string, phone: NormalizedPhone): Promise<WappContact | null> {
  return systemDb.wappContact.findUnique({ where: { storeId_phoneHash: { storeId, phoneHash: waPhoneHash(storeId, phone.waId) } } });
}

export const contactPhone = (c: Pick<WappContact, "storeId" | "phoneEnc">) => waDecrypt(c.storeId, "phone", c.phoneEnc);
export const contactFirstName = (c: Pick<WappContact, "storeId" | "firstNameEnc">) => (c.firstNameEnc ? waDecrypt(c.storeId, "name", c.firstNameEnc) : null);

/** The store's do-not-message list for a number: which scopes it is on. */
export async function suppressionsOf(storeId: string, phoneHash: string): Promise<Set<WaSuppressionScope>> {
  const rows = await systemDb.wappSuppression.findMany({ where: { storeId, phoneHash }, select: { scope: true } });
  return new Set(rows.map((r) => r.scope as WaSuppressionScope));
}

/**
 * Whether a number asked not to get this store's messages: it is on the do-not-message list (for
 * everything, or for marketing when the message is marketing), or its contact opted out. Checked for
 * every message, the store's own numbers' (tests, codes, team alerts) included.
 */
export async function onDoNotMessageList(storeId: string, phoneHash: string, category: "transactional" | "marketing"): Promise<boolean> {
  const scopes = await suppressionsOf(storeId, phoneHash);
  if (scopes.has("all") || (category === "marketing" && scopes.has("marketing"))) return true;
  const c = await systemDb.wappContact.findUnique({ where: { storeId_phoneHash: { storeId, phoneHash } }, select: { optedOut: true } });
  return !!c?.optedOut;
}

/** What consent says about a contact, for a message of `category`. */
export async function consentFacts(c: WappContact, category: "transactional" | "marketing"): Promise<WaConsentFacts> {
  const scopes = await suppressionsOf(c.storeId, c.phoneHash);
  return { optedOut: c.optedOut, optedIn: c.optedIn, marketing: c.marketing as WaMarketingState, suppressed: scopes.has("all") || (category === "marketing" && scopes.has("marketing")) };
}

interface ConsentChange {
  scope: "all" | "order_updates" | "marketing";
  status: "opted_in" | "opted_out";
  source: WaConsentSource;
  actorUserId?: string | null;
  note?: string | null;
  at?: Date;
}

/** Records a consent change and applies it to the contact. Returns the contact as it stands after. */
export async function recordConsent(contact: WappContact, change: ConsentChange): Promise<WappContact> {
  const at = change.at ?? new Date();
  // An older change (a retried Shopify event) never overrides a newer one.
  if (contact.consentUpdatedAt && at < contact.consentUpdatedAt && change.source !== "whatsapp_stop") return contact;
  const data: Prisma.WappContactUpdateInput = { consentUpdatedAt: at };
  if (change.scope === "all") {
    data.optedOut = change.status === "opted_out";
    if (change.status === "opted_out") {
      data.optedIn = false;
      data.marketing = "opted_out";
    } else {
      data.optedIn = true;
    }
  } else if (change.scope === "order_updates") {
    data.optedIn = change.status === "opted_in";
    if (change.status === "opted_in") data.optedOut = false;
  } else {
    data.marketing = change.status;
    if (change.status === "opted_in") data.optedOut = false;
  }
  const [updated] = await systemDb.$transaction([
    systemDb.wappContact.update({ where: { id: contact.id }, data }),
    systemDb.wappConsentEvent.create({
      data: {
        workspaceId: contact.workspaceId,
        storeId: contact.storeId,
        contactId: contact.id,
        scope: change.scope,
        status: change.status,
        source: change.source,
        actorUserId: change.actorUserId ?? null,
        note: change.note?.slice(0, 300) ?? null,
        occurredAt: at,
      },
    }),
  ]);
  return updated;
}

/**
 * Shopify's text-message marketing consent on an event, recorded as WhatsApp marketing consent only
 * when the store says its consent wording covers WhatsApp (Settings). Only a change is recorded.
 */
export async function applyShopifyConsent(contact: WappContact, state: string | null | undefined, enabled: boolean, at: Date): Promise<WappContact> {
  if (!enabled || !state) return contact;
  const s = state.toLowerCase();
  const status = s === "subscribed" ? "opted_in" : s === "unsubscribed" || s === "redacted" ? "opted_out" : null;
  if (!status || contact.marketing === status || contact.optedOut) return contact;
  return recordConsent(contact, { scope: "marketing", status, source: "shopify_sms", at });
}

/** The store records (or withdraws) a customer's consent, given some other way. Audited. */
export async function setConsentByMerchant(
  store: { id: string; workspaceId: string },
  input: { phone: string; country?: string | null; scope: "all" | "order_updates" | "marketing"; status: "opted_in" | "opted_out"; note?: string | null; userId: string; ip?: string },
): Promise<WappContact> {
  const phone = normalizePhone(input.phone, input.country ?? null);
  if (!phone) throw new WhatsappError("That isn't a valid international phone number. Include the country code, for example +61 412 345 678.", 400, "invalid_phone");
  const contact = await upsertContact(store, phone);
  if (contact.optedOut && input.status === "opted_in" && input.scope !== "all") {
    throw new WhatsappError("This customer replied STOP. Only they can opt back in (by replying START), or you can record that they asked to receive messages again.", 409, "opted_out");
  }
  const updated = await recordConsent(contact, { scope: input.scope, status: input.status, source: "merchant", actorUserId: input.userId, note: input.note ?? null });
  await audit({ workspaceId: store.workspaceId, actorUserId: input.userId, action: "whatsapp.consent_recorded", targetType: "whatsapp_contact", targetId: contact.id, metadata: { scope: input.scope, status: input.status }, ip: input.ip });
  return updated;
}

/** STOP from a customer: nothing more is sent, and the number goes on the do-not-message list. */
export async function optOutByReply(contact: WappContact, at: Date): Promise<WappContact> {
  await systemDb.wappSuppression.upsert({
    where: { storeId_phoneHash_scope: { storeId: contact.storeId, phoneHash: contact.phoneHash, scope: "all" } },
    create: { workspaceId: contact.workspaceId, storeId: contact.storeId, phoneHash: contact.phoneHash, phoneMasked: contact.phoneMasked, scope: "all", reason: "stop_reply" },
    update: {},
  });
  logger.info({ storeId: contact.storeId, contactId: contact.id }, "whatsapp opt-out (STOP)");
  return recordConsent(contact, { scope: "all", status: "opted_out", source: "whatsapp_stop", at });
}

/** START from a customer: they asked to receive messages again (the STOP entry on the list goes). */
export async function optInByReply(contact: WappContact, at: Date): Promise<WappContact> {
  await systemDb.wappSuppression.deleteMany({ where: { storeId: contact.storeId, phoneHash: contact.phoneHash, scope: "all", reason: "stop_reply" } });
  return recordConsent(contact, { scope: "all", status: "opted_in", source: "whatsapp_start", at });
}

/** Adds a number to the store's do-not-message list (the merchant). */
export async function addWaSuppression(
  store: { id: string; workspaceId: string },
  input: { phone: string; country?: string | null; scope: WaSuppressionScope; note?: string | null; userId: string; ip?: string },
) {
  const phone = normalizePhone(input.phone, input.country ?? null);
  if (!phone) throw new WhatsappError("That isn't a valid international phone number. Include the country code.", 400, "invalid_phone");
  const phoneHash = waPhoneHash(store.id, phone.waId);
  const row = await systemDb.wappSuppression.upsert({
    where: { storeId_phoneHash_scope: { storeId: store.id, phoneHash, scope: input.scope } },
    create: { workspaceId: store.workspaceId, storeId: store.id, phoneHash, phoneMasked: maskPhone(phone.e164), scope: input.scope, reason: "merchant", note: input.note?.slice(0, 300) ?? null, createdBy: input.userId },
    update: { note: input.note?.slice(0, 300) ?? null },
  });
  // Messages already waiting for it go too.
  await systemDb.wappMessage.updateMany({
    where: { storeId: store.id, phoneHash, direction: "out", status: "queued", ...(input.scope === "marketing" ? { category: "marketing" } : {}) },
    data: { status: "cancelled", reason: "suppressed", finalAt: new Date(), payloadEnc: null },
  });
  await audit({ workspaceId: store.workspaceId, actorUserId: input.userId, action: "whatsapp.suppression_added", targetType: "whatsapp_suppression", targetId: row.id, metadata: { scope: input.scope }, ip: input.ip });
  return row;
}

export async function removeWaSuppression(store: { id: string; workspaceId: string }, id: string, actor: { userId: string; ip?: string }) {
  const row = await systemDb.wappSuppression.findFirst({ where: { id, storeId: store.id } });
  if (!row) throw new WhatsappError("Not found", 404, "not_found");
  if (row.reason === "stop_reply") throw new WhatsappError("This customer replied STOP. Only their reply START takes them off the list.", 409, "stop_reply");
  await systemDb.wappSuppression.delete({ where: { id: row.id } });
  await audit({ workspaceId: store.workspaceId, actorUserId: actor.userId, action: "whatsapp.suppression_removed", targetType: "whatsapp_suppression", targetId: row.id, metadata: { scope: row.scope }, ip: actor.ip });
}

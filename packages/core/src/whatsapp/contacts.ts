/**
 * Customers' WhatsApp numbers and what they agreed to. A contact is made only when there is a
 * reason to keep the number: a workflow is about to message them, they wrote to the store, they
 * agreed to marketing (Shopify's consent, START, the store recording it), or the store's team added
 * them. Every consent change is kept in wa_consent_events with where it came from.
 *
 * Consent rules (who may receive what) are `consentProblem` in @app/shared/whatsapp.
 */
import { Prisma, systemDb, type Store, type WaContact } from "@app/db";
import { maskPhone, type ConsentFacts, type ConsentSource, type MarketingStatus, type NormalizedPhone } from "@app/shared";
import { logger } from "../logger.js";
import { waDecrypt, waEncrypt, waPhoneHash } from "./common.js";

export interface ContactDetails {
  firstName?: string | null;
  shopifyCustomerId?: string | null;
  /** Shopify's order count and lifetime spend for the customer, when the event carried them. */
  ordersCount?: number | null;
  totalSpent?: number | null;
  lastOrderAt?: Date | null;
  /** The customer wrote to the store at this time (opens the 24-hour window). */
  inboundAt?: Date | null;
}

const digitsOf = (p: NormalizedPhone) => p.e164.replace(/\D/g, "");

/** Find a store's contact by number, without decrypting anything. */
export async function findContact(storeId: string, phone: NormalizedPhone): Promise<WaContact | null> {
  return systemDb.waContact.findUnique({ where: { storeId_phoneHash: { storeId, phoneHash: waPhoneHash(storeId, digitsOf(phone)) } } });
}

/** The fields an event may move forward: counts only grow, dates only move later. */
function updates(c: WaContact | null, storeId: string, d: ContactDetails): Prisma.WaContactUpdateInput {
  const out: Prisma.WaContactUpdateInput = {};
  if (d.firstName?.trim()) out.firstNameEnc = waEncrypt(storeId, "name", d.firstName.trim().slice(0, 60));
  if (d.shopifyCustomerId && c?.shopifyCustomerId !== d.shopifyCustomerId) out.shopifyCustomerId = d.shopifyCustomerId;
  if (d.ordersCount != null && d.ordersCount > (c?.ordersCount ?? 0)) out.ordersCount = d.ordersCount;
  if (d.totalSpent != null && Number.isFinite(d.totalSpent) && d.totalSpent > Number(c?.totalSpent ?? 0)) out.totalSpent = d.totalSpent.toFixed(2);
  if (d.lastOrderAt && (!c?.lastOrderAt || d.lastOrderAt > c.lastOrderAt)) out.lastOrderAt = d.lastOrderAt;
  if (d.inboundAt && (!c?.lastInboundAt || d.inboundAt > c.lastInboundAt)) out.lastInboundAt = d.inboundAt;
  return out;
}

/** The store's contact for this number, made if new; what the event knows is added. */
export async function upsertContact(store: Pick<Store, "id" | "workspaceId">, phone: NormalizedPhone, d: ContactDetails = {}): Promise<WaContact> {
  const existing = await findContact(store.id, phone);
  if (existing) {
    const data = updates(existing, store.id, d);
    return Object.keys(data).length ? systemDb.waContact.update({ where: { id: existing.id }, data }) : existing;
  }
  try {
    const data = updates(null, store.id, d) as Prisma.WaContactUncheckedCreateInput;
    return await systemDb.waContact.create({
      data: {
        ...data,
        workspaceId: store.workspaceId,
        storeId: store.id,
        phoneHash: waPhoneHash(store.id, digitsOf(phone)),
        phoneEnc: waEncrypt(store.id, "phone", phone.e164),
        phoneMasked: maskPhone(phone.e164),
        country: phone.country,
      },
    });
  } catch (e) {
    // Two events for one new number at once: the other one made it.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const again = await findContact(store.id, phone);
      if (again) return again;
    }
    throw e;
  }
}

/** The contact's number (E.164, "+61412345678"). */
export const contactPhone = (c: Pick<WaContact, "storeId" | "phoneEnc">) => waDecrypt(c.storeId, "phone", c.phoneEnc);

/** The contact's first name, or null (an unreadable one is treated as unknown). */
export function contactFirstName(c: Pick<WaContact, "storeId" | "firstNameEnc" | "id">): string | null {
  if (!c.firstNameEnc) return null;
  try {
    return waDecrypt(c.storeId, "name", c.firstNameEnc);
  } catch (err) {
    logger.warn({ err, contactId: c.id }, "whatsapp contact name unreadable");
    return null;
  }
}

export const consentFacts = (c: Pick<WaContact, "optedOut" | "optedIn" | "marketing">): ConsentFacts => ({ optedOut: c.optedOut, optedIn: c.optedIn, marketing: c.marketing as MarketingStatus });

export interface ConsentChange {
  /** "all": every message (STOP / START); "marketing": offers only. */
  scope: "all" | "marketing";
  status: "opted_in" | "opted_out";
  source: ConsentSource;
  at: Date;
  actorUserId?: string | null;
  note?: string | null;
}

/** Sources the customer acts through themselves: only they can undo their own STOP. */
const CUSTOMER_SOURCES = new Set<ConsentSource>(["whatsapp_start", "whatsapp_stop", "stop_promotions", "meta_preferences", "meta_error"]);

/**
 * Apply a consent change and record it. Returns the contact as it is now, and whether anything
 * changed. Rules:
 *  - a change older than the last one recorded (Meta and Shopify redeliver late) changes nothing;
 *  - a STOP is undone only by the customer (START, or their WhatsApp setting), never by Shopify's
 *    consent or the store's own record;
 *  - "Stop promotions" stops marketing; order updates continue.
 * Waiting messages the change rules out are cancelled.
 */
export async function setConsent(contact: WaContact, change: ConsentChange): Promise<{ contact: WaContact; changed: boolean }> {
  if (contact.consentUpdatedAt && change.at < contact.consentUpdatedAt && CUSTOMER_SOURCES.has(change.source)) return { contact, changed: false };
  const data: Prisma.WaContactUpdateInput = {};
  if (change.scope === "all" && change.status === "opted_out") {
    if (!contact.optedOut) data.optedOut = true;
  } else if (change.scope === "all" && change.status === "opted_in") {
    if (contact.optedOut && !CUSTOMER_SOURCES.has(change.source)) return { contact, changed: false };
    if (contact.optedOut) data.optedOut = false;
    if (!contact.optedIn) data.optedIn = true;
    if (contact.marketing !== "opted_in") data.marketing = "opted_in";
  } else if (change.scope === "marketing" && change.status === "opted_out") {
    if (contact.marketing !== "opted_out") data.marketing = "opted_out";
  } else {
    // Marketing opt-in: not over a STOP (only START undoes that), and not over the customer's own
    // "stop promotions" unless the customer is the one changing it.
    if (contact.optedOut) return { contact, changed: false };
    if (contact.marketing === "opted_out" && !CUSTOMER_SOURCES.has(change.source) && change.source !== "merchant") return { contact, changed: false };
    if (contact.marketing !== "opted_in") data.marketing = "opted_in";
    if (!contact.optedIn) data.optedIn = true;
  }
  if (!Object.keys(data).length) return { contact, changed: false };
  data.consentUpdatedAt = change.at;
  const [updated] = await systemDb.$transaction([
    systemDb.waContact.update({ where: { id: contact.id }, data }),
    systemDb.waConsentEvent.create({
      data: {
        workspaceId: contact.workspaceId,
        storeId: contact.storeId,
        contactId: contact.id,
        scope: change.scope,
        status: change.status,
        source: change.source,
        actorUserId: change.actorUserId ?? null,
        note: change.note?.slice(0, 300) ?? null,
        occurredAt: change.at,
      },
    }),
  ]);
  if (change.status === "opted_out") {
    // What was waiting for them and is now ruled out: everything on a STOP, marketing on "stop promotions".
    const r = await systemDb.waMessage.updateMany({
      where: { contactId: contact.id, status: "queued", ...(change.scope === "marketing" ? { category: "MARKETING" } : {}) },
      data: { status: "skipped", reason: change.scope === "all" ? "opted_out" : "no_marketing_consent", finalAt: new Date(), payloadEnc: null },
    });
    if (r.count) logger.info({ contactId: contact.id, cancelled: r.count, scope: change.scope }, "whatsapp: waiting messages cancelled after an opt-out");
  }
  return { contact: updated, changed: true };
}

/** Shopify's text-message marketing consent on an order, checkout or customer, when the store says it covers WhatsApp. */
export function shopifySmsConsent(state: string | null | undefined, acceptsSms?: boolean | null): "opted_in" | "opted_out" | null {
  const s = String(state ?? "").toLowerCase();
  if (s === "subscribed" || acceptsSms === true) return "opted_in";
  if (s === "unsubscribed") return "opted_out";
  return null;
}

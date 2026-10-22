/**
 * Customers' numbers, their SMS consent and the suppression list.
 *
 * Consent is never inferred: a number on an order, or a past purchase, is not agreement to
 * marketing. A contact's marketing state is what Shopify reports (the customer's SMS marketing
 * consent, or the buyer ticking the SMS box at checkout), and every change is kept in
 * sms_consent_records with its evidence. An opt-out (the link in a text, AWS's opt-out list, the
 * merchant) is a suppression: it wins over anything Shopify says later.
 */
import { Prisma, systemDb, type SmsContact, type Store } from "@app/db";
import { maskPhone, sha256Hex, type NormalizedPhone } from "@app/shared";
import { consentState, type ConsentState, type SuppressionReason } from "@app/shared/sms";
import { customerKey } from "../persist.js";
import { smsDecrypt, smsEncrypt, smsPhoneHash } from "./common.js";

export interface ConsentSignal {
  state: ConsentState;
  optInLevel?: string | null;
  collectedFrom?: string | null;
  /** When Shopify says the consent changed (consent_updated_at); older signals never overwrite newer ones. */
  updatedAt?: Date | null;
  source: "shopify_order" | "shopify_checkout" | "shopify_customer" | "shopify_import" | "opt_out_link" | "aws_opt_out" | "provider" | "merchant" | "customer_redact";
  evidence: Record<string, unknown>;
}

/** Shopify's sms_marketing_consent on a REST payload (orders, checkouts, customers), as a signal; null when it says nothing. */
export function shopifySmsConsent(
  raw: { state?: string | null; opt_in_level?: string | null; consent_updated_at?: string | null; consent_collected_from?: string | null } | null | undefined,
  buyerAccepted: boolean | null | undefined,
  source: ConsentSignal["source"],
  evidence: Record<string, unknown>,
): ConsentSignal | null {
  if (raw?.state) {
    const updated = raw.consent_updated_at ? new Date(raw.consent_updated_at) : null;
    return {
      state: consentState(raw.state),
      optInLevel: raw.opt_in_level ?? null,
      collectedFrom: raw.consent_collected_from ?? null,
      updatedAt: updated && !Number.isNaN(updated.getTime()) ? updated : null,
      source,
      evidence: { ...evidence, consentCollectedFrom: raw.consent_collected_from ?? null, consentUpdatedAt: raw.consent_updated_at ?? null, optInLevel: raw.opt_in_level ?? null },
    };
  }
  // The buyer ticked the checkout's text-message box: explicit agreement, recorded as such.
  if (buyerAccepted === true) return { state: "subscribed", optInLevel: "single_opt_in", collectedFrom: "checkout", updatedAt: null, source, evidence: { ...evidence, buyerAcceptsSmsMarketing: true } };
  return null;
}

export interface ContactInput {
  phone: NormalizedPhone;
  firstName?: string | null;
  shopifyCustomerId?: string | null;
  consent?: ConsentSignal | null;
}

/** Find or create the contact for a number, update what the event says about them, and apply its consent signal. */
export async function upsertSmsContact(store: Pick<Store, "id" | "workspaceId">, input: ContactInput): Promise<SmsContact> {
  const hash = smsPhoneHash(store.id, input.phone.e164);
  const custId = input.shopifyCustomerId ? String(input.shopifyCustomerId) : null;
  const base = {
    ...(input.firstName ? { firstNameEnc: smsEncrypt(store.id, "name", input.firstName.slice(0, 100)) } : {}),
    ...(custId ? { shopifyCustomerId: custId, customerKey: customerKey(store, custId) } : {}),
    ...(input.phone.country ? { country: input.phone.country } : {}),
  };
  let contact: SmsContact;
  try {
    contact = await systemDb.smsContact.upsert({
      where: { storeId_phoneHash: { storeId: store.id, phoneHash: hash } },
      create: {
        workspaceId: store.workspaceId,
        storeId: store.id,
        phoneHash: hash,
        phoneEnc: smsEncrypt(store.id, "phone", input.phone.e164),
        phoneMasked: maskPhone(input.phone.e164),
        ...base,
      },
      update: base,
    });
  } catch (e) {
    // Two events for a new number at once: the other one created it.
    if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
    contact = await systemDb.smsContact.update({ where: { storeId_phoneHash: { storeId: store.id, phoneHash: hash } }, data: base });
  }
  // A number already suppressed (before the contact existed) stays suppressed.
  const suppressions = await systemDb.smsSuppression.findMany({ where: { storeId: store.id, phoneHash: hash }, select: { scope: true } });
  const all = suppressions.some((s) => s.scope === "all");
  const marketing = all || suppressions.some((s) => s.scope === "marketing");
  if (all !== contact.suppressedAll || marketing !== contact.suppressedMarketing) {
    contact = await systemDb.smsContact.update({ where: { id: contact.id }, data: { suppressedAll: all, suppressedMarketing: marketing } });
  }
  if (input.consent) contact = await applyConsent(contact, input.consent);
  return contact;
}

/**
 * Apply a consent signal to a contact. A signal older than the stored one changes nothing (Shopify
 * delivers late and out of order); one that changes the state is recorded with its evidence.
 * An unsubscribe also cancels the contact's waiting marketing texts.
 */
export async function applyConsent(contact: SmsContact, s: ConsentSignal): Promise<SmsContact> {
  if (contact.consentUpdatedAt && s.updatedAt && s.updatedAt < contact.consentUpdatedAt) return contact;
  // An undated signal (the checkout box) doesn't overturn a dated "unsubscribed".
  if (!s.updatedAt && contact.consentUpdatedAt && contact.consentState === "unsubscribed" && s.state === "subscribed") return contact;
  const changed = contact.consentState !== s.state || (s.optInLevel ?? null) !== (contact.consentOptInLevel ?? null);
  if (!changed && !(s.updatedAt && (!contact.consentUpdatedAt || s.updatedAt > contact.consentUpdatedAt))) return contact;
  const now = new Date();
  const updated = await systemDb.smsContact.update({
    where: { id: contact.id },
    data: {
      consentState: s.state,
      consentOptInLevel: s.optInLevel ?? null,
      consentSource: s.source,
      consentCollectedFrom: s.collectedFrom ?? null,
      consentUpdatedAt: s.updatedAt ?? now,
    },
  });
  if (changed) {
    await systemDb.smsConsentRecord.create({
      data: {
        workspaceId: contact.workspaceId,
        storeId: contact.storeId,
        contactId: contact.id,
        purpose: "marketing",
        state: s.state,
        optInLevel: s.optInLevel ?? null,
        source: s.source,
        evidence: s.evidence as Prisma.InputJsonValue,
        effectiveAt: s.updatedAt ?? now,
      },
    });
    if (s.state !== "subscribed") await cancelMarketingFor(contact.id, "no_marketing_consent");
  }
  return updated;
}

/** Cancel a contact's texts that haven't gone yet: marketing only, or everything. */
export async function cancelMarketingFor(contactId: string, reason: string, everything = false): Promise<number> {
  const { count } = await systemDb.smsMessageJob.updateMany({
    where: { contactId, status: "scheduled", ...(everything ? {} : { category: "marketing" }) },
    data: { status: "cancelled", reason, finalAt: new Date(), valuesEnc: null },
  });
  return count;
}

/**
 * Put a number on the store's suppression list (idempotent). `all` stops every text, order
 * updates included; `marketing` only marketing. The contact, if there is one, is marked and its
 * waiting texts cancelled, and the opt-out goes into its consent history.
 */
export async function suppressNumber(
  store: Pick<Store, "id" | "workspaceId">,
  e164: string,
  scope: "all" | "marketing",
  reason: SuppressionReason,
  o: { createdBy?: string | null; note?: string | null; evidence?: Record<string, unknown> } = {},
): Promise<{ created: boolean; contactId: string | null }> {
  return suppressHash(store, smsPhoneHash(store.id, e164), maskPhone(e164), scope, reason, o);
}

/** suppressNumber for a number known only by its hash (a text's opt-out link: its contact may be gone). */
export async function suppressHash(
  store: Pick<Store, "id" | "workspaceId">,
  hash: string,
  masked: string,
  scope: "all" | "marketing",
  reason: SuppressionReason,
  o: { createdBy?: string | null; note?: string | null; evidence?: Record<string, unknown> } = {},
): Promise<{ created: boolean; contactId: string | null }> {
  let created = true;
  try {
    await systemDb.smsSuppression.create({ data: { workspaceId: store.workspaceId, storeId: store.id, phoneHash: hash, phoneMasked: masked, scope, reason, note: o.note ?? null, createdBy: o.createdBy ?? null } });
  } catch (e) {
    if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
    created = false;
  }
  const contact = await systemDb.smsContact.findUnique({ where: { storeId_phoneHash: { storeId: store.id, phoneHash: hash } } });
  if (!contact) return { created, contactId: null };
  await systemDb.smsContact.update({ where: { id: contact.id }, data: scope === "all" ? { suppressedAll: true, suppressedMarketing: true } : { suppressedMarketing: true } });
  await cancelMarketingFor(contact.id, "suppressed", scope === "all");
  if (created) {
    await systemDb.smsConsentRecord.create({
      data: {
        workspaceId: store.workspaceId,
        storeId: store.id,
        contactId: contact.id,
        purpose: scope === "all" ? "all" : "marketing",
        state: "unsubscribed",
        source: reasonSource(reason),
        evidence: { reason, ...(o.evidence ?? {}), ...(o.createdBy ? { by: o.createdBy } : {}) } as Prisma.InputJsonValue,
        effectiveAt: new Date(),
      },
    });
  }
  return { created, contactId: contact.id };
}

const reasonSource = (reason: SuppressionReason): ConsentSignal["source"] =>
  reason === "opt_out_link" ? "opt_out_link" : reason === "aws_opt_out" || reason === "keyword_stop" ? "aws_opt_out" : reason === "customer_redact" ? "customer_redact" : reason === "merchant" ? "merchant" : "provider";

/** Take a number off the list (only suppressions the merchant may lift; the caller checks). Recomputes the contact's flags. */
export async function liftSuppression(store: Pick<Store, "id">, id: string): Promise<boolean> {
  const row = await systemDb.smsSuppression.findFirst({ where: { id, storeId: store.id } });
  if (!row) return false;
  await systemDb.smsSuppression.delete({ where: { id: row.id } });
  const rest = await systemDb.smsSuppression.findMany({ where: { storeId: store.id, phoneHash: row.phoneHash }, select: { scope: true } });
  const all = rest.some((s) => s.scope === "all");
  await systemDb.smsContact.updateMany({ where: { storeId: store.id, phoneHash: row.phoneHash }, data: { suppressedAll: all, suppressedMarketing: all || rest.some((s) => s.scope === "marketing") } });
  return true;
}

/** Recompute a contact's order count, spend and last order from the orders seen for it. */
export async function refreshContactStats(contactId: string): Promise<void> {
  const [agg, last] = await Promise.all([
    systemDb.smsContactOrder.aggregate({ where: { contactId, cancelled: false }, _count: true, _sum: { total: true } }),
    systemDb.smsContactOrder.findFirst({ where: { contactId, cancelled: false }, orderBy: { placedAt: "desc" }, select: { placedAt: true } }),
  ]);
  await systemDb.smsContact.update({ where: { id: contactId }, data: { ordersCount: agg._count, totalSpent: agg._sum.total ?? 0, lastOrderAt: last?.placedAt ?? null } });
}

// ---------------------------------------------------------------------------
// The opt-out link in a marketing text (/stop?c=<code>; only the code's SHA-256 is stored)
// ---------------------------------------------------------------------------

async function jobForCode(code: string) {
  if (!/^[A-Za-z0-9]{6,20}$/.test(code)) return null;
  return systemDb.smsMessageJob.findUnique({ where: { optOutCodeHash: sha256Hex(code) } });
}

/** What the /stop page shows: whose texts, to which number (masked), and whether they stopped already. Null for a code that names nothing. */
export async function describeOptOut(code: string): Promise<{ business: string; number: string; stopped: "none" | "marketing" | "all" } | null> {
  const job = await jobForCode(code);
  if (!job?.phoneHash) return null;
  const [store, suppressions] = await Promise.all([
    systemDb.store.findUnique({ where: { id: job.storeId }, select: { name: true, shopDomain: true } }),
    systemDb.smsSuppression.findMany({ where: { storeId: job.storeId, phoneHash: job.phoneHash }, select: { scope: true } }),
  ]);
  if (!store) return null;
  const stopped = suppressions.some((x) => x.scope === "all") ? "all" : suppressions.length ? "marketing" : "none";
  return { business: store.name ?? store.shopDomain.replace(/\.myshopify\.com$/, ""), number: job.phoneMasked ?? "your number", stopped };
}

/** The customer confirmed on /stop: marketing texts (or every text) from this store stop now. */
export async function applyOptOut(code: string, scope: "marketing" | "all"): Promise<boolean> {
  const job = await jobForCode(code);
  if (!job?.phoneHash) return false;
  await suppressHash({ id: job.storeId, workspaceId: job.workspaceId }, job.phoneHash, job.phoneMasked ?? "", scope, "opt_out_link", { evidence: { jobId: job.id, via: "opt_out_link" } });
  if (job.contactId) {
    const contact = await systemDb.smsContact.findUnique({ where: { id: job.contactId } });
    if (contact && contact.consentState === "subscribed") await applyConsent(contact, { state: "unsubscribed", source: "opt_out_link", updatedAt: new Date(), evidence: { jobId: job.id } });
  }
  return true;
}

export const contactPhone = (c: Pick<SmsContact, "storeId" | "phoneEnc">) => smsDecrypt(c.storeId, "phone", c.phoneEnc);
export const contactFirstName = (c: Pick<SmsContact, "storeId" | "firstNameEnc">) => {
  if (!c.firstNameEnc) return null;
  try {
    return smsDecrypt(c.storeId, "name", c.firstNameEnc);
  } catch {
    return null;
  }
};

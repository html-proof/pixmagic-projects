/**
 * What every store event handler shares (events/*.ts): the store's WhatsApp context, reading the
 * customer off Shopify's payloads, scheduling a notification and running the automations.
 */
import { systemDb, type AbandonedCheckout, type OrderTracking, type Store, type WhatsappConnection, type WhatsappContact } from "@app/db";
import { kindSetting, normalizePhone, type AutomationFacts, type AutomationTrigger, type NotificationKind, type WhatsappConfig } from "@app/shared";
import type { AutomationCheckout, AutomationOrder } from "../../shopifyPayloads.js";
import { runAutomations, type AutomationSubject } from "../automations.js";
import { marketingAllowed, scheduleMessage, type WaDeps } from "../messages.js";
import { contactFirstName, type MarketingSignal } from "../store.js";
import { orderValues, type Values } from "../values.js";

/** Events older than this are put on the timeline but never sent to the customer. */
export const STALE_NOTIFY_MS = 48 * 3600_000;

export interface Ctx {
  store: Store;
  cfg: WhatsappConfig;
  connection: WhatsappConnection | null;
  deps: WaDeps;
}

export const fresh = (at: Date) => Date.now() - at.getTime() <= STALE_NOTIFY_MS;
export const date = (v: unknown, fallback = new Date()) => {
  const d = v ? new Date(String(v)) : fallback;
  return Number.isNaN(d.getTime()) ? fallback : d;
};

// ---------------------------------------------------------------------------
// What Shopify's payloads say about the customer
// ---------------------------------------------------------------------------

/** An order or a checkout: who is buying and how to reach them read the same on both. */
export type Purchase = AutomationOrder | AutomationCheckout;

export function phoneOf(p: Purchase) {
  const country = p.shipping_address?.country_code ?? p.billing_address?.country_code ?? p.customer?.default_address?.country_code ?? null;
  const candidates = [p.phone, p.shipping_address?.phone, p.billing_address?.phone, p.customer?.phone, p.customer?.default_address?.phone, p.sms_marketing_phone];
  for (const c of candidates) {
    const n = normalizePhone(typeof c === "string" ? c : null, country);
    if (n) return n;
  }
  return null;
}

export const firstNameOf = (p: Purchase): string | null => p.shipping_address?.first_name || p.billing_address?.first_name || p.customer?.first_name || null;

export function smsSignal(p: Purchase): MarketingSignal | null {
  const state = String(p.customer?.sms_marketing_consent?.state ?? "").toLowerCase();
  if (state === "subscribed" || p.buyer_accepts_sms_marketing === true) return { status: "opted_in", source: "shopify_sms" };
  if (state === "unsubscribed") return { status: "opted_out", source: "shopify_sms" };
  return null;
}

/** The `whatsapp_opt_in` cart attribute (a checkbox the merchant adds to their cart page; docs/whatsapp.md). */
export function cartOptIn(p: Pick<AutomationOrder, "note_attributes">): boolean {
  return (p.note_attributes ?? []).some((a) => /^whatsapp[ _-]?(opt[ _-]?in|updates)$/i.test(String(a.name ?? "")) && /^(yes|true|on|1|y)$/i.test(String(a.value ?? "").trim()));
}

export const tagsOf = (p: AutomationOrder): string[] =>
  (Array.isArray(p.tags) ? p.tags.join(",") : (p.tags ?? ""))
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);

export function itemsOf(p: Purchase) {
  return (p.line_items ?? []).slice(0, 50).map((li) => ({
    productId: li.product_id ? String(li.product_id) : "",
    title: [li.title, li.variant_title].filter((x) => x && String(x).trim() && x !== "Default Title").join(" – ") || "Item",
    quantity: Number(li.quantity ?? 1),
    price: Number(li.price ?? 0),
  }));
}

// ---------------------------------------------------------------------------
// Sending a notification
// ---------------------------------------------------------------------------

interface NotifyOpts {
  tracking?: OrderTracking | null;
  checkout?: AbandonedCheckout | null;
  contact: WhatsappContact | null;
  values: Values;
  dedupeKey: string;
  scheduledFor?: Date;
  clickUrl?: string | null;
}

/** Schedule a notification the merchant has turned on. Without a number it is recorded as skipped, so the merchant sees why. */
export async function notify(ctx: Ctx, kind: NotificationKind, o: NotifyOpts) {
  const s = kindSetting(ctx.cfg, kind);
  if (!s.enabled || !s.templateName || !ctx.connection) return null;
  const { message } = await scheduleMessage(
    {
      store: ctx.store,
      kind,
      dedupeKey: o.dedupeKey,
      contact: o.contact,
      template: { name: s.templateName, language: s.language },
      mapping: s.mapping,
      values: o.values,
      scheduledFor: o.scheduledFor ?? new Date(),
      trackingId: o.tracking?.id ?? null,
      orderName: o.tracking?.orderName ?? null,
      checkoutId: o.checkout?.id ?? null,
      clickUrl: o.clickUrl ?? null,
      skip: o.contact ? null : "no_phone",
    },
    ctx.deps,
  );
  return message;
}

async function previousOrders(contact: WhatsappContact | null, before: Date): Promise<number> {
  if (!contact) return 0;
  return systemDb.orderTracking.count({ where: { contactId: contact.id, orderCreatedAt: { lt: before }, cancelledAt: null } });
}

async function orderFacts(ctx: Ctx, t: OrderTracking, contact: WhatsappContact | null): Promise<AutomationFacts> {
  const items = (t.items as Array<{ productId: string; title: string }>) ?? [];
  const prior = contact ? await previousOrders(contact, t.orderCreatedAt) : null;
  return {
    orderValue: Number(t.totalPrice),
    productIds: items.map((i) => i.productId).filter(Boolean),
    productTitles: items.map((i) => i.title),
    orderStatus: t.status,
    customerSegment: prior === null ? "unknown" : prior > 0 ? "returning" : "new",
    country: t.country ?? contact?.country ?? null,
    marketingConsent: contact ? marketingAllowed(ctx.cfg, contact) : false,
  };
}

export async function automate(ctx: Ctx, trigger: AutomationTrigger, key: string, t: OrderTracking | null, contact: WhatsappContact | null, values: Values, extra: Partial<AutomationSubject> = {}) {
  const subject: AutomationSubject = {
    key,
    store: ctx.store,
    cfg: ctx.cfg,
    contact,
    tracking: t,
    facts: t ? await orderFacts(ctx, t, contact) : { country: contact?.country ?? null, marketingConsent: contact ? marketingAllowed(ctx.cfg, contact) : false },
    values,
    ...extra,
  };
  await runAutomations(trigger, subject, ctx.deps);
}

export async function contactOf(t: OrderTracking) {
  return t.contactId ? systemDb.whatsappContact.findUnique({ where: { id: t.contactId } }) : null;
}

export const valuesFor = (ctx: Ctx, t: OrderTracking, contact: WhatsappContact | null, extra: Values = {}) =>
  orderValues(ctx.store, ctx.cfg, t, contact ? contactFirstName(contact) : null, extra);

/** The order a refund or parcel names, if it is on the timeline. */
export const trackingOf = (store: Pick<Store, "id">, orderId: string | number) =>
  systemDb.orderTracking.findUnique({ where: { storeId_shopifyOrderId: { storeId: store.id, shopifyOrderId: String(orderId) } } });

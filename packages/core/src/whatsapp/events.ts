/**
 * Store events → the order timeline, tracking links and WhatsApp notifications.
 *
 * Fed by Shopify's webhooks (HMAC-verified at intake, apps/api/src/routes/webhooks.ts) and by the
 * shipment poll below. Shopify delivers late, twice and out of order, so:
 *  - every timeline event has a dedupe key, and a notification is only sent the first time its
 *    event is recorded (and has its own dedupe key on top);
 *  - a parcel stage is only announced when it is further along than anything seen for that
 *    fulfillment ("delivered" then a late "shipped" announces nothing);
 *  - an event older than STALE_NOTIFY_MS is recorded but not announced;
 *  - "delivered" is only ever written from Shopify's carrier status or the merchant's own button.
 */
import { Prisma, systemDb, type AbandonedCheckout, type OrderTracking, type Store, type WhatsappContact } from "@app/db";
import {
  kindSetting,
  normalizePhone,
  SHIPMENT_RANK,
  shipmentStage,
  type AutomationFacts,
  type AutomationTrigger,
  type NotificationKind,
  type ShipmentStage,
  type TrackingStatus,
  type WhatsappConfig,
} from "@app/shared";
import { customerKey } from "../persist.js";
import { getAccessToken } from "../tokens.js";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { shopifyGraphql } from "../shopify.js";
import { runAutomations, type AutomationSubject } from "./automations.js";
import { OPEN_CHECKOUT } from "./carts.js";
import { cancelScheduled, marketingAllowed, scheduleMessage, type WaDeps } from "./messages.js";
import { contactFirstName, newLinkToken, phoneHash, storeWhatsapp, upsertContact, waEncrypt, type MarketingSignal } from "./store.js";
import { addressLine, cartValues, money, orderValues, type Values } from "./values.js";
import type { WhatsappConnection } from "@app/db";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Payload = Record<string, any>;

/** Events older than this are put on the timeline but never sent to the customer. */
export const STALE_NOTIFY_MS = 48 * 3600_000;
/** How long an order's tracking and review links keep working. */
export const TRACKING_LINK_DAYS = 120;
/** A recovered cart: the order came within this long of a reminder that was sent. */
export const CART_ATTRIBUTION_MS = 7 * 86_400_000;

interface Ctx {
  store: Store;
  cfg: WhatsappConfig;
  connection: WhatsappConnection | null;
  deps: WaDeps;
}

const fresh = (at: Date) => Date.now() - at.getTime() <= STALE_NOTIFY_MS;
const date = (v: unknown, fallback = new Date()) => {
  const d = v ? new Date(String(v)) : fallback;
  return Number.isNaN(d.getTime()) ? fallback : d;
};

// ---------------------------------------------------------------------------
// What Shopify's payloads say about the customer
// ---------------------------------------------------------------------------

function phoneOf(p: Payload) {
  const country = p.shipping_address?.country_code ?? p.billing_address?.country_code ?? p.customer?.default_address?.country_code ?? null;
  const candidates = [p.phone, p.shipping_address?.phone, p.billing_address?.phone, p.customer?.phone, p.customer?.default_address?.phone, p.sms_marketing_phone];
  for (const c of candidates) {
    const n = normalizePhone(typeof c === "string" ? c : null, country);
    if (n) return n;
  }
  return null;
}

const firstNameOf = (p: Payload): string | null => p.shipping_address?.first_name || p.billing_address?.first_name || p.customer?.first_name || null;

function smsSignal(p: Payload): MarketingSignal | null {
  const state = String(p.customer?.sms_marketing_consent?.state ?? "").toLowerCase();
  if (state === "subscribed" || p.buyer_accepts_sms_marketing === true) return { status: "opted_in", source: "shopify_sms" };
  if (state === "unsubscribed") return { status: "opted_out", source: "shopify_sms" };
  return null;
}

/** The `whatsapp_opt_in` cart attribute (a checkbox the merchant adds to their cart page; docs/whatsapp.md). */
export function cartOptIn(p: Payload): boolean {
  const attrs: Array<{ name?: unknown; value?: unknown }> = Array.isArray(p.note_attributes) ? p.note_attributes : [];
  return attrs.some((a) => /^whatsapp[ _-]?(opt[ _-]?in|updates)$/i.test(String(a?.name ?? "")) && /^(yes|true|on|1|y)$/i.test(String(a?.value ?? "").trim()));
}

const tagsOf = (p: Payload): string[] =>
  String(p.tags ?? "")
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);

function itemsOf(p: Payload) {
  return (Array.isArray(p.line_items) ? p.line_items : []).slice(0, 50).map((li: Payload) => ({
    productId: li.product_id ? String(li.product_id) : "",
    title: [li.title, li.variant_title].filter((x) => x && String(x).trim() && x !== "Default Title").join(" – ") || "Item",
    quantity: Number(li.quantity ?? 1),
    price: Number(li.price ?? 0),
  }));
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

interface EventInput {
  type: string;
  occurredAt: Date;
  source: "shopify" | "carrier" | "merchant";
  dedupeKey: string;
  fulfillmentId?: string | null;
  courier?: string | null;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
  estimatedDeliveryAt?: Date | null;
}

/** Record a timeline event once. Returns false when it had been recorded already. */
async function addEvent(t: OrderTracking, e: EventInput): Promise<boolean> {
  try {
    await systemDb.orderTrackingEvent.create({
      data: {
        workspaceId: t.workspaceId,
        storeId: t.storeId,
        trackingId: t.id,
        type: e.type,
        occurredAt: e.occurredAt,
        source: e.source,
        dedupeKey: e.dedupeKey,
        fulfillmentId: e.fulfillmentId ?? null,
        courier: e.courier ?? null,
        trackingNumber: e.trackingNumber ?? null,
        trackingUrl: e.trackingUrl ?? null,
        estimatedDeliveryAt: e.estimatedDeliveryAt ?? null,
      },
    });
    return true;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return false;
    throw err;
  }
}

/** The order's status as the tracking page shows it, from its timeline. */
export async function refreshTrackingStatus(trackingId: string): Promise<TrackingStatus> {
  const t = await systemDb.orderTracking.findUniqueOrThrow({ where: { id: trackingId } });
  const events = await systemDb.orderTrackingEvent.findMany({ where: { trackingId }, orderBy: { occurredAt: "asc" } });
  const has = (type: string) => events.some((e) => e.type === type);
  let status: TrackingStatus = "placed";
  if (t.cancelledAt) status = "cancelled";
  else if (t.deliveredAt) status = "delivered";
  else if (t.shipmentRank > 0) {
    const lastStage = [...events].reverse().find((e) => e.type in SHIPMENT_RANK || e.type === "delivery_failed");
    status =
      lastStage?.type === "delivery_failed" ? "delivery_failed"
      : t.shipmentRank >= SHIPMENT_RANK.out_for_delivery ? "out_for_delivery"
      : t.shipmentRank >= SHIPMENT_RANK.in_transit ? "in_transit"
      : "shipped";
  } else if (t.financialStatus === "refunded") status = "refunded";
  else if (has("packed")) status = "packed";
  else if (has("processing")) status = "processing";
  else if (t.paidAt) status = "paid";
  if (status !== t.status) await systemDb.orderTracking.update({ where: { id: trackingId }, data: { status } });
  return status;
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
async function notify(ctx: Ctx, kind: NotificationKind, o: NotifyOpts) {
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

async function automate(ctx: Ctx, trigger: AutomationTrigger, key: string, t: OrderTracking | null, contact: WhatsappContact | null, values: Values, extra: Partial<AutomationSubject> = {}) {
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

async function contactOf(t: OrderTracking) {
  return t.contactId ? systemDb.whatsappContact.findUnique({ where: { id: t.contactId } }) : null;
}

const valuesFor = (ctx: Ctx, t: OrderTracking, contact: WhatsappContact | null, extra: Values = {}) =>
  orderValues(ctx.store, ctx.cfg, t, contact ? contactFirstName(contact) : null, extra);

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

async function upsertTracking(ctx: Ctx, p: Payload, contact: WhatsappContact | null): Promise<{ tracking: OrderTracking; isNew: boolean }> {
  const shopifyOrderId = String(p.id);
  const where = { storeId_shopifyOrderId: { storeId: ctx.store.id, shopifyOrderId } };
  const country = p.shipping_address?.country_code ?? p.billing_address?.country_code ?? contact?.country ?? null;
  const common = {
    orderName: String(p.name ?? `#${p.order_number ?? shopifyOrderId}`),
    currency: String(p.currency ?? ctx.store.currency),
    totalPrice: new Prisma.Decimal(String(p.total_price ?? "0")),
    items: itemsOf(p) as unknown as Prisma.InputJsonValue,
    financialStatus: p.financial_status ? String(p.financial_status) : null,
    checkoutToken: p.checkout_token ? String(p.checkout_token) : null,
    country: country ? String(country).toUpperCase() : null,
  };
  const existing = await systemDb.orderTracking.findUnique({ where });
  if (existing) {
    // A delivery Shopify generated before the payment (retried, or simply late) still says
    // "pending": once paid, the status only moves on to refunds or voids, never back.
    const stale = !!existing.paidAt && (!common.financialStatus || ["pending", "authorized", "partially_paid"].includes(common.financialStatus));
    const tracking = await systemDb.orderTracking.update({
      where: { id: existing.id },
      data: {
        ...common,
        financialStatus: stale ? existing.financialStatus : common.financialStatus,
        contactId: existing.contactId ?? contact?.id ?? null,
        // Consent the order showed once stays shown (a later edit doesn't take it back).
        cartOptIn: existing.cartOptIn || cartOptIn(p),
        smsConsent: existing.smsConsent || smsSignal(p)?.status === "opted_in",
      },
    });
    return { tracking, isNew: false };
  }
  const track = newLinkToken();
  const review = newLinkToken();
  const created = date(p.created_at);
  try {
    const tracking = await systemDb.orderTracking.create({
      data: {
        ...common,
        workspaceId: ctx.store.workspaceId,
        storeId: ctx.store.id,
        shopifyOrderId,
        contactId: contact?.id ?? null,
        tokenHash: track.hash,
        tokenEnc: waEncrypt(ctx.store.id, "track", track.token),
        reviewTokenHash: review.hash,
        reviewTokenEnc: waEncrypt(ctx.store.id, "review", review.token),
        cartOptIn: cartOptIn(p),
        smsConsent: smsSignal(p)?.status === "opted_in",
        orderCreatedAt: created,
        expiresAt: new Date(created.getTime() + TRACKING_LINK_DAYS * 86_400_000),
      },
    });
    return { tracking, isNew: true };
  } catch (err) {
    // The same order's other webhook created it a moment ago.
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
    return { tracking: await systemDb.orderTracking.findUniqueOrThrow({ where }), isNew: false };
  }
}

async function onOrder(ctx: Ctx, p: Payload) {
  if (!p?.id) return;
  const phone = phoneOf(p);
  const ck = p.customer?.id ? customerKey(ctx.store, String(p.customer.id)) : null;
  const contact = phone ? await upsertContact(ctx.store, phone, { firstName: firstNameOf(p), customerKey: ck, marketing: smsSignal(p) }) : null;
  let { tracking, isNew } = await upsertTracking(ctx, p, contact);
  const createdAt = tracking.orderCreatedAt;
  const id = tracking.shopifyOrderId;
  const values = valuesFor(ctx, tracking, contact, { delivery_address: addressLine(p.shipping_address) });

  if (isNew) {
    await addEvent(tracking, { type: "placed", occurredAt: createdAt, source: "shopify", dedupeKey: "placed" });
    // Not for an order that arrives already cancelled (a failed payment), nor one we first hear of days later.
    if (!p.cancelled_at && fresh(createdAt)) {
      await notify(ctx, "order_confirmation", { tracking, contact, values, dedupeKey: `order:${id}:order_confirmation` });
    }
    if (p.checkout_token) await completeCheckout(ctx, String(p.checkout_token), tracking, contact);
    await attributeOrder(ctx, contact, tracking);
    await automate(ctx, "order_created", `order:${id}`, tracking, contact, values);
  }

  if (p.financial_status === "paid" && !tracking.paidAt) {
    const at = date(p.updated_at ?? p.processed_at);
    tracking = await systemDb.orderTracking.update({ where: { id: tracking.id }, data: { paidAt: at } });
    await addEvent(tracking, { type: "paid", occurredAt: at, source: "shopify", dedupeKey: "paid" });
    // Paid at checkout: the confirmation already says so. Paid later (cash on delivery, bank transfer): say it now.
    if (!isNew && !tracking.cancelledAt && fresh(at)) await notify(ctx, "payment_confirmed", { tracking, contact, values, dedupeKey: `order:${id}:payment_confirmed` });
    await automate(ctx, "payment_confirmed", `order:${id}`, tracking, contact, values);
  }

  if (p.cancelled_at && !tracking.cancelledAt) {
    const at = date(p.cancelled_at);
    tracking = await systemDb.orderTracking.update({ where: { id: tracking.id }, data: { cancelledAt: at } });
    await addEvent(tracking, { type: "cancelled", occurredAt: at, source: "shopify", dedupeKey: "cancelled" });
    await cancelScheduled({ trackingId: tracking.id, exceptKinds: ["order_cancelled", "refund_processed"] }, "order_cancelled");
    if (!isNew && fresh(at)) await notify(ctx, "order_cancelled", { tracking, contact, values, dedupeKey: `order:${id}:order_cancelled` });
  }

  // "Processing" and "Packed" come from tags the merchant adds in Shopify.
  const tags = tagsOf(p);
  const before = new Set(tracking.tags);
  if (tags.join(",") !== tracking.tags.join(",")) tracking = await systemDb.orderTracking.update({ where: { id: tracking.id }, data: { tags } });
  for (const [kind, tag] of [
    ["order_processing", ctx.cfg.processingTag],
    ["order_packed", ctx.cfg.packedTag],
  ] as const) {
    if (tags.includes(tag.toLowerCase()) && !before.has(tag.toLowerCase())) {
      await markStep(ctx, tracking, contact, kind === "order_processing" ? "processing" : "packed", date(p.updated_at), "shopify", values);
    }
  }

  // Every parcel's "shipped" first, then what couriers say: judged one parcel at a time, a
  // delivered first parcel would make a two-parcel order look delivered before the second was seen.
  const parcels: Payload[] = Array.isArray(p.fulfillments) ? p.fulfillments : [];
  for (const f of parcels) await applyFulfillment(ctx, tracking, contact, f, "shipped");
  for (const f of parcels) await applyFulfillment(ctx, tracking, contact, f, "carrier");
  await refreshTrackingStatus(tracking.id);
}

/** Processing / packed: from a Shopify tag, or the merchant's button. */
async function markStep(ctx: Ctx, t: OrderTracking, contact: WhatsappContact | null, step: "processing" | "packed", at: Date, source: "shopify" | "merchant", values?: Values) {
  if (!(await addEvent(t, { type: step, occurredAt: at, source, dedupeKey: step }))) return false;
  const kind = step === "processing" ? "order_processing" : "order_packed";
  // Only while it still makes sense: not once the parcel is on its way, nor for a cancelled order.
  if (t.shipmentRank === 0 && !t.cancelledAt && fresh(at)) {
    await notify(ctx, kind, { tracking: t, contact, values: values ?? valuesFor(ctx, t, contact), dedupeKey: `order:${t.shopifyOrderId}:${kind}` });
  }
  return true;
}

// ---------------------------------------------------------------------------
// Fulfillments and parcel stages
// ---------------------------------------------------------------------------

interface StageInput {
  fulfillmentId: string;
  stage: ShipmentStage | "failed";
  at: Date;
  source: "shopify" | "carrier" | "merchant";
  courier?: string | null;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
  estimatedDeliveryAt?: Date | null;
}

/** A Shopify fulfillment: its "shipped", then (unless only that phase is asked for) what its courier last said. */
async function applyFulfillment(ctx: Ctx, t: OrderTracking, contact: WhatsappContact | null, f: Payload, phase: "shipped" | "carrier" | "both" = "both") {
  if (!f?.id) return;
  // Pending (with a fulfillment service) or cancelled: nothing has shipped.
  const status = String(f.status ?? "success").toLowerCase();
  if (status !== "success") return;
  const common = {
    fulfillmentId: String(f.id),
    courier: f.tracking_company ? String(f.tracking_company) : null,
    trackingNumber: f.tracking_number ? String(f.tracking_number) : Array.isArray(f.tracking_numbers) && f.tracking_numbers[0] ? String(f.tracking_numbers[0]) : null,
    trackingUrl: f.tracking_url ? String(f.tracking_url) : Array.isArray(f.tracking_urls) && f.tracking_urls[0] ? String(f.tracking_urls[0]) : null,
  };
  if (phase !== "carrier") await applyStage(ctx, t, contact, { ...common, stage: "shipped", at: date(f.created_at), source: "shopify" });
  const stage = shipmentStage(f.shipment_status);
  if (phase !== "shipped" && stage && stage !== "shipped") await applyStage(ctx, t, contact, { ...common, stage, at: date(f.updated_at), source: "carrier" });
}

/**
 * How far the whole order has got: the least advanced of its parcels (an order with one parcel
 * delivered and one in transit is in transit). The merchant's own "Delivered" covers every parcel.
 */
async function orderRank(trackingId: string): Promise<number> {
  const events = await systemDb.orderTrackingEvent.findMany({ where: { trackingId, fulfillmentId: { not: null } }, select: { type: true, fulfillmentId: true } });
  if (events.some((e) => e.fulfillmentId === "merchant" && e.type === "delivered")) return SHIPMENT_RANK.delivered;
  const byParcel = new Map<string, number>();
  for (const e of events) {
    const r = e.type === "delivery_failed" ? SHIPMENT_RANK.shipped : (SHIPMENT_RANK[e.type as ShipmentStage] ?? 0);
    byParcel.set(e.fulfillmentId!, Math.max(byParcel.get(e.fulfillmentId!) ?? 0, r));
  }
  return byParcel.size ? Math.min(...byParcel.values()) : 0;
}

async function applyStage(ctx: Ctx, stale: OrderTracking, contact: WhatsappContact | null, s: StageInput) {
  // Re-read: an earlier parcel in the same webhook may have moved the order on.
  const t = await systemDb.orderTracking.findUniqueOrThrow({ where: { id: stale.id } });
  const prior = await systemDb.orderTrackingEvent.findMany({ where: { trackingId: t.id, fulfillmentId: s.fulfillmentId }, select: { type: true, courier: true, trackingNumber: true, trackingUrl: true } });
  const priorRank = Math.max(0, ...prior.map((e) => SHIPMENT_RANK[e.type as ShipmentStage] ?? 0));
  // Courier details carry over from the fulfillment's earlier events (a carrier event has none of its own).
  const known = prior.find((e) => e.courier || e.trackingNumber || e.trackingUrl);
  const courier = s.courier ?? known?.courier ?? null;
  const trackingNumber = s.trackingNumber ?? known?.trackingNumber ?? null;
  const carrierUrl = s.trackingUrl ?? known?.trackingUrl ?? null;
  const dedupeKey = s.stage === "failed" ? `ful:${s.fulfillmentId}:failed:${s.at.toISOString().slice(0, 10)}` : `ful:${s.fulfillmentId}:${s.stage}`;
  const recorded = await addEvent(t, {
    type: s.stage === "failed" ? "delivery_failed" : s.stage,
    occurredAt: s.at,
    source: s.source,
    dedupeKey,
    fulfillmentId: s.fulfillmentId,
    courier,
    trackingNumber,
    trackingUrl: carrierUrl,
    estimatedDeliveryAt: s.estimatedDeliveryAt ?? null,
  });
  if (!recorded) return;

  const rank = s.stage === "failed" ? 0 : SHIPMENT_RANK[s.stage];
  const whole = await orderRank(t.id);
  // Delivered means every parcel: only now, and only once, is the order (and the customer) told so.
  const nowDelivered = whole >= SHIPMENT_RANK.delivered && !t.deliveredAt;
  const tracking = await systemDb.orderTracking.update({
    where: { id: t.id },
    data: {
      shipmentRank: whole,
      ...(s.source === "carrier" ? { carrierEvents: true } : {}),
      ...(nowDelivered ? { deliveredAt: s.at } : {}),
    },
  });
  await refreshTrackingStatus(tracking.id);
  if (tracking.cancelledAt || !fresh(s.at)) return;

  const id = tracking.shopifyOrderId;
  const values = valuesFor(ctx, tracking, contact, {
    courier_name: courier ?? "our courier",
    tracking_number: trackingNumber ?? "not provided",
    carrier_tracking_url: carrierUrl,
    estimated_delivery: s.estimatedDeliveryAt ? s.estimatedDeliveryAt.toISOString().slice(0, 10) : null,
  });
  const key = `order:${id}:${s.fulfillmentId}:${s.stage}`;
  if (s.stage === "failed") {
    if (priorRank < SHIPMENT_RANK.delivered) {
      await notify(ctx, "delivery_failed", { tracking, contact, values, dedupeKey: `order:${id}:delivery_failed:${s.fulfillmentId}:${s.at.toISOString().slice(0, 10)}` });
    }
    await automate(ctx, "tracking_updated", key, tracking, contact, values);
    return;
  }
  // Late or out of order: on the timeline, never announced.
  if (rank <= priorRank) return;
  if (s.stage === "shipped") {
    await notify(ctx, "order_shipped", { tracking, contact, values, dedupeKey: `order:${id}:order_shipped:${s.fulfillmentId}` });
    await automate(ctx, "fulfillment_created", `order:${id}:${s.fulfillmentId}`, tracking, contact, values);
  } else if (s.stage === "out_for_delivery") {
    await notify(ctx, "out_for_delivery", { tracking, contact, values, dedupeKey: `order:${id}:out_for_delivery:${s.fulfillmentId}` });
  } else if (s.stage === "delivered" && nowDelivered) {
    await notify(ctx, "order_delivered", { tracking, contact, values, dedupeKey: `order:${id}:order_delivered` });
    const due = new Date(s.at.getTime() + ctx.cfg.reviewDelayDays * 86_400_000);
    await notify(ctx, "review_request", { tracking, contact, values, dedupeKey: `order:${id}:review_request`, scheduledFor: due });
    await notify(ctx, "review_reminder", {
      tracking,
      contact,
      values,
      dedupeKey: `order:${id}:review_reminder`,
      scheduledFor: new Date(due.getTime() + ctx.cfg.reviewReminderDays * 86_400_000),
    });
    await automate(ctx, "order_delivered", `order:${id}`, tracking, contact, values);
    await automate(ctx, "review_request_due", `order:${id}`, tracking, contact, values, {
      delayMinutes: Math.max(0, Math.round((due.getTime() - Date.now()) / 60_000)),
    });
  }
  if (s.stage !== "shipped") await automate(ctx, "tracking_updated", key, tracking, contact, values);
}

/** The merchant's own buttons on the order timeline. "Delivered" from them is trusted: they're the store. */
export async function merchantOrderStep(store: Store, trackingId: string, step: "processing" | "packed" | "delivered", deps: WaDeps): Promise<boolean> {
  const wa = await storeWhatsapp(store.id);
  if (!wa) return false;
  const ctx: Ctx = { store, cfg: wa.config, connection: wa.connection, deps };
  const t = await systemDb.orderTracking.findFirstOrThrow({ where: { id: trackingId, storeId: store.id } });
  const contact = await contactOf(t);
  if (step === "delivered") {
    if (t.deliveredAt) return false;
    await applyStage(ctx, t, contact, { fulfillmentId: "merchant", stage: "delivered", at: new Date(), source: "merchant" });
    return true;
  }
  const done = await markStep(ctx, t, contact, step, new Date(), "merchant");
  await refreshTrackingStatus(t.id);
  return done;
}

// ---------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------

async function onRefund(ctx: Ctx, p: Payload) {
  const t = await systemDb.orderTracking.findUnique({ where: { storeId_shopifyOrderId: { storeId: ctx.store.id, shopifyOrderId: String(p.order_id) } } });
  if (!t || !p.id) return;
  const amount = (Array.isArray(p.transactions) ? p.transactions : [])
    .filter((tx: Payload) => tx?.kind === "refund" && (tx?.status ?? "success") === "success")
    .reduce((sum: number, tx: Payload) => sum + Number(tx.amount ?? 0), 0);
  const at = date(p.created_at);
  if (!(await addEvent(t, { type: "refunded", occurredAt: at, source: "shopify", dedupeKey: `refund:${p.id}` }))) return;
  const contact = await contactOf(t);
  const values = valuesFor(ctx, t, contact, { refund_amount: money(amount, t.currency) });
  if (amount > 0 && fresh(at)) await notify(ctx, "refund_processed", { tracking: t, contact, values, dedupeKey: `order:${t.shopifyOrderId}:refund_processed:${p.id}` });
  await automate(ctx, "refund_created", `refund:${p.id}`, t, contact, values);
}

// ---------------------------------------------------------------------------
// Checkouts (abandoned cart recovery)
// ---------------------------------------------------------------------------

async function onCheckout(ctx: Ctx, p: Payload) {
  const token = p.token ? String(p.token) : null;
  if (!token) return;
  const existing = await systemDb.abandonedCheckout.findUnique({ where: { storeId_checkoutToken: { storeId: ctx.store.id, checkoutToken: token } } });
  if (p.completed_at) {
    if (existing && OPEN_CHECKOUT.includes(existing.status)) {
      await systemDb.abandonedCheckout.update({ where: { id: existing.id }, data: { status: "completed", completedAt: date(p.completed_at) } });
      await cancelScheduled({ checkoutId: existing.id }, "checkout_completed");
    }
    return;
  }
  const phone = phoneOf(p);
  // Anonymous checkouts are never stored or messaged: only someone who typed a number at checkout can be reminded.
  if (!phone) return;
  const updatedAt = date(p.updated_at ?? p.created_at);
  if (existing && (!OPEN_CHECKOUT.includes(existing.status) || existing.lastActivityAt > updatedAt)) return;

  const ck = p.customer?.id ? customerKey(ctx.store, String(p.customer.id)) : null;
  const firstName = firstNameOf(p);
  const contact = await upsertContact(ctx.store, phone, { firstName, customerKey: ck, marketing: smsSignal(p) });
  const consent = marketingAllowed(ctx.cfg, contact);
  const items = itemsOf(p).map(({ title, quantity, price }: { title: string; quantity: number; price: number }) => ({ title, quantity, price }));
  const data = {
    contactId: contact.id,
    customerNameEnc: firstName ? waEncrypt(ctx.store.id, "name", firstName) : null,
    phoneMasked: contact.phoneMasked,
    currency: String(p.presentment_currency ?? p.currency ?? ctx.store.currency),
    totalPrice: new Prisma.Decimal(String(p.total_price ?? "0")),
    items: items as unknown as Prisma.InputJsonValue,
    recoveryUrlEnc: p.abandoned_checkout_url ? waEncrypt(ctx.store.id, "recovery", String(p.abandoned_checkout_url)) : null,
    marketingConsent: consent,
    lastActivityAt: updatedAt,
  };
  let checkout: AbandonedCheckout;
  try {
    checkout = existing
      ? await systemDb.abandonedCheckout.update({ where: { id: existing.id }, data })
      : await systemDb.abandonedCheckout.create({
          data: { ...data, workspaceId: ctx.store.workspaceId, storeId: ctx.store.id, checkoutToken: token, checkoutCreatedAt: date(p.created_at) },
        });
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
    return; // checkouts/create and /update raced: the other one stored it.
  }
  if (!ctx.connection) return;

  const values = cartValues(ctx.store, ctx.cfg, firstName?.split(/\s+/)[0] ?? null, data.totalPrice, data.currency);
  const recoveryUrl = p.abandoned_checkout_url ? String(p.abandoned_checkout_url) : null;
  let ineligible: string | null = null;
  for (const n of [1, 2] as const) {
    const kind: NotificationKind = n === 1 ? "abandoned_cart_1" : "abandoned_cart_2";
    const s = kindSetting(ctx.cfg, kind);
    if (!s.enabled || !s.templateName) continue;
    const template = await systemDb.whatsappTemplate.findUnique({
      where: { connectionId_name_language: { connectionId: ctx.connection.id, name: s.templateName, language: s.language } },
      select: { category: true },
    });
    // Cart reminders are marketing on WhatsApp: no consent, no reminder (and the dashboard says why).
    if ((template?.category ?? "MARKETING").toUpperCase() === "MARKETING" && !consent) {
      ineligible = "no_marketing_consent";
      continue;
    }
    if (!recoveryUrl) {
      ineligible = "no_checkout_link";
      continue;
    }
    const delay = n === 1 ? ctx.cfg.cartFirstDelayMinutes : ctx.cfg.cartFirstDelayMinutes + ctx.cfg.cartSecondDelayMinutes;
    const due = new Date(updatedAt.getTime() + delay * 60_000);
    // A checkout we hear about long after it was left: a reminder now would arrive days late.
    if (due.getTime() < Date.now() - 6 * 3600_000) continue;
    const { message, created } = await scheduleMessage(
      { store: ctx.store, kind, dedupeKey: `cart:${token}:${n}`, contact, template: { name: s.templateName, language: s.language }, mapping: s.mapping, values, scheduledFor: due, checkoutId: checkout.id, clickUrl: recoveryUrl },
      ctx.deps,
    );
    // Still shopping: the reminder moves back with every update.
    if (!created && message.status === "scheduled" && message.scheduledFor.getTime() !== due.getTime()) {
      await systemDb.whatsappMessage.update({ where: { id: message.id }, data: { scheduledFor: due, enqueuedAt: null } });
    }
  }
  if (ineligible && checkout.status === "open") {
    await systemDb.abandonedCheckout.update({ where: { id: checkout.id }, data: { status: "ineligible", ineligibleReason: ineligible } });
  } else if (!ineligible && checkout.status === "ineligible") {
    await systemDb.abandonedCheckout.update({ where: { id: checkout.id }, data: { status: "open", ineligibleReason: null } });
  }
  if (!existing) {
    await runAutomations(
      "checkout_abandoned",
      {
        key: `checkout:${token}`,
        store: ctx.store,
        cfg: ctx.cfg,
        contact,
        checkout,
        facts: { orderValue: Number(data.totalPrice), productTitles: items.map((i: { title: string }) => i.title), country: contact.country, marketingConsent: consent },
        values: { ...values, checkout_url: recoveryUrl },
        delayMinutes: ctx.cfg.cartFirstDelayMinutes,
      },
      ctx.deps,
    );
  }
}

/** The order for a checkout came in: reminders stop, and if one had been sent, the cart counts as recovered. */
async function completeCheckout(ctx: Ctx, checkoutToken: string, t: OrderTracking, contact: WhatsappContact | null) {
  const c = await systemDb.abandonedCheckout.findUnique({ where: { storeId_checkoutToken: { storeId: ctx.store.id, checkoutToken } } });
  if (!c || c.status === "recovered") return;
  const reminder = await systemDb.whatsappMessage.findFirst({
    where: {
      checkoutId: c.id,
      status: { in: ["sent", "delivered", "read"] },
      sentAt: { lte: t.orderCreatedAt, gte: new Date(t.orderCreatedAt.getTime() - CART_ATTRIBUTION_MS) },
    },
    orderBy: { sentAt: "desc" },
  });
  await systemDb.abandonedCheckout.update({
    where: { id: c.id },
    data: reminder
      ? { status: "recovered", completedAt: t.orderCreatedAt, recoveredOrderId: t.shopifyOrderId, recoveredOrderName: t.orderName, recoveredRevenue: t.totalPrice }
      : { status: "completed", completedAt: t.orderCreatedAt },
  });
  await cancelScheduled({ checkoutId: c.id }, "checkout_completed");
  if (reminder) await automate(ctx, "cart_recovered", `checkout:${checkoutToken}`, t, contact, valuesFor(ctx, t, contact));
}

/**
 * Credit an order to the most recent campaign message its customer received within the store's
 * attribution window ("last touch"). An order is credited at most once (a unique index), and only
 * to a message that was actually sent before it. This says the order followed the message, not
 * that the message caused it; the dashboard says so too.
 */
async function attributeOrder(ctx: Ctx, contact: WhatsappContact | null, t: OrderTracking) {
  if (!contact || t.cancelledAt) return;
  const since = new Date(t.orderCreatedAt.getTime() - ctx.cfg.attributionDays * 86_400_000);
  const msg = await systemDb.whatsappMessage.findFirst({
    where: {
      storeId: ctx.store.id,
      contactId: contact.id,
      campaignId: { not: null },
      test: false,
      attributedOrderId: null,
      status: { in: ["sent", "delivered", "read"] },
      sentAt: { gte: since, lte: t.orderCreatedAt },
    },
    orderBy: { sentAt: "desc" },
  });
  if (!msg) return;
  try {
    await systemDb.whatsappMessage.update({ where: { id: msg.id }, data: { attributedOrderId: t.shopifyOrderId, attributedRevenue: t.totalPrice, attributedAt: new Date() } });
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
  }
}

// ---------------------------------------------------------------------------
// Entry point from the webhook consumer
// ---------------------------------------------------------------------------

const ORDER_TOPICS = new Set(["orders/create", "orders/updated", "orders/paid", "orders/cancelled", "orders/fulfilled", "orders/partially_fulfilled"]);
export const WHATSAPP_TOPICS = new Set([...ORDER_TOPICS, "refunds/create", "checkouts/create", "checkouts/update", "fulfillments/create", "fulfillments/update", "fulfillment_events/create"]);

/** Apply a verified Shopify webhook to WhatsApp. A no-op for stores that haven't turned WhatsApp on. */
export async function whatsappOnShopifyEvent(store: Store, topic: string, payload: unknown, deps: WaDeps): Promise<void> {
  if (!WHATSAPP_TOPICS.has(topic) || store.status === "uninstalled") return;
  const wa = await storeWhatsapp(store.id);
  if (!wa) return;
  const ctx: Ctx = { store, cfg: wa.config, connection: wa.connection, deps };
  const p = (payload ?? {}) as Payload;
  if (ORDER_TOPICS.has(topic)) return onOrder(ctx, p);
  if (topic === "refunds/create") return onRefund(ctx, p);
  if (topic === "checkouts/create" || topic === "checkouts/update") return onCheckout(ctx, p);
  // Fulfillment payloads name their order; only orders already on the timeline are followed.
  const t = await systemDb.orderTracking.findUnique({ where: { storeId_shopifyOrderId: { storeId: store.id, shopifyOrderId: String(p.order_id) } } });
  if (!t) return;
  const contact = await contactOf(t);
  if (topic === "fulfillments/create" || topic === "fulfillments/update") return applyFulfillment(ctx, t, contact, p);
  // fulfillment_events/create: the courier's own progress report.
  const stage = shipmentStage(p.status);
  if (!stage || !p.fulfillment_id) return;
  await applyStage(ctx, t, contact, {
    fulfillmentId: String(p.fulfillment_id),
    stage,
    at: date(p.happened_at ?? p.created_at),
    source: stage === "shipped" ? "shopify" : "carrier",
    estimatedDeliveryAt: p.estimated_delivery_at ? date(p.estimated_delivery_at) : null,
  });
}

// ---------------------------------------------------------------------------
// Shipment poll: Shopify's carrier status for parcels on their way, for stores whose webhooks
// don't carry tracking updates (that needs the read_fulfillments scope). read_orders is enough here.
// ---------------------------------------------------------------------------

const SHIPMENTS_QUERY = `#graphql
  query Shipments($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Order {
        id
        fulfillments(first: 10) {
          id
          status
          displayStatus
          createdAt
          updatedAt
          inTransitAt
          deliveredAt
          estimatedDeliveryAt
          trackingInfo(first: 1) { company number url }
        }
      }
    }
  }`;

const gidId = (gid: string) => gid.split("/").pop() ?? gid;

/** Ask Shopify where the store's parcels in transit are. Returns how many orders were checked. */
export async function pollShipments(store: Store, deps: WaDeps): Promise<number> {
  const wa = await storeWhatsapp(store.id);
  if (!wa || !store.accessTokenEnc) return 0;
  const ctx: Ctx = { store, cfg: wa.config, connection: wa.connection, deps };
  const open = await systemDb.orderTracking.findMany({
    where: { storeId: store.id, cancelledAt: null, deliveredAt: null, shipmentRank: { gte: 1, lt: SHIPMENT_RANK.delivered }, orderCreatedAt: { gte: new Date(Date.now() - 45 * 86_400_000) } },
    orderBy: { orderCreatedAt: "desc" },
    take: 50,
  });
  if (!open.length) return 0;
  const token = await getAccessToken(store, deps.coord, deps.fetchImpl);
  const data = await shopifyGraphql<{ nodes: Array<{ id: string; fulfillments: Payload[] } | null> }>({
    shop: store.shopDomain,
    accessToken: token,
    apiVersion: env().SHOPIFY_API_VERSION,
    query: SHIPMENTS_QUERY,
    variables: { ids: open.map((t) => `gid://shopify/Order/${t.shopifyOrderId}`) },
    fetchImpl: deps.fetchImpl,
    maxRetries: 1,
  });
  for (const node of data.nodes ?? []) {
    if (!node) continue;
    const t = open.find((o) => o.shopifyOrderId === gidId(node.id));
    if (!t) continue;
    const contact = await contactOf(t);
    for (const f of node.fulfillments ?? []) {
      if (String(f.status).toUpperCase() !== "SUCCESS") continue;
      const stage = shipmentStage(f.displayStatus);
      if (!stage || stage === "shipped") continue;
      const info = f.trackingInfo?.[0] ?? {};
      const at = stage === "delivered" && f.deliveredAt ? date(f.deliveredAt) : stage === "in_transit" && f.inTransitAt ? date(f.inTransitAt) : date(f.updatedAt);
      const current = await systemDb.orderTracking.findUniqueOrThrow({ where: { id: t.id } });
      await applyStage(ctx, current, contact, {
        fulfillmentId: gidId(f.id),
        stage,
        at,
        source: "carrier",
        courier: info.company ?? null,
        trackingNumber: info.number ?? null,
        trackingUrl: info.url ?? null,
        estimatedDeliveryAt: f.estimatedDeliveryAt ? date(f.estimatedDeliveryAt) : null,
      });
    }
  }
  return open.length;
}

// ---------------------------------------------------------------------------
// GDPR
// ---------------------------------------------------------------------------

/** customers/redact: everything WhatsApp holds about this customer goes. */
export async function redactWhatsappCustomer(store: Pick<Store, "id">, p: Payload): Promise<number> {
  const ck = p.customer?.id ? customerKey(store, String(p.customer.id)) : null;
  const phone = normalizePhone(p.customer?.phone ?? null, null);
  const contacts = await systemDb.whatsappContact.findMany({
    where: { storeId: store.id, OR: [...(ck ? [{ customerKey: ck }] : []), ...(phone ? [{ phoneHash: phoneHash(store.id, phone.waId) }] : [])] },
    select: { id: true },
  });
  const contactIds = contacts.map((c) => c.id);
  const orderIds: string[] = (Array.isArray(p.orders_to_redact) ? p.orders_to_redact : []).map(String);
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

/**
 * Orders, parcels and refunds onto the timeline, and the notifications they set off (order
 * confirmed, paid, cancelled, processing, packed, shipped, out for delivery, delivered, reviews).
 */
import { Prisma, systemDb, type OrderTracking, type Store, type WhatsappContact } from "@app/db";
import { SHIPMENT_RANK, shipmentStage, type ShipmentStage } from "@app/shared";
import { customerKey } from "../../persist.js";
import { fulfillmentSchema, parseShopifyList, type AutomationOrder, type AutomationRefund, type ShopifyFulfillment } from "../../shopifyPayloads.js";
import { cancelScheduled, type WaDeps } from "../messages.js";
import { newLinkToken, storeWhatsapp, upsertContact, waEncrypt } from "../store.js";
import { addressLine, money, type Values } from "../values.js";
import { attributeOrder, completeCheckout } from "./checkouts.js";
import { automate, cartOptIn, contactOf, date, firstNameOf, fresh, itemsOf, notify, phoneOf, smsSignal, tagsOf, trackingOf, valuesFor, type Ctx } from "./context.js";
import { addEvent, refreshTrackingStatus } from "./timeline.js";

/** How long an order's tracking and review links keep working. */
export const TRACKING_LINK_DAYS = 120;

async function upsertTracking(ctx: Ctx, p: AutomationOrder, contact: WhatsappContact | null): Promise<{ tracking: OrderTracking; isNew: boolean }> {
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

export async function onOrder(ctx: Ctx, p: AutomationOrder) {
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
  const parcels = parseShopifyList(fulfillmentSchema, p.fulfillments ?? [], "order fulfillment", { storeId: ctx.store.id, module: "whatsapp", orderId: id });
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

export interface StageInput {
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
export async function applyFulfillment(ctx: Ctx, t: OrderTracking, contact: WhatsappContact | null, f: ShopifyFulfillment, phase: "shipped" | "carrier" | "both" = "both") {
  // Pending (with a fulfillment service) or cancelled: nothing has shipped.
  const status = String(f.status ?? "success").toLowerCase();
  if (status !== "success") return;
  const common = {
    fulfillmentId: String(f.id),
    courier: f.tracking_company ? String(f.tracking_company) : null,
    trackingNumber: f.tracking_number || f.tracking_numbers?.[0] || null,
    trackingUrl: f.tracking_url || f.tracking_urls?.[0] || null,
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

export async function applyStage(ctx: Ctx, stale: OrderTracking, contact: WhatsappContact | null, s: StageInput) {
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

export async function onRefund(ctx: Ctx, p: AutomationRefund) {
  const t = await trackingOf(ctx.store, p.order_id);
  if (!t) return;
  const amount = (p.transactions ?? [])
    .filter((tx) => tx.kind === "refund" && (tx.status ?? "success") === "success")
    .reduce((sum, tx) => sum + Number(tx.amount ?? 0), 0);
  const at = date(p.created_at);
  if (!(await addEvent(t, { type: "refunded", occurredAt: at, source: "shopify", dedupeKey: `refund:${p.id}` }))) return;
  const contact = await contactOf(t);
  const values = valuesFor(ctx, t, contact, { refund_amount: money(amount, t.currency) });
  if (amount > 0 && fresh(at)) await notify(ctx, "refund_processed", { tracking: t, contact, values, dedupeKey: `order:${t.shopifyOrderId}:refund_processed:${p.id}` });
  await automate(ctx, "refund_created", `refund:${p.id}`, t, contact, values);
}

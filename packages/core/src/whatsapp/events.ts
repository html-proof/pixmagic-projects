/**
 * Store events → the order timeline, tracking links and WhatsApp notifications.
 *
 * Fed by Shopify's webhooks (HMAC-verified at intake, apps/api/src/routes/webhooks.ts) and by the
 * shipment poll (events/shipments.ts). This file is the webhooks' entry point; the work is in
 * events/: orders.ts (orders, parcels, refunds), checkouts.ts (cart reminders), timeline.ts.
 *
 * Shopify delivers late, twice and out of order, so:
 *  - every timeline event has a dedupe key, and a notification is only sent the first time its
 *    event is recorded (and has its own dedupe key on top);
 *  - a parcel stage is only announced when it is further along than anything seen for that
 *    fulfillment ("delivered" then a late "shipped" announces nothing);
 *  - an event older than STALE_NOTIFY_MS is recorded but not announced;
 *  - "delivered" is only ever written from Shopify's carrier status or the merchant's own button.
 */
import type { Store } from "@app/db";
import { shipmentStage } from "@app/shared";
import { automationCheckoutSchema, automationOrderSchema, automationRefundSchema, fulfillmentEventSchema, fulfillmentWebhookSchema, parseShopify } from "../shopifyPayloads.js";
import type { WaDeps } from "./messages.js";
import { storeWhatsapp } from "./store.js";
import { onCheckout } from "./events/checkouts.js";
import { contactOf, date, trackingOf, type Ctx } from "./events/context.js";
import { applyFulfillment, applyStage, onOrder, onRefund } from "./events/orders.js";

export { cartOptIn, STALE_NOTIFY_MS } from "./events/context.js";
export { refreshTrackingStatus } from "./events/timeline.js";
export { merchantOrderStep, TRACKING_LINK_DAYS } from "./events/orders.js";
export { CART_ATTRIBUTION_MS } from "./events/checkouts.js";
export { pollShipments } from "./events/shipments.js";
export { redactWhatsappCustomer } from "./events/redact.js";

const ORDER_TOPICS = new Set(["orders/create", "orders/updated", "orders/paid", "orders/cancelled", "orders/fulfilled", "orders/partially_fulfilled"]);
export const WHATSAPP_TOPICS = new Set([...ORDER_TOPICS, "refunds/create", "checkouts/create", "checkouts/update", "fulfillments/create", "fulfillments/update", "fulfillment_events/create"]);

/**
 * Apply a verified Shopify webhook to WhatsApp. A no-op for stores that haven't turned WhatsApp on.
 * The payload is checked only past that point, so a store without WhatsApp logs nothing about it;
 * one that doesn't fit is logged and skipped, since a retry would meet the same payload.
 */
export async function whatsappOnShopifyEvent(store: Store, topic: string, payload: unknown, deps: WaDeps): Promise<void> {
  if (!WHATSAPP_TOPICS.has(topic) || store.status === "uninstalled") return;
  const wa = await storeWhatsapp(store.id);
  if (!wa) return;
  const ctx: Ctx = { store, cfg: wa.config, connection: wa.connection, deps };
  const logIds = { storeId: store.id, module: "whatsapp" };
  if (ORDER_TOPICS.has(topic)) {
    const order = parseShopify(automationOrderSchema, payload, topic, logIds);
    if (order) await onOrder(ctx, order);
    return;
  }
  if (topic === "refunds/create") {
    const refund = parseShopify(automationRefundSchema, payload, topic, logIds);
    if (refund) await onRefund(ctx, refund);
    return;
  }
  if (topic === "checkouts/create" || topic === "checkouts/update") {
    const checkout = parseShopify(automationCheckoutSchema, payload, topic, logIds);
    if (checkout) await onCheckout(ctx, checkout);
    return;
  }
  // Fulfillment payloads name their order; only orders already on the timeline are followed.
  if (topic === "fulfillments/create" || topic === "fulfillments/update") {
    const f = parseShopify(fulfillmentWebhookSchema, payload, topic, logIds);
    const t = f && (await trackingOf(store, f.order_id));
    if (f && t) await applyFulfillment(ctx, t, await contactOf(t), f);
    return;
  }
  // fulfillment_events/create: the courier's own progress report.
  const e = parseShopify(fulfillmentEventSchema, payload, topic, logIds);
  const t = e && (await trackingOf(store, e.order_id));
  if (!e || !t) return;
  const contact = await contactOf(t);
  const stage = shipmentStage(e.status);
  if (!stage) return;
  await applyStage(ctx, t, contact, {
    fulfillmentId: String(e.fulfillment_id),
    stage,
    at: date(e.happened_at ?? e.created_at),
    source: stage === "shipped" ? "shopify" : "carrier",
    estimatedDeliveryAt: e.estimated_delivery_at ? date(e.estimated_delivery_at) : null,
  });
}

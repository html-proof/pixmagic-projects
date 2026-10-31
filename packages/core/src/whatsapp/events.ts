/**
 * Shopify's webhooks → WhatsApp automations. Called by the webhook consumer after the analytics
 * write (Shopify's HMAC, dedupe and shop binding are checked at intake), for every store; a no-op
 * for a store without a WhatsApp connection or without a switched-on automation for the trigger,
 * which also reads nothing of the payload.
 *
 *  - orders/create → "An order is placed"; it also cancels the checkout's waiting reminder.
 *  - orders/paid → "An order is paid".
 *  - orders/fulfilled, orders/partially_fulfilled → "An order ships" (once per order: the first parcel).
 *  - orders/cancelled → "An order is cancelled"; it also cancels what else waits about the order.
 *  - checkouts/create, checkouts/update → "A checkout is left unfinished", timed from the customer's
 *    latest change; a completed checkout cancels its reminder.
 *  - customers/create → "A customer signs up" (the store must grant read_customers; the topic is
 *    subscribed per store when such an automation is switched on).
 *
 * WhatsApp delivery and Shopify's figures stay apart: nothing here changes an order.
 */
import { systemDb, type Store } from "@app/db";
import { expandScopes, normalizePhone, type NormalizedPhone, type WaFacts, type WaTrigger, type WaValues } from "@app/shared";
import { env } from "../env.js";
import { WEBHOOK_SUBSCRIPTIONS_QUERY, WEBHOOK_SUBSCRIPTION_CREATE } from "../inventory/queries.js";
import type { InventoryGql } from "../inventory/shopify.js";
import { logger } from "../logger.js";
import { automationCheckoutSchema, automationOrderSchema, customerConsentSchema, fulfillmentSchema, parseShopify, parseShopifyList, type AutomationCheckout, type AutomationOrder } from "../shopifyPayloads.js";
import { firstNameOf, itemsOf, phoneOf, tagsOf, type Purchase } from "../shopifyCustomer.js";
import { connectionListens, liveConnection, type WaDeps } from "./common.js";
import { cancelSubject, runAutomations } from "./automations.js";

const ORDER_TRIGGER: Record<string, WaTrigger> = {
  "orders/create": "order_created",
  "orders/paid": "order_paid",
  "orders/fulfilled": "order_fulfilled",
  "orders/partially_fulfilled": "order_fulfilled",
  "orders/cancelled": "order_cancelled",
};
export const WHATSAPP_TOPICS = new Set([...Object.keys(ORDER_TRIGGER), "checkouts/create", "checkouts/update", "customers/create"]);

const date = (v: unknown, fallback = new Date()) => {
  const d = v ? new Date(String(v)) : fallback;
  return Number.isNaN(d.getTime()) ? fallback : d;
};

/** An amount in the order's currency, as a customer reads it ("$58.00", "₹1,250.00"). */
export function money(amount: unknown, currency: string | null | undefined): string | undefined {
  const n = Number(amount);
  if (!Number.isFinite(n)) return undefined;
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency: currency || "USD" }).format(n);
  } catch {
    return n.toFixed(2);
  }
}

const countryOf = (p: Purchase, phone: NormalizedPhone | null) => (p.shipping_address?.country_code ?? p.billing_address?.country_code ?? p.customer?.default_address?.country_code ?? phone?.country ?? null)?.toUpperCase() ?? null;

/** The numbers an automation can send to: the customer's (any of the order's), or one address's own. */
function phonesOf(p: Purchase) {
  const country = p.shipping_address?.country_code ?? p.billing_address?.country_code ?? p.customer?.default_address?.country_code ?? null;
  return {
    customer: phoneOf(p),
    shipping_address: normalizePhone(p.shipping_address?.phone ?? null, p.shipping_address?.country_code ?? country),
    billing_address: normalizePhone(p.billing_address?.phone ?? null, p.billing_address?.country_code ?? country),
  };
}

function purchaseFacts(p: Purchase, phone: NormalizedPhone | null): WaFacts {
  const count = p.customer?.orders_count;
  return {
    orderTotal: p.total_price != null && Number.isFinite(Number(p.total_price)) ? Number(p.total_price) : null,
    country: countryOf(p, phone),
    productTitles: itemsOf(p).map((i) => i.title),
    customerType: typeof count === "number" ? (count > 1 ? "returning" : "new") : null,
    tags: "tags" in p ? tagsOf(p as AutomationOrder) : [],
    messageText: null,
  };
}

function purchaseValues(store: Store, p: Purchase): WaValues {
  const items = itemsOf(p);
  return {
    customer_first_name: firstNameOf(p) ?? undefined,
    order_total: money(p.total_price, p.presentment_currency ?? p.currency ?? store.currency),
    product_names: items.length ? items.map((i) => (i.quantity > 1 ? `${i.title} ×${i.quantity}` : i.title)).join(", ").slice(0, 300) : undefined,
  };
}

const customerDetails = (p: Purchase, at: Date) => ({
  firstName: firstNameOf(p),
  shopifyCustomerId: p.customer?.id != null ? String(p.customer.id) : null,
  ordersCount: typeof p.customer?.orders_count === "number" ? p.customer.orders_count : null,
  totalSpent: p.customer?.total_spent != null ? Number(p.customer.total_spent) : null,
  lastOrderAt: at,
});

/** The parcel to tell the customer about: the newest one with tracking, else the newest. */
function latestParcel(order: AutomationOrder, logIds: Record<string, unknown>) {
  const parcels = parseShopifyList(fulfillmentSchema, order.fulfillments ?? [], "order fulfillments", logIds);
  const sorted = [...parcels].sort((a, b) => date(b.created_at, new Date(0)).getTime() - date(a.created_at, new Date(0)).getTime());
  return sorted.find((f) => f.tracking_number || f.tracking_numbers?.length) ?? sorted[0] ?? null;
}

async function onOrder(store: Store, topic: string, order: AutomationOrder, deps: Pick<WaDeps, "queues">, logIds: Record<string, unknown>) {
  const trigger = ORDER_TRIGGER[topic]!;
  const placed = date(order.processed_at ?? order.created_at);
  const phones = phonesOf(order);
  const values: WaValues = { ...purchaseValues(store, order), order_number: order.name ?? (order.order_number != null ? `#${order.order_number}` : undefined), order_status_url: order.order_status_url ?? undefined };
  let occurredAt = placed;
  if (trigger === "order_fulfilled") {
    const parcel = latestParcel(order, logIds);
    if (parcel) {
      values.tracking_number = parcel.tracking_number ?? parcel.tracking_numbers?.[0] ?? undefined;
      values.tracking_url = parcel.tracking_url ?? parcel.tracking_urls?.[0] ?? undefined;
      values.carrier = parcel.tracking_company ?? undefined;
      occurredAt = date(parcel.created_at, new Date());
    } else {
      occurredAt = date(order.updated_at, new Date());
    }
  } else if (trigger === "order_paid" || trigger === "order_cancelled") {
    occurredAt = date(trigger === "order_cancelled" ? order.cancelled_at : order.updated_at, new Date());
  }
  if (trigger === "order_created" && order.checkout_token) await cancelSubject(store.id, `checkout:${order.checkout_token}`, "checkout_completed");
  if (trigger === "order_cancelled") await cancelSubject(store.id, `order:${order.id}`, "order_cancelled", "order_cancelled");
  // An order that arrives already cancelled is no news to send (except to its own trigger).
  if (order.cancelled_at && trigger !== "order_cancelled") return;
  await runAutomations(deps, {
    store,
    trigger,
    key: `order:${order.id}`,
    label: `Order ${order.name ?? order.id}`,
    phones,
    contact: customerDetails(order, placed),
    shopifyConsent: order.customer?.sms_marketing_consent?.state ?? (order.buyer_accepts_sms_marketing ? "subscribed" : null),
    values,
    facts: purchaseFacts(order, phones.customer),
    occurredAt,
  });
}

async function onCheckout(store: Store, checkout: AutomationCheckout, deps: Pick<WaDeps, "queues">) {
  if (checkout.completed_at) {
    await cancelSubject(store.id, `checkout:${checkout.token}`, "checkout_completed");
    return;
  }
  const phones = phonesOf(checkout);
  // An anonymous checkout is never kept: nobody to remind, nothing to record.
  if (!phones.customer && !phones.shipping_address && !phones.billing_address) return;
  await runAutomations(deps, {
    store,
    trigger: "checkout_abandoned",
    key: `checkout:${checkout.token}`,
    label: "Checkout",
    phones,
    contact: { firstName: firstNameOf(checkout), shopifyCustomerId: checkout.customer?.id != null ? String(checkout.customer.id) : null },
    shopifyConsent: checkout.customer?.sms_marketing_consent?.state ?? (checkout.buyer_accepts_sms_marketing ? "subscribed" : null),
    values: { ...purchaseValues(store, checkout), checkout_url: checkout.abandoned_checkout_url ?? undefined },
    facts: purchaseFacts(checkout, phones.customer),
    occurredAt: date(checkout.updated_at ?? checkout.created_at),
    retime: true,
  });
}

/**
 * Applies a verified Shopify webhook to WhatsApp Automation. A no-op unless the store has a
 * connection that listens and a switched-on automation for the event; the payload is read only
 * past that point.
 */
export async function whatsappOnShopifyEvent(store: Store, topic: string, payload: unknown, deps: Pick<WaDeps, "queues">): Promise<void> {
  if (!WHATSAPP_TOPICS.has(topic) || store.status === "uninstalled") return;
  if (!connectionListens(await liveConnection(store.id))) return;
  const trigger: WaTrigger = ORDER_TRIGGER[topic] ?? (topic.startsWith("checkouts/") ? "checkout_abandoned" : "customer_created");
  // Cancellations of waiting messages need no automation of their own trigger.
  const listening = await systemDb.wappAutomation.count({ where: { storeId: store.id, status: "active" } });
  if (!listening) return;
  const logIds = { storeId: store.id, module: "whatsapp" };
  if (ORDER_TRIGGER[topic]) {
    const order = parseShopify(automationOrderSchema, payload, topic, logIds);
    if (order) await onOrder(store, topic, order, deps, logIds);
    return;
  }
  if (trigger === "checkout_abandoned") {
    const checkout = parseShopify(automationCheckoutSchema, payload, topic, logIds);
    if (checkout) await onCheckout(store, checkout, deps);
    return;
  }
  const c = parseShopify(customerConsentSchema, payload, topic, logIds);
  if (!c) return;
  const country = c.default_address?.country_code ?? null;
  const phone = normalizePhone(c.phone ?? c.default_address?.phone ?? null, country);
  await runAutomations(deps, {
    store,
    trigger: "customer_created",
    key: `customer:${c.id}`,
    label: "New customer",
    phones: { customer: phone, shipping_address: null, billing_address: null },
    contact: { firstName: c.first_name ?? null, shopifyCustomerId: String(c.id) },
    shopifyConsent: c.sms_marketing_consent?.state ?? null,
    values: { customer_first_name: c.first_name ?? undefined },
    facts: { orderTotal: null, country: country?.toUpperCase() ?? phone?.country ?? null, productTitles: [], customerType: null, tags: [], messageText: null },
    occurredAt: date(c.updated_at, new Date()),
  });
}

/**
 * Shopify sends customers/create only to an app subscribed per store, and only once the store granted
 * read_customers (the topic can't go in the app's toml). A "customer signs up" automation subscribes
 * its store when it is switched on. Returns why it can't, or null when the store is subscribed.
 */
export async function ensureCustomerWebhook(store: Pick<Store, "id" | "grantedScopes">, gql: InventoryGql): Promise<string | null> {
  if (!expandScopes(store.grantedScopes).has("read_customers")) {
    return "Shopify hasn't given bizinsights access to this store's customers (read_customers), so it doesn't hear about new ones. Update the bizinsights app's access in Shopify, then switch this on again.";
  }
  const uri = `${env().API_URL}/webhooks/shopify`;
  let cursor: string | null = null;
  for (let page = 0; page < 10; page++) {
    const d: { webhookSubscriptions: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Array<{ topic: string; uri?: string | null }> } } = await gql(WEBHOOK_SUBSCRIPTIONS_QUERY, { cursor });
    if (d.webhookSubscriptions.nodes.some((n) => n.topic === "CUSTOMERS_CREATE" && (!n.uri || n.uri === uri))) return null;
    if (!d.webhookSubscriptions.pageInfo.hasNextPage || !d.webhookSubscriptions.pageInfo.endCursor) break;
    cursor = d.webhookSubscriptions.pageInfo.endCursor;
  }
  const r = await gql<{ webhookSubscriptionCreate: { webhookSubscription: { id: string } | null; userErrors: Array<{ message: string }> } }>(WEBHOOK_SUBSCRIPTION_CREATE, { topic: "CUSTOMERS_CREATE", sub: { uri } });
  const errs = r.webhookSubscriptionCreate.userErrors;
  // "Address for this topic has already been taken": subscribed already.
  if (errs.length && !errs.every((e) => /already been taken/i.test(e.message))) {
    logger.warn({ storeId: store.id, errors: errs.map((e) => e.message) }, "whatsapp: customers/create subscription refused");
    return "Shopify refused to tell bizinsights about new customers on this store (its customer data isn't approved for bizinsights yet). This automation can't start until it does.";
  }
  return null;
}

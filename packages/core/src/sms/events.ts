/**
 * Shopify's store events → Customer Messaging: contacts and their consent, the orders that count
 * towards segments and attribution, abandoned checkouts, and the rules each event runs.
 *
 * Fed by the verified Shopify webhooks (apps/worker handlers/webhooks.ts), after analytics and
 * WhatsApp, in the same idempotent job. A no-op for a store without a sender configuration: a
 * store that doesn't use SMS logs nothing about it. Shopify delivers late, twice and out of order:
 *  - each rule sends once per subject (rule:<id>:<subject>), so a retried webhook sends nothing new;
 *  - an event older than 48 hours runs no rule (its text would be stale);
 *  - a newer consent state is never replaced by an older one.
 *
 * Topics, checked against the Admin API 2026-10: orders/create, orders/paid, orders/cancelled,
 * orders/updated, orders/fulfilled, orders/partially_fulfilled (fulfillments ride the order),
 * refunds/create, checkouts/create, checkouts/update, and with read_customers customers/create,
 * customers/update, customers_marketing_consent/update. On a live store Shopify withholds the phone
 * number until the app is approved for protected customer data (Level 2): texts are then recorded
 * as "no mobile number".
 */
import { systemDb, type SmsContact, type Store } from "@app/db";
import { expandScopes, normalizePhone } from "@app/shared";
import type { RuleFacts, SmsTrigger, SmsValues } from "@app/shared/sms";
import { DEFAULT_ATTRIBUTION_DAYS, ATTRIBUTABLE_STATUSES } from "@app/shared/sms";
import type { Coord } from "../coord.js";
import { env } from "../env.js";
import { WEBHOOK_SUBSCRIPTIONS_QUERY, WEBHOOK_SUBSCRIPTION_CREATE } from "../inventory/queries.js";
import type { InventoryGql } from "../inventory/shopify.js";
import { logger } from "../logger.js";
import {
  automationCheckoutSchema,
  automationOrderSchema,
  automationRefundSchema,
  customerConsentSchema,
  fulfillmentSchema,
  parseShopify,
  type AutomationCheckout,
  type AutomationOrder,
  type CustomerConsentPayload,
} from "../shopifyPayloads.js";
import { firstNameOf, itemsOf, phoneOf, tagsOf } from "../whatsapp/events/context.js";
import { runSmsRules, type RuleSubject } from "./automations.js";
import { smsEncrypt, type SmsDeps } from "./common.js";
import { applyConsent, cancelMarketingFor, refreshContactStats, shopifySmsConsent, upsertSmsContact } from "./contacts.js";

const ORDER_TOPICS = new Set(["orders/create", "orders/updated", "orders/paid", "orders/cancelled", "orders/fulfilled", "orders/partially_fulfilled"]);
const CUSTOMER_TOPICS = new Set(["customers/create", "customers/update", "customers_marketing_consent/update"]);
export const SMS_TOPICS = new Set([...ORDER_TOPICS, ...CUSTOMER_TOPICS, "refunds/create", "checkouts/create", "checkouts/update"]);

/** Events older than this are recorded but run no rule. */
export const SMS_STALE_MS = 48 * 3600_000;

const date = (v: unknown, fallback = new Date()) => {
  const d = v ? new Date(String(v)) : fallback;
  return Number.isNaN(d.getTime()) ? fallback : d;
};
const fresh = (at: Date) => Date.now() - at.getTime() <= SMS_STALE_MS;

export interface SmsEventMeta {
  webhookId?: string | null;
}

/** Apply a verified Shopify webhook to Customer Messaging. */
export async function smsOnShopifyEvent(store: Store, topic: string, payload: unknown, deps: Pick<SmsDeps, "queues">, meta: SmsEventMeta = {}): Promise<void> {
  if (!SMS_TOPICS.has(topic) || store.status === "uninstalled") return;
  const sender = await systemDb.smsSenderConfiguration.findUnique({ where: { storeId: store.id }, select: { id: true } });
  if (!sender) return;
  const logIds = { storeId: store.id, module: "sms" };
  const evidence = { topic, webhookId: meta.webhookId ?? null };
  if (ORDER_TOPICS.has(topic)) {
    const order = parseShopify(automationOrderSchema, payload, topic, logIds);
    if (order) await onOrder(store, topic, order, evidence, deps);
    return;
  }
  if (topic === "refunds/create") {
    const refund = parseShopify(automationRefundSchema, payload, topic, logIds);
    if (!refund) return;
    const o = await systemDb.smsContactOrder.findUnique({ where: { storeId_shopifyOrderId: { storeId: store.id, shopifyOrderId: String(refund.order_id) } }, include: { contact: true } });
    if (!o) return;
    const amount = (refund.transactions ?? []).filter((t) => t.kind === "refund" && (t.status ?? "success") === "success").reduce((n, t) => n + Number(t.amount ?? 0), 0);
    const at = date(refund.created_at);
    if (!fresh(at)) return;
    await runSmsRules("refund_issued", { key: `refund:${refund.id}`, store, contact: o.contact, facts: { orderTotal: amount, country: o.contact.country }, values: { order_number: o.orderName, order_total: amount, currency: o.currency }, at, orderId: o.shopifyOrderId }, deps);
    return;
  }
  if (topic === "checkouts/create" || topic === "checkouts/update") {
    const checkout = parseShopify(automationCheckoutSchema, payload, topic, logIds);
    if (checkout) await onCheckout(store, checkout, evidence, deps);
    return;
  }
  const customer = parseShopify(customerConsentSchema, payload, topic, logIds);
  if (!customer) return;
  const contacts = await onCustomer(store, customer, evidence);
  if (topic === "customers/create") await onCustomerCreated(store, customer, contacts[0] ?? null, deps);
}

/**
 * customers/create: a new customer account, the "Customer registered" trigger. Welcome texts are
 * marketing, so the rules' consent check sends them only to a customer subscribed to SMS
 * marketing (Shopify says so on the customer); one per customer whatever Shopify repeats.
 */
async function onCustomerCreated(store: Store, c: CustomerConsentPayload, contact: SmsContact | null, deps: Pick<SmsDeps, "queues">) {
  const at = date(c.created_at ?? c.updated_at);
  if (!fresh(at)) return;
  const current = contact ? await systemDb.smsContact.findUnique({ where: { id: contact.id } }) : null;
  await runSmsRules(
    "customer_registered",
    {
      key: `customer:${String(c.id)}`,
      store,
      contact: current,
      noContactReason: current ? null : c.phone?.trim() ? "invalid_number" : "no_phone",
      facts: { country: current?.country ?? c.default_address?.country_code ?? null },
      values: { customer_name: c.first_name ?? null },
      at,
    },
    deps,
  );
}

async function contactFor(store: Store, p: AutomationOrder | AutomationCheckout, source: "shopify_order" | "shopify_checkout", evidence: Record<string, unknown>): Promise<SmsContact | null> {
  const phone = phoneOf(p);
  if (!phone) return null;
  return upsertSmsContact(store, {
    phone,
    firstName: firstNameOf(p),
    shopifyCustomerId: p.customer?.id != null ? String(p.customer.id) : null,
    consent: shopifySmsConsent(p.customer?.sms_marketing_consent, p.buyer_accepts_sms_marketing, source, evidence),
  });
}

/** Why an order or checkout has no contact: no number on it, or one that isn't a valid mobile number. */
function noContactReason(p: AutomationOrder | AutomationCheckout): string {
  const raw = [p.phone, p.shipping_address?.phone, p.billing_address?.phone, p.customer?.phone, p.sms_marketing_phone].find((v) => typeof v === "string" && v.trim());
  return raw ? "invalid_number" : "no_phone";
}

function orderFacts(o: AutomationOrder, contact: SmsContact | null): RuleFacts {
  return {
    orderTotal: Number(o.total_price ?? 0),
    country: contact?.country ?? o.shipping_address?.country_code ?? o.billing_address?.country_code ?? null,
    productTitles: itemsOf(o).map((i) => i.title),
    tags: tagsOf(o),
    customerOrders: contact?.ordersCount ?? null,
    customerSpent: contact ? Number(contact.totalSpent) : null,
    daysSinceLastOrder: contact?.lastOrderAt ? Math.floor((Date.now() - contact.lastOrderAt.getTime()) / 86400_000) : null,
  };
}

function orderValues(o: AutomationOrder): SmsValues {
  const first = itemsOf(o)[0];
  return { order_number: o.name ?? (o.order_number != null ? `#${o.order_number}` : null), order_total: o.total_price != null ? Number(o.total_price) : null, currency: o.presentment_currency ?? o.currency ?? null, product_name: first?.title ?? null };
}

async function onOrder(store: Store, topic: string, o: AutomationOrder, evidence: Record<string, unknown>, deps: Pick<SmsDeps, "queues">) {
  const orderId = String(o.id);
  const placedAt = date(o.processed_at ?? o.created_at);
  const contact = await contactFor(store, o, "shopify_order", evidence);
  let isNew = false;
  if (contact) {
    const existing = await systemDb.smsContactOrder.findUnique({ where: { storeId_shopifyOrderId: { storeId: store.id, shopifyOrderId: orderId } } });
    const data = { orderName: o.name ?? null, total: Number(o.total_price ?? 0), currency: o.presentment_currency ?? o.currency ?? store.currency, placedAt, cancelled: !!o.cancelled_at };
    if (!existing) {
      isNew = true;
      await systemDb.smsContactOrder.upsert({ where: { storeId_shopifyOrderId: { storeId: store.id, shopifyOrderId: orderId } }, create: { workspaceId: store.workspaceId, storeId: store.id, contactId: contact.id, shopifyOrderId: orderId, ...data }, update: data });
    } else {
      await systemDb.smsContactOrder.update({ where: { id: existing.id }, data });
    }
    await refreshContactStats(contact.id);
    if (isNew) await attributeOrder(store, contact, orderId, Number(o.total_price ?? 0), data.currency, placedAt);
  }
  // The order finishes its checkout: no more recovery texts for it.
  if (o.checkout_token) await completeCheckout(store, o.checkout_token, orderId);
  if (o.cancelled_at) await systemDb.smsMessageJob.updateMany({ where: { storeId: store.id, orderId, status: "scheduled", trigger: { notIn: ["order_cancelled", "refund_issued"] } }, data: { status: "cancelled", reason: "order_cancelled", finalAt: new Date(), valuesEnc: null } });

  const freshContact = contact ? await systemDb.smsContact.findUnique({ where: { id: contact.id } }) : null;
  const subjectBase = { store, contact: freshContact, noContactReason: freshContact ? null : noContactReason(o), facts: orderFacts(o, freshContact), values: orderValues(o), orderId };
  const run = (trigger: SmsTrigger, key: string, at: Date, extra: Partial<RuleSubject> = {}) => (fresh(at) ? runSmsRules(trigger, { ...subjectBase, key, at, ...extra }, deps) : Promise.resolve([]));

  if (topic === "orders/create" || (isNew && topic !== "orders/cancelled")) await run("order_created", `order:${orderId}`, date(o.created_at));
  if (topic === "orders/paid") await run("payment_completed", `paid:${orderId}`, date(o.processed_at ?? o.updated_at));
  if (topic === "orders/cancelled" && o.cancelled_at) await run("order_cancelled", `cancel:${orderId}`, date(o.cancelled_at));
  for (const raw of o.fulfillments ?? []) {
    const f = fulfillmentSchema.safeParse(raw);
    if (!f.success) continue;
    const ful = f.data;
    const tracking = ful.tracking_url ?? ful.tracking_urls?.[0] ?? null;
    if ((ful.status ?? "success") === "success") await run("fulfillment_created", `ful:${ful.id}`, date(ful.created_at), { values: { ...subjectBase.values, tracking_url: tracking } });
    if ((ful.shipment_status ?? "").toLowerCase() === "delivered") await run("delivery_confirmed", `del:${ful.id}`, date(ful.updated_at ?? ful.created_at), { values: { ...subjectBase.values, tracking_url: tracking } });
  }
}

/**
 * Credit a new order to the last text its customer received before it (within the window, each
 * order once): the campaign's attribution days, or 3 days for automations. "Followed", not "caused".
 */
async function attributeOrder(store: Store, contact: SmsContact, orderId: string, total: number, currency: string, placedAt: Date) {
  const since = new Date(placedAt.getTime() - 14 * 86400_000);
  const candidates = await systemDb.smsMessageJob.findMany({
    where: { storeId: store.id, contactId: contact.id, purpose: { in: ["campaign", "automation", "manual"] }, status: { in: [...ATTRIBUTABLE_STATUSES] }, acceptedAt: { gte: since, lte: placedAt }, attributedOrderId: null },
    orderBy: { acceptedAt: "desc" },
    take: 5,
    select: { id: true, acceptedAt: true, campaignId: true },
  });
  for (const c of candidates) {
    const days = c.campaignId ? ((await systemDb.smsCampaign.findUnique({ where: { id: c.campaignId }, select: { attributionDays: true } }))?.attributionDays ?? DEFAULT_ATTRIBUTION_DAYS) : DEFAULT_ATTRIBUTION_DAYS;
    if (placedAt.getTime() - c.acceptedAt!.getTime() > days * 86400_000) continue;
    try {
      await systemDb.smsMessageJob.update({ where: { id: c.id }, data: { attributedOrderId: orderId, attributedRevenue: total, attributedCurrency: currency, attributedAt: new Date() } });
    } catch {
      // Credited already (the unique index on the order): one order counts once.
    }
    return;
  }
}

async function completeCheckout(store: Store, token: string, orderId: string | null) {
  const ck = await systemDb.smsCheckout.findUnique({ where: { storeId_checkoutToken: { storeId: store.id, checkoutToken: token } } });
  if (ck && ck.status === "open") await systemDb.smsCheckout.update({ where: { id: ck.id }, data: { status: "completed", completedAt: new Date(), completedOrderId: orderId } });
  await systemDb.smsMessageJob.updateMany({ where: { storeId: store.id, checkoutToken: token, status: "scheduled" }, data: { status: "cancelled", reason: "checkout_completed", finalAt: new Date(), valuesEnc: null } });
}

async function onCheckout(store: Store, p: AutomationCheckout, evidence: Record<string, unknown>, deps: Pick<SmsDeps, "queues">) {
  const token = p.token;
  if (p.completed_at) return completeCheckout(store, token, null);
  const contact = await contactFor(store, p, "shopify_checkout", evidence);
  // Anonymous checkouts are never stored or texted: only someone who typed a number can be reminded.
  if (!contact) return;
  const activity = date(p.updated_at ?? p.created_at);
  const existing = await systemDb.smsCheckout.findUnique({ where: { storeId_checkoutToken: { storeId: store.id, checkoutToken: token } } });
  if (existing && (existing.status !== "open" || existing.lastActivityAt > activity)) return;
  const first = itemsOf(p)[0];
  const data = {
    contactId: contact.id,
    productTitle: first?.title ?? null,
    total: p.total_price != null ? Number(p.total_price) : null,
    currency: p.presentment_currency ?? p.currency ?? null,
    recoveryUrlEnc: p.abandoned_checkout_url ? smsEncrypt(store.id, "recovery", p.abandoned_checkout_url) : null,
    lastActivityAt: activity,
  };
  await systemDb.smsCheckout.upsert({ where: { storeId_checkoutToken: { storeId: store.id, checkoutToken: token } }, create: { workspaceId: store.workspaceId, storeId: store.id, checkoutToken: token, ...data }, update: data });
  if (!fresh(activity)) return;
  // Each recovery rule is one stage, sent once per checkout; while the customer keeps editing, the wait starts again.
  const runs = await runSmsRules(
    "checkout_abandoned",
    {
      key: `cart:${token}`,
      store,
      contact,
      facts: { orderTotal: data.total, country: contact.country, productTitles: first ? [first.title] : [], customerOrders: contact.ordersCount, customerSpent: Number(contact.totalSpent) },
      values: { product_name: first?.title ?? null, checkout_url: p.abandoned_checkout_url ?? null, currency: data.currency },
      at: activity,
      checkoutToken: token,
    },
    deps,
  );
  for (const r of runs) {
    if (r.outcome !== "duplicate" || !r.jobId) continue;
    const rule = await systemDb.smsAutomationRule.findUnique({ where: { id: r.ruleId }, select: { activeConfig: true } });
    const delay = Number((rule?.activeConfig as { delayMinutes?: number } | null)?.delayMinutes ?? 0);
    const due = new Date(activity.getTime() + delay * 60_000);
    // Only a reminder still waiting moves; values carry the newest recovery link.
    await systemDb.smsMessageJob.updateMany({ where: { id: r.jobId, status: "scheduled", sendAfter: { lt: due } }, data: { sendAfter: due, enqueuedAt: null } });
  }
}

/** customers/* and customers_marketing_consent/update: the customer's SMS consent, as Shopify has it now. Returns the customer's contacts (the one for their number first). */
async function onCustomer(store: Store, c: CustomerConsentPayload, evidence: Record<string, unknown>): Promise<SmsContact[]> {
  const signal = shopifySmsConsent(c.sms_marketing_consent, null, "shopify_customer", evidence);
  const customerId = String(c.id);
  const phone = normalizePhone(c.phone ?? null, c.default_address?.country_code ?? null);
  let contacts: SmsContact[] = [];
  if (phone) contacts = [await upsertSmsContact(store, { phone, firstName: c.first_name ?? null, shopifyCustomerId: customerId })];
  else contacts = await systemDb.smsContact.findMany({ where: { storeId: store.id, shopifyCustomerId: customerId } });
  if (!signal) return contacts;
  for (const contact of contacts) {
    const before = contact.consentState;
    const after = await applyConsent(contact, signal);
    if (before === "subscribed" && after.consentState !== "subscribed") {
      const cancelled = await cancelMarketingFor(contact.id, "no_marketing_consent");
      if (cancelled) logger.info({ storeId: store.id, cancelled }, "sms marketing texts cancelled: consent withdrawn");
    }
  }
  return contacts;
}

/**
 * Shopify tells bizinsights when a customer's SMS consent changes (customers_marketing_consent/update)
 * and when a customer account is created (customers/create, the "Customer registered" trigger)
 * only to an app subscribed per store, and only once the store granted read_customers (an optional
 * scope; the topics can't go in the app's toml). Subscribed when the sender is saved, when the
 * automation builder checks a trigger, and daily, as the inventory module does. Without them,
 * consent still arrives on every order and checkout, and an opt-out link or STOP works at once.
 */
export const SMS_WEBHOOK_TOPICS: ReadonlyArray<{ topic: string; scope: string }> = [
  { topic: "CUSTOMERS_MARKETING_CONSENT_UPDATE", scope: "read_customers" },
  { topic: "CUSTOMERS_CREATE", scope: "read_customers" },
];

/** Each per-store topic as Shopify last answered: subscribed (found or made now), refused by Shopify, or not asked for (the scope isn't granted). */
export type SmsWebhookState = "subscribed" | "refused" | "no_scope";
export interface SmsWebhookCheck {
  topics: Record<string, SmsWebhookState>;
  created: number;
  checkedAt: string;
}

/** Where the last check of a store's per-store topics is kept (the builder reads it instead of asking Shopify on every page). */
export const smsWebhookCheckKey = (storeId: string) => `sms:webhooks:${storeId}`;
const CHECK_TTL_S = 26 * 3600;

/** The last check of a store's per-store topics, if one is kept. */
export async function lastSmsWebhookCheck(coord: Coord, storeId: string): Promise<SmsWebhookCheck | null> {
  const raw = await coord.peek(smsWebhookCheckKey(storeId)).catch(() => null);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SmsWebhookCheck;
  } catch {
    return null;
  }
}

/** Subscribe the store to the per-store topics its scopes allow; how many were made now. */
export async function ensureSmsWebhooks(store: Pick<Store, "id" | "grantedScopes">, gql: InventoryGql, coord?: Coord): Promise<number> {
  return (await checkSmsWebhooks(store, gql, coord)).created;
}

/** Ask Shopify which per-store topics the store is subscribed to, subscribe what's missing, and keep the answer (when given `coord`). */
export async function checkSmsWebhooks(store: Pick<Store, "id" | "grantedScopes">, gql: InventoryGql, coord?: Coord): Promise<SmsWebhookCheck> {
  const scopes = expandScopes(store.grantedScopes);
  const topics: Record<string, SmsWebhookState> = Object.fromEntries(SMS_WEBHOOK_TOPICS.map((t) => [t.topic, scopes.has(t.scope) ? "refused" : "no_scope"]));
  const wanted = SMS_WEBHOOK_TOPICS.filter((t) => scopes.has(t.scope));
  const result: SmsWebhookCheck = { topics, created: 0, checkedAt: new Date().toISOString() };
  if (!wanted.length) {
    await coord?.put(smsWebhookCheckKey(store.id), JSON.stringify(result), CHECK_TTL_S).catch(() => {});
    return result;
  }
  const uri = `${env().API_URL}/webhooks/shopify`;
  const have = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < 10; page++) {
    const d: { webhookSubscriptions: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Array<{ topic: string; uri?: string | null }> } } = await gql(WEBHOOK_SUBSCRIPTIONS_QUERY, { cursor });
    for (const n of d.webhookSubscriptions.nodes) if (!n.uri || n.uri === uri) have.add(n.topic);
    if (!d.webhookSubscriptions.pageInfo.hasNextPage || !d.webhookSubscriptions.pageInfo.endCursor) break;
    cursor = d.webhookSubscriptions.pageInfo.endCursor;
  }
  for (const t of wanted) {
    if (have.has(t.topic)) {
      topics[t.topic] = "subscribed";
      continue;
    }
    const r = await gql<{ webhookSubscriptionCreate: { webhookSubscription: { id: string } | null; userErrors: Array<{ message: string }> } }>(WEBHOOK_SUBSCRIPTION_CREATE, { topic: t.topic, sub: { uri } });
    const errs = r.webhookSubscriptionCreate.userErrors;
    // "Address for this topic has already been taken": subscribed already. Anything else (protected
    // customer data not approved yet, for one) is logged: consent still arrives with orders and checkouts.
    if (errs.length && !errs.every((e) => /already been taken/i.test(e.message))) {
      logger.warn({ storeId: store.id, topic: t.topic, errors: errs.map((e) => e.message) }, "sms customer webhook subscription refused");
      continue;
    }
    topics[t.topic] = "subscribed";
    if (!errs.length) result.created++;
  }
  if (result.created) logger.info({ storeId: store.id, created: result.created }, "sms customer webhooks subscribed");
  await coord?.put(smsWebhookCheckKey(store.id), JSON.stringify(result), CHECK_TTL_S).catch(() => {});
  return result;
}

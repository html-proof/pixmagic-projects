/**
 * Business events for email automations: where they come from and how they are stored.
 *
 *  - Shopify: the webhook consumer hands every verified order/checkout webhook here
 *    (emailOnShopifyEvent). An order topic becomes order.created / paid / cancelled / fulfilled.
 *    checkout.abandoned is detected: a checkout with an email is watched (pending_detection), every
 *    update pushes its deadline back, an order from it or a completed checkout cancels it, and the
 *    sweep promotes it once CHECKOUT_ABANDON_MINUTES pass with neither.
 *  - The business's own systems: POST /api/v1/events (ingestCustomEvent), authenticated by an
 *    event API key, for custom events such as appointment.booked or invoice.overdue.
 *
 * An event is stored once per source id (a redelivered webhook or a retried API call is a no-op),
 * normalized to the fields in EVENT_CATALOG, and encrypted. Nothing is stored for an event no
 * enabled automation listens to, beyond the id that makes a retry a no-op.
 */
import { systemDb, type Store } from "@app/db";
import {
  CHECKOUT_ABANDON_MINUTES,
  customDataProblems,
  isCustomEventType,
  normalizeEmail,
  readPath,
  type EventData,
  type IngestEvent,
} from "@app/shared/email";
import { logger } from "../logger.js";
import { EmailError, isUniqueViolation, recipientHash, type EmailDeps } from "./common.js";
import { AAD, seal } from "./vault.js";

type Payload = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown, max = 200): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const titles = (items: unknown): string[] => (Array.isArray(items) ? items.map((i: Payload) => str(i?.title)).filter((t): t is string => !!t).slice(0, 50) : []);
const itemCount = (items: unknown): number => (Array.isArray(items) ? items.reduce((n: number, i: Payload) => n + (num(i?.quantity) ?? 1), 0) : 0);

/** Shopify's marketing consent for email: the customer's current consent, else the checkbox at checkout. */
function acceptsMarketing(p: Payload): boolean {
  const state = p.customer?.email_marketing_consent?.state;
  if (typeof state === "string") return state === "subscribed";
  return p.buyer_accepts_marketing === true || p.customer?.accepts_marketing === true;
}

function customer(p: Payload): EventData["customer"] {
  const email = normalizeEmail(p.email ?? p.contact_email ?? p.customer?.email);
  return {
    ...(email ? { email } : {}),
    ...(str(p.customer?.first_name ?? p.billing_address?.first_name ?? p.shipping_address?.first_name, 100) ? { first_name: str(p.customer?.first_name ?? p.billing_address?.first_name ?? p.shipping_address?.first_name, 100) } : {}),
    ...(str(p.customer?.last_name ?? p.billing_address?.last_name ?? p.shipping_address?.last_name, 100) ? { last_name: str(p.customer?.last_name ?? p.billing_address?.last_name ?? p.shipping_address?.last_name, 100) } : {}),
    accepts_marketing: acceptsMarketing(p),
  };
}

const storeFields = (store: Pick<Store, "name" | "shopDomain">) => ({ name: store.name ?? store.shopDomain, domain: store.shopDomain });

/** An order webhook as event data (EVENT_CATALOG's order fields). */
export function normalizeShopifyOrder(store: Pick<Store, "name" | "shopDomain">, p: Payload): EventData {
  return {
    customer: customer(p),
    order: {
      id: str(p.name, 40) ?? `#${p.order_number ?? p.id}`,
      number: num(p.order_number),
      total: num(p.total_price),
      subtotal: num(p.subtotal_price),
      currency: str(p.currency ?? p.presentment_currency, 3),
      financial_status: str(p.financial_status, 40),
      fulfillment_status: str(p.fulfillment_status, 40) ?? "unfulfilled",
      item_count: itemCount(p.line_items),
      product_titles: titles(p.line_items),
      discount_codes: Array.isArray(p.discount_codes) ? p.discount_codes.map((d: Payload) => str(d?.code, 60)).filter(Boolean).slice(0, 20) : [],
      shipping_country: str(p.shipping_address?.country_code, 2),
      status_url: typeof p.order_status_url === "string" && /^https:\/\//.test(p.order_status_url) ? p.order_status_url.slice(0, 500) : null,
    },
    store: storeFields(store),
  };
}

/** A checkout webhook as event data (EVENT_CATALOG's checkout fields). */
export function normalizeShopifyCheckout(store: Pick<Store, "name" | "shopDomain">, p: Payload): EventData {
  return {
    customer: customer(p),
    checkout: {
      total: num(p.total_price),
      currency: str(p.presentment_currency ?? p.currency, 3),
      item_count: itemCount(p.line_items),
      product_titles: titles(p.line_items),
      recovery_url: typeof p.abandoned_checkout_url === "string" && /^https:\/\//.test(p.abandoned_checkout_url) ? p.abandoned_checkout_url.slice(0, 1000) : null,
    },
    store: storeFields(store),
  };
}

/** Whether any enabled automation in the workspace listens to this event (for this store). */
async function listening(workspaceId: string, eventType: string, storeId: string | null): Promise<boolean> {
  const n = await systemDb.emailAutomationRule.count({
    where: { workspaceId, eventType, enabled: true, deletedAt: null, ...(storeId ? { OR: [{ storeId: null }, { storeId }] } : { storeId: null }) },
  });
  return n > 0;
}

export interface RecordInput {
  workspaceId: string;
  storeId?: string | null;
  source: "shopify" | "api";
  eventType: string;
  externalId: string;
  occurredAt: Date;
  data: EventData | null;
  status?: "received" | "pending_detection" | "processed";
  detectAfter?: Date | null;
}

/** Store an event once per source id, and queue its automations. Returns whether it was new. */
export async function recordEvent(input: RecordInput, deps: Pick<EmailDeps, "queues">): Promise<{ id: string; duplicate: boolean }> {
  const email = input.data ? normalizeEmail(readPath(input.data, "customer.email")) : null;
  try {
    const evt = await systemDb.emailBusinessEvent.create({
      data: {
        workspaceId: input.workspaceId,
        storeId: input.storeId ?? null,
        source: input.source,
        eventType: input.eventType,
        externalId: input.externalId,
        occurredAt: input.occurredAt,
        recipientHash: email ? recipientHash(input.workspaceId, email) : null,
        payloadEnc: input.data ? seal(JSON.stringify(input.data), AAD.eventPayload(input.workspaceId, input.source, input.externalId)) : null,
        status: input.status ?? "received",
        detectAfter: input.detectAfter ?? null,
        ...(input.status === "processed" ? { processedAt: new Date() } : {}),
      },
    });
    if (evt.status === "received") await enqueueEvent(evt.id, deps);
    return { id: evt.id, duplicate: false };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const existing = await systemDb.emailBusinessEvent.findUnique({ where: { workspaceId_source_externalId: { workspaceId: input.workspaceId, source: input.source, externalId: input.externalId } }, select: { id: true } });
    return { id: existing?.id ?? "", duplicate: true };
  }
}

export async function enqueueEvent(eventId: string, deps: Pick<EmailDeps, "queues">) {
  try {
    await deps.queues.email.send({ kind: "email_event", eventId });
  } catch (err) {
    // The sweep re-queues events that stay "received".
    logger.warn({ err, eventId }, "could not queue an email event; the sweep will pick it up");
  }
}

const ORDER_TOPICS: Record<string, string> = {
  "orders/create": "order.created",
  "orders/paid": "order.paid",
  "orders/cancelled": "order.cancelled",
  "orders/fulfilled": "order.fulfilled",
};

const checkoutKey = (storeId: string, token: string) => `checkout:${storeId}:${token}`;

/** A checkout that turned into an order (or completed) is no longer a candidate for abandonment. */
async function stopWatchingCheckout(store: Pick<Store, "id" | "workspaceId">, token: unknown) {
  if (typeof token !== "string" || !token) return;
  await systemDb.emailBusinessEvent.updateMany({
    where: { workspaceId: store.workspaceId, source: "shopify", externalId: checkoutKey(store.id, token), status: "pending_detection" },
    data: { status: "cancelled", detectAfter: null, payloadEnc: null, processedAt: new Date() },
  });
}

/** Apply a verified Shopify webhook to email automations. A no-op unless an automation listens. */
export async function emailOnShopifyEvent(store: Store, topic: string, payload: unknown, deps: Pick<EmailDeps, "queues">): Promise<void> {
  if (store.status === "uninstalled") return;
  const p = (payload ?? {}) as Payload;
  const orderEvent = ORDER_TOPICS[topic];
  if (orderEvent) {
    if (topic === "orders/create") await stopWatchingCheckout(store, p.checkout_token);
    if (!p.id || !(await listening(store.workspaceId, orderEvent, store.id))) return;
    await recordEvent(
      {
        workspaceId: store.workspaceId,
        storeId: store.id,
        source: "shopify",
        eventType: orderEvent,
        externalId: `${store.id}:order:${p.id}:${orderEvent}`,
        occurredAt: new Date(p.cancelled_at ?? p.processed_at ?? p.updated_at ?? p.created_at ?? Date.now()),
        data: normalizeShopifyOrder(store, p),
      },
      deps,
    );
    return;
  }
  if (topic !== "checkouts/create" && topic !== "checkouts/update") return;
  const token = typeof p.token === "string" ? p.token : null;
  if (!token) return;
  if (p.completed_at) return stopWatchingCheckout(store, token);
  if (!(await listening(store.workspaceId, "checkout.abandoned", store.id))) return;
  const data = normalizeShopifyCheckout(store, p);
  const lastActivity = new Date(p.updated_at ?? p.created_at ?? Date.now());
  const detectAfter = new Date(Math.max(lastActivity.getTime(), Date.now() - 5 * 60_000) + CHECKOUT_ABANDON_MINUTES * 60_000);
  const externalId = checkoutKey(store.id, token);
  const existing = await systemDb.emailBusinessEvent.findUnique({ where: { workspaceId_source_externalId: { workspaceId: store.workspaceId, source: "shopify", externalId } } });
  if (existing) {
    // Still being watched: the latest cart and a later deadline. Already decided: leave it.
    if (existing.status !== "pending_detection") return;
    await systemDb.emailBusinessEvent.updateMany({
      where: { id: existing.id, status: "pending_detection" },
      data: {
        payloadEnc: seal(JSON.stringify(data), AAD.eventPayload(store.workspaceId, "shopify", externalId)),
        recipientHash: typeof data.customer === "object" && data.customer && "email" in data.customer ? recipientHash(store.workspaceId, String((data.customer as { email: string }).email)) : null,
        occurredAt: lastActivity,
        detectAfter,
      },
    });
    return;
  }
  await recordEvent({ workspaceId: store.workspaceId, storeId: store.id, source: "shopify", eventType: "checkout.abandoned", externalId, occurredAt: lastActivity, data, status: "pending_detection", detectAfter }, deps);
}

/** Sweep: checkouts whose deadline passed with no order are abandoned now. */
export async function promoteAbandonedCheckouts(deps: Pick<EmailDeps, "queues">, now = new Date()): Promise<number> {
  const due = await systemDb.emailBusinessEvent.findMany({ where: { status: "pending_detection", detectAfter: { lte: now } }, select: { id: true }, take: 200 });
  let n = 0;
  for (const { id } of due) {
    const { count } = await systemDb.emailBusinessEvent.updateMany({ where: { id, status: "pending_detection" }, data: { status: "received", occurredAt: now } });
    if (count) {
      n++;
      await enqueueEvent(id, deps);
    }
  }
  return n;
}

/** POST /api/v1/events: one custom event from the business's own systems. */
export async function ingestCustomEvent(workspaceId: string, input: IngestEvent, deps: Pick<EmailDeps, "queues">): Promise<{ id: string; duplicate: boolean; listening: boolean }> {
  if (!isCustomEventType(input.type)) {
    throw new EmailError(`"${input.type}" isn't a valid custom event type. Use two to four lowercase dotted parts (like appointment.booked); order.* and checkout.* come from Shopify.`, 400, "invalid_event_type");
  }
  const problems = customDataProblems(input.data);
  if (problems.length) throw new EmailError(`data: ${problems[0]}`, 400, "invalid_data", { problems });
  let email: string | null = null;
  if (input.customer?.email !== undefined && input.customer.email !== "") {
    email = normalizeEmail(input.customer.email);
    if (!email) throw new EmailError("customer.email isn't a valid email address", 400, "invalid_email");
  }
  const occurredAt = input.occurred_at ? new Date(input.occurred_at) : new Date();
  if (occurredAt.getTime() > Date.now() + 5 * 60_000) throw new EmailError("occurred_at is in the future", 400, "invalid_time");
  const data: EventData = {
    customer: {
      ...(email ? { email } : {}),
      ...(input.customer?.first_name ? { first_name: input.customer.first_name.trim() } : {}),
      ...(input.customer?.last_name ? { last_name: input.customer.last_name.trim() } : {}),
      accepts_marketing: input.customer?.accepts_marketing === true,
    },
    data: (input.data ?? {}) as Record<string, unknown>,
  };
  const on = await listening(workspaceId, input.type, null);
  const r = await recordEvent({ workspaceId, source: "api", eventType: input.type, externalId: input.id, occurredAt, data: on ? data : null, status: on ? "received" : "processed" }, deps);
  return { ...r, listening: on };
}

/** GDPR customers/redact: the customer's events and the messages sent to them, for this store. */
export async function redactEmailCustomer(store: Pick<Store, "id" | "workspaceId">, email: string | null | undefined): Promise<number> {
  const normalized = normalizeEmail(email);
  if (!normalized) return 0;
  const hash = recipientHash(store.workspaceId, normalized);
  const events = await systemDb.emailBusinessEvent.deleteMany({ where: { workspaceId: store.workspaceId, storeId: store.id, recipientHash: hash } });
  const messages = await systemDb.emailMessage.deleteMany({ where: { workspaceId: store.workspaceId, storeId: store.id, recipientHash: hash } });
  return events.count + messages.count;
}

/** shop/redact: everything about the store's customers in the email module. Rules stay (they hold no customer data). */
export async function purgeEmailStoreData(storeId: string): Promise<number> {
  const events = await systemDb.emailBusinessEvent.deleteMany({ where: { storeId } });
  const messages = await systemDb.emailMessage.deleteMany({ where: { storeId } });
  await systemDb.emailAutomationRule.updateMany({ where: { storeId, enabled: true }, data: { enabled: false } });
  return events.count + messages.count;
}

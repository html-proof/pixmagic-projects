/**
 * Shopify's mandatory customers/data_request: a customer asked the store what it holds about them,
 * and Shopify asks every app with access to that customer's data to give it to the store owner.
 * The webhook records the request (`recordDataRequest`); the owner downloads the export from
 * Settings → Privacy requests (`customerDataExport`), compiled from the live records at that
 * moment, so nothing about the customer is copied or kept beyond the records themselves.
 *
 * What bizinsights can hold about one customer, and how each is found:
 *  - analytics: orders linked by the keyed customer hash, plus the orders the request names;
 *    no name, email or address is stored with them;
 *  - WhatsApp (when the store uses it): the contact (number, first name, consent), the messages
 *    sent to it, its parcel tracking and reviews, its abandoned checkouts;
 *  - email automations: messages sent to the address and the store events recorded for it.
 */
import { systemDb, type DataRequest, type Store, type Tx } from "@app/db";
import { normalizePhone } from "@app/shared";
import { normalizeEmail } from "@app/shared/email";
import { customerKey } from "./persist.js";
import { contactFirstName, contactWaId, phoneHash, waDecrypt } from "./whatsapp/store.js";
import { isUniqueViolation, recipientHash } from "./email/common.js";
import { smsExportFor } from "./sms/privacy.js";

export interface DataRequestInput {
  /** Shopify's id for the request (data_request.id). */
  requestId: string;
  customerId?: string | null;
  email?: string | null;
  phone?: string | null;
  ordersRequested?: string[];
}

/**
 * Record a data request, once per Shopify request id (webhooks arrive at least once). `created`
 * is false for a redelivery, so the caller tells the owner only once.
 */
export async function recordDataRequest(store: Pick<Store, "id" | "workspaceId">, input: DataRequestInput): Promise<{ request: DataRequest; created: boolean }> {
  const where = { storeId_shopifyRequestId: { storeId: store.id, shopifyRequestId: input.requestId } };
  const existing = await systemDb.dataRequest.findUnique({ where });
  if (existing) return { request: existing, created: false };
  const phone = normalizePhone(input.phone ?? null, null);
  const email = normalizeEmail(input.email);
  try {
    const request = await systemDb.dataRequest.create({
      data: {
        workspaceId: store.workspaceId,
        storeId: store.id,
        shopifyRequestId: input.requestId,
        customerId: input.customerId ?? null,
        customerKey: input.customerId ? customerKey(store, input.customerId) : null,
        phoneHash: phone ? phoneHash(store.id, phone.waId) : null,
        emailHash: email ? recipientHash(store.workspaceId, email) : null,
        ordersRequested: input.ordersRequested ?? [],
      },
    });
    return { request, created: true };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    return { request: await systemDb.dataRequest.findUniqueOrThrow({ where }), created: false };
  }
}

const money = (d: { toString(): string } | null | undefined) => (d == null ? null : d.toString());
/** A secret field that can no longer be read (a retired key) is reported as such, not dropped. */
function reveal(read: () => string | null): string | null {
  try {
    return read();
  } catch {
    return "[could not be decrypted]";
  }
}

/**
 * Everything bizinsights holds about the customer `request` names, for the store owner to pass
 * on. Runs in the workspace's tenant transaction (`withTenant`), so RLS confines every read to it.
 */
export async function customerDataExport(tx: Tx, request: DataRequest) {
  const { workspaceId, storeId } = request;
  const store = await tx.store.findFirst({ where: { id: storeId, workspaceId }, select: { shopDomain: true, name: true } });

  const orderMatch = [
    ...(request.customerKey ? [{ customerKey: request.customerKey }] : []),
    ...(request.ordersRequested.length ? [{ shopifyId: { in: request.ordersRequested } }] : []),
  ];
  const orders = orderMatch.length
    ? await tx.order.findMany({
        where: { workspaceId, storeId, OR: orderMatch },
        orderBy: { shopifyCreatedAt: "asc" },
        include: { lineItems: { select: { title: true, sku: true, quantity: true, price: true, discount: true } } },
      })
    : [];

  const contactMatch = [
    ...(request.customerKey ? [{ customerKey: request.customerKey }] : []),
    ...(request.phoneHash ? [{ phoneHash: request.phoneHash }] : []),
  ];
  const contacts = contactMatch.length ? await tx.whatsappContact.findMany({ where: { workspaceId, storeId, OR: contactMatch } }) : [];
  const contactIds = contacts.map((c) => c.id);
  const orderIds = [...new Set([...orders.map((o) => o.shopifyId), ...request.ordersRequested])];
  const trackings =
    contactIds.length || orderIds.length
      ? await tx.orderTracking.findMany({
          where: { workspaceId, storeId, OR: [{ contactId: { in: contactIds } }, { shopifyOrderId: { in: orderIds } }] },
          select: { id: true },
        })
      : [];
  const trackingIds = trackings.map((t) => t.id);
  const [messages, checkouts, reviews] = await Promise.all([
    contactIds.length || trackingIds.length
      ? tx.whatsappMessage.findMany({
          where: { workspaceId, storeId, OR: [{ contactId: { in: contactIds } }, { trackingId: { in: trackingIds } }] },
          orderBy: { createdAt: "asc" },
        })
      : [],
    contactIds.length ? tx.abandonedCheckout.findMany({ where: { workspaceId, storeId, contactId: { in: contactIds } }, orderBy: { checkoutCreatedAt: "asc" } }) : [],
    trackingIds.length ? tx.customerReview.findMany({ where: { workspaceId, storeId, trackingId: { in: trackingIds } }, orderBy: { submittedAt: "asc" } }) : [],
  ]);

  const [emailMessages, emailEvents] = request.emailHash
    ? await Promise.all([
        tx.emailMessage.findMany({ where: { workspaceId, storeId, recipientHash: request.emailHash }, orderBy: { createdAt: "asc" } }),
        tx.emailBusinessEvent.findMany({ where: { workspaceId, storeId, recipientHash: request.emailHash }, orderBy: { occurredAt: "asc" } }),
      ])
    : [[], []];

  return {
    about:
      "Data bizinsights holds about one of your store's customers, as of the time this file was made, for you to pass on to the customer. " +
      "Order records hold no name, email or address: they are linked to the customer only by a keyed hash.",
    generatedAt: new Date().toISOString(),
    store: store ? { domain: store.shopDomain, name: store.name } : null,
    request: {
      shopifyRequestId: request.shopifyRequestId,
      receivedAt: request.receivedAt.toISOString(),
      customerId: request.customerId,
      ordersRequested: request.ordersRequested,
    },
    orders: orders.map((o) => ({
      shopifyId: o.shopifyId,
      name: o.name,
      createdAt: o.shopifyCreatedAt.toISOString(),
      cancelledAt: o.cancelledAt?.toISOString() ?? null,
      currency: o.currency,
      subtotal: money(o.subtotal),
      discounts: money(o.totalDiscounts),
      tax: money(o.totalTax),
      shipping: money(o.totalShipping),
      total: money(o.totalPrice),
      financialStatus: o.financialStatus,
      fulfillmentStatus: o.fulfillmentStatus,
      discountCodes: o.discountCodes,
      salesChannel: o.sourceName,
      trafficSource: o.trafficSource,
      trafficMedium: o.trafficMedium,
      trafficCampaign: o.trafficCampaign,
      referrerHost: o.referrerHost,
      lineItems: o.lineItems.map((l) => ({ title: l.title, sku: l.sku, quantity: l.quantity, price: money(l.price), discount: money(l.discount) })),
    })),
    whatsapp: {
      contacts: contacts.map((c) => ({
        phone: reveal(() => contactWaId(c)),
        firstName: reveal(() => contactFirstName(c)),
        country: c.country,
        marketing: c.marketingStatus,
        marketingSource: c.marketingSource,
        marketingUpdatedAt: c.marketingUpdatedAt?.toISOString() ?? null,
        optedOut: c.optedOut,
        optedOutAt: c.optedOutAt?.toISOString() ?? null,
        lastMessageFromCustomerAt: c.lastInboundAt?.toISOString() ?? null,
        firstSeenAt: c.createdAt.toISOString(),
      })),
      messages: messages.map((m) => ({
        kind: m.kind,
        template: m.templateName,
        order: m.orderName,
        status: m.status,
        to: m.phoneMasked,
        scheduledFor: m.scheduledFor.toISOString(),
        sentAt: m.sentAt?.toISOString() ?? null,
        deliveredAt: m.deliveredAt?.toISOString() ?? null,
        readAt: m.readAt?.toISOString() ?? null,
      })),
      abandonedCheckouts: checkouts.map((a) => ({
        startedAt: a.checkoutCreatedAt.toISOString(),
        lastActivityAt: a.lastActivityAt.toISOString(),
        customerName: a.customerNameEnc ? reveal(() => waDecrypt(a.storeId, "name", a.customerNameEnc!)) : null,
        phone: a.phoneMasked,
        items: a.items,
        currency: a.currency,
        total: money(a.totalPrice),
        marketingConsent: a.marketingConsent,
        status: a.status,
        recoveredOrder: a.recoveredOrderName,
      })),
      reviews: reviews.map((r) => ({
        order: r.orderName,
        product: r.productTitle,
        rating: r.rating,
        text: r.body,
        reviewerName: r.reviewerName,
        status: r.status,
        submittedAt: r.submittedAt.toISOString(),
      })),
    },
    email: {
      messages: emailMessages.map((m) => ({
        kind: m.kind,
        subject: m.subject,
        to: m.recipientMasked,
        status: m.status,
        sentAt: (m.providerAcceptedAt ?? m.createdAt).toISOString(),
        deliveredAt: m.deliveredAt?.toISOString() ?? null,
      })),
      events: emailEvents.map((e) => ({ type: e.eventType, source: e.source, occurredAt: e.occurredAt.toISOString(), status: e.status })),
    },
    sms: await smsExportFor(tx, workspaceId, storeId, { customerKey: request.customerKey, customerId: request.customerId, ordersRequested: request.ordersRequested }),
  };
}

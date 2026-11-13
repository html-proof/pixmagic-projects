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
 *  - WhatsApp Automation (when the store uses it): the contact (number, first name, consent and its
 *    history), the messages to and from it; and how many records the earlier WhatsApp feature's
 *    tables still hold about them, until those are dropped.
 */
import { systemDb, type DataRequest, type Store, type Tx } from "@app/db";
import { normalizePhone } from "@app/shared";
import { customerKey } from "./persist.js";
import { waPhoneHash } from "./whatsapp/common.js";
import { whatsappExportFor } from "./whatsapp/privacy.js";

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
  try {
    const request = await systemDb.dataRequest.create({
      data: {
        workspaceId: store.workspaceId,
        storeId: store.id,
        shopifyRequestId: input.requestId,
        customerId: input.customerId ?? null,
        customerKey: input.customerId ? customerKey(store, input.customerId) : null,
        phoneHash: phone ? waPhoneHash(store.id, phone.waId) : null,
        ordersRequested: input.ordersRequested ?? [],
      },
    });
    return { request, created: true };
  } catch (err) {
    if ((err as { code?: unknown }).code !== "P2002") throw err;
    return { request: await systemDb.dataRequest.findUniqueOrThrow({ where }), created: false };
  }
}

const money = (d: { toString(): string } | null | undefined) => (d == null ? null : d.toString());

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

  const whatsapp = await whatsappExportFor(tx, workspaceId, storeId, { phoneHash: request.phoneHash, customerId: request.customerId });

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
    whatsapp,
  };
}

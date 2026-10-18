/**
 * Shipment poll: Shopify's carrier status for parcels on their way, for stores whose webhooks
 * don't carry tracking updates (that needs the read_fulfillments scope). read_orders is enough here.
 */
import { systemDb, type Store } from "@app/db";
import { SHIPMENT_RANK, shipmentStage } from "@app/shared";
import { env } from "../../env.js";
import { shopifyGraphql } from "../../shopify.js";
import { graphqlShipmentOrderSchema, graphqlShipmentSchema, parseShopifyList } from "../../shopifyPayloads.js";
import { getAccessToken } from "../../tokens.js";
import type { WaDeps } from "../messages.js";
import { storeWhatsapp } from "../store.js";
import { contactOf, date, type Ctx } from "./context.js";
import { applyStage } from "./orders.js";

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
  const data = await shopifyGraphql<{ nodes: unknown[] | null }>({
    shop: store.shopDomain,
    accessToken: token,
    apiVersion: env().SHOPIFY_API_VERSION,
    query: SHIPMENTS_QUERY,
    variables: { ids: open.map((t) => `gid://shopify/Order/${t.shopifyOrderId}`) },
    fetchImpl: deps.fetchImpl,
    maxRetries: 1,
  });
  // A deleted order comes back as null: nothing to follow.
  const orders = parseShopifyList(graphqlShipmentOrderSchema, (data.nodes ?? []).filter((n) => n !== null), "GraphQL shipments", { storeId: store.id });
  for (const node of orders) {
    const t = open.find((o) => o.shopifyOrderId === gidId(node.id));
    if (!t) continue;
    const contact = await contactOf(t);
    for (const f of parseShopifyList(graphqlShipmentSchema, node.fulfillments ?? [], "GraphQL fulfillment", { storeId: store.id, orderId: t.shopifyOrderId })) {
      if (String(f.status).toUpperCase() !== "SUCCESS") continue;
      const stage = shipmentStage(f.displayStatus);
      if (!stage || stage === "shipped") continue;
      const info = f.trackingInfo?.[0];
      const at = stage === "delivered" && f.deliveredAt ? date(f.deliveredAt) : stage === "in_transit" && f.inTransitAt ? date(f.inTransitAt) : date(f.updatedAt);
      const current = await systemDb.orderTracking.findUniqueOrThrow({ where: { id: t.id } });
      await applyStage(ctx, current, contact, {
        fulfillmentId: gidId(f.id),
        stage,
        at,
        source: "carrier",
        courier: info?.company ?? null,
        trackingNumber: info?.number ?? null,
        trackingUrl: info?.url ?? null,
        estimatedDeliveryAt: f.estimatedDeliveryAt ? date(f.estimatedDeliveryAt) : null,
      });
    }
  }
  return open.length;
}

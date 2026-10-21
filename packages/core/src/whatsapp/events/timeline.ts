/**
 * The order timeline: each event recorded once, and the status the tracking page shows from it.
 */
import { Prisma, systemDb, type OrderTracking } from "@app/db";
import { SHIPMENT_RANK, type TrackingStatus } from "@app/shared";

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
export async function addEvent(t: OrderTracking, e: EventInput): Promise<boolean> {
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

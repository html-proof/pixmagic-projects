/**
 * Erasing a store (shop/redact, a workspace deleted): every WhatsApp record of the store, as Prisma
 * operations for persist.ts purgeStoreData's one transaction, and the retired module's token at Nango.
 * Its own module, importing nothing but the database (and env and the logger), so persist.ts can use
 * it without importing the rest of WhatsApp.
 */
import { systemDb } from "@app/db";
import { env } from "../env.js";
import { logger } from "../logger.js";
import type { FetchLike } from "../shopify.js";

/** Every WhatsApp Automation record of the store (the wapp_* tables). The provider's instance goes first (connection.ts dropStoreInstance). */
export function purgeWhatsappStoreOps(storeId: string) {
  return [
    systemDb.wappMessageEvent.deleteMany({ where: { storeId } }),
    systemDb.wappMessage.deleteMany({ where: { storeId } }),
    systemDb.wappWebhookEvent.deleteMany({ where: { storeId } }),
    systemDb.wappAutomationRun.deleteMany({ where: { storeId } }),
    systemDb.wappAutomation.deleteMany({ where: { storeId } }),
    systemDb.wappCampaign.deleteMany({ where: { storeId } }),
    systemDb.wappConsentEvent.deleteMany({ where: { storeId } }),
    systemDb.wappContact.deleteMany({ where: { storeId } }),
    systemDb.wappSuppression.deleteMany({ where: { storeId } }),
    systemDb.wappTemplate.deleteMany({ where: { storeId } }),
    systemDb.wappSettings.deleteMany({ where: { storeId } }),
    systemDb.wappConnection.deleteMany({ where: { storeId } }),
  ];
}

/** Erasing a store: everything the retired tables hold of it, for persist.ts purgeStoreData's one transaction. */
export function purgeLegacyWhatsappOps(storeId: string) {
  return [
    systemDb.whatsappMessageEvent.deleteMany({ where: { storeId } }),
    systemDb.whatsappMessage.deleteMany({ where: { storeId } }),
    systemDb.whatsappContact.deleteMany({ where: { storeId } }),
    systemDb.customerReview.deleteMany({ where: { storeId } }),
    systemDb.orderTrackingEvent.deleteMany({ where: { storeId } }),
    systemDb.orderTracking.deleteMany({ where: { storeId } }),
    systemDb.abandonedCheckout.deleteMany({ where: { storeId } }),
    systemDb.whatsappCampaign.deleteMany({ where: { storeId } }),
    systemDb.whatsappAutomationRun.deleteMany({ where: { storeId } }),
    systemDb.whatsappAutomationRule.deleteMany({ where: { storeId } }),
    systemDb.whatsappTemplate.deleteMany({ where: { storeId } }),
    systemDb.whatsappConnection.deleteMany({ where: { storeId } }),
    systemDb.whatsappSettings.deleteMany({ where: { storeId } }),
    systemDb.waMessageEvent.deleteMany({ where: { storeId } }),
    systemDb.waMessage.deleteMany({ where: { storeId } }),
    systemDb.waWorkflowRun.deleteMany({ where: { storeId } }),
    systemDb.waWorkflow.deleteMany({ where: { storeId } }),
    systemDb.waCampaign.deleteMany({ where: { storeId } }),
    systemDb.waConsentEvent.deleteMany({ where: { storeId } }),
    systemDb.waContact.deleteMany({ where: { storeId } }),
    systemDb.waTemplate.deleteMany({ where: { storeId } }),
    systemDb.waSettings.deleteMany({ where: { storeId } }),
    systemDb.waConnection.deleteMany({ where: { storeId } }),
  ];
}

/**
 * Erasing a store: the retired module kept the store's Meta token at Nango (integration
 * `whatsapp-business`, connection `wa-<storeId>`); it goes too, best effort. Read before the rows go.
 */
export async function deleteRetiredNangoToken(storeId: string, fetchImpl: FetchLike): Promise<void> {
  const c = await systemDb.waConnection.findUnique({ where: { storeId }, select: { nangoConnectionId: true } });
  const id = c?.nangoConnectionId;
  const e = env();
  if (!id || !e.NANGO_SECRET_KEY) return;
  try {
    const res = await fetchImpl(`${e.NANGO_API_URL.replace(/\/+$/, "")}/connections/${encodeURIComponent(id)}?provider_config_key=whatsapp-business`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${e.NANGO_SECRET_KEY}` },
    });
    if (res.status >= 300 && res.status !== 404) logger.warn({ storeId, status: res.status }, "retired whatsapp token at Nango not deleted");
  } catch (err) {
    logger.warn({ err, storeId }, "retired whatsapp token at Nango not deleted");
  }
}

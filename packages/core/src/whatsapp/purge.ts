/**
 * Erasing a store (shop/redact, a workspace deleted): every WhatsApp record of the store, as Prisma
 * operations for persist.ts purgeStoreData's one transaction. Its own module, importing nothing but
 * the database, so persist.ts can use it without importing the rest of WhatsApp.
 */
import { systemDb } from "@app/db";

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

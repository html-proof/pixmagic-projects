import { withTenant, type Store, type WhatsappConnection, type WhatsappTemplate } from "@app/db";
import { env, manualVerifyToken, money, storeName } from "@app/core";
import { templateShape, type ParamSource, type TemplateComponent, type WhatsappConfig } from "@app/shared";
import { HttpError } from "../context.js";

/** Helpers shared by the merchant WhatsApp routes (whatsapp.ts, whatsappOps.ts). */

export async function waStore(ws: string, storeId: string): Promise<Store> {
  const store = await withTenant(ws, (tx) => tx.store.findFirst({ where: { id: storeId, workspaceId: ws } }));
  if (!store || store.status === "uninstalled") throw new HttpError(404, "Not found", "not_found");
  return store;
}

export const base = "/workspaces/:ws/stores/:storeId/whatsapp";

/** What the browser may see of a connection. The verify token only for managers of a manual connection. */
export function publicConnection(c: WhatsappConnection, manage: boolean) {
  return {
    id: c.id,
    mode: c.mode,
    businessId: c.businessId,
    wabaId: c.wabaId,
    wabaName: c.wabaName,
    phoneNumberId: c.phoneNumberId,
    displayPhoneNumber: c.displayPhoneNumber,
    verifiedName: c.verifiedName,
    nameStatus: c.nameStatus,
    qualityRating: c.qualityRating,
    messagingLimitTier: c.messagingLimitTier,
    registered: c.registered,
    status: c.status,
    lastError: c.lastError,
    webhookVerifiedAt: c.webhookVerifiedAt,
    lastWebhookAt: c.lastWebhookAt,
    lastSyncedAt: c.lastSyncedAt,
    connectedAt: c.createdAt,
    hasAppSecret: !!c.appSecretEnc,
    verifyToken: manage && c.mode === "manual" ? manualVerifyToken(c) : null,
  };
}

export function publicTemplate(t: WhatsappTemplate) {
  const shape = templateShape(t.components as unknown as TemplateComponent[]);
  return {
    id: t.id,
    name: t.name,
    language: t.language,
    category: t.category,
    status: t.status,
    rejectedReason: t.rejectedReason,
    qualityScore: t.qualityScore,
    components: t.components,
    shape,
    updatedAt: t.updatedAt,
  };
}

/** Example values for test sends and previews. */
export function sampleValues(store: Store, cfg: WhatsappConfig): Partial<Record<ParamSource, string>> {
  const app = env().APP_URL;
  return {
    customer_name: "Test",
    store_name: storeName(store),
    order_number: "#TEST-1001",
    order_total: money(49.99, store.currency),
    delivery_address: "1 Example Street, Sample City",
    tracking_url: `${app}/track?t=test-message-example-link`,
    tracking_token: "test-message-example-link",
    courier_name: "Test Courier",
    tracking_number: "TEST123456",
    carrier_tracking_url: `${app}/track?t=test-message-example-link`,
    estimated_delivery: new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10),
    review_url: `${app}/review?t=test-message-example-link`,
    review_token: "test-message-example-link",
    checkout_url: app,
    checkout_link_code: "testlink00",
    cart_total: money(49.99, store.currency),
    refund_amount: money(10, store.currency),
    campaign_url: app,
    campaign_link_code: "testlink00",
    discount_code: "TEST10",
    discount_percentage: "10",
    end_date: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10),
    occasion: "Special offers",
    support_contact: cfg.supportPhone || cfg.supportEmail || "the store",
  };
}

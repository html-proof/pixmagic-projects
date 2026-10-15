import { withTenant, type Store, type WhatsappConnection, type WhatsappTemplate } from "@app/db";
import { manualVerifyToken } from "@app/core";
import { templateShape, type TemplateComponent } from "@app/shared";
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
    /** Whether bizinsights knows the number's two-step verification PIN (POST .../pin shows it to owners and admins). */
    hasPin: !!c.pinEnc,
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

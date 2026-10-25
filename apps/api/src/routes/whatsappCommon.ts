/**
 * What the WhatsApp Automation routes share (whatsapp.ts, whatsappAutomation.ts): the store
 * lookup, who may do what, and the shapes the browser sees. Tokens, PINs, numbers in full and
 * Meta's raw answers are never in them; message contents and customers' names only for those who
 * may see contact information.
 */
import { withTenant, type Store, type WaConnection, type WaMessage, type WaTemplate } from "@app/db";
import { messagePreview, type WaSettingsView } from "@app/core";
import {
  allows,
  can,
  CONNECTION_STATUS_LABEL,
  QUALITY_LABEL,
  skipLabel,
  TEMPLATE_STATUS_LABEL,
  templateShape,
  templateTexts,
  tierLimit,
  WA_STATUS_LABEL,
  type TemplateComponent,
  type WaConnectionStatus,
  type WaMessageStatus,
} from "@app/shared";
import { HttpError, requireWorkspace, type Ctx, type Deps, type WorkspaceAccess } from "../context.js";

export const base = "/workspaces/:ws/stores/:storeId/whatsapp";

export async function waStore(ws: string, storeId: string): Promise<Store> {
  const store = await withTenant(ws, (tx) => tx.store.findFirst({ where: { id: storeId, workspaceId: ws } }));
  if (!store || store.status === "uninstalled") throw new HttpError(404, "Not found", "not_found");
  return store;
}

/** Reading WhatsApp Automation: anyone who sees campaigns. */
export const requireWaView = (c: Ctx, deps: Deps, ws: string) => requireWorkspace(c, deps, ws, "marketing.campaigns");

/** Changing what customers receive (templates, workflows, campaigns, settings, sends): the store's owners and admins, signed in themselves. */
export async function requireWaManage(c: Ctx, deps: Deps, ws: string): Promise<WorkspaceAccess & { user: NonNullable<WorkspaceAccess["user"]> }> {
  const a = await requireWorkspace(c, deps, ws, "stores:manage");
  if (!a.user || a.link) throw new HttpError(403, "You don't have permission to do that", "forbidden");
  return a as WorkspaceAccess & { user: NonNullable<WorkspaceAccess["user"]> };
}

/** Connecting and disconnecting the number: "Manage integrations", signed in themselves. */
export async function requireWaConnect(c: Ctx, deps: Deps, ws: string): Promise<WorkspaceAccess & { user: NonNullable<WorkspaceAccess["user"]> }> {
  const a = await requireWorkspace(c, deps, ws, "integrations.manage");
  if (!a.user || a.link) throw new HttpError(403, "You don't have permission to do that", "forbidden");
  return a as WorkspaceAccess & { user: NonNullable<WorkspaceAccess["user"]> };
}

/** Customers' numbers, names and what was said: "View contact information" too. */
export const seesContacts = (a: WorkspaceAccess) => allows(a.access, "customers.contact");

export function requireContacts(a: WorkspaceAccess) {
  if (!seesContacts(a)) throw new HttpError(403, "You don't have permission to see customers' contact details", "forbidden");
}

/** What the browser may know of each permission, so it shows only the buttons that work. */
export function waCan(a: WorkspaceAccess) {
  const signedIn = !!a.user && !a.link;
  return {
    connect: signedIn && allows(a.access, "integrations.manage"),
    manage: signedIn && allows(a.access, "stores:manage"),
    contacts: seesContacts(a),
    pin: signedIn && can(a.role, "stores:manage"),
  };
}

export function connectionView(c: WaConnection | null) {
  if (!c) return null;
  return {
    status: c.status as WaConnectionStatus,
    statusLabel: CONNECTION_STATUS_LABEL[c.status as WaConnectionStatus] ?? c.status,
    step: c.step,
    statusDetail: c.statusDetail,
    signupFlow: c.signupFlow,
    businessId: c.businessId,
    wabaId: c.wabaId,
    wabaName: c.wabaName,
    phoneNumberId: c.phoneNumberId,
    displayPhoneNumber: c.displayPhoneNumber,
    verifiedName: c.verifiedName,
    nameStatus: c.nameStatus,
    qualityRating: c.qualityRating,
    qualityLabel: c.qualityRating ? (QUALITY_LABEL[c.qualityRating] ?? c.qualityRating) : null,
    messagingLimitTier: c.messagingLimitTier,
    dailyConversationLimit: tierLimit(c.messagingLimitTier),
    registered: c.registered,
    subscribed: !!c.subscribedAt,
    hasPin: !!c.pinEnc,
    lastWebhookAt: c.lastWebhookAt,
    lastCheckedAt: c.lastCheckedAt,
    connectedAt: c.connectedAt,
    disconnectedAt: c.disconnectedAt,
  };
}

export function settingsJson(s: WaSettingsView) {
  return {
    orderUpdates: s.orderUpdates,
    orderUpdatesSetAt: s.orderUpdatesSetAt,
    shopifySmsConsent: s.shopifySmsConsent,
    sendWindow: s.sendWindow,
    dailyLimit: s.dailyLimit,
    testPhone: s.testPhoneMasked,
    eventKey: s.eventKey,
  };
}

export function templateView(t: WaTemplate, usedBy?: { workflows: number; campaigns: number }) {
  const components = t.components as unknown as TemplateComponent[];
  return {
    id: t.id,
    name: t.name,
    language: t.language,
    category: t.category,
    status: t.status,
    statusLabel: TEMPLATE_STATUS_LABEL[t.status] ?? t.status.toLowerCase(),
    rejectedReason: t.rejectedReason,
    qualityScore: t.qualityScore,
    components,
    shape: templateShape(components),
    texts: templateTexts(components),
    madeHere: !!t.createdByUserId,
    usedBy: usedBy ?? null,
    updatedAt: t.updatedAt,
  };
}

/** A message as the history shows it. Its text only for those who may see contact information. */
export function messageView(m: WaMessage, opts: { contacts: boolean }) {
  return {
    id: m.id,
    direction: m.direction as "out" | "in",
    source: m.source,
    type: m.type,
    templateName: m.templateName,
    templateLanguage: m.templateLanguage,
    category: m.category,
    status: m.status as WaMessageStatus,
    statusLabel: WA_STATUS_LABEL[m.status as WaMessageStatus] ?? m.status,
    reason: m.reason,
    reasonLabel: skipLabel(m.reason),
    errorCode: m.errorCode,
    errorTitle: m.errorTitle,
    phone: m.phoneMasked,
    contactId: opts.contacts ? m.contactId : null,
    preview: opts.contacts ? messagePreview(m) : null,
    workflowId: m.workflowId,
    campaignId: m.campaignId,
    createdAt: m.createdAt,
    sendAfter: m.sendAfter,
    acceptedAt: m.acceptedAt,
    sentAt: m.sentAt,
    deliveredAt: m.deliveredAt,
    readAt: m.readAt,
    failedAt: m.failedAt,
    attempts: m.attempts,
    canRetry: m.direction === "out" && m.status === "failed" && !!m.payloadEnc,
  };
}

import { systemDb, withTenant, type SmsMessageJob, type SmsSenderConfiguration, type SmsTemplate, type SmsTemplateVersion, type Store } from "@app/db";
import { noSmsProvider, smsDecrypt, type Actor, type SmsDeps } from "@app/core/sms";
import { allows } from "@app/shared";
import { DELIVERY_EXPLANATION, skipLabel, SMS_STAGE_LABEL, smsStage, type SmsStatus } from "@app/shared/sms";
import { clientIp, HttpError, requireWorkspace, type Ctx, type Deps, type WorkspaceAccess } from "../context.js";

/** Helpers shared by the Customer Messaging routes (sms.ts, smsOps.ts, smsActivity.ts). */

export const base = "/workspaces/:ws/stores/:storeId/sms";

/** See Customer Messaging (its pages, templates, rules, campaigns, figures). */
export const SMS_READ = "marketing.campaigns" as const;
/** Change what customers receive (sender, templates, rules, campaigns, approvals): owners and admins. */
export const SMS_MANAGE = "stores:manage" as const;

/** Lists showing customers' (masked) numbers and their consent also need "View contact information". */
export async function requireSmsContacts(c: Ctx, deps: Deps, ws: string): Promise<WorkspaceAccess> {
  const a = await requireWorkspace(c, deps, ws, SMS_READ);
  if (!allows(a.access, "customers.contact")) throw new HttpError(403, "You don't have permission to see customers' contact details", "forbidden");
  return a;
}

export async function smsStore(ws: string, storeId: string): Promise<Store> {
  const store = await withTenant(ws, (tx) => tx.store.findFirst({ where: { id: storeId, workspaceId: ws } }));
  if (!store || store.status === "uninstalled") throw new HttpError(404, "Not found", "not_found");
  return store;
}

export const actorOf = (c: Ctx, a: WorkspaceAccess): Actor => ({ userId: a.user?.id ?? null, ip: clientIp(c) });

/** Who did it, for histories: the member's name (or email), "A former member", or bizinsights itself. Never a user id. */
export async function actorNames(ids: Array<string | null | undefined>): Promise<(id: string | null | undefined) => string> {
  const wanted = [...new Set(ids.filter((x): x is string => !!x))];
  const users = wanted.length ? await systemDb.user.findMany({ where: { id: { in: wanted } }, select: { id: true, email: true, displayName: true } }) : [];
  const byId = new Map(users.map((u) => [u.id, u.displayName || u.email]));
  return (id) => (id ? (byId.get(id) ?? "A former member") : "bizinsights");
}

export const smsDeps = (deps: Deps): SmsDeps => ({ coord: deps.coord, queues: deps.queues, fetchImpl: deps.fetchImpl, mailer: deps.mailer, sms: deps.sms ?? noSmsProvider });

/** What the browser may see of a sender: no secrets exist, but the opt-out list and the origination ARN are the platform's, shown only to managers. */
export function publicSender(s: SmsSenderConfiguration, manage: boolean) {
  return {
    senderType: s.senderType,
    originationIdentity: manage ? s.originationIdentity : null,
    identityLabel: s.identityLabel,
    identityCountry: s.identityCountry,
    identityStatus: s.identityStatus,
    identityCheck: s.identityCheck,
    identityCheckedAt: s.identityCheckedAt,
    registrationStatus: s.registrationStatus,
    twoWay: s.twoWay,
    awsRegion: s.awsRegion,
    configurationSet: s.configurationSet,
    countries: s.countries,
    sendingEnabled: s.sendingEnabled,
    marketingEnabled: s.marketingEnabled,
    monthlyBudgetUsd: Number(s.monthlyBudgetUsd),
    hardStop: s.hardStop,
    monthlyMessageQuota: s.monthlyMessageQuota,
    transactionalBasis: s.transactionalBasis,
    transactionalBasisAt: s.transactionalBasisAt,
    quietStart: s.quietStart,
    quietEnd: s.quietEnd,
    maxPerCustomerDay: s.maxPerCustomerDay,
    maxMarketingPerWeek: s.maxMarketingPerWeek,
    dltEntityId: s.dltEntityId,
    heldUntil: s.heldUntil,
    heldReason: s.heldReason,
    updatedAt: s.updatedAt,
  };
}

export function publicVersion(v: SmsTemplateVersion) {
  return {
    version: v.version,
    category: v.category,
    body: v.body,
    dltTemplateId: v.dltTemplateId,
    dltText: v.dltText,
    encoding: v.encoding,
    segments: v.segments,
    status: v.status,
    reviewNote: v.reviewNote,
    createdBy: v.createdBy,
    createdAt: v.createdAt,
    submittedAt: v.submittedAt,
    approvedBy: v.approvedBy,
    approvedAt: v.approvedAt,
  };
}

export function publicTemplate(t: SmsTemplate & { versions?: SmsTemplateVersion[] }) {
  const latest = t.versions?.[0];
  const approved = t.versions?.find((v) => v.version === t.approvedVersion);
  return {
    id: t.id,
    name: t.name,
    category: t.category,
    status: t.status,
    latestVersion: t.latestVersion,
    approvedVersion: t.approvedVersion,
    countries: t.countries,
    body: latest?.body ?? null,
    approvedBody: approved?.body ?? null,
    latestStatus: latest?.status ?? null,
    segments: latest?.segments ?? null,
    encoding: latest?.encoding ?? null,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

/**
 * A message as the history shows it. Its text only to members who may see contact details (it
 * names the customer and the order) and only while it is kept (30 days after its outcome).
 */
export function publicMessage(m: SmsMessageJob, showText: boolean) {
  const status = m.status as SmsStatus;
  return {
    id: m.id,
    purpose: m.purpose,
    category: m.category,
    trigger: m.trigger,
    ruleId: m.ruleId,
    campaignId: m.campaignId,
    templateId: m.templateId,
    templateVersion: m.templateVersion,
    to: m.phoneMasked,
    country: m.destinationCountry,
    status,
    stage: smsStage(m),
    statusLabel: SMS_STAGE_LABEL[smsStage(m)],
    reason: m.reason,
    reasonLabel: skipLabel(m.reason),
    providerStatus: m.providerStatus,
    providerExplanation: m.providerStatus ? (DELIVERY_EXPLANATION[m.providerStatus.toUpperCase()] ?? null) : null,
    errorCode: m.errorCode,
    dryRun: m.dryRun,
    segments: m.segments,
    encoding: m.encoding,
    sendAfter: m.sendAfter,
    acceptedAt: m.acceptedAt,
    finalAt: m.finalAt,
    providerMessageId: m.providerMessageId,
    estimatedCostUsd: m.estimatedCostUsd === null ? null : Number(m.estimatedCostUsd),
    priceUsd: m.priceUsd === null ? null : Number(m.priceUsd) + Number(m.carrierFeeUsd ?? 0),
    partsBilled: m.partsBilled,
    attributedOrderId: m.attributedOrderId,
    attributedRevenue: m.attributedRevenue === null ? null : Number(m.attributedRevenue),
    attributedCurrency: m.attributedCurrency,
    attempts: m.attempts,
    createdAt: m.createdAt,
    text: showText && m.bodyEnc ? safeDecrypt(m.storeId, m.bodyEnc) : null,
  };
}

function safeDecrypt(storeId: string, enc: string): string | null {
  try {
    return smsDecrypt(storeId, "body", enc);
  } catch {
    return null;
  }
}

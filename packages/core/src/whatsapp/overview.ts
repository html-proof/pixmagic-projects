/**
 * What the WhatsApp Automation page shows about a store (docs/whatsapp.md, "The page"): the
 * connection as the provider last reported it, the four-step setup, automation as a whole, the
 * statistics (counted from the message records, never made up), what is waiting or held, recent
 * failures with their reasons, and the latest messages. Customers' messages' texts only for
 * people who may see contact information.
 */
import { systemDb, type Store, type WappConnection, type WappMessage } from "@app/db";
import {
  EVOLUTION_NOTICE,
  statusBucket,
  waAutomationState,
  waSetupProgress,
  waSkipLabel,
  WA_CONNECTION_LABEL,
  WA_MESSAGE_LABEL,
  WA_DAILY_LIMIT,
  type WaConnectionStatus,
  type WaMessageStatus,
  type WaProvider,
} from "@app/shared";
import { env } from "../env.js";
import { connectionOf, dailyLimitOf, settingsOf, waDecrypt, type WaSettingsView } from "./common.js";
import { statusReasonLabel } from "./connection.js";
import { evolutionConfigured } from "./evolution.js";
import { retiredConnection } from "./legacy.js";
import { sentToday } from "./messages.js";
import { automationProblemsFor } from "./automations.js";

/** What the Cloud API way of connecting still lacks on this server, by setting name (empty: it can be offered). */
export function cloudApiMissing(): string[] {
  const e = env();
  const appId = e.WHATSAPP_APP_ID || e.META_APP_ID;
  const secret = e.WHATSAPP_APP_SECRET || (!e.WHATSAPP_APP_ID || e.WHATSAPP_APP_ID === e.META_APP_ID ? e.META_APP_SECRET : "");
  return [
    !evolutionConfigured() ? "EVOLUTION_API_URL" : null,
    !appId ? "WHATSAPP_APP_ID" : null,
    !e.WHATSAPP_CONFIG_ID ? "WHATSAPP_CONFIG_ID" : null,
    !secret ? "WHATSAPP_APP_SECRET" : null,
    !e.WHATSAPP_WEBHOOK_VERIFY_TOKEN ? "WHATSAPP_WEBHOOK_VERIFY_TOKEN" : null,
  ].filter((x): x is string => !!x);
}

export function waConnectionView(c: WappConnection | null) {
  if (!c) return null;
  return {
    provider: c.provider as WaProvider,
    status: c.status as WaConnectionStatus,
    statusLabel: WA_CONNECTION_LABEL[c.status as WaConnectionStatus] ?? c.status,
    reason: statusReasonLabel(c.statusReason),
    pairingMethod: c.pairingMethod,
    phone: c.phoneMasked,
    profileName: c.profileName,
    wabaId: c.wabaId,
    phoneNumberId: c.phoneNumberId,
    qrCount: c.qrCount,
    pairingStartedAt: c.pairingStartedAt,
    connectedAt: c.connectedAt,
    disconnectedAt: c.disconnectedAt,
    downSince: c.downSince,
    lastEventAt: c.lastEventAt,
    lastCheckedAt: c.lastCheckedAt,
  };
}

export function waSettingsJson(s: WaSettingsView) {
  return {
    businessName: s.businessName,
    orderUpdates: s.orderUpdates,
    orderUpdatesSetAt: s.orderUpdatesSetAt,
    marketingEnabled: s.marketingEnabled,
    shopifySmsConsent: s.shopifySmsConsent,
    sendWindow: s.sendWindow,
    timeZone: s.timeZone,
    timeZoneSet: s.timeZoneSet,
    dailyLimit: s.dailyLimit,
    perCustomerDailyLimit: s.perCustomerDailyLimit,
    retentionDays: s.retentionDays,
    configuredAt: s.configuredAt,
    testPhone: s.testPhoneMasked,
    testVerifiedAt: s.testVerifiedAt,
    testPassedAt: s.testPassedAt,
    testCodeExpiresAt: s.testCodeExpiresAt,
    automationPausedAt: s.automationPausedAt,
  };
}

/** A message as the history shows it. Its text only for those who may see contact information. */
export function waMessageView(m: WappMessage, opts: { contacts: boolean }) {
  let preview: string | null = null;
  if (opts.contacts && m.previewEnc) {
    try {
      preview = waDecrypt(m.storeId, "preview", m.previewEnc);
    } catch {
      preview = null;
    }
  }
  return {
    id: m.id,
    direction: m.direction as "out" | "in",
    source: m.source,
    category: m.category,
    type: m.type,
    status: m.status as WaMessageStatus,
    statusLabel: WA_MESSAGE_LABEL[m.status as WaMessageStatus] ?? m.status,
    reason: m.reason,
    reasonLabel: waSkipLabel(m.reason),
    errorCode: m.errorCode,
    errorDetail: m.errorDetail,
    providerMessageId: m.providerMessageId,
    phone: m.phoneMasked,
    contactId: opts.contacts ? m.contactId : null,
    preview,
    automationId: m.automationId,
    campaignId: m.campaignId,
    templateId: m.templateId,
    attempts: m.attempts,
    createdAt: m.createdAt,
    sendAfter: m.sendAfter,
    acceptedAt: m.acceptedAt,
    sentAt: m.sentAt,
    deliveredAt: m.deliveredAt,
    readAt: m.readAt,
    failedAt: m.failedAt,
    canRetry: m.direction === "out" && m.status === "failed" && m.source !== "verification" && (!!m.payloadEnc || (m.type === "text" && !!m.previewEnc)),
  };
}

/** Counts of the store's messages since `since`, by what reached whom. */
async function stats(storeId: string, since: Date) {
  const rows = await systemDb.wappMessage.groupBy({ by: ["status", "direction"], where: { storeId, createdAt: { gte: since } }, _count: { _all: true } });
  const out = { waiting: 0, sent: 0, delivered: 0, read: 0, failed: 0, notSent: 0, received: 0 };
  for (const r of rows) {
    const b = r.direction === "in" ? "received" : statusBucket(r.status);
    const n = r._count._all;
    if (b === "waiting") out.waiting += n;
    else if (b === "sent") out.sent += n;
    else if (b === "delivered") out.delivered += n;
    else if (b === "read") out.read += n;
    else if (b === "failed") out.failed += n;
    else if (b === "received") out.received += n;
    else out.notSent += n;
  }
  const reached = out.sent + out.delivered + out.read + out.failed;
  return {
    ...out,
    /** Of the messages WhatsApp took, the share it reported delivered (or read); null with none yet. */
    deliveryRate: reached ? (out.delivered + out.read) / reached : null,
    readRate: reached ? out.read / reached : null,
  };
}

export async function whatsappOverview(store: Store, opts: { contacts: boolean }) {
  const now = Date.now();
  const [conn, settings, retired] = await Promise.all([connectionOf(store.id), settingsOf(store), retiredConnection(store.id)]);
  const automations = await systemDb.wappAutomation.findMany({ where: { storeId: store.id }, orderBy: { createdAt: "asc" } });
  const active = automations.filter((a) => a.status === "active");
  const blocked: Array<{ id: string; name: string; problems: string[] }> = [];
  for (const a of active) {
    const problems = await automationProblemsFor(store, a);
    if (problems.length) blocked.push({ id: a.id, name: a.name, problems });
  }
  const setup = waSetupProgress({
    provider: (conn && conn.status !== "disconnected" ? (conn.provider as WaProvider) : null) ?? null,
    status: (conn?.status as WaConnectionStatus) ?? null,
    configuredAt: settings.configuredAt,
    orderUpdates: settings.orderUpdates,
    testVerifiedAt: settings.testVerifiedAt,
    testPassedAt: settings.testPassedAt,
  });
  const connected = conn?.status === "connected";
  const [week, month, waiting, held, failures, recent, lastEvent, templates, campaigns] = await Promise.all([
    stats(store.id, new Date(now - 7 * 86_400_000)),
    stats(store.id, new Date(now - 30 * 86_400_000)),
    systemDb.wappMessage.count({ where: { storeId: store.id, direction: "out", status: { in: ["queued", "sending"] } } }),
    systemDb.wappMessage.groupBy({ by: ["reason"], where: { storeId: store.id, direction: "out", status: "queued", reason: { not: null } }, _count: { _all: true } }),
    systemDb.wappMessage.groupBy({ by: ["reason", "errorCode"], where: { storeId: store.id, direction: "out", status: "failed", createdAt: { gte: new Date(now - 7 * 86_400_000) } }, _count: { _all: true } }),
    systemDb.wappMessage.findMany({ where: { storeId: store.id }, orderBy: { createdAt: "desc" }, take: 8 }),
    systemDb.wappWebhookEvent.findFirst({ where: { storeId: store.id }, orderBy: { receivedAt: "desc" }, select: { receivedAt: true } }),
    systemDb.wappTemplate.count({ where: { storeId: store.id, active: true } }),
    systemDb.wappCampaign.groupBy({ by: ["status"], where: { storeId: store.id }, _count: { _all: true } }),
  ]);
  const provider = (conn?.provider as WaProvider) ?? "qr";
  return {
    store: { id: store.id, name: store.name ?? store.shopDomain, timezone: store.timezone },
    platform: { evolution: evolutionConfigured(), cloudApi: { missing: cloudApiMissing() } },
    connection: waConnectionView(conn),
    settings: waSettingsJson(settings),
    setup,
    automation: {
      state: waAutomationState({ connected, paused: !!settings.automationPausedAt, setupDone: !setup.current, active: active.length, blocked: blocked.length }),
      total: automations.length,
      active: active.length,
      testMode: active.filter((a) => a.testMode).length,
      blocked,
    },
    templates: { active: templates },
    campaigns: Object.fromEntries(campaigns.map((c) => [c.status, c._count._all])),
    stats: { week, month },
    limits: {
      dailyLimit: dailyLimitOf(settings, provider),
      dailyMax: WA_DAILY_LIMIT[provider].max,
      sentToday: await sentToday(store.id, settings.timeZone),
    },
    queue: {
      waiting,
      held: held.map((h) => ({ reason: h.reason, label: waSkipLabel(h.reason), count: h._count._all })),
      failures: failures
        .sort((a, b) => b._count._all - a._count._all)
        .slice(0, 5)
        .map((f) => ({ reason: f.reason, label: waSkipLabel(f.reason), errorCode: f.errorCode, count: f._count._all })),
    },
    health: {
      lastWebhookAt: lastEvent?.receivedAt ?? null,
      lastEventAt: conn?.lastEventAt ?? null,
      lastCheckedAt: conn?.lastCheckedAt ?? null,
    },
    recent: recent.map((m) => waMessageView(m, opts)),
    retired,
    notice: EVOLUTION_NOTICE,
  };
}

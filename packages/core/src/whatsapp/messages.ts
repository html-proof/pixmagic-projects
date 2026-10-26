/**
 * The message queue and the sender (docs/whatsapp.md, "Sending").
 *
 * queueMessage makes one row per purpose (`idempotencyKey`, unique per store), so a Shopify retry,
 * a duplicate queue delivery, two automations firing together or a double press send once. The
 * row carries what the send needs (encrypted) and what the history shows (encrypted, cleared after
 * the store's retention).
 *
 * sendQueuedMessage (the whatsapp queue's wapp_send job) claims the row, then checks, in order:
 * the connection is up, automation isn't paused, the automation or campaign still runs (and an
 * automation switched to test mode sends nothing more to a customer), consent
 * (again: a customer may have replied STOP since), the sending hours, the store's daily limit, the
 * customer's daily limit, the pace of the linked phone. Then one call to Evolution API. Its answer
 * is recorded as "accepted": sent, delivered and read come only from WhatsApp's reports
 * (applyMessageStatus), never from the HTTP answer.
 */
import { systemDb, type Store, type WappConnection, type WappContact, type WappMessage } from "@app/db";
import {
  inSendWindow,
  isFinalStatus,
  localDay,
  maskPhone,
  messageStatusFromProvider,
  nextSendTime,
  QR_GAP_JITTER_MS,
  QR_MIN_GAP_MS,
  CLOUD_SENDS_PER_SECOND,
  startOfLocalDay,
  statusAfterReport,
  waConsentProblem,
  WA_MAX_SEND_ATTEMPTS,
  WA_RETRY_DELAYS_S,
  type NormalizedPhone,
  type WaMessageStatus,
  type WaSkipReason,
  type WaTemplateCategory,
} from "@app/shared";
import { providerDetail } from "../errors.js";
import { logger } from "../logger.js";
import { consentFacts, onDoNotMessageList } from "./contacts.js";
import { dailyLimitOf, DOWN_GRACE_MS, settingsOf, storeById, WA_MAX_QUEUE_DELAY_S, waDecrypt, waEncrypt, waPhoneHash, waQueue, WhatsappError, type WaDeps, type WaSettingsView } from "./common.js";
import { checkConnection, clientFor, instanceToken } from "./connection.js";
import { EvolutionError, isNotConnected } from "./evolution.js";

export type MessageSource = "automation" | "campaign" | "manual" | "test" | "verification" | "team_alert" | "reply";

/** What a send needs, encrypted on the row until the message is final. */
export interface MessagePayload {
  text: string;
  attachment?: { key: string; mime: string; name: string; kind: "image" | "document" } | null;
  /** Cloud API: the Meta template and its body's values, in order. */
  meta?: { name: string; language: string; params: string[] } | null;
}

export interface QueueInput {
  store: Pick<Store, "id" | "workspaceId">;
  conn: Pick<WappConnection, "id" | "provider"> | null;
  source: MessageSource;
  category: WaTemplateCategory;
  phone: NormalizedPhone;
  contactId?: string | null;
  payload: MessagePayload;
  templateId?: string | null;
  idempotencyKey: string;
  automationId?: string | null;
  runId?: string | null;
  campaignId?: string | null;
  createdByUserId?: string | null;
  sendAfter?: Date;
  /** Queued later by the caller (a campaign batch): not enqueued here. */
  noEnqueue?: boolean;
  /** What the history shows instead of the text (a verification code is never kept there). */
  preview?: string;
}

/** The longest text the history keeps of a message. */
const PREVIEW_MAX = 1000;

const previewOf = (p: MessagePayload) => [p.text, p.attachment ? `[${p.attachment.kind === "image" ? "Image" : "Document"}: ${p.attachment.name}]` : ""].filter(Boolean).join("\n").slice(0, PREVIEW_MAX);

/** Puts a message on the queue (or returns the one already made for the same purpose). */
export async function queueMessage(deps: Pick<WaDeps, "queues">, input: QueueInput): Promise<{ message: WappMessage; created: boolean }> {
  const existing = await systemDb.wappMessage.findUnique({ where: { storeId_idempotencyKey: { storeId: input.store.id, idempotencyKey: input.idempotencyKey } } });
  if (existing) return { message: existing, created: false };
  const sendAfter = input.sendAfter ?? new Date();
  let message: WappMessage;
  try {
    message = await systemDb.wappMessage.create({
      data: {
        workspaceId: input.store.workspaceId,
        storeId: input.store.id,
        connectionId: input.conn?.id ?? null,
        provider: input.conn?.provider ?? null,
        direction: "out",
        contactId: input.contactId ?? null,
        phoneHash: waPhoneHash(input.store.id, input.phone.waId),
        phoneEnc: waEncrypt(input.store.id, "phone", input.phone.e164),
        phoneMasked: maskPhone(input.phone.e164),
        source: input.source,
        automationId: input.automationId ?? null,
        runId: input.runId ?? null,
        campaignId: input.campaignId ?? null,
        idempotencyKey: input.idempotencyKey,
        category: input.category,
        type: input.payload.attachment ? input.payload.attachment.kind : "text",
        templateId: input.templateId ?? null,
        payloadEnc: waEncrypt(input.store.id, "payload", JSON.stringify(input.payload)),
        previewEnc: waEncrypt(input.store.id, "preview", input.preview ?? previewOf(input.payload)),
        status: "queued",
        sendAfter,
        createdByUserId: input.createdByUserId ?? null,
      },
    });
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") {
      return { message: await systemDb.wappMessage.findUniqueOrThrow({ where: { storeId_idempotencyKey: { storeId: input.store.id, idempotencyKey: input.idempotencyKey } } }), created: false };
    }
    throw e;
  }
  if (!input.noEnqueue) await enqueueIfDue(deps, message);
  return { message, created: true };
}

/** Hands a waiting message to the queue when it is due within SQS's delay; later ones are the sweep's. */
export async function enqueueIfDue(deps: Pick<WaDeps, "queues">, m: Pick<WappMessage, "id" | "sendAfter" | "status">): Promise<boolean> {
  if (m.status !== "queued") return false;
  const delay = Math.max(0, Math.ceil((m.sendAfter.getTime() - Date.now()) / 1000));
  if (delay > WA_MAX_QUEUE_DELAY_S) return false;
  await waQueue(deps.queues).send({ kind: "wapp_send", messageId: m.id }, { delaySeconds: delay });
  await systemDb.wappMessage.update({ where: { id: m.id }, data: { enqueuedAt: new Date() } });
  return true;
}

/** Ends a message without sending it (its attachment, if any, goes). */
async function finish(id: string, status: "skipped" | "cancelled" | "failed", reason: WaSkipReason, extra: { errorCode?: string | null; errorDetail?: string | null } = {}, deps?: Pick<WaDeps, "payloads">) {
  const m = await systemDb.wappMessage.update({
    where: { id },
    data: { status, reason, finalAt: new Date(), ...(status === "failed" ? { failedAt: new Date() } : {}), payloadEnc: null, errorCode: extra.errorCode ?? null, errorDetail: extra.errorDetail ?? null },
  });
  if (m.type !== "text") await dropAttachment(m, deps);
  return status;
}

/** Puts a message back to wait (a hold doesn't spend one of its tries). */
async function hold(deps: Pick<WaDeps, "queues">, id: string, until: Date, reason: WaSkipReason | null) {
  const m = await systemDb.wappMessage.update({ where: { id }, data: { status: "queued", sendAfter: until, reason, attempts: { decrement: 1 }, enqueuedAt: null } });
  await enqueueIfDue(deps, m);
  return "held" as const;
}

async function dropAttachment(m: Pick<WappMessage, "id">, deps?: Pick<WaDeps, "payloads">) {
  if (!deps) return;
  await deps.payloads.delete(`wapp-media/${m.id}`).catch(() => {});
}

/** Business-started messages (counted against the daily limits); a test, a verification code or a reply to a customer's message aren't. */
const counted = (source: string) => source === "automation" || source === "campaign" || source === "manual" || source === "team_alert";
/** Messages that keep to the sending hours: the ones nobody is waiting for at that moment. */
const timed = (source: string) => source === "automation" || source === "campaign" || source === "team_alert";
/** Messages to a customer, whose consent is checked again at the moment of sending. */
const toCustomer = (source: string) => source === "automation" || source === "campaign" || source === "manual" || source === "reply";

/** How many business-started messages the store sent today (its own day). */
export async function sentToday(storeId: string, timeZone: string, now = new Date()): Promise<number> {
  const since = startOfLocalDay(localDay(now, timeZone), timeZone);
  return systemDb.wappMessage.count({ where: { storeId, direction: "out", source: { in: ["automation", "campaign", "manual", "team_alert"] }, acceptedAt: { gte: since } } });
}

/** The reason consent stops this message now, if any. A customer who wrote in the last 24 hours may be answered. */
export async function consentBlock(contact: WappContact | null, category: WaTemplateCategory, settings: WaSettingsView, opts: { reply?: boolean } = {}): Promise<WaSkipReason | null> {
  if (!contact) return "unknown_contact";
  const facts = await consentFacts(contact, category);
  if (facts.optedOut) return "opted_out";
  if (facts.suppressed) return "suppressed";
  if (category === "transactional" && (opts.reply || (contact.lastInboundAt && Date.now() - contact.lastInboundAt.getTime() < 24 * 3600_000))) return null;
  return waConsentProblem(category, facts, settings);
}

/** One message to WhatsApp, after every check. Returns what happened (for the job's log). */
export async function sendQueuedMessage(deps: Pick<WaDeps, "queues" | "fetchImpl" | "coord" | "payloads" | "mailer">, messageId: string): Promise<string> {
  const now = new Date();
  // Claim it: one delivery of the job sends it, a duplicate delivery or a sweep finds it taken.
  const claimed = await systemDb.wappMessage.updateMany({ where: { id: messageId, status: "queued", sendAfter: { lte: new Date(now.getTime() + 60_000) } }, data: { status: "sending", attempts: { increment: 1 } } });
  if (!claimed.count) return "not_due";
  const m = await systemDb.wappMessage.findUniqueOrThrow({ where: { id: messageId } });
  const end = (status: "skipped" | "cancelled" | "failed", reason: WaSkipReason, extra: { errorCode?: string | null; errorDetail?: string | null } = {}) => finish(m.id, status, reason, extra, deps);
  const store = await storeById(m.storeId);
  const conn = await systemDb.wappConnection.findUnique({ where: { storeId: m.storeId } });
  if (!store || store.status === "uninstalled" || !conn || conn.status === "disconnected" || !conn.instanceName) return end("cancelled", "not_connected");
  if (m.connectionId && m.connectionId !== conn.id) return end("cancelled", "connection_changed");
  if (conn.status !== "connected") {
    if (conn.downSince && now.getTime() - conn.downSince.getTime() > DOWN_GRACE_MS) return end("cancelled", "not_connected");
    return hold(deps, m.id, new Date(now.getTime() + 10 * 60_000), "not_connected");
  }
  const settings = await settingsOf(store);

  if (m.source === "automation" && m.automationId) {
    const a = await systemDb.wappAutomation.findUnique({ where: { id: m.automationId }, select: { status: true, testMode: true } });
    if (!a || a.status !== "active") return end("cancelled", "automation_off");
    // Switched to "only you" (test mode) since this was queued for a customer: it never reaches them,
    // however it got here (a run racing the switch, a send held back to wait). Its messages to the
    // store's verified number (no contact) still go.
    if (a.testMode && m.contactId) return end("cancelled", "manual_cancel");
  }
  if (m.source === "campaign" && m.campaignId) {
    const c = await systemDb.wappCampaign.findUnique({ where: { id: m.campaignId }, select: { status: true } });
    if (!c || c.status !== "sending") return end("cancelled", "campaign_cancelled");
  }
  if ((m.source === "automation" || m.source === "campaign" || m.source === "team_alert") && settings.automationPausedAt) {
    if (now.getTime() - settings.automationPausedAt.getTime() > DOWN_GRACE_MS) return end("cancelled", "automation_paused");
    return hold(deps, m.id, new Date(now.getTime() + 3600_000), "automation_paused");
  }

  const contact = m.contactId ? await systemDb.wappContact.findUnique({ where: { id: m.contactId } }) : null;
  // An automation in test mode sends to the store's own verified number (no contact): no customer consent
  // applies. Nor does it to the one reply confirming a customer's STOP (inbound.ts), which their opt-out would stop.
  const confirmsStop = m.source === "reply" && !!m.idempotencyKey?.startsWith("stop:");
  if (toCustomer(m.source) && !(m.source === "automation" && !m.contactId) && !confirmsStop) {
    const block = await consentBlock(contact, (m.category ?? "transactional") as WaTemplateCategory, settings, { reply: m.source === "reply" });
    if (block) return end("skipped", block);
    if (contact?.notOnWhatsappAt && now.getTime() - contact.notOnWhatsappAt.getTime() < 30 * 86_400_000) return end("skipped", "not_on_whatsapp");
  } else if (!confirmsStop && m.phoneHash && (await onDoNotMessageList(m.storeId, m.phoneHash, (m.category ?? "transactional") as WaTemplateCategory))) {
    // The store's own numbers (a test, a code, a team alert, an automation in test mode) still never
    // get a message once that number asked not to (it replied STOP, or is on the do-not-message list).
    return end("skipped", "suppressed");
  }
  if (timed(m.source) && !inSendWindow(now, settings.timeZone, settings.sendWindow.start, settings.sendWindow.end)) {
    return hold(deps, m.id, nextSendTime(now, settings.timeZone, settings.sendWindow.start, settings.sendWindow.end), null);
  }
  if (counted(m.source) && (await sentToday(m.storeId, settings.timeZone, now)) >= dailyLimitOf(settings, conn.provider as "qr" | "cloud_api")) {
    const tomorrow = startOfLocalDay(localDay(new Date(now.getTime() + 86_400_000), settings.timeZone), settings.timeZone);
    if (m.source === "campaign" || m.source === "automation") return hold(deps, m.id, timed(m.source) ? nextSendTime(tomorrow, settings.timeZone, settings.sendWindow.start, settings.sendWindow.end) : tomorrow, "daily_limit");
    return end("skipped", "daily_limit");
  }
  if ((m.source === "automation" || m.source === "campaign") && m.phoneHash) {
    const lastDay = await systemDb.wappMessage.count({ where: { storeId: m.storeId, phoneHash: m.phoneHash, direction: "out", source: { in: ["automation", "campaign"] }, acceptedAt: { gte: new Date(now.getTime() - 86_400_000) } } });
    if (lastDay >= settings.perCustomerDailyLimit) return end("skipped", "customer_limit");
  }
  // The pace: one message at a time per linked phone, with a pause between; the Cloud API per second.
  const gap = conn.provider === "qr" ? QR_MIN_GAP_MS + Math.floor(Math.random() * QR_GAP_JITTER_MS) : Math.ceil(1000 / CLOUD_SENDS_PER_SECOND);
  if (!(await deps.coord.acquire(`wapp:pace:${conn.id}`, gap))) {
    return hold(deps, m.id, new Date(now.getTime() + gap + Math.floor(Math.random() * 2000)), null);
  }

  if (!m.payloadEnc || !m.phoneEnc) return end("failed", "gave_up", { errorCode: "no_payload" });
  const payload = JSON.parse(waDecrypt(m.storeId, "payload", m.payloadEnc)) as MessagePayload;
  const number = waDecrypt(m.storeId, "phone", m.phoneEnc).replace(/^\+/, "");
  const client = clientFor(conn, deps);
  const token = instanceToken(conn);
  try {
    let sent;
    if (payload.attachment) {
      const media = await deps.payloads.get(`wapp-media/${m.id}`);
      if (!media) return end("failed", "gave_up", { errorCode: "attachment_missing", errorDetail: "The attachment was no longer there to send." });
      sent = await client.sendMedia(conn.instanceName, token, { number, mediatype: payload.attachment.kind, mimetype: payload.attachment.mime, media, fileName: payload.attachment.name, caption: payload.text || undefined });
    } else if (conn.provider === "cloud_api" && payload.meta) {
      sent = await client.sendTemplate(conn.instanceName, token, { number, name: payload.meta.name, language: payload.meta.language, bodyParams: payload.meta.params });
    } else {
      sent = await client.sendText(conn.instanceName, token, { number, text: payload.text });
    }
    const status: WaMessageStatus = messageStatusFromProvider(sent.status) === "sent" ? "sent" : "accepted";
    const at = new Date();
    await systemDb.wappMessage.update({
      where: { id: m.id },
      data: { status, reason: null, providerMessageId: sent.id, acceptedAt: at, ...(status === "sent" ? { sentAt: at } : {}), payloadEnc: null, errorCode: null, errorDetail: null },
    });
    await systemDb.wappMessageEvent.createMany({ data: [{ workspaceId: m.workspaceId, storeId: m.storeId, messageId: m.id, status: "accepted", providerStatus: sent.status, occurredAt: at }], skipDuplicates: true });
    if (contact) await systemDb.wappContact.update({ where: { id: contact.id }, data: { lastOutboundAt: at } });
    if (payload.attachment) await dropAttachment(m, deps);
    return status;
  } catch (e) {
    if (!(e instanceof EvolutionError)) throw e;
    const detail = providerDetail(e.detail);
    if (e.notOnWhatsapp) {
      if (contact) await systemDb.wappContact.update({ where: { id: contact.id }, data: { notOnWhatsappAt: new Date() } });
      return end("skipped", "not_on_whatsapp", { errorCode: "not_on_whatsapp" });
    }
    if (e.uncertain) {
      logger.warn({ messageId: m.id, storeId: m.storeId, kind: e.kind, status: e.status }, "whatsapp send unconfirmed: it may have been sent, not retried");
      return end("failed", "gave_up", { errorCode: "uncertain", errorDetail: "WhatsApp's service didn't confirm the send. The message may have reached the customer: check the chat on your phone before sending it again." });
    }
    if (isNotConnected(e)) {
      // The provider lost the phone: hold, and ask it for the state so the page shows it.
      await checkConnection(deps, conn).catch(() => {});
      return hold(deps, m.id, new Date(Date.now() + 5 * 60_000), "not_connected");
    }
    if (e.kind === "unreachable" || e.kind === "server" || e.kind === "timeout") {
      if (m.attempts >= WA_MAX_SEND_ATTEMPTS) return end("failed", "gave_up", { errorCode: e.kind, errorDetail: "bizinsights' WhatsApp service couldn't be reached after several tries." });
      const delay = WA_RETRY_DELAYS_S[Math.min(m.attempts - 1, WA_RETRY_DELAYS_S.length - 1)]!;
      const r = await systemDb.wappMessage.update({ where: { id: m.id }, data: { status: "queued", sendAfter: new Date(Date.now() + delay * 1000), errorCode: e.kind, enqueuedAt: null } });
      await enqueueIfDue(deps, r);
      logger.warn({ messageId: m.id, attempts: m.attempts, kind: e.kind }, "whatsapp send will be retried");
      return "retry";
    }
    if (e.kind === "unauthorized" || e.kind === "not_found") await checkConnection(deps, conn).catch(() => {});
    logger.warn({ messageId: m.id, storeId: m.storeId, kind: e.kind, status: e.status }, "whatsapp send refused by the provider");
    return end("failed", "provider_rejected", { errorCode: `${e.kind}_${e.status}`, errorDetail: detail || null });
  }
}

/**
 * A status report from WhatsApp (Evolution's MESSAGES_UPDATE). A message only moves forward;
 * every report is recorded once. A test message reaching WhatsApp completes Step 4.
 */
export async function applyMessageStatus(conn: Pick<WappConnection, "id" | "storeId" | "workspaceId">, report: { providerMessageId: string; status: string; at: Date }): Promise<"unknown" | "unchanged" | WaMessageStatus> {
  const m = await systemDb.wappMessage.findUnique({ where: { connectionId_providerMessageId: { connectionId: conn.id, providerMessageId: report.providerMessageId } } });
  if (!m || m.storeId !== conn.storeId) return "unknown";
  const status = messageStatusFromProvider(report.status);
  if (!status) return "unchanged";
  await systemDb.wappMessageEvent.createMany({ data: [{ workspaceId: m.workspaceId, storeId: m.storeId, messageId: m.id, status, providerStatus: report.status.slice(0, 40), occurredAt: report.at }], skipDuplicates: true });
  const next = statusAfterReport(m.status, status);
  if (!next) return "unchanged";
  const stamp: Record<string, Date> = {};
  if (next === "sent") stamp.sentAt = report.at;
  if (next === "delivered") {
    stamp.deliveredAt = report.at;
    if (!m.sentAt) stamp.sentAt = report.at;
  }
  if (next === "read") {
    stamp.readAt = report.at;
    if (!m.deliveredAt) stamp.deliveredAt = report.at;
    if (!m.sentAt) stamp.sentAt = report.at;
  }
  if (next === "failed") stamp.failedAt = report.at;
  await systemDb.wappMessage.update({
    where: { id: m.id },
    data: { status: next, ...stamp, ...(isFinalStatus(next) ? { finalAt: report.at, payloadEnc: null } : {}), ...(next === "failed" ? { reason: "provider_rejected", errorCode: "whatsapp_error" } : {}) },
  });
  if (m.source === "test" && (next === "sent" || next === "delivered" || next === "read")) {
    await systemDb.wappSettings.updateMany({ where: { storeId: m.storeId, testPassedAt: null, testVerifiedAt: { not: null } }, data: { testPassedAt: report.at } });
  }
  return next;
}

/** Sends a failed message again (the merchant's "Retry"), when nothing about it has changed. */
export async function retryMessage(deps: Pick<WaDeps, "queues">, store: Pick<Store, "id">, id: string, actor: { userId: string }): Promise<WappMessage> {
  const m = await systemDb.wappMessage.findFirst({ where: { id, storeId: store.id } });
  if (!m || m.direction !== "out") throw new WhatsappError("Not found", 404, "not_found");
  if (m.status !== "failed" || !m.phoneEnc) throw new WhatsappError("Only a failed message can be sent again.", 409, "not_failed");
  // Its code isn't kept (the history shows a placeholder): a new code is the way.
  if (m.source === "verification") throw new WhatsappError("Send a new code from Step 4 instead.", 409, "not_retryable");
  if (!m.payloadEnc && m.type === "text") {
    // The text was cleared when it failed: rebuild the payload from the preview.
    if (!m.previewEnc) throw new WhatsappError("This message's text is no longer kept, so it can't be sent again.", 409, "text_gone");
  }
  const payload: MessagePayload | null = m.payloadEnc
    ? (JSON.parse(waDecrypt(m.storeId, "payload", m.payloadEnc)) as MessagePayload)
    : m.type === "text" && m.previewEnc
      ? { text: waDecrypt(m.storeId, "preview", m.previewEnc) }
      : null;
  if (!payload) throw new WhatsappError("This message's attachment is no longer kept, so it can't be sent again.", 409, "attachment_gone");
  const updated = await systemDb.wappMessage.update({
    where: { id: m.id },
    data: { status: "queued", reason: null, errorCode: null, errorDetail: null, failedAt: null, finalAt: null, attempts: 0, sendAfter: new Date(), payloadEnc: waEncrypt(m.storeId, "payload", JSON.stringify(payload)), createdByUserId: actor.userId },
  });
  await enqueueIfDue(deps, updated);
  return updated;
}

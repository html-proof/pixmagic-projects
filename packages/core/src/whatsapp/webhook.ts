/**
 * Meta's WhatsApp webhooks. The API route checks the signature (bizinsights' app secret signs every
 * delivery, since every number is connected through bizinsights' app) and calls `recordWebhook`,
 * which stores the body once (keyed by its hash: Meta's retries of a body are the same body),
 * encrypted, and queues it; Meta gets its 200 at once. The worker then applies it
 * (`processWebhookEvent`): delivery statuses, customers' messages (STOP / START, and the
 * "Customer sends a message" workflows that answer them), their marketing setting, template
 * reviews, the number's quality and name, and the account's state.
 *
 * Each change is applied only to the store whose number (or account) it names. Everything is
 * idempotent and safe out of order: a status only moves a message forward (statusAfterEvent), each
 * status is stored once per message, an inbound message once per Meta id, and consent changes
 * older than the last one change nothing.
 */
import { Prisma, systemDb, type Store, type WaConnection, type WaContact } from "@app/db";
import { isStartKeyword, isStopKeyword, isStopPromotionsReply, metaErrorExplanation, normalizePhone, sha256Hex, statusAfterEvent } from "@app/shared";
import { logger } from "../logger.js";
import { raiseAlert } from "../notify.js";
import { waDecrypt, waEncrypt, waQueue, type WaDeps } from "./common.js";
import { findContact, setConsent, upsertContact } from "./contacts.js";
import { markAccountProblem, markReconnect, WA_ALERT } from "./tokens.js";
import { runReplyWorkflows } from "./workflows.js";
import {
  metaAccountValueSchema,
  metaChangeSchema,
  metaEntrySchema,
  metaInboundSchema,
  metaMessagesValueSchema,
  metaPreferenceSchema,
  metaPreferencesValueSchema,
  metaStatusSchema,
  metaTemplateValueSchema,
  metaWebhookSchema,
  parseMeta,
  parseMetaList,
  type MetaAccountValue,
  type MetaInbound,
  type MetaStatus,
  type MetaTemplateValue,
} from "./metaPayloads.js";

/** Tries of one delivery before it is set aside as dead (and the stores it names are alerted). */
export const WA_WEBHOOK_MAX_ATTEMPTS = 6;

/** The account ids a body names, without reading anything else of it. */
function wabaIdsOf(body: unknown): string[] {
  const entries = (body as { entry?: Array<{ id?: unknown }> } | null)?.entry;
  return Array.isArray(entries) ? [...new Set(entries.map((e) => String(e?.id ?? "")).filter((x) => /^\d{1,30}$/.test(x)))].slice(0, 50) : [];
}

/**
 * Store a signed delivery and queue it. Returns false for a body that isn't a WhatsApp Business
 * Account's (acknowledged, ignored). A repeat of a stored body is acknowledged; if it is still
 * waiting and its queue message looks lost, it is queued again.
 */
export async function recordWebhook(rawBody: string, deps: Pick<WaDeps, "queues">): Promise<{ stored: boolean; duplicate: boolean }> {
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return { stored: false, duplicate: false };
  }
  if ((body as { object?: unknown })?.object !== "whatsapp_business_account") return { stored: false, duplicate: false };
  const bodyHash = sha256Hex(rawBody);
  let event: { id: string; status: string; enqueuedAt: Date | null };
  let duplicate = false;
  try {
    const id = `wh_${bodyHash.slice(0, 24)}`;
    event = await systemDb.waWebhookEvent.create({
      data: { id, bodyHash, bodyEnc: waEncrypt(id, "webhook", rawBody), wabaIds: wabaIdsOf(body) },
      select: { id: true, status: true, enqueuedAt: true },
    });
  } catch (e) {
    if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
    const found = await systemDb.waWebhookEvent.findUnique({ where: { bodyHash }, select: { id: true, status: true, enqueuedAt: true } });
    if (!found) throw e;
    event = found;
    duplicate = true;
    if (event.status !== "pending" || (event.enqueuedAt && Date.now() - event.enqueuedAt.getTime() < 10 * 60_000)) return { stored: true, duplicate };
  }
  await waQueue(deps.queues).send({ kind: "whatsapp_webhook", eventId: event.id });
  await systemDb.waWebhookEvent.update({ where: { id: event.id }, data: { enqueuedAt: new Date() } });
  return { stored: true, duplicate };
}

/** Apply one stored delivery. Throws (so the queue retries) when something passing went wrong. */
export async function processWebhookEvent(eventId: string, deps: WaDeps): Promise<{ applied: number } | null> {
  const ev = await systemDb.waWebhookEvent.findUnique({ where: { id: eventId } });
  if (!ev || ev.status !== "pending" || !ev.bodyEnc) return null;
  await systemDb.waWebhookEvent.update({ where: { id: ev.id }, data: { attempts: { increment: 1 } } });
  let body: unknown;
  try {
    body = JSON.parse(waDecrypt(ev.id, "webhook", ev.bodyEnc));
  } catch (err) {
    logger.error({ err, eventId }, "whatsapp webhook body unreadable; set aside");
    await systemDb.waWebhookEvent.update({ where: { id: ev.id }, data: { status: "dead", lastError: "unreadable", bodyEnc: null, processedAt: new Date() } });
    return null;
  }
  try {
    const applied = await applyMetaWebhook(body, deps);
    await systemDb.waWebhookEvent.update({ where: { id: ev.id }, data: { status: "processed", processedAt: new Date(), bodyEnc: null, lastError: null } });
    return { applied };
  } catch (err) {
    await systemDb.waWebhookEvent.update({ where: { id: ev.id }, data: { lastError: (err instanceof Error ? err.message : String(err)).slice(0, 300) } }).catch(() => undefined);
    throw err;
  }
}

/** A delivery that kept failing: set aside, and the stores it names are told. */
export async function setWebhookAside(eventId: string, deps: Pick<WaDeps, "mailer" | "fetchImpl">): Promise<void> {
  const ev = await systemDb.waWebhookEvent.findUnique({ where: { id: eventId } });
  if (!ev || ev.status !== "pending") return;
  await systemDb.waWebhookEvent.update({ where: { id: ev.id }, data: { status: "dead", processedAt: new Date() } });
  const conns = await systemDb.waConnection.findMany({ where: { wabaId: { in: ev.wabaIds }, status: { not: "disconnected" } }, select: { workspaceId: true, storeId: true } });
  for (const c of conns) {
    await raiseAlert({ workspaceId: c.workspaceId, storeId: c.storeId, severity: "warning", code: WA_ALERT.webhook, message: `A WhatsApp update from Meta couldn't be applied (${ev.lastError ?? "unknown error"})` }, deps.mailer, deps.fetchImpl).catch(() => undefined);
  }
  logger.error({ eventId, wabaIds: ev.wabaIds, lastError: ev.lastError }, "whatsapp webhook set aside after repeated failures");
}

/** The store a connection belongs to, as the contact helpers want it. */
const storeOf = (c: Pick<WaConnection, "storeId" | "workspaceId">) => ({ id: c.storeId, workspaceId: c.workspaceId });

/** Meta's Unix seconds as a date; now, for one missing or out of range (it must not fail the whole delivery). */
const tsDate = (ts: unknown) => {
  const d = new Date(Number(ts) * 1000);
  return Number(ts) > 0 && Number.isFinite(d.getTime()) ? d : new Date();
};

async function applyStatus(conn: WaConnection, s: MetaStatus): Promise<boolean> {
  // Our own id comes back with the status, so it is found even before Meta's id was recorded.
  const ref = s.biz_opaque_callback_data ?? null;
  let msg = ref ? await systemDb.waMessage.findUnique({ where: { id: ref } }) : null;
  if (!msg || msg.storeId !== conn.storeId) msg = await systemDb.waMessage.findUnique({ where: { wamid: s.id } });
  // A message sent another way (WhatsApp Manager, another tool), or another store's: not ours to change.
  if (!msg || msg.storeId !== conn.storeId || msg.direction !== "out") return false;
  const at = tsDate(s.timestamp);
  const err = s.errors?.[0] ?? null;
  const code = err?.code !== undefined && err?.code !== null ? String(err.code) : null;
  try {
    await systemDb.waMessageEvent.create({
      data: { workspaceId: msg.workspaceId, storeId: msg.storeId, messageId: msg.id, status: s.status, occurredAt: at, errorCode: code, errorTitle: err ? String(err.title ?? err.message ?? "").slice(0, 300) : null },
    });
  } catch (e) {
    // Seen before: a redelivery changes nothing.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return false;
    throw e;
  }
  const data: Prisma.WaMessageUpdateInput = {};
  if (!msg.wamid) data.wamid = s.id;
  if (s.status === "sent" && !msg.sentAt) data.sentAt = at;
  if (s.status === "delivered" && !msg.deliveredAt) data.deliveredAt = at;
  if (s.status === "read") {
    if (!msg.readAt) data.readAt = at;
    if (!msg.deliveredAt) data.deliveredAt = at;
  }
  const next = statusAfterEvent(msg.status, s.status);
  if (next) {
    data.status = next;
    if (next === "failed") {
      data.failedAt = at;
      data.finalAt = at;
      data.errorCode = code;
      data.errorTitle = metaErrorExplanation(code, err?.error_data?.details ?? err?.title ?? err?.message).slice(0, 300);
      data.reason = "undeliverable";
    } else if (next === "delivered" || next === "read") {
      data.finalAt = msg.finalAt ?? at;
      data.reason = null;
    }
  }
  if (s.pricing) {
    if (typeof s.pricing.billable === "boolean") data.billable = s.pricing.billable;
    if (s.pricing.category) data.pricingCategory = s.pricing.category;
  }
  if (Object.keys(data).length) await systemDb.waMessage.update({ where: { id: msg.id }, data });
  if (s.status === "failed" && (code === "131050" || code === "498") && msg.contactId) {
    const contact = await systemDb.waContact.findUnique({ where: { id: msg.contactId } });
    if (contact) await setConsent(contact, { scope: "marketing", status: "opted_out", source: "meta_error", at });
  }
  return true;
}

/** What a customer's message says, for the history ("[image]" for media without a caption). */
function inboundText(m: MetaInbound): string {
  const t = m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? m.image?.caption ?? m.video?.caption ?? m.document?.caption ?? null;
  if (t) return t.slice(0, 2000);
  return `[${(m.type ?? "message").replace(/_/g, " ")}]`;
}

/** What a customer can send that a "Customer sends a message" workflow answers (not reactions, system notices or unsupported types). */
const REPLYABLE = new Set(["text", "image", "video", "document", "audio", "voice", "sticker", "location", "contacts", "button", "interactive", "order"]);

async function applyInbound(conn: WaConnection, store: Pick<Store, "id" | "workspaceId">, m: MetaInbound, deps: WaDeps): Promise<boolean> {
  const phone = normalizePhone(`+${m.from}`, null);
  if (!phone) return false;
  const at = tsDate(m.timestamp);
  const words = m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? null;
  const keyword = isStopPromotionsReply(words) || isStopKeyword(words) || isStartKeyword(words);
  const replyTo = async (contact: WaContact) => {
    if (keyword || !REPLYABLE.has(m.type ?? "text")) return;
    await runReplyWorkflows(deps, { conn, contact, wamid: m.id, text: m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? m.image?.caption ?? m.video?.caption ?? m.document?.caption ?? null, at });
  };
  const known = await systemDb.waMessage.findUnique({ where: { wamid: m.id }, select: { id: true } });
  if (known) {
    // Seen before (Meta redelivered, or applying it failed part-way): its replies are made once per
    // workflow and message, so asking again only finishes what a failed try left.
    const contact = await findContact(store.id, phone);
    if (contact) await replyTo(contact);
    return false;
  }
  let contact = await upsertContact(store, phone, { inboundAt: at });
  const text = inboundText(m);
  try {
    await systemDb.waMessage.create({
      data: {
        workspaceId: store.workspaceId,
        storeId: store.id,
        connectionId: conn.id,
        direction: "in",
        contactId: contact.id,
        phoneHash: contact.phoneHash,
        phoneMasked: contact.phoneMasked,
        source: "inbound",
        type: (m.type ?? "text").slice(0, 30),
        status: "delivered",
        wamid: m.id,
        previewEnc: waEncrypt(store.id, "preview", text),
        sendAfter: at,
        deliveredAt: at,
        finalAt: at,
      },
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return false;
    throw e;
  }
  if (isStopPromotionsReply(words)) {
    contact = (await setConsent(contact, { scope: "marketing", status: "opted_out", source: "stop_promotions", at })).contact;
  } else if (isStopKeyword(words)) {
    contact = (await setConsent(contact, { scope: "all", status: "opted_out", source: "whatsapp_stop", at })).contact;
  } else if (isStartKeyword(words)) {
    contact = (await setConsent(contact, { scope: "all", status: "opted_in", source: "whatsapp_start", at })).contact;
  }
  await replyTo(contact);
  return true;
}

async function applyTemplateUpdate(wabaId: string, v: MetaTemplateValue, field: string): Promise<void> {
  const metaId = v.message_template_id != null ? String(v.message_template_id) : "";
  const where: Prisma.WaTemplateWhereInput = {
    wabaId,
    OR: [...(metaId ? [{ metaId }] : []), ...(v.message_template_name && v.message_template_language ? [{ name: v.message_template_name, language: v.message_template_language }] : [])],
  };
  if (!(where.OR as unknown[]).length) return;
  if (field === "message_template_status_update") {
    const status = String(v.event ?? "").toUpperCase();
    if (status) await systemDb.waTemplate.updateMany({ where, data: { status, rejectedReason: v.reason && v.reason !== "NONE" ? v.reason.slice(0, 300) : null } });
  } else if (field === "template_category_update") {
    const category = String(v.new_category ?? "").toUpperCase();
    if (category) await systemDb.waTemplate.updateMany({ where, data: { category } });
  } else if (field === "message_template_quality_update") {
    await systemDb.waTemplate.updateMany({ where, data: { qualityScore: v.new_quality_score || null } });
  }
}

const sameNumber = (c: WaConnection, display: string | null | undefined) => !display || (c.displayPhoneNumber ?? "").replace(/\D/g, "") === display.replace(/\D/g, "");

async function applyAccountUpdate(conns: WaConnection[], v: MetaAccountValue, field: string, deps: WaDeps): Promise<void> {
  const event = String(v.event ?? "").toUpperCase();
  if (field === "phone_number_quality_update") {
    for (const c of conns.filter((x) => sameNumber(x, v.display_phone_number))) {
      // FLAGGED: quality dropped (the limit may fall next); the health check reads the rating itself.
      await systemDb.waConnection.update({ where: { id: c.id }, data: { ...(v.current_limit ? { messagingLimitTier: v.current_limit } : {}), ...(event === "FLAGGED" ? { qualityRating: "RED" } : {}) } });
    }
    return;
  }
  if (field === "phone_number_name_update") {
    const decision = String(v.decision ?? "").toUpperCase();
    for (const c of conns.filter((x) => sameNumber(x, v.display_phone_number))) {
      if (decision) await systemDb.waConnection.update({ where: { id: c.id }, data: { nameStatus: decision, ...(decision === "APPROVED" && v.requested_verified_name ? { verifiedName: v.requested_verified_name } : {}) } });
    }
    return;
  }
  // account_update: bizinsights removed from the business, or the account restricted.
  if (/PARTNER_REMOVED|PARTNER_APP_UNINSTALLED/.test(event)) {
    for (const c of conns) await markReconnect(c, "bizinsights was removed from your business in Meta", deps);
  } else if (/DISABLED|BAN|VIOLATION|RESTRICT/.test(event) || /DISABLE|BAN/.test(String(v.ban_info?.waba_ban_state ?? "").toUpperCase())) {
    for (const c of conns) await markAccountProblem(c, `Meta reports the account as ${event.toLowerCase().replace(/_/g, " ")}`, deps, { holdSending: /DISABLED|BAN/.test(event) });
  }
}

/** Apply one webhook body. Returns how many changes were applied. */
export async function applyMetaWebhook(payload: unknown, deps: WaDeps): Promise<number> {
  const body = parseMeta(metaWebhookSchema, payload, "webhook");
  if (body?.object !== "whatsapp_business_account" || !body.entry) return 0;
  let applied = 0;
  for (const entry of parseMetaList(metaEntrySchema, body.entry, "webhook entry")) {
    const wabaId = String(entry.id);
    const conns = await systemDb.waConnection.findMany({ where: { wabaId, status: { not: "disconnected" } } });
    if (!conns.length) continue;
    await systemDb.waConnection.updateMany({ where: { id: { in: conns.map((c) => c.id) } }, data: { lastWebhookAt: new Date() } });
    for (const change of parseMetaList(metaChangeSchema, entry.changes ?? [], "webhook change", { wabaId })) {
      const field = change.field;
      const ids = { wabaId, field };
      if (field === "messages") {
        const v = parseMeta(metaMessagesValueSchema, change.value, field, ids);
        if (!v) continue;
        // Statuses and messages name the number they're for: only its store hears them.
        const conn = conns.find((c) => c.phoneNumberId && c.phoneNumberId === String(v.metadata?.phone_number_id ?? ""));
        if (!conn) continue;
        for (const s of parseMetaList(metaStatusSchema, v.statuses ?? [], "status", ids)) if (await applyStatus(conn, s)) applied++;
        for (const m of parseMetaList(metaInboundSchema, v.messages ?? [], "message", ids)) if (await applyInbound(conn, storeOf(conn), m, deps)) applied++;
      } else if (field === "user_preferences") {
        const v = parseMeta(metaPreferencesValueSchema, change.value, field, ids);
        if (!v) continue;
        // The change names the number it was made on: that store's contact changes. Without one, a
        // "stop" still reaches contacts the stores on the account already have (the safe way round).
        const named = conns.find((c) => c.phoneNumberId && c.phoneNumberId === String(v.metadata?.phone_number_id ?? ""));
        for (const conn of named ? [named] : conns) {
          for (const p of parseMetaList(metaPreferenceSchema, v.user_preferences ?? [], "preference", ids)) {
            if (p.category !== "marketing_messages") continue;
            const phone = normalizePhone(`+${p.wa_id}`, null);
            if (!phone) continue;
            const at = tsDate(p.timestamp);
            if (p.value === "stop") {
              // Remembered for the store it names; elsewhere only for customers the store already has.
              const contact = named ? await upsertContact(storeOf(conn), phone) : await findContact(conn.storeId, phone);
              if (contact) await setConsent(contact, { scope: "marketing", status: "opted_out", source: "meta_preferences", at });
            } else if (p.value === "resume" && named) {
              const contact = await upsertContact(storeOf(conn), phone);
              await setConsent(contact, { scope: "marketing", status: "opted_in", source: "meta_preferences", at });
            }
            applied++;
          }
        }
      } else if (field.startsWith("message_template") || field === "template_category_update") {
        const v = parseMeta(metaTemplateValueSchema, change.value, field, ids);
        if (!v) continue;
        await applyTemplateUpdate(wabaId, v, field);
        applied++;
      } else if (field === "phone_number_quality_update" || field === "phone_number_name_update" || field === "account_update") {
        const v = parseMeta(metaAccountValueSchema, change.value, field, ids);
        if (!v) continue;
        await applyAccountUpdate(conns, v, field, deps);
        applied++;
      }
    }
  }
  return applied;
}

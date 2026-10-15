/**
 * Meta's WhatsApp webhooks, after the signature check (apps/api/src/routes/whatsappPublic.ts):
 * delivery statuses, customers' messages (STOP / START), their marketing preferences, and template
 * review results. Each change is applied only to the store whose number or account it names, and
 * only when the signature that came with it belongs to that account.
 *
 * Everything is idempotent: statuses only move a message forward, events are stored once per
 * message and status, and opt-outs are states, not counters.
 */
import { Prisma, systemDb, type Store, type WhatsappConnection } from "@app/db";
import { errorExplanation, isStartKeyword, isStopKeyword, isStopPromotionsReply, normalizePhone, STATUS_RANK } from "@app/shared";
import { logger } from "../logger.js";
import { runAutomations } from "./automations.js";
import type { WaDeps } from "./messages.js";
import { applyMarketing, optInContact, optOutContact, parseConfig, phoneHash, upsertContact } from "./store.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Value = Record<string, any>;

export interface MetaWebhookResult {
  /** Statuses for messages we sent a moment ago but haven't recorded the id of yet: ask Meta to retry. */
  retry: boolean;
  applied: number;
}

/** A status this young for an unknown message id is probably our own send still being recorded. */
const UNKNOWN_STATUS_GRACE_S = 120;

const tsDate = (ts: unknown) => {
  const n = Number(ts);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : new Date();
};

async function applyStatus(conn: WhatsappConnection, s: Value): Promise<"ok" | "unknown" | "ignored"> {
  if (!s?.id || !s?.status) return "ignored";
  const msg = await systemDb.whatsappMessage.findUnique({ where: { providerMessageId: String(s.id) } });
  if (!msg) return Date.now() / 1000 - Number(s.timestamp ?? 0) < UNKNOWN_STATUS_GRACE_S ? "unknown" : "ignored";
  // Another store's message named in this store's webhook: never applied.
  if (msg.storeId !== conn.storeId) return "ignored";
  const status = String(s.status);
  const at = tsDate(s.timestamp);
  const err = Array.isArray(s.errors) ? s.errors[0] : null;
  const code = err?.code !== undefined ? String(err.code) : null;
  try {
    await systemDb.whatsappMessageEvent.create({
      data: { workspaceId: msg.workspaceId, storeId: msg.storeId, messageId: msg.id, status, occurredAt: at, errorCode: code, errorTitle: err ? String(err.title ?? err.message ?? "").slice(0, 300) : null },
    });
  } catch (e) {
    if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
  }
  const data: Prisma.WhatsappMessageUpdateInput = {};
  const rank = STATUS_RANK[msg.status] ?? -1;
  if (status === "sent") {
    if (!msg.sentAt) data.sentAt = at;
    if (rank < STATUS_RANK.sent!) data.status = "sent";
  } else if (status === "delivered") {
    if (!msg.deliveredAt) data.deliveredAt = at;
    if (rank < STATUS_RANK.delivered! && msg.status !== "failed") data.status = "delivered";
  } else if (status === "read") {
    if (!msg.readAt) data.readAt = at;
    if (!msg.deliveredAt) data.deliveredAt = at;
    data.status = "read";
  } else if (status === "failed") {
    // Delivered and read are facts; a failure report can't undo them.
    if (rank < STATUS_RANK.delivered!) {
      data.status = "failed";
      data.failedAt = at;
      data.errorCode = code;
      data.errorTitle = errorExplanation(code, err?.error_data?.details ?? err?.message ?? err?.title).slice(0, 300);
    }
    if ((code === "131050" || code === "498") && msg.contactId) {
      const contact = await systemDb.whatsappContact.findUnique({ where: { id: msg.contactId } });
      if (contact) await applyMarketing(contact, { status: "opted_out", source: "meta_preferences" }, at);
    }
  }
  const pricing = s.pricing as Value | undefined;
  if (pricing) {
    if (typeof pricing.billable === "boolean") data.billable = pricing.billable;
    if (pricing.category) data.pricingCategory = String(pricing.category);
  }
  if (Object.keys(data).length) await systemDb.whatsappMessage.update({ where: { id: msg.id }, data });
  return "ok";
}

async function applyInbound(conn: WhatsappConnection, store: Store, m: Value, deps: Pick<WaDeps, "queues">) {
  const phone = normalizePhone(m?.from ? `+${m.from}` : null, null);
  if (!phone) return;
  const at = tsDate(m.timestamp);
  const contact = await upsertContact(store, phone, { inboundAt: at });
  const text: string | null = m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? null;
  if (isStopPromotionsReply(text)) {
    // The marketing template's own button: no more offers; order updates continue.
    await applyMarketing(contact, { status: "opted_out", source: "whatsapp" }, at);
  } else if (isStopKeyword(text)) {
    await optOutContact(contact, "whatsapp_keyword", at);
  } else if (isStartKeyword(text)) {
    // Meta redelivers: a START older than the last change (a STOP sent after it) must not undo it.
    if (contact.marketingUpdatedAt && at <= contact.marketingUpdatedAt) return;
    const before = contact.marketingStatus;
    const updated = await optInContact(contact, "whatsapp_keyword", at);
    if (before !== "opted_in") await customerOptedIn(store, updated, deps);
  }
}

async function customerOptedIn(store: Store, contact: Awaited<ReturnType<typeof optInContact>>, deps: Pick<WaDeps, "queues">) {
  const settings = await systemDb.whatsappSettings.findUnique({ where: { storeId: store.id } });
  if (!settings) return;
  await runAutomations(
    "customer_opted_in",
    {
      key: `contact:${contact.id}:${contact.marketingUpdatedAt?.getTime() ?? 0}`,
      store,
      cfg: parseConfig(settings.config),
      contact,
      facts: { country: contact.country, marketingConsent: true },
      values: { store_name: store.name ?? store.shopDomain },
    },
    deps,
  );
}

/**
 * Meta's own "stop/resume marketing messages" setting in WhatsApp. `named` is whether the change
 * named this store's number: only then may it create a contact (to remember a "stop") or opt one in.
 * A "resume" never creates a contact: someone who never was this store's customer doesn't become one.
 */
async function applyPreference(store: Store, p: Value, deps: Pick<WaDeps, "queues">, named: boolean) {
  if (String(p?.category ?? "") !== "marketing_messages") return;
  const phone = normalizePhone(p?.wa_id ? `+${p.wa_id}` : null, null);
  if (!phone) return;
  const at = tsDate(p.timestamp);
  const existing = await systemDb.whatsappContact.findUnique({ where: { storeId_phoneHash: { storeId: store.id, phoneHash: phoneHash(store.id, phone.waId) } } });
  if (String(p.value) === "stop") {
    const contact = existing ?? (named ? await upsertContact(store, phone) : null);
    if (contact) await applyMarketing(contact, { status: "opted_out", source: "meta_preferences" }, at);
  } else if (String(p.value) === "resume" && named && existing) {
    // A redelivered "resume" older than the last change must not undo a later "stop".
    if (existing.marketingUpdatedAt && at <= existing.marketingUpdatedAt) return;
    const updated = await applyMarketing(existing, { status: "opted_in", source: "meta_preferences" }, at);
    if (existing.marketingStatus !== "opted_in") await customerOptedIn(store, updated, deps);
  }
}

async function applyTemplateUpdate(conn: WhatsappConnection, v: Value, field: string) {
  if (field === "message_template_status_update") {
    const status = String(v.event ?? "").toUpperCase();
    if (!status) return;
    await systemDb.whatsappTemplate.updateMany({
      where: { connectionId: conn.id, OR: [{ metaId: String(v.message_template_id ?? "") }, { name: String(v.message_template_name ?? ""), language: String(v.message_template_language ?? "") }] },
      data: { status, rejectedReason: v.reason && v.reason !== "NONE" ? String(v.reason).slice(0, 300) : null },
    });
  } else if (field === "template_category_update") {
    const category = String(v.new_category ?? "").toUpperCase();
    if (category) await systemDb.whatsappTemplate.updateMany({ where: { connectionId: conn.id, metaId: String(v.message_template_id ?? "") }, data: { category } });
  } else if (field === "message_template_quality_update") {
    await systemDb.whatsappTemplate.updateMany({ where: { connectionId: conn.id, metaId: String(v.message_template_id ?? "") }, data: { qualityScore: v.new_quality_score ? String(v.new_quality_score) : null } });
  }
}

async function applyAccountUpdate(conns: WhatsappConnection[], v: Value, field: string) {
  if (field === "phone_number_quality_update") {
    const display = String(v.display_phone_number ?? "").replace(/\D/g, "");
    for (const c of conns) {
      if (display && (c.displayPhoneNumber ?? "").replace(/\D/g, "") !== display) continue;
      await systemDb.whatsappConnection.update({ where: { id: c.id }, data: { ...(v.current_limit ? { messagingLimitTier: String(v.current_limit) } : {}), ...(v.event ? { qualityRating: String(v.event) } : {}) } });
    }
  } else if (field === "account_update" && /DISABLED|BAN|RESTRICT/i.test(String(v.event ?? ""))) {
    for (const c of conns) await systemDb.whatsappConnection.update({ where: { id: c.id }, data: { status: "error", lastError: `WhatsApp account ${String(v.event).toLowerCase().replace(/_/g, " ")}` } });
  }
}

/**
 * Apply one signed webhook body. `trusted` is the set of connections (ids) whose own app secret
 * signed it, or "all" when Insights' own app secret did (Meta only signs with it what it delivers
 * to Insights' app, so it is genuine for every connection on the account).
 */
export async function applyMetaWebhook(payload: unknown, trusted: Set<string> | "all", deps: Pick<WaDeps, "queues">): Promise<MetaWebhookResult> {
  const body = (payload ?? {}) as Value;
  const result: MetaWebhookResult = { retry: false, applied: 0 };
  if (body.object !== "whatsapp_business_account" || !Array.isArray(body.entry)) return result;
  for (const entry of body.entry) {
    const wabaId = String(entry?.id ?? "");
    if (!wabaId) continue;
    const onAccount = await systemDb.whatsappConnection.findMany({ where: { wabaId } });
    // A manual connection's secret speaks for that connection only, never for others on the account.
    const conns = trusted === "all" ? onAccount : onAccount.filter((c) => trusted.has(c.id));
    if (!conns.length) continue;
    const now = new Date();
    await systemDb.whatsappConnection.updateMany({ where: { id: { in: conns.map((c) => c.id) } }, data: { lastWebhookAt: now, webhookVerifiedAt: now } });
    for (const change of Array.isArray(entry.changes) ? entry.changes : []) {
      const field = String(change?.field ?? "");
      const v = (change?.value ?? {}) as Value;
      try {
        if (field === "messages") {
          // Statuses and messages name the number they're for: only that number's store hears them.
          const conn = conns.find((c) => c.phoneNumberId === String(v.metadata?.phone_number_id ?? ""));
          if (!conn) continue;
          const store = await systemDb.store.findUnique({ where: { id: conn.storeId } });
          if (!store) continue;
          for (const s of Array.isArray(v.statuses) ? v.statuses : []) {
            const r = await applyStatus(conn, s);
            if (r === "unknown") result.retry = true;
            if (r === "ok") result.applied++;
          }
          for (const m of Array.isArray(v.messages) ? v.messages : []) {
            await applyInbound(conn, store, m, deps);
            result.applied++;
          }
        } else if (field === "user_preferences") {
          // The change names the number it was made on: that store's contact changes. Without a
          // number, a "stop" still reaches contacts the other stores already have (the safe way
          // round), and nothing is opted in or created anywhere.
          const named = conns.find((c) => c.phoneNumberId === String(v.metadata?.phone_number_id ?? ""));
          for (const conn of named ? [named] : conns) {
            const store = await systemDb.store.findUnique({ where: { id: conn.storeId } });
            if (!store) continue;
            for (const p of Array.isArray(v.user_preferences) ? v.user_preferences : []) await applyPreference(store, p, deps, !!named);
          }
          result.applied++;
        } else if (field.startsWith("message_template") || field === "template_category_update") {
          for (const conn of conns) await applyTemplateUpdate(conn, v, field);
          result.applied++;
        } else if (field === "phone_number_quality_update" || field === "account_update") {
          await applyAccountUpdate(conns, v, field);
          result.applied++;
        }
      } catch (err) {
        logger.error({ err, field, wabaId }, "applying a whatsapp webhook change failed");
        throw err;
      }
    }
  }
  return result;
}

/**
 * Zapier's one action, "Send WhatsApp Template Message" (docs/zapier.md): a Zap hands bizinsights a
 * customer's number, one of the store's templates Meta approved and the values for its variables, and
 * bizinsights queues it through the store's own WhatsApp path (docs/whatsapp.md, "Sending"), so every
 * rule a message from the dashboard keeps applies: the connection, consent and the do-not-message list
 * (checked now and again when it is sent), the store's daily and per-customer limits, its sending
 * hours, Pause all automation, Meta's limits and the circuit breaker.
 *
 * Only for a connection that was given the scope "whatsapp_send" on the consent page, while the member
 * who connected it may still send from the WhatsApp page (owners and admins). Never free text: always
 * one of the store's templates the WhatsApp page would send now (on Meta's WhatsApp Business Platform,
 * one Meta approved: a Zap doesn't know whether the customer wrote in the last 24 hours).
 */
import { systemDb, type WappTemplate, type ZapierGrant } from "@app/db";
import { allows, normalizePhone, renderWaText, sha256Hex, variablesIn, WaMissingValueError, waSkipLabel, WA_CATEGORY_INFO, type WaTemplateCategory } from "@app/shared";
import { ZAPIER_SCOPE_INFO, ZAPIER_WA_SENDS_PER_MINUTE, ZAPIER_WA_VALUE_MAX, zapierFillable, zapierWaValue, zapierWhatsappSendSchema } from "@app/shared/zapier";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { audit } from "../notify.js";
import { businessNameOf, connectionCanSend, liveConnection, settingsOf, type WaDeps } from "../whatsapp/common.js";
import { contactFirstName, recordConsent, upsertContact } from "../whatsapp/contacts.js";
import { consentBlock, queueMessage } from "../whatsapp/messages.js";
import { templateUsable } from "../whatsapp/templates.js";
import type { AuthorizerAccess } from "./access.js";
import { ZapierError } from "./common.js";

const SCOPE_MISSING =
  'This Zapier connection wasn\'t allowed to send WhatsApp messages. Connect bizinsights again in Zapier and tick "Send WhatsApp template messages to your customers" on bizinsights\' page.';

/** The connection may send: the scope was ticked, and the member who connected it may still send from the WhatsApp page. */
function requireWhatsappSend(grant: Pick<ZapierGrant, "scopes">, who: Pick<AuthorizerAccess, "access">) {
  if (!grant.scopes.includes("whatsapp_send")) throw new ZapierError(SCOPE_MISSING, 403, "scope_missing");
  if (!allows(who.access, ZAPIER_SCOPE_INFO.whatsapp_send.needs)) {
    throw new ZapierError(`Only ${ZAPIER_SCOPE_INFO.whatsapp_send.needsLabel} may send WhatsApp messages, and the person who connected bizinsights no longer is one. One of them can connect bizinsights again.`, 403, "no_permission");
  }
}

/** A template as the action's dropdown shows it: the variables a Zap fills in, and the text with them. */
function templateView(t: WappTemplate) {
  const variables = variablesIn(t.body);
  return {
    id: t.id,
    name: t.name,
    category: t.category,
    category_label: WA_CATEGORY_INFO[t.category as WaTemplateCategory]?.label ?? t.category,
    language: t.metaLanguage ?? "en",
    body: t.body,
    variables: zapierFillable(variables),
    // Filled in by bizinsights: the business's name (WhatsApp Settings).
    automatic: variables.filter((v) => v === "store_name"),
  };
}

/**
 * Whether a template can go through this connection now: the WhatsApp page's own rule (switched on;
 * on Meta's WhatsApp Business Platform, approved by Meta and known to Meta by name).
 */
function sendable(t: WappTemplate, conn: Parameters<typeof templateUsable>[1]): { ok: boolean; reason: string | null } {
  const usable = templateUsable(t, conn);
  if (usable.ok && conn?.provider === "cloud_api" && !t.metaName) return { ok: false, reason: "It hasn't been submitted to Meta yet." };
  return usable;
}

/** The store's templates a Zap can send now, through the connection it has. */
export async function zapierWhatsappTemplates(grant: ZapierGrant, who: AuthorizerAccess) {
  requireWhatsappSend(grant, who);
  const [conn, rows] = await Promise.all([liveConnection(grant.storeId), systemDb.wappTemplate.findMany({ where: { storeId: grant.storeId, active: true }, orderBy: { name: "asc" } })]);
  return rows.filter((t) => sendable(t, conn).ok).map(templateView);
}

/** What the action answers: the message as bizinsights queued it (the customer's number masked). */
export interface ZapierWhatsappSent {
  id: string;
  status: string;
  duplicate: boolean;
  phone_masked: string | null;
  template: { id: string; name: string; category: string };
  consent_recorded: boolean;
  send_after: string;
  queued_at: string;
  note: string | null;
  view_url: string;
}

/**
 * Queues one template message for a Zap. Refused with words the merchant reads in Zapier when it
 * can't go: not connected, a number that isn't one, a template that isn't approved, a value missing,
 * no consent, the customer replied STOP. Once queued, what happens to it is the WhatsApp page's
 * (and the "WhatsApp Message Failed" trigger's, if Meta refuses it).
 */
export async function zapierSendWhatsapp(deps: Pick<WaDeps, "queues" | "coord">, grant: ZapierGrant, who: AuthorizerAccess, data: unknown, now = new Date()): Promise<ZapierWhatsappSent> {
  requireWhatsappSend(grant, who);
  const d = zapierWhatsappSendSchema.parse(data);
  const store = await systemDb.store.findUniqueOrThrow({ where: { id: grant.storeId } });
  const conn = await liveConnection(store.id);
  if (!connectionCanSend(conn)) {
    throw new ZapierError("WhatsApp isn't connected for this store in bizinsights, so nothing can be sent. Connect it on bizinsights' WhatsApp page first.", 409, "not_connected");
  }
  const phone = normalizePhone(d.phone, d.country ?? null);
  if (!phone) throw new ZapierError("That isn't a valid international phone number. Map one with its country code (+61 412 345 678), or choose the country for numbers written without it.", 400, "invalid_phone");

  const t = await systemDb.wappTemplate.findFirst({ where: { id: d.template_id, storeId: store.id } });
  if (!t) throw new ZapierError("Choose one of this store's WhatsApp templates.", 400, "template_not_found");
  const usable = sendable(t, conn);
  if (!usable.ok) throw new ZapierError(`That template can't be sent: ${usable.reason}`, 409, "template_unavailable");
  const category = t.category as WaTemplateCategory;

  // The same purpose sends once: this template with the Zap's key (a lead's or order's id), per store,
  // so a replayed task, a copied Zap or Zapier connected again (a new grant) never sends it twice.
  const valuesIn = Object.fromEntries(Object.entries(d.values).map(([k, v]) => [k, zapierWaValue(v)]));
  const key = `zapier:k:${sha256Hex(JSON.stringify([t.id, d.unique_key]))}`;
  const existing = await systemDb.wappMessage.findUnique({ where: { storeId_idempotencyKey: { storeId: store.id, idempotencyKey: key } } });
  if (existing) return answer(existing, t, { duplicate: true, consentRecorded: false });

  if ((await deps.coord.hit(`wapp:zapier:${store.id}`, 60)) > ZAPIER_WA_SENDS_PER_MINUTE) {
    throw new ZapierError("Zapier is handing bizinsights WhatsApp messages too quickly for this store. Zapier will try again in a minute.", 429, "rate_limited");
  }

  const settings = await settingsOf(store);
  let contact = await upsertContact(store, phone, { firstName: d.first_name ?? null });
  // The values first: a message refused for one records nothing.
  const values: Record<string, string | undefined> = { ...valuesIn, store_name: businessNameOf(store, settings) };
  if (!values.customer_first_name) values.customer_first_name = contactFirstName(contact) ?? undefined;
  const tooLong = Object.entries(values).find(([, v]) => (v?.length ?? 0) > ZAPIER_WA_VALUE_MAX);
  if (tooLong) throw new ZapierError(`The value for {{${tooLong[0]}}} is longer than ${ZAPIER_WA_VALUE_MAX} characters.`, 400, "value_too_long");
  let text: string;
  try {
    text = renderWaText(t.body, values);
  } catch (e) {
    if (e instanceof WaMissingValueError) throw new ZapierError(`This template needs a value for ${e.missing.map((v) => `{{${v}}}`).join(", ")}: map one in the Zap.`, 400, "missing_values");
    throw e;
  }

  let consentRecorded = false;
  if (d.customer_agreed) {
    if (contact.optedOut) throw new ZapierError("This customer replied STOP to the store's WhatsApp. Only they can opt back in, by replying START.", 409, "opted_out");
    contact = await recordConsent(contact, {
      scope: category === "marketing" ? "marketing" : "order_updates",
      status: "opted_in",
      source: "zapier",
      actorUserId: grant.userId,
      note: `A Zap said the customer agreed${d.consent_note ? `: ${d.consent_note}` : "."}`,
      at: now,
    });
    consentRecorded = true;
  }
  let block = await consentBlock(contact, category, settings);
  // "Customers told at checkout" covers the store's own customers, who went through its checkout. A
  // number bizinsights knows only from a Zap (a lead) needs the customer's own agreement.
  if (!block && category === "transactional" && settings.orderUpdates === "checkout_notice" && !contact.optedIn && contact.marketing !== "opted_in" && !contact.shopifyCustomerId && !contact.ordersCount) {
    block = "no_consent";
  }
  if (block) {
    const hint =
      block === "no_consent" || block === "no_marketing_consent"
        ? ' If the customer agreed to get WhatsApp messages from you (on your lead form, at checkout), set "The customer agreed to WhatsApp messages from you" to Yes and say where in "Where they agreed".'
        : block === "consent_basis_unset"
          ? " Choose how customers agree to order updates in bizinsights' WhatsApp Settings."
          : block === "marketing_off"
            ? " Switch marketing on in bizinsights' WhatsApp Settings, or use an order-update template."
            : "";
    throw new ZapierError(`This message can't go to that number: ${waSkipLabel(block)}.${hint}`, 409, "not_allowed");
  }

  const { message, created } = await queueMessage(deps, {
    store,
    conn,
    source: "zapier",
    category,
    phone,
    contactId: contact.id,
    // Meta's template by name when Meta approved it (the Cloud API sends that); a phone linked another way sends the text.
    payload: { text, meta: t.metaName ? { name: t.metaName, language: t.metaLanguage ?? "en", params: variablesIn(t.body).map((v) => values[v] ?? "") } : null },
    templateId: t.id,
    idempotencyKey: key,
    createdByUserId: grant.userId,
  });
  if (created) {
    await audit({
      workspaceId: store.workspaceId,
      actorUserId: grant.userId,
      action: "whatsapp.message_sent",
      targetType: "whatsapp_message",
      targetId: message.id,
      metadata: { via: "zapier", zapierGrantId: grant.id, zapId: d.zap_id ?? null, template: t.id, category, recordedConsent: consentRecorded },
    });
    logger.info({ storeId: store.id, messageId: message.id, zapierGrantId: grant.id }, "whatsapp message queued from zapier");
  }
  return answer(message, t, { duplicate: !created, consentRecorded });
}

function answer(m: { id: string; status: string; phoneMasked: string | null; sendAfter: Date; createdAt: Date; reason: string | null }, t: Pick<WappTemplate, "id" | "name" | "category">, o: { duplicate: boolean; consentRecorded: boolean }): ZapierWhatsappSent {
  return {
    id: m.id,
    status: m.status,
    duplicate: o.duplicate,
    phone_masked: m.phoneMasked,
    template: { id: t.id, name: t.name, category: t.category },
    consent_recorded: o.consentRecorded,
    send_after: m.sendAfter.toISOString(),
    queued_at: m.createdAt.toISOString(),
    note: o.duplicate ? "Already sent for this key: bizinsights didn't send it again." : m.reason ? waSkipLabel(m.reason) : null,
    view_url: `${env().APP_URL}/dashboard/whatsapp-automation?tab=messages`,
  };
}

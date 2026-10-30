/**
 * A message written in the dashboard (docs/whatsapp.md, "Sending a message"). Before it is queued:
 * the person may send (the route), the store's connection is up, the number is a valid
 * international one, the reason they give allows it (a customer who wrote in the last 24 hours, an
 * order update under the store's consent choice, marketing only with marketing consent), the
 * customer hasn't opted out, and the store isn't sending too fast. "The customer asked to be
 * messaged on WhatsApp" is recorded as consent from the store, with who said it.
 *
 * The same idempotency key sends once: a double press, or a retried request, finds the first.
 */
import { systemDb, type Store, type WappMessage } from "@app/db";
import {
  normalizePhone,
  renderWaText,
  WaMissingValueError,
  waSendSchema,
  WA_ATTACHMENT_MAX_BYTES,
  WA_ATTACHMENT_TYPES,
  WA_SEND_REASON_INFO,
  variablesIn,
  waSkipLabel,
} from "@app/shared";
import { audit } from "../notify.js";
import { businessNameOf, liveConnection, settingsOf, WhatsappError, type WaDeps } from "./common.js";
import { contactFirstName, recordConsent, upsertContact } from "./contacts.js";
import { consentBlock, enqueueIfDue, inServiceWindow, queueMessage, type MessagePayload } from "./messages.js";
import { templateUsable } from "./templates.js";

/** Messages one store may send from the dashboard a minute. */
const MANUAL_PER_MINUTE = 20;

/** The file's first bytes must match the type it claims. */
function signatureMatches(mime: string, bytes: Buffer): boolean {
  if (mime === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === "image/png") return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mime === "image/webp") return bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP";
  if (mime === "application/pdf") return bytes.subarray(0, 5).toString("latin1") === "%PDF-";
  return false;
}

export async function sendManualMessage(deps: Pick<WaDeps, "queues" | "coord" | "payloads">, input: { store: Store; userId: string; data: unknown; ip?: string }): Promise<WappMessage> {
  const d = waSendSchema.parse(input.data);
  const conn = await liveConnection(input.store.id);
  if (!conn || conn.status !== "connected") throw new WhatsappError("WhatsApp isn't connected, so nothing can be sent. Connect it first.", 409, "not_connected");
  const phone = normalizePhone(d.phone, d.country);
  if (!phone) throw new WhatsappError("That isn't a valid international phone number. Include the country code, for example +61 412 345 678.", 400, "invalid_phone");
  const existing = await systemDb.wappMessage.findUnique({ where: { storeId_idempotencyKey: { storeId: input.store.id, idempotencyKey: `manual:${d.idempotencyKey}` } } });
  if (existing) return existing;
  if ((await deps.coord.hit(`wapp:manual:${input.store.id}`, 60)) > MANUAL_PER_MINUTE) throw new WhatsappError("You're sending messages too quickly. Wait a minute and try again.", 429, "rate_limited");

  const settings = await settingsOf(input.store);
  const info = WA_SEND_REASON_INFO[d.reason];
  let contact = await upsertContact(input.store, phone);
  if (d.customerAsked) {
    if (contact.optedOut) throw new WhatsappError("This customer replied STOP. Only they can opt back in, by replying START.", 409, "opted_out");
    contact = await recordConsent(contact, {
      scope: info.category === "marketing" ? "marketing" : "order_updates",
      status: "opted_in",
      source: "merchant",
      actorUserId: input.userId,
      note: "The customer asked to be messaged on WhatsApp (recorded when sending from the dashboard).",
    });
  }
  const block = await consentBlock(contact, info.category, settings, { reply: false });
  if (block) {
    const hint =
      block === "no_consent" || block === "no_marketing_consent" || block === "unknown_contact"
        ? " If the customer asked you to message them on WhatsApp, tick that box to record it."
        : block === "consent_basis_unset"
          ? " Choose how customers agree to order updates in Settings."
          : "";
    throw new WhatsappError(`This message can't go to that number: ${waSkipLabel(block)}.${hint}`, 409, "not_allowed", { reason: block });
  }

  let text = d.text;
  let templateId: string | null = null;
  let meta: MessagePayload["meta"] = null;
  if (d.templateId) {
    const t = await systemDb.wappTemplate.findFirst({ where: { id: d.templateId, storeId: input.store.id } });
    if (!t) throw new WhatsappError("Pick one of this store's templates.", 400, "template_not_found");
    const usable = templateUsable(t, conn);
    if (!usable.ok) throw new WhatsappError(`That template can't be sent: ${usable.reason}`, 409, "template_unavailable");
    if (t.category === "marketing" && info.category !== "marketing") throw new WhatsappError("That's a marketing template: choose \"Marketing\" as the reason.", 400, "category_mismatch");
    const values: Record<string, string | undefined> = { store_name: businessNameOf(input.store, settings), customer_first_name: contactFirstName(contact) ?? undefined };
    try {
      text = renderWaText(t.body, values);
    } catch (e) {
      if (e instanceof WaMissingValueError) throw new WhatsappError(`This template needs ${e.missing.map((v) => `{{${v}}}`).join(", ")}, which bizinsights doesn't have here. Write the message yourself instead.`, 400, "missing_values");
      throw e;
    }
    templateId = t.id;
    // A Cloud API number sends the template Meta approved, by its name; a linked phone sends its text.
    if (conn.provider === "cloud_api" && t.metaName) meta = { name: t.metaName, language: t.metaLanguage ?? "en", params: variablesIn(t.body).map((v) => values[v] ?? "") };
  }
  if (conn.provider === "cloud_api" && !meta && !inServiceWindow(contact)) {
    throw new WhatsappError("This customer hasn't written to you in the last 24 hours, so Meta only delivers a message template it approved. Pick an approved template instead.", 409, "outside_window");
  }

  let attachment: MessagePayload["attachment"] = null;
  let media: string | null = null;
  if (d.attachment) {
    const bytes = Buffer.from(d.attachment.data, "base64");
    if (!bytes.length || bytes.length > WA_ATTACHMENT_MAX_BYTES) throw new WhatsappError("Attachments can be at most 3 MB.", 400, "attachment_too_large");
    if (!signatureMatches(d.attachment.mime, bytes)) throw new WhatsappError("The file isn't the type it claims to be. Attach a JPEG, PNG or WebP image, or a PDF.", 400, "attachment_invalid");
    attachment = { key: "", mime: d.attachment.mime, name: d.attachment.name.replace(/[^\w.\- ]+/g, "_").slice(0, 100), kind: WA_ATTACHMENT_TYPES[d.attachment.mime]! };
    media = bytes.toString("base64");
  }

  const { message, created } = await queueMessage(deps, {
    store: input.store,
    conn,
    source: "manual",
    category: info.category,
    phone,
    contactId: contact.id,
    payload: { text, attachment, meta },
    templateId,
    idempotencyKey: `manual:${d.idempotencyKey}`,
    createdByUserId: input.userId,
    // With an attachment the file is stored first, then the message is handed to the queue.
    noEnqueue: !!media,
  });
  if (created && media) {
    await deps.payloads.put(`wapp-media/${message.id}`, media);
    await enqueueIfDue(deps, message);
  }
  if (created) {
    await audit({ workspaceId: input.store.workspaceId, actorUserId: input.userId, action: "whatsapp.message_sent", targetType: "whatsapp_message", targetId: message.id, metadata: { reason: d.reason, template: !!templateId, attachment: !!attachment, recordedConsent: d.customerAsked }, ip: input.ip });
  }
  return message;
}

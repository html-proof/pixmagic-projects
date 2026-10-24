/**
 * One message a person sends from the dashboard: an approved template to a customer who agreed to
 * receive it, or a free-form reply (text, image, document, video) to a customer who wrote within
 * the last 24 hours (Meta's customer service window). Checked here first so the person is told
 * why at once, and again right before it is sent (messages.ts).
 */
import { systemDb, type Store, type WaMessage } from "@app/db";
import { consentProblem, normalizePhone, renderTemplate, SKIP_LABEL, templateShape, type SendValues, type TemplateComponent, type TemplateMapping } from "@app/shared";
import { canSend, liveConnection, settingsOf, storeLabel, WhatsappError, type WaDeps } from "./common.js";
import { consentFacts, contactFirstName, upsertContact } from "./contacts.js";
import { queueMessage } from "./messages.js";

export type ManualMessage =
  | { kind: "template"; template: { name: string; language: string }; mapping: TemplateMapping; headerMediaUrl?: string | null }
  | { kind: "text"; body: string }
  | { kind: "media"; mediaType: "image" | "document" | "video"; link: string; caption?: string | null; filename?: string | null };

export async function sendManual(
  deps: Pick<WaDeps, "queues">,
  input: { store: Store; userId: string; to: { contactId: string } | { phone: string; country?: string | null }; message: ManualMessage; requestId: string },
): Promise<WaMessage> {
  const conn = await liveConnection(input.store.id);
  if (!canSend(conn)) throw new WhatsappError("Connect WhatsApp and finish its setup first.", 409, "not_connected");
  let contact;
  if ("contactId" in input.to) {
    contact = await systemDb.waContact.findFirst({ where: { id: input.to.contactId, storeId: input.store.id } });
    if (!contact) throw new WhatsappError("That customer wasn't found.", 404, "not_found");
  } else {
    const phone = normalizePhone(input.to.phone, input.to.country ?? null);
    if (!phone) throw new WhatsappError("That number can't be read. Use the international format, like +61412345678.", 400, "invalid_phone");
    contact = await upsertContact(input.store, phone);
  }
  if (contact.optedOut) throw new WhatsappError("This customer replied STOP: nothing can be sent to them until they reply START.", 409, "opted_out");
  const m = input.message;
  if (m.kind === "template") {
    const t = await systemDb.waTemplate.findUnique({ where: { storeId_name_language: { storeId: input.store.id, name: m.template.name, language: m.template.language } } });
    if (!t || t.status !== "APPROVED") throw new WhatsappError("Only a template Meta approved can be sent.", 409, "template_not_approved");
    const settings = await settingsOf(input.store.id);
    const problem = consentProblem(t.category, consentFacts(contact), { orderUpdates: settings.orderUpdates });
    if (problem) throw new WhatsappError(`${SKIP_LABEL[problem]}, so this template can't be sent to them.`, 409, problem);
    const values: SendValues = { customer_first_name: contactFirstName(contact) ?? undefined, store_name: storeLabel(input.store) };
    const { message } = await queueMessage(
      {
        store: input.store,
        connectionId: conn!.id,
        contact,
        source: "manual",
        idempotencyKey: `manual:${input.requestId}`,
        template: { name: t.name, language: t.language, category: t.category },
        payload: { kind: "template", mapping: m.mapping, values, headerMediaUrl: m.headerMediaUrl ?? null },
        preview: renderTemplate(t.components as unknown as TemplateComponent[], m.mapping, values).body,
        createdByUserId: input.userId,
      },
      deps,
    );
    return message;
  }
  if (!contact.lastInboundAt || Date.now() - contact.lastInboundAt.getTime() > 24 * 3600_000) {
    throw new WhatsappError("More than 24 hours since this customer last wrote, so WhatsApp allows only an approved template. Choose a template instead.", 409, "outside_window");
  }
  const preview = m.kind === "text" ? m.body : `[${m.mediaType}] ${m.caption ?? m.filename ?? ""}`.trim();
  const { message } = await queueMessage(
    {
      store: input.store,
      connectionId: conn!.id,
      contact,
      source: "manual",
      idempotencyKey: `manual:${input.requestId}`,
      payload: m.kind === "text" ? { kind: "text", body: m.body, previewUrl: /https?:\/\//.test(m.body) } : { kind: "media", mediaType: m.mediaType, link: m.link, caption: m.caption ?? null, filename: m.filename ?? null },
      preview,
      createdByUserId: input.userId,
    },
    deps,
  );
  return message;
}

/**
 * A message to the store's own team (Inventory's stock alerts): an approved template with two body
 * variables, the store's name and the alert. The team's numbers are the merchant's own, so no
 * customer consent applies. One message per number and hour.
 */
export async function queueTeamAlert(deps: Pick<WaDeps, "queues">, input: { store: Pick<Store, "id" | "workspaceId" | "name" | "shopDomain">; templateName: string; numbers: string[]; summary: string; at: Date }): Promise<number> {
  const conn = await liveConnection(input.store.id);
  if (!canSend(conn)) return 0;
  const t = await systemDb.waTemplate.findFirst({ where: { storeId: input.store.id, name: input.templateName, status: "APPROVED" } });
  if (!t) return 0;
  const shape = templateShape(t.components as unknown as TemplateComponent[]);
  if (shape.bodyVars !== 2 || shape.headerFormat !== "NONE" || shape.dynamicUrlButtons.length) return 0;
  const mapping: TemplateMapping = { body: [{ source: "store_name" }, { source: "custom_text", text: input.summary.slice(0, 200) }], buttons: [] };
  const values: SendValues = { store_name: storeLabel(input.store) };
  let queued = 0;
  for (const to of input.numbers) {
    const phone = normalizePhone(to, null);
    if (!phone) continue;
    const { created } = await queueMessage(
      {
        store: input.store,
        connectionId: conn!.id,
        to: phone.e164,
        source: "team_alert",
        idempotencyKey: `team_alert:${input.templateName}:${phone.waId}:${input.at.toISOString().slice(0, 13)}`,
        template: { name: t.name, language: t.language, category: t.category },
        payload: { kind: "template", mapping, values },
        preview: renderTemplate(t.components as unknown as TemplateComponent[], mapping, values).body,
      },
      deps,
    );
    if (created) queued++;
  }
  return queued;
}

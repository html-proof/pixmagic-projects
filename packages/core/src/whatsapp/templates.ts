/**
 * Message templates written in bizinsights (docs/whatsapp.md, "Templates"): a name, a category, a
 * text with {{variables}} and an on/off switch. A business-started message must use a template Meta
 * approved, so each one is also submitted to Meta (POST /{waba-id}/message_templates) and is used
 * only once Meta's status is APPROVED; Meta's review comes back in its webhook
 * (message_template_status_update), and the sweep asks again for those still pending.
 */
import { systemDb, type Store, type WappConnection, type WappTemplate } from "@app/db";
import { variablesIn, waHasErrors, waTemplateIssues, waTemplateSchema, type WaTemplateCategory, type WaTemplateInput } from "@app/shared";
import { logger } from "../logger.js";
import { audit } from "../notify.js";
import { WhatsappError, type WaDeps } from "./common.js";
import { createCloudTemplate, listCloudTemplates } from "./cloudApi.js";
import { providerProblem } from "./connection.js";

/** Whether a template can be sent through this connection now, and why not. */
export function templateUsable(t: Pick<WappTemplate, "active" | "metaStatus">, conn: Pick<WappConnection, "provider"> | null): { ok: boolean; reason: string | null } {
  if (!t.active) return { ok: false, reason: "The template is switched off." };
  if (t.metaStatus !== "APPROVED") {
    return { ok: false, reason: t.metaStatus ? `Meta hasn't approved it (${t.metaStatus.toLowerCase()}).` : conn?.provider === "cloud_api" ? "It hasn't been submitted to Meta yet." : "Connect WhatsApp, then submit it to Meta for approval." };
  }
  return { ok: true, reason: null };
}

export async function templateOf(storeId: string, id: string): Promise<WappTemplate | null> {
  return systemDb.wappTemplate.findFirst({ where: { id, storeId } });
}

/** What uses a template (an automation or a campaign that hasn't finished stops it being deleted). */
export async function templateUsage(storeId: string, ids: string[]) {
  const [autos, campaigns] = await Promise.all([
    systemDb.wappAutomation.groupBy({ by: ["templateId"], where: { storeId, templateId: { in: ids } }, _count: { _all: true } }),
    systemDb.wappCampaign.groupBy({ by: ["templateId"], where: { storeId, templateId: { in: ids }, status: { in: ["draft", "scheduled", "sending"] } }, _count: { _all: true } }),
  ]);
  const out = new Map<string, { automations: number; campaigns: number }>();
  for (const id of ids) out.set(id, { automations: 0, campaigns: 0 });
  for (const a of autos) out.get(a.templateId)!.automations = a._count._all;
  for (const c of campaigns) out.get(c.templateId)!.campaigns = c._count._all;
  return out;
}

function checked(data: unknown): WaTemplateInput {
  const t = waTemplateSchema.parse(data);
  const issues = waTemplateIssues(t);
  if (waHasErrors(issues)) throw new WhatsappError(issues.filter((i) => i.level === "error").map((i) => i.message).join(" "), 400, "template_invalid", { issues });
  return t;
}

export async function createWaTemplate(store: Pick<Store, "id" | "workspaceId">, input: { data: unknown; userId: string; ip?: string }): Promise<WappTemplate> {
  const t = checked(input.data);
  if (await systemDb.wappTemplate.findUnique({ where: { storeId_name: { storeId: store.id, name: t.name } } })) {
    throw new WhatsappError(`There's already a template called "${t.name}". Pick another name.`, 409, "template_exists");
  }
  const row = await systemDb.wappTemplate.create({ data: { workspaceId: store.workspaceId, storeId: store.id, name: t.name, category: t.category, body: t.body, active: t.active, createdByUserId: input.userId, updatedByUserId: input.userId } });
  await audit({ workspaceId: store.workspaceId, actorUserId: input.userId, action: "whatsapp.template_created", targetType: "whatsapp_template", targetId: row.id, metadata: { name: t.name, category: t.category }, ip: input.ip });
  return row;
}

/**
 * Edits a template. Messages already waiting keep the text they were rendered with; automations and
 * campaigns use the new one from now on. On the Cloud API an edit needs Meta's review again.
 */
export async function updateWaTemplate(store: Pick<Store, "id" | "workspaceId">, id: string, input: { data: unknown; userId: string; ip?: string }): Promise<WappTemplate> {
  const existing = await templateOf(store.id, id);
  if (!existing) throw new WhatsappError("Not found", 404, "not_found");
  const t = checked(input.data);
  if (t.name !== existing.name && (await systemDb.wappTemplate.findUnique({ where: { storeId_name: { storeId: store.id, name: t.name } } }))) {
    throw new WhatsappError(`There's already a template called "${t.name}". Pick another name.`, 409, "template_exists");
  }
  if (t.category !== existing.category) {
    const usage = (await templateUsage(store.id, [id])).get(id)!;
    if (usage.automations || usage.campaigns) throw new WhatsappError("Automations or campaigns use this template, so its category can't change. Make a new template instead.", 409, "template_in_use");
  }
  const changedText = t.body !== existing.body || t.category !== existing.category;
  const row = await systemDb.wappTemplate.update({
    where: { id },
    data: {
      name: t.name,
      category: t.category,
      body: t.body,
      active: t.active,
      updatedByUserId: input.userId,
      // Meta reviewed the old text, not this one.
      ...(changedText && existing.metaStatus ? { metaStatus: null, metaId: null, metaName: null, metaReason: null } : {}),
    },
  });
  await audit({ workspaceId: store.workspaceId, actorUserId: input.userId, action: "whatsapp.template_updated", targetType: "whatsapp_template", targetId: id, metadata: { name: t.name, active: t.active }, ip: input.ip });
  return row;
}

export async function deleteWaTemplate(store: Pick<Store, "id" | "workspaceId">, id: string, actor: { userId: string; ip?: string }) {
  const existing = await templateOf(store.id, id);
  if (!existing) throw new WhatsappError("Not found", 404, "not_found");
  const usage = (await templateUsage(store.id, [id])).get(id)!;
  if (usage.automations || usage.campaigns) {
    throw new WhatsappError(`This template is used by ${usage.automations} automation(s) and ${usage.campaigns} campaign(s). Change or delete those first.`, 409, "template_in_use");
  }
  await systemDb.wappTemplate.delete({ where: { id } });
  await audit({ workspaceId: store.workspaceId, actorUserId: actor.userId, action: "whatsapp.template_deleted", targetType: "whatsapp_template", targetId: id, metadata: { name: existing.name }, ip: actor.ip });
}

// ---------------------------------------------------------------------------
// Meta's review (Cloud API connections only)
// ---------------------------------------------------------------------------

/** Meta's template name: lower case, digits and underscores, made unique per bizinsights template. */
export const metaTemplateName = (t: Pick<WappTemplate, "id" | "name">) =>
  `${t.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40) || "template"}_${t.id.slice(-6).toLowerCase()}`;

/** A bizinsights text in Meta's form: {{customer_first_name}} becomes {{1}}, in order, with Meta's sample values. */
export function toMetaBody(body: string, samples: Record<string, string>): { text: string; order: string[]; examples: string[] } {
  const order = variablesIn(body);
  let text = body;
  order.forEach((v, i) => {
    text = text.replace(new RegExp(`\\{\\{\\s*${v}\\s*\\}\\}`, "g"), `{{${i + 1}}}`);
  });
  return { text, order, examples: order.map((v) => samples[v] ?? v) };
}

const META_CATEGORY: Record<WaTemplateCategory, "UTILITY" | "MARKETING"> = { transactional: "UTILITY", marketing: "MARKETING" };

/** Submits a template to Meta for review. Meta's answer is recorded as it comes. */
export async function submitTemplateToMeta(deps: Pick<WaDeps, "fetchImpl">, conn: WappConnection, t: WappTemplate, samples: Record<string, string>, language = "en"): Promise<WappTemplate> {
  if (conn.provider !== "cloud_api" || !conn.instanceTokenEnc || !conn.wabaId) throw new WhatsappError("Connect WhatsApp first: templates are submitted to Meta through your WhatsApp Business account.", 409, "not_cloud_api");
  const name = metaTemplateName(t);
  const body = toMetaBody(t.body, samples);
  try {
    const r = await createCloudTemplate(deps, conn, {
      name,
      category: META_CATEGORY[t.category as WaTemplateCategory],
      language,
      components: [{ type: "BODY", text: body.text, ...(body.examples.length ? { example: { body_text: [body.examples] } } : {}) }],
    });
    return systemDb.wappTemplate.update({ where: { id: t.id }, data: { metaName: name, metaLanguage: language, metaId: r.id ?? null, metaStatus: (r.status ?? "PENDING").toUpperCase(), metaReason: null, metaCheckedAt: new Date() } });
  } catch (e) {
    throw providerProblem(e);
  }
}

/** Meta's current review of every submitted template. */
export async function refreshMetaTemplates(deps: Pick<WaDeps, "fetchImpl">, conn: WappConnection): Promise<number> {
  if (conn.provider !== "cloud_api" || !conn.instanceTokenEnc || !conn.wabaId) return 0;
  const list = await listCloudTemplates(deps, conn);
  const byName = new Map(list.map((t) => [`${t.name}:${t.language}`, t]));
  const mine = await systemDb.wappTemplate.findMany({ where: { storeId: conn.storeId, metaName: { not: null } } });
  let changed = 0;
  for (const t of mine) {
    const m = byName.get(`${t.metaName}:${t.metaLanguage ?? "en"}`);
    const status = m?.status?.toUpperCase() ?? "DELETED";
    if (status !== t.metaStatus) {
      await systemDb.wappTemplate.update({ where: { id: t.id }, data: { metaStatus: status, metaReason: m?.rejected_reason ?? null, metaCheckedAt: new Date() } });
      changed++;
    }
  }
  if (changed) logger.info({ storeId: conn.storeId, changed }, "whatsapp templates: Meta's review changed");
  return changed;
}

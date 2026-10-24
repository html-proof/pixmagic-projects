/**
 * Message templates: what Meta holds in the store's WhatsApp Business Account (synced on connect,
 * on Refresh, by the health check, and kept current by Meta's template webhooks), templates the
 * merchant writes here and submits for Meta's review, and deleting them. Only a template Meta
 * approved is ever sent, and the category Meta gave it decides who may receive it.
 */
import { Prisma, systemDb, type Store, type WaConnection, type WaTemplate } from "@app/db";
import { checkTemplateDraft, hasErrors, toMetaComponents, type TemplateDraft } from "@app/shared";
import { audit } from "../notify.js";
import { providerDetail } from "../errors.js";
import type { FetchLike } from "../shopify.js";
import { WhatsappError, type WaDeps } from "./common.js";
import { metaCreateTemplate, metaDeleteTemplate, metaListTemplates, WhatsappApiError } from "./graph.js";
import { connectionToken } from "./tokens.js";

/** Replace the store's templates with what the account holds now. Returns how many there are. */
export async function syncTemplates(conn: Pick<WaConnection, "storeId" | "workspaceId" | "wabaId">, token: string, fetchImpl: FetchLike): Promise<number> {
  const list = await metaListTemplates(conn.wabaId, token, fetchImpl);
  const seen: Array<{ name: string; language: string }> = [];
  for (const t of list) {
    if (!t.name || !t.language) continue;
    seen.push({ name: t.name, language: t.language });
    const data = {
      wabaId: conn.wabaId,
      metaId: String(t.id),
      category: String(t.category ?? "").toUpperCase(),
      status: String(t.status ?? "").toUpperCase(),
      components: (t.components ?? []) as unknown as Prisma.InputJsonValue,
      rejectedReason: t.rejected_reason && t.rejected_reason !== "NONE" ? t.rejected_reason.slice(0, 300) : null,
      qualityScore: t.quality_score?.score ?? null,
    };
    await systemDb.waTemplate.upsert({
      where: { storeId_name_language: { storeId: conn.storeId, name: t.name, language: t.language } },
      create: { workspaceId: conn.workspaceId, storeId: conn.storeId, name: t.name, language: t.language, ...data },
      update: data,
    });
  }
  // Templates deleted in WhatsApp Manager, or of another account the store was connected to before.
  await systemDb.waTemplate.deleteMany({
    where: { storeId: conn.storeId, NOT: seen.length ? { OR: seen.map((s) => ({ name: s.name, language: s.language })) } : undefined },
  });
  return seen.length;
}

/** The store's template by name and language when Meta approved it, else null. */
export async function approvedTemplate(storeId: string, name: string, language: string): Promise<WaTemplate | null> {
  const t = await systemDb.waTemplate.findUnique({ where: { storeId_name_language: { storeId, name, language } } });
  return t && t.status === "APPROVED" ? t : null;
}

/** Meta's refusal of a template, in the merchant's words. */
function templateRefusal(err: WhatsappApiError): WhatsappError {
  if (err.code === 100 && /already exists|name.*(taken|exists)/i.test(err.details ?? "")) {
    return new WhatsappError("A template with this name and language already exists. Choose another name.", 409, "template_exists");
  }
  if (err.action === "reconnect") return new WhatsappError("Meta no longer accepts bizinsights' access to your WhatsApp. Reconnect WhatsApp, then try again.", 409, "reconnect_needed");
  if (err.action === "retry" || err.action === "network") return new WhatsappError("WhatsApp didn't answer just now. Try again in a minute.", 503, "meta_unavailable");
  return new WhatsappError(`Meta didn't accept the template: ${providerDetail(err.details ?? err.title) || "no reason given"}`, 400, "template_refused");
}

/** Write a template and submit it for Meta's review (usually minutes, sometimes up to a day). */
export async function submitTemplate(deps: WaDeps, input: { store: Store; draft: TemplateDraft; userId: string | null; ip?: string }): Promise<WaTemplate> {
  const issues = checkTemplateDraft(input.draft);
  if (hasErrors(issues)) throw new WhatsappError(issues.find((i) => i.level === "error")!.message, 400, "invalid_template", { issues });
  const conn = await systemDb.waConnection.findUnique({ where: { storeId: input.store.id } });
  if (!conn || conn.status === "disconnected" || !conn.nangoConnectionId) throw new WhatsappError("Connect WhatsApp before writing templates.", 409, "not_connected");
  const existing = await systemDb.waTemplate.findUnique({ where: { storeId_name_language: { storeId: input.store.id, name: input.draft.name, language: input.draft.language } } });
  if (existing) throw new WhatsappError("A template with this name and language already exists. Choose another name.", 409, "template_exists");
  const token = await connectionToken(conn, deps);
  const components = toMetaComponents(input.draft);
  let made: { id: string; status: string; category: string };
  try {
    made = await metaCreateTemplate(conn.wabaId, token, { name: input.draft.name, language: input.draft.language, category: input.draft.category, components }, deps.fetchImpl);
  } catch (err) {
    if (err instanceof WhatsappApiError) throw templateRefusal(err);
    throw err;
  }
  const row = await systemDb.waTemplate.upsert({
    where: { storeId_name_language: { storeId: input.store.id, name: input.draft.name, language: input.draft.language } },
    create: {
      workspaceId: input.store.workspaceId,
      storeId: input.store.id,
      wabaId: conn.wabaId,
      metaId: made.id,
      name: input.draft.name,
      language: input.draft.language,
      category: made.category.toUpperCase(),
      status: made.status.toUpperCase(),
      components: components as unknown as Prisma.InputJsonValue,
      createdByUserId: input.userId,
    },
    update: { metaId: made.id, status: made.status.toUpperCase(), category: made.category.toUpperCase(), components: components as unknown as Prisma.InputJsonValue },
  });
  await audit({ workspaceId: input.store.workspaceId, actorUserId: input.userId, action: "whatsapp.template_submitted", targetType: "store", targetId: input.store.id, metadata: { name: row.name, language: row.language, category: input.draft.category }, ip: input.ip });
  return row;
}

/** Delete a template at Meta and here. Refused while an active workflow or a running campaign uses it. */
export async function removeTemplate(deps: WaDeps, input: { store: Store; templateId: string; userId: string | null; ip?: string }): Promise<void> {
  const t = await systemDb.waTemplate.findFirst({ where: { id: input.templateId, storeId: input.store.id } });
  if (!t) throw new WhatsappError("That template wasn't found.", 404, "not_found");
  const [workflows, campaigns] = await Promise.all([
    systemDb.waWorkflow.count({ where: { storeId: t.storeId, templateName: t.name, templateLanguage: t.language, status: "active" } }),
    systemDb.waCampaign.count({ where: { storeId: t.storeId, templateName: t.name, templateLanguage: t.language, status: { in: ["scheduled", "sending"] } } }),
  ]);
  if (workflows || campaigns) throw new WhatsappError("This template is in use by an active workflow or a running campaign. Pause or cancel those first.", 409, "template_in_use");
  const conn = await systemDb.waConnection.findUnique({ where: { storeId: t.storeId } });
  // Disconnected: bizinsights has no access to delete it at Meta, only its own copy goes.
  if (conn?.nangoConnectionId && conn.status !== "disconnected" && conn.wabaId === t.wabaId) {
    const token = await connectionToken(conn, deps);
    try {
      await metaDeleteTemplate(conn.wabaId, token, t.name, t.metaId, deps.fetchImpl);
    } catch (err) {
      // Already gone at Meta: delete it here too.
      if (!(err instanceof WhatsappApiError && (err.code === 100 || err.httpStatus === 404))) {
        if (err instanceof WhatsappApiError) throw templateRefusal(err);
        throw err;
      }
    }
  }
  await systemDb.waTemplate.delete({ where: { id: t.id } });
  await audit({ workspaceId: t.workspaceId, actorUserId: input.userId, action: "whatsapp.template_deleted", targetType: "store", targetId: t.storeId, metadata: { name: t.name, language: t.language }, ip: input.ip });
}

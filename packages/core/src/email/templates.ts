/**
 * Email templates: written in the dashboard, sanitized and checked on save, versioned, previewed
 * with example data and sent as tests to the person editing them.
 *
 * Every save that changes what a template says makes a new version (the old one stays in
 * email_template_versions and can be restored); messages record the version they were sent with.
 */
import { systemDb, withTenant, type EmailTemplate } from "@app/db";
import {
  customDataProblems,
  isAllowedVariable,
  isEventType,
  placeholdersIn,
  sampleEventData,
  sanitizeHtml,
  templateProblems,
  type EventData,
  type TemplateInput,
} from "@app/shared/email";
import { emailAudit, EmailError, isUniqueViolation, notFound } from "./common.js";
import { businessInfo, renderEmail, type RenderedEmail } from "./render.js";

const MAX_TEMPLATES = 200;

export function publicTemplate(t: EmailTemplate) {
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    category: t.category,
    eventType: t.eventType,
    subject: t.subjectTemplate,
    html: t.htmlTemplate,
    text: t.textTemplate,
    variables: t.allowedVariables,
    version: t.version,
    status: t.status,
    replyTo: t.replyToAddress,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

/** Check and clean a template's content. Throws with every problem at once. */
function prepare(input: Pick<TemplateInput, "subject" | "html" | "text" | "eventType" | "category">) {
  if (input.eventType !== null && !isEventType(input.eventType)) throw new EmailError(`"${input.eventType}" isn't an event Insights knows.`, 400, "invalid_event");
  const html = sanitizeHtml(input.html, { allowPlaceholders: true });
  const problems = templateProblems({ subject: input.subject, html, text: input.text }, (p) => isAllowedVariable(input.eventType, input.category, p));
  if (problems.length) throw new EmailError(problems[0]!, 400, "invalid_template", { problems });
  const variables = [...new Set([...placeholdersIn(input.subject), ...placeholdersIn(html), ...placeholdersIn(input.text)])];
  return { subjectTemplate: input.subject.trim(), htmlTemplate: html, textTemplate: input.text, allowedVariables: variables };
}

export async function listTemplates(workspaceId: string) {
  return withTenant(workspaceId, (tx) => tx.emailTemplate.findMany({ where: { workspaceId, deletedAt: null }, orderBy: { updatedAt: "desc" } }));
}

export async function getTemplate(workspaceId: string, id: string) {
  const t = await withTenant(workspaceId, (tx) => tx.emailTemplate.findFirst({ where: { id, workspaceId, deletedAt: null } }));
  if (!t) throw notFound();
  return t;
}

export async function templateVersions(workspaceId: string, id: string) {
  await getTemplate(workspaceId, id);
  return withTenant(workspaceId, (tx) =>
    tx.emailTemplateVersion.findMany({ where: { workspaceId, templateId: id }, orderBy: { version: "desc" }, take: 50, select: { version: true, createdAt: true, createdByUserId: true, subjectTemplate: true } }),
  );
}

export async function createTemplate(workspaceId: string, userId: string, input: TemplateInput) {
  if ((await systemDb.emailTemplate.count({ where: { workspaceId, deletedAt: null } })) >= MAX_TEMPLATES) throw new EmailError(`A workspace can have at most ${MAX_TEMPLATES} templates.`, 409, "too_many_templates");
  const content = prepare(input);
  try {
    const t = await systemDb.$transaction(async (tx) => {
      const t = await tx.emailTemplate.create({
        data: {
          workspaceId,
          name: input.name,
          description: input.description ?? null,
          category: input.category,
          eventType: input.eventType,
          ...content,
          status: input.status,
          replyToAddress: input.replyTo ?? null,
          createdByUserId: userId,
          updatedByUserId: userId,
        },
      });
      await tx.emailTemplateVersion.create({ data: { workspaceId, templateId: t.id, version: 1, category: t.category, eventType: t.eventType, subjectTemplate: t.subjectTemplate, htmlTemplate: t.htmlTemplate, textTemplate: t.textTemplate, createdByUserId: userId } });
      return t;
    });
    await emailAudit({ workspaceId, actorUserId: userId, action: "email.template.created", targetType: "email_template", targetId: t.id, metadata: { name: t.name, status: t.status } });
    return t;
  } catch (err) {
    if (isUniqueViolation(err)) throw new EmailError(`A template called "${input.name}" already exists.`, 409, "template_exists");
    throw err;
  }
}

/** Rules that send this template and would break if it changed this way. */
async function enabledRulesUsing(workspaceId: string, templateId: string) {
  return systemDb.emailAutomationRule.findMany({ where: { workspaceId, templateId, deletedAt: null, enabled: true }, select: { id: true, name: true, eventType: true } });
}

export async function updateTemplate(workspaceId: string, id: string, userId: string, patch: Omit<Partial<TemplateInput>, "status"> & { status?: "draft" | "active" | "archived" }) {
  const t = await getTemplate(workspaceId, id);
  const next = {
    subject: patch.subject ?? t.subjectTemplate,
    html: patch.html ?? t.htmlTemplate,
    text: patch.text ?? t.textTemplate,
    eventType: patch.eventType !== undefined ? patch.eventType : t.eventType,
    category: patch.category ?? (t.category as "transactional" | "marketing"),
  };
  const content = prepare(next);
  const changed =
    content.subjectTemplate !== t.subjectTemplate || content.htmlTemplate !== t.htmlTemplate || content.textTemplate !== t.textTemplate || next.eventType !== t.eventType || next.category !== t.category;
  const rules = await enabledRulesUsing(workspaceId, t.id);
  if (rules.length) {
    if (patch.status === "draft" || patch.status === "archived") {
      throw new EmailError(`Active automations send this template (${rules.map((r) => r.name).join(", ")}). Turn them off first.`, 409, "template_in_use", { rules });
    }
    const clash = rules.filter((r) => next.eventType !== null && r.eventType !== next.eventType);
    if (clash.length) throw new EmailError(`Automations for another event send this template (${clash.map((r) => r.name).join(", ")}).`, 409, "template_in_use", { rules: clash });
  }
  try {
    const updated = await systemDb.$transaction(async (tx) => {
      const u = await tx.emailTemplate.update({
        where: { id: t.id },
        data: {
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.description !== undefined ? { description: patch.description } : {}),
          ...(patch.replyTo !== undefined ? { replyToAddress: patch.replyTo } : {}),
          ...(patch.status ? { status: patch.status } : {}),
          category: next.category,
          eventType: next.eventType,
          ...content,
          ...(changed ? { version: { increment: 1 } } : {}),
          updatedByUserId: userId,
        },
      });
      if (changed) {
        await tx.emailTemplateVersion.create({ data: { workspaceId, templateId: t.id, version: u.version, category: u.category, eventType: u.eventType, subjectTemplate: u.subjectTemplate, htmlTemplate: u.htmlTemplate, textTemplate: u.textTemplate, createdByUserId: userId } });
      }
      return u;
    });
    await emailAudit({ workspaceId, actorUserId: userId, action: "email.template.updated", targetType: "email_template", targetId: t.id, metadata: { version: updated.version, status: updated.status, contentChanged: changed } });
    return updated;
  } catch (err) {
    if (isUniqueViolation(err)) throw new EmailError(`A template called "${patch.name}" already exists.`, 409, "template_exists");
    throw err;
  }
}

export async function duplicateTemplate(workspaceId: string, id: string, userId: string) {
  const t = await getTemplate(workspaceId, id);
  for (let n = 1; n < 50; n++) {
    const name = `${t.name.slice(0, 85)} (copy${n > 1 ? ` ${n}` : ""})`;
    try {
      return await createTemplate(workspaceId, userId, {
        name,
        description: t.description,
        category: t.category as "transactional" | "marketing",
        eventType: t.eventType,
        subject: t.subjectTemplate,
        html: t.htmlTemplate,
        text: t.textTemplate,
        replyTo: t.replyToAddress,
        status: "draft",
      });
    } catch (err) {
      if (!(err instanceof EmailError && err.code === "template_exists")) throw err;
    }
  }
  throw new EmailError("Couldn't find a free name for the copy", 409, "template_exists");
}

export async function restoreTemplateVersion(workspaceId: string, id: string, version: number, userId: string) {
  const t = await getTemplate(workspaceId, id);
  const v = await systemDb.emailTemplateVersion.findUnique({ where: { templateId_version: { templateId: t.id, version } } });
  if (!v || v.workspaceId !== workspaceId) throw notFound("That version doesn't exist");
  return updateTemplate(workspaceId, id, userId, { subject: v.subjectTemplate, html: v.htmlTemplate, text: v.textTemplate, eventType: v.eventType, category: v.category as "transactional" | "marketing" });
}

export async function deleteTemplate(workspaceId: string, id: string, userId: string) {
  const t = await getTemplate(workspaceId, id);
  const used = await systemDb.emailAutomationRule.count({ where: { workspaceId, templateId: t.id, deletedAt: null } });
  if (used) throw new EmailError(`${used} automation${used === 1 ? " uses" : "s use"} this template. Delete or change ${used === 1 ? "it" : "them"} first.`, 409, "template_in_use");
  await systemDb.emailTemplate.update({ where: { id: t.id }, data: { deletedAt: new Date(), status: "archived" } });
  await emailAudit({ workspaceId, actorUserId: userId, action: "email.template.deleted", targetType: "email_template", targetId: t.id, metadata: { name: t.name } });
}

/** Example data for an event, merged with what the person typed in (validated: only plain data). */
export function previewData(eventType: string | null, custom?: unknown): EventData {
  const base = sampleEventData(eventType);
  if (custom === undefined || custom === null) return base;
  if (typeof custom !== "object" || Array.isArray(custom)) throw new EmailError("Preview data must be an object", 400, "invalid_data");
  const problems = customDataProblems((custom as { data?: unknown }).data ?? {});
  if (problems.length) throw new EmailError(problems[0]!, 400, "invalid_data");
  const merged: EventData = { ...base };
  for (const [k, v] of Object.entries(custom as Record<string, unknown>)) {
    if (!/^[a-z_]{1,40}$/.test(k)) continue;
    merged[k] = v && typeof v === "object" && !Array.isArray(v) && typeof base[k] === "object" ? { ...(base[k] as object), ...(v as object) } : v;
  }
  return JSON.parse(JSON.stringify(merged)) as EventData;
}

/** Render a template (saved or not) with example data. Marketing previews include the footer. */
export async function previewTemplate(workspaceId: string, t: { subject: string; html: string; text: string; category: string; eventType: string | null }, data?: unknown, recipient = "alex@example.com"): Promise<RenderedEmail> {
  const content = prepare({ subject: t.subject, html: t.html, text: t.text, eventType: t.eventType, category: t.category as "transactional" | "marketing" });
  return renderEmail(
    { subject: content.subjectTemplate, html: content.htmlTemplate, text: content.textTemplate, category: t.category },
    { data: previewData(t.eventType, data), business: await businessInfo(workspaceId), recipient, unsubscribeUrl: t.category === "marketing" ? "https://example.com/unsubscribe-preview" : null },
  );
}

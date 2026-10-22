/**
 * Message templates and their versions. Each edit is a new version (draft); a version is sent for
 * review, then approved by an owner or admin, and only an approved version is ever sent. A
 * template whose newer version is in draft keeps sending its approved one until the new one is
 * approved; the old one becomes "superseded" then. Every step is in sms_audit_logs with the
 * version's text, so the history can be read back.
 */
import { Prisma, systemDb, type SmsTemplate, type SmsTemplateVersion, type Store } from "@app/db";
import { checkTemplate, hasErrors, templateCan, worstCaseSegments, type SmsCategory, type TemplateIssue } from "@app/shared/sms";
import { smsAudit, SmsError } from "./common.js";

export interface TemplateInput {
  name: string;
  category: SmsCategory;
  body: string;
  dltTemplateId?: string | null;
  dltText?: string | null;
  countries?: string[];
}

export interface Actor {
  userId: string | null;
  ip?: string;
}

const snapshot = (v: Pick<SmsTemplateVersion, "version" | "category" | "body" | "dltTemplateId" | "dltText" | "status">) => ({
  version: v.version,
  category: v.category,
  body: v.body,
  dltTemplateId: v.dltTemplateId,
  dltText: v.dltText,
  status: v.status,
});

function issuesFor(t: TemplateInput, forIndia: boolean): TemplateIssue[] {
  return checkTemplate({ category: t.category, body: t.body, dltTemplateId: t.dltTemplateId, dltText: t.dltText, forIndia });
}

const versionData = (store: Pick<Store, "id" | "workspaceId">, templateId: string, version: number, t: TemplateInput, actor: Actor) => {
  const worst = worstCaseSegments(t.body);
  return {
    workspaceId: store.workspaceId,
    storeId: store.id,
    templateId,
    version,
    category: t.category,
    body: t.body,
    dltTemplateId: t.dltTemplateId ?? null,
    dltText: t.dltText ?? null,
    encoding: worst.encoding,
    segments: worst.segments,
    status: "draft",
    createdBy: actor.userId,
  };
};

/** Create a template (its version 1, a draft). Problems that are errors are refused; warnings are returned. */
export async function createTemplate(store: Pick<Store, "id" | "workspaceId">, t: TemplateInput, actor: Actor): Promise<{ template: SmsTemplate; issues: TemplateIssue[] }> {
  const forIndia = (t.countries ?? []).includes("IN");
  const issues = issuesFor(t, forIndia);
  if (hasErrors(issues)) throw new SmsError(issues.find((i) => i.level === "error")!.message, 400, "template_invalid", { issues });
  try {
    const template = await systemDb.$transaction(async (tx) => {
      const created = await tx.smsTemplate.create({
        data: { workspaceId: store.workspaceId, storeId: store.id, name: t.name, category: t.category, status: "draft", latestVersion: 1, countries: t.countries ?? [], createdBy: actor.userId },
      });
      await tx.smsTemplateVersion.create({ data: versionData(store, created.id, 1, t, actor) });
      return created;
    });
    await smsAudit({ workspaceId: store.workspaceId, storeId: store.id, actorUserId: actor.userId, action: "template_created", targetType: "sms_template", targetId: template.id, version: 1, snapshot: { name: t.name, ...snapshot({ version: 1, category: t.category, body: t.body, dltTemplateId: t.dltTemplateId ?? null, dltText: t.dltText ?? null, status: "draft" }) }, ip: actor.ip });
    return { template, issues };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw new SmsError("A template with this name already exists.", 409, "template_exists");
    throw e;
  }
}

export async function templateOf(storeId: string, id: string) {
  const t = await systemDb.smsTemplate.findFirst({ where: { id, storeId }, include: { versions: { orderBy: { version: "desc" } } } });
  if (!t) throw new SmsError("Template not found.", 404, "not_found");
  return t;
}

/**
 * Save an edit. A latest version still in draft is edited in place (no one has reviewed it);
 * otherwise the edit becomes a new draft version and the approved one keeps sending.
 */
export async function updateTemplate(store: Pick<Store, "id" | "workspaceId">, id: string, t: TemplateInput, actor: Actor) {
  const current = await templateOf(store.id, id);
  if (current.status === "archived") throw new SmsError("Restore the template before editing it.", 409, "template_archived");
  const forIndia = (t.countries ?? current.countries).includes("IN");
  const issues = issuesFor(t, forIndia);
  if (hasErrors(issues)) throw new SmsError(issues.find((i) => i.level === "error")!.message, 400, "template_invalid", { issues });
  const latest = current.versions[0]!;
  const inPlace = latest.status === "draft";
  const version = inPlace ? latest.version : latest.version + 1;
  try {
    await systemDb.$transaction(async (tx) => {
      if (inPlace) {
        const v = versionData(store, id, version, t, actor);
        await tx.smsTemplateVersion.update({ where: { id: latest.id }, data: { category: v.category, body: v.body, dltTemplateId: v.dltTemplateId, dltText: v.dltText, encoding: v.encoding, segments: v.segments } });
      } else {
        // An edit while in review takes the version out of review: what was reviewed isn't what's there now.
        if (latest.status === "in_review") await tx.smsTemplateVersion.update({ where: { id: latest.id }, data: { status: "rejected", reviewNote: "Replaced by an edit before review." } });
        await tx.smsTemplateVersion.create({ data: versionData(store, id, version, t, actor) });
      }
      // The template's category is the approved version's: an edit to another category counts only once it is approved.
      await tx.smsTemplate.update({ where: { id }, data: { name: t.name, category: current.approvedVersion ? current.category : t.category, latestVersion: version, status: "draft", countries: t.countries ?? current.countries } });
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw new SmsError("A template with this name already exists.", 409, "template_exists");
    throw e;
  }
  await smsAudit({ workspaceId: store.workspaceId, storeId: store.id, actorUserId: actor.userId, action: "template_edited", targetType: "sms_template", targetId: id, version, snapshot: { name: t.name, ...snapshot({ version, category: t.category, body: t.body, dltTemplateId: t.dltTemplateId ?? null, dltText: t.dltText ?? null, status: "draft" }) }, ip: actor.ip });
  return { template: await templateOf(store.id, id), issues };
}

/**
 * Review steps on the latest version: submit (draft → in review), approve (in review → approved:
 * the version messages use from now on), reject (back to draft, with a note), archive, restore.
 */
export async function templateAction(store: Pick<Store, "id" | "workspaceId">, id: string, action: "submit" | "approve" | "reject" | "archive" | "restore", actor: Actor, note?: string | null) {
  const t = await templateOf(store.id, id);
  const latest = t.versions[0]!;
  const now = new Date();
  if (action === "archive" || action === "restore") {
    if (!templateCan(t.status, action)) throw new SmsError(action === "archive" ? "This template is archived already." : "This template isn't archived.", 409, "template_state");
    if (action === "archive") {
      const using = await systemDb.smsAutomationRule.count({ where: { storeId: store.id, status: { in: ["active", "paused", "pending_approval"] }, OR: [{ config: { path: ["templateId"], equals: id } }, { activeConfig: { path: ["templateId"], equals: id } }] } });
      const campaigns = await systemDb.smsCampaign.count({ where: { storeId: store.id, templateId: id, status: { in: ["pending_approval", "approved", "scheduled", "sending", "paused"] } } });
      if (using || campaigns) throw new SmsError(`This template is used by ${using} rule${using === 1 ? "" : "s"} and ${campaigns} campaign${campaigns === 1 ? "" : "s"}. Disable them first.`, 409, "template_in_use");
    }
    await systemDb.smsTemplate.update({ where: { id }, data: { status: action === "archive" ? "archived" : latest.status === "approved" ? "approved" : "draft" } });
    await smsAudit({ workspaceId: store.workspaceId, storeId: store.id, actorUserId: actor.userId, action: `template_${action}d`, targetType: "sms_template", targetId: id, version: latest.version, ip: actor.ip });
    return templateOf(store.id, id);
  }
  if (t.status === "archived") throw new SmsError("Restore the template first.", 409, "template_archived");
  if (!templateCan(latest.status, action)) {
    const what = { submit: "Only a draft can be sent for review.", approve: "Only a version in review can be approved.", reject: "Only a version in review can be sent back." }[action];
    throw new SmsError(what, 409, "template_state");
  }
  if (action === "submit" || action === "approve") {
    const issues = checkTemplate({ category: latest.category as SmsCategory, body: latest.body, dltTemplateId: latest.dltTemplateId, dltText: latest.dltText, forIndia: t.countries.includes("IN") });
    if (hasErrors(issues)) throw new SmsError(issues.find((i) => i.level === "error")!.message, 400, "template_invalid", { issues });
  }
  await systemDb.$transaction(async (tx) => {
    if (action === "submit") {
      await tx.smsTemplateVersion.update({ where: { id: latest.id }, data: { status: "in_review", submittedBy: actor.userId, submittedAt: now } });
      await tx.smsTemplate.update({ where: { id }, data: { status: "in_review" } });
    } else if (action === "reject") {
      await tx.smsTemplateVersion.update({ where: { id: latest.id }, data: { status: "draft", reviewNote: note?.slice(0, 500) ?? null } });
      await tx.smsTemplate.update({ where: { id }, data: { status: "draft" } });
    } else {
      await tx.smsTemplateVersion.updateMany({ where: { templateId: id, status: "approved" }, data: { status: "superseded" } });
      await tx.smsTemplateVersion.update({ where: { id: latest.id }, data: { status: "approved", approvedBy: actor.userId, approvedAt: now, reviewNote: note?.slice(0, 500) ?? null } });
      await tx.smsTemplate.update({ where: { id }, data: { status: "approved", approvedVersion: latest.version, category: latest.category } });
    }
  });
  await smsAudit({
    workspaceId: store.workspaceId,
    storeId: store.id,
    actorUserId: actor.userId,
    action: { submit: "template_submitted", approve: "template_approved", reject: "template_rejected" }[action],
    targetType: "sms_template",
    targetId: id,
    version: latest.version,
    snapshot: snapshot({ ...latest, status: action === "submit" ? "in_review" : action === "approve" ? "approved" : "draft" }),
    metadata: note ? { note: note.slice(0, 500) } : undefined,
    ip: actor.ip,
  });
  return templateOf(store.id, id);
}

/** The version messages from this template use now, or null when none is approved (or the template is archived). */
export async function approvedVersionOf(storeId: string, templateId: string): Promise<(SmsTemplateVersion & { template: SmsTemplate }) | null> {
  const t = await systemDb.smsTemplate.findFirst({ where: { id: templateId, storeId } });
  if (!t || t.status === "archived" || !t.approvedVersion) return null;
  const v = await systemDb.smsTemplateVersion.findUnique({ where: { templateId_version: { templateId, version: t.approvedVersion } } });
  return v ? { ...v, template: t } : null;
}

/** A version that was approved at some point (a message keeps the version it was scheduled with). */
export async function sendableVersion(templateId: string, version: number): Promise<(SmsTemplateVersion & { template: SmsTemplate }) | null> {
  const v = await systemDb.smsTemplateVersion.findUnique({ where: { templateId_version: { templateId, version } }, include: { template: true } });
  if (!v || !v.approvedAt || v.template.status === "archived") return null;
  return v;
}

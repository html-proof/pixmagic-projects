/**
 * Campaigns: an approved Marketing template to the customers who agreed to WhatsApp marketing (and
 * never replied STOP), filtered by an audience, now or at a chosen time.
 *
 *  - Scheduling needs a working connection, a registered number subscribed to its webhooks (so STOP
 *    replies arrive), an approved Marketing template with every variable filled, and the merchant
 *    confirming the exact recipient count the estimate showed.
 *  - At its time it starts sending: its messages are made in batches of 500 (one per customer: the
 *    idempotency key is the campaign and the contact, so a batch run twice makes nothing twice),
 *    spread over time at CAMPAIGN_SENDS_PER_SECOND, and each one is checked again right before it goes
 *    (consent, the campaign not cancelled).
 *  - Cancel stops everything still waiting; what Meta already has can't be called back.
 */
import { Prisma, systemDb, type Store, type WaCampaign, type WaConnection, type WaTemplate } from "@app/db";
import {
  audienceSchema,
  CAMPAIGN_MAX_RECIPIENTS,
  CAMPAIGN_SENDS_PER_SECOND,
  CAMPAIGN_VARIABLES,
  campaignCan,
  campaignSchema,
  renderTemplate,
  templateShape,
  type CampaignAudience,
  type CampaignInput,
  type TemplateComponent,
  type TemplateMapping,
} from "@app/shared";
import { logger } from "../logger.js";
import { audit } from "../notify.js";
import { canSend, liveConnection, storeLabel, waQueue, WhatsappError, type WaDeps } from "./common.js";
import { contactFirstName } from "./contacts.js";
import { cancelQueued, enqueueSend, queueMessage } from "./messages.js";
import { sendTest } from "./workflows.js";

/** The customers an audience reaches: opted in to marketing, never STOP. */
export function audienceWhere(storeId: string, a: CampaignAudience, now = new Date()): Prisma.WaContactWhereInput {
  const day = 86_400_000;
  const and: Prisma.WaContactWhereInput[] = [];
  if (a.countries.length) and.push({ country: { in: a.countries } });
  if (a.customerType === "new") and.push({ ordersCount: 1 });
  if (a.customerType === "returning") and.push({ ordersCount: { gte: 2 } });
  if (a.minOrders) and.push({ ordersCount: { gte: a.minOrders } });
  if (a.minSpent) and.push({ totalSpent: { gte: a.minSpent } });
  if (a.orderedWithinDays) and.push({ lastOrderAt: { gte: new Date(now.getTime() - a.orderedWithinDays * day) } });
  if (a.notOrderedForDays) and.push({ OR: [{ lastOrderAt: { lt: new Date(now.getTime() - a.notOrderedForDays * day) } }, { lastOrderAt: null }] });
  return { storeId, optedOut: false, marketing: "opted_in", ...(and.length ? { AND: and } : {}) };
}

export async function estimateAudience(storeId: string, audience: unknown): Promise<number> {
  return systemDb.waContact.count({ where: audienceWhere(storeId, audienceSchema.parse(audience)) });
}

export function campaignInput(c: WaCampaign): CampaignInput {
  return {
    name: c.name,
    template: { name: c.templateName, language: c.templateLanguage },
    mapping: c.mapping as unknown as TemplateMapping,
    headerMediaUrl: c.headerMediaUrl,
    audience: audienceSchema.parse(c.audience ?? {}),
  };
}

/** Why a campaign can't be scheduled (empty: it can). */
export function campaignProblems(input: CampaignInput, ctx: { template: WaTemplate | null; conn: WaConnection | null }): string[] {
  const out: string[] = [];
  if (!canSend(ctx.conn)) out.push("Connect WhatsApp and finish its setup first.");
  else if (!ctx.conn!.subscribedAt) out.push("bizinsights isn't receiving your WhatsApp replies yet (so STOP can't be heard). Press Check again on the Overview.");
  const t = ctx.template;
  if (!t) out.push(`The template "${input.template.name}" (${input.template.language}) isn't in your WhatsApp account.`);
  else if (t.status !== "APPROVED") out.push(`The template "${t.name}" isn't approved by Meta yet.`);
  else if (t.category !== "MARKETING") out.push("Campaigns send offers and news: choose a template Meta approved as Marketing.");
  if (t) {
    const shape = templateShape(t.components as unknown as TemplateComponent[]);
    if (input.mapping.body.length < shape.bodyVars) out.push(`Choose what fills each of the template's ${shape.bodyVars} variables.`);
    if (shape.headerVars && !input.mapping.header) out.push("Choose what fills the template's header.");
    if (shape.dynamicUrlButtons.length > input.mapping.buttons.length) out.push("Choose what completes the template's link button.");
    if (["IMAGE", "VIDEO", "DOCUMENT"].includes(shape.headerFormat) && !input.headerMediaUrl) out.push(`Add the link to the ${shape.headerFormat.toLowerCase()} the template's header shows.`);
  }
  const refs = [...input.mapping.body, ...input.mapping.buttons, ...(input.mapping.header ? [input.mapping.header] : [])];
  if (refs.some((r) => !CAMPAIGN_VARIABLES.includes(r.source))) out.push("A campaign knows only the customer's first name, your store's name and fixed text.");
  if (refs.some((r) => r.source === "custom_text" && !r.text)) out.push("Write the fixed text for each variable that uses it.");
  return out;
}

async function templateOf(storeId: string, ref: { name: string; language: string }) {
  return systemDb.waTemplate.findUnique({ where: { storeId_name_language: { storeId, name: ref.name, language: ref.language } } });
}

async function campaignOf(storeId: string, id: string): Promise<WaCampaign> {
  const c = await systemDb.waCampaign.findFirst({ where: { id, storeId } });
  if (!c) throw new WhatsappError("That campaign wasn't found.", 404, "not_found");
  return c;
}

export async function storedCampaignProblems(c: WaCampaign): Promise<string[]> {
  return campaignProblems(campaignInput(c), { template: await templateOf(c.storeId, { name: c.templateName, language: c.templateLanguage }), conn: await liveConnection(c.storeId) });
}

/** Save a draft (new, or an edit of one). */
export async function saveCampaign(input: { store: Store; userId: string | null; id?: string; data: unknown; ip?: string }): Promise<WaCampaign> {
  const d = campaignSchema.parse(input.data);
  const row = {
    name: d.name,
    templateName: d.template.name,
    templateLanguage: d.template.language,
    mapping: d.mapping as unknown as Prisma.InputJsonValue,
    headerMediaUrl: d.headerMediaUrl ?? null,
    audience: d.audience as unknown as Prisma.InputJsonValue,
  };
  if (input.id) {
    const c = await campaignOf(input.store.id, input.id);
    if (!campaignCan(c.status, "edit")) throw new WhatsappError("Only a draft can be changed. Cancel it and make a copy instead.", 409, "not_editable");
    return systemDb.waCampaign.update({ where: { id: c.id }, data: row });
  }
  const made = await systemDb.waCampaign.create({ data: { workspaceId: input.store.workspaceId, storeId: input.store.id, ...row, status: "draft", createdByUserId: input.userId } });
  await audit({ workspaceId: input.store.workspaceId, actorUserId: input.userId, action: "whatsapp.campaign_created", targetType: "whatsapp_campaign", targetId: made.id, metadata: { name: made.name }, ip: input.ip });
  return made;
}

export async function deleteCampaign(input: { store: Store; id: string; userId: string | null; ip?: string }): Promise<void> {
  const c = await campaignOf(input.store.id, input.id);
  if (!campaignCan(c.status, "delete")) throw new WhatsappError("A campaign that is scheduled or sending can't be deleted. Cancel it first.", 409, "not_deletable");
  await systemDb.waCampaign.delete({ where: { id: c.id } });
  await audit({ workspaceId: input.store.workspaceId, actorUserId: input.userId, action: "whatsapp.campaign_deleted", targetType: "whatsapp_campaign", targetId: c.id, metadata: { name: c.name }, ip: input.ip });
}

/** The campaign's message, to the merchant's own test number. */
export async function testCampaign(deps: Pick<WaDeps, "queues">, input: { store: Store; id: string; userId: string | null }) {
  const c = await campaignOf(input.store.id, input.id);
  if (!campaignCan(c.status, "test")) throw new WhatsappError("This campaign has already started.", 409, "not_testable");
  const message = await sendTest(deps, { store: input.store, userId: input.userId, template: { name: c.templateName, language: c.templateLanguage }, mapping: c.mapping as unknown as TemplateMapping, headerMediaUrl: c.headerMediaUrl, label: `campaign:${c.id}` });
  await systemDb.waCampaign.update({ where: { id: c.id }, data: { lastTestAt: new Date() } });
  return message;
}

/**
 * Schedule a draft: at `scheduledAt`, or now (null). `confirmRecipients` must be the count the
 * merchant was shown, so nobody schedules a send larger than they meant.
 */
export async function scheduleCampaign(deps: Pick<WaDeps, "queues">, input: { store: Store; id: string; userId: string | null; scheduledAt: Date | null; confirmRecipients: number; ip?: string }): Promise<WaCampaign> {
  const c = await campaignOf(input.store.id, input.id);
  if (!campaignCan(c.status, "schedule")) throw new WhatsappError("This campaign is already scheduled or sent.", 409, "not_schedulable");
  const problems = await storedCampaignProblems(c);
  if (problems.length) throw new WhatsappError(problems[0]!, 409, "campaign_problems", { problems });
  const count = await estimateAudience(c.storeId, c.audience);
  if (!count) throw new WhatsappError("Nobody in this audience has agreed to WhatsApp marketing yet.", 409, "empty_audience");
  if (count > CAMPAIGN_MAX_RECIPIENTS) throw new WhatsappError(`A campaign can reach up to ${CAMPAIGN_MAX_RECIPIENTS.toLocaleString("en")} customers. Narrow the audience.`, 409, "too_many_recipients");
  if (count !== input.confirmRecipients) throw new WhatsappError(`The audience is now ${count.toLocaleString("en")} customers, not ${input.confirmRecipients.toLocaleString("en")}. Check it and confirm again.`, 409, "recipients_changed", { count });
  const now = new Date();
  if (input.scheduledAt && input.scheduledAt.getTime() > now.getTime() + 90 * 86_400_000) throw new WhatsappError("Schedule it within the next 90 days.", 400, "too_far");
  const at = input.scheduledAt && input.scheduledAt > now ? input.scheduledAt : now;
  const updated = await systemDb.waCampaign.update({ where: { id: c.id }, data: { status: "scheduled", scheduledAt: at, estimatedRecipients: count, scheduledByUserId: input.userId } });
  await audit({ workspaceId: input.store.workspaceId, actorUserId: input.userId, action: "whatsapp.campaign_scheduled", targetType: "whatsapp_campaign", targetId: c.id, metadata: { name: c.name, recipients: count, at: at.toISOString() }, ip: input.ip });
  if (at <= now) return startCampaign(updated, deps);
  return updated;
}

/** Its time has come: sending, and the first batch on its way. */
async function startCampaign(c: WaCampaign, deps: Pick<WaDeps, "queues">): Promise<WaCampaign> {
  const r = await systemDb.waCampaign.updateMany({ where: { id: c.id, status: "scheduled" }, data: { status: "sending", startedAt: new Date() } });
  if (!r.count) return (await systemDb.waCampaign.findUnique({ where: { id: c.id } })) ?? c;
  await waQueue(deps.queues).send({ kind: "whatsapp_dispatch", campaignId: c.id, storeId: c.storeId });
  return (await systemDb.waCampaign.findUnique({ where: { id: c.id } }))!;
}

/** Scheduled campaigns whose time has come (the sweep). */
export async function startDueCampaigns(deps: Pick<WaDeps, "queues">): Promise<number> {
  const due = await systemDb.waCampaign.findMany({ where: { status: "scheduled", scheduledAt: { lte: new Date() } }, take: 50 });
  for (const c of due) await startCampaign(c, deps);
  return due.length;
}

const BATCH = 500;

/** Make the next batch of a sending campaign's messages; queue the next batch until everyone has one. */
export async function dispatchCampaign(job: { campaignId: string; storeId: string }, deps: Pick<WaDeps, "queues" | "coord">): Promise<{ made: number; done: boolean }> {
  const lease = `wa-dispatch:${job.campaignId}`;
  if (!(await deps.coord.acquire(lease, 120_000))) return { made: 0, done: false };
  try {
    const c = await systemDb.waCampaign.findUnique({ where: { id: job.campaignId } });
    if (!c || c.status !== "sending" || c.materializedAt) return { made: 0, done: true };
    const conn = await liveConnection(c.storeId);
    const store = await systemDb.store.findUnique({ where: { id: c.storeId } });
    if (!conn || !store) {
      await cancelCampaign({ store: store ?? ({ id: c.storeId, workspaceId: c.workspaceId } as Store), id: c.id, userId: null, reason: "disconnected" });
      return { made: 0, done: true };
    }
    const template = await templateOf(c.storeId, { name: c.templateName, language: c.templateLanguage });
    if (!template || template.status !== "APPROVED") {
      await cancelCampaign({ store, id: c.id, userId: null, reason: "template_not_approved" });
      return { made: 0, done: true };
    }
    const audience = audienceSchema.parse(c.audience ?? {});
    const contacts = await systemDb.waContact.findMany({
      where: { ...audienceWhere(c.storeId, audience, c.startedAt ?? new Date()), ...(c.cursor ? { id: { gt: c.cursor } } : {}) },
      orderBy: { id: "asc" },
      take: BATCH,
    });
    const mapping = c.mapping as unknown as TemplateMapping;
    const components = template.components as unknown as TemplateComponent[];
    const start = Date.now();
    let made = 0;
    for (const contact of contacts) {
      if (c.recipients + made >= CAMPAIGN_MAX_RECIPIENTS) break;
      const values = { customer_first_name: contactFirstName(contact) ?? undefined, store_name: storeLabel(store) };
      // Spread from the campaign's start at a steady pace: recipient i goes i / rate seconds in
      // (or now, when making the batch fell behind).
      const sendAfter = new Date((c.startedAt ?? new Date(start)).getTime() + Math.floor((c.recipients + made) / CAMPAIGN_SENDS_PER_SECOND) * 1000);
      const { message, created } = await queueMessage(
        {
          store,
          connectionId: conn.id,
          contact,
          source: "campaign",
          campaignId: c.id,
          idempotencyKey: `campaign:${c.id}:${contact.id}`,
          template: { name: template.name, language: template.language, category: template.category },
          payload: { kind: "template", mapping, values, headerMediaUrl: c.headerMediaUrl },
          preview: renderTemplate(components, mapping, values).body,
          sendAfter: sendAfter.getTime() > start ? sendAfter : new Date(start),
        },
        deps,
        { enqueue: false },
      );
      if (created) {
        made++;
        await enqueueSend(message, deps);
      }
    }
    const last = contacts.at(-1);
    const done = contacts.length < BATCH;
    await systemDb.waCampaign.update({
      where: { id: c.id },
      data: { recipients: { increment: made }, ...(last ? { cursor: last.id } : {}), ...(done ? { materializedAt: new Date() } : {}) },
    });
    if (!done) await waQueue(deps.queues).send({ kind: "whatsapp_dispatch", campaignId: c.id, storeId: c.storeId }, { delaySeconds: 5 });
    logger.info({ campaignId: c.id, made, done }, "whatsapp campaign batch made");
    return { made, done };
  } finally {
    await deps.coord.release(lease).catch(() => undefined);
  }
}

/** Cancel a scheduled or sending campaign: whatever hasn't gone to Meta yet won't. */
export async function cancelCampaign(input: { store: Pick<Store, "id" | "workspaceId">; id: string; userId: string | null; reason?: string; ip?: string }): Promise<{ campaign: WaCampaign; cancelled: number }> {
  const c = await campaignOf(input.store.id, input.id);
  if (!campaignCan(c.status, "cancel")) throw new WhatsappError("Only a scheduled or sending campaign can be cancelled.", 409, "not_cancellable");
  const campaign = await systemDb.waCampaign.update({ where: { id: c.id }, data: { status: "cancelled", cancelledAt: new Date(), cancelReason: input.reason ?? "merchant" } });
  const cancelled = await cancelQueued({ campaignId: c.id }, "campaign_cancelled");
  await audit({ workspaceId: input.store.workspaceId, actorUserId: input.userId, action: "whatsapp.campaign_cancelled", targetType: "whatsapp_campaign", targetId: c.id, metadata: { name: c.name, cancelled, reason: input.reason ?? "merchant" }, ip: input.ip });
  return { campaign, cancelled };
}

/** Sending campaigns with every message made and none left waiting: completed (the sweep). */
export async function completeCampaigns(): Promise<number> {
  const sending = await systemDb.waCampaign.findMany({ where: { status: "sending", materializedAt: { not: null } }, select: { id: true }, take: 200 });
  let n = 0;
  for (const c of sending) {
    const waiting = await systemDb.waMessage.count({ where: { campaignId: c.id, status: { in: ["queued", "sending"] } } });
    if (waiting) continue;
    const r = await systemDb.waCampaign.updateMany({ where: { id: c.id, status: "sending" }, data: { status: "completed", completedAt: new Date() } });
    n += r.count;
  }
  return n;
}

/** A batch chain that stopped (a lost queue message, a failed job): picked up again (the sweep). */
export async function resumeStalledDispatch(deps: Pick<WaDeps, "queues">): Promise<number> {
  const stalled = await systemDb.waCampaign.findMany({ where: { status: "sending", materializedAt: null, updatedAt: { lt: new Date(Date.now() - 15 * 60_000) } }, take: 50 });
  for (const c of stalled) await waQueue(deps.queues).send({ kind: "whatsapp_dispatch", campaignId: c.id, storeId: c.storeId });
  return stalled.length;
}

/** Each status's count for a campaign's messages, and the commonest failure reasons. */
export async function campaignReport(campaignId: string) {
  const [byStatus, failures] = await Promise.all([
    systemDb.waMessage.groupBy({ by: ["status"], where: { campaignId }, _count: { _all: true } }),
    systemDb.waMessage.groupBy({ by: ["errorCode", "errorTitle", "reason"], where: { campaignId, status: { in: ["failed", "skipped"] } }, _count: { _all: true }, orderBy: { _count: { id: "desc" } }, take: 10 }),
  ]);
  const count = (s: string) => byStatus.find((b) => b.status === s)?._count._all ?? 0;
  return {
    total: byStatus.reduce((a, b) => a + b._count._all, 0),
    queued: count("queued") + count("sending"),
    sent: count("accepted") + count("sent"),
    delivered: count("delivered"),
    read: count("read"),
    failed: count("failed"),
    skipped: count("skipped"),
    cancelled: count("cancelled"),
    failures: failures.map((f) => ({ code: f.errorCode, title: f.errorTitle, reason: f.reason, count: f._count._all })),
  };
}

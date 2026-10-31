/**
 * Customer segments and marketing campaigns.
 *
 * A campaign only ever reaches contacts subscribed to the store's SMS marketing and not
 * suppressed, whatever its filter says. It is written (draft), sent for approval, approved by an
 * owner or admin (which fixes the template version it sends), then scheduled with the exact
 * recipient count confirmed and the budget checked. Nothing is sent because a date comes near:
 * a scheduled campaign starts on the 15-minute sweep after its time, and each text re-checks
 * consent when it goes. Marketing must be switched on for the platform and for the store.
 */
import { Prisma, systemDb, type SmsCampaign, type Store } from "@app/db";
import { budgetAllows, estimateCostUsd, segmentFilterSchema, smsCampaignCan, smsCampaignEditable, smsCampaignSchema, type RuleCondition, type SegmentFilter, type SmsCampaignAction } from "@app/shared/sms";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { marketingSwitchedOn, monthSpend, partPrice, senderOf, senderProblem, smsAudit, SmsError, smsMode, type SmsDeps } from "./common.js";
import { scheduleSms } from "./messages.js";
import { approvedVersionOf, type Actor } from "./templates.js";

// ---------------------------------------------------------------------------
// Segments
// ---------------------------------------------------------------------------

/**
 * The contacts a filter reaches: subscribed, not suppressed, and matching every part of the filter.
 * `consent: "any"` drops the marketing consent (order updates limited to a segment): opted-out numbers are still left out.
 */
export function segmentWhere(storeId: string, f: SegmentFilter, now = new Date(), consent: "marketing" | "any" = "marketing"): Prisma.SmsContactWhereInput {
  const and: Prisma.SmsContactWhereInput[] = [consent === "marketing" ? { storeId, consentState: "subscribed", suppressedAll: false, suppressedMarketing: false } : { storeId, suppressedAll: false }];
  if (f.countries.length) and.push({ country: { in: f.countries } });
  if (f.minOrders != null) and.push({ ordersCount: { gte: f.minOrders } });
  if (f.maxOrders != null) and.push({ ordersCount: { lte: f.maxOrders } });
  if (f.minSpent != null) and.push({ totalSpent: { gte: f.minSpent } });
  if (f.orderedWithinDays != null) and.push({ lastOrderAt: { gte: new Date(now.getTime() - f.orderedWithinDays * 86400_000) } });
  if (f.inactiveForDays != null) and.push({ lastOrderAt: { lt: new Date(now.getTime() - f.inactiveForDays * 86400_000) } });
  return { AND: and };
}

/**
 * A rule's conditions on a contact's own facts (country, orders, spend, days since the last order),
 * as a query: the same reading as evaluateRuleConditions, where a missing fact fails. Order facts
 * (total, product, tag) aren't a contact's and are left to the rule.
 */
export function contactConditionsWhere(conditions: RuleCondition[], now = new Date()): Prisma.SmsContactWhereInput {
  const day = 86400_000;
  const and: Prisma.SmsContactWhereInput[] = [];
  for (const c of conditions) {
    if (c.field === "country") and.push(c.op === "in" ? { country: { in: c.value } } : { AND: [{ country: { not: null } }, { country: { notIn: c.value } }] });
    else if (c.field === "customer_orders") and.push({ ordersCount: c.op === "gte" ? { gte: c.value } : { lte: c.value } });
    else if (c.field === "customer_spent") and.push({ totalSpent: c.op === "gte" ? { gte: c.value } : { lte: c.value } });
    else if (c.field === "days_since_last_order")
      and.push({ lastOrderAt: c.op === "gte" ? { lte: new Date(now.getTime() - c.value * day) } : { gt: new Date(now.getTime() - (c.value + 1) * day) } });
  }
  return { AND: and };
}

export async function estimateSegment(storeId: string, raw: unknown): Promise<{ recipients: number; byCountry: Array<{ country: string | null; count: number }> }> {
  const f = segmentFilterSchema.parse(raw ?? {});
  const where = segmentWhere(storeId, f);
  const [recipients, groups] = await Promise.all([systemDb.smsContact.count({ where }), systemDb.smsContact.groupBy({ by: ["country"], where, _count: true })]);
  return { recipients, byCountry: groups.map((g) => ({ country: g.country, count: g._count })).sort((a, b) => b.count - a.count) };
}

export async function saveSegment(store: Pick<Store, "id" | "workspaceId">, id: string | null, name: string, raw: unknown, actor: Actor) {
  const filter = segmentFilterSchema.parse(raw ?? {});
  const clean = name.trim().slice(0, 80);
  if (!clean) throw new SmsError("Name the segment.", 400, "name_required");
  try {
    const seg = id
      ? await systemDb.smsSegment.update({ where: { id: (await segmentOf(store.id, id)).id }, data: { name: clean, filter } })
      : await systemDb.smsSegment.create({ data: { workspaceId: store.workspaceId, storeId: store.id, name: clean, filter, createdBy: actor.userId } });
    await smsAudit({ workspaceId: store.workspaceId, storeId: store.id, actorUserId: actor.userId, action: id ? "segment_edited" : "segment_created", targetType: "sms_segment", targetId: seg.id, snapshot: { name: clean, filter }, ip: actor.ip });
    return seg;
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw new SmsError("A segment with this name already exists.", 409, "segment_exists");
    throw e;
  }
}

export async function segmentOf(storeId: string, id: string) {
  const s = await systemDb.smsSegment.findFirst({ where: { id, storeId } });
  if (!s) throw new SmsError("Segment not found.", 404, "not_found");
  return s;
}

export async function deleteSegment(store: Pick<Store, "id" | "workspaceId">, id: string, actor: Actor) {
  const seg = await segmentOf(store.id, id);
  const used = await systemDb.smsCampaign.count({ where: { storeId: store.id, segmentId: id, status: { notIn: ["completed", "cancelled"] } } });
  if (used) throw new SmsError("A campaign still uses this segment.", 409, "segment_in_use");
  const automations = await systemDb.smsAutomationRule.findMany({
    where: { storeId: store.id, OR: [{ config: { path: ["audience", "segmentId"], equals: id } }, { activeConfig: { path: ["audience", "segmentId"], equals: id } }] },
    select: { name: true },
    take: 3,
  });
  if (automations.length) throw new SmsError(`An automation still uses this segment (${automations.map((a) => `"${a.name}"`).join(", ")}): change or delete it first.`, 409, "segment_in_use");
  await systemDb.smsSegment.delete({ where: { id: seg.id } });
  await smsAudit({ workspaceId: store.workspaceId, storeId: store.id, actorUserId: actor.userId, action: "segment_deleted", targetType: "sms_segment", targetId: id, ip: actor.ip });
}

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

async function campaignFilter(storeId: string, segmentId: string | null | undefined, filter: SegmentFilter): Promise<SegmentFilter> {
  if (!segmentId) return filter;
  const seg = await segmentOf(storeId, segmentId);
  return segmentFilterSchema.parse(seg.filter);
}

export async function campaignOf(storeId: string, id: string) {
  const c = await systemDb.smsCampaign.findFirst({ where: { id, storeId } });
  if (!c) throw new SmsError("Campaign not found.", 404, "not_found");
  return c;
}

/** Recipients now and what they would cost (per country, from AWS's billed prices or the price list). */
export async function estimateCampaign(store: Pick<Store, "id">, c: Pick<SmsCampaign, "templateId" | "segmentId" | "filter">) {
  const filter = await campaignFilter(store.id, c.segmentId, segmentFilterSchema.parse(c.filter ?? {}));
  const est = await estimateSegment(store.id, filter);
  const t = await approvedVersionOf(store.id, c.templateId);
  const parts = t?.segments ?? 1;
  let cost = 0;
  let unpriced = 0;
  for (const g of est.byCountry) {
    const price = await partPrice(g.country);
    const one = estimateCostUsd(parts, price?.usd);
    if (one === null) unpriced += g.count;
    else cost += one * g.count;
  }
  return { recipients: est.recipients, byCountry: est.byCountry, partsPerText: parts, estimatedCostUsd: Math.round(cost * 1e6) / 1e6, unpricedRecipients: unpriced, max: env().SMS_CAMPAIGN_MAX_RECIPIENTS };
}

export async function saveCampaign(store: Pick<Store, "id" | "workspaceId">, id: string | null, raw: unknown, actor: Actor): Promise<SmsCampaign> {
  const input = smsCampaignSchema.parse(raw);
  const t = await systemDb.smsTemplate.findFirst({ where: { id: input.templateId, storeId: store.id } });
  if (!t) throw new SmsError("Template not found.", 404, "not_found");
  if (t.category !== "marketing") throw new SmsError("Campaigns send marketing templates (with an opt-out link): choose one.", 400, "not_marketing");
  if (input.segmentId) await segmentOf(store.id, input.segmentId);
  const data = { name: input.name, templateId: input.templateId, segmentId: input.segmentId ?? null, filter: input.filter, discountCode: input.discountCode ?? null, attributionDays: input.attributionDays };
  let c: SmsCampaign;
  if (id) {
    const before = await campaignOf(store.id, id);
    if (!smsCampaignEditable(before.status)) throw new SmsError("Only a draft campaign can be edited. Send it back to draft first.", 409, "campaign_state");
    c = await systemDb.smsCampaign.update({ where: { id }, data });
  } else {
    c = await systemDb.smsCampaign.create({ data: { workspaceId: store.workspaceId, storeId: store.id, ...data, status: "draft", createdBy: actor.userId } });
  }
  await smsAudit({ workspaceId: store.workspaceId, storeId: store.id, actorUserId: actor.userId, action: id ? "campaign_edited" : "campaign_created", targetType: "sms_campaign", targetId: c.id, snapshot: data, ip: actor.ip });
  return c;
}

const CAMPAIGN_PAST: Record<SmsCampaignAction, string> = { submit: "submitted", approve: "approved", reject: "rejected", schedule: "scheduled", pause: "paused", resume: "resumed", cancel: "cancelled" };

/**
 * submit → approve (fixes the template version) → schedule (exact count confirmed, budget checked)
 * → the sweep starts it. pause, resume and cancel at any time; reject sends it back to draft.
 */
export async function campaignAction(
  store: Pick<Store, "id" | "workspaceId">,
  id: string,
  action: SmsCampaignAction,
  actor: Actor,
  o: { confirmRecipients?: number; scheduledAt?: Date } = {},
): Promise<SmsCampaign> {
  const c = await campaignOf(store.id, id);
  if (!smsCampaignCan(c.status, action)) throw new SmsError(`This campaign can't be ${{ submit: "submitted", approve: "approved", reject: "sent back", schedule: "scheduled", pause: "paused", resume: "resumed", cancel: "cancelled" }[action]} while it is ${c.status.replace("_", " ")}.`, 409, "campaign_state");
  const now = new Date();
  let data: Prisma.SmsCampaignUpdateInput = {};
  if (action === "submit" || action === "approve") {
    const t = await approvedVersionOf(store.id, c.templateId);
    if (!t) throw new SmsError("Its template has no approved version yet.", 409, "template_not_approved");
    if (t.category !== "marketing") throw new SmsError("Campaigns send marketing templates.", 409, "not_marketing");
    if (t.body.includes("{{discount_code}}") && !c.discountCode) throw new SmsError("The template shows a discount code: enter it on the campaign.", 409, "discount_required");
    const est = await estimateCampaign(store, c);
    data = action === "submit" ? { status: "pending_approval", submittedBy: actor.userId, submittedAt: now, estimatedRecipients: est.recipients, estimatedCostUsd: est.estimatedCostUsd } : { status: "approved", approvedBy: actor.userId, approvedAt: now, templateVersion: t.version, estimatedRecipients: est.recipients, estimatedCostUsd: est.estimatedCostUsd };
  } else if (action === "reject") {
    data = { status: "draft", approvedBy: null, approvedAt: null, templateVersion: null };
  } else if (action === "schedule") {
    if (!marketingSwitchedOn()) throw new SmsError("Marketing texts aren't switched on for bizinsights yet.", 409, "marketing_platform_off");
    const sender = await senderOf(store.id);
    const problem = senderProblem(sender);
    if (problem) throw new SmsError("The sender isn't ready: finish Sender configuration and turn sending on.", 409, "sender_not_ready");
    if (!sender!.marketingEnabled) throw new SmsError("Turn marketing texts on in Sender configuration first.", 409, "marketing_disabled");
    const est = await estimateCampaign(store, c);
    if (o.confirmRecipients !== est.recipients) throw new SmsError(`The audience is now ${est.recipients} customers. Confirm that number to schedule.`, 409, "recipients_changed", { recipients: est.recipients });
    if (est.recipients === 0) throw new SmsError("No customer in this audience has agreed to marketing texts.", 409, "no_recipients");
    if (est.recipients > est.max) throw new SmsError(`A campaign can reach at most ${est.max} customers.`, 409, "too_many_recipients");
    const spend = await monthSpend(store.id);
    const worst = est.estimatedCostUsd + est.unpricedRecipients * est.partsPerText * env().SMS_MAX_PRICE_PER_PART_USD;
    if (sender!.hardStop && !budgetAllows(spend.totalUsd, worst, Number(sender!.monthlyBudgetUsd))) {
      throw new SmsError(`This campaign could cost up to US$${worst.toFixed(2)}, more than is left of this month's budget (US$${Math.max(0, Number(sender!.monthlyBudgetUsd) - spend.totalUsd).toFixed(2)}).`, 409, "over_budget");
    }
    const at = o.scheduledAt && o.scheduledAt > now ? o.scheduledAt : now;
    data = { status: "scheduled", scheduledAt: at, scheduledBy: actor.userId, confirmedRecipients: est.recipients, estimatedRecipients: est.recipients, estimatedCostUsd: est.estimatedCostUsd };
  } else if (action === "pause") {
    data = { status: "paused" };
  } else if (action === "resume") {
    data = { status: c.startedAt ? "sending" : "scheduled" };
  } else if (action === "cancel") {
    data = { status: "cancelled", cancelledAt: now };
  }
  const updated = await systemDb.smsCampaign.update({ where: { id }, data });
  if (action === "cancel") await systemDb.smsMessageJob.updateMany({ where: { campaignId: id, status: "scheduled" }, data: { status: "cancelled", reason: "campaign_stopped", finalAt: now, valuesEnc: null } });
  await smsAudit({ workspaceId: store.workspaceId, storeId: store.id, actorUserId: actor.userId, action: `campaign_${CAMPAIGN_PAST[action]}`, targetType: "sms_campaign", targetId: id, metadata: { status: updated.status, ...(o.confirmRecipients !== undefined ? { recipients: o.confirmRecipients } : {}) }, ip: actor.ip });
  return updated;
}

/** Start campaigns whose time has come: choose the recipients now, one text each, paced to the sender's speed. */
export async function startDueCampaigns(deps: Pick<SmsDeps, "queues">, now = new Date()): Promise<number> {
  const due = await systemDb.smsCampaign.findMany({ where: { status: "scheduled", scheduledAt: { lte: now } }, take: 5 });
  let started = 0;
  for (const c of due) {
    const claimed = await systemDb.smsCampaign.updateMany({ where: { id: c.id, status: "scheduled" }, data: { status: "sending", startedAt: now } });
    if (!claimed.count) continue;
    started++;
    try {
      await materialize(c, deps, now);
    } catch (err) {
      logger.error({ err, campaignId: c.id }, "sms campaign start failed; paused");
      await systemDb.smsCampaign.update({ where: { id: c.id }, data: { status: "paused" } });
    }
  }
  return started;
}

async function materialize(c: SmsCampaign, deps: Pick<SmsDeps, "queues">, now: Date) {
  const store = await systemDb.store.findUnique({ where: { id: c.storeId } });
  if (!store || !c.templateVersion) return;
  const filter = await campaignFilter(c.storeId, c.segmentId, segmentFilterSchema.parse(c.filter ?? {})).catch(() => segmentFilterSchema.parse(c.filter ?? {}));
  const contacts = await systemDb.smsContact.findMany({ where: segmentWhere(c.storeId, filter, now), take: env().SMS_CAMPAIGN_MAX_RECIPIENTS, orderBy: { createdAt: "asc" } });
  const pps = env().SMS_PARTS_PER_SECOND;
  const t = await systemDb.smsTemplateVersion.findUnique({ where: { templateId_version: { templateId: c.templateId, version: c.templateVersion } } });
  const parts = t?.segments ?? 1;
  const spacingMs = Math.ceil((1000 * parts) / pps);
  let i = 0;
  for (const contact of contacts) {
    const { job } = await scheduleSms(
      {
        store,
        purpose: "campaign",
        category: "marketing",
        dedupeKey: `campaign:${c.id}:${contact.id}`,
        campaignId: c.id,
        templateId: c.templateId,
        templateVersion: c.templateVersion,
        contact,
        values: { ...(c.discountCode ? { discount_code: c.discountCode } : {}) },
        sendAfter: new Date(now.getTime() + i * spacingMs),
        dryRun: smsMode() !== "live",
        subjectKey: `campaign:${c.id}`,
      },
      deps,
    );
    await systemDb.smsCampaignRecipient.upsert({
      where: { campaignId_contactId: { campaignId: c.id, contactId: contact.id } },
      create: { workspaceId: c.workspaceId, storeId: c.storeId, campaignId: c.id, contactId: contact.id, status: job.status === "skipped" ? "skipped" : "scheduled", jobId: job.id, reason: job.reason },
      update: {},
    });
    i++;
  }
  logger.info({ campaignId: c.id, recipients: contacts.length }, "sms campaign started");
}

/** Campaigns with nothing left waiting are completed. */
export async function completeCampaigns(): Promise<number> {
  const sending = await systemDb.smsCampaign.findMany({ where: { status: "sending" }, select: { id: true } });
  let done = 0;
  for (const c of sending) {
    const waiting = await systemDb.smsMessageJob.count({ where: { campaignId: c.id, status: { in: ["scheduled", "sending"] } } });
    if (!waiting) {
      await systemDb.smsCampaign.update({ where: { id: c.id }, data: { status: "completed", completedAt: new Date() } });
      done++;
    }
  }
  return done;
}

/** A campaign's results, from its messages' rows: what AWS accepted, what the carriers reported, what it cost and the orders that followed. */
export async function campaignMetrics(campaignId: string) {
  const [byStatus, cost, attributed] = await Promise.all([
    systemDb.smsMessageJob.groupBy({ by: ["status"], where: { campaignId }, _count: true }),
    systemDb.smsCostRecord.aggregate({ where: { campaignId }, _sum: { totalUsd: true } }),
    systemDb.smsMessageJob.groupBy({ by: ["attributedCurrency"], where: { campaignId, attributedOrderId: { not: null } }, _count: true, _sum: { attributedRevenue: true } }),
  ]);
  const counts = Object.fromEntries(byStatus.map((g) => [g.status, g._count])) as Record<string, number>;
  const byCurrency = attributed.map((g) => ({ currency: g.attributedCurrency, orders: g._count, revenue: Number(g._sum.attributedRevenue ?? 0) }));
  // One figure only when every attributed order is in one currency: amounts in different currencies don't add up.
  const single = byCurrency.length === 1 ? byCurrency[0]! : null;
  return {
    counts,
    costUsd: Number(cost._sum.totalUsd ?? 0),
    attributedOrders: byCurrency.reduce((n, g) => n + g.orders, 0),
    attributedRevenue: single ? single.revenue : null,
    attributedCurrency: single?.currency ?? null,
    attributedByCurrency: byCurrency,
  };
}

import { z } from "zod";
import { withTenant, type SmsAutomationRule, type SmsCampaign } from "@app/db";
import {
  awaitingApproval,
  campaignAction,
  campaignMetrics,
  campaignOf,
  createRule,
  deleteSegment,
  dryRunRule,
  estimateCampaign,
  estimateSegment,
  hasUnapprovedVersion,
  parseRule,
  ruleAction,
  ruleOf,
  saveCampaign,
  saveSegment,
  segmentOf,
  updateRule,
} from "@app/core/sms";
import { describeSegment, segmentFilterSchema, TRIGGER_INFO, type SmsCampaignAction } from "@app/shared/sms";
import { body, requireWorkspace, type Deps } from "../context.js";
import type { App } from "../app.js";
import { limit, LIMITS } from "../rateLimit.js";
import { actorNames, actorOf, base, SMS_MANAGE, SMS_READ, smsStore } from "./smsCommon.js";

/** Customer Messaging: automation rules, customer segments and campaigns (docs/sms.md). */

function publicRule(r: SmsAutomationRule) {
  const cfg = parseRule(r.config);
  const active = parseRule(r.activeConfig);
  return {
    id: r.id,
    name: r.name,
    status: r.status,
    config: cfg ?? r.config,
    trigger: cfg?.trigger ?? null,
    triggerLabel: cfg ? TRIGGER_INFO[cfg.trigger].label : null,
    version: r.version,
    activeVersion: r.activeVersion,
    activeConfig: active,
    unapprovedVersion: hasUnapprovedVersion(r),
    awaitingApproval: awaitingApproval(r),
    dryRun: active?.dryRun ?? cfg?.dryRun ?? true,
    priority: r.priority,
    submittedBy: r.submittedBy,
    submittedAt: r.submittedAt,
    approvedBy: r.approvedBy,
    approvedAt: r.approvedAt,
    lastRunAt: r.lastRunAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/** A campaign as the pages show it; with its saved segment, the audience is that segment's. */
function publicCampaign(c: SmsCampaign, segment?: { name: string; filter: unknown } | null) {
  const filter = segmentFilterSchema.safeParse((segment ? segment.filter : c.filter) ?? {});
  return {
    id: c.id,
    name: c.name,
    templateId: c.templateId,
    templateVersion: c.templateVersion,
    segmentId: c.segmentId,
    filter: filter.success ? filter.data : { countries: [] },
    audience: filter.success ? describeSegment(filter.data) : null,
    segmentName: segment?.name ?? null,
    discountCode: c.discountCode,
    attributionDays: c.attributionDays,
    status: c.status,
    estimatedRecipients: c.estimatedRecipients,
    estimatedCostUsd: c.estimatedCostUsd === null ? null : Number(c.estimatedCostUsd),
    confirmedRecipients: c.confirmedRecipients,
    scheduledAt: c.scheduledAt,
    startedAt: c.startedAt,
    completedAt: c.completedAt,
    cancelledAt: c.cancelledAt,
    submittedAt: c.submittedAt,
    approvedBy: c.approvedBy,
    approvedAt: c.approvedAt,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

/**
 * The advanced rule editor's input without an audience: who a rule texts (a segment, chosen
 * customers) is set in the automation builder only, so an editor that doesn't show it can never
 * widen it. A new rule texts the event's customer.
 */
function withoutAudience(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const { audience: _audience, ...rest } = input as Record<string, unknown>;
  return rest;
}

export function smsOpsRoutes(app: App, deps: Deps) {
  // ---------------------------------------------------------------- automation rules

  app.get(`${base}/rules`, async (c) => {
    const { ws, storeId } = c.req.param();
    await requireWorkspace(c, deps, ws, SMS_READ);
    await smsStore(ws, storeId);
    const rows = await withTenant(ws, (tx) => tx.smsAutomationRule.findMany({ where: { workspaceId: ws, storeId }, orderBy: [{ status: "asc" }, { priority: "asc" }, { createdAt: "asc" }] }));
    return c.json({ rules: rows.map(publicRule) });
  });

  app.get(`${base}/rules/:id`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    await requireWorkspace(c, deps, ws, SMS_READ);
    await smsStore(ws, storeId);
    const r = await ruleOf(storeId, id);
    // Version history: each version's content as saved, and each approval and state change.
    const history = await withTenant(ws, (tx) => tx.smsAuditLog.findMany({ where: { workspaceId: ws, storeId, targetId: id }, orderBy: { createdAt: "desc" }, take: 100 }));
    const who = await actorNames([...history.map((h) => h.actorUserId), r.submittedBy, r.approvedBy]);
    return c.json({
      rule: { ...publicRule(r), submittedByName: r.submittedBy ? who(r.submittedBy) : null, approvedByName: r.approvedBy ? who(r.approvedBy) : null },
      history: history.map((h) => ({ action: h.action, version: h.version, actorUserId: h.actorUserId, actor: who(h.actorUserId), at: h.createdAt, snapshot: h.snapshot })),
    });
  });

  app.post(`${base}/rules`, async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, SMS_MANAGE);
    const store = await smsStore(ws, storeId);
    const r = await createRule(store, withoutAudience(await body(c)), actorOf(c, a));
    return c.json({ rule: publicRule(r) }, 201);
  });

  app.put(`${base}/rules/:id`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, SMS_MANAGE);
    const store = await smsStore(ws, storeId);
    // The rule keeps its own audience (updateRule): only the automation builder changes who it texts.
    const r = await updateRule(store, id, withoutAudience(await body(c)), actorOf(c, a));
    return c.json({ rule: publicRule(r) });
  });

  app.post(`${base}/rules/:id/:action{submit|approve|reject|pause|resume|disable}`, async (c) => {
    const { ws, storeId, id, action } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, SMS_MANAGE);
    const store = await smsStore(ws, storeId);
    const r = await ruleAction(store, id, action as "submit" | "approve" | "reject" | "pause" | "resume" | "disable", actorOf(c, a));
    return c.json({ rule: publicRule(r) });
  });

  /** What the rule's edited version would do with the store's recent orders: nothing is sent. */
  app.post(`${base}/rules/:id/dry-run`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    await requireWorkspace(c, deps, ws, SMS_READ);
    const store = await smsStore(ws, storeId);
    await limit(deps.coord, `rl:sms-dryrun:${storeId}`, LIMITS.smsEstimate);
    return c.json(await dryRunRule(store, id));
  });

  // ---------------------------------------------------------------- segments

  app.get(`${base}/segments`, async (c) => {
    const { ws, storeId } = c.req.param();
    await requireWorkspace(c, deps, ws, SMS_READ);
    await smsStore(ws, storeId);
    const rows = await withTenant(ws, (tx) => tx.smsSegment.findMany({ where: { workspaceId: ws, storeId }, orderBy: { name: "asc" } }));
    const out = [];
    for (const s of rows) {
      const filter = segmentFilterSchema.parse(s.filter ?? {});
      out.push({ id: s.id, name: s.name, filter, description: describeSegment(filter), recipients: (await estimateSegment(storeId, filter)).recipients, updatedAt: s.updatedAt });
    }
    return c.json({ segments: out });
  });

  app.post(`${base}/segments/estimate`, async (c) => {
    const { ws, storeId } = c.req.param();
    await requireWorkspace(c, deps, ws, SMS_READ);
    await smsStore(ws, storeId);
    await limit(deps.coord, `rl:sms-estimate:${storeId}`, LIMITS.smsEstimate);
    const input = z.object({ filter: z.unknown().optional() }).parse(await body(c));
    const filter = segmentFilterSchema.parse(input.filter ?? {});
    return c.json({ ...(await estimateSegment(storeId, filter)), description: describeSegment(filter) });
  });

  app.post(`${base}/segments`, async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, SMS_MANAGE);
    const store = await smsStore(ws, storeId);
    const input = z.object({ name: z.string().max(80), filter: z.unknown().optional() }).parse(await body(c));
    const s = await saveSegment(store, null, input.name, input.filter, actorOf(c, a));
    return c.json({ segment: { id: s.id, name: s.name } }, 201);
  });

  app.put(`${base}/segments/:id`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, SMS_MANAGE);
    const store = await smsStore(ws, storeId);
    await segmentOf(storeId, id);
    const input = z.object({ name: z.string().max(80), filter: z.unknown().optional() }).parse(await body(c));
    const s = await saveSegment(store, id, input.name, input.filter, actorOf(c, a));
    return c.json({ segment: { id: s.id, name: s.name } });
  });

  app.delete(`${base}/segments/:id`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, SMS_MANAGE);
    const store = await smsStore(ws, storeId);
    await deleteSegment(store, id, actorOf(c, a));
    return c.json({ ok: true });
  });

  // ---------------------------------------------------------------- campaigns

  app.get(`${base}/campaigns`, async (c) => {
    const { ws, storeId } = c.req.param();
    await requireWorkspace(c, deps, ws, SMS_READ);
    await smsStore(ws, storeId);
    const rows = await withTenant(ws, (tx) => tx.smsCampaign.findMany({ where: { workspaceId: ws, storeId }, orderBy: { createdAt: "desc" }, take: 100 }));
    const segments = await withTenant(ws, (tx) => tx.smsSegment.findMany({ where: { workspaceId: ws, storeId, id: { in: rows.map((r) => r.segmentId).filter((x): x is string => !!x) } } }));
    const out = [];
    for (const r of rows) out.push({ ...publicCampaign(r, segments.find((s) => s.id === r.segmentId)), metrics: r.startedAt ? await campaignMetrics(r.id) : null });
    return c.json({ campaigns: out });
  });

  app.get(`${base}/campaigns/:id`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    await requireWorkspace(c, deps, ws, SMS_READ);
    const store = await smsStore(ws, storeId);
    const r = await campaignOf(storeId, id);
    const estimate = ["draft", "pending_approval", "approved", "scheduled"].includes(r.status) ? await estimateCampaign(store, r) : null;
    const segment = r.segmentId ? await withTenant(ws, (tx) => tx.smsSegment.findFirst({ where: { id: r.segmentId!, workspaceId: ws, storeId } })) : null;
    return c.json({ campaign: publicCampaign(r, segment), metrics: r.startedAt ? await campaignMetrics(r.id) : null, estimate });
  });

  app.post(`${base}/campaigns/estimate`, async (c) => {
    const { ws, storeId } = c.req.param();
    await requireWorkspace(c, deps, ws, SMS_READ);
    const store = await smsStore(ws, storeId);
    await limit(deps.coord, `rl:sms-estimate:${storeId}`, LIMITS.smsEstimate);
    const input = z.object({ templateId: z.string().min(1).max(40), segmentId: z.string().max(40).nullish(), filter: z.unknown().optional() }).parse(await body(c));
    return c.json(await estimateCampaign(store, { templateId: input.templateId, segmentId: input.segmentId ?? null, filter: (input.filter ?? {}) as never }));
  });

  app.post(`${base}/campaigns`, async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, SMS_MANAGE);
    const store = await smsStore(ws, storeId);
    const r = await saveCampaign(store, null, await body(c), actorOf(c, a));
    return c.json({ campaign: publicCampaign(r) }, 201);
  });

  app.put(`${base}/campaigns/:id`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, SMS_MANAGE);
    const store = await smsStore(ws, storeId);
    const r = await saveCampaign(store, id, await body(c), actorOf(c, a));
    return c.json({ campaign: publicCampaign(r) });
  });

  app.post(`${base}/campaigns/:id/:action{submit|approve|reject|schedule|pause|resume|cancel}`, async (c) => {
    const { ws, storeId, id, action } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, SMS_MANAGE);
    const store = await smsStore(ws, storeId);
    const input = z.object({ confirmRecipients: z.number().int().min(0).optional(), scheduledAt: z.coerce.date().optional() }).parse(await body(c));
    const r = await campaignAction(store, id, action as SmsCampaignAction, actorOf(c, a), input);
    return c.json({ campaign: publicCampaign(r) });
  });
}

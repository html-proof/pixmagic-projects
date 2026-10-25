import { z } from "zod";
import { withTenant, type WaWorkflow } from "@app/db";
import {
  activateWorkflow,
  campaignInput,
  campaignReport,
  cancelCampaign,
  deleteCampaign,
  deleteWorkflow,
  ensureCustomerWebhook,
  estimateAudience,
  liveConnection,
  pauseWorkflow,
  saveCampaign,
  saveWorkflow,
  scheduleCampaign,
  sendTest,
  settingsOf,
  storedCampaignProblems,
  storedWorkflowProblems,
  storeGraphql,
  testCampaign,
  workflowInput,
  workflowProblems,
} from "@app/core";
import { audienceSchema, campaignCan, CONDITION_LABEL, conditionFieldsFor, describeAudience, describeCondition, TRIGGER_INFO, VARIABLE_INFO, WORKFLOW_PRESETS, WORKFLOW_TRIGGERS, workflowSchema } from "@app/shared";
import { body, clientIp, HttpError, type Deps } from "../context.js";
import type { App } from "../app.js";
import { limit, LIMITS } from "../rateLimit.js";
import { base, messageView, requireWaManage, requireWaView, waStore } from "./whatsappCommon.js";

/**
 * WhatsApp Automation's workflows (trigger → conditions → template → timing) and campaigns
 * (an approved Marketing template to an audience of opted-in customers). Reading needs "View
 * campaigns"; changing them needs the store's owners or admins.
 */

const idParam = z.string().trim().min(1).max(64);
const DAY = 86_400_000;

/** Each workflow's results over the last 30 days, by its messages' statuses. */
async function workflowStats(ws: string, storeId: string, ids: string[]) {
  if (!ids.length) return new Map<string, Record<string, number>>();
  const [messages, skipped] = await withTenant(ws, (tx) =>
    Promise.all([
      tx.waMessage.groupBy({ by: ["workflowId", "status"], where: { storeId, workspaceId: ws, workflowId: { in: ids }, createdAt: { gte: new Date(Date.now() - 30 * DAY) } }, _count: { _all: true } }),
      tx.waWorkflowRun.groupBy({ by: ["workflowId"], where: { storeId, workspaceId: ws, workflowId: { in: ids }, outcome: "skipped", createdAt: { gte: new Date(Date.now() - 30 * DAY) } }, _count: { _all: true } }),
    ]),
  );
  const out = new Map<string, Record<string, number>>();
  for (const id of ids) out.set(id, { waiting: 0, sent: 0, delivered: 0, read: 0, failed: 0, skipped: 0, cancelled: 0 });
  for (const r of messages) {
    const s = out.get(r.workflowId!)!;
    const n = r._count._all;
    if (r.status === "queued" || r.status === "sending") s.waiting! += n;
    else if (r.status === "accepted" || r.status === "sent") s.sent! += n;
    else if (r.status === "delivered") s.delivered! += n;
    else if (r.status === "read") {
      s.delivered! += n;
      s.read! += n;
    } else if (r.status === "failed") s.failed! += n;
    else if (r.status === "skipped") s.skipped! += n;
    else if (r.status === "cancelled") s.cancelled! += n;
  }
  for (const r of skipped) out.get(r.workflowId)!.skipped! += r._count._all;
  return out;
}

function workflowView(w: WaWorkflow, problems: string[], stats?: Record<string, number>) {
  const input = workflowInput(w);
  return {
    id: w.id,
    ...input,
    conditionsText: input.conditions.map(describeCondition),
    status: w.status,
    version: w.version,
    problems,
    stats: stats ?? null,
    lastRunAt: w.lastRunAt,
    activatedAt: w.activatedAt,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  };
}

export function whatsappAutomationRoutes(app: App, deps: Deps) {
  // ---------------------------------------------------------------- workflows

  /** The store's workflows with their results, and what the builder offers. */
  app.get(`${base}/workflows`, async (c) => {
    const { ws, storeId } = c.req.param();
    await requireWaView(c, deps, ws);
    await waStore(ws, storeId);
    const rows = await withTenant(ws, (tx) => tx.waWorkflow.findMany({ where: { storeId, workspaceId: ws }, orderBy: { createdAt: "asc" } }));
    const stats = await workflowStats(ws, storeId, rows.map((r) => r.id));
    const workflows = [];
    for (const w of rows) workflows.push(workflowView(w, await storedWorkflowProblems(w), stats.get(w.id)));
    return c.json({
      workflows,
      presets: WORKFLOW_PRESETS,
      triggers: WORKFLOW_TRIGGERS.map((t) => ({ key: t, ...TRIGGER_INFO[t], conditionFields: conditionFieldsFor(t).map((f) => ({ key: f, label: CONDITION_LABEL[f] })), variables: TRIGGER_INFO[t].variables.map((v) => ({ key: v, ...VARIABLE_INFO[v] })) })),
    });
  });

  /** What would stop a workflow being switched on, before it is saved (the builder's last step). */
  app.post(`${base}/workflows/check`, async (c) => {
    const { ws, storeId } = c.req.param();
    await requireWaView(c, deps, ws);
    await waStore(ws, storeId);
    const parsed = workflowSchema.safeParse(await body(c));
    if (!parsed.success) return c.json({ problems: parsed.error.issues.slice(0, 5).map((i) => i.message) });
    const input = parsed.data;
    const template = await withTenant(ws, (tx) => tx.waTemplate.findFirst({ where: { storeId, workspaceId: ws, name: input.template.name, language: input.template.language } }));
    return c.json({ problems: workflowProblems(input, { template, conn: await liveConnection(storeId), settings: await settingsOf(storeId) }) });
  });

  app.post(`${base}/workflows`, async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireWaManage(c, deps, ws);
    const store = await waStore(ws, storeId);
    const w = await saveWorkflow({ store, userId: a.user.id, data: await body(c), ip: clientIp(c) });
    return c.json({ workflow: workflowView(w, await storedWorkflowProblems(w)) }, 201);
  });

  /** One workflow, with its latest runs (what happened each time its trigger fired). */
  app.get(`${base}/workflows/:id`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    await requireWaView(c, deps, ws);
    await waStore(ws, storeId);
    const q = z.object({ cursor: idParam.optional() }).parse(c.req.query());
    const found = await withTenant(ws, async (tx) => {
      const w = await tx.waWorkflow.findFirst({ where: { id: idParam.parse(id), storeId, workspaceId: ws } });
      if (!w) return null;
      const runs = await tx.waWorkflowRun.findMany({ where: { workflowId: w.id, workspaceId: ws }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 51, ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}) });
      const messages = await tx.waMessage.findMany({ where: { id: { in: runs.flatMap((r) => (r.messageId ? [r.messageId] : [])) }, workspaceId: ws } });
      return { w, runs, messages };
    });
    if (!found) throw new HttpError(404, "That workflow wasn't found.", "not_found");
    const byId = new Map(found.messages.map((m) => [m.id, m]));
    const page = found.runs.slice(0, 50);
    const stats = await workflowStats(ws, storeId, [found.w.id]);
    return c.json({
      workflow: workflowView(found.w, await storedWorkflowProblems(found.w), stats.get(found.w.id)),
      runs: page.map((r) => {
        const m = r.messageId ? byId.get(r.messageId) : null;
        return {
          id: r.id,
          subject: r.subjectLabel,
          outcome: r.outcome,
          reason: r.reason,
          at: r.createdAt,
          version: r.workflowVersion,
          message: m ? messageView(m, { contacts: false }) : null,
        };
      }),
      nextCursor: found.runs.length > 50 ? page.at(-1)!.id : null,
    });
  });

  app.put(`${base}/workflows/:id`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    const a = await requireWaManage(c, deps, ws);
    const store = await waStore(ws, storeId);
    const w = await saveWorkflow({ store, userId: a.user.id, id: idParam.parse(id), data: await body(c), ip: clientIp(c) });
    return c.json({ workflow: workflowView(w, await storedWorkflowProblems(w)) });
  });

  app.post(`${base}/workflows/:id/activate`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    const a = await requireWaManage(c, deps, ws);
    const store = await waStore(ws, storeId);
    const w = await activateWorkflow({ store, id: idParam.parse(id), userId: a.user.id, ip: clientIp(c), subscribeCustomers: () => ensureCustomerWebhook(store, storeGraphql(store, deps.coord, deps.fetchImpl)) });
    return c.json({ workflow: workflowView(w, []) });
  });

  app.post(`${base}/workflows/:id/pause`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    const a = await requireWaManage(c, deps, ws);
    const store = await waStore(ws, storeId);
    const { workflow, cancelled } = await pauseWorkflow({ store, id: idParam.parse(id), userId: a.user.id, ip: clientIp(c) });
    return c.json({ workflow: workflowView(workflow, await storedWorkflowProblems(workflow)), cancelled });
  });

  app.delete(`${base}/workflows/:id`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    const a = await requireWaManage(c, deps, ws);
    const store = await waStore(ws, storeId);
    await deleteWorkflow({ store, id: idParam.parse(id), userId: a.user.id, ip: clientIp(c) });
    return c.json({ ok: true });
  });

  /** The workflow's message to the merchant's own test number, with sample values. */
  app.post(`${base}/workflows/:id/test`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    const a = await requireWaManage(c, deps, ws);
    const store = await waStore(ws, storeId);
    const w = await withTenant(ws, (tx) => tx.waWorkflow.findFirst({ where: { id: idParam.parse(id), storeId, workspaceId: ws } }));
    if (!w) throw new HttpError(404, "That workflow wasn't found.", "not_found");
    await limit(deps.coord, `rl:wa-test:${storeId}`, LIMITS.waTest, "Too many test messages. Wait a few minutes.");
    const input = workflowInput(w);
    const message = await sendTest(deps, { store, userId: a.user.id, template: input.template, mapping: input.mapping, headerMediaUrl: input.headerMediaUrl, label: `workflow:${w.id}` });
    return c.json({ message: messageView(message, { contacts: true }) }, 202);
  });

  // ---------------------------------------------------------------- campaigns

  app.get(`${base}/campaigns`, async (c) => {
    const { ws, storeId } = c.req.param();
    await requireWaView(c, deps, ws);
    await waStore(ws, storeId);
    const rows = await withTenant(ws, (tx) => tx.waCampaign.findMany({ where: { storeId, workspaceId: ws }, orderBy: { createdAt: "desc" }, take: 200 }));
    const counts = rows.length
      ? await withTenant(ws, (tx) => tx.waMessage.groupBy({ by: ["campaignId", "status"], where: { storeId, workspaceId: ws, campaignId: { in: rows.map((r) => r.id) } }, _count: { _all: true } }))
      : [];
    return c.json({
      campaigns: rows.map((r) => {
        const mine = counts.filter((x) => x.campaignId === r.id);
        const n = (...s: string[]) => mine.filter((x) => s.includes(x.status)).reduce((a, x) => a + x._count._all, 0);
        const input = campaignInput(r);
        return {
          id: r.id,
          ...input,
          audienceText: describeAudience(input.audience),
          status: r.status,
          scheduledAt: r.scheduledAt,
          startedAt: r.startedAt,
          completedAt: r.completedAt,
          cancelledAt: r.cancelledAt,
          cancelReason: r.cancelReason,
          estimatedRecipients: r.estimatedRecipients,
          recipients: r.recipients,
          lastTestAt: r.lastTestAt,
          progress: { waiting: n("queued", "sending"), sent: n("accepted", "sent", "delivered", "read"), delivered: n("delivered", "read"), read: n("read"), failed: n("failed"), skipped: n("skipped", "cancelled") },
          createdAt: r.createdAt,
        };
      }),
    });
  });

  /** How many opted-in customers an audience reaches now. */
  app.post(`${base}/campaigns/estimate`, async (c) => {
    const { ws, storeId } = c.req.param();
    await requireWaView(c, deps, ws);
    await waStore(ws, storeId);
    const { audience } = z.object({ audience: audienceSchema }).parse(await body(c));
    await limit(deps.coord, `rl:wa-estimate:${storeId}`, LIMITS.waEstimate);
    return c.json({ count: await estimateAudience(storeId, audience), audienceText: describeAudience(audience) });
  });

  app.post(`${base}/campaigns`, async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireWaManage(c, deps, ws);
    const store = await waStore(ws, storeId);
    const campaign = await saveCampaign({ store, userId: a.user.id, data: await body(c), ip: clientIp(c) });
    return c.json({ campaign: { id: campaign.id, status: campaign.status } }, 201);
  });

  app.get(`${base}/campaigns/:id`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    await requireWaView(c, deps, ws);
    await waStore(ws, storeId);
    const r = await withTenant(ws, (tx) => tx.waCampaign.findFirst({ where: { id: idParam.parse(id), storeId, workspaceId: ws } }));
    if (!r) throw new HttpError(404, "That campaign wasn't found.", "not_found");
    const input = campaignInput(r);
    return c.json({
      campaign: {
        id: r.id,
        ...input,
        audienceText: describeAudience(input.audience),
        status: r.status,
        scheduledAt: r.scheduledAt,
        startedAt: r.startedAt,
        completedAt: r.completedAt,
        cancelledAt: r.cancelledAt,
        cancelReason: r.cancelReason,
        estimatedRecipients: r.estimatedRecipients,
        recipients: r.recipients,
        materialized: !!r.materializedAt,
        lastTestAt: r.lastTestAt,
        createdAt: r.createdAt,
        can: { edit: campaignCan(r.status, "edit"), schedule: campaignCan(r.status, "schedule"), cancel: campaignCan(r.status, "cancel"), delete: campaignCan(r.status, "delete"), test: campaignCan(r.status, "test") },
      },
      report: await campaignReport(r.id),
      problems: campaignCan(r.status, "schedule") ? await storedCampaignProblems(r) : [],
    });
  });

  app.put(`${base}/campaigns/:id`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    const a = await requireWaManage(c, deps, ws);
    const store = await waStore(ws, storeId);
    const campaign = await saveCampaign({ store, userId: a.user.id, id: idParam.parse(id), data: await body(c), ip: clientIp(c) });
    return c.json({ campaign: { id: campaign.id, status: campaign.status } });
  });

  app.delete(`${base}/campaigns/:id`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    const a = await requireWaManage(c, deps, ws);
    const store = await waStore(ws, storeId);
    await deleteCampaign({ store, id: idParam.parse(id), userId: a.user.id, ip: clientIp(c) });
    return c.json({ ok: true });
  });

  app.post(`${base}/campaigns/:id/test`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    const a = await requireWaManage(c, deps, ws);
    const store = await waStore(ws, storeId);
    await limit(deps.coord, `rl:wa-test:${storeId}`, LIMITS.waTest, "Too many test messages. Wait a few minutes.");
    const message = await testCampaign(deps, { store, id: idParam.parse(id), userId: a.user.id });
    return c.json({ message: messageView(message, { contacts: true }) }, 202);
  });

  /** Schedule a draft (now, or at a time), confirming the recipient count the merchant was shown. */
  app.post(`${base}/campaigns/:id/schedule`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    const a = await requireWaManage(c, deps, ws);
    const store = await waStore(ws, storeId);
    const input = z.object({ scheduledAt: z.string().datetime({ offset: true }).nullable(), confirmRecipients: z.number().int().min(1) }).parse(await body(c));
    const campaign = await scheduleCampaign(deps, { store, id: idParam.parse(id), userId: a.user.id, scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null, confirmRecipients: input.confirmRecipients, ip: clientIp(c) });
    return c.json({ campaign: { id: campaign.id, status: campaign.status, scheduledAt: campaign.scheduledAt } });
  });

  app.post(`${base}/campaigns/:id/cancel`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    const a = await requireWaManage(c, deps, ws);
    const store = await waStore(ws, storeId);
    const { campaign, cancelled } = await cancelCampaign({ store, id: idParam.parse(id), userId: a.user.id, ip: clientIp(c) });
    return c.json({ campaign: { id: campaign.id, status: campaign.status }, cancelled });
  });
}

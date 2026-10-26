import { z } from "zod";
import { systemDb, withTenant, type Prisma, type Store, type WappAutomation, type WappCampaign, type WappTemplate } from "@app/db";
import {
  activateAutomation,
  addWaSuppression,
  automationInput,
  automationIssuesFor,
  campaignReport,
  cancelCampaign,
  checkConnection,
  confirmTestVerification,
  connectCloudApi,
  connectionOf,
  createWaTemplate,
  deleteAutomation,
  deleteCampaign,
  deleteWaTemplate,
  disconnectWhatsapp,
  ensureCustomerWebhook,
  evolutionConfigured,
  estimateWaAudience,
  launchCampaign,
  metaSignupConfig,
  pairingState,
  pauseAutomation,
  quickAutomation,
  removeWaSuppression,
  restartConnection,
  retryMessage,
  saveAutomation,
  saveCampaign,
  saveWaSettings,
  sendManualMessage,
  sendTestMessage,
  setAutomationPaused,
  setAutomationTestMode,
  setConsentByMerchant,
  storeGraphql,
  startPairing,
  startTestVerification,
  submitTemplateToMeta,
  templateUsable,
  templateUsage,
  testAutomation,
  triggerAvailability,
  updateWaTemplate,
  waConnectionView,
  waDecrypt,
  waMessageView,
  waPhoneHash,
  whatsappOverview,
  WhatsappError,
} from "@app/core";
import {
  addDays,
  allows,
  describeWaAudience,
  describeWaCondition,
  normalizePhone,
  startOfLocalDay,
  variablesIn,
  waSampleValues,
  waSkipLabel,
  WA_CONSENT_SOURCE_LABEL,
  WA_MESSAGE_STATUSES,
  WA_TRIGGER_INFO,
  type WaAudience,
  type WaAutomationIssue,
  type WaCondition,
  type WaConsentSource,
} from "@app/shared";
import { body, clientIp, HttpError, requireWorkspace, type Ctx, type Deps, type WorkspaceAccess } from "../context.js";
import type { App } from "../app.js";
import { limit, LIMITS } from "../rateLimit.js";

/**
 * WhatsApp Automation's merchant API (docs/whatsapp.md), one store at a time. Who may do what:
 *  - read anything here: "View campaigns" (marketing.campaigns); how the connection stands (the
 *    overview, cut down to it, for Settings → Integrations): "View integration connection status" too;
 *  - customers' numbers, names and what was said: "View contact information" as well;
 *  - change what customers receive (settings, templates, automations, campaigns, sends): the
 *    store's owners and admins (stores:manage), signed in themselves; a shared link never can;
 *  - connect and disconnect the number: "Manage integrations", signed in themselves.
 * Instance keys, webhook keys, QR codes (except to the person pairing), tokens and full numbers are
 * never in an answer.
 */
const base = "/workspaces/:ws/stores/:storeId/whatsapp";
const idParam = z.string().min(1).max(40);

async function waStore(ws: string, storeId: string): Promise<Store> {
  const store = await withTenant(ws, (tx) => tx.store.findFirst({ where: { id: storeId, workspaceId: ws } }));
  if (!store || store.status === "uninstalled") throw new HttpError(404, "Not found", "not_found");
  return store;
}

const requireView = (c: Ctx, deps: Deps, ws: string) => requireWorkspace(c, deps, ws, "marketing.campaigns");

type SignedIn = WorkspaceAccess & { user: NonNullable<WorkspaceAccess["user"]> };

async function requireSignedIn(c: Ctx, deps: Deps, ws: string, need: "stores:manage" | "integrations.manage"): Promise<SignedIn> {
  const a = await requireWorkspace(c, deps, ws, need);
  if (!a.user || a.link) throw new HttpError(403, "You don't have permission to do that", "forbidden");
  return a as SignedIn;
}
const requireManage = (c: Ctx, deps: Deps, ws: string) => requireSignedIn(c, deps, ws, "stores:manage");
const requireConnect = (c: Ctx, deps: Deps, ws: string) => requireSignedIn(c, deps, ws, "integrations.manage");

const seesContacts = (a: WorkspaceAccess) => allows(a.access, "customers.contact");
function requireContacts(a: WorkspaceAccess) {
  if (!seesContacts(a)) throw new HttpError(403, "You don't have permission to see customers' contact details", "forbidden");
}

/** What the browser may know of each permission, so it shows only the buttons that work. */
function waCan(a: WorkspaceAccess) {
  const signedIn = !!a.user && !a.link;
  return { connect: signedIn && allows(a.access, "integrations.manage"), manage: signedIn && allows(a.access, "stores:manage"), contacts: seesContacts(a) };
}

function templateView(t: WappTemplate, conn: Awaited<ReturnType<typeof connectionOf>>, usage?: { automations: number; campaigns: number }) {
  const usable = templateUsable(t, conn);
  return {
    id: t.id,
    name: t.name,
    category: t.category,
    body: t.body,
    active: t.active,
    variables: variablesIn(t.body),
    usable: usable.ok,
    unusableReason: usable.reason,
    meta: t.metaName ? { name: t.metaName, language: t.metaLanguage, status: t.metaStatus, reason: t.metaReason, checkedAt: t.metaCheckedAt } : null,
    usedBy: usage ?? null,
    updatedAt: t.updatedAt,
  };
}

/** An automation as the page shows it; `issues` (with `problems`, their words alone): why it can't be switched on, null when not checked in this answer. */
function automationView(a: WappAutomation, issues: WaAutomationIssue[] | null, stats?: { queued: number; skipped: number }) {
  const input = automationInput(a);
  return {
    id: a.id,
    ...input,
    status: a.status,
    version: a.version,
    triggerLabel: WA_TRIGGER_INFO[input.trigger]?.label ?? input.trigger,
    conditionLabels: input.conditions.map((x: WaCondition) => describeWaCondition(x)),
    problems: issues ? issues.map((i) => i.message) : null,
    issues,
    stats: stats ?? null,
    activatedAt: a.activatedAt,
    lastRunAt: a.lastRunAt,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

function campaignView(c: WappCampaign, report?: Awaited<ReturnType<typeof campaignReport>>) {
  const audience = c.audience as unknown as WaAudience;
  return {
    id: c.id,
    name: c.name,
    templateId: c.templateId,
    audience,
    audienceLabel: describeWaAudience(audience),
    status: c.status,
    scheduledAt: c.scheduledAt,
    confirmedRecipients: c.confirmedRecipients,
    recipients: c.recipients,
    startedAt: c.startedAt,
    completedAt: c.completedAt,
    cancelledAt: c.cancelledAt,
    cancelReason: c.cancelReason,
    report: report ?? null,
    createdAt: c.createdAt,
  };
}

const messageFilters = z.object({
  status: z.enum(["waiting", "sent", "delivered", "read", "failed", "not_sent", "received", ...WA_MESSAGE_STATUSES]).optional(),
  direction: z.enum(["out", "in"]).optional(),
  source: z.enum(["automation", "campaign", "manual", "test", "verification", "team_alert", "reply", "inbound"]).optional(),
  automationId: idParam.optional(),
  campaignId: idParam.optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  phone: z.string().trim().min(6).max(32).optional(),
  cursor: z.string().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const BUCKET_STATUSES: Record<string, string[]> = {
  waiting: ["queued", "sending"],
  sent: ["accepted", "sent"],
  delivered: ["delivered"],
  read: ["read"],
  failed: ["failed"],
  not_sent: ["skipped", "cancelled"],
  received: ["received"],
};

export function whatsappRoutes(app: App, deps: Deps) {
  // ---------------------------------------------------------------------------
  // Overview
  // ---------------------------------------------------------------------------

  app.get(base, async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, ["marketing.campaigns", "integrations.status"]);
    const store = await waStore(ws, storeId);
    const can = waCan(a);
    // Settings → Integrations, for someone who may see only how connections stand: the connection, nothing else.
    if (!allows(a.access, "marketing.campaigns")) {
      return c.json({ store: { id: store.id, name: store.name ?? store.shopDomain }, platform: { evolution: evolutionConfigured() }, connection: waConnectionView(await connectionOf(store.id)), can });
    }
    const overview = await whatsappOverview(store, { contacts: seesContacts(a) });
    return c.json({
      ...overview,
      can,
      triggers: triggerAvailability(store),
      // The Meta app's public ids, for Embedded Signup (only to those who may connect).
      cloudSignup: can.connect ? metaSignupConfig() : null,
    });
  });

  // ---------------------------------------------------------------------------
  // Connecting (Steps 1-2)
  // ---------------------------------------------------------------------------

  app.post(`${base}/connection`, async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireConnect(c, deps, ws);
    const store = await waStore(ws, storeId);
    await limit(deps.coord, `rl:wa-connect:${store.id}`, LIMITS.waConnect);
    const d = z.object({ method: z.enum(["qr", "code"]).default("qr"), phone: z.string().trim().max(32).nullable().optional(), country: z.string().trim().length(2).nullable().optional() }).parse(await body(c));
    const pairing = await startPairing(deps, { store, userId: a.user.id, method: d.method, phone: d.phone, country: d.country, ip: clientIp(c) });
    return c.json({ pairing }, 201, { "cache-control": "no-store" });
  });

  /** What the page polls while the phone scans: the provider's current code, or the state it reached. */
  app.get(`${base}/connection/pairing`, async (c) => {
    const { ws, storeId } = c.req.param();
    await requireConnect(c, deps, ws);
    const store = await waStore(ws, storeId);
    await limit(deps.coord, `rl:wa-pairing:${store.id}`, LIMITS.waPairing);
    const conn = await connectionOf(store.id);
    if (!conn) throw new HttpError(404, "Not connected", "not_connected");
    return c.json({ pairing: await pairingState(deps, conn) }, 200, { "cache-control": "no-store" });
  });

  app.post(`${base}/connection/cloud`, async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireConnect(c, deps, ws);
    const store = await waStore(ws, storeId);
    await limit(deps.coord, `rl:wa-connect:${store.id}`, LIMITS.waConnect);
    const conn = await connectCloudApi(deps, { store, userId: a.user.id, data: await body(c), ip: clientIp(c) });
    return c.json({ connection: waConnectionView(conn) }, 201);
  });

  app.post(`${base}/connection/check`, async (c) => {
    const { ws, storeId } = c.req.param();
    await requireView(c, deps, ws);
    const store = await waStore(ws, storeId);
    await limit(deps.coord, `rl:wa-refresh:${store.id}`, LIMITS.waRefresh);
    const conn = await connectionOf(store.id);
    if (!conn) throw new HttpError(404, "Not connected", "not_connected");
    return c.json({ connection: waConnectionView(await checkConnection(deps, conn)) });
  });

  app.post(`${base}/connection/reconnect`, async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireConnect(c, deps, ws);
    const store = await waStore(ws, storeId);
    await limit(deps.coord, `rl:wa-connect:${store.id}`, LIMITS.waConnect);
    const conn = await connectionOf(store.id);
    if (!conn) throw new HttpError(404, "Not connected", "not_connected");
    return c.json({ connection: waConnectionView(await restartConnection(deps, conn, { userId: a.user.id, ip: clientIp(c) })) });
  });

  app.delete(`${base}/connection`, async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireConnect(c, deps, ws);
    const store = await waStore(ws, storeId);
    await limit(deps.coord, `rl:wa-connect:${store.id}`, LIMITS.waConnect);
    const conn = await connectionOf(store.id);
    if (!conn || conn.status === "disconnected") throw new HttpError(404, "Not connected", "not_connected");
    return c.json({ connection: waConnectionView(await disconnectWhatsapp(deps, conn, { userId: a.user.id, ip: clientIp(c) })) });
  });

  // ---------------------------------------------------------------------------
  // Settings and the test number (Steps 3-4)
  // ---------------------------------------------------------------------------

  app.put(`${base}/settings`, async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireManage(c, deps, ws);
    const store = await waStore(ws, storeId);
    await saveWaSettings({ store, userId: a.user.id, data: await body(c), ip: clientIp(c) });
    return c.json({ ok: true });
  });

  app.post(`${base}/settings/pause`, async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireManage(c, deps, ws);
    const store = await waStore(ws, storeId);
    const { paused } = z.object({ paused: z.boolean() }).parse(await body(c));
    await setAutomationPaused({ store, userId: a.user.id, paused, ip: clientIp(c) });
    return c.json({ ok: true, paused });
  });

  app.post(`${base}/test-number`, async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireManage(c, deps, ws);
    const store = await waStore(ws, storeId);
    await limit(deps.coord, `rl:wa-test:${store.id}`, LIMITS.waTest);
    const d = z.object({ phone: z.string().trim().min(6).max(32), country: z.string().trim().length(2).nullable().optional() }).parse(await body(c));
    return c.json(await startTestVerification(deps, { store, userId: a.user.id, phone: d.phone, country: d.country, ip: clientIp(c) }));
  });

  app.post(`${base}/test-number/verify`, async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireManage(c, deps, ws);
    const store = await waStore(ws, storeId);
    const { code } = z.object({ code: z.string().trim().min(6).max(10) }).parse(await body(c));
    await confirmTestVerification({ store, userId: a.user.id, code, ip: clientIp(c) });
    return c.json({ ok: true });
  });

  app.post(`${base}/test-message`, async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireManage(c, deps, ws);
    const store = await waStore(ws, storeId);
    await limit(deps.coord, `rl:wa-test:${store.id}`, LIMITS.waTest);
    const d = z.object({ templateId: idParam.nullable().optional(), text: z.string().trim().max(1024).nullable().optional() }).parse(await body(c));
    return c.json(await sendTestMessage(deps, { store, userId: a.user.id, templateId: d.templateId, text: d.text }), 201);
  });

  // ---------------------------------------------------------------------------
  // Messages
  // ---------------------------------------------------------------------------

  app.get(`${base}/messages`, async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireView(c, deps, ws);
    const store = await waStore(ws, storeId);
    const f = messageFilters.parse(c.req.query());
    if (f.phone) requireContacts(a);
    const where: Prisma.WappMessageWhereInput = { storeId: store.id, workspaceId: ws };
    if (f.status) where.status = { in: BUCKET_STATUSES[f.status] ?? [f.status] };
    if (f.direction) where.direction = f.direction;
    if (f.source) where.source = f.source;
    if (f.automationId) where.automationId = f.automationId;
    if (f.campaignId) where.campaignId = f.campaignId;
    if (f.from || f.to) {
      where.createdAt = { ...(f.from ? { gte: startOfLocalDay(f.from, store.timezone) } : {}), ...(f.to ? { lt: startOfLocalDay(addDays(f.to, 1), store.timezone) } : {}) };
    }
    if (f.phone) {
      const p = normalizePhone(f.phone, null);
      if (!p) throw new HttpError(400, "Search with a full international number (+61...).", "invalid_phone");
      where.phoneHash = waPhoneHash(store.id, p.waId);
    }
    if (f.cursor) {
      const [at, id] = f.cursor.split("_");
      const t = new Date(Number(at));
      if (!id || Number.isNaN(t.getTime())) throw new HttpError(400, "Bad cursor", "validation");
      where.OR = [{ createdAt: { lt: t } }, { createdAt: t, id: { lt: id } }];
    }
    const rows = await withTenant(ws, (tx) => tx.wappMessage.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: f.limit + 1 }));
    const page = rows.slice(0, f.limit);
    const last = page.at(-1);
    return c.json({ messages: page.map((m) => waMessageView(m, { contacts: seesContacts(a) })), nextCursor: rows.length > f.limit && last ? `${last.createdAt.getTime()}_${last.id}` : null });
  });

  app.get(`${base}/messages/:id`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    const a = await requireView(c, deps, ws);
    const store = await waStore(ws, storeId);
    const m = await withTenant(ws, (tx) => tx.wappMessage.findFirst({ where: { id: idParam.parse(id), storeId: store.id, workspaceId: ws } }));
    if (!m) throw new HttpError(404, "Not found", "not_found");
    const events = await withTenant(ws, (tx) => tx.wappMessageEvent.findMany({ where: { messageId: m.id, workspaceId: ws }, orderBy: { occurredAt: "asc" } }));
    return c.json({ message: waMessageView(m, { contacts: seesContacts(a) }), events: events.map((e) => ({ status: e.status, providerStatus: e.providerStatus, at: e.occurredAt })) });
  });

  app.post(`${base}/messages`, async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireManage(c, deps, ws);
    const store = await waStore(ws, storeId);
    await limit(deps.coord, `rl:wa-send:${store.id}`, LIMITS.waSend);
    const m = await sendManualMessage(deps, { store, userId: a.user.id, data: await body(c), ip: clientIp(c) });
    return c.json({ message: waMessageView(m, { contacts: seesContacts(a) }) }, 201);
  });

  app.post(`${base}/messages/:id/retry`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    const a = await requireManage(c, deps, ws);
    const store = await waStore(ws, storeId);
    await limit(deps.coord, `rl:wa-send:${store.id}`, LIMITS.waSend);
    const m = await retryMessage(deps, store, idParam.parse(id), { userId: a.user.id });
    return c.json({ message: waMessageView(m, { contacts: seesContacts(a) }) });
  });

  // ---------------------------------------------------------------------------
  // Templates
  // ---------------------------------------------------------------------------

  app.get(`${base}/templates`, async (c) => {
    const { ws, storeId } = c.req.param();
    await requireView(c, deps, ws);
    const store = await waStore(ws, storeId);
    const [rows, conn] = await Promise.all([withTenant(ws, (tx) => tx.wappTemplate.findMany({ where: { storeId: store.id, workspaceId: ws }, orderBy: { name: "asc" } })), connectionOf(store.id)]);
    const usage = await templateUsage(store.id, rows.map((t) => t.id));
    return c.json({ templates: rows.map((t) => templateView(t, conn, usage.get(t.id))), samples: waSampleValues(store.name) });
  });

  app.post(`${base}/templates`, async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireManage(c, deps, ws);
    const store = await waStore(ws, storeId);
    await limit(deps.coord, `rl:wa-template:${store.id}`, LIMITS.waTemplateCreate);
    const t = await createWaTemplate(store, { data: await body(c), userId: a.user.id, ip: clientIp(c) });
    return c.json({ template: templateView(t, await connectionOf(store.id)) }, 201);
  });

  app.put(`${base}/templates/:id`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    const a = await requireManage(c, deps, ws);
    const store = await waStore(ws, storeId);
    await limit(deps.coord, `rl:wa-template:${store.id}`, LIMITS.waTemplateCreate);
    const t = await updateWaTemplate(store, idParam.parse(id), { data: await body(c), userId: a.user.id, ip: clientIp(c) });
    return c.json({ template: templateView(t, await connectionOf(store.id)) });
  });

  app.delete(`${base}/templates/:id`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    const a = await requireManage(c, deps, ws);
    const store = await waStore(ws, storeId);
    await deleteWaTemplate(store, idParam.parse(id), { userId: a.user.id, ip: clientIp(c) });
    return c.json({ ok: true });
  });

  /** Cloud API: submit a template for Meta's review. */
  app.post(`${base}/templates/:id/submit`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    await requireManage(c, deps, ws);
    const store = await waStore(ws, storeId);
    await limit(deps.coord, `rl:wa-template:${store.id}`, LIMITS.waTemplateCreate);
    const conn = await connectionOf(store.id);
    const t = await systemDb.wappTemplate.findFirst({ where: { id: idParam.parse(id), storeId: store.id } });
    if (!t) throw new HttpError(404, "Not found", "not_found");
    if (!conn || conn.provider !== "cloud_api" || conn.status !== "connected") throw new WhatsappError("Templates are reviewed by Meta only on a Cloud API connection.", 409, "not_cloud_api");
    const updated = await submitTemplateToMeta(deps, conn, t, waSampleValues(store.name) as Record<string, string>);
    return c.json({ template: templateView(updated, conn) });
  });

  // ---------------------------------------------------------------------------
  // Automations
  // ---------------------------------------------------------------------------

  app.get(`${base}/automations`, async (c) => {
    const { ws, storeId } = c.req.param();
    await requireView(c, deps, ws);
    const store = await waStore(ws, storeId);
    const rows = await withTenant(ws, (tx) => tx.wappAutomation.findMany({ where: { storeId: store.id, workspaceId: ws }, orderBy: { createdAt: "asc" } }));
    const since = new Date(Date.now() - 30 * 86_400_000);
    const runs = await withTenant(ws, (tx) => tx.wappAutomationRun.groupBy({ by: ["automationId", "outcome"], where: { storeId: store.id, workspaceId: ws, createdAt: { gte: since } }, _count: { _all: true } }));
    const out = [];
    for (const r of rows) {
      const stats = { queued: 0, skipped: 0 };
      for (const x of runs.filter((x) => x.automationId === r.id)) stats[x.outcome === "queued" ? "queued" : "skipped"] += x._count._all;
      out.push(automationView(r, await automationIssuesFor(store, r), stats));
    }
    return c.json({ automations: out, triggers: triggerAvailability(store) });
  });

  app.post(`${base}/automations`, async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireManage(c, deps, ws);
    const store = await waStore(ws, storeId);
    const r = await saveAutomation({ store, userId: a.user.id, data: await body(c), ip: clientIp(c) });
    return c.json({ automation: automationView(r, await automationIssuesFor(store, r)) }, 201);
  });

  /**
   * A ready-made automation turned on in one go: its message becomes a template (or reuses the
   * store's own with the same text), and the automation is saved and switched on when nothing stops
   * it. Saved but off, the answer's `issues` say why, each with the tab that fixes it.
   */
  app.post(`${base}/automations/quick`, async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireManage(c, deps, ws);
    const store = await waStore(ws, storeId);
    // It may write a template and ask Meta to review it: the templates' limit.
    await limit(deps.coord, `rl:wa-template:${store.id}`, LIMITS.waTemplateCreate);
    const r = await quickAutomation(deps, {
      store,
      userId: a.user.id,
      data: await body(c),
      ip: clientIp(c),
      subscribeCustomers: () => ensureCustomerWebhook(store, storeGraphql(store, deps.coord, deps.fetchImpl)),
    });
    const conn = await connectionOf(store.id);
    return c.json({ automation: automationView(r.automation, r.issues), template: templateView(r.template, conn), activated: r.activated, problems: r.problems, issues: r.issues, notice: r.notice }, 201);
  });

  app.get(`${base}/automations/:id`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    await requireView(c, deps, ws);
    const store = await waStore(ws, storeId);
    const r = await withTenant(ws, (tx) => tx.wappAutomation.findFirst({ where: { id: idParam.parse(id), storeId: store.id, workspaceId: ws } }));
    if (!r) throw new HttpError(404, "Not found", "not_found");
    const runs = await withTenant(ws, (tx) => tx.wappAutomationRun.findMany({ where: { automationId: r.id, workspaceId: ws }, orderBy: { createdAt: "desc" }, take: 50 }));
    const messages = await withTenant(ws, (tx) => tx.wappMessage.findMany({ where: { id: { in: runs.map((x) => x.messageId).filter((x): x is string => !!x) }, workspaceId: ws }, select: { id: true, status: true } }));
    const statusOf = new Map(messages.map((m) => [m.id, m.status]));
    return c.json({
      automation: automationView(r, await automationIssuesFor(store, r)),
      runs: runs.map((x) => ({ id: x.id, subject: x.subjectLabel, outcome: x.outcome, reason: x.reason, reasonLabel: waSkipLabel(x.reason), detail: x.detail, testMode: x.testMode, messageId: x.messageId, messageStatus: x.messageId ? (statusOf.get(x.messageId) ?? null) : null, at: x.createdAt })),
    });
  });

  app.put(`${base}/automations/:id`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    const a = await requireManage(c, deps, ws);
    const store = await waStore(ws, storeId);
    const r = await saveAutomation({ store, userId: a.user.id, id: idParam.parse(id), data: await body(c), ip: clientIp(c) });
    return c.json({ automation: automationView(r, await automationIssuesFor(store, r)) });
  });

  app.delete(`${base}/automations/:id`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    const a = await requireManage(c, deps, ws);
    const store = await waStore(ws, storeId);
    await deleteAutomation({ store, id: idParam.parse(id), userId: a.user.id, ip: clientIp(c) });
    return c.json({ ok: true });
  });

  app.post(`${base}/automations/:id/activate`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    const a = await requireManage(c, deps, ws);
    const store = await waStore(ws, storeId);
    const r = await activateAutomation({ store, id: idParam.parse(id), userId: a.user.id, ip: clientIp(c), subscribeCustomers: () => ensureCustomerWebhook(store, storeGraphql(store, deps.coord, deps.fetchImpl)) });
    return c.json({ automation: automationView(r, []) });
  });

  app.post(`${base}/automations/:id/pause`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    const a = await requireManage(c, deps, ws);
    const store = await waStore(ws, storeId);
    const r = await pauseAutomation({ store, id: idParam.parse(id), userId: a.user.id, ip: clientIp(c) });
    return c.json({ automation: automationView(r.automation, null), cancelled: r.cancelled });
  });

  /** "Sending to: your customers / only you" (test mode), without opening the builder. */
  app.post(`${base}/automations/:id/test-mode`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    const a = await requireManage(c, deps, ws);
    const store = await waStore(ws, storeId);
    const { testMode } = z.object({ testMode: z.boolean() }).parse(await body(c));
    const r = await setAutomationTestMode({ store, id: idParam.parse(id), userId: a.user.id, testMode, ip: clientIp(c) });
    return c.json({ automation: automationView(r.automation, await automationIssuesFor(store, r.automation)), cancelled: r.cancelled });
  });

  app.post(`${base}/automations/:id/test`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    const a = await requireManage(c, deps, ws);
    const store = await waStore(ws, storeId);
    await limit(deps.coord, `rl:wa-test:${store.id}`, LIMITS.waTest);
    return c.json(await testAutomation(deps, { store, id: idParam.parse(id), userId: a.user.id }), 201);
  });

  // ---------------------------------------------------------------------------
  // Campaigns
  // ---------------------------------------------------------------------------

  app.get(`${base}/campaigns`, async (c) => {
    const { ws, storeId } = c.req.param();
    await requireView(c, deps, ws);
    const store = await waStore(ws, storeId);
    const rows = await withTenant(ws, (tx) => tx.wappCampaign.findMany({ where: { storeId: store.id, workspaceId: ws }, orderBy: { createdAt: "desc" }, take: 100 }));
    const out = [];
    for (const r of rows) out.push(campaignView(r, r.status === "draft" ? undefined : await campaignReport(r.id)));
    return c.json({ campaigns: out });
  });

  app.post(`${base}/campaigns/estimate`, async (c) => {
    const { ws, storeId } = c.req.param();
    await requireManage(c, deps, ws);
    const store = await waStore(ws, storeId);
    await limit(deps.coord, `rl:wa-estimate:${store.id}`, LIMITS.waEstimate);
    const { audience, templateId } = z.object({ audience: z.unknown(), templateId: idParam.nullable().optional() }).parse(await body(c));
    const template = templateId ? await withTenant(ws, (tx) => tx.wappTemplate.findFirst({ where: { id: templateId, storeId: store.id, workspaceId: ws } })) : null;
    return c.json({ count: await estimateWaAudience(store.id, audience, template) });
  });

  app.post(`${base}/campaigns`, async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireManage(c, deps, ws);
    const store = await waStore(ws, storeId);
    return c.json({ campaign: campaignView(await saveCampaign({ store, userId: a.user.id, data: await body(c), ip: clientIp(c) })) }, 201);
  });

  app.get(`${base}/campaigns/:id`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    await requireView(c, deps, ws);
    const store = await waStore(ws, storeId);
    const r = await withTenant(ws, (tx) => tx.wappCampaign.findFirst({ where: { id: idParam.parse(id), storeId: store.id, workspaceId: ws } }));
    if (!r) throw new HttpError(404, "Not found", "not_found");
    return c.json({ campaign: campaignView(r, await campaignReport(r.id)) });
  });

  app.put(`${base}/campaigns/:id`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    const a = await requireManage(c, deps, ws);
    const store = await waStore(ws, storeId);
    return c.json({ campaign: campaignView(await saveCampaign({ store, userId: a.user.id, id: idParam.parse(id), data: await body(c), ip: clientIp(c) })) });
  });

  app.delete(`${base}/campaigns/:id`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    const a = await requireManage(c, deps, ws);
    const store = await waStore(ws, storeId);
    await deleteCampaign({ store, id: idParam.parse(id), userId: a.user.id, ip: clientIp(c) });
    return c.json({ ok: true });
  });

  /** Launch (now or later): only with the exact recipient count the merchant confirmed. */
  app.post(`${base}/campaigns/:id/launch`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    const a = await requireManage(c, deps, ws);
    const store = await waStore(ws, storeId);
    return c.json({ campaign: campaignView(await launchCampaign(deps, { store, id: idParam.parse(id), userId: a.user.id, data: await body(c), ip: clientIp(c) })) });
  });

  app.post(`${base}/campaigns/:id/cancel`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    const a = await requireManage(c, deps, ws);
    const store = await waStore(ws, storeId);
    const r = await cancelCampaign({ store, id: idParam.parse(id), userId: a.user.id, ip: clientIp(c) });
    return c.json({ campaign: campaignView(r.campaign), cancelled: r.cancelled });
  });

  // ---------------------------------------------------------------------------
  // Customers: consent and the do-not-message list
  // ---------------------------------------------------------------------------

  app.get(`${base}/contacts`, async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireView(c, deps, ws);
    requireContacts(a);
    const store = await waStore(ws, storeId);
    const q = z.object({ phone: z.string().trim().min(6).max(32).optional(), consent: z.enum(["opted_in", "opted_out", "unknown"]).optional(), cursor: idParam.optional() }).parse(c.req.query());
    const where: Prisma.WappContactWhereInput = { storeId: store.id, workspaceId: ws };
    if (q.phone) {
      const p = normalizePhone(q.phone, null);
      if (!p) throw new HttpError(400, "Search with a full international number (+61...).", "invalid_phone");
      where.phoneHash = waPhoneHash(store.id, p.waId);
    }
    if (q.consent === "opted_out") where.optedOut = true;
    else if (q.consent) where.marketing = q.consent;
    if (q.cursor) where.id = { lt: q.cursor };
    const rows = await withTenant(ws, (tx) => tx.wappContact.findMany({ where, orderBy: { id: "desc" }, take: 51 }));
    const page = rows.slice(0, 50);
    const events = await withTenant(ws, (tx) => tx.wappConsentEvent.findMany({ where: { workspaceId: ws, contactId: { in: page.map((r) => r.id) } }, orderBy: { occurredAt: "desc" } }));
    return c.json({
      contacts: page.map((r) => ({
        id: r.id,
        phone: r.phoneMasked,
        firstName: r.firstNameEnc ? waDecrypt(r.storeId, "name", r.firstNameEnc) : null,
        country: r.country,
        optedOut: r.optedOut,
        optedIn: r.optedIn,
        marketing: r.marketing,
        lastInboundAt: r.lastInboundAt,
        lastOutboundAt: r.lastOutboundAt,
        ordersCount: r.ordersCount,
        history: events.filter((e) => e.contactId === r.id).slice(0, 5).map((e) => ({ scope: e.scope, status: e.status, source: e.source, sourceLabel: WA_CONSENT_SOURCE_LABEL[e.source as WaConsentSource] ?? e.source, note: e.note, at: e.occurredAt })),
      })),
      nextCursor: rows.length > 50 ? page.at(-1)!.id : null,
    });
  });

  app.post(`${base}/contacts/consent`, async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireManage(c, deps, ws);
    requireContacts(a);
    const store = await waStore(ws, storeId);
    const d = z
      .object({ phone: z.string().trim().min(6).max(32), country: z.string().trim().length(2).nullable().optional(), scope: z.enum(["all", "order_updates", "marketing"]), status: z.enum(["opted_in", "opted_out"]), note: z.string().trim().max(300).nullable().optional() })
      .parse(await body(c));
    const contact = await setConsentByMerchant(store, { ...d, userId: a.user.id, ip: clientIp(c) });
    return c.json({ contact: { id: contact.id, phone: contact.phoneMasked, optedOut: contact.optedOut, optedIn: contact.optedIn, marketing: contact.marketing } });
  });

  app.get(`${base}/suppressions`, async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireView(c, deps, ws);
    requireContacts(a);
    const store = await waStore(ws, storeId);
    const rows = await withTenant(ws, (tx) => tx.wappSuppression.findMany({ where: { storeId: store.id, workspaceId: ws }, orderBy: { createdAt: "desc" }, take: 200 }));
    return c.json({ suppressions: rows.map((r) => ({ id: r.id, phone: r.phoneMasked, scope: r.scope, reason: r.reason, note: r.note, createdAt: r.createdAt })) });
  });

  app.post(`${base}/suppressions`, async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireManage(c, deps, ws);
    const store = await waStore(ws, storeId);
    const d = z.object({ phone: z.string().trim().min(6).max(32), country: z.string().trim().length(2).nullable().optional(), scope: z.enum(["all", "marketing"]), note: z.string().trim().max(300).nullable().optional() }).parse(await body(c));
    const row = await addWaSuppression(store, { ...d, userId: a.user.id, ip: clientIp(c) });
    return c.json({ suppression: { id: row.id, phone: row.phoneMasked, scope: row.scope } }, 201);
  });

  app.delete(`${base}/suppressions/:id`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    const a = await requireManage(c, deps, ws);
    const store = await waStore(ws, storeId);
    await removeWaSuppression(store, idParam.parse(id), { userId: a.user.id, ip: clientIp(c) });
    return c.json({ ok: true });
  });
}

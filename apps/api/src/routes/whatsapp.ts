import { z } from "zod";
import { systemDb, withTenant, type Prisma } from "@app/db";
import {
  accountNumbers,
  audit,
  checkConnection,
  chooseNumber,
  disconnect,
  finishSignup,
  legacyConnection,
  liveConnection,
  receiveCustomEvent,
  registerWithPin,
  removeTemplate,
  retryMessage,
  revealPin,
  revokeEventKey,
  rotateEventKey,
  sendManual,
  sendTest,
  setConsent,
  settingsOf,
  startSignup,
  submitTemplate,
  syncTemplates,
  connectionToken,
  waEncrypt,
  waPhoneHash,
  waPlatform,
  waPlatformMissing,
  waWebhookUrl,
  WhatsappError,
  contactFirstName,
  messagePreview,
} from "@app/core";
import {
  customEventSchema,
  mappingSchema,
  maskPhone,
  normalizePhone,
  ORDER_UPDATE_BASES,
  sendWindowSchema,
  STARTER_TEMPLATES,
  statusBucket,
  templateDraftSchema,
  templateRefSchema,
  templateShape,
  WA_MESSAGE_STATUSES,
  type TemplateComponent,
  type TemplateMapping,
} from "@app/shared";
import { body, clientIp, HttpError, type Deps } from "../context.js";
import type { App } from "../app.js";
import { limit, LIMITS } from "../rateLimit.js";
import { base, connectionView, messageView, requireContacts, requireWaConnect, requireWaManage, requireWaView, seesContacts, settingsJson, templateView, waCan, waStore } from "./whatsappCommon.js";

/**
 * WhatsApp Automation for a store, for the signed-in merchant (docs/whatsapp.md): the overview,
 * connecting the number with Meta's Embedded Signup (its finish, a number to choose, the number's
 * PIN, "Check again", disconnect), settings, templates, the message history and sending, contacts
 * and their consent, and test events. Workflows and campaigns are in whatsappAutomation.ts.
 *
 * Reading needs "View campaigns"; anything that changes what customers receive needs the store's
 * owners or admins; connecting needs "Manage integrations". Tokens never reach the browser.
 */

const DAY = 86_400_000;
const idParam = z.string().trim().min(1).max(64);

export function whatsappRoutes(app: App, deps: Deps) {
  /** Everything the WhatsApp Automation page opens with, in one call. */
  app.get(base, async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireWaView(c, deps, ws);
    const store = await waStore(ws, storeId);
    const can = waCan(a);
    const now = Date.now();
    const data = await withTenant(ws, async (tx) => {
      const [conn, templates, week, month, recent, workflows, campaigns] = await Promise.all([
        tx.waConnection.findUnique({ where: { storeId } }),
        tx.waTemplate.findMany({ where: { storeId, workspaceId: ws }, select: { status: true } }),
        tx.waMessage.groupBy({ by: ["status", "direction"], where: { storeId, workspaceId: ws, createdAt: { gte: new Date(now - 7 * DAY) }, source: { not: "test" } }, _count: { _all: true } }),
        tx.waMessage.groupBy({ by: ["status", "direction"], where: { storeId, workspaceId: ws, createdAt: { gte: new Date(now - 30 * DAY) }, source: { not: "test" } }, _count: { _all: true } }),
        tx.waMessage.findMany({ where: { storeId, workspaceId: ws }, orderBy: { createdAt: "desc" }, take: 8 }),
        tx.waWorkflow.groupBy({ by: ["status"], where: { storeId, workspaceId: ws }, _count: { _all: true } }),
        tx.waCampaign.groupBy({ by: ["status"], where: { storeId, workspaceId: ws }, _count: { _all: true } }),
      ]);
      const failures = await tx.waMessage.groupBy({
        by: ["errorTitle", "reason"],
        where: { storeId, workspaceId: ws, status: "failed", createdAt: { gte: new Date(now - 7 * DAY) } },
        _count: { _all: true },
        orderBy: { _count: { id: "desc" } },
        take: 5,
      });
      return { conn, templates, week, month, recent, workflows, campaigns, failures };
    });
    const conn = data.conn;
    const live = conn && conn.status !== "disconnected" ? conn : null;
    const dead = live ? await systemDb.waWebhookEvent.count({ where: { status: "dead", wabaIds: { has: live.wabaId }, receivedAt: { gte: new Date(now - 7 * DAY) } } }) : 0;
    const settings = await settingsOf(storeId);
    const stats = (rows: typeof data.week) => {
      const out = { pending: 0, sent: 0, delivered: 0, read: 0, failed: 0, skipped: 0, received: 0 };
      for (const r of rows) {
        if (r.direction === "in") {
          out.received += r._count._all;
          continue;
        }
        const b = statusBucket(r.status);
        if (b === "pending") out.pending += r._count._all;
        else if (b === "sent") out.sent += r._count._all;
        else if (b === "delivered") {
          out.delivered += r._count._all;
          if (r.status === "read") out.read += r._count._all;
        } else if (b === "failed") out.failed += r._count._all;
        else if (r.status === "skipped") out.skipped += r._count._all;
      }
      return out;
    };
    const count = (rows: Array<{ status: string; _count: { _all: number } }>, s: string) => rows.find((r) => r.status === s)?._count._all ?? 0;
    const approved = data.templates.filter((t) => t.status === "APPROVED").length;
    const missing = waPlatformMissing();
    const platform = waPlatform();
    const legacy = live ? null : await legacyConnection(storeId);

    // What needs the merchant, in the order it matters.
    const problems: Array<{ key: string; title: string; detail: string }> = [];
    if (live?.status === "reconnect") problems.push({ key: "reconnect", title: "Reconnect WhatsApp", detail: live.statusDetail ?? "Meta no longer accepts bizinsights' access. Nothing is sent until you reconnect." });
    if (live?.status === "error") problems.push({ key: "account", title: "Problem with your WhatsApp account", detail: live.statusDetail ?? "Meta restricted the account. Check WhatsApp Manager." });
    if (live?.status === "action_required" && live.statusDetail) problems.push({ key: `step:${live.step}`, title: "One more step", detail: live.statusDetail });
    if (live && !live.subscribedAt) problems.push({ key: "webhooks", title: "Replies aren't reaching bizinsights yet", detail: "Press Check again. Until it works, delivery reports and STOP replies don't arrive, and campaigns can't be sent." });
    if (live && live.qualityRating === "RED") problems.push({ key: "quality", title: "Your number's quality is low", detail: "Customers are blocking or reporting your messages. Send fewer marketing messages and make sure customers expect them, or Meta may limit the number." });
    if (dead) problems.push({ key: "webhook_failed", title: "Some updates from WhatsApp couldn't be applied", detail: `${dead} update${dead === 1 ? "" : "s"} from Meta failed in the last 7 days. Delivery statuses may be out of date; contact support if this keeps happening.` });
    for (const f of data.failures) problems.push({ key: `failed:${f.reason}:${f.errorTitle}`, title: `${f._count._all} message${f._count._all === 1 ? "" : "s"} failed`, detail: f.errorTitle ?? "WhatsApp couldn't send them." });
    if (live && settings.orderUpdates === "unset") problems.push({ key: "consent", title: "Choose how customers agree to updates", detail: "Order and service updates go to nobody until you choose, in Settings." });

    return c.json({
      // Public ids (Meta's SDK needs them in the page); the secret never leaves the server.
      platform: { ready: !!platform, ...(platform ? { appId: platform.appId, configId: platform.configId, version: platform.version } : {}), ...(can.connect ? { missing } : {}) },
      connection: connectionView(conn),
      legacy,
      can,
      store: { name: store.name ?? store.shopDomain, timezone: store.timezone, currency: store.currency },
      settings: settingsJson(settings),
      stats: { last7Days: stats(data.week), last30Days: stats(data.month) },
      checklist: {
        connected: !!live,
        registered: !!live?.registered,
        subscribed: !!live?.subscribedAt,
        approvedTemplates: approved,
        consentChosen: settings.orderUpdates !== "unset",
        testPhone: settings.hasTestPhone,
        activeWorkflows: count(data.workflows, "active"),
      },
      counts: {
        templates: { approved, pending: data.templates.filter((t) => t.status === "PENDING" || t.status === "IN_APPEAL").length, rejected: data.templates.filter((t) => ["REJECTED", "PAUSED", "DISABLED"].includes(t.status)).length },
        workflows: { active: count(data.workflows, "active"), total: data.workflows.reduce((s, r) => s + r._count._all, 0) },
        campaigns: { scheduled: count(data.campaigns, "scheduled"), sending: count(data.campaigns, "sending"), total: data.campaigns.reduce((s, r) => s + r._count._all, 0) },
      },
      problems,
      recent: data.recent.map((m) => messageView(m, { contacts: can.contacts })),
      webhookUrl: waWebhookUrl(),
    });
  });

  // ---------------------------------------------------------------- connecting

  /** Start Meta's Embedded Signup: the ids its SDK needs and a nonce the finish brings back. */
  app.post(`${base}/connect/start`, async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireWaConnect(c, deps, ws);
    const store = await waStore(ws, storeId);
    await limit(deps.coord, `rl:wa-connect:${storeId}`, LIMITS.waConnect, "Too many tries. Wait a few minutes and press Connect WhatsApp again.");
    return c.json(await startSignup(deps, { store, userId: a.user.id }));
  });

  /** Meta's window finished: exchange the code (it lives 30 seconds), check everything, save. */
  app.post(`${base}/connect/finish`, async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireWaConnect(c, deps, ws);
    const store = await waStore(ws, storeId);
    const id = z.string().regex(/^\d{3,30}$/).nullish();
    const input = z
      .object({ nonce: z.string().uuid(), code: z.string().min(10).max(2000), flow: z.enum(["cloud_api", "only_waba", "business_app", "other"]).nullish(), wabaId: id, phoneNumberId: id, businessId: id })
      .parse(await body(c));
    const conn = await finishSignup(deps, {
      store,
      userId: a.user.id,
      ip: clientIp(c),
      nonce: input.nonce,
      code: input.code,
      flow: input.flow ?? null,
      wabaId: input.wabaId ?? null,
      phoneNumberId: input.phoneNumberId ?? null,
      businessId: input.businessId ?? null,
    });
    return c.json({ connection: connectionView(conn) });
  });

  /** The numbers in the connected account (for "Choose a number"). */
  app.get(`${base}/connect/numbers`, async (c) => {
    const { ws, storeId } = c.req.param();
    await requireWaConnect(c, deps, ws);
    const store = await waStore(ws, storeId);
    return c.json({ numbers: await accountNumbers(deps, store) });
  });

  app.post(`${base}/connect/number`, async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireWaConnect(c, deps, ws);
    const store = await waStore(ws, storeId);
    const { phoneNumberId } = z.object({ phoneNumberId: z.string().regex(/^\d{3,30}$/) }).parse(await body(c));
    await limit(deps.coord, `rl:wa-connect:${storeId}`, LIMITS.waConnect);
    return c.json({ connection: connectionView(await chooseNumber(deps, { store, userId: a.user.id, phoneNumberId, ip: clientIp(c) })) });
  });

  /** The number's own two-step verification PIN, to finish registering it. */
  app.post(`${base}/connect/pin`, async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireWaConnect(c, deps, ws);
    const store = await waStore(ws, storeId);
    const { pin } = z.object({ pin: z.string().regex(/^\d{6}$/, "The PIN is 6 digits") }).parse(await body(c));
    await limit(deps.coord, `rl:wa-connect:${storeId}`, LIMITS.waConnect, "Too many tries. Wait a few minutes before entering the PIN again.");
    return c.json({ connection: connectionView(await registerWithPin(deps, { store, userId: a.user.id, pin, ip: clientIp(c) })) });
  });

  /** "Check again": the number, the webhooks and the templates, from Meta, now. */
  app.post(`${base}/connect/check`, async (c) => {
    const { ws, storeId } = c.req.param();
    await requireWaConnect(c, deps, ws);
    await waStore(ws, storeId);
    const conn = await liveConnection(storeId);
    if (!conn) throw new HttpError(409, "Connect WhatsApp first.", "not_connected");
    await limit(deps.coord, `rl:wa-refresh:${storeId}`, LIMITS.waRefresh, "WhatsApp was checked a moment ago. Wait a few minutes before checking again.");
    const result = await checkConnection(deps, conn);
    return c.json({ connection: connectionView(await systemDb.waConnection.findUnique({ where: { storeId } })), templates: result.templates });
  });

  /** Disconnect: bizinsights' access is deleted, waiting messages and running campaigns cancelled, history kept. */
  app.delete(base, async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireWaConnect(c, deps, ws);
    const store = await waStore(ws, storeId);
    await disconnect(deps, { store, userId: a.user.id, ip: clientIp(c) });
    return c.json({ ok: true });
  });

  /** The PIN bizinsights set on the number, for an owner or admin moving it to another provider. Audited. */
  app.post(`${base}/pin`, async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireWaManage(c, deps, ws);
    if (!waCan(a).pin) throw new HttpError(403, "Only owners and admins can see the PIN.", "forbidden");
    const store = await waStore(ws, storeId);
    await limit(deps.coord, `rl:wa-pin:${a.user.id}`, LIMITS.waPin);
    const pin = await revealPin({ store, userId: a.user.id, ip: clientIp(c) });
    if (!pin) throw new HttpError(404, "bizinsights didn't set this number's PIN: it is the one you chose in WhatsApp Manager.", "no_pin");
    return c.json({ pin });
  });

  // ---------------------------------------------------------------- settings

  app.get(`${base}/settings`, async (c) => {
    const { ws, storeId } = c.req.param();
    await requireWaView(c, deps, ws);
    await waStore(ws, storeId);
    return c.json(settingsJson(await settingsOf(storeId)));
  });

  app.put(`${base}/settings`, async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireWaManage(c, deps, ws);
    const store = await waStore(ws, storeId);
    const input = z
      .object({
        orderUpdates: z.enum(ORDER_UPDATE_BASES).optional(),
        shopifySmsConsent: z.boolean().optional(),
        sendWindow: sendWindowSchema.optional(),
        dailyLimit: z.number().int().min(1).max(1_000_000).nullable().optional(),
        /** The merchant's own WhatsApp number for tests; null removes it. */
        testPhone: z.string().trim().max(40).nullable().optional(),
        testPhoneCountry: z.string().regex(/^[A-Z]{2}$/).optional(),
      })
      .parse(await body(c));
    const data: Prisma.WaSettingsUncheckedUpdateInput = { updatedByUserId: a.user.id };
    const now = new Date();
    if (input.orderUpdates !== undefined) Object.assign(data, { orderUpdates: input.orderUpdates, orderUpdatesSetBy: a.user.id, orderUpdatesSetAt: now });
    if (input.shopifySmsConsent !== undefined) data.shopifySmsConsent = input.shopifySmsConsent;
    if (input.sendWindow) Object.assign(data, { sendWindowStart: input.sendWindow.start, sendWindowEnd: input.sendWindow.end });
    if (input.dailyLimit !== undefined) data.dailyLimit = input.dailyLimit;
    if (input.testPhone !== undefined) {
      if (input.testPhone === null || input.testPhone === "") Object.assign(data, { testPhoneEnc: null, testPhoneMasked: null });
      else {
        const phone = normalizePhone(input.testPhone, input.testPhoneCountry ?? null);
        if (!phone) throw new HttpError(400, "That number can't be read. Use the international format, like +61412345678.", "invalid_phone");
        Object.assign(data, { testPhoneEnc: waEncrypt(storeId, "test_phone", phone.e164), testPhoneMasked: maskPhone(phone.e164) });
      }
    }
    const before = await settingsOf(storeId);
    await systemDb.waSettings.upsert({ where: { storeId }, create: { ...(data as Prisma.WaSettingsUncheckedCreateInput), storeId, workspaceId: ws }, update: data });
    await audit({
      workspaceId: ws,
      actorUserId: a.user.id,
      action: "whatsapp.settings_changed",
      targetType: "store",
      targetId: store.id,
      metadata: {
        ...(input.orderUpdates !== undefined && input.orderUpdates !== before.orderUpdates ? { orderUpdates: { from: before.orderUpdates, to: input.orderUpdates } } : {}),
        ...(input.shopifySmsConsent !== undefined ? { shopifySmsConsent: input.shopifySmsConsent } : {}),
        ...(input.sendWindow ? { sendWindow: input.sendWindow } : {}),
        ...(input.dailyLimit !== undefined ? { dailyLimit: input.dailyLimit } : {}),
        ...(input.testPhone !== undefined ? { testPhone: input.testPhone ? "set" : "removed" } : {}),
      },
      ip: clientIp(c),
    });
    return c.json(settingsJson(await settingsOf(storeId)));
  });

  /** A new custom-event key (shown this once; the old one stops working). */
  app.post(`${base}/settings/event-key`, async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireWaManage(c, deps, ws);
    const store = await waStore(ws, storeId);
    const key = await rotateEventKey({ store, userId: a.user.id, ip: clientIp(c) });
    return c.json({ key, endpoint: `${waWebhookUrl().replace(/\/webhooks\/whatsapp$/, "")}/whatsapp/events` });
  });

  app.delete(`${base}/settings/event-key`, async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireWaManage(c, deps, ws);
    const store = await waStore(ws, storeId);
    await revokeEventKey({ store, userId: a.user.id, ip: clientIp(c) });
    return c.json({ ok: true });
  });

  // ---------------------------------------------------------------- templates

  app.get(`${base}/templates`, async (c) => {
    const { ws, storeId } = c.req.param();
    await requireWaView(c, deps, ws);
    await waStore(ws, storeId);
    const [templates, workflows, campaigns] = await withTenant(ws, (tx) =>
      Promise.all([
        tx.waTemplate.findMany({ where: { storeId, workspaceId: ws }, orderBy: [{ status: "asc" }, { name: "asc" }] }),
        tx.waWorkflow.groupBy({ by: ["templateName", "templateLanguage"], where: { storeId, workspaceId: ws }, _count: { _all: true } }),
        tx.waCampaign.groupBy({ by: ["templateName", "templateLanguage"], where: { storeId, workspaceId: ws, status: { in: ["draft", "scheduled", "sending"] } }, _count: { _all: true } }),
      ]),
    );
    const used = (rows: typeof workflows, name: string, language: string) => rows.find((r) => r.templateName === name && r.templateLanguage === language)?._count._all ?? 0;
    return c.json({
      templates: templates.map((t) => templateView(t, { workflows: used(workflows, t.name, t.language), campaigns: used(campaigns, t.name, t.language) })),
      starters: STARTER_TEMPLATES,
    });
  });

  /** Write a template and submit it for Meta's review. */
  app.post(`${base}/templates`, async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireWaManage(c, deps, ws);
    const store = await waStore(ws, storeId);
    const draft = templateDraftSchema.parse(await body(c));
    await limit(deps.coord, `rl:wa-template:${storeId}`, LIMITS.waTemplateCreate, "Too many templates submitted in an hour. Wait a little and try again.");
    const t = await submitTemplate(deps, { store, draft, userId: a.user.id, ip: clientIp(c) });
    return c.json({ template: templateView(t) }, 201);
  });

  /** Read the templates from Meta again now. */
  app.post(`${base}/templates/sync`, async (c) => {
    const { ws, storeId } = c.req.param();
    await requireWaManage(c, deps, ws);
    await waStore(ws, storeId);
    const conn = await liveConnection(storeId);
    if (!conn) throw new HttpError(409, "Connect WhatsApp first.", "not_connected");
    await limit(deps.coord, `rl:wa-refresh:${storeId}`, LIMITS.waRefresh, "Templates were refreshed a moment ago. Wait a few minutes.");
    const token = await connectionToken(conn, deps);
    const count = await syncTemplates(conn, token, deps.fetchImpl).catch((err: unknown) => {
      throw err instanceof WhatsappError ? err : new HttpError(503, "WhatsApp didn't answer just now. Try again in a minute.", "meta_unavailable");
    });
    return c.json({ count });
  });

  app.delete(`${base}/templates/:id`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    const a = await requireWaManage(c, deps, ws);
    const store = await waStore(ws, storeId);
    await limit(deps.coord, `rl:wa-template:${storeId}`, LIMITS.waTemplateCreate);
    await removeTemplate(deps, { store, templateId: idParam.parse(id), userId: a.user.id, ip: clientIp(c) });
    return c.json({ ok: true });
  });

  /** An approved template to the merchant's own test number, with sample values (or the given mapping). */
  app.post(`${base}/templates/:id/test`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    const a = await requireWaManage(c, deps, ws);
    const store = await waStore(ws, storeId);
    const t = await withTenant(ws, (tx) => tx.waTemplate.findFirst({ where: { id: idParam.parse(id), storeId, workspaceId: ws } }));
    if (!t) throw new HttpError(404, "That template wasn't found.", "not_found");
    const input = z.object({ mapping: mappingSchema.optional(), headerMediaUrl: z.string().url().max(2000).nullish() }).parse(await body(c).catch(() => ({})));
    await limit(deps.coord, `rl:wa-test:${storeId}`, LIMITS.waTest, "Too many test messages. Wait a few minutes.");
    const shape = templateShape(t.components as unknown as TemplateComponent[]);
    const sample: TemplateMapping = input.mapping ?? {
      header: shape.headerVars ? { source: "custom_text", text: "Sample" } : null,
      body: Array.from({ length: shape.bodyVars }, (_x, i) => ({ source: "custom_text" as const, text: `sample ${i + 1}` })),
      buttons: shape.dynamicUrlButtons.map(() => ({ source: "custom_text" as const, text: "example" })),
    };
    const message = await sendTest(deps, { store, userId: a.user.id, template: { name: t.name, language: t.language }, mapping: sample, headerMediaUrl: input.headerMediaUrl ?? null, label: `template:${t.id}` });
    return c.json({ message: messageView(message, { contacts: true }) }, 202);
  });

  // ---------------------------------------------------------------- messages

  app.get(`${base}/messages`, async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireWaView(c, deps, ws);
    await waStore(ws, storeId);
    const q = z
      .object({
        status: z.enum(WA_MESSAGE_STATUSES).optional(),
        direction: z.enum(["out", "in"]).optional(),
        source: z.enum(["workflow", "campaign", "manual", "test", "team_alert", "inbound"]).optional(),
        workflowId: idParam.optional(),
        campaignId: idParam.optional(),
        contactId: idParam.optional(),
        cursor: idParam.optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .parse(c.req.query());
    if (q.contactId) requireContacts(a);
    const rows = await withTenant(ws, (tx) =>
      tx.waMessage.findMany({
        where: {
          storeId,
          workspaceId: ws,
          ...(q.status ? { status: q.status } : {}),
          ...(q.direction ? { direction: q.direction } : {}),
          ...(q.source ? { source: q.source } : {}),
          ...(q.workflowId ? { workflowId: q.workflowId } : {}),
          ...(q.campaignId ? { campaignId: q.campaignId } : {}),
          ...(q.contactId ? { contactId: q.contactId } : {}),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: q.limit + 1,
        ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      }),
    );
    const page = rows.slice(0, q.limit);
    return c.json({ messages: page.map((m) => messageView(m, { contacts: seesContacts(a) })), nextCursor: rows.length > q.limit ? page.at(-1)!.id : null });
  });

  app.get(`${base}/messages/:id`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    const a = await requireWaView(c, deps, ws);
    await waStore(ws, storeId);
    const found = await withTenant(ws, async (tx) => {
      const m = await tx.waMessage.findFirst({ where: { id: idParam.parse(id), storeId, workspaceId: ws } });
      if (!m) return null;
      const events = await tx.waMessageEvent.findMany({ where: { messageId: m.id, workspaceId: ws }, orderBy: { occurredAt: "asc" } });
      return { m, events };
    });
    if (!found) throw new HttpError(404, "That message wasn't found.", "not_found");
    return c.json({
      message: messageView(found.m, { contacts: seesContacts(a) }),
      events: found.events.map((e) => ({ status: e.status, at: e.occurredAt, errorCode: e.errorCode, errorTitle: e.errorTitle })),
    });
  });

  app.post(`${base}/messages/:id/retry`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    const a = await requireWaManage(c, deps, ws);
    const store = await waStore(ws, storeId);
    await limit(deps.coord, `rl:wa-send:${storeId}`, LIMITS.waSend);
    const m = await retryMessage(deps, { storeId: store.id, messageId: idParam.parse(id) });
    await audit({ workspaceId: ws, actorUserId: a.user.id, action: "whatsapp.message_retried", targetType: "whatsapp_message", targetId: m.id, ip: clientIp(c) });
    return c.json({ message: messageView(m, { contacts: seesContacts(a) }) });
  });

  /** One message from the dashboard: an approved template, or a reply within the customer's 24-hour window. */
  app.post(`${base}/messages`, async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireWaManage(c, deps, ws);
    requireContacts(a);
    const store = await waStore(ws, storeId);
    const https = z.string().trim().url().max(2000).refine((u) => u.startsWith("https://"), "Links must start with https://");
    const input = z
      .object({
        requestId: z.string().uuid(),
        to: z.union([z.object({ contactId: idParam }), z.object({ phone: z.string().trim().min(6).max(40), country: z.string().regex(/^[A-Z]{2}$/).nullish() })]),
        message: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("template"), template: templateRefSchema, mapping: mappingSchema, headerMediaUrl: https.nullish() }),
          z.object({ kind: z.literal("text"), body: z.string().trim().min(1).max(4096) }),
          z.object({ kind: z.literal("media"), mediaType: z.enum(["image", "document", "video"]), link: https, caption: z.string().trim().max(1024).nullish(), filename: z.string().trim().max(200).nullish() }),
        ]),
      })
      .parse(await body(c));
    await limit(deps.coord, `rl:wa-send:${storeId}`, LIMITS.waSend, "Too many messages sent from here in a short time. Wait a few minutes.");
    const message = await sendManual(deps, { store, userId: a.user.id, to: input.to, message: input.message, requestId: input.requestId });
    await audit({ workspaceId: ws, actorUserId: a.user.id, action: "whatsapp.message_sent", targetType: "whatsapp_message", targetId: message.id, metadata: { kind: input.message.kind }, ip: clientIp(c) });
    return c.json({ message: messageView(message, { contacts: true }) }, 202);
  });

  // ---------------------------------------------------------------- contacts and consent

  app.get(`${base}/contacts`, async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireWaView(c, deps, ws);
    requireContacts(a);
    await waStore(ws, storeId);
    const q = z
      .object({ consent: z.enum(["marketing", "opted_out", "any"]).default("any"), phone: z.string().trim().max(40).optional(), cursor: idParam.optional(), limit: z.coerce.number().int().min(1).max(100).default(50) })
      .parse(c.req.query());
    const phone = q.phone ? normalizePhone(q.phone, null) : null;
    if (q.phone && !phone) return c.json({ contacts: [], nextCursor: null });
    const rows = await withTenant(ws, (tx) =>
      tx.waContact.findMany({
        where: {
          storeId,
          workspaceId: ws,
          ...(q.consent === "marketing" ? { marketing: "opted_in", optedOut: false } : q.consent === "opted_out" ? { optedOut: true } : {}),
          ...(phone ? { phoneHash: waPhoneHash(storeId, phone.waId) } : {}),
        },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: q.limit + 1,
        ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      }),
    );
    const page = rows.slice(0, q.limit);
    const now = Date.now();
    return c.json({
      contacts: page.map((ct) => ({
        id: ct.id,
        phone: ct.phoneMasked,
        firstName: contactFirstName(ct),
        country: ct.country,
        optedOut: ct.optedOut,
        optedIn: ct.optedIn,
        marketing: ct.marketing,
        lastInboundAt: ct.lastInboundAt,
        windowOpen: !!ct.lastInboundAt && now - ct.lastInboundAt.getTime() < DAY,
        ordersCount: ct.ordersCount,
        lastOrderAt: ct.lastOrderAt,
        createdAt: ct.createdAt,
      })),
      nextCursor: rows.length > q.limit ? page.at(-1)!.id : null,
    });
  });

  app.get(`${base}/contacts/:id`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    const a = await requireWaView(c, deps, ws);
    requireContacts(a);
    await waStore(ws, storeId);
    const found = await withTenant(ws, async (tx) => {
      const ct = await tx.waContact.findFirst({ where: { id: idParam.parse(id), storeId, workspaceId: ws } });
      if (!ct) return null;
      const [consent, messages] = await Promise.all([
        tx.waConsentEvent.findMany({ where: { contactId: ct.id, workspaceId: ws }, orderBy: { occurredAt: "desc" }, take: 50 }),
        tx.waMessage.findMany({ where: { contactId: ct.id, workspaceId: ws }, orderBy: { createdAt: "desc" }, take: 30 }),
      ]);
      return { ct, consent, messages };
    });
    if (!found) throw new HttpError(404, "That customer wasn't found.", "not_found");
    const { ct } = found;
    return c.json({
      contact: { id: ct.id, phone: ct.phoneMasked, firstName: contactFirstName(ct), country: ct.country, optedOut: ct.optedOut, optedIn: ct.optedIn, marketing: ct.marketing, lastInboundAt: ct.lastInboundAt, windowOpen: !!ct.lastInboundAt && Date.now() - ct.lastInboundAt.getTime() < DAY },
      consent: found.consent.map((e) => ({ scope: e.scope, status: e.status, source: e.source, note: e.note, at: e.occurredAt })),
      messages: found.messages.map((m) => ({ ...messageView(m, { contacts: true }), preview: messagePreview(m) })),
    });
  });

  /**
   * Record a customer's consent given another way (in the shop, on the phone), or their opt-out.
   * A STOP can only be undone by the customer (START): recording it here is refused.
   */
  app.post(`${base}/contacts/:id/consent`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    const a = await requireWaManage(c, deps, ws);
    requireContacts(a);
    await waStore(ws, storeId);
    const input = z.object({ scope: z.enum(["all", "marketing"]), status: z.enum(["opted_in", "opted_out"]), note: z.string().trim().min(3, "Say how the customer told you").max(300) }).parse(await body(c));
    const ct = await withTenant(ws, (tx) => tx.waContact.findFirst({ where: { id: idParam.parse(id), storeId, workspaceId: ws } }));
    if (!ct) throw new HttpError(404, "That customer wasn't found.", "not_found");
    if (ct.optedOut && input.status === "opted_in") throw new HttpError(409, "This customer replied STOP. Only they can undo it, by replying START on WhatsApp.", "customer_stopped");
    const { changed } = await setConsent(ct, { scope: input.scope, status: input.status, source: "merchant", at: new Date(), actorUserId: a.user.id, note: input.note });
    await audit({ workspaceId: ws, actorUserId: a.user.id, action: "whatsapp.consent_recorded", targetType: "whatsapp_contact", targetId: ct.id, metadata: { scope: input.scope, status: input.status, changed }, ip: clientIp(c) });
    return c.json({ changed });
  });

  // ---------------------------------------------------------------- test events

  /** A custom event from the dashboard (to try a workflow): the same path the store's tools use. */
  app.post(`${base}/events`, async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireWaManage(c, deps, ws);
    const store = await waStore(ws, storeId);
    const event = customEventSchema.parse(await body(c));
    await limit(deps.coord, `rl:wa-test:${storeId}`, LIMITS.waTest, "Too many test events. Wait a few minutes.");
    const result = await receiveCustomEvent(deps, { store, event });
    await audit({ workspaceId: ws, actorUserId: a.user.id, action: "whatsapp.test_event", targetType: "store", targetId: store.id, metadata: { event: event.event, ...result }, ip: clientIp(c) });
    return c.json(result);
  });
}

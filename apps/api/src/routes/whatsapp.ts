import { z } from "zod";
import { Prisma, systemDb, withTenant, type WhatsappTemplate } from "@app/db";
import {
  audit,
  connectWhatsapp,
  disconnectWhatsapp,
  ensureSettings,
  env,
  logger,
  parseConfig,
  refreshConnection,
  registerWhatsapp,
  scheduleMessage,
  storeName,
  waCreateTemplate,
  waExchangeCode,
  waPlatformConfig,
  WhatsappApiError,
  WhatsappConnectError,
  connectionToken,
  syncTemplates,
} from "@app/core";
import {
  KIND_INFO,
  kindSetting,
  libraryTemplate,
  normalizePhone,
  NOTIFICATION_KINDS,
  templateMappingSchema,
  templateShape,
  whatsappConfigSchema,
  type KindSetting,
  type TemplateComponent,
} from "@app/shared";
import { body, clientIp, HttpError, requireWorkspace, type Deps } from "../context.js";
import type { App } from "../app.js";
import { limit, LIMITS } from "../rateLimit.js";
import { whatsappOpsRoutes } from "./whatsappOps.js";
import { base, publicConnection, publicTemplate, sampleValues, waStore } from "./whatsappCommon.js";

/**
 * WhatsApp for a store, for the signed-in merchant: connect the number (Meta's Embedded Signup,
 * or the merchant's own app and system-user token), choose what is sent and when, templates,
 * test sends, and the overview. Order timelines, carts, reviews, campaigns, automations and the
 * message history are in whatsappOps.ts.
 *
 * Reading is for any member; anything that changes what customers receive needs stores:manage.
 * Tokens and secrets are never returned.
 */

/** Whether a notification's template is ready, and what's wrong if not. */
function templateCheck(templates: WhatsappTemplate[], s: KindSetting): { state: "ready" | "pending" | "rejected" | "missing" | "unset"; problem: string | null; category: string | null } {
  if (!s.templateName) return { state: "unset", problem: "Choose a template", category: null };
  const t = templates.find((x) => x.name === s.templateName && x.language === s.language);
  if (!t) return { state: "missing", problem: `"${s.templateName}" (${s.language}) isn't in your WhatsApp account`, category: null };
  if (t.status === "PENDING" || t.status === "IN_APPEAL") return { state: "pending", problem: "Waiting for Meta's review", category: t.category };
  if (t.status !== "APPROVED") return { state: "rejected", problem: `Meta says ${t.status.toLowerCase()}${t.rejectedReason ? `: ${t.rejectedReason}` : ""}`, category: t.category };
  const shape = templateShape(t.components as unknown as TemplateComponent[]);
  if (s.mapping.body.length < shape.bodyVars) return { state: "missing", problem: `The template has ${shape.bodyVars} variables; ${s.mapping.body.length} are filled`, category: t.category };
  if (s.mapping.buttons.length < shape.dynamicUrlButtons.length) return { state: "missing", problem: "The template's link button needs a value", category: t.category };
  return { state: "ready", problem: null, category: t.category };
}

const connectError = (err: unknown): never => {
  if (err instanceof WhatsappConnectError) throw new HttpError(400, err.message, err.code);
  if (err instanceof WhatsappApiError) throw new HttpError(502, `Meta didn't accept the request: ${err.details ?? err.title}`, "meta_error");
  throw err;
};

const idSchema = z.string().trim().regex(/^\d{5,25}$/, "must be the numeric id from WhatsApp Manager");

export function whatsappRoutes(app: App, deps: Deps) {
  /** Everything the WhatsApp overview needs, in one call. */
  app.get(base, async (c) => {
    const { ws, storeId } = c.req.param();
    const access = await requireWorkspace(c, deps, ws, "dashboard:read");
    const store = await waStore(ws, storeId);
    const manage = access.role === "owner" || access.role === "admin";
    const weekAgo = new Date(Date.now() - 7 * 86_400_000);
    const data = await withTenant(ws, async (tx) => {
      const [settings, conn, templates, byStatus, failed, rules, openCarts, pendingReviews, campaigns, scheduled] = await Promise.all([
        tx.whatsappSettings.findUnique({ where: { storeId } }),
        tx.whatsappConnection.findUnique({ where: { storeId } }),
        tx.whatsappTemplate.findMany({ where: { storeId } }),
        tx.whatsappMessage.groupBy({ by: ["status"], where: { storeId, workspaceId: ws, createdAt: { gte: weekAgo }, test: false }, _count: { _all: true } }),
        tx.whatsappMessage.findMany({
          where: { storeId, workspaceId: ws, status: "failed", createdAt: { gte: weekAgo } },
          orderBy: { createdAt: "desc" },
          take: 5,
          select: { id: true, kind: true, orderName: true, errorTitle: true, phoneMasked: true, createdAt: true },
        }),
        tx.whatsappAutomationRule.count({ where: { storeId, workspaceId: ws, enabled: true } }),
        tx.abandonedCheckout.count({ where: { storeId, workspaceId: ws, status: { in: ["open", "reminded"] } } }),
        tx.customerReview.count({ where: { storeId, workspaceId: ws, status: "pending" } }),
        tx.whatsappCampaign.findMany({ where: { storeId, workspaceId: ws, status: { in: ["scheduled", "sending", "paused"] } }, select: { id: true, name: true, status: true, startAt: true } }),
        tx.whatsappMessage.count({ where: { storeId, workspaceId: ws, status: "scheduled" } }),
      ]);
      return { settings, conn, templates, byStatus, failed, rules, openCarts, pendingReviews, campaigns, scheduled };
    });
    const cfg = parseConfig(data.settings?.config);
    const count = (s: string) => data.byStatus.find((b) => b.status === s)?._count._all ?? 0;
    const notifications = NOTIFICATION_KINDS.map((k) => {
      const s = kindSetting(cfg, k);
      return { kind: k, enabled: s.enabled, templateName: s.templateName, check: templateCheck(data.templates, s) };
    });
    const platform = waPlatformConfig();
    return c.json({
      platform: platform ? { embeddedSignup: true, appId: platform.appId, configId: platform.configId, version: platform.version } : { embeddedSignup: false },
      webhookUrl: `${env().API_URL}/webhooks/whatsapp`,
      enabled: !!data.settings,
      connection: data.conn ? publicConnection(data.conn, manage) : null,
      store: { name: storeName(store), timezone: store.timezone, currency: store.currency },
      setup: {
        connected: !!data.conn,
        registered: !!data.conn?.registered,
        webhookVerified: !!data.conn?.webhookVerifiedAt,
        consentBasis: cfg.transactionalBasis,
        notificationsReady: notifications.filter((n) => n.enabled && n.check.state === "ready").length,
        approvedTemplates: data.templates.filter((t) => t.status === "APPROVED").length,
      },
      last7Days: {
        sent: count("sent") + count("delivered") + count("read"),
        delivered: count("delivered") + count("read"),
        read: count("read"),
        failed: count("failed"),
        skipped: count("skipped"),
      },
      scheduled: data.scheduled,
      notifications,
      automationsEnabled: data.rules,
      attention: {
        failed: data.failed,
        pendingTemplates: data.templates.filter((t) => t.status === "PENDING").length,
        rejectedTemplates: data.templates.filter((t) => ["REJECTED", "PAUSED", "DISABLED"].includes(t.status)).length,
        openCarts: data.openCarts,
        pendingReviews: data.pendingReviews,
        campaigns: data.campaigns,
        problems: notifications.filter((n) => n.enabled && n.check.state !== "ready").map((n) => ({ kind: n.kind, problem: n.check.problem })),
      },
    });
  });

  // ---------------------------------------------------------------- connecting

  /**
   * Embedded Signup finished in the browser: exchange its code (it lives 30 seconds) for the
   * business's token, check the number and account, subscribe webhooks, save.
   */
  app.post(`${base}/embedded`, async (c) => {
    const { ws, storeId } = c.req.param();
    const access = await requireWorkspace(c, deps, ws, "stores:manage");
    const store = await waStore(ws, storeId);
    await limit(deps.coord, `rl:wa-connect:${storeId}`, LIMITS.waConnect);
    const input = z.object({ code: z.string().min(10).max(2000), wabaId: idSchema, phoneNumberId: idSchema, businessId: idSchema.optional() }).parse(await body(c));
    const cfg = waPlatformConfig();
    if (!cfg) throw new HttpError(503, "Connect WhatsApp Business isn't set up on this Insights server yet.", "not_configured");
    let token: string;
    try {
      token = await waExchangeCode(cfg, input.code, deps.fetchImpl);
    } catch (err) {
      logger.warn({ err, storeId }, "whatsapp embedded signup code exchange failed");
      throw new HttpError(400, "Meta didn't accept the sign-in (it expires after 30 seconds). Please press Connect again.", "exchange_failed");
    }
    const conn = await connectWhatsapp({ store, mode: "embedded", wabaId: input.wabaId, phoneNumberId: input.phoneNumberId, businessId: input.businessId, accessToken: token, userId: access.user!.id }, deps.fetchImpl).catch(connectError);
    await audit({ workspaceId: ws, actorUserId: access.user!.id, action: "whatsapp.connected", targetType: "store", targetId: storeId, metadata: { mode: "embedded", wabaId: conn.wabaId, phoneNumberId: conn.phoneNumberId }, ip: clientIp(c) });
    return c.json({ connection: publicConnection(conn, true) });
  });

  /** The merchant's own Meta app: WABA id, phone number id, a system-user token and the app secret. */
  app.post(`${base}/manual`, async (c) => {
    const { ws, storeId } = c.req.param();
    const access = await requireWorkspace(c, deps, ws, "stores:manage");
    const store = await waStore(ws, storeId);
    await limit(deps.coord, `rl:wa-connect:${storeId}`, LIMITS.waConnect);
    const input = z
      .object({
        wabaId: idSchema,
        phoneNumberId: idSchema,
        accessToken: z.string().trim().min(20).max(1000).regex(/^[A-Za-z0-9_-]+$/, "doesn't look like a Meta access token"),
        // Without it, Insights can't verify Meta's deliveries, so it would never hear STOP replies.
        appSecret: z.string().trim().regex(/^[a-f0-9]{32}$/i, "must be the 32-character app secret from your Meta app's Basic settings"),
      })
      .parse(await body(c));
    const conn = await connectWhatsapp({ store, mode: "manual", ...input, userId: access.user!.id }, deps.fetchImpl).catch(connectError);
    await audit({ workspaceId: ws, actorUserId: access.user!.id, action: "whatsapp.connected", targetType: "store", targetId: storeId, metadata: { mode: "manual", wabaId: conn.wabaId, phoneNumberId: conn.phoneNumberId }, ip: clientIp(c) });
    return c.json({ connection: publicConnection(conn, true) });
  });

  /** Register the number with the Cloud API (it can't send until it is). */
  app.post(`${base}/register`, async (c) => {
    const { ws, storeId } = c.req.param();
    const access = await requireWorkspace(c, deps, ws, "stores:manage");
    await waStore(ws, storeId);
    await limit(deps.coord, `rl:wa-connect:${storeId}`, LIMITS.waConnect);
    const { pin } = z.object({ pin: z.string().regex(/^\d{6}$/, "must be 6 digits") }).parse(await body(c));
    const conn = await systemDb.whatsappConnection.findUnique({ where: { storeId } });
    if (!conn || conn.workspaceId !== ws) throw new HttpError(404, "Connect WhatsApp first.", "not_connected");
    const updated = await registerWhatsapp(conn, pin, deps.fetchImpl).catch(connectError);
    await audit({ workspaceId: ws, actorUserId: access.user!.id, action: "whatsapp.number_registered", targetType: "store", targetId: storeId, ip: clientIp(c) });
    return c.json({ connection: publicConnection(updated, true) });
  });

  /** Read the number's status and the templates from Meta again. */
  app.post(`${base}/refresh`, async (c) => {
    const { ws, storeId } = c.req.param();
    await requireWorkspace(c, deps, ws, "stores:manage");
    await waStore(ws, storeId);
    await limit(deps.coord, `rl:wa-refresh:${storeId}`, LIMITS.waRefresh);
    const conn = await systemDb.whatsappConnection.findUnique({ where: { storeId } });
    if (!conn || conn.workspaceId !== ws) throw new HttpError(404, "Connect WhatsApp first.", "not_connected");
    try {
      const updated = await refreshConnection(conn, deps.fetchImpl);
      return c.json({ connection: publicConnection(updated, true) });
    } catch (err) {
      if (err instanceof WhatsappApiError) throw new HttpError(502, `Meta didn't answer as expected: ${err.details ?? err.title}`, "meta_error");
      throw err;
    }
  });

  app.delete(base, async (c) => {
    const { ws, storeId } = c.req.param();
    const access = await requireWorkspace(c, deps, ws, "stores:manage");
    await waStore(ws, storeId);
    const conn = await systemDb.whatsappConnection.findUnique({ where: { storeId } });
    if (!conn || conn.workspaceId !== ws) throw new HttpError(404, "Not connected", "not_connected");
    await disconnectWhatsapp(conn, deps.fetchImpl);
    await audit({ workspaceId: ws, actorUserId: access.user!.id, action: "whatsapp.disconnected", targetType: "store", targetId: storeId, metadata: { wabaId: conn.wabaId }, ip: clientIp(c) });
    return c.json({ ok: true });
  });

  // ---------------------------------------------------------------- settings

  app.get(`${base}/settings`, async (c) => {
    const { ws, storeId } = c.req.param();
    await requireWorkspace(c, deps, ws, "dashboard:read");
    await waStore(ws, storeId);
    const [settings, templates] = await withTenant(ws, (tx) =>
      Promise.all([tx.whatsappSettings.findUnique({ where: { storeId } }), tx.whatsappTemplate.findMany({ where: { storeId }, orderBy: [{ name: "asc" }, { language: "asc" }] })]),
    );
    const cfg = parseConfig(settings?.config);
    return c.json({
      enabled: !!settings,
      config: { ...cfg, notifications: Object.fromEntries(NOTIFICATION_KINDS.map((k) => [k, kindSetting(cfg, k)])) },
      checks: Object.fromEntries(NOTIFICATION_KINDS.map((k) => [k, templateCheck(templates, kindSetting(cfg, k))])),
      basisSetAt: settings?.basisSetAt ?? null,
      templates: templates.map(publicTemplate),
    });
  });

  /** Save the whole configuration. Turning a notification on needs a template chosen for it. */
  app.put(`${base}/settings`, async (c) => {
    const { ws, storeId } = c.req.param();
    const access = await requireWorkspace(c, deps, ws, "stores:manage");
    const store = await waStore(ws, storeId);
    const cfg = whatsappConfigSchema.parse(await body(c));
    for (const k of NOTIFICATION_KINDS) {
      const s = cfg.notifications[k];
      if (s?.enabled && !s.templateName) throw new HttpError(400, `Choose a template for "${KIND_INFO[k].label}" before turning it on.`, "template_required");
    }
    if (cfg.sendWindowStart === cfg.sendWindowEnd) throw new HttpError(400, "The sending window needs different start and end hours.", "invalid_window");
    const before = await systemDb.whatsappSettings.findUnique({ where: { storeId } });
    const prev = parseConfig(before?.config);
    const basisChanged = !before || prev.transactionalBasis !== cfg.transactionalBasis;
    await ensureSettings(store);
    await systemDb.whatsappSettings.update({
      where: { storeId },
      data: {
        config: cfg as unknown as Prisma.InputJsonValue,
        updatedByUserId: access.user!.id,
        ...(basisChanged ? { basisSetByUserId: access.user!.id, basisSetAt: new Date() } : {}),
      },
    });
    const enabledNow = NOTIFICATION_KINDS.filter((k) => cfg.notifications[k]?.enabled);
    const enabledBefore = NOTIFICATION_KINDS.filter((k) => prev.notifications[k]?.enabled);
    await audit({
      workspaceId: ws,
      actorUserId: access.user!.id,
      action: "whatsapp.settings_updated",
      targetType: "store",
      targetId: storeId,
      metadata: {
        turnedOn: enabledNow.filter((k) => !enabledBefore.includes(k)),
        turnedOff: enabledBefore.filter((k) => !enabledNow.includes(k)),
        ...(basisChanged ? { consentBasis: cfg.transactionalBasis } : {}),
        smsConsentCountsForMarketing: cfg.smsConsentCountsForMarketing,
      },
      ip: clientIp(c),
    });
    return c.json({ ok: true });
  });

  // ---------------------------------------------------------------- templates

  app.get(`${base}/templates`, async (c) => {
    const { ws, storeId } = c.req.param();
    await requireWorkspace(c, deps, ws, "dashboard:read");
    await waStore(ws, storeId);
    const templates = await withTenant(ws, (tx) => tx.whatsappTemplate.findMany({ where: { storeId, workspaceId: ws }, orderBy: [{ name: "asc" }, { language: "asc" }] }));
    return c.json({ templates: templates.map(publicTemplate) });
  });

  /** Submit one of Insights' templates to Meta's review, in the merchant's account. */
  app.post(`${base}/templates`, async (c) => {
    const { ws, storeId } = c.req.param();
    const access = await requireWorkspace(c, deps, ws, "stores:manage");
    await waStore(ws, storeId);
    await limit(deps.coord, `rl:wa-template:${storeId}`, LIMITS.waTemplateCreate);
    const { name, language } = z.object({ name: z.string(), language: z.string().regex(/^[a-z]{2,3}(_[A-Z]{2})?$/).default("en") }).parse(await body(c));
    const lib = libraryTemplate(name);
    if (!lib) throw new HttpError(400, "Choose a template from the library.", "unknown_template");
    const conn = await systemDb.whatsappConnection.findUnique({ where: { storeId } });
    if (!conn || conn.workspaceId !== ws) throw new HttpError(409, "Connect WhatsApp first.", "not_connected");
    const e = env();
    const buttons: Array<Record<string, unknown>> = [];
    if (lib.urlButton) {
      const root = lib.urlButton.base === "api" ? e.API_URL : e.APP_URL;
      buttons.push({ type: "URL", text: lib.urlButton.text, url: `${root}${lib.urlButton.path}{{1}}`, example: [`${root}${lib.urlButton.path}${lib.urlButton.example}`] });
    }
    if (lib.stopButton) buttons.push({ type: "QUICK_REPLY", text: "Stop promotions" });
    const components: Array<Record<string, unknown>> = [{ type: "BODY", text: lib.body, example: { body_text: [lib.examples] } }];
    if (lib.footer) components.push({ type: "FOOTER", text: lib.footer });
    if (buttons.length) components.push({ type: "BUTTONS", buttons });
    try {
      const created = await waCreateTemplate(conn.wabaId, connectionToken(conn), { name: lib.name, language, category: lib.category, components }, deps.fetchImpl);
      await syncTemplates(conn, connectionToken(conn), deps.fetchImpl).catch((err: unknown) => logger.warn({ err }, "template sync after create failed"));
      await audit({ workspaceId: ws, actorUserId: access.user!.id, action: "whatsapp.template_submitted", targetType: "store", targetId: storeId, metadata: { name: lib.name, language }, ip: clientIp(c) });
      return c.json({ id: created.id, status: created.status, category: created.category });
    } catch (err) {
      if (err instanceof WhatsappApiError) {
        // Already there (Meta's "content in this language already exists"): just refresh the list.
        if (err.code === 100 && /already exists/i.test(err.details ?? "")) {
          await syncTemplates(conn, connectionToken(conn), deps.fetchImpl);
          return c.json({ status: "EXISTS" });
        }
        throw new HttpError(502, `Meta didn't accept the template: ${err.details ?? err.title}`, "meta_error");
      }
      throw err;
    }
  });

  /** Send one template to the merchant's own phone, with example values. */
  app.post(`${base}/test`, async (c) => {
    const { ws, storeId } = c.req.param();
    const access = await requireWorkspace(c, deps, ws, "stores:manage");
    const store = await waStore(ws, storeId);
    await limit(deps.coord, `rl:wa-test:${storeId}`, LIMITS.waTest);
    const input = z
      .object({
        templateName: z.string().min(1).max(512),
        language: z.string().max(15).default("en"),
        phone: z.string().min(6).max(30),
        kind: z.enum(NOTIFICATION_KINDS).optional(),
        mapping: templateMappingSchema.optional(),
        /** For a template with an image header: a public https image. */
        mediaUrl: z.string().url().startsWith("https://").max(2000).optional(),
      })
      .parse(await body(c));
    const phone = normalizePhone(input.phone, null);
    if (!phone) throw new HttpError(400, "Enter the number in international format, starting with + and the country code.", "invalid_phone");
    const conn = await systemDb.whatsappConnection.findUnique({ where: { storeId } });
    if (!conn || conn.workspaceId !== ws) throw new HttpError(409, "Connect WhatsApp first.", "not_connected");
    const settings = await ensureSettings(store);
    const cfg = parseConfig(settings.config);
    const template = await systemDb.whatsappTemplate.findUnique({ where: { connectionId_name_language: { connectionId: conn.id, name: input.templateName, language: input.language } } });
    if (!template) throw new HttpError(404, "That template isn't in your WhatsApp account. Press Refresh on Message templates.", "template_missing");
    const shape = templateShape(template.components as unknown as TemplateComponent[]);
    const mapping =
      input.mapping ??
      (input.kind ? kindSetting(cfg, input.kind).mapping : null) ??
      libraryTemplate(template.name)?.mapping ?? { body: Array.from({ length: shape.bodyVars }, () => "custom_text" as const), buttons: shape.dynamicUrlButtons.map(() => "custom_text" as const), fixed: {} };
    const { message } = await scheduleMessage(
      {
        store,
        kind: "test",
        dedupeKey: `test:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
        contact: null,
        template: { name: template.name, language: template.language },
        mapping: { ...mapping, fixed: { ...Object.fromEntries([...Array(shape.bodyVars).keys()].map((i) => [`body.${i + 1}`, "Test"])), "button.0": "test", ...mapping.fixed } },
        values: sampleValues(store, cfg),
        media: input.mediaUrl ? { link: input.mediaUrl } : null,
        scheduledFor: new Date(),
        test: { to: phone.waId },
      },
      deps,
    );
    await audit({ workspaceId: ws, actorUserId: access.user!.id, action: "whatsapp.test_sent", targetType: "store", targetId: storeId, metadata: { template: template.name }, ip: clientIp(c) });
    return c.json({ messageId: message.id, status: message.status });
  });

  // ---------------------------------------------------------------- analytics

  app.get(`${base}/analytics`, async (c) => {
    const { ws, storeId } = c.req.param();
    await requireWorkspace(c, deps, ws, "dashboard:read");
    const store = await waStore(ws, storeId);
    const days = z.coerce.number().int().min(1).max(180).default(30).parse(c.req.query("days") ?? undefined);
    const since = new Date(Date.now() - days * 86_400_000);
    const scope = { storeId, workspaceId: ws };
    const r = await withTenant(ws, async (tx) => {
      const [statuses, kinds, daily, carts, recovered, reviews, rated, campaignMsgs, attributed, billable, clicks] = await Promise.all([
        tx.whatsappMessage.groupBy({ by: ["status"], where: { ...scope, test: false, createdAt: { gte: since } }, _count: { _all: true } }),
        tx.whatsappMessage.groupBy({ by: ["kind", "status"], where: { ...scope, test: false, createdAt: { gte: since } }, _count: { _all: true } }),
        tx.$queryRaw<Array<{ day: string; sent: number; delivered: number; read: number; failed: number }>>`
          SELECT to_char(created_at, 'YYYY-MM-DD') AS day,
                 COUNT(*) FILTER (WHERE status IN ('sent','delivered','read'))::int AS sent,
                 COUNT(*) FILTER (WHERE status IN ('delivered','read'))::int AS delivered,
                 COUNT(*) FILTER (WHERE status = 'read')::int AS read,
                 COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
          FROM whatsapp_messages
          WHERE store_id = ${storeId} AND workspace_id = ${ws} AND test = false AND created_at >= ${since}
          GROUP BY 1 ORDER BY 1`,
        tx.abandonedCheckout.groupBy({ by: ["status"], where: { ...scope, checkoutCreatedAt: { gte: since } }, _count: { _all: true } }),
        tx.abandonedCheckout.groupBy({ by: ["currency"], where: { ...scope, status: "recovered", completedAt: { gte: since } }, _sum: { recoveredRevenue: true }, _count: { _all: true } }),
        tx.customerReview.count({ where: { ...scope, submittedAt: { gte: since } } }),
        // The average leaves out reviews removed for breaking the policy, as the Reviews page does.
        tx.customerReview.aggregate({ where: { ...scope, submittedAt: { gte: since }, status: { in: ["published", "pending"] } }, _avg: { rating: true } }),
        tx.whatsappMessage.count({ where: { ...scope, test: false, campaignId: { not: null }, sentAt: { gte: since } } }),
        tx.$queryRaw<Array<{ currency: string; orders: number; revenue: string }>>`
          SELECT COALESCE(t.currency, ${store.currency}) AS currency, COUNT(*)::int AS orders, COALESCE(SUM(m.attributed_revenue), 0)::text AS revenue
          FROM whatsapp_messages m LEFT JOIN order_trackings t ON t.store_id = m.store_id AND t.shopify_order_id = m.attributed_order_id
          WHERE m.store_id = ${storeId} AND m.workspace_id = ${ws} AND m.attributed_order_id IS NOT NULL AND m.attributed_at >= ${since}
          GROUP BY 1`,
        tx.whatsappMessage.groupBy({ by: ["pricingCategory"], where: { ...scope, test: false, billable: true, sentAt: { gte: since } }, _count: { _all: true } }),
        tx.whatsappMessage.count({ where: { ...scope, test: false, clickedAt: { gte: since } } }),
      ]);
      return { statuses, kinds, daily, carts, recovered, reviews, rated, campaignMsgs, attributed, billable, clicks };
    });
    const n = (s: string) => r.statuses.find((x) => x.status === s)?._count._all ?? 0;
    const group = (kind: string) =>
      kind.startsWith("abandoned_cart") ? "carts"
      : kind.startsWith("review") ? "reviews"
      : (["order_shipped", "out_for_delivery", "order_delivered", "delivery_failed"] as string[]).includes(kind) ? "delivery"
      : (NOTIFICATION_KINDS as readonly string[]).includes(kind) ? "orders"
      : kind;
    const byGroup: Record<string, { sent: number; delivered: number; read: number; failed: number; skipped: number }> = {};
    for (const k of r.kinds) {
      const g = (byGroup[group(k.kind)] ??= { sent: 0, delivered: 0, read: 0, failed: 0, skipped: 0 });
      const c2 = k._count._all;
      if (["sent", "delivered", "read"].includes(k.status)) g.sent += c2;
      if (["delivered", "read"].includes(k.status)) g.delivered += c2;
      if (k.status === "read") g.read += c2;
      if (k.status === "failed") g.failed += c2;
      if (k.status === "skipped" || k.status === "cancelled") g.skipped += c2;
    }
    const cartCount = (s: string) => r.carts.find((x) => x.status === s)?._count._all ?? 0;
    return c.json({
      days,
      currency: store.currency,
      messages: {
        sent: n("sent") + n("delivered") + n("read"),
        delivered: n("delivered") + n("read"),
        read: n("read"),
        failed: n("failed"),
        skipped: n("skipped") + n("cancelled"),
        scheduled: n("scheduled") + n("sending"),
        clicks: r.clicks,
      },
      byGroup,
      daily: r.daily,
      carts: {
        withPhone: r.carts.reduce((s, x) => s + x._count._all, 0),
        reminded: cartCount("reminded") + cartCount("recovered"),
        recovered: cartCount("recovered"),
        completedWithoutReminder: cartCount("completed"),
        revenue: r.recovered.map((x) => ({ currency: x.currency, amount: Number(x._sum.recoveredRevenue ?? 0), orders: x._count._all })),
      },
      reviews: { submitted: r.reviews, average: r.rated._avg.rating ? Math.round(r.rated._avg.rating * 10) / 10 : null },
      campaigns: { messages: r.campaignMsgs, conversions: r.attributed.map((x) => ({ currency: x.currency, orders: x.orders, revenue: Number(x.revenue) })) },
      billable: r.billable.map((b) => ({ category: b.pricingCategory ?? "unknown", messages: b._count._all })),
    });
  });

  whatsappOpsRoutes(app, deps);
}


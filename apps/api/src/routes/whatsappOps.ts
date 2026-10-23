import { z } from "zod";
import { Prisma, systemDb, withTenant, type WhatsappCampaign } from "@app/db";
import {
  audit,
  campaignMetrics,
  canRequeue,
  cancelScheduled,
  changeCampaignState,
  estimateAudience,
  marketingAllowed,
  merchantOrderStep,
  optOutContact,
  parseConfig,
  parseRule,
  remindCart,
  requeueMessage,
  rulesLike,
  scheduleCampaign,
  testAutomation,
  upsertContact,
  validateRule,
  waDecrypt,
  trackingUrl,
  type CampaignMetrics,
} from "@app/core";
import {
  audienceSchema,
  automationActionSchema,
  AUTOMATION_TRIGGERS,
  campaignEditable,
  conditionSchema,
  errorExplanation,
  libraryTemplate,
  messageKinds,
  MODERATION_REASONS,
  normalizePhone,
  OCCASIONS,
  partialUpdate,
  ruleConflicts,
  templateMappingSchema,
} from "@app/shared";
import { body, clientIp, HttpError, requireWorkspace, type Deps } from "../context.js";
import type { App } from "../app.js";
import { limit, LIMITS } from "../rateLimit.js";
import { cursorPage } from "../pagination.js";
import { base, requireWaContacts, requireWaContactsManage, waStore } from "./whatsappCommon.js";

/** Day boundaries from ?from=YYYY-MM-DD&to=YYYY-MM-DD (UTC), each optional. */
function range(q: Record<string, string>) {
  const day = /^\d{4}-\d{2}-\d{2}$/;
  return {
    ...(q.from && day.test(q.from) ? { gte: new Date(`${q.from}T00:00:00Z`) } : {}),
    ...(q.to && day.test(q.to) ? { lt: new Date(new Date(`${q.to}T00:00:00Z`).getTime() + 86_400_000) } : {}),
  };
}

const httpsUrl = z.string().trim().url().max(2000).refine((u) => u.startsWith("https://"), "must start with https://");

const campaignInput = z.object({
  name: z.string().trim().min(1).max(120),
  occasion: z.enum(OCCASIONS.map((o) => o.id) as [string, ...string[]]),
  objective: z.string().trim().max(300).nullable().optional(),
  templateName: z.string().min(1).max(512),
  templateLanguage: z.string().max(15).default("en"),
  mapping: templateMappingSchema.optional(),
  variables: z
    .object({
      greeting: z.string().trim().max(60).optional(),
      discountPercentage: z.string().trim().regex(/^\d{1,2}$/, "a whole number from 0 to 99").optional(),
      endDate: z.string().trim().max(40).optional(),
    })
    .default({}),
  mediaUrl: httpsUrl.nullable().optional(),
  linkUrl: httpsUrl.nullable().optional(),
  discountCode: z.string().trim().max(40).regex(/^[A-Za-z0-9_-]*$/, "letters, numbers, - and _ only").nullable().optional(),
  audience: audienceSchema.prefault({}),
  startAt: z.coerce.date(),
  endAt: z.coerce.date().nullable().optional(),
});

const ruleInput = z.object({
  name: z.string().trim().min(1).max(100),
  enabled: z.boolean().default(false),
  trigger: z.enum(AUTOMATION_TRIGGERS),
  conditions: z.array(conditionSchema).max(20).default([]),
  action: automationActionSchema,
});

export function whatsappOpsRoutes(app: App, deps: Deps) {
  // ---------------------------------------------------------------- message history

  app.get(`${base}/messages`, async (c) => {
    const { ws, storeId } = c.req.param();
    await requireWaContacts(c, deps, ws);
    await waStore(ws, storeId);
    const q = c.req.query();
    const paging = cursorPage(q, 50);
    const created = range(q);
    const groupKinds = q.group ? messageKinds(q.group) : null;
    const where: Prisma.WhatsappMessageWhereInput = {
      storeId,
      workspaceId: ws,
      ...(q.status ? { status: { in: q.status.split(",").slice(0, 8) } } : {}),
      ...(q.kind ? { kind: q.kind } : groupKinds ? { kind: { in: groupKinds } } : {}),
      ...(q.campaignId ? { campaignId: q.campaignId } : {}),
      ...(q.trackingId ? { trackingId: q.trackingId } : {}),
      ...(q.q ? { OR: [{ orderName: { contains: q.q.slice(0, 40), mode: "insensitive" as const } }, { providerMessageId: q.q.slice(0, 200) }, { phoneMasked: { endsWith: q.q.replace(/\D/g, "").slice(-3) || "~" } }] } : {}),
      ...(Object.keys(created).length ? { createdAt: created } : {}),
    };
    const rows = await withTenant(ws, (tx) =>
      tx.whatsappMessage.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], ...paging.args }),
    );
    const { items: page, nextCursor } = paging.split(rows);
    const campaignIds = [...new Set(page.map((m) => m.campaignId).filter((x): x is string => !!x))];
    const campaigns = campaignIds.length ? await withTenant(ws, (tx) => tx.whatsappCampaign.findMany({ where: { id: { in: campaignIds }, workspaceId: ws }, select: { id: true, name: true } })) : [];
    return c.json({
      messages: page.map((m) => ({
        id: m.id,
        kind: m.kind,
        category: m.category,
        templateName: m.templateName,
        templateLanguage: m.templateLanguage,
        phoneMasked: m.phoneMasked,
        orderName: m.orderName,
        trackingId: m.trackingId,
        checkoutId: m.checkoutId,
        campaign: m.campaignId ? (campaigns.find((x) => x.id === m.campaignId) ?? { id: m.campaignId, name: null }) : null,
        ruleId: m.ruleId,
        status: m.status,
        reason: m.reason,
        scheduledFor: m.scheduledFor,
        sentAt: m.sentAt,
        deliveredAt: m.deliveredAt,
        readAt: m.readAt,
        failedAt: m.failedAt,
        cancelledAt: m.cancelledAt,
        errorCode: m.errorCode,
        failure: m.status === "failed" ? (m.errorTitle ?? errorExplanation(m.errorCode)) : null,
        providerMessageId: m.providerMessageId,
        attempts: m.attempts,
        clickedAt: m.clickedAt,
        attributedOrderId: m.attributedOrderId,
        test: m.test,
        createdAt: m.createdAt,
        canRetry: canRequeue(m),
        canCancel: m.status === "scheduled",
      })),
      nextCursor,
    });
  });

  app.post(`${base}/messages/:id/retry`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    const access = await requireWorkspace(c, deps, ws, "stores:manage");
    await waStore(ws, storeId);
    const msg = await withTenant(ws, (tx) => tx.whatsappMessage.findFirst({ where: { id, storeId, workspaceId: ws } }));
    if (!msg) throw new HttpError(404, "Not found", "not_found");
    await requeueMessage(msg, deps);
    await audit({ workspaceId: ws, actorUserId: access.user!.id, action: "whatsapp.message_retried", targetType: "whatsapp_message", targetId: id, ip: clientIp(c) });
    return c.json({ ok: true });
  });

  app.post(`${base}/messages/:id/cancel`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    const access = await requireWorkspace(c, deps, ws, "stores:manage");
    await waStore(ws, storeId);
    const count = await cancelScheduled({ id, storeId, workspaceId: ws }, "cancelled_by_merchant");
    if (!count) throw new HttpError(409, "Only a message that hasn't gone out yet can be cancelled.", "not_cancellable");
    await audit({ workspaceId: ws, actorUserId: access.user!.id, action: "whatsapp.message_cancelled", targetType: "whatsapp_message", targetId: id, ip: clientIp(c) });
    return c.json({ ok: true });
  });

  // ---------------------------------------------------------------- order timelines

  app.get(`${base}/orders`, async (c) => {
    const { ws, storeId } = c.req.param();
    await requireWaContacts(c, deps, ws);
    await waStore(ws, storeId);
    const q = c.req.query();
    const paging = cursorPage(q, 30);
    const rows = await withTenant(ws, (tx) =>
      tx.orderTracking.findMany({
        where: { storeId, workspaceId: ws, ...(q.status ? { status: q.status } : {}), ...(q.q ? { orderName: { contains: q.q.slice(0, 40), mode: "insensitive" } } : {}) },
        orderBy: [{ orderCreatedAt: "desc" }, { id: "desc" }],
        ...paging.args,
      }),
    );
    const { items: page, nextCursor } = paging.split(rows);
    const ids = page.map((t) => t.id);
    const contactIds = page.map((t) => t.contactId).filter((x): x is string => !!x);
    const [contacts, msgs] = await withTenant(ws, (tx) =>
      Promise.all([
        tx.whatsappContact.findMany({ where: { id: { in: contactIds }, workspaceId: ws }, select: { id: true, phoneMasked: true } }),
        tx.whatsappMessage.groupBy({ by: ["trackingId", "status"], where: { trackingId: { in: ids }, workspaceId: ws }, _count: { _all: true } }),
      ]),
    );
    return c.json({
      orders: page.map((t) => ({
        id: t.id,
        orderName: t.orderName,
        status: t.status,
        placedAt: t.orderCreatedAt,
        total: Number(t.totalPrice),
        currency: t.currency,
        phoneMasked: contacts.find((x) => x.id === t.contactId)?.phoneMasked ?? null,
        liveTracking: t.carrierEvents,
        messages: Object.fromEntries(msgs.filter((m) => m.trackingId === t.id).map((m) => [m.status, m._count._all])),
      })),
      nextCursor,
    });
  });

  app.get(`${base}/orders/:id`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    await requireWaContacts(c, deps, ws);
    await waStore(ws, storeId);
    const t = await withTenant(ws, (tx) => tx.orderTracking.findFirst({ where: { id, storeId, workspaceId: ws } }));
    if (!t) throw new HttpError(404, "Not found", "not_found");
    const [events, messages, contact, reviews] = await withTenant(ws, (tx) =>
      Promise.all([
        tx.orderTrackingEvent.findMany({ where: { trackingId: t.id, workspaceId: ws }, orderBy: { occurredAt: "asc" } }),
        tx.whatsappMessage.findMany({ where: { trackingId: t.id, workspaceId: ws }, orderBy: { createdAt: "asc" } }),
        t.contactId ? tx.whatsappContact.findFirst({ where: { id: t.contactId, workspaceId: ws } }) : null,
        tx.customerReview.findMany({ where: { trackingId: t.id, workspaceId: ws } }),
      ]),
    );
    const token = waDecrypt(t.storeId, "track", t.tokenEnc);
    return c.json({
      order: {
        id: t.id,
        orderName: t.orderName,
        status: t.status,
        placedAt: t.orderCreatedAt,
        total: Number(t.totalPrice),
        currency: t.currency,
        financialStatus: t.financialStatus,
        items: t.items,
        paidAt: t.paidAt,
        deliveredAt: t.deliveredAt,
        cancelledAt: t.cancelledAt,
        liveTracking: t.carrierEvents,
        consent: { cartOptIn: t.cartOptIn, smsConsent: t.smsConsent },
        trackingUrl: trackingUrl(token),
      },
      customer: contact ? { phoneMasked: contact.phoneMasked, optedOut: contact.optedOut, marketing: contact.marketingStatus, country: contact.country } : null,
      events: events.map((e) => ({ type: e.type, at: e.occurredAt, source: e.source, courier: e.courier, trackingNumber: e.trackingNumber, trackingUrl: e.trackingUrl, estimatedDelivery: e.estimatedDeliveryAt })),
      messages: messages.map((m) => ({ id: m.id, kind: m.kind, status: m.status, reason: m.reason, templateName: m.templateName, sentAt: m.sentAt, deliveredAt: m.deliveredAt, readAt: m.readAt, scheduledFor: m.scheduledFor, failure: m.status === "failed" ? m.errorTitle : null })),
      reviews: reviews.map((r) => ({ id: r.id, productTitle: r.productTitle, rating: r.rating, status: r.status })),
    });
  });

  /** The merchant marks a step themselves (a trusted source: they're the store). */
  app.post(`${base}/orders/:id/steps`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    const access = await requireWorkspace(c, deps, ws, "stores:manage");
    const store = await waStore(ws, storeId);
    const { step } = z.object({ step: z.enum(["processing", "packed", "delivered"]) }).parse(await body(c));
    const t = await withTenant(ws, (tx) => tx.orderTracking.findFirst({ where: { id, storeId, workspaceId: ws }, select: { id: true, cancelledAt: true } }));
    if (!t) throw new HttpError(404, "Not found", "not_found");
    if (t.cancelledAt) throw new HttpError(409, "This order was cancelled.", "order_cancelled");
    const done = await merchantOrderStep(store, t.id, step, deps);
    await audit({ workspaceId: ws, actorUserId: access.user!.id, action: "whatsapp.order_step_marked", targetType: "order_tracking", targetId: t.id, metadata: { step }, ip: clientIp(c) });
    return c.json({ ok: true, changed: done });
  });

  // ---------------------------------------------------------------- abandoned carts

  app.get(`${base}/carts`, async (c) => {
    const { ws, storeId } = c.req.param();
    await requireWaContacts(c, deps, ws);
    await waStore(ws, storeId);
    const q = c.req.query();
    const paging = cursorPage(q, 30);
    const [rows, counts] = await withTenant(ws, (tx) =>
      Promise.all([
        tx.abandonedCheckout.findMany({
          where: { storeId, workspaceId: ws, ...(q.status ? { status: { in: q.status.split(",").slice(0, 6) } } : {}) },
          orderBy: [{ lastActivityAt: "desc" }, { id: "desc" }],
          ...paging.args,
        }),
        tx.abandonedCheckout.groupBy({ by: ["status"], where: { storeId, workspaceId: ws }, _count: { _all: true } }),
      ]),
    );
    const { items: page, nextCursor } = paging.split(rows);
    const reminders = await withTenant(ws, (tx) =>
      tx.whatsappMessage.findMany({
        where: { checkoutId: { in: page.map((r) => r.id) }, workspaceId: ws },
        select: { checkoutId: true, kind: true, status: true, reason: true, scheduledFor: true, sentAt: true, readAt: true, clickedAt: true },
        orderBy: { createdAt: "asc" },
      }),
    );
    return c.json({
      counts: Object.fromEntries(counts.map((x) => [x.status, x._count._all])),
      carts: page.map((r) => ({
        id: r.id,
        customerName: r.customerNameEnc ? waDecrypt(r.storeId, "name", r.customerNameEnc) : null,
        phoneMasked: r.phoneMasked,
        total: Number(r.totalPrice),
        currency: r.currency,
        items: r.items,
        abandonedAt: r.lastActivityAt,
        startedAt: r.checkoutCreatedAt,
        status: r.status,
        ineligibleReason: r.ineligibleReason,
        marketingConsent: r.marketingConsent,
        checkoutUrl: r.recoveryUrlEnc ? waDecrypt(r.storeId, "recovery", r.recoveryUrlEnc) : null,
        recovered: r.recoveredOrderId ? { orderName: r.recoveredOrderName, revenue: Number(r.recoveredRevenue ?? 0), at: r.completedAt } : null,
        completedAt: r.completedAt,
        reminders: reminders.filter((m) => m.checkoutId === r.id).map(({ checkoutId: _x, ...m }) => m),
      })),
      nextCursor,
    });
  });

  /** "Send reminder" now, with the cart reminder template, if the customer may receive it. */
  app.post(`${base}/carts/:id/remind`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    const access = await requireWorkspace(c, deps, ws, "stores:manage");
    const store = await waStore(ws, storeId);
    await limit(deps.coord, `rl:wa-remind:${storeId}`, LIMITS.waRemind);
    const checkout = await withTenant(ws, (tx) => tx.abandonedCheckout.findFirst({ where: { id, storeId, workspaceId: ws } }));
    if (!checkout) throw new HttpError(404, "Not found", "not_found");
    const message = await remindCart(store, checkout, deps);
    await audit({ workspaceId: ws, actorUserId: access.user!.id, action: "whatsapp.cart_reminder_sent", targetType: "abandoned_checkout", targetId: checkout.id, ip: clientIp(c) });
    return c.json({ messageId: message.id, status: message.status });
  });

  // ---------------------------------------------------------------- reviews

  app.get(`${base}/reviews`, async (c) => {
    const { ws, storeId } = c.req.param();
    await requireWaContacts(c, deps, ws);
    await waStore(ws, storeId);
    const q = c.req.query();
    const paging = cursorPage(q, 30);
    // A rating that isn't 1-5 is ignored, like a malformed date in range().
    const rating = Number(q.rating);
    const scope = { storeId, workspaceId: ws };
    const [rows, byStatus, dist, avg] = await withTenant(ws, (tx) =>
      Promise.all([
        tx.customerReview.findMany({
          where: { ...scope, ...(q.status ? { status: q.status } : {}), ...(Number.isInteger(rating) && rating >= 1 && rating <= 5 ? { rating } : {}) },
          orderBy: [{ submittedAt: "desc" }, { id: "desc" }],
          ...paging.args,
        }),
        tx.customerReview.groupBy({ by: ["status"], where: scope, _count: { _all: true } }),
        tx.customerReview.groupBy({ by: ["rating", "status"], where: scope, _count: { _all: true } }),
        tx.customerReview.aggregate({ where: { ...scope, status: { in: ["published", "pending"] } }, _avg: { rating: true }, _count: { _all: true } }),
      ]),
    );
    const { items: page, nextCursor } = paging.split(rows);
    return c.json({
      summary: {
        // Rejected reviews are left out of the average, and counted below so suppression stays visible.
        average: avg._avg.rating ? Math.round(avg._avg.rating * 10) / 10 : null,
        counted: avg._count._all,
        byStatus: Object.fromEntries(byStatus.map((x) => [x.status, x._count._all])),
        distribution: [1, 2, 3, 4, 5].map((r) => ({ rating: r, count: dist.filter((d) => d.rating === r && d.status !== "rejected").reduce((s, d) => s + d._count._all, 0) })),
        rejectedByRating: [1, 2, 3, 4, 5].map((r) => ({ rating: r, count: dist.find((d) => d.rating === r && d.status === "rejected")?._count._all ?? 0 })),
      },
      reviews: page.map((r) => ({
        id: r.id,
        orderName: r.orderName,
        productTitle: r.productTitle,
        rating: r.rating,
        body: r.body,
        reviewerName: r.reviewerName,
        status: r.status,
        moderationReason: r.moderationReason,
        submittedAt: r.submittedAt,
        editedAt: r.editedAt,
        moderatedAt: r.moderatedAt,
      })),
      nextCursor,
    });
  });

  /** Publish, hold, or remove a review. Removing needs a policy reason; "it's negative" isn't one. */
  app.patch(`${base}/reviews/:id`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    const access = await requireWorkspace(c, deps, ws, "stores:manage");
    await waStore(ws, storeId);
    const input = z.object({ status: z.enum(["published", "pending", "rejected"]), reason: z.enum(MODERATION_REASONS).optional() }).parse(await body(c));
    if (input.status === "rejected" && !input.reason) throw new HttpError(400, "Choose why this review breaks the review policy.", "reason_required");
    const review = await withTenant(ws, (tx) => tx.customerReview.findFirst({ where: { id, storeId, workspaceId: ws } }));
    if (!review) throw new HttpError(404, "Not found", "not_found");
    await systemDb.customerReview.update({
      where: { id: review.id },
      data: { status: input.status, moderationReason: input.status === "rejected" ? input.reason : null, moderatedAt: new Date(), moderatedByUserId: access.user!.id },
    });
    await audit({
      workspaceId: ws,
      actorUserId: access.user!.id,
      action: `whatsapp.review_${input.status}`,
      targetType: "customer_review",
      targetId: review.id,
      metadata: { rating: review.rating, reason: input.reason ?? null, order: review.orderName },
      ip: clientIp(c),
    });
    return c.json({ ok: true });
  });

  // ---------------------------------------------------------------- campaigns

  const publicCampaign = (camp: WhatsappCampaign, metrics?: CampaignMetrics) => ({
    id: camp.id,
    name: camp.name,
    occasion: camp.occasion,
    objective: camp.objective,
    templateName: camp.templateName,
    templateLanguage: camp.templateLanguage,
    mapping: camp.mapping,
    variables: camp.variables,
    mediaUrl: camp.mediaUrl,
    linkUrl: camp.linkUrl,
    discountCode: camp.discountCode,
    audience: camp.audience,
    startAt: camp.startAt,
    endAt: camp.endAt,
    status: camp.status,
    estimatedRecipients: camp.estimatedRecipients,
    approvedAt: camp.approvedAt,
    startedAt: camp.startedAt,
    completedAt: camp.completedAt,
    createdAt: camp.createdAt,
    metrics: metrics ?? null,
  });

  app.get(`${base}/campaigns`, async (c) => {
    const { ws, storeId } = c.req.param();
    await requireWorkspace(c, deps, ws, "marketing.campaigns");
    await waStore(ws, storeId);
    const [rows, settings] = await withTenant(ws, (tx) =>
      Promise.all([tx.whatsappCampaign.findMany({ where: { storeId, workspaceId: ws }, orderBy: { createdAt: "desc" }, take: 100 }), tx.whatsappSettings.findUnique({ where: { storeId } })]),
    );
    const metrics = await campaignMetrics(ws, storeId, rows, parseConfig(settings?.config).attributionDays);
    return c.json({ campaigns: rows.map((r) => publicCampaign(r, metrics.get(r.id))) });
  });

  /** How many customers an audience reaches right now (opted in, not opted out). */
  app.post(`${base}/campaigns/estimate`, async (c) => {
    const { ws, storeId } = c.req.param();
    await requireWorkspace(c, deps, ws, "marketing.campaigns");
    await waStore(ws, storeId);
    // Counts up to every contact of the store: an API key (read access) mustn't be able to loop it.
    await limit(deps.coord, `rl:wa-estimate:${storeId}`, LIMITS.waEstimate);
    const { audience } = z.object({ audience: audienceSchema.prefault({}) }).parse(await body(c));
    const settings = await systemDb.whatsappSettings.findUnique({ where: { storeId } });
    return c.json({ recipients: await estimateAudience(storeId, audience, parseConfig(settings?.config)) });
  });

  app.post(`${base}/campaigns`, async (c) => {
    const { ws, storeId } = c.req.param();
    const access = await requireWorkspace(c, deps, ws, "stores:manage");
    const store = await waStore(ws, storeId);
    const input = campaignInput.parse(await body(c));
    if (input.endAt && input.endAt <= input.startAt) throw new HttpError(400, "The end must be after the start.", "invalid_dates");
    const camp = await systemDb.whatsappCampaign.create({
      data: {
        workspaceId: ws,
        storeId: store.id,
        name: input.name,
        occasion: input.occasion,
        objective: input.objective ?? null,
        templateName: input.templateName,
        templateLanguage: input.templateLanguage,
        mapping: (input.mapping ?? libraryTemplate(input.templateName)?.mapping ?? { body: [], buttons: [], fixed: {} }) as Prisma.InputJsonValue,
        variables: input.variables as Prisma.InputJsonValue,
        mediaUrl: input.mediaUrl ?? null,
        linkUrl: input.linkUrl ?? null,
        discountCode: input.discountCode || null,
        audience: input.audience as Prisma.InputJsonValue,
        startAt: input.startAt,
        endAt: input.endAt ?? null,
        createdByUserId: access.user!.id,
      },
    });
    await audit({ workspaceId: ws, actorUserId: access.user!.id, action: "whatsapp.campaign_created", targetType: "whatsapp_campaign", targetId: camp.id, ip: clientIp(c) });
    return c.json({ campaign: publicCampaign(camp) });
  });

  async function ownCampaign(ws: string, storeId: string, id: string) {
    const camp = await withTenant(ws, (tx) => tx.whatsappCampaign.findFirst({ where: { id, storeId, workspaceId: ws } }));
    if (!camp) throw new HttpError(404, "Not found", "not_found");
    return camp;
  }

  app.get(`${base}/campaigns/:id`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    await requireWorkspace(c, deps, ws, "marketing.campaigns");
    await waStore(ws, storeId);
    const camp = await ownCampaign(ws, storeId, id);
    const settings = await systemDb.whatsappSettings.findUnique({ where: { storeId } });
    const cfg = parseConfig(settings?.config);
    const metrics = await campaignMetrics(ws, storeId, [camp], cfg.attributionDays);
    const estimate = ["draft", "scheduled"].includes(camp.status) ? await estimateAudience(storeId, camp.audience, cfg) : null;
    return c.json({ campaign: publicCampaign(camp, metrics.get(camp.id)), estimate });
  });

  /** Edit a draft. Editing a scheduled campaign takes it back to draft: it has to be confirmed again. */
  app.patch(`${base}/campaigns/:id`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    const access = await requireWorkspace(c, deps, ws, "stores:manage");
    await waStore(ws, storeId);
    const camp = await ownCampaign(ws, storeId, id);
    if (!campaignEditable(camp.status)) throw new HttpError(409, "Only a campaign that hasn't started can be edited.", "not_editable");
    const input = partialUpdate(campaignInput).parse(await body(c));
    const startAt = input.startAt ?? camp.startAt;
    const endAt = input.endAt === undefined ? camp.endAt : input.endAt;
    if (endAt && endAt <= startAt) throw new HttpError(400, "The end must be after the start.", "invalid_dates");
    const updated = await systemDb.whatsappCampaign.update({
      where: { id: camp.id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.occasion !== undefined ? { occasion: input.occasion } : {}),
        ...(input.objective !== undefined ? { objective: input.objective } : {}),
        ...(input.templateName !== undefined ? { templateName: input.templateName, ...(input.mapping ? {} : { mapping: (libraryTemplate(input.templateName)?.mapping ?? camp.mapping) as Prisma.InputJsonValue }) } : {}),
        ...(input.templateLanguage !== undefined ? { templateLanguage: input.templateLanguage } : {}),
        ...(input.mapping !== undefined ? { mapping: input.mapping as Prisma.InputJsonValue } : {}),
        ...(input.variables !== undefined ? { variables: input.variables as Prisma.InputJsonValue } : {}),
        ...(input.mediaUrl !== undefined ? { mediaUrl: input.mediaUrl } : {}),
        ...(input.linkUrl !== undefined ? { linkUrl: input.linkUrl } : {}),
        ...(input.discountCode !== undefined ? { discountCode: input.discountCode || null } : {}),
        ...(input.audience !== undefined ? { audience: input.audience as Prisma.InputJsonValue } : {}),
        startAt,
        endAt,
        status: "draft",
        approvedAt: null,
        approvedByUserId: null,
      },
    });
    if (camp.status === "scheduled") await audit({ workspaceId: ws, actorUserId: access.user!.id, action: "whatsapp.campaign_unscheduled", targetType: "whatsapp_campaign", targetId: camp.id, ip: clientIp(c) });
    return c.json({ campaign: publicCampaign(updated) });
  });

  app.delete(`${base}/campaigns/:id`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    const access = await requireWorkspace(c, deps, ws, "stores:manage");
    await waStore(ws, storeId);
    const camp = await ownCampaign(ws, storeId, id);
    if (camp.status !== "draft") throw new HttpError(409, "Only a draft can be deleted. Cancel a scheduled or running campaign instead.", "not_draft");
    await systemDb.whatsappCampaign.delete({ where: { id: camp.id } });
    await audit({ workspaceId: ws, actorUserId: access.user!.id, action: "whatsapp.campaign_deleted", targetType: "whatsapp_campaign", targetId: camp.id, ip: clientIp(c) });
    return c.json({ ok: true });
  });

  /** Schedule (authorize) a campaign: the merchant confirms the recipient count they were shown (scheduleCampaign). */
  app.post(`${base}/campaigns/:id/schedule`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    const access = await requireWorkspace(c, deps, ws, "stores:manage");
    await waStore(ws, storeId);
    const { confirmRecipients } = z.object({ confirmRecipients: z.number().int().min(0) }).parse(await body(c));
    const camp = await ownCampaign(ws, storeId, id);
    const result = await scheduleCampaign(camp, confirmRecipients, access.user!.id);
    if ("recipientsChanged" in result) {
      return c.json({ error: "recipients_changed", message: `The audience is now ${result.recipientsChanged} customers. Please confirm again.`, recipients: result.recipientsChanged }, 409);
    }
    await audit({
      workspaceId: ws,
      actorUserId: access.user!.id,
      action: "whatsapp.campaign_scheduled",
      targetType: "whatsapp_campaign",
      targetId: camp.id,
      metadata: { recipients: result.recipients, startAt: camp.startAt, template: camp.templateName },
      ip: clientIp(c),
    });
    return c.json({ campaign: publicCampaign(result.campaign) });
  });

  for (const action of ["pause", "resume", "cancel"] as const) {
    app.post(`${base}/campaigns/:id/${action}`, async (c) => {
      const { ws, storeId, id } = c.req.param();
      const access = await requireWorkspace(c, deps, ws, "stores:manage");
      await waStore(ws, storeId);
      const camp = await ownCampaign(ws, storeId, id);
      const status = await changeCampaignState(camp, action);
      const done = { pause: "paused", resume: "resumed", cancel: "cancelled" }[action];
      await audit({ workspaceId: ws, actorUserId: access.user!.id, action: `whatsapp.campaign_${done}`, targetType: "whatsapp_campaign", targetId: camp.id, ip: clientIp(c) });
      return c.json({ ok: true, status });
    });
  }

  // ---------------------------------------------------------------- automations

  app.get(`${base}/automations`, async (c) => {
    const { ws, storeId } = c.req.param();
    await requireWorkspace(c, deps, ws, "marketing.campaigns");
    await waStore(ws, storeId);
    const [rules, runs] = await withTenant(ws, (tx) =>
      Promise.all([
        tx.whatsappAutomationRule.findMany({ where: { storeId, workspaceId: ws }, orderBy: { createdAt: "asc" } }),
        tx.whatsappAutomationRun.groupBy({ by: ["ruleId", "outcome"], where: { storeId, workspaceId: ws, createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) } }, _count: { _all: true }, _max: { createdAt: true } }),
      ]),
    );
    const all = rulesLike(rules);
    return c.json({
      automations: rules.map((r) => {
        const like = all.find((x) => x.id === r.id);
        return {
          id: r.id,
          name: r.name,
          enabled: r.enabled,
          trigger: r.trigger,
          conditions: r.conditions,
          action: r.action,
          valid: !!like,
          conflicts: like ? ruleConflicts(like, all) : [],
          last30Days: Object.fromEntries(runs.filter((x) => x.ruleId === r.id).map((x) => [x.outcome, x._count._all])),
          lastRunAt: runs.filter((x) => x.ruleId === r.id).reduce<Date | null>((m, x) => (x._max.createdAt && (!m || x._max.createdAt > m) ? x._max.createdAt : m), null),
          updatedAt: r.updatedAt,
        };
      }),
    });
  });

  app.post(`${base}/automations`, async (c) => {
    const { ws, storeId } = c.req.param();
    const access = await requireWorkspace(c, deps, ws, "stores:manage");
    await waStore(ws, storeId);
    const input = ruleInput.parse(await body(c));
    const conflicts = await validateRule(ws, storeId, { id: "new", ...input });
    const rule = await systemDb.whatsappAutomationRule.create({
      data: { workspaceId: ws, storeId, name: input.name, enabled: input.enabled, trigger: input.trigger, conditions: input.conditions as Prisma.InputJsonValue, action: input.action as Prisma.InputJsonValue, createdByUserId: access.user!.id },
    });
    await audit({ workspaceId: ws, actorUserId: access.user!.id, action: "whatsapp.automation_created", targetType: "whatsapp_automation_rule", targetId: rule.id, metadata: { trigger: input.trigger, enabled: input.enabled }, ip: clientIp(c) });
    return c.json({ id: rule.id, conflicts });
  });

  app.patch(`${base}/automations/:id`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    const access = await requireWorkspace(c, deps, ws, "stores:manage");
    await waStore(ws, storeId);
    const rule = await withTenant(ws, (tx) => tx.whatsappAutomationRule.findFirst({ where: { id, storeId, workspaceId: ws } }));
    if (!rule) throw new HttpError(404, "Not found", "not_found");
    const current = parseRule(rule);
    const patch = partialUpdate(ruleInput).parse(await body(c));
    const merged = ruleInput.parse({
      name: patch.name ?? rule.name,
      enabled: patch.enabled ?? rule.enabled,
      trigger: patch.trigger ?? rule.trigger,
      conditions: patch.conditions ?? current?.conditions ?? [],
      action: patch.action ?? current?.action,
    });
    const conflicts = await validateRule(ws, storeId, { id: rule.id, ...merged });
    await systemDb.whatsappAutomationRule.update({
      where: { id: rule.id },
      data: { name: merged.name, enabled: merged.enabled, trigger: merged.trigger, conditions: merged.conditions as Prisma.InputJsonValue, action: merged.action as Prisma.InputJsonValue },
    });
    await audit({ workspaceId: ws, actorUserId: access.user!.id, action: "whatsapp.automation_updated", targetType: "whatsapp_automation_rule", targetId: rule.id, metadata: { enabled: merged.enabled }, ip: clientIp(c) });
    return c.json({ ok: true, conflicts });
  });

  app.delete(`${base}/automations/:id`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    const access = await requireWorkspace(c, deps, ws, "stores:manage");
    await waStore(ws, storeId);
    const { count } = await systemDb.whatsappAutomationRule.deleteMany({ where: { id, storeId, workspaceId: ws } });
    if (!count) throw new HttpError(404, "Not found", "not_found");
    await cancelScheduled({ ruleId: id }, "rule_deleted");
    await audit({ workspaceId: ws, actorUserId: access.user!.id, action: "whatsapp.automation_deleted", targetType: "whatsapp_automation_rule", targetId: id, ip: clientIp(c) });
    return c.json({ ok: true });
  });

  app.get(`${base}/automations/:id/runs`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    await requireWorkspace(c, deps, ws, "marketing.campaigns");
    await waStore(ws, storeId);
    const runs = await withTenant(ws, (tx) => tx.whatsappAutomationRun.findMany({ where: { ruleId: id, storeId, workspaceId: ws }, orderBy: { createdAt: "desc" }, take: 50 }));
    return c.json({ runs: runs.map((r) => ({ id: r.id, trigger: r.trigger, subject: r.subjectKey, outcome: r.outcome, detail: r.detail, messageId: r.messageId, at: r.createdAt })) });
  });

  /**
   * "Test": evaluate the rule against a recent order (or the one given) without doing anything.
   * With a phone number, a send action's template also goes to that number, with example values.
   */
  app.post(`${base}/automations/:id/test`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    const access = await requireWorkspace(c, deps, ws, "stores:manage");
    const store = await waStore(ws, storeId);
    const input = z.object({ trackingId: z.string().max(40).optional(), phone: z.string().max(30).optional() }).parse(await body(c));
    const rule = await withTenant(ws, (tx) => tx.whatsappAutomationRule.findFirst({ where: { id, storeId, workspaceId: ws } }));
    if (!rule) throw new HttpError(404, "Not found", "not_found");
    const result = await testAutomation(store, rule, input, { ...deps, beforeSend: () => limit(deps.coord, `rl:wa-test:${storeId}`, LIMITS.waTest) });
    await audit({ workspaceId: ws, actorUserId: access.user!.id, action: "whatsapp.automation_tested", targetType: "whatsapp_automation_rule", targetId: rule.id, ip: clientIp(c) });
    return c.json(result);
  });

  // ---------------------------------------------------------------- consent

  app.get(`${base}/contacts/summary`, async (c) => {
    const { ws, storeId } = c.req.param();
    await requireWorkspace(c, deps, ws, "marketing.campaigns");
    await waStore(ws, storeId);
    const [byStatus, optedOut, settings] = await withTenant(ws, (tx) =>
      Promise.all([
        tx.whatsappContact.groupBy({ by: ["marketingStatus", "marketingSource"], where: { storeId, workspaceId: ws, optedOut: false }, _count: { _all: true } }),
        tx.whatsappContact.count({ where: { storeId, workspaceId: ws, optedOut: true } }),
        tx.whatsappSettings.findUnique({ where: { storeId } }),
      ]),
    );
    const cfg = parseConfig(settings?.config);
    const sum = (f: (x: (typeof byStatus)[number]) => boolean) => byStatus.filter(f).reduce((s, x) => s + x._count._all, 0);
    return c.json({
      contacts: sum(() => true) + optedOut,
      marketingEligible: sum((x) => marketingAllowed(cfg, { ...x, optedOut: false })),
      optedInViaShopifySms: sum((x) => x.marketingStatus === "opted_in" && x.marketingSource === "shopify_sms"),
      marketingOptedOut: sum((x) => x.marketingStatus === "opted_out"),
      optedOutOfEverything: optedOut,
    });
  });

  /** Record an opt-out the customer gave another way (email, phone call): nothing more is sent to them. */
  app.post(`${base}/contacts/opt-out`, async (c) => {
    const { ws, storeId } = c.req.param();
    const access = await requireWaContactsManage(c, deps, ws);
    const store = await waStore(ws, storeId);
    const { phone: raw } = z.object({ phone: z.string().min(6).max(30) }).parse(await body(c));
    const phone = normalizePhone(raw, null);
    if (!phone) throw new HttpError(400, "Enter the number in international format, starting with + and the country code.", "invalid_phone");
    const contact = await upsertContact(store, phone);
    await optOutContact(contact, "merchant");
    await audit({ workspaceId: ws, actorUserId: access.user!.id, action: "whatsapp.contact_opted_out", targetType: "whatsapp_contact", targetId: contact.id, ip: clientIp(c) });
    return c.json({ ok: true, phoneMasked: contact.phoneMasked });
  });
}

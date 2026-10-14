import { z } from "zod";
import { Prisma, systemDb, withTenant, type WhatsappAutomationRule, type WhatsappCampaign } from "@app/db";
import {
  audit,
  dryRunAutomation,
  estimateAudience,
  marketingAllowed,
  merchantOrderStep,
  optOutContact,
  orderValues,
  parseConfig,
  parseRule,
  NotRetryableError,
  requeueMessage,
  scheduleMessage,
  storeName,
  upsertContact,
  waDecrypt,
  contactFirstName,
  money,
  trackingUrl,
  type AutomationSubject,
} from "@app/core";
import {
  audienceSchema,
  automationActionSchema,
  AUTOMATION_TRIGGERS,
  conditionSchema,
  errorExplanation,
  kindSetting,
  libraryTemplate,
  MODERATION_REASONS,
  normalizePhone,
  OCCASIONS,
  ruleConflicts,
  templateMappingSchema,
  templateShape,
  type AutomationTrigger,
  type RuleLike,
  type TemplateComponent,
} from "@app/shared";
import { body, clientIp, HttpError, requireWorkspace, type Deps } from "../context.js";
import type { App } from "../app.js";
import { limit, LIMITS } from "../rateLimit.js";
import { cursorPage } from "../pagination.js";
import { base, sampleValues, waStore } from "./whatsappCommon.js";

/** Day boundaries from ?from=YYYY-MM-DD&to=YYYY-MM-DD (UTC), each optional. */
function range(q: Record<string, string>) {
  const day = /^\d{4}-\d{2}-\d{2}$/;
  return {
    ...(q.from && day.test(q.from) ? { gte: new Date(`${q.from}T00:00:00Z`) } : {}),
    ...(q.to && day.test(q.to) ? { lt: new Date(new Date(`${q.to}T00:00:00Z`).getTime() + 86_400_000) } : {}),
  };
}

const ORDER_KINDS = ["order_confirmation", "payment_confirmed", "order_processing", "order_packed", "order_cancelled", "refund_processed"];
const DELIVERY_KINDS = ["order_shipped", "out_for_delivery", "order_delivered", "delivery_failed"];
const GROUP_KINDS: Record<string, string[]> = {
  orders: ORDER_KINDS,
  delivery: DELIVERY_KINDS,
  carts: ["abandoned_cart_1", "abandoned_cart_2"],
  reviews: ["review_request", "review_reminder"],
  campaign: ["campaign"],
  automation: ["automation"],
  test: ["test"],
};

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
  audience: audienceSchema.default({}),
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

const asRule = (r: WhatsappAutomationRule): RuleLike | null => {
  const p = parseRule(r);
  return p ? { id: r.id, name: r.name, enabled: r.enabled, trigger: r.trigger as AutomationTrigger, conditions: p.conditions, action: p.action } : null;
};

export function whatsappOpsRoutes(app: App, deps: Deps) {
  // ---------------------------------------------------------------- message history

  app.get(`${base}/messages`, async (c) => {
    const { ws, storeId } = c.req.param();
    await requireWorkspace(c, deps, ws, "customers:contact");
    await waStore(ws, storeId);
    const q = c.req.query();
    const paging = cursorPage(q, 50);
    const created = range(q);
    const where: Prisma.WhatsappMessageWhereInput = {
      storeId,
      workspaceId: ws,
      ...(q.status ? { status: { in: q.status.split(",").slice(0, 8) } } : {}),
      ...(q.kind ? { kind: q.kind } : q.group && GROUP_KINDS[q.group] ? { kind: { in: GROUP_KINDS[q.group] } } : {}),
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
        canRetry: !!m.paramsEnc && ["failed", "skipped", "cancelled"].includes(m.status),
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
    try {
      await requeueMessage(msg, deps);
    } catch (err) {
      // Anything else (database, queue) is a real failure: the global handler logs it.
      if (err instanceof NotRetryableError) throw new HttpError(409, err.message, "not_retryable");
      throw err;
    }
    await audit({ workspaceId: ws, actorUserId: access.user!.id, action: "whatsapp.message_retried", targetType: "whatsapp_message", targetId: id, ip: clientIp(c) });
    return c.json({ ok: true });
  });

  app.post(`${base}/messages/:id/cancel`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    const access = await requireWorkspace(c, deps, ws, "stores:manage");
    await waStore(ws, storeId);
    const { count } = await systemDb.whatsappMessage.updateMany({
      where: { id, storeId, workspaceId: ws, status: "scheduled" },
      data: { status: "cancelled", cancelledAt: new Date(), reason: "cancelled_by_merchant", paramsEnc: null },
    });
    if (!count) throw new HttpError(409, "Only a message that hasn't gone out yet can be cancelled.", "not_cancellable");
    await audit({ workspaceId: ws, actorUserId: access.user!.id, action: "whatsapp.message_cancelled", targetType: "whatsapp_message", targetId: id, ip: clientIp(c) });
    return c.json({ ok: true });
  });

  // ---------------------------------------------------------------- order timelines

  app.get(`${base}/orders`, async (c) => {
    const { ws, storeId } = c.req.param();
    await requireWorkspace(c, deps, ws, "customers:contact");
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
    await requireWorkspace(c, deps, ws, "customers:contact");
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
    await requireWorkspace(c, deps, ws, "customers:contact");
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
    if (!["open", "reminded", "ineligible"].includes(checkout.status)) throw new HttpError(409, "This checkout has been completed or has expired.", "checkout_closed");
    if (!checkout.recoveryUrlEnc) throw new HttpError(409, "Shopify didn't provide a link back to this checkout.", "no_checkout_link");
    const [settings, conn, contact] = await Promise.all([
      systemDb.whatsappSettings.findUnique({ where: { storeId } }),
      systemDb.whatsappConnection.findUnique({ where: { storeId } }),
      checkout.contactId ? systemDb.whatsappContact.findUnique({ where: { id: checkout.contactId } }) : null,
    ]);
    if (!conn) throw new HttpError(409, "Connect WhatsApp first.", "not_connected");
    if (!contact) throw new HttpError(409, "There's no WhatsApp number for this checkout.", "no_phone");
    const cfg = parseConfig(settings?.config);
    const s = kindSetting(cfg, "abandoned_cart_1");
    if (!s.templateName) throw new HttpError(409, "Choose a cart reminder template on Abandoned carts first.", "template_required");
    const template = await systemDb.whatsappTemplate.findUnique({ where: { connectionId_name_language: { connectionId: conn.id, name: s.templateName, language: s.language } } });
    if (!template || template.status !== "APPROVED") throw new HttpError(409, "The cart reminder template isn't approved yet.", "template_not_approved");
    if (template.category === "MARKETING" && !marketingAllowed(cfg, contact)) {
      throw new HttpError(409, "This customer hasn't agreed to WhatsApp marketing, so a cart reminder can't be sent.", "no_marketing_consent");
    }
    const { message, created } = await scheduleMessage(
      {
        store,
        kind: "abandoned_cart_1",
        dedupeKey: `cart:${checkout.checkoutToken}:manual`,
        contact,
        template: { name: s.templateName, language: s.language },
        mapping: s.mapping,
        values: {
          customer_name: contactFirstName(contact) || "there",
          store_name: storeName(store),
          cart_total: money(checkout.totalPrice, checkout.currency),
          support_contact: cfg.supportPhone || cfg.supportEmail || null,
        },
        scheduledFor: new Date(),
        checkoutId: checkout.id,
        clickUrl: waDecrypt(storeId, "recovery", checkout.recoveryUrlEnc),
      },
      deps,
    );
    if (!created) throw new HttpError(409, "A reminder was already sent from here for this checkout.", "already_reminded");
    await audit({ workspaceId: ws, actorUserId: access.user!.id, action: "whatsapp.cart_reminder_sent", targetType: "abandoned_checkout", targetId: checkout.id, ip: clientIp(c) });
    return c.json({ messageId: message.id, status: message.status });
  });

  // ---------------------------------------------------------------- reviews

  app.get(`${base}/reviews`, async (c) => {
    const { ws, storeId } = c.req.param();
    await requireWorkspace(c, deps, ws, "customers:contact");
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

  async function campaignMetrics(ws: string, campaigns: WhatsappCampaign[], storeId: string, attributionDays: number) {
    const ids = campaigns.map((x) => x.id);
    if (!ids.length) return new Map<string, Record<string, unknown>>();
    const [byStatus, clicks, attributed] = await withTenant(ws, (tx) =>
      Promise.all([
        tx.whatsappMessage.groupBy({ by: ["campaignId", "status"], where: { campaignId: { in: ids }, workspaceId: ws }, _count: { _all: true } }),
        tx.whatsappMessage.groupBy({ by: ["campaignId"], where: { campaignId: { in: ids }, workspaceId: ws, clickedAt: { not: null } }, _count: { _all: true } }),
        tx.whatsappMessage.groupBy({ by: ["campaignId"], where: { campaignId: { in: ids }, workspaceId: ws, attributedOrderId: { not: null } }, _count: { _all: true }, _sum: { attributedRevenue: true } }),
      ]),
    );
    // Orders that used each campaign's discount code while it ran (and its attribution days after),
    // for every campaign with a code at once: one query, not one per campaign.
    const now = Date.now();
    const windows = campaigns.flatMap((camp) =>
      camp.discountCode && camp.startedAt
        ? [{ id: camp.id, code: camp.discountCode, since: camp.startedAt.toISOString(), until: new Date((camp.endAt?.getTime() ?? now) + attributionDays * 86_400_000).toISOString() }]
        : [],
    );
    const codeRows = windows.length
      ? await withTenant(ws, (tx) =>
          tx.$queryRaw<Array<{ id: string; orders: number; revenue: string }>>`
            SELECT w.id, COUNT(o.id)::int AS orders, COALESCE(SUM(o.total_price), 0)::text AS revenue
            FROM jsonb_to_recordset(${JSON.stringify(windows)}::jsonb) AS w(id text, code text, since text, until text)
            LEFT JOIN orders o
              ON o.store_id = ${storeId} AND o.workspace_id = ${ws} AND o.cancelled_at IS NULL
             AND o.shopify_created_at >= (w.since)::timestamptz AT TIME ZONE 'UTC'
             AND o.shopify_created_at < (w.until)::timestamptz AT TIME ZONE 'UTC'
             AND EXISTS (SELECT 1 FROM unnest(o.discount_codes) code WHERE lower(code) = lower(w.code))
            GROUP BY w.id`,
        )
      : [];
    const out = new Map<string, Record<string, unknown>>();
    for (const camp of campaigns) {
      const n = (s: string[]) => byStatus.filter((b) => b.campaignId === camp.id && s.includes(b.status)).reduce((sum, b) => sum + b._count._all, 0);
      const a = attributed.find((x) => x.campaignId === camp.id);
      const r = codeRows.find((x) => x.id === camp.id);
      const codeOrders = r ? { orders: r.orders, revenue: Number(r.revenue) } : null;
      out.set(camp.id, {
        recipients: n(["scheduled", "sending", "sent", "delivered", "read", "failed", "skipped", "cancelled"]),
        waiting: n(["scheduled", "sending"]),
        sent: n(["sent", "delivered", "read"]),
        delivered: n(["delivered", "read"]),
        read: n(["read"]),
        failed: n(["failed"]),
        skipped: n(["skipped", "cancelled"]),
        clicks: clicks.find((x) => x.campaignId === camp.id)?._count._all ?? 0,
        conversions: a?._count._all ?? 0,
        revenue: Number(a?._sum.attributedRevenue ?? 0),
        codeOrders,
      });
    }
    return out;
  }

  const publicCampaign = (camp: WhatsappCampaign, metrics?: Record<string, unknown>) => ({
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
    await requireWorkspace(c, deps, ws, "dashboard:read");
    await waStore(ws, storeId);
    const [rows, settings] = await withTenant(ws, (tx) =>
      Promise.all([tx.whatsappCampaign.findMany({ where: { storeId, workspaceId: ws }, orderBy: { createdAt: "desc" }, take: 100 }), tx.whatsappSettings.findUnique({ where: { storeId } })]),
    );
    const metrics = await campaignMetrics(ws, rows, storeId, parseConfig(settings?.config).attributionDays);
    return c.json({ campaigns: rows.map((r) => publicCampaign(r, metrics.get(r.id))) });
  });

  /** How many customers an audience reaches right now (opted in, not opted out). */
  app.post(`${base}/campaigns/estimate`, async (c) => {
    const { ws, storeId } = c.req.param();
    await requireWorkspace(c, deps, ws, "dashboard:read");
    await waStore(ws, storeId);
    const { audience } = z.object({ audience: audienceSchema.default({}) }).parse(await body(c));
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
    await requireWorkspace(c, deps, ws, "dashboard:read");
    await waStore(ws, storeId);
    const camp = await ownCampaign(ws, storeId, id);
    const settings = await systemDb.whatsappSettings.findUnique({ where: { storeId } });
    const cfg = parseConfig(settings?.config);
    const metrics = await campaignMetrics(ws, [camp], storeId, cfg.attributionDays);
    const estimate = ["draft", "scheduled"].includes(camp.status) ? await estimateAudience(storeId, camp.audience, cfg) : null;
    return c.json({ campaign: publicCampaign(camp, metrics.get(camp.id)), estimate });
  });

  /** Edit a draft. Editing a scheduled campaign takes it back to draft: it has to be confirmed again. */
  app.patch(`${base}/campaigns/:id`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    const access = await requireWorkspace(c, deps, ws, "stores:manage");
    await waStore(ws, storeId);
    const camp = await ownCampaign(ws, storeId, id);
    if (!["draft", "scheduled"].includes(camp.status)) throw new HttpError(409, "Only a campaign that hasn't started can be edited.", "not_editable");
    const input = campaignInput.partial().parse(await body(c));
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

  /**
   * Schedule (authorize) a campaign. The merchant confirms the recipient count they were shown;
   * if it changed since, they're shown the new one first. Needs an approved marketing template, a
   * registered number and verified webhooks (otherwise STOP replies couldn't reach us).
   */
  app.post(`${base}/campaigns/:id/schedule`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    const access = await requireWorkspace(c, deps, ws, "stores:manage");
    await waStore(ws, storeId);
    const { confirmRecipients } = z.object({ confirmRecipients: z.number().int().min(0) }).parse(await body(c));
    const camp = await ownCampaign(ws, storeId, id);
    if (camp.status !== "draft") throw new HttpError(409, "This campaign is already scheduled or has run.", "not_draft");
    const [conn, settings] = await Promise.all([systemDb.whatsappConnection.findUnique({ where: { storeId } }), systemDb.whatsappSettings.findUnique({ where: { storeId } })]);
    if (!conn || conn.status !== "active" || !conn.registered) throw new HttpError(409, "Connect and register your WhatsApp number first.", "not_connected");
    if (!conn.webhookVerifiedAt) throw new HttpError(409, "Meta hasn't reached Insights' webhook yet, so opt-out replies couldn't be received. Finish the webhook step on Connect WhatsApp first.", "webhook_unverified");
    const template = await systemDb.whatsappTemplate.findUnique({ where: { connectionId_name_language: { connectionId: conn.id, name: camp.templateName, language: camp.templateLanguage } } });
    if (!template || template.status !== "APPROVED") throw new HttpError(409, "The campaign's template isn't approved by Meta yet.", "template_not_approved");
    if (template.category !== "MARKETING") throw new HttpError(409, "Campaigns must use a template Meta approved as Marketing.", "not_marketing_template");
    const shape = templateShape(template.components as unknown as TemplateComponent[]);
    const mapping = templateMappingSchema.parse(camp.mapping ?? {});
    if (mapping.body.length < shape.bodyVars) throw new HttpError(400, `The template has ${shape.bodyVars} variables; fill each one.`, "mapping_incomplete");
    if (shape.headerFormat === "IMAGE" && !camp.mediaUrl) throw new HttpError(400, "This template needs an image: add the image's https link.", "media_required");
    if (shape.dynamicUrlButtons.length && !camp.linkUrl) throw new HttpError(400, "This template has a link button: add where it should go.", "link_required");
    if (camp.endAt && camp.endAt <= new Date()) throw new HttpError(400, "The campaign's end has already passed.", "ended");
    const estimate = await estimateAudience(storeId, camp.audience, parseConfig(settings?.config));
    if (estimate !== confirmRecipients) {
      return c.json({ error: "recipients_changed", message: `The audience is now ${estimate} customers. Please confirm again.`, recipients: estimate }, 409);
    }
    if (estimate === 0) throw new HttpError(409, "No customers in this audience have opted in to WhatsApp marketing.", "no_recipients");
    const updated = await systemDb.whatsappCampaign.update({
      where: { id: camp.id },
      data: { status: "scheduled", estimatedRecipients: estimate, approvedByUserId: access.user!.id, approvedAt: new Date() },
    });
    await audit({
      workspaceId: ws,
      actorUserId: access.user!.id,
      action: "whatsapp.campaign_scheduled",
      targetType: "whatsapp_campaign",
      targetId: camp.id,
      metadata: { recipients: estimate, startAt: camp.startAt, template: camp.templateName },
      ip: clientIp(c),
    });
    return c.json({ campaign: publicCampaign(updated) });
  });

  for (const action of ["pause", "resume", "cancel"] as const) {
    app.post(`${base}/campaigns/:id/${action}`, async (c) => {
      const { ws, storeId, id } = c.req.param();
      const access = await requireWorkspace(c, deps, ws, "stores:manage");
      await waStore(ws, storeId);
      const camp = await ownCampaign(ws, storeId, id);
      const from = action === "pause" ? ["scheduled", "sending"] : action === "resume" ? ["paused"] : ["draft", "scheduled", "sending", "paused"];
      if (!from.includes(camp.status)) throw new HttpError(409, `A ${camp.status} campaign can't be ${action === "cancel" ? "cancelled" : action + "d"}.`, "invalid_state");
      const status = action === "pause" ? "paused" : action === "resume" ? (camp.startedAt ? "sending" : "scheduled") : "cancelled";
      await systemDb.whatsappCampaign.update({ where: { id: camp.id }, data: { status, ...(action === "cancel" ? { completedAt: new Date() } : {}) } });
      if (action === "cancel") {
        await systemDb.whatsappMessage.updateMany({
          where: { campaignId: camp.id, status: "scheduled" },
          data: { status: "cancelled", cancelledAt: new Date(), reason: "campaign_cancelled", paramsEnc: null },
        });
      }
      const done = { pause: "paused", resume: "resumed", cancel: "cancelled" }[action];
      await audit({ workspaceId: ws, actorUserId: access.user!.id, action: `whatsapp.campaign_${done}`, targetType: "whatsapp_campaign", targetId: camp.id, ip: clientIp(c) });
      return c.json({ ok: true, status });
    });
  }

  // ---------------------------------------------------------------- automations

  app.get(`${base}/automations`, async (c) => {
    const { ws, storeId } = c.req.param();
    await requireWorkspace(c, deps, ws, "dashboard:read");
    await waStore(ws, storeId);
    const [rules, runs] = await withTenant(ws, (tx) =>
      Promise.all([
        tx.whatsappAutomationRule.findMany({ where: { storeId, workspaceId: ws }, orderBy: { createdAt: "asc" } }),
        tx.whatsappAutomationRun.groupBy({ by: ["ruleId", "outcome"], where: { storeId, workspaceId: ws, createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) } }, _count: { _all: true }, _max: { createdAt: true } }),
      ]),
    );
    const all = rules.map(asRule).filter((r): r is RuleLike => !!r);
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

  async function checkRule(ws: string, storeId: string, candidate: RuleLike) {
    const others = (await systemDb.whatsappAutomationRule.findMany({ where: { storeId, workspaceId: ws } })).map(asRule).filter((r): r is RuleLike => !!r);
    const conflicts = ruleConflicts(candidate, others);
    const blocking = conflicts.find((x) => x.severity === "block");
    if (blocking) throw new HttpError(409, blocking.message, "rule_conflict");
    const a = candidate.action;
    if (a.type === "send_template" || a.type === "schedule_reminder") {
      const conn = await systemDb.whatsappConnection.findUnique({ where: { storeId } });
      const t = conn ? await systemDb.whatsappTemplate.findUnique({ where: { connectionId_name_language: { connectionId: conn.id, name: a.templateName, language: a.language } } }) : null;
      if (!t) throw new HttpError(400, `"${a.templateName}" (${a.language}) isn't in your WhatsApp account.`, "template_missing");
      const shape = templateShape(t.components as unknown as TemplateComponent[]);
      if (a.mapping.body.length < shape.bodyVars) throw new HttpError(400, `The template has ${shape.bodyVars} variables; fill each one.`, "mapping_incomplete");
    }
    return conflicts;
  }

  app.post(`${base}/automations`, async (c) => {
    const { ws, storeId } = c.req.param();
    const access = await requireWorkspace(c, deps, ws, "stores:manage");
    await waStore(ws, storeId);
    const input = ruleInput.parse(await body(c));
    const conflicts = await checkRule(ws, storeId, { id: "new", ...input });
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
    const patch = ruleInput.partial().parse(await body(c));
    const merged = ruleInput.parse({
      name: patch.name ?? rule.name,
      enabled: patch.enabled ?? rule.enabled,
      trigger: patch.trigger ?? rule.trigger,
      conditions: patch.conditions ?? current?.conditions ?? [],
      action: patch.action ?? current?.action,
    });
    const conflicts = await checkRule(ws, storeId, { id: rule.id, ...merged });
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
    await systemDb.whatsappMessage.updateMany({ where: { ruleId: id, status: "scheduled" }, data: { status: "cancelled", cancelledAt: new Date(), reason: "rule_deleted", paramsEnc: null } });
    await audit({ workspaceId: ws, actorUserId: access.user!.id, action: "whatsapp.automation_deleted", targetType: "whatsapp_automation_rule", targetId: id, ip: clientIp(c) });
    return c.json({ ok: true });
  });

  app.get(`${base}/automations/:id/runs`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    await requireWorkspace(c, deps, ws, "dashboard:read");
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
    const settings = await systemDb.whatsappSettings.findUnique({ where: { storeId } });
    const cfg = parseConfig(settings?.config);
    const tracking = await withTenant(ws, (tx) =>
      tx.orderTracking.findFirst({ where: { storeId, workspaceId: ws, ...(input.trackingId ? { id: input.trackingId } : {}) }, orderBy: { orderCreatedAt: "desc" } }),
    );
    const contact = tracking?.contactId ? await systemDb.whatsappContact.findUnique({ where: { id: tracking.contactId } }) : null;
    const items = ((tracking?.items as Array<{ productId: string; title: string }>) ?? []);
    const subject: AutomationSubject = {
      key: tracking ? `order:${tracking.shopifyOrderId}` : "example",
      store,
      cfg,
      contact,
      tracking,
      facts: tracking
        ? { orderValue: Number(tracking.totalPrice), productIds: items.map((i) => i.productId), productTitles: items.map((i) => i.title), orderStatus: tracking.status, country: tracking.country, marketingConsent: contact ? marketingAllowed(cfg, contact) : false }
        : { orderValue: 0, marketingConsent: false },
      values: tracking ? orderValues(store, cfg, tracking, contact ? contactFirstName(contact) : null) : sampleValues(store, cfg),
    };
    const result = await dryRunAutomation(rule, subject);
    let testMessageId: string | null = null;
    const parsed = parseRule(rule);
    if (input.phone && parsed && (parsed.action.type === "send_template" || parsed.action.type === "schedule_reminder")) {
      const phone = normalizePhone(input.phone, null);
      if (!phone) throw new HttpError(400, "Enter the number in international format, starting with + and the country code.", "invalid_phone");
      await limit(deps.coord, `rl:wa-test:${storeId}`, LIMITS.waTest);
      const { message } = await scheduleMessage(
        {
          store,
          kind: "test",
          dedupeKey: `test:rule:${rule.id}:${Date.now()}`,
          contact: null,
          template: { name: parsed.action.templateName, language: parsed.action.language },
          mapping: parsed.action.mapping,
          values: { ...sampleValues(store, cfg), ...subject.values, customer_name: "Test" },
          scheduledFor: new Date(),
          ruleId: rule.id,
          test: { to: phone.waId },
        },
        deps,
      );
      testMessageId = message.id;
    }
    await systemDb.whatsappAutomationRun
      .create({ data: { workspaceId: ws, storeId, ruleId: rule.id, trigger: rule.trigger, subjectKey: `test:${Date.now()}`, outcome: "test", detail: result.valid ? (result.wouldRun ? "Would run" : "Conditions not met") : result.error, messageId: testMessageId } })
      .catch(() => undefined);
    await audit({ workspaceId: ws, actorUserId: access.user!.id, action: "whatsapp.automation_tested", targetType: "whatsapp_automation_rule", targetId: rule.id, ip: clientIp(c) });
    return c.json({ ...result, order: tracking ? { id: tracking.id, orderName: tracking.orderName } : null, testMessageId });
  });

  // ---------------------------------------------------------------- consent

  app.get(`${base}/contacts/summary`, async (c) => {
    const { ws, storeId } = c.req.param();
    await requireWorkspace(c, deps, ws, "dashboard:read");
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
      marketingEligible: sum((x) => x.marketingStatus === "opted_in" && (x.marketingSource !== "shopify_sms" || cfg.smsConsentCountsForMarketing)),
      optedInViaShopifySms: sum((x) => x.marketingStatus === "opted_in" && x.marketingSource === "shopify_sms"),
      marketingOptedOut: sum((x) => x.marketingStatus === "opted_out"),
      optedOutOfEverything: optedOut,
    });
  });

  /** Record an opt-out the customer gave another way (email, phone call): nothing more is sent to them. */
  app.post(`${base}/contacts/opt-out`, async (c) => {
    const { ws, storeId } = c.req.param();
    const access = await requireWorkspace(c, deps, ws, "customers:contact");
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

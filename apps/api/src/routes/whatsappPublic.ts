import { z } from "zod";
import { Prisma, systemDb } from "@app/db";
import { applyMetaWebhook, env, logger, parseConfig, refreshTrackingStatus, storeName, waDecrypt, waPlatformConfig, waPlatformSecret } from "@app/core";
import { safeEqual, sha256Hex, SHIPMENT_RANK, verifyMetaSignature, type ShipmentStage } from "@app/shared";
import { body, clientIp, HttpError, type Deps } from "../context.js";
import type { App } from "../app.js";
import { limit, LIMITS } from "../rateLimit.js";

/**
 * The WhatsApp routes that answer without a session:
 *  - Meta's webhook (verify handshake, then signed deliveries),
 *  - the customer's order tracking page and review form (found by an unguessable token; the order
 *    id alone never finds anything),
 *  - tracked links in messages (/r/<code>),
 *  - a store's published reviews (for its storefront).
 */

const STEP_LABEL: Record<string, string> = {
  placed: "Order placed",
  paid: "Payment confirmed",
  processing: "Processing",
  packed: "Packed",
  shipped: "Shipped",
  in_transit: "In transit",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
};

const FINANCIAL_LABEL: Record<string, string> = {
  paid: "Paid",
  pending: "Payment pending",
  authorized: "Payment authorised",
  partially_paid: "Partially paid",
  refunded: "Refunded",
  partially_refunded: "Partially refunded",
  voided: "Payment voided",
};

/** Link previews (WhatsApp's own, Facebook's crawler) open links nobody clicked. */
const PREVIEW_AGENTS = /WhatsApp\/|facebookexternalhit|Facebot|TelegramBot|Slackbot|Twitterbot|bot\b|crawler|spider/i;

const reviewSchema = z.object({
  reviewerName: z.string().trim().max(60).optional().default(""),
  reviews: z
    .array(
      z.object({
        productId: z.string().max(40).default(""),
        rating: z.number().int().min(1).max(5),
        body: z.string().max(2000).optional().default(""),
      }),
    )
    .min(1)
    .max(30),
});

/** Strip control characters (keep newlines) from text customers type. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const clean = (s: string) => s.replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, "").trim();

/** Edits are accepted this long after a review was first submitted. */
const REVIEW_EDIT_DAYS = 60;

async function trackingByToken(hashOf: "tokenHash" | "reviewTokenHash", token: string) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null;
  const t = await systemDb.orderTracking.findUnique({ where: hashOf === "tokenHash" ? { tokenHash: sha256Hex(token) } : { reviewTokenHash: sha256Hex(token) } });
  if (!t || t.expiresAt < new Date()) return null;
  return t;
}

const notFound = () => new HttpError(404, "This link has expired or isn't valid. Ask the store for an update.", "not_found");

export function whatsappPublicRoutes(app: App, deps: Deps) {
  // ---------------------------------------------------------------- Meta webhook

  /** Meta's subscription handshake: echo the challenge when the verify token is ours (or a store's own). */
  app.get("/webhooks/whatsapp", async (c) => {
    await limit(deps.coord, `rl:wa-verify:${clientIp(c)}`, LIMITS.waVerifyIp);
    const mode = c.req.query("hub.mode");
    const token = c.req.query("hub.verify_token") ?? "";
    const challenge = c.req.query("hub.challenge") ?? "";
    if (mode !== "subscribe" || !token || !challenge || challenge.length > 200) return c.json({ error: "forbidden" }, 403);
    const platform = env().WHATSAPP_WEBHOOK_VERIFY_TOKEN;
    let ok = !!platform && safeEqual(token, platform);
    if (!ok) {
      // A manual connection's own Meta app, with the verify token shown in its settings.
      const conn = await systemDb.whatsappConnection.findUnique({ where: { verifyTokenHash: sha256Hex(token) } });
      if (conn) {
        ok = true;
        await systemDb.whatsappConnection.update({ where: { id: conn.id }, data: { webhookVerifiedAt: new Date() } });
      }
    }
    if (!ok) {
      logger.warn({ ip: clientIp(c) }, "whatsapp webhook verification refused");
      return c.json({ error: "forbidden" }, 403);
    }
    return c.text(challenge, 200, { "content-type": "text/plain" });
  });

  /**
   * Deliveries. The signature (X-Hub-Signature-256, HMAC of the raw body with the app secret) is
   * checked before anything is applied: Insights' own app secret vouches for every account it
   * connected; a manual connection's secret vouches only for its own account.
   */
  app.post("/webhooks/whatsapp", async (c) => {
    const raw = await c.req.text();
    const sig = c.req.header("x-hub-signature-256");
    let trusted: Set<string> | "all" | null = null;
    const platformSecret = waPlatformSecret();
    if (platformSecret && verifyMetaSignature(raw, sig, platformSecret)) trusted = "all";
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      if (!trusted) return c.json({ error: "invalid_signature" }, 401);
      return c.json({ error: "invalid_json" }, 400);
    }
    if (!trusted) {
      // Anyone can send this: cap how often one address makes us look anything up.
      await limit(deps.coord, `rl:wa-unsigned:${clientIp(c)}`, LIMITS.waUnsignedIp);
      const ids = [...new Set(((payload as { entry?: Array<{ id?: unknown }> })?.entry ?? []).map((e) => String(e?.id ?? "")).filter(Boolean))].slice(0, 20);
      const conns = ids.length ? await systemDb.whatsappConnection.findMany({ where: { wabaId: { in: ids }, appSecretEnc: { not: null } } }) : [];
      const ok = new Set<string>();
      for (const conn of conns) {
        try {
          if (verifyMetaSignature(raw, sig, waDecrypt(conn.storeId, "app_secret", conn.appSecretEnc!))) ok.add(conn.wabaId);
        } catch (err) {
          logger.warn({ err, connectionId: conn.id }, "could not read a whatsapp app secret");
        }
      }
      if (ok.size) trusted = ok;
    }
    if (!trusted) {
      logger.warn({ ip: clientIp(c) }, "whatsapp webhook rejected: bad signature");
      return c.json({ error: "invalid_signature" }, 401);
    }
    const result = await applyMetaWebhook(payload, trusted, deps);
    // A status for a message we sent a moment ago and are still recording: Meta retries it shortly.
    if (result.retry) return c.json({ error: "in_progress" }, 503);
    return c.json({ ok: true });
  });

  // ---------------------------------------------------------------- tracking page

  app.get("/public/track/:token", async (c) => {
    await limit(deps.coord, `rl:track:${clientIp(c)}`, LIMITS.trackIp);
    c.header("x-robots-tag", "noindex, nofollow");
    c.header("referrer-policy", "no-referrer");
    const t = await trackingByToken("tokenHash", c.req.param("token"));
    if (!t) throw notFound();
    const [store, settings, events] = await Promise.all([
      systemDb.store.findUnique({ where: { id: t.storeId }, select: { name: true, shopDomain: true } }),
      systemDb.whatsappSettings.findUnique({ where: { storeId: t.storeId } }),
      systemDb.orderTrackingEvent.findMany({ where: { trackingId: t.id }, orderBy: { occurredAt: "asc" } }),
    ]);
    if (!store) throw notFound();
    const status = await refreshTrackingStatus(t.id);
    const cfg = parseConfig(settings?.config);
    const at = (type: string) => events.find((e) => e.type === type)?.occurredAt ?? null;
    const has = (type: string) => events.some((e) => e.type === type);
    const delivered = !!t.deliveredAt;
    const stepDone = (k: string) =>
      k === "placed" ? true
      : k === "paid" ? !!t.paidAt
      : k === "processing" ? has("processing") || has("packed") || t.shipmentRank > 0
      : k === "packed" ? has("packed") || t.shipmentRank > 0
      : k === "delivered" ? delivered
      : t.shipmentRank >= SHIPMENT_RANK[k as ShipmentStage];
    // Steps that never happen for this order (not paid online, no packing step) are left out.
    const keys = ["placed", ...(t.paidAt ? ["paid"] : []), ...(has("processing") ? ["processing"] : []), ...(has("packed") ? ["packed"] : []), "shipped", "out_for_delivery", "delivered"];
    const steps = keys.map((k) => ({
      key: k,
      label: STEP_LABEL[k],
      done: stepDone(k),
      at: k === "placed" ? t.orderCreatedAt : k === "paid" ? t.paidAt : k === "delivered" ? t.deliveredAt : at(k),
    }));
    // One entry per parcel, with what its courier last said.
    const parcels = new Map<string, typeof events>();
    for (const e of events) if (e.fulfillmentId && e.fulfillmentId !== "merchant") parcels.set(e.fulfillmentId, [...(parcels.get(e.fulfillmentId) ?? []), e]);
    const shipments = [...parcels.values()].map((list) => {
      const withInfo = list.find((e) => e.courier || e.trackingNumber || e.trackingUrl);
      const last = list[list.length - 1]!;
      const eta = [...list].reverse().find((e) => e.estimatedDeliveryAt)?.estimatedDeliveryAt ?? null;
      return {
        courier: withInfo?.courier ?? null,
        trackingNumber: withInfo?.trackingNumber ?? null,
        trackingUrl: withInfo?.trackingUrl && /^https?:\/\//i.test(withInfo.trackingUrl) ? withInfo.trackingUrl : null,
        status: last.type,
        estimatedDelivery: eta,
        events: list.map((e) => ({ type: e.type, at: e.occurredAt, source: e.source })),
      };
    });
    const items = ((t.items as Array<{ title: string; quantity: number }>) ?? []).map((i) => ({ title: i.title, quantity: i.quantity }));
    return c.json({
      store: { name: storeName(store), supportPhone: cfg.supportPhone || null, supportEmail: cfg.supportEmail || null },
      order: {
        name: t.orderName,
        placedAt: t.orderCreatedAt,
        total: Number(t.totalPrice),
        currency: t.currency,
        payment: t.financialStatus ? (FINANCIAL_LABEL[t.financialStatus] ?? null) : null,
        status,
        cancelledAt: t.cancelledAt,
        deliveredAt: t.deliveredAt,
        items,
      },
      steps,
      shipments,
      failedAttempts: events.filter((e) => e.type === "delivery_failed").map((e) => e.occurredAt),
      /** False when no courier has reported anything: the page says live tracking isn't available. */
      liveTracking: t.carrierEvents,
      reviewToken: delivered && !t.cancelledAt ? waDecrypt(t.storeId, "review", t.reviewTokenEnc) : null,
    });
  });

  // ---------------------------------------------------------------- review form

  app.get("/public/review/:token", async (c) => {
    await limit(deps.coord, `rl:review:${clientIp(c)}`, LIMITS.reviewIp);
    c.header("x-robots-tag", "noindex, nofollow");
    c.header("referrer-policy", "no-referrer");
    const t = await trackingByToken("reviewTokenHash", c.req.param("token"));
    if (!t) throw notFound();
    const [store, existing] = await Promise.all([
      systemDb.store.findUnique({ where: { id: t.storeId }, select: { name: true, shopDomain: true } }),
      systemDb.customerReview.findMany({ where: { trackingId: t.id }, select: { productId: true, rating: true, body: true, reviewerName: true, submittedAt: true } }),
    ]);
    if (!store) throw notFound();
    const items = ((t.items as Array<{ productId: string; title: string }>) ?? []).filter((i, n, all) => !i.productId || all.findIndex((x) => x.productId === i.productId) === n);
    const first = existing.reduce<Date | null>((min, r) => (!min || r.submittedAt < min ? r.submittedAt : min), null);
    return c.json({
      store: { name: storeName(store) },
      order: { name: t.orderName, placedAt: t.orderCreatedAt, deliveredAt: t.deliveredAt, cancelled: !!t.cancelledAt },
      products: items.filter((i) => i.productId).map((i) => ({ productId: i.productId, title: i.title })),
      existing: existing.map((r) => ({ productId: r.productId, rating: r.rating, body: r.body ?? "", reviewerName: r.reviewerName ?? "" })),
      canEdit: !first || Date.now() - first.getTime() < REVIEW_EDIT_DAYS * 86_400_000,
    });
  });

  /** Submit (or edit) reviews of the order and its products. One per order and product; never paid for. */
  app.post("/public/review/:token", async (c) => {
    await limit(deps.coord, `rl:review:${clientIp(c)}`, LIMITS.reviewIp);
    const token = c.req.param("token");
    await limit(deps.coord, `rl:review-submit:${sha256Hex(token)}`, LIMITS.reviewSubmitPerOrder);
    const t = await trackingByToken("reviewTokenHash", token);
    if (!t) throw notFound();
    if (t.cancelledAt) throw new HttpError(409, "This order was cancelled, so it can't be reviewed.", "order_cancelled");
    const input = reviewSchema.parse(await body(c));
    const items = (t.items as Array<{ productId: string; title: string }>) ?? [];
    const titleOf = new Map(items.filter((i) => i.productId).map((i) => [i.productId, i.title]));
    const seen = new Set<string>();
    for (const r of input.reviews) {
      if (r.productId && !titleOf.has(r.productId)) throw new HttpError(400, "That product isn't part of this order.", "invalid_product");
      if (seen.has(r.productId)) throw new HttpError(400, "Each product can be reviewed once.", "duplicate_product");
      seen.add(r.productId);
    }
    const settings = await systemDb.whatsappSettings.findUnique({ where: { storeId: t.storeId } });
    const autoPublish = parseConfig(settings?.config).reviewAutoPublish;
    const existing = await systemDb.customerReview.findMany({ where: { trackingId: t.id } });
    const first = existing.reduce<Date | null>((min, r) => (!min || r.submittedAt < min ? r.submittedAt : min), null);
    if (first && Date.now() - first.getTime() > REVIEW_EDIT_DAYS * 86_400_000) throw new HttpError(409, "Reviews for this order can no longer be changed.", "edit_window_closed");
    const name = clean(input.reviewerName).slice(0, 60) || null;
    const now = new Date();
    for (const r of input.reviews) {
      const text = clean(r.body).slice(0, 2000) || null;
      const before = existing.find((e) => e.productId === r.productId);
      // A review a merchant rejected for a policy reason stays rejected unless they look again.
      const status = before?.status === "rejected" ? "pending" : autoPublish ? "published" : "pending";
      if (before) {
        if (before.rating === r.rating && (before.body ?? null) === text && (before.reviewerName ?? null) === name) continue;
        await systemDb.customerReview.update({
          where: { id: before.id },
          data: { rating: r.rating, body: text, reviewerName: name, status, editedAt: now, moderationReason: null, moderatedAt: null, moderatedByUserId: null },
        });
      } else {
        try {
          await systemDb.customerReview.create({
            data: {
              workspaceId: t.workspaceId,
              storeId: t.storeId,
              trackingId: t.id,
              shopifyOrderId: t.shopifyOrderId,
              orderName: t.orderName,
              productId: r.productId,
              productTitle: r.productId ? (titleOf.get(r.productId) ?? null) : null,
              rating: r.rating,
              body: text,
              reviewerName: name,
              status,
            },
          });
        } catch (err) {
          if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
        }
      }
    }
    // The request and reminder are no longer needed.
    await systemDb.whatsappMessage.updateMany({
      where: { trackingId: t.id, kind: { in: ["review_request", "review_reminder"] }, status: "scheduled" },
      data: { status: "cancelled", cancelledAt: now, reason: "already_reviewed", paramsEnc: null },
    });
    return c.json({ ok: true, status: autoPublish ? "published" : "pending" });
  });

  /** A store's published reviews, for its storefront (CORS-open: they're public by nature). */
  app.get("/public/stores/:storeId/reviews", async (c) => {
    await limit(deps.coord, `rl:track:${clientIp(c)}`, LIMITS.trackIp);
    c.header("access-control-allow-origin", "*");
    const storeId = c.req.param("storeId");
    const productId = c.req.query("productId");
    if (!/^[a-z0-9]{10,40}$/i.test(storeId) || (productId && !/^\d{1,30}$/.test(productId))) throw new HttpError(400, "Bad request", "bad_request");
    const where = { storeId, status: "published", ...(productId ? { productId } : {}) };
    const [rows, agg] = await Promise.all([
      systemDb.customerReview.findMany({ where, orderBy: { submittedAt: "desc" }, take: 50, select: { rating: true, body: true, reviewerName: true, productTitle: true, submittedAt: true } }),
      systemDb.customerReview.aggregate({ where, _avg: { rating: true }, _count: { _all: true } }),
    ]);
    return c.json({
      count: agg._count._all,
      average: agg._avg.rating ? Math.round(agg._avg.rating * 10) / 10 : null,
      reviews: rows.map((r) => ({ ...r, verifiedPurchase: true })),
    });
  });

  // ---------------------------------------------------------------- tracked links

  app.get("/r/:code", async (c) => {
    await limit(deps.coord, `rl:click:${clientIp(c)}`, LIMITS.clickIp);
    c.header("referrer-policy", "no-referrer");
    const code = c.req.param("code");
    if (!/^[A-Za-z0-9_-]{8,24}$/.test(code)) throw notFound();
    const msg = await systemDb.whatsappMessage.findUnique({ where: { clickCode: code } });
    if (!msg) throw notFound();
    let url: string | null = msg.clickUrlEnc ? waDecrypt(msg.storeId, "click", msg.clickUrlEnc) : null;
    if (!url && msg.campaignId) url = (await systemDb.whatsappCampaign.findUnique({ where: { id: msg.campaignId }, select: { linkUrl: true } }))?.linkUrl ?? null;
    if (!url || !/^https?:\/\//i.test(url)) throw notFound();
    if (!msg.clickedAt && !PREVIEW_AGENTS.test(c.req.header("user-agent") ?? "")) {
      await systemDb.whatsappMessage.updateMany({ where: { id: msg.id, clickedAt: null }, data: { clickedAt: new Date() } });
    }
    return c.redirect(url, 302);
  });

  /** For the dashboard: whether Embedded Signup can be offered at all (public ids only). */
  app.get("/whatsapp/platform", (c) => {
    const p = waPlatformConfig();
    return c.json(p ? { embeddedSignup: true, appId: p.appId, configId: p.configId, version: p.version } : { embeddedSignup: false });
  });
}

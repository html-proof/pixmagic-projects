import { Prisma, systemDb } from "@app/db";
import { INLINE_PAYLOAD_LIMIT, logger, shopifyApps, type WebhookJobData } from "@app/core";
import { randomToken, verifyShopifyWebhookHmac } from "@app/shared";
import { clientIp, type Deps } from "../context.js";
import type { App } from "../app.js";

/**
 * Once a delivery has been recorded (or re-armed) this long, the request that did it is over:
 * Shopify gives up at 5s and the Worker is cancelled with it. Shopify's first retry can come about
 * a second later, so a retry inside this window is answered 503, never 200 (see redelivery).
 */
const REARM_AFTER_MS = 30_000;

/**
 * A retry of a delivery we already recorded. The row is committed before the queue send, so it can
 * exist with nothing behind it: the DB tunnel dropped after the INSERT committed (we answered 500),
 * or Shopify gave up at 5s and the Worker was cancelled before the send. A 200 ends Shopify's
 * retries, so answering one for such a row loses the event for good (uninstall, redact,
 * products/delete: the payload was never stored). Only a consumer touching the row proves it was
 * queued, so:
 *  - touched (running, done, or an attempt counted): a real duplicate;
 *  - untouched for REARM_AFTER_MS: nothing can still be sending it, so it is re-armed and queued
 *    again with this delivery's payload;
 *  - untouched and younger, or gone (its send failed and the row was forgotten): the first attempt
 *    may still be mid-send or may have died, so Shopify is asked to retry. By then a consumer has
 *    touched it, or it is old enough to re-arm.
 *
 * "Untouched" can also be a message still waiting out a DB outage (the consumer fails before
 * counting the attempt), so a re-arm occasionally queues a second copy. That is harmless:
 * processWebhook skips succeeded events and its writes are upserts, and each copy gets its own blob.
 */
async function redelivery(webhookId: string): Promise<"duplicate" | "retry" | { eventId: string }> {
  const ev = await systemDb.webhookEvent.findUnique({
    where: { webhookId },
    select: { id: true, status: true, attempts: true, receivedAt: true },
  });
  if (ev && (ev.status !== "queued" || ev.attempts > 0)) return "duplicate";
  const now = new Date();
  const cutoff = new Date(now.getTime() - REARM_AFTER_MS);
  if (!ev || ev.receivedAt >= cutoff) return "retry";
  // Lease: re-stamping receivedAt makes concurrent retries see a fresh row, so only one re-queues.
  // The others are asked to retry too: if the winner is cut off before its send, the next retry
  // re-arms the row again once the lease has lapsed.
  const { count } = await systemDb.webhookEvent.updateMany({
    where: { id: ev.id, status: "queued", attempts: 0, receivedAt: { lt: cutoff } },
    data: { receivedAt: now },
  });
  return count === 1 ? { eventId: ev.id } : "retry";
}

/**
 * The shop a payload says it is about, lowercased: `shop_domain` on the GDPR topics,
 * `myshopify_domain` on shop objects (app/uninstalled). Null when it names none, which is most topics.
 */
function payloadShop(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as { shop_domain?: unknown; myshopify_domain?: unknown };
  const named = typeof p.shop_domain === "string" ? p.shop_domain : typeof p.myshopify_domain === "string" ? p.myshopify_domain : null;
  return named ? named.toLowerCase() : null;
}

/**
 * Shopify webhook intake. Contract:
 *  - HMAC of the *raw* body is verified before anything else (401 otherwise).
 *  - X-Shopify-Webhook-Id is recorded under a unique constraint, so retries
 *    and duplicate deliveries are processed once. A retry is acknowledged as a
 *    duplicate only once a consumer has picked the delivery up: the row is
 *    written before the queue send, so on its own it proves nothing (see redelivery).
 *  - Work is queued and we answer 200 quickly (Shopify times out at 5s).
 *  - The payload is never stored in Postgres: it rides in the queue message,
 *    or, when too large for a message, in R2 until the job has processed it.
 */
export function webhookRoutes(app: App, deps: Deps) {
  app.post("/webhooks/shopify", async (c) => {
    const raw = await c.req.text();
    const hmac = c.req.header("x-shopify-hmac-sha256");
    // Signed with the secret of whichever of our apps it belongs to.
    const app = shopifyApps().find((a) => verifyShopifyWebhookHmac(raw, hmac, a.clientSecret));
    if (!app) {
      logger.warn({ ip: clientIp(c) }, "webhook rejected: bad hmac");
      return c.json({ error: "invalid_hmac" }, 401);
    }
    const topic = c.req.header("x-shopify-topic") ?? "";
    const shop = (c.req.header("x-shopify-shop-domain") ?? "").toLowerCase();
    const webhookId = c.req.header("x-shopify-webhook-id") ?? c.req.header("x-shopify-event-id") ?? "";
    if (!topic || !shop || !webhookId) return c.json({ error: "missing_headers" }, 400);

    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    // The HMAC covers the body only, so the shop (and topic) headers are unauthenticated. Where
    // the body names its shop - the GDPR topics and app/uninstalled, the ones that delete data or
    // tokens - it must be the shop the headers say, or a signed body could be replayed at another store.
    const claimed = payloadShop(payload);
    if (claimed !== null && claimed !== shop) {
      logger.warn({ topic, shop, claimed, ip: clientIp(c) }, "webhook rejected: payload is for another shop");
      return c.json({ error: "shop_mismatch" }, 401);
    }

    const store = await systemDb.store.findUnique({ where: { shopDomain: shop }, select: { id: true, workspaceId: true } });
    let eventId: string;
    let rearmed = false;
    try {
      const ev = await systemDb.webhookEvent.create({
        data: { webhookId, topic, shopDomain: shop, storeId: store?.id, workspaceId: store?.workspaceId },
      });
      eventId = ev.id;
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
      const seen = await redelivery(webhookId);
      if (seen === "duplicate") return c.json({ ok: true, duplicate: true });
      if (seen === "retry") return c.json({ error: "in_progress" }, 503);
      logger.warn({ webhookId, topic, shop }, "webhook re-queued: an earlier delivery was recorded but never queued");
      eventId = seen.eventId;
      rearmed = true;
    }
    // Shopify retries for up to 48h, so the handler needs to know when the delivery was generated
    // rather than when it arrived. Fall back to now: a missing header must not look ancient.
    const triggeredAt = c.req.header("x-shopify-triggered-at");
    const job: WebhookJobData = {
      eventId,
      topic,
      shop,
      app: app.key,
      triggeredAt: triggeredAt && !Number.isNaN(Date.parse(triggeredAt)) ? triggeredAt : new Date().toISOString(),
    };
    try {
      if (new TextEncoder().encode(raw).byteLength <= INLINE_PAYLOAD_LIMIT) {
        job.payload = payload;
      } else {
        // Unique per send: a re-queued copy must not share a blob the other copy deletes when done.
        job.payloadKey = `webhooks/${eventId}-${randomToken(9)}.json`;
        await deps.payloads.put(job.payloadKey, raw);
      }
      await deps.queues.webhooks.send(job);
    } catch (err) {
      // Forget a delivery this request recorded, so Shopify's retry records it afresh instead of
      // waiting out the re-arm window. Never a re-armed row: an earlier message may still be live
      // behind it (waiting out a DB outage) and would find nothing; its lease lapses and a later
      // retry re-arms it. If the DB is gone too, the row stays and is re-armed the same way.
      if (!rearmed) {
        await systemDb.webhookEvent
          .deleteMany({ where: { id: eventId, status: "queued", attempts: 0 } })
          .catch((e) => logger.warn({ err: e, webhookId }, "could not forget unqueued webhook; its retry will re-arm it"));
      }
      throw err;
    }
    return c.json({ ok: true });
  });
}

import { customEventSchema, safeEqual, verifyMetaSignature } from "@app/shared";
import { env, logger, receiveCustomEvent, recordWebhook, storeForEventKey, waAppSecret } from "@app/core";
import { clientIp, HttpError, type Deps } from "../context.js";
import type { App } from "../app.js";
import { limit, LIMITS } from "../rateLimit.js";

/**
 * WhatsApp Automation's public endpoints, called by machines:
 *  - Meta's webhook (GET: the subscription handshake with bizinsights' verify token; POST: deliveries,
 *    signed with bizinsights' app secret). A signed delivery is stored once and queued, and Meta gets
 *    its 200 at once; the worker applies it (core whatsapp/webhook.ts). Every number is connected
 *    through bizinsights' own app, so its secret vouches for every delivery.
 *  - Custom events from a store's own tools (a booking system, a form, Zapier), with the store's
 *    event key: `Authorization: Bearer whev_...` (WhatsApp Automation → Settings).
 */
export function whatsappWebhookRoutes(app: App, deps: Deps) {
  app.get("/webhooks/whatsapp", async (c) => {
    await limit(deps.coord, `rl:wa-verify:${clientIp(c)}`, LIMITS.waVerifyIp);
    const mode = c.req.query("hub.mode");
    const token = c.req.query("hub.verify_token") ?? "";
    const challenge = c.req.query("hub.challenge") ?? "";
    const ours = env().WHATSAPP_WEBHOOK_VERIFY_TOKEN;
    if (mode !== "subscribe" || !token || !challenge || challenge.length > 200 || !ours || !safeEqual(token, ours)) {
      logger.warn({ ip: clientIp(c) }, "whatsapp webhook verification refused");
      return c.json({ error: "forbidden" }, 403);
    }
    return c.text(challenge, 200, { "content-type": "text/plain" });
  });

  app.post("/webhooks/whatsapp", async (c) => {
    const raw = await c.req.text();
    const secret = waAppSecret();
    if (!secret || !verifyMetaSignature(raw, c.req.header("x-hub-signature-256"), secret)) {
      // Anyone can post here: past a few refusals per address they're answered 429 and no longer logged.
      const n = await deps.coord.hit(`rl:wa-unsigned:${clientIp(c)}`, LIMITS.waUnsignedIp.windowSec).catch(() => 0);
      if (n > LIMITS.waUnsignedIp.max) return c.json({ error: "rate_limited" }, 429, { "retry-after": String(LIMITS.waUnsignedIp.windowSec) });
      if (n <= 5) logger.warn({ ip: clientIp(c), configured: !!secret }, "whatsapp webhook rejected: its signature didn't verify");
      return c.json({ error: "invalid_signature" }, 401);
    }
    const { stored, duplicate } = await recordWebhook(raw, deps);
    if (!stored) return c.json({ ok: true, ignored: true });
    return c.json({ ok: true, ...(duplicate ? { duplicate: true } : {}) });
  });

  /** A custom event, sent with the store's event key. Idempotent per event id. */
  app.post("/whatsapp/events", async (c) => {
    const auth = c.req.header("authorization") ?? "";
    const key = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    const store = key ? await storeForEventKey(key) : null;
    if (!store) {
      await limit(deps.coord, `rl:wa-event-key:${clientIp(c)}`, LIMITS.waEventKeyIp, "Too many attempts with an unknown key.");
      throw new HttpError(401, "Send the store's event key as Authorization: Bearer whev_... (WhatsApp Automation → Settings).", "invalid_key");
    }
    await limit(deps.coord, `rl:wa-events:${store.id}`, LIMITS.waEvents, "Too many events in a minute. Slow down and try again.");
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new HttpError(400, "The body must be JSON.", "invalid_body");
    }
    const event = customEventSchema.parse(raw);
    return c.json(await receiveCustomEvent(deps, { store, event }));
  });
}

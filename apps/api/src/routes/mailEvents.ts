import { applyProviderEvent, env, logger, parseResendEvent, verifyResendWebhook } from "@app/core";
import { clientIp, type Deps } from "../context.js";
import type { App } from "../app.js";
import { limit, LIMITS } from "../rateLimit.js";

/**
 * Delivery events from the app's mail provider (core/mail): Resend posts delivered, delayed,
 * bounced, complained and failed events for every invitation email, signed with the endpoint's
 * secret (Svix). They update the delivery records the team page reads, so "Delivered" and
 * "Bounced" are the provider's own word, never a guess. Unsigned or stale requests are refused;
 * unknown messages are acknowledged (they may be another environment's), so Resend stops retrying.
 */
export function mailEventRoutes(app: App, deps: Deps) {
  app.post("/webhooks/email/resend", async (c) => {
    const secret = env().RESEND_WEBHOOK_SECRET;
    if (!secret) return c.json({ error: "not_configured" }, 404);
    await limit(deps.coord, `rl:mail-events:${clientIp(c)}`, LIMITS.mailEvents, "Too many requests");
    const raw = await c.req.text();
    const ok = verifyResendWebhook(secret, { id: c.req.header("svix-id"), timestamp: c.req.header("svix-timestamp"), signature: c.req.header("svix-signature") }, raw);
    if (!ok) {
      logger.warn({ ip: clientIp(c) }, "mail provider webhook rejected: bad signature");
      return c.json({ error: "invalid_signature" }, 401);
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    const event = parseResendEvent(body);
    if (!event) return c.json({ ok: true, ignored: true });
    const matched = await applyProviderEvent(event);
    logger.info({ provider: event.provider, status: event.status, matched }, "mail delivery event");
    return c.json({ ok: true, matched });
  });
}

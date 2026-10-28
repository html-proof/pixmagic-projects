import { safeEqual, verifyMetaSignature } from "@app/shared";
import { applyMetaWebhook, env, logger, metaApp } from "@app/core";
import { clientIp, type Deps } from "../context.js";
import type { App } from "../app.js";
import { limit, LIMITS } from "../rateLimit.js";

/**
 * WhatsApp Automation's machine endpoint (docs/whatsapp.md, "Webhooks and security"): Meta's webhook,
 * the one source of statuses, customers' messages and template reviews (GET: the subscription
 * handshake with bizinsights' verify token; POST: deliveries signed with bizinsights' Meta app
 * secret, X-Hub-Signature-256, checked before anything is read). Evolution API's webhook went with
 * the service (release 2 of removing it). Machine endpoints answer `{ "error": code }` only; this one
 * is outside the CSRF check and the global per-IP limit (/webhooks/*): it has its own checks and limits.
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
    const secret = metaApp()?.appSecret ?? "";
    if (!secret || !verifyMetaSignature(raw, c.req.header("x-hub-signature-256"), secret)) {
      const n = await deps.coord.hit(`rl:wa-unsigned:${clientIp(c)}`, LIMITS.waUnsignedIp.windowSec).catch(() => 0);
      if (n > LIMITS.waUnsignedIp.max) return c.json({ error: "rate_limited" }, 429, { "retry-after": String(LIMITS.waUnsignedIp.windowSec) });
      if (n <= 5) logger.warn({ ip: clientIp(c), configured: !!secret }, "whatsapp webhook rejected: its signature didn't verify");
      return c.json({ error: "invalid_signature" }, 401);
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return c.json({ error: "invalid_body" }, 400);
    }
    const r = await applyMetaWebhook(deps, body);
    return c.json({ ok: true, ...r });
  });
}

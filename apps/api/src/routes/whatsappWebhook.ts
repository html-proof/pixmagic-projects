import { safeEqual, verifyMetaSignature } from "@app/shared";
import { applyMetaWebhook, env, logger, metaApp, receiveEvolutionWebhook, WEBHOOK_MAX_BYTES } from "@app/core";
import { clientIp, type Deps } from "../context.js";
import type { App } from "../app.js";
import { limit, LIMITS } from "../rateLimit.js";

/**
 * WhatsApp Automation's machine endpoints (docs/whatsapp.md, "Webhooks and security"):
 *  - Meta's webhook, the one source of statuses, customers' messages and template reviews (GET: the
 *    subscription handshake with bizinsights' verify token; POST: deliveries signed with
 *    bizinsights' Meta app secret, X-Hub-Signature-256, checked before anything is read).
 *  - Evolution API's webhook (POST /webhooks/whatsapp/evolution/:instance), until release 2 removes
 *    it: only what a QR-linked phone's instance not yet deleted still posts, customers' replies and
 *    delivery reports, each with an HS256 JWT made from the instance's own key (core whatsapp/webhook.ts).
 * Machine endpoints answer `{ "error": code }` only. Both are outside the CSRF check and the global
 * per-IP limit (/webhooks/*): they have their own checks and limits.
 */
export function whatsappWebhookRoutes(app: App, deps: Deps) {
  app.post("/webhooks/whatsapp/evolution/:instance", async (c) => {
    const raw = await c.req.text();
    if (Buffer.byteLength(raw, "utf8") > WEBHOOK_MAX_BYTES) return c.json({ error: "too_large" }, 413);
    const r = await receiveEvolutionWebhook(deps, { instanceName: c.req.param("instance"), authorization: c.req.header("authorization"), rawBody: raw });
    if (r.status === 401) {
      // Anyone can post here: past a few refusals per address they're answered 429 and no longer logged.
      const n = await deps.coord.hit(`rl:wa-unsigned:${clientIp(c)}`, LIMITS.waUnsignedIp.windowSec).catch(() => 0);
      if (n > LIMITS.waUnsignedIp.max) return c.json({ error: "rate_limited" }, 429, { "retry-after": String(LIMITS.waUnsignedIp.windowSec) });
      return c.json({ error: "unauthenticated" }, 401);
    }
    if (r.status !== 200) return c.json({ error: r.outcome }, r.status, r.status === 429 ? { "retry-after": "30" } : undefined);
    return c.json({ ok: true, outcome: r.outcome });
  });

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

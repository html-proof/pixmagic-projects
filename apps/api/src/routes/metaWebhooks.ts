import { env, logger, META_SIGNED_REQUEST_MAX_AGE_S, metaDataDeletion, metaDataDeletionStatus, metaDeauthorized, verifyMetaSignedRequest } from "@app/core";
import { sha256Hex } from "@app/shared";
import { clientIp, type Ctx, type Deps } from "../context.js";
import type { App } from "../app.js";
import { limit, LIMITS } from "../rateLimit.js";

/**
 * Meta's callbacks for bizinsights' ads app, server to server: the person removed bizinsights in their
 * Facebook settings (deauthorize), or asked Facebook for their data to be deleted. Registered in the
 * Meta app (Facebook Login for Business → Settings → Deauthorize callback URL; App settings → Basic →
 * Data deletion request URL) as <API_URL>/webhooks/meta/deauthorize and .../data-deletion.
 *
 * Each is a form POST whose `signed_request` is verified with META_APP_SECRET before anything is done
 * (core adConnections/metaCallbacks.ts), and is never logged: it names the person. Machine endpoints:
 * they answer `{ error: code }` only. /webhooks/* carries no cookie, so the CSRF check passes it by, and
 * is outside the global per-IP limit (app.ts): nothing is read or written for a request that fails the
 * signature, which takes the app secret to make. Refusals are limited per IP (LIMITS.metaCallbackRefusedIp;
 * past it they are answered 429 and no longer logged), and a signed request is acted on once: sent
 * again while it is still valid, it gets the first answer back (a replay can't pile up records).
 */
export function metaWebhookRoutes(app: App, deps: Deps) {
  /** The person a callback is about (and the request's fingerprint), or the answer that refuses it. */
  async function signedBy(c: Ctx): Promise<{ userId: string; seenKey: string } | { refused: Response }> {
    const secret = env().META_APP_SECRET;
    if (!secret) return { refused: c.json({ error: "not_configured" }, 503) };
    const form = await c.req.parseBody().catch((): Record<string, unknown> => ({}));
    const verified = verifyMetaSignedRequest(form.signed_request, secret);
    if (!verified) {
      const ip = clientIp(c);
      const n = await deps.coord.hit(`rl:meta-cb:${ip ?? "unknown"}`, LIMITS.metaCallbackRefusedIp.windowSec).catch(() => 0);
      if (n > LIMITS.metaCallbackRefusedIp.max) return { refused: c.json({ error: "rate_limited" }, 429, { "retry-after": String(LIMITS.metaCallbackRefusedIp.windowSec) }) };
      logger.warn({ ip, path: c.req.path }, "meta callback rejected: its signed_request didn't verify");
      return { refused: c.json({ error: "invalid_signature" }, 401) };
    }
    // Only a hash of it is kept, by which callback it came to.
    const kind = c.req.path.endsWith("/deauthorize") ? "deauthorize" : "data-deletion";
    return { userId: verified.userId, seenKey: `meta-cb-seen:${kind}:${sha256Hex(String(form.signed_request))}` };
  }

  /** Deauthorize: their Meta ad connections wait for a reconnect now, not at their next sync. */
  app.post("/webhooks/meta/deauthorize", async (c) => {
    const who = await signedBy(c);
    if ("refused" in who) return who.refused;
    if (await deps.coord.peek(who.seenKey).catch(() => null)) return c.json({ ok: true });
    await metaDeauthorized(who.userId, deps.coord);
    await deps.coord.put(who.seenKey, "1", META_SIGNED_REQUEST_MAX_AGE_S).catch(() => undefined);
    return c.json({ ok: true });
  });

  /**
   * Data deletion: their Meta ad connections and every figure fetched for them are deleted, and Meta is
   * given where the person can see the request's status, with its confirmation code (the /data-deletion
   * page reads ?code= through the status route below). The same request sent again gets the same code.
   */
  app.post("/webhooks/meta/data-deletion", async (c) => {
    const who = await signedBy(c);
    if ("refused" in who) return who.refused;
    const seen = await deps.coord.peek(who.seenKey).catch(() => null);
    const confirmationCode = seen && /^[a-f0-9]{20}$/.test(seen) ? seen : (await metaDataDeletion(who.userId, deps.coord)).confirmationCode;
    if (!seen) await deps.coord.put(who.seenKey, confirmationCode, META_SIGNED_REQUEST_MAX_AGE_S).catch(() => undefined);
    return c.json({ url: `${env().APP_URL}/data-deletion?${new URLSearchParams({ code: confirmationCode })}`, confirmation_code: confirmationCode });
  });

  /** Where a data deletion request stands, for the /data-deletion page: "done" (and when), or "unknown". */
  app.get("/meta/data-deletion/:code", async (c) => {
    await limit(deps.coord, `rl:meta-deletion:${clientIp(c)}`, LIMITS.metaDeletionStatusIp);
    return c.json(await metaDataDeletionStatus(c.req.param("code")));
  });
}

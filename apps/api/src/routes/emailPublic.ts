import { applyUnsubscribe, authenticateIngestKey, describeUnsubscribe, ingestCustomEvent } from "@app/core";
import { ingestEventSchema } from "@app/shared/email";
import { body, clientIp, HttpError, type Ctx, type Deps } from "../context.js";
import type { App } from "../app.js";
import { limit, LIMITS } from "../rateLimit.js";

/**
 * The email module's public endpoints:
 *
 *  - POST /v1/events (and /v1/events/ingest): a business event from the customer's own systems,
 *    authorized by an event key (`Authorization: Bearer ek_live_...`). The key decides the
 *    workspace; nothing in the request can name another. Re-sending an id is a no-op.
 *  - /email/unsubscribe/:token: the unsubscribe page's lookup and confirmation, and the RFC 8058
 *    one-click POST mail providers send. The token is signed and names no address.
 */
export function emailPublicRoutes(app: App, deps: Deps) {
  const ingest = async (c: Ctx) => {
    await limit(deps.coord, `rl:email:ingest:ip:${clientIp(c)}`, LIMITS.emailIngestIp);
    const auth = c.req.header("authorization") ?? "";
    const key = auth.startsWith("Bearer ") ? await authenticateIngestKey(auth.slice(7).trim()) : null;
    if (!key) throw new HttpError(401, "A valid event API key is required (Authorization: Bearer ek_live_…)", "unauthenticated");
    await limit(deps.coord, `rl:email:ingest:key:${key.keyId}`, LIMITS.emailIngestKey);
    const raw = await body(c);
    if (JSON.stringify(raw).length > 32 * 1024) throw new HttpError(413, "An event can be at most 32 KB", "too_large");
    const input = ingestEventSchema.parse(raw);
    const r = await ingestCustomEvent(key.workspaceId, input, deps);
    return c.json({ id: input.id, accepted: !r.duplicate, duplicate: r.duplicate, automations: r.listening }, r.duplicate ? 200 : 202);
  };
  app.post("/v1/events", ingest);
  app.post("/v1/events/ingest", ingest);

  app.get("/email/unsubscribe/:token", async (c) => {
    await limit(deps.coord, `rl:email:unsub:${clientIp(c)}`, LIMITS.emailUnsubscribeIp);
    return c.json(await describeUnsubscribe(c.req.param("token")));
  });

  /** The page's "Unsubscribe" button, and mail providers' one-click POST (List-Unsubscribe=One-Click). */
  app.post("/email/unsubscribe/:token", async (c) => {
    await limit(deps.coord, `rl:email:unsub:${clientIp(c)}`, LIMITS.emailUnsubscribeIp);
    const oneClick = (c.req.header("content-type") ?? "").includes("application/x-www-form-urlencoded");
    return c.json(await applyUnsubscribe(c.req.param("token"), oneClick ? "one_click" : "unsubscribe_link"));
  });
}

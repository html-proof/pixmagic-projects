import { z } from "zod";
import { applyOptOut, describeOptOut } from "@app/core/sms";
import { body, clientIp, HttpError, type Deps } from "../context.js";
import type { App } from "../app.js";
import { limit, LIMITS } from "../rateLimit.js";

/**
 * The opt-out link in marketing texts lands on the /stop page (apps/web), which reads and confirms
 * through these. A code is ~59 random bits and only its SHA-256 is stored; nothing changes until
 * the person confirms, so a link preview can't opt anyone out. Answers never include the number in
 * full, only masked.
 */
export function smsPublicRoutes(app: App, deps: Deps) {
  app.get("/sms/u/:code", async (c) => {
    await limit(deps.coord, `rl:sms-stop:${clientIp(c)}`, LIMITS.smsOptOutIp);
    const info = await describeOptOut(c.req.param("code"));
    if (!info) throw new HttpError(404, "This link isn't valid any more. Reply STOP to the text, or contact the store.", "not_found");
    return c.json(info);
  });

  app.post("/sms/u/:code", async (c) => {
    await limit(deps.coord, `rl:sms-stop:${clientIp(c)}`, LIMITS.smsOptOutIp);
    const input = z.object({ scope: z.enum(["marketing", "all"]).default("marketing") }).parse(await body(c));
    if (!(await applyOptOut(c.req.param("code"), input.scope))) throw new HttpError(404, "This link isn't valid any more. Reply STOP to the text, or contact the store.", "not_found");
    return c.json({ ok: true, ...(await describeOptOut(c.req.param("code"))) });
  });
}

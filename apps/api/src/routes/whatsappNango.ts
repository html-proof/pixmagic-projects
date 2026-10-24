import { z } from "zod";
import {
  AdsApiError,
  AdsAuthError,
  AdsRateLimitedError,
  AdsRetryableError,
  discoverWhatsapp,
  holdWhatsappToken,
  isNangoConnectionId,
  logger,
  nangoConfig,
  startWhatsappNangoSession,
  takeWhatsappNangoToken,
  whatsappNangoReady,
} from "@app/core";
import { randomToken } from "@app/shared";
import { body, HttpError, requireWorkspace, type Deps } from "../context.js";
import type { App } from "../app.js";
import { limit, LIMITS } from "../rateLimit.js";
import { base, connectError, waStore } from "./whatsappCommon.js";

/**
 * "Add your token" in Nango's window (docs/whatsapp.md "Through Nango", core whatsapp/nango.ts): the
 * manual connect's first step, with the access token pasted into Nango's Connect UI instead of
 * bizinsights' own box. The finish answers what /manual/discover does, plus a handle that
 * /manual/discover and /manual take in place of the token; the browser never holds the token itself.
 */

const nonceSchema = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);
/** A held token's handle (holdWhatsappToken): what the page sends in place of the token. */
export const tokenHandleSchema = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/, "isn't a token from Nango's window");

const notConfigured = () => new HttpError(503, "Adding the token through Nango isn't available right now. Paste it in the box instead.", "not_configured");

/** A failure of Nango's own, as the HTTP answer the page words. */
function nangoFailure(err: unknown): never {
  if (err instanceof AdsRateLimitedError) throw new HttpError(429, "Nango asked bizinsights to slow down. Try again in a few minutes.", "rate_limited", 300);
  if (err instanceof AdsRetryableError) throw new HttpError(503, "Nango didn't answer. Try again in a minute.", "nango_busy", 60);
  if (err instanceof AdsAuthError) throw new HttpError(409, "Nango no longer has that token. Press Add your token and paste it again.", "state_mismatch");
  if (err instanceof AdsApiError) {
    logger.error({ err }, "whatsapp: nango refused bizinsights' request");
    throw notConfigured();
  }
  throw err;
}

export function whatsappNangoRoutes(app: App, deps: Deps) {
  /** Step 1: a Connect UI session for the WhatsApp integration (Nango's token, 30 minutes); `nonce` comes back with the finish. */
  app.post(`${base}/nango/session`, async (c) => {
    const { ws, storeId } = c.req.param();
    const access = await requireWorkspace(c, deps, ws, "integrations.manage");
    await waStore(ws, storeId);
    await limit(deps.coord, `rl:wa-connect:${storeId}`, LIMITS.waConnect);
    const cfg = nangoConfig(deps.fetchImpl);
    if (!cfg || !(await whatsappNangoReady(deps.coord, deps.fetchImpl))) throw notConfigured();
    const nonce = randomToken(24);
    const session = await startWhatsappNangoSession(deps.coord, cfg, nonce, { userId: access.user!.id, workspaceId: ws, storeId }).catch(nangoFailure);
    return c.json({ token: session.token, expiresAt: session.expiresAt, nonce });
  });

  /**
   * Step 2: the Connect UI said the token was saved (`connectionId`). The token is read from Nango (the
   * connection deleted there), the numbers it reaches are found, and it is held for the rest of the connect.
   */
  app.post(`${base}/nango/finish`, async (c) => {
    const { ws, storeId } = c.req.param();
    const access = await requireWorkspace(c, deps, ws, "integrations.manage");
    await waStore(ws, storeId);
    await limit(deps.coord, `rl:wa-connect:${storeId}`, LIMITS.waConnect);
    const input = z.object({ nonce: nonceSchema, connectionId: z.string().refine(isNangoConnectionId, "not a Nango connection id") }).parse(await body(c));
    const cfg = nangoConfig(deps.fetchImpl);
    if (!cfg) throw notConfigured();
    const who = { userId: access.user!.id, workspaceId: ws, storeId };
    const token = await takeWhatsappNangoToken(deps.coord, cfg, input.nonce, input.connectionId, who).catch(nangoFailure);
    const found = await discoverWhatsapp(token, deps.fetchImpl).catch(connectError);
    return c.json({ ...found, tokenHandle: await holdWhatsappToken(deps.coord, who, token) });
  });
}

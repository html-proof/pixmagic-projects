import { z } from "zod";
import { systemDb, type ZapierGrant } from "@app/db";
import { addLogContext, logger } from "@app/core";
import {
  authenticateZapierToken,
  disconnectZapier,
  findAdPerformance,
  findAdsenseEarnings,
  hookInputSchema,
  retryZapierDelivery,
  subscribeZapierHook,
  unsubscribeZapierHook,
  zapierConfig,
  zapierOverview,
  zapierSamples,
  type AuthorizerAccess,
} from "@app/core/zapier";
import { addDays, allows, hasFullAccess, isDay, localDay } from "@app/shared";
import { isZapierEvent, ZAPIER_ACCESS_PREFIX, ZAPIER_SPEND_PLATFORMS } from "@app/shared/zapier";
import { body, clientIp, HttpError, requireWorkspace, type Ctx, type Deps } from "../context.js";
import type { App } from "../app.js";
import { limit, LIMITS } from "../rateLimit.js";

/**
 * Zapier's API (/api/zapier/*, docs/zapier.md): what bizinsights' Zapier app calls with the access
 * token of a connection (Authorization: Bearer zat_…). Nothing else gets in here: no session cookie,
 * no shared link, no workspace API key (sk_); and a zat_ token opens nothing outside /zapier (every
 * other route reads cookies or sk_ keys only). Each request re-checks the member who connected it
 * (authenticateZapierToken): one who left, lost "Manage integrations" or whose access ended gets 401,
 * so Zapier asks for the connection again. The store is the connection's: no route takes one.
 *
 * And Settings → Integrations' Zapier card (/workspaces/:ws/stores/:storeId/zapier): the store's
 * connections, triggers and recent deliveries; Disconnect; Retry a failed delivery (owners and admins).
 */

interface ZapierCtx {
  grant: ZapierGrant;
  who: AuthorizerAccess;
}

const UNAUTHORIZED = "Connect bizinsights to Zapier again: this connection is no longer valid.";
const NO_ACCESS = "The person who connected bizinsights can no longer manage this store's integrations. Connect bizinsights again (someone with \"Manage integrations\").";

/** The connection a Zapier request is made with. Only a bearer zat_ token counts: cookies are never read here. */
async function requireZapier(c: Ctx, deps: Deps): Promise<ZapierCtx> {
  const authz = c.req.header("authorization") ?? "";
  const token = authz.startsWith("Bearer ") ? authz.slice(7).trim() : "";
  if (!token.startsWith(ZAPIER_ACCESS_PREFIX)) {
    c.header("www-authenticate", 'Bearer realm="bizinsights"');
    throw new HttpError(401, "Sign in required: connect bizinsights in Zapier.", "unauthenticated");
  }
  const check = await authenticateZapierToken(token);
  if (!check.ok) {
    // Only tokens bizinsights never issued count: an expired one is Zapier's every-hour refresh, from
    // the few addresses it calls every merchant's connections from.
    if (check.reason === "unknown_token") await limit(deps.coord, `rl:zapier:bad-token:${clientIp(c)}`, LIMITS.zapierBadTokenIp);
    c.header("www-authenticate", 'Bearer realm="bizinsights", error="invalid_token"');
    throw new HttpError(401, check.reason === "no_access" ? NO_ACCESS : UNAUTHORIZED, "invalid_token");
  }
  // A connection made before the settings were taken away: it stands, but Zapier is switched off.
  if (!zapierConfig().configured) throw new HttpError(503, "Zapier isn't set up for bizinsights yet.", "not_configured");
  await limit(deps.coord, `rl:zapier:api:${check.grant.id}`, LIMITS.zapierApi, "Too many requests from Zapier for this connection. Zapier will try again.");
  addLogContext({ workspaceId: check.grant.workspaceId, zapierGrantId: check.grant.id });
  return { grant: check.grant, who: check.who };
}

const searchRange = z.object({ since: z.string().optional(), until: z.string().optional() });

/** A search's dates: both days, in order, at most 400 days apart; by default the last 7 days to yesterday (the store's calendar). */
function rangeOf(q: z.infer<typeof searchRange>, timeZone: string): { since: string; until: string } {
  const yesterday = addDays(localDay(new Date(), timeZone), -1);
  const until = q.until ? q.until.slice(0, 10) : yesterday;
  const since = q.since ? q.since.slice(0, 10) : addDays(until, -6);
  if (!isDay(since) || !isDay(until)) throw new HttpError(400, "Dates must be written YYYY-MM-DD.", "validation");
  if (since > until) throw new HttpError(400, "The start date is after the end date.", "validation");
  if (addDays(since, 400) < until) throw new HttpError(400, "Choose at most 400 days.", "validation");
  return { since, until };
}

function requireAds(zc: ZapierCtx) {
  if (!allows(zc.who.access, "marketing.ads")) {
    throw new HttpError(403, "The person who connected bizinsights can't see advertising figures in this workspace. An owner or admin can give them \"View advertising analytics\" in Team & Access.", "no_permission");
  }
}

export function zapierRoutes(app: App, deps: Deps) {
  // ---------------- Zapier's own calls (bearer token) ----------------

  /** The connection test, and its label in Zapier: which store this is. */
  app.get("/zapier/me", async (c) => {
    const zc = await requireZapier(c, deps);
    const [workspace, user] = await Promise.all([
      systemDb.workspace.findUnique({ where: { id: zc.grant.workspaceId }, select: { id: true, name: true } }),
      systemDb.user.findUnique({ where: { id: zc.grant.userId }, select: { email: true } }),
    ]);
    const storeName = zc.who.store.name ?? zc.who.store.shopDomain;
    return c.json({
      workspace: { id: zc.grant.workspaceId, name: workspace?.name ?? null },
      store: { id: zc.who.store.id, name: storeName, shop_domain: zc.who.store.shopDomain, currency: zc.who.store.currency, timezone: zc.who.store.timezone },
      connected_by: user?.email ?? null,
      label: `${storeName} (${workspace?.name ?? "bizinsights"})`,
    });
  });

  /** A Zap turned on: subscribe its trigger (REST hook). */
  app.post("/zapier/hooks", async (c) => {
    const zc = await requireZapier(c, deps);
    const input = hookInputSchema.parse(await body(c));
    const hook = await subscribeZapierHook(zc.grant, zc.who, input);
    return c.json({ id: hook.id, event: hook.event }, 201);
  });

  /** A Zap turned off or deleted: unsubscribe its trigger. Only this connection's triggers are found. */
  app.delete("/zapier/hooks/:id", async (c) => {
    const zc = await requireZapier(c, deps);
    if (!(await unsubscribeZapierHook(zc.grant, c.req.param("id")))) throw new HttpError(404, "Not found", "not_found");
    return c.json({ ok: true });
  });

  /** A trigger's samples while the Zap is set up: the store's last few real events, or none. */
  app.get("/zapier/samples/:event", async (c) => {
    const zc = await requireZapier(c, deps);
    const event = c.req.param("event");
    if (!isZapierEvent(event)) throw new HttpError(404, "Not found", "not_found");
    return c.json(await zapierSamples(zc.grant, zc.who, event));
  });

  /** "Find ad performance": the store's stored Meta and Google Ads figures for the dates. */
  app.get("/zapier/search/ad-performance", async (c) => {
    const zc = await requireZapier(c, deps);
    requireAds(zc);
    const q = searchRange.extend({ platform: z.enum(ZAPIER_SPEND_PLATFORMS).default("any") }).parse(c.req.query());
    const { since, until } = rangeOf(q, zc.who.store.timezone);
    return c.json(await findAdPerformance(zc.grant.storeId, q.platform, since, until));
  });

  /** "Find AdSense earnings": the store's estimated AdSense earnings for the dates. */
  app.get("/zapier/search/adsense-earnings", async (c) => {
    const zc = await requireZapier(c, deps);
    requireAds(zc);
    const { since, until } = rangeOf(searchRange.parse(c.req.query()), zc.who.store.timezone);
    return c.json(await findAdsenseEarnings(zc.grant.storeId, since, until));
  });

  // ---------------- Settings → Integrations (the member's session) ----------------

  const base = "/workspaces/:ws/stores/:storeId/zapier";

  async function storeIn(ws: string, storeId: string) {
    const store = await systemDb.store.findFirst({ where: { id: storeId, workspaceId: ws, status: { not: "uninstalled" } }, select: { id: true } });
    if (!store) throw new HttpError(404, "Not found", "not_found");
    return store;
  }

  app.get(base, async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, "integrations.status");
    await storeIn(ws, storeId);
    // Which settings are set (never their values): owners and admins, who set the platform up.
    return c.json(await zapierOverview(ws, storeId, { setup: hasFullAccess(a.access.role) && !a.link }));
  });

  app.delete(`${base}/connections/:grantId`, async (c) => {
    const { ws, storeId, grantId } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, "integrations.manage");
    if (!a.user || a.link) throw new HttpError(403, "Sign in to your own account to disconnect Zapier.", "forbidden");
    await storeIn(ws, storeId);
    await limit(deps.coord, `rl:zapier:manage:${ws}`, LIMITS.zapierManage);
    if (!(await disconnectZapier(ws, storeId, grantId, { userId: a.user.id, ip: clientIp(c) }))) throw new HttpError(404, "Not found", "not_found");
    logger.info({ workspaceId: ws, storeId, grantId }, "zapier disconnected from settings");
    return c.json({ ok: true });
  });

  /** Retry: send a failed delivery again. Owners and admins, who get the alert about it. */
  app.post(`${base}/deliveries/:deliveryId/retry`, async (c) => {
    const { ws, storeId, deliveryId } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, "integrations.manage");
    if (!a.user || a.link) throw new HttpError(403, "Sign in to your own account to send an event again.", "forbidden");
    if (!hasFullAccess(a.access.role)) throw new HttpError(403, "Only owners and admins can send an event to Zapier again.", "forbidden");
    await storeIn(ws, storeId);
    await limit(deps.coord, `rl:zapier:manage:${ws}`, LIMITS.zapierManage);
    const outcome = await retryZapierDelivery(ws, storeId, deliveryId, deps.queues, { userId: a.user.id, ip: clientIp(c) });
    if (outcome === "not_found") throw new HttpError(404, "Not found", "not_found");
    if (outcome === "not_failed") throw new HttpError(409, "Only an event that failed can be sent again: this one was sent, or is being sent.", "not_failed");
    if (outcome === "trigger_gone") throw new HttpError(409, "The Zap's trigger is gone (the Zap was turned off, or Zapier disconnected), so there is nowhere to send it. Turn the Zap on again in Zapier.", "trigger_gone");
    logger.info({ workspaceId: ws, storeId, deliveryId }, "zapier delivery sent again from settings");
    return c.json({ ok: true });
  });
}

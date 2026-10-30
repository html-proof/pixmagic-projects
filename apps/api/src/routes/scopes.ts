import { z } from "zod";
import { systemDb, withTenant, type Store } from "@app/db";
import {
  audit,
  declaredScopes,
  fetchGrantedScopes,
  getAccessToken,
  logger,
  optionalScopeGrantUrl,
  optionalScopesFor,
  requestableScopes,
  revocableOptionalScopesFor,
  revocableScopes,
  revokeAccessScopes,
  ScopeRevokeError,
  seedScopeFollowUp,
  shopifyApp,
  StoreDisconnectedError,
} from "@app/core";
import { resolveCapabilities, scopesForModule, type ModuleId } from "@app/shared";
import { body, clientIp, HttpError, requireWorkspace, type Deps } from "../context.js";
import type { App } from "../app.js";
import { limit, LIMITS } from "../rateLimit.js";

/**
 * Dynamic (optional) scope requests: how a merchant unlocks a module whose scopes weren't part
 * of the install grant, and how the app gives one back. Three endpoints, because Shopify's
 * request URL gives nothing back:
 *
 *   POST .../scopes/request  → the URL to send the merchant to
 *   POST .../scopes/refresh  → ask Shopify what they actually granted, and act on it
 *   POST .../scopes/revoke   → hand an optional scope back (`appRevokeAccessScopes`)
 *
 * The request URL carries no `state` and no `redirect_uri`, and returns no code (see
 * `optionalScopeGrantUrl`). So `request` is not half of a handshake — nothing is held open
 * waiting for a callback, and a merchant who abandons the Shopify screen leaves nothing behind.
 * The grant is learned afterwards, from `app/scopes_update` or from `refresh`.
 *
 * All three are deliberately available while `SHOPIFY_OPTIONAL_SCOPES` is empty — the state the
 * app ships in today — and `request` and `revoke` then refuse with `scope_unavailable` instead
 * of building a URL Shopify would reject or asking it to revoke something it considers part of
 * the install grant (see docs/shopify-setup.md "Optional scopes").
 */

const requestSchema = z.object({
  /** Either an explicit scope list, or a module id whose scopes we look up. */
  scopes: z.array(z.string().regex(/^[a-z_]{1,64}$/)).max(10).optional(),
  module: z.string().max(40).optional(),
});

/** The store, or 404. Uninstalled stores have no token and no installation to ask about. */
async function liveStore(ws: string, storeId: string): Promise<Store> {
  const store = await withTenant(ws, (tx) =>
    tx.store.findFirst({ where: { id: storeId, workspaceId: ws, status: { not: "uninstalled" } } }),
  );
  if (!store) throw new HttpError(404, "Not found", "not_found");
  return store;
}

/**
 * Reconcile `grantedScopes` with Shopify and queue whatever the new scopes make possible.
 * Returns the stored scopes afterwards plus the ones that are new to us.
 *
 * Shared by `refresh` and used after a grant: the stored list is only ever a cache of what
 * Shopify says, and an optional scope changes it long after the token was issued.
 */
async function reconcileScopes(
  deps: Deps,
  store: Store,
  via: "refresh" | "revoke" = "refresh",
): Promise<{ scopes: string[]; newlyGranted: string[] }> {
  const token = await getAccessToken(store, deps.coord, deps.fetchImpl);
  const scopes = await fetchGrantedScopes({
    shop: store.shopDomain,
    accessToken: token,
    fetchImpl: deps.fetchImpl,
  });
  const newlyGranted = scopes.filter((s) => !store.grantedScopes.includes(s));
  const revoked = store.grantedScopes.filter((s) => !scopes.includes(s));
  if (newlyGranted.length || revoked.length) {
    await systemDb.store.update({ where: { id: store.id }, data: { grantedScopes: scopes } });
    await audit({
      workspaceId: store.workspaceId,
      action: "store.scopes_updated",
      targetType: "store",
      targetId: store.id,
      metadata: { current: scopes, granted: newlyGranted, revoked, via },
    });
    logger.info(
      { event: "shopify_scopes_reconciled", shop: store.shopDomain, granted: newlyGranted, revoked, via },
      "granted scopes changed",
    );
  }
  if (newlyGranted.length) await seedScopeFollowUp(deps, store, newlyGranted);
  return { scopes, newlyGranted };
}

export function scopeRoutes(app: App, deps: Deps) {
  /**
   * Step 1: where to send the merchant to be asked for the scopes a module needs.
   *
   * Answers 409 `scope_unavailable` rather than a URL when the scopes aren't declared as
   * optional in the deployed app config — which is also the state the app ships in. A URL built
   * anyway would put the merchant on a Shopify error page, and they would reasonably read that
   * as the app being broken.
   */
  app.post("/workspaces/:ws/stores/:storeId/scopes/request", async (c) => {
    const { ws, storeId } = c.req.param();
    const access = await requireWorkspace(c, deps, ws, "stores:manage");
    const store = await liveStore(ws, storeId);
    const input = requestSchema.parse(await body(c));

    const wanted = input.scopes ?? (input.module ? scopesForModule(input.module as ModuleId) : []);
    if (!wanted.length) throw new HttpError(400, "Say which scopes to request", "invalid_scopes");

    // What the store's own app declares: an App Store app may declare less than the others.
    const optional = optionalScopesFor(store);
    const ask = requestableScopes(wanted, store.grantedScopes, optional);
    if (!ask.length) {
      // Either the store already has them (nothing to do) or we may not ask for them at all.
      const declared = new Set(optional);
      if (wanted.every((s) => !declared.has(s))) {
        throw new HttpError(
          409,
          "This feature isn't available yet. We're waiting on Shopify to approve our access to that data.",
          "scope_unavailable",
        );
      }
      return c.json({ url: null, alreadyGranted: true, scopes: store.grantedScopes });
    }

    const url = optionalScopeGrantUrl(shopifyApp(store.shopifyAppKey).clientId, store.shopDomain, ask);
    await audit({
      workspaceId: ws,
      actorUserId: access.user?.id,
      action: "store.scopes_requested",
      targetType: "store",
      targetId: storeId,
      metadata: { scopes: ask },
      ip: clientIp(c),
    });
    // Pairs with `shopify_scopes_reconciled` the way install handoffs pair with returns: a
    // request with no later grant is a merchant who said no, or never finished.
    logger.info(
      { event: "shopify_scope_request", shop: store.shopDomain, app: store.shopifyAppKey, scopes: ask },
      "sending merchant to Shopify for optional scopes",
    );
    return c.json({ url, scopes: ask });
  });

  /**
   * Step 2: the merchant is back — ask Shopify what they granted.
   *
   * `app/scopes_update` reports the same thing and usually arrives first, so this is belt and
   * braces for the case that matters most: the merchant is looking at the page right now,
   * having just approved, and a webhook that is late or lost would leave the module they just
   * paid attention to still showing as locked.
   *
   * Rate limited per store: it is one Shopify call per invocation, and the web app calls it on
   * returning from the grant screen, which a merchant can reload.
   */
  app.post("/workspaces/:ws/stores/:storeId/scopes/refresh", async (c) => {
    const { ws, storeId } = c.req.param();
    await requireWorkspace(c, deps, ws, "stores:manage");
    const store = await liveStore(ws, storeId);
    await limit(deps.coord, `rl:scopes:${store.id}`, LIMITS.scopes, "Give us a moment and try again.", "too_soon");

    let result;
    try {
      result = await reconcileScopes(deps, store);
    } catch (err) {
      if (err instanceof StoreDisconnectedError) throw new HttpError(409, "This store is not connected", "store_disconnected");
      logger.error({ err, shop: store.shopDomain }, "granted scope refresh failed");
      throw new HttpError(502, "Shopify didn't answer. Try again in a moment.", "shopify_unavailable");
    }

    const fresh = await systemDb.store.findUniqueOrThrow({ where: { id: store.id } });
    return c.json({
      scopes: result.scopes,
      granted: result.newlyGranted,
      capabilities: resolveCapabilities(result.scopes, {
        pixelInstalled: fresh.pixelInstalled,
        optionalScopes: optionalScopesFor(store),
        declaredScopes: declaredScopes(),
      }),
    });
  });

  /**
   * Give an optional scope back: the app should hold only what it currently uses, so that a
   * leaked token can do less.
   *
   * Nothing goes through the merchant here — unlike a request, a revoke is the app's own call
   * and takes effect immediately. Only scopes declared optional *and* currently granted are
   * sent on (`revocableScopes`); anything else is refused here rather than at Shopify, since a
   * required scope can only be given up by uninstalling. Optional means what the store's own
   * app declares (`revocableOptionalScopesFor`), not only what it is still offered: a scope the
   * owner stopped offering stays the merchant's to give back.
   *
   * The stored scopes are then reconciled from Shopify rather than edited locally, for the same
   * reason `refresh` exists: `grantedScopes` is a cache, and the authoritative answer is one
   * call away. That also records the change in the audit log once, in the usual shape.
   */
  app.post("/workspaces/:ws/stores/:storeId/scopes/revoke", async (c) => {
    const { ws, storeId } = c.req.param();
    const access = await requireWorkspace(c, deps, ws, "stores:manage");
    const store = await liveStore(ws, storeId);
    const input = requestSchema.parse(await body(c));

    const wanted = input.scopes ?? (input.module ? scopesForModule(input.module as ModuleId) : []);
    if (!wanted.length) throw new HttpError(400, "Say which scopes to revoke", "invalid_scopes");

    const optional = revocableOptionalScopesFor(store);
    const give = revocableScopes(wanted, store.grantedScopes, optional);
    if (!give.length) {
      // Either the store doesn't have them (nothing to do) or they aren't ours to revoke.
      const declared = new Set(optional);
      if (wanted.every((s) => !declared.has(s))) {
        throw new HttpError(
          409,
          "Those permissions aren't optional, so they can't be given up without uninstalling the app.",
          "scope_unavailable",
        );
      }
      return c.json({ revoked: [], alreadyRevoked: true, scopes: store.grantedScopes });
    }

    await limit(deps.coord, `rl:scopes:${store.id}`, LIMITS.scopes, "Give us a moment and try again.", "too_soon");

    let revoked: string[];
    try {
      const token = await getAccessToken(store, deps.coord, deps.fetchImpl);
      revoked = await revokeAccessScopes({
        shop: store.shopDomain,
        accessToken: token,
        scopes: give,
        fetchImpl: deps.fetchImpl,
      });
    } catch (err) {
      if (err instanceof StoreDisconnectedError) throw new HttpError(409, "This store is not connected", "store_disconnected");
      // Shopify answered, and said no. That is the caller's problem to see, not a 502.
      if (err instanceof ScopeRevokeError) throw new HttpError(409, err.message, "scope_not_revocable");
      logger.error({ err, shop: store.shopDomain, scopes: give }, "scope revoke failed");
      throw new HttpError(502, "Shopify didn't answer. Try again in a moment.", "shopify_unavailable");
    }

    await audit({
      workspaceId: ws,
      actorUserId: access.user?.id,
      action: "store.scopes_revoked",
      targetType: "store",
      targetId: storeId,
      metadata: { scopes: revoked, requested: give },
      ip: clientIp(c),
    });
    logger.info(
      { event: "shopify_scopes_revoked", shop: store.shopDomain, app: store.shopifyAppKey, scopes: revoked },
      "gave optional scopes back to Shopify",
    );

    /**
     * The revoke has already happened at Shopify, so a reconcile that fails must not be reported
     * as a failed revoke — the caller would retry something that is already done. Fall back to
     * the next best answer, what Shopify said it took away, and let `app/scopes_update` or the
     * next refresh settle the cache. Leaving the stored scopes alone is the one thing we must not
     * do: the dashboard would keep offering a module whose scope the token no longer has.
     */
    let scopes: string[];
    try {
      scopes = (await reconcileScopes(deps, store, "revoke")).scopes;
    } catch (err) {
      logger.warn({ err, shop: store.shopDomain, scopes: revoked }, "scopes revoked but the reconcile failed");
      scopes = store.grantedScopes.filter((s) => !revoked.includes(s));
      await systemDb.store.update({ where: { id: store.id }, data: { grantedScopes: scopes } });
    }

    const fresh = await systemDb.store.findUniqueOrThrow({ where: { id: store.id } });
    return c.json({
      revoked,
      scopes,
      capabilities: resolveCapabilities(scopes, {
        pixelInstalled: fresh.pixelInstalled,
        optionalScopes: optionalScopesFor(store),
        declaredScopes: declaredScopes(),
      }),
    });
  });
}

import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { systemDb } from "@app/db";
import {
  appForShop,
  buildAuthorizeUrl,
  DEFAULT_APP,
  env,
  exchangeCodeForToken,
  logger,
  managedInstallUrl,
  servesAnyShop,
  shopifyApp,
  shopifyApps,
  type ShopifyApp,
  type ShopifyAppConfig,
} from "@app/core";
import { can, expandScopes, normalizeShopDomain, randomToken, safeEqual, verifyShopifyQueryHmac, type Role } from "@app/shared";
import { body, clientIp, HttpError, loadUser, requireWorkspace, type Ctx, type Deps } from "../context.js";
import type { App } from "../app.js";
import { attachStore, storeTakenElsewhere, syncPage } from "../connectStore.js";
import { limit, LIMITS } from "../rateLimit.js";

const STATE_TTL_S = 600;
/** Shopify-signed redirects (callback, launch) older than this are refused. */
const MAX_LINK_AGE_S = 600;
const STATE_COOKIE = "shopify_oauth_state";
/** Remembers which user/workspace started a one-click connect while the user is on Shopify. */
const PENDING_COOKIE = "shopify_pending";
/** Minimum we need to provide any value. Everything else is optional. */
export const REQUIRED_SCOPES = ["read_orders"];

const cookieOpts = () => ({
  path: "/",
  httpOnly: true,
  sameSite: "Lax" as const,
  secure: env().NODE_ENV === "production",
  maxAge: STATE_TTL_S,
});

/**
 * Single-use OAuth state, kept while the merchant is on Shopify: a signed-in user connecting a
 * store to a workspace (`mode` is absent on state written by older releases).
 */
export type ConnectState = { mode?: "connect"; userId: string; workspaceId: string; shop: string; app?: string; from?: ConnectFrom };
type OAuthState = ConnectState;

/** True when a Shopify-signed `timestamp` is recent. */
function freshTimestamp(ts: string | undefined): boolean {
  const n = Number(ts);
  return Number.isFinite(n) && Math.abs(Date.now() / 1000 - n) <= MAX_LINK_AGE_S;
}

/**
 * Where an in-app connect was started, so Shopify's answer brings the merchant back there: Settings
 * shows the store's card (status, what it can read), the default is the first-sync progress page.
 * A fixed list, never a URL from the request.
 */
const CONNECT_FROM = ["settings"] as const;
type ConnectFrom = (typeof CONNECT_FROM)[number];
const connectFromSchema = z.enum(CONNECT_FROM).optional();
/** Settings → Stores, where a connect started from there lands. */
const SETTINGS_STORES = "/settings/stores";
const connectPage = (from: ConnectFrom | undefined) => (from === "settings" ? SETTINGS_STORES : "/onboarding");
const connectedPage = (from: ConnectFrom | undefined, storeId: string) =>
  from === "settings" ? `${SETTINGS_STORES}?connected=${encodeURIComponent(storeId)}` : syncPage(storeId);

/** Create single-use OAuth state, bind it to this browser and return Shopify's authorize URL. */
export async function authorizeRedirect(c: Ctx, deps: Deps, state: OAuthState): Promise<string> {
  const nonce = randomToken(24);
  await deps.coord.put(`oauth:state:${nonce}`, JSON.stringify(state), STATE_TTL_S);
  // Bind the flow to this browser too (prevents login-CSRF style state injection).
  setCookie(c, STATE_COOKIE, nonce, cookieOpts());
  const app = shopifyApp(state.app);
  const cfg = shopifyConfig(app);
  logHandoff(state.mode ?? "connect", state.shop, app, cfg.scopes);
  return buildAuthorizeUrl(cfg, state.shop, nonce);
}

/** Which of our apps signed this Shopify redirect (null: none, i.e. forged or tampered). */
export function appForSignedQuery(q: Record<string, string>): ShopifyApp | null {
  return shopifyApps().find((a) => verifyShopifyQueryHmac(q, a.clientSecret)) ?? null;
}

/** Authorize redirect for a signed-in user connecting `shop` to `workspaceId`. */
const beginAuthorize = (c: Ctx, deps: Deps, userId: string, workspaceId: string, shop: string, app: string, from?: ConnectFrom) =>
  authorizeRedirect(c, deps, { mode: "connect", userId, workspaceId, shop, app, ...(from ? { from } : {}) });

/**
 * The app `shop` installs through. Shopify shows "This installation link can't be used" when a
 * store may not install the app it is sent to, and it never calls us back, so a store we have
 * no app for is refused here instead — with an answer the merchant can act on.
 */
export function installApp(shop: string): ShopifyApp {
  const app = appForShop(shop);
  if (!app) {
    throw new HttpError(
      400,
      "This store can't install our app yet. Please contact support so we can set it up for your store.",
      "app_unavailable",
    );
  }
  return app;
}

/**
 * Recorded the moment before a merchant leaves for Shopify. When Shopify refuses an install
 * ("This installation link can't be used") it never calls us back, so nothing else marks the
 * attempt: a handoff with no matching `shopify_install_return` for the same shop means Shopify
 * turned that merchant away, and `app`/`clientId` say which app to check in the Dev Dashboard.
 * Grep Workers logs for `shopify_install_handoff` to see who tried and never arrived.
 */
export function logHandoff(flow: string, shop: string | null, app: ShopifyApp, scopes: string) {
  logger.info(
    { event: "shopify_install_handoff", flow, shop, app: app.key, clientId: app.clientId, scopes },
    "sending merchant to Shopify",
  );
}

/** The other half of the pair above: the merchant made it back. */
const logReturn = (flow: string, shop: string, app: ShopifyApp) =>
  logger.info({ event: "shopify_install_return", flow, shop, app: app.key }, "merchant returned from Shopify");

/** OAuth settings for one of our Shopify apps (the default app unless given). */
export function shopifyConfig(app: ShopifyApp = shopifyApp(DEFAULT_APP)): ShopifyAppConfig {
  const e = env();
  return {
    apiKey: app.clientId,
    apiSecret: app.clientSecret,
    scopes: [e.SHOPIFY_SCOPES, e.SHOPIFY_OPTIONAL_SCOPES].filter(Boolean).join(","),
    apiVersion: e.SHOPIFY_API_VERSION,
    // Browser-facing callback goes through the web app's /api proxy (same-origin cookies).
    redirectUri: `${e.APP_URL}/api/shopify/callback`,
  };
}

export function shopifyRoutes(app: App, deps: Deps) {
  /** Step 1: signed-in, verified user asks to connect a shop to a workspace. */
  app.post("/workspaces/:ws/shopify/install", async (c) => {
    const { ws } = c.req.param();
    const access = await requireWorkspace(c, deps, ws, "stores:manage");
    const user = access.user!;
    if (!user.emailVerified) throw new HttpError(403, "Verify your email before connecting a store", "email_unverified");
    const { shop: rawShop, from } = z.object({ shop: z.string().min(1).max(255), from: connectFromSchema }).parse(await body(c));
    const shop = normalizeShopDomain(rawShop);
    if (!shop) throw new HttpError(400, "Enter your store's myshopify.com address", "invalid_shop");
    // "Already connected elsewhere" tells whether a store uses Insights: bound how fast anyone can ask.
    await limit(deps.coord, `rl:shopify-install:${user.id}`, LIMITS.shopifyInstall);

    if (await storeTakenElsewhere(shop, ws)) {
      throw new HttpError(409, "This store is already connected to another workspace", "store_taken");
    }
    return c.json({ url: await beginAuthorize(c, deps, user.id, ws, shop, installApp(shop).key, from) });
  });

  /**
   * One-click connect: send the user to Shopify's managed install link, where they sign in,
   * pick a store and approve the scopes. Shopify then opens /shopify/launch for that store,
   * which finishes the connection for the workspace remembered here.
   *
   * Letting the merchant pick the store on Shopify only works while the main app may be
   * installed on any store. Once it is limited to named stores, a store served by its own app
   * can only be reached by name, so we ask for the address instead of sending the merchant to
   * an install link their store would be refused.
   */
  app.post("/workspaces/:ws/shopify/start", async (c) => {
    const { ws } = c.req.param();
    const access = await requireWorkspace(c, deps, ws, "stores:manage");
    const user = access.user!;
    if (!user.emailVerified) throw new HttpError(403, "Verify your email before connecting a store", "email_unverified");
    const { from } = z.object({ from: connectFromSchema }).parse(await body(c));
    const mainApp = shopifyApp(DEFAULT_APP);
    if (!servesAnyShop(mainApp)) {
      throw new HttpError(400, "Enter your store's myshopify.com address to connect it", "shop_required");
    }

    const nonce = randomToken(24);
    await deps.coord.put(`oauth:pending:${nonce}`, JSON.stringify({ userId: user.id, workspaceId: ws, ...(from ? { from } : {}) }), STATE_TTL_S);
    setCookie(c, PENDING_COOKIE, nonce, cookieOpts());
    logHandoff("oneclick", null, mainApp, shopifyConfig(mainApp).scopes);
    return c.json({ url: managedInstallUrl(mainApp.clientId) });
  });

  /** Step 2: Shopify redirects back here. */
  app.get("/shopify/callback", async (c) => {
    const q = c.req.query();
    const appUrl = env().APP_URL;
    // Errors go back to the page the connect started from, once the state record says which.
    let errorPage = "/onboarding";
    const fail = (code: string, shop?: string) =>
      c.redirect(`${appUrl}${errorPage}?error=${encodeURIComponent(code)}${shop ? `&shop=${encodeURIComponent(shop)}` : ""}`);

    const app = appForSignedQuery(q);
    if (!app) return fail("invalid_hmac");
    const shop = normalizeShopDomain(q.shop ?? "");
    if (!shop || shop !== q.shop) return fail("invalid_shop");
    logReturn("callback", shop, app);
    if (!freshTimestamp(q.timestamp)) return fail("stale_request");
    if (!q.state || !q.code) return fail("missing_params");

    try {
      const cookieState = getCookie(c, STATE_COOKIE);
      deleteCookie(c, STATE_COOKIE, { path: "/" });
      if (!cookieState || !safeEqual(cookieState, q.state)) return fail("state_mismatch");
      const stateKey = `oauth:state:${q.state}`;
      const raw = await deps.coord.take(stateKey);
      if (!raw) return fail("state_expired");
      const state = JSON.parse(raw) as OAuthState;
      errorPage = connectPage(state.from);
      if (state.shop !== shop) return fail("shop_mismatch");
      // The redirect must come back signed by the app the flow was started for.
      if ((state.app ?? DEFAULT_APP) !== app.key) return fail("app_mismatch");

      let user;
      try {
        user = await loadUser(c, deps);
      } catch (err) {
        // We couldn't tell who this is (database or session store down), which isn't "signed out". The
        // code hasn't been exchanged yet, so hand the state back rather than spend it on a blip:
        // this approval can still complete once we're reachable again.
        await deps.coord.put(stateKey, raw, STATE_TTL_S).catch(() => {});
        setCookie(c, STATE_COOKIE, q.state, cookieOpts());
        throw err;
      }
      if (!user || user.id !== state.userId) return fail("session_mismatch");
      // Re-checked here, not only at /install: the approval can take minutes, and someone removed
      // from the workspace (or demoted) in between must not still attach a store to it.
      const member = await systemDb.membership.findUnique({ where: { workspaceId_userId: { workspaceId: state.workspaceId, userId: user.id } } });
      if (!member || !can(member.role, "stores:manage")) return fail("not_allowed");

      let token;
      try {
        token = await exchangeCodeForToken(shopifyConfig(app), shop, q.code, deps.fetchImpl);
      } catch (err) {
        logger.error({ err, shop }, "shopify code exchange failed");
        return fail("exchange_failed");
      }
      const granted = expandScopes(token.scopes);
      if (!REQUIRED_SCOPES.every((s) => granted.has(s))) return fail("missing_required_scopes");

      try {
        const store = await attachStore(deps, { workspaceId: state.workspaceId, shop, token, appKey: app.key, actorUserId: user.id, ip: clientIp(c) });
        return c.redirect(`${appUrl}${connectedPage(state.from, store.id)}`);
      } catch (err) {
        if (err instanceof HttpError && err.code === "store_taken") return fail("store_taken");
        throw err;
      }
    } catch (err) {
      // A browser navigation: a blip in the database, coordinator or queue must land on a page
      // that says so, not on raw JSON. Connecting again repairs a connect that died half-way
      // (attachStore re-runs from the top), so the retry is all the merchant needs.
      logger.error({ err, shop }, "shopify callback failed");
      return fail("temporarily_unavailable", shop);
    }
  });

  /**
   * App URL configured in the Partner dashboard. Shopify opens it (signed) right after a managed
   * install (one-click connect), and whenever a merchant launches the app from their admin.
   * If we know which workspace to connect, go straight to the authorize redirect (the app is
   * already installed with its scopes, so Shopify returns to /callback without another prompt).
   * Otherwise send them to the connect page, which picks up ?shop= after sign-in.
   */
  app.get("/shopify/launch", async (c) => {
    const q = c.req.query();
    const appUrl = env().APP_URL;
    // Opened by Shopify for whichever of our apps was launched; its signature tells us which.
    // A merchant can land here with a stale or hand-edited link, so answer with the sign-in
    // page and an explanation rather than the raw JSON error an API client would get: this is
    // a browser entry point, and a dead end here looks to them like the product is broken.
    const app = appForSignedQuery(q);
    const shop = app ? normalizeShopDomain(q.shop ?? "") : null;
    // Shopify signs a fresh link on every launch, so an old one is a replay (or a bookmark).
    const stale = !!app && !freshTimestamp(q.timestamp);
    if (!app || !shop || stale) {
      logger.warn({ event: "shopify_launch_rejected", reason: !app ? "invalid_hmac" : stale ? "stale" : "invalid_shop" }, "unverified app launch");
      return c.redirect(`${appUrl}/onboarding?error=launch_unverified`);
    }
    logReturn("launch", shop, app);
    const toOnboarding = () => c.redirect(`${appUrl}/onboarding?shop=${encodeURIComponent(shop)}`);

    const pendingNonce = getCookie(c, PENDING_COOKIE);
    /** The one-click choice once taken, so a launch that fails can hand it back. */
    let pendingRaw: string | null = null;
    try {
      // Null only without a valid session: an outage throws instead of passing for "signed out",
      // which used to send signed-in merchants into sign-up.
      const user = await loadUser(c, deps);
      // Stores connect from inside the app: the connect page asks a visitor to sign in or create
      // an account first and then picks this store up from ?shop=.
      if (!user || !user.emailVerified) return toOnboarding();

      let workspaceId: string | null = null;
      let role: Role | null = null;
      let from: ConnectFrom | undefined;
      if (pendingNonce) {
        deleteCookie(c, PENDING_COOKIE, { path: "/" });
        pendingRaw = await deps.coord.take(`oauth:pending:${pendingNonce}`);
        const pending = pendingRaw ? (JSON.parse(pendingRaw) as { userId: string; workspaceId: string; from?: unknown }) : null;
        if (pending?.userId === user.id) {
          workspaceId = pending.workspaceId;
          from = connectFromSchema.catch(undefined).parse(pending.from);
        }
      }
      if (!workspaceId) {
        // Opened from the Shopify admin: only auto-connect when there's exactly one workspace to use.
        // This read already carries the role, so only the remembered workspace needs a second one.
        const managed = await systemDb.membership.findMany({
          where: { userId: user.id, role: { in: ["owner", "admin"] } },
          select: { workspaceId: true, role: true },
        });
        if (managed.length !== 1) return toOnboarding();
        ({ workspaceId, role } = managed[0]!);
      } else {
        // Re-check permission on the workspace /start remembered (the role may have changed since).
        const m = await systemDb.membership.findUnique({ where: { workspaceId_userId: { workspaceId, userId: user.id } } });
        role = m?.role ?? null;
      }
      if (!role || !can(role, "stores:manage")) return toOnboarding();
      if (await storeTakenElsewhere(shop, workspaceId)) return c.redirect(`${appUrl}/onboarding?error=store_taken`);

      return c.redirect(await beginAuthorize(c, deps, user.id, workspaceId, shop, app.key, from));
    } catch (err) {
      // A browser entry point (see the top of this handler): a blip in the database or coordinator
      // must land on a page that says so. Put the one-click choice back so relaunching from the
      // admin still uses it. Someone with a session retries from onboarding (the shop filled in),
      // a visitor from the sign-up page.
      logger.error({ err, shop }, "shopify launch failed");
      if (pendingNonce && pendingRaw) {
        await deps.coord.put(`oauth:pending:${pendingNonce}`, pendingRaw, STATE_TTL_S).catch(() => {});
        setCookie(c, PENDING_COOKIE, pendingNonce, cookieOpts());
      }
      return c.redirect(`${appUrl}/onboarding?shop=${encodeURIComponent(shop)}&error=temporarily_unavailable`);
    }
  });
}

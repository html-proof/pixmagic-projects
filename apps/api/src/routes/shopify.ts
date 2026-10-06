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
import { body, clientIp, HttpError, loadUser, requireWorkspace, SESSION_COOKIE, type Ctx, type Deps } from "../context.js";
import type { App } from "../app.js";
import { attachStore, storeTakenElsewhere, syncPage } from "../connectStore.js";
import { freshTimestamp, SIGNUP_COOKIE, signupCallback, signupLaunch } from "./shopifySignup.js";

const STATE_TTL_S = 600;
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
 * Single-use OAuth state, kept while the merchant is on Shopify. `connect` (also when `mode` is
 * absent) is a signed-in user connecting a store to a workspace; the signup modes belong to
 * "Continue with Shopify" (see shopifySignup.ts).
 */
export type ConnectState = { mode?: "connect"; userId: string; workspaceId: string; shop: string; app?: string };
export type SignupState = { mode: "signup_user" | "signup_offline"; signup: string; shop: string; app?: string };
type OAuthState = ConnectState | SignupState;

const isSignupState = (s: OAuthState): s is SignupState => s.mode === "signup_user" || s.mode === "signup_offline";

/** Create single-use OAuth state, bind it to this browser and return Shopify's authorize URL. */
export async function authorizeRedirect(c: Ctx, deps: Deps, state: OAuthState, opts: { perUser?: boolean } = {}): Promise<string> {
  const nonce = randomToken(24);
  await deps.coord.put(`oauth:state:${nonce}`, JSON.stringify(state), STATE_TTL_S);
  // Bind the flow to this browser too (prevents login-CSRF style state injection).
  setCookie(c, STATE_COOKIE, nonce, cookieOpts());
  const app = shopifyApp(state.app);
  const cfg = shopifyConfig(app);
  logHandoff(state.mode ?? "connect", state.shop, app, cfg.scopes);
  return buildAuthorizeUrl(cfg, state.shop, nonce, opts);
}

/** Which of our apps signed this Shopify redirect (null: none, i.e. forged or tampered). */
export function appForSignedQuery(q: Record<string, string>): ShopifyApp | null {
  return shopifyApps().find((a) => verifyShopifyQueryHmac(q, a.clientSecret)) ?? null;
}

/** Authorize redirect for a signed-in user connecting `shop` to `workspaceId`. */
const beginAuthorize = (c: Ctx, deps: Deps, userId: string, workspaceId: string, shop: string, app: string) =>
  authorizeRedirect(c, deps, { mode: "connect", userId, workspaceId, shop, app });

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
    const { shop: rawShop } = z.object({ shop: z.string().min(1).max(255) }).parse(await body(c));
    const shop = normalizeShopDomain(rawShop);
    if (!shop) throw new HttpError(400, "Enter your store's myshopify.com address", "invalid_shop");

    if (await storeTakenElsewhere(shop, ws)) {
      throw new HttpError(409, "This store is already connected to another workspace", "store_taken");
    }
    return c.json({ url: await beginAuthorize(c, deps, user.id, ws, shop, installApp(shop).key) });
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
    const mainApp = shopifyApp(DEFAULT_APP);
    if (!servesAnyShop(mainApp)) {
      throw new HttpError(400, "Enter your store's myshopify.com address to connect it", "shop_required");
    }

    const nonce = randomToken(24);
    await deps.coord.put(`oauth:pending:${nonce}`, JSON.stringify({ userId: user.id, workspaceId: ws }), STATE_TTL_S);
    setCookie(c, PENDING_COOKIE, nonce, cookieOpts());
    logHandoff("oneclick", null, mainApp, shopifyConfig(mainApp).scopes);
    return c.json({ url: managedInstallUrl(mainApp.clientId) });
  });

  /** Step 2: Shopify redirects back here (in-app connect and both signup legs). */
  app.get("/shopify/callback", async (c) => {
    const q = c.req.query();
    const appUrl = env().APP_URL;
    // Signup errors go back to /start, in-app connect errors to /onboarding. Until the state
    // record says which flow this is, judge by the cookies.
    let errorPage = getCookie(c, SIGNUP_COOKIE) && !getCookie(c, SESSION_COOKIE) ? "/start" : "/onboarding";
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
      errorPage = isSignupState(state) ? "/start" : "/onboarding";
      if (state.shop !== shop) return fail("shop_mismatch");
      // The redirect must come back signed by the app the flow was started for.
      if ((state.app ?? DEFAULT_APP) !== app.key) return fail("app_mismatch");
      // Awaited, so its failures land on the retry page below too.
      if (isSignupState(state)) return await signupCallback(c, deps, state, shop, q.code, fail, app);

      let user;
      try {
        user = await loadUser(c, deps);
      } catch (err) {
        // We couldn't tell who this is (database or Firebase down), which isn't "signed out". The
        // code hasn't been exchanged yet, so hand the state back rather than spend it on a blip:
        // this approval can still complete once we're reachable again.
        await deps.coord.put(stateKey, raw, STATE_TTL_S).catch(() => {});
        setCookie(c, STATE_COOKIE, q.state, cookieOpts());
        throw err;
      }
      if (!user || user.id !== state.userId) return fail("session_mismatch");

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
        return c.redirect(`${appUrl}${syncPage(store.id)}`);
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
   * App URL configured in the Partner dashboard. Shopify opens it (signed) right after the
   * managed install from /start, and whenever a merchant launches the app from their admin.
   * If we know which workspace to connect, go straight to the authorize redirect (the app is
   * already installed with its scopes, so Shopify returns to /callback without another prompt).
   * Visitors without a session continue their "Continue with Shopify" signup, or start one.
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
    if (!app || !shop) {
      logger.warn({ event: "shopify_launch_rejected", reason: app ? "invalid_shop" : "invalid_hmac" }, "unverified app launch");
      return c.redirect(`${appUrl}/start?error=launch_unverified`);
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
      if (!user || !user.emailVerified) {
        const next = await signupLaunch(c, deps, shop, q.timestamp, app.key);
        if (next) return c.redirect(next);
        return user ? toOnboarding() : c.redirect(`${appUrl}/start?shop=${encodeURIComponent(shop)}`);
      }

      let workspaceId: string | null = null;
      let role: Role | null = null;
      if (pendingNonce) {
        deleteCookie(c, PENDING_COOKIE, { path: "/" });
        pendingRaw = await deps.coord.take(`oauth:pending:${pendingNonce}`);
        const pending = pendingRaw ? (JSON.parse(pendingRaw) as { userId: string; workspaceId: string }) : null;
        if (pending?.userId === user.id) workspaceId = pending.workspaceId;
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

      return c.redirect(await beginAuthorize(c, deps, user.id, workspaceId, shop, app.key));
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
      const page = getCookie(c, SESSION_COOKIE) ? "/onboarding" : "/start";
      return c.redirect(`${appUrl}${page}?shop=${encodeURIComponent(shop)}&error=temporarily_unavailable`);
    }
  });
}

import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { systemDb, type Store, type User } from "@app/db";
import {
  appForShop,
  audit,
  buildAuthorizeUrl,
  DEFAULT_APP,
  encryptTokenFields,
  installTarget,
  env,
  exchangeCodeForToken,
  logger,
  managedInstallUrl,
  servesAnyShop,
  shopifyApp,
  shopifyApps,
  storeLimitReached,
  type Plan,
  type ShopifyApp,
  type ShopifyAppConfig,
  type TokenResponse,
} from "@app/core";
import { syncProblem } from "@app/core/reports";
import { can, expandScopes, normalizeShopDomain, randomToken, safeEqual, verifyShopifyQueryHmac } from "@app/shared";
import { body, clientIp, HttpError, loadUser, memberAllows, requireUser, requireWorkspace, type Ctx, type Deps } from "../context.js";
import type { App } from "../app.js";
import { SESSION_COOKIE } from "../session.js";
import { attachStore, createShopWorkspace, dropEmptyShopWorkspace, lockWorkspace, storeTakenElsewhere, syncPage, unclaimed } from "../connectStore.js";
import { limit, LIMITS } from "../rateLimit.js";

const STATE_TTL_S = 600;
/** Shopify-signed redirects (callback, launch) older than this are refused. */
const MAX_LINK_AGE_S = 600;
const STATE_COOKIE = "shopify_oauth_state";
/** Remembers which user/workspace started a one-click connect while the user is on Shopify. */
const PENDING_COOKIE = "shopify_pending";
/**
 * Remembers, in the browser that installed it, which store installed from Shopify it may add to
 * an account. A day, because signing up (and confirming the email) can take a while.
 */
const CLAIM_COOKIE = "shopify_claim";
const CLAIM_TTL_S = 24 * 3600;
const claimKey = (nonce: string) => `shopify:claim:${nonce}`;
/** Minimum we need to provide any value. Everything else is optional. */
export const REQUIRED_SCOPES = ["read_orders"];

const cookieOpts = (maxAge = STATE_TTL_S) => ({
  path: "/",
  httpOnly: true,
  sameSite: "Lax" as const,
  secure: env().NODE_ENV === "production",
  maxAge,
});

/**
 * Single-use OAuth state, kept while the merchant is on Shopify: a signed-in user connecting a
 * store to a workspace (`mode` is absent on state written by older releases).
 */
export type ConnectState = { mode?: "connect"; userId: string; workspaceId: string; shop: string; app?: string; from?: ConnectFrom };
/**
 * Shopify opened the app for a store we hold no working token for (installed from the App Store,
 * reinstalled, or its access was lost): authorized before anything else, whoever is signed in.
 */
export type InstallState = { mode: "install"; shop: string; app: string };
type OAuthState = ConnectState | InstallState;

/** What the claim cookie points at: a store, the workspace it was installed into, and when the offer ends (ms). */
type Claim = { storeId: string; workspaceId: string; shop: string; exp: number };

/**
 * True when the app can work with `store` right now through `app`: not uninstalled, holding a
 * token from that app, and Shopify isn't refusing it (a sync that failed on 401/403).
 */
async function workingFor(store: Store | null, app: ShopifyApp): Promise<boolean> {
  if (!store || store.status === "uninstalled" || !store.accessTokenEnc || store.shopifyAppKey !== app.key) return false;
  if (store.status !== "error") return true;
  const failed = await systemDb.syncJob.findFirst({
    where: { storeId: store.id, status: "failed" },
    orderBy: { createdAt: "desc" },
    select: { error: true },
  });
  return syncProblem(failed?.error) !== "access";
}

/** Let this browser add `store` to an account (GET/POST /shopify/claim) for the next day. */
async function offerClaim(c: Ctx, deps: Deps, store: Pick<Store, "id" | "workspaceId" | "shopDomain">) {
  const nonce = randomToken(24);
  const claim: Claim = { storeId: store.id, workspaceId: store.workspaceId, shop: store.shopDomain, exp: Date.now() + CLAIM_TTL_S * 1000 };
  await deps.coord.put(claimKey(nonce), JSON.stringify(claim), CLAIM_TTL_S);
  setCookie(c, CLAIM_COOKIE, nonce, cookieOpts(CLAIM_TTL_S));
}

/**
 * Where a merchant opening `store` from Shopify lands: the page that adds it to an account while
 * nobody has claimed it, otherwise its dashboard (by way of the first-sync page, which picks the
 * store's workspace and asks a signed-out visitor to sign in first).
 */
async function landingFor(c: Ctx, deps: Deps, store: Store): Promise<string> {
  const appUrl = env().APP_URL;
  if (await unclaimed(store.workspaceId)) {
    await offerClaim(c, deps, store);
    return `${appUrl}/claim`;
  }
  return `${appUrl}${syncPage(store.id)}`;
}

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

const htmlEscape = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/**
 * The page a launch framed by Shopify's admin gets: it reopens `target` as the whole tab.
 * App Bridge does that (a cross-origin frame may not navigate the top window by itself, and
 * App Bridge turns `open(url, "_top")` into a request to the admin); the link is the fallback a
 * click always makes work. Only this store's admin may frame it (Shopify's frame-ancestors rule
 * for embedded apps); every other page still refuses to be framed.
 */
function breakOutOfAdmin(c: Ctx, shop: string, apiKey: string, target: string) {
  const nonce = randomToken(16);
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' https://cdn.shopify.com`,
    "connect-src https://cdn.shopify.com https://*.shopify.com https://*.myshopify.com",
    "style-src 'unsafe-inline' https://cdn.shopify.com",
    "img-src https: data:",
    "font-src https://cdn.shopify.com",
    `frame-ancestors https://${shop} https://admin.shopify.com`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
  const href = htmlEscape(target);
  // JSON inside a script: `<` escaped so the string can never end the element.
  const js = JSON.stringify(target).replace(/</g, "\\u003c");
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="shopify-api-key" content="${htmlEscape(apiKey)}">
<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js" nonce="${nonce}"></script>
<title>Opening bizinsights</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;color:#1a1a1a;background:#f6f6f7}a{display:inline-block;margin-top:12px;padding:10px 16px;border-radius:8px;background:#1a1a1a;color:#fff;text-decoration:none}</style>
</head><body><main style="text-align:center"><p>bizinsights opens in its own window.</p><a href="${href}" target="_top">Open bizinsights</a></main>
<script nonce="${nonce}">try{open(${js},"_top")}catch(e){}</script>
</body></html>`;
  return c.html(html, 200, { "content-security-policy": csp, "cache-control": "no-store" });
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
 * Search the API's logs (CloudWatch) for `shopify_install_handoff` to see who tried and never arrived.
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

/** The authorization code exchanged for the offline token, or the error to send the merchant back with. */
async function exchangeOrFail(app: ShopifyApp, shop: string, code: string, deps: Deps): Promise<TokenResponse | string> {
  let token: TokenResponse;
  try {
    token = await exchangeCodeForToken(shopifyConfig(app), shop, code, deps.fetchImpl);
  } catch (err) {
    logger.error({ err, shop }, "shopify code exchange failed");
    return "exchange_failed";
  }
  const granted = expandScopes(token.scopes);
  return REQUIRED_SCOPES.every((s) => granted.has(s)) ? token : "missing_required_scopes";
}

/**
 * The callback of an install-mode authorization: Shopify installed (or reinstalled) the app and
 * the merchant approved it. The token goes to the store's own workspace (the one it had before an
 * uninstall, or one made for it now), the first import starts, and the merchant lands in the app.
 */
async function finishInstall(
  c: Ctx,
  deps: Deps,
  { app, shop, code, user }: { app: ShopifyApp; shop: string; code: string; user: User | null },
  fail: (code: string) => Response,
): Promise<Response> {
  const token = await exchangeOrFail(app, shop, code, deps);
  if (typeof token === "string") return fail(token);
  const existing = await systemDb.store.findUnique({ where: { shopDomain: shop } });

  // Opened again before anyone claimed it: the import already ran, this approval only earns the
  // browser its claim (landingFor), so keep the fresher token and go there.
  if (existing && (await workingFor(existing, app)) && (await unclaimed(existing.workspaceId))) {
    await systemDb.store.update({ where: { id: existing.id }, data: encryptTokenFields(existing.id, token) });
    return c.redirect(await landingFor(c, deps, existing));
  }

  // The store goes back to its own workspace, except one an account had until the merchant
  // uninstalled the app: uninstalling is how a merchant cuts an account off, so that account gets
  // the store back only when someone who manages its stores is the one signed in here. Anyone
  // else starts afresh in a workspace of the store's own (attachStore moves it and clears the old
  // copy of its data).
  let target = existing?.workspaceId ?? null;
  if (existing && existing.status === "uninstalled" && !(await unclaimed(existing.workspaceId))) {
    const m = user?.emailVerified
      ? await systemDb.membership.findUnique({ where: { workspaceId_userId: { workspaceId: existing.workspaceId, userId: user.id } } })
      : null;
    if (!memberAllows(m, "stores:manage")) target = null;
  }
  const created = target ? null : await createShopWorkspace(shop);
  let store: Store;
  try {
    store = await attachStore(deps, {
      workspaceId: target ?? created!.id,
      shop,
      token,
      appKey: app.key,
      actorUserId: user?.id ?? null,
      ip: clientIp(c),
      via: "shopify_install",
    });
  } catch (err) {
    if (created) await dropEmptyShopWorkspace(created.id);
    // Another install of the same store finished first (a second tab): open that one instead.
    if (err instanceof HttpError && err.code === "store_taken") {
      const winner = await systemDb.store.findUnique({ where: { shopDomain: shop } });
      if (winner) return c.redirect(await landingFor(c, deps, winner));
    }
    throw err;
  }
  if (created) await audit({ workspaceId: created.id, action: "workspace.created", metadata: { via: "shopify_install", shop }, ip: clientIp(c) });
  logger.info({ event: "shopify_installed", shop, app: app.key, storeId: store.id, newWorkspace: !!created }, "store installed from Shopify");
  return c.redirect(await landingFor(c, deps, store));
}

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
    // "Already connected elsewhere" tells whether a store uses bizinsights: bound how fast anyone can ask.
    await limit(deps.coord, `rl:shopify-install:${user.id}`, LIMITS.shopifyInstall);

    if (await storeTakenElsewhere(shop, ws)) {
      throw new HttpError(409, "This store is already connected to another workspace", "store_taken");
    }
    const full = await storeLimitReached(ws, shop);
    if (full) throw storeLimit(full);
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
    const mainApp = installTarget();
    if (!servesAnyShop(mainApp)) {
      throw new HttpError(400, "Enter your store's myshopify.com address to connect it", "shop_required");
    }
    // Asked before Shopify installs anything: the store is picked there, and only one the
    // workspace has room for may come back to it.
    const full = await storeLimitReached(ws, null);
    if (full) throw storeLimit(full);

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
      errorPage = state.mode === "install" ? "/claim" : connectPage(state.from);
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
      if (state.mode === "install") return await finishInstall(c, deps, { app, shop, code: q.code, user }, fail);
      if (!user || user.id !== state.userId) return fail("session_mismatch");
      // Re-checked here, not only at /install: the approval can take minutes, and someone removed
      // from the workspace (or demoted) in between must not still attach a store to it.
      const member = await systemDb.membership.findUnique({ where: { workspaceId_userId: { workspaceId: state.workspaceId, userId: user.id } } });
      if (!memberAllows(member, "stores:manage")) return fail("not_allowed");

      const token = await exchangeOrFail(app, shop, q.code, deps);
      if (typeof token === "string") return fail(token);

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
   * App URL configured in the Partner dashboard. Shopify opens it (signed) right after an install
   * (from the App Store, or our one-click connect) and whenever a merchant opens the app from their
   * admin.
   *
   * A store we hold no working token for is authorized at once, before anything else is shown or
   * asked (App Store requirements 2.3.2 and 2.3.4): the app is already installed with its scopes,
   * so Shopify returns to /callback without another prompt. Where that token goes: the workspace a
   * one-click connect from inside the app remembered, the only workspace a signed-in person
   * manages, or else the store's own workspace (see finishInstall). A store that works opens.
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
    // Shopify's admin opens the app inside its own iframe (embedded=1), though the app is
    // configured non-embedded. Everything below answers with redirects to pages that refuse to
    // be framed, which the merchant sees as "bizinsights.io refused to connect". So a framed
    // launch gets a page only that store's admin may frame, which reopens this same signed link
    // as the whole tab; that top-level request then goes on below like any other launch.
    if (c.req.header("sec-fetch-dest") === "iframe") {
      const query = new URL(c.req.url).search;
      return breakOutOfAdmin(c, shop, app.clientId, `${appUrl}/api/shopify/launch${query}`);
    }
    logReturn("launch", shop, app);

    const pendingNonce = getCookie(c, PENDING_COOKIE);
    /** The one-click choice once taken, so a launch that fails can hand it back. */
    let pendingRaw: string | null = null;
    // Whether this browser has a session at all, known even when checking it fails (an outage).
    const hasSession = !!getCookie(c, SESSION_COOKIE);
    try {
      // Null only without a valid session: an outage throws instead of passing for "signed out".
      const user = await loadUser(c, deps);
      const verified = user?.emailVerified ? user : null;
      /** The workspace a verified person may connect a store to, or null. */
      const manageable = async (workspaceId: string) => {
        if (!verified) return null;
        const m = await systemDb.membership.findUnique({ where: { workspaceId_userId: { workspaceId, userId: verified.id } } });
        return memberAllows(m, "stores:manage") ? workspaceId : null;
      };

      // 1. A one-click connect this browser started from inside the app: finish it there.
      if (pendingNonce) {
        deleteCookie(c, PENDING_COOKIE, { path: "/" });
        pendingRaw = await deps.coord.take(`oauth:pending:${pendingNonce}`);
        const pending = pendingRaw ? (JSON.parse(pendingRaw) as { userId: string; workspaceId: string; from?: unknown }) : null;
        // Re-check permission on the workspace /start remembered (the role may have changed since).
        const ws = pending && pending.userId === verified?.id ? await manageable(pending.workspaceId) : null;
        // A workspace that filled up since /start checked (a second connect at the same time) can't
        // take it; the store is installed by now, so it goes on as if nobody was known (4. below).
        if (ws && verified && !(await storeLimitReached(ws, shop))) {
          if (await storeTakenElsewhere(shop, ws)) return c.redirect(`${appUrl}/onboarding?error=store_taken`);
          const from = connectFromSchema.catch(undefined).parse(pending?.from);
          return c.redirect(await beginAuthorize(c, deps, verified.id, ws, shop, app.key, from));
        }
      }

      const store = await systemDb.store.findUnique({ where: { shopDomain: shop } });
      // 2. Installed and working: open it. One nobody has claimed yet goes through Shopify's
      //    approval first (it doesn't prompt again): a signed link alone doesn't earn a claim.
      if (store && (await workingFor(store, app)) && !(await unclaimed(store.workspaceId))) {
        return c.redirect(await landingFor(c, deps, store));
      }

      // 3. A new or uninstalled store opened by someone signed in who manages exactly one
      //    workspace: connect it there, as opening the app from the admin always has.
      if ((!store || store.status === "uninstalled") && verified) {
        const managed = await systemDb.membership.findMany({
          where: { userId: verified.id, role: { in: ["owner", "admin"] }, revokedAt: null },
          select: { workspaceId: true, role: true },
        });
        const only = managed.length === 1 && can(managed[0]!.role, "stores:manage") ? managed[0]!.workspaceId : null;
        // One whose plan has no room for another store doesn't get it: then 4.
        if (only && !(await storeLimitReached(only, shop))) return c.redirect(await beginAuthorize(c, deps, verified.id, only, shop, app.key));
      }

      // 4. Everyone else: authorize now, decide where the store lives once Shopify answers.
      return c.redirect(await authorizeRedirect(c, deps, { mode: "install", shop, app: app.key }));
    } catch (err) {
      // A browser entry point (see the top of this handler): a blip in the database or coordinator
      // must land on a page that says so. Put the one-click choice back so relaunching from the
      // admin still uses it. Someone with a session retries from onboarding (the shop filled in);
      // anyone else is told to open the app from Shopify again.
      logger.error({ err, shop }, "shopify launch failed");
      if (pendingNonce && pendingRaw) {
        await deps.coord.put(`oauth:pending:${pendingNonce}`, pendingRaw, STATE_TTL_S).catch(() => {});
        setCookie(c, PENDING_COOKIE, pendingNonce, cookieOpts());
      }
      return c.redirect(
        hasSession
          ? `${appUrl}/onboarding?shop=${encodeURIComponent(shop)}&error=temporarily_unavailable`
          : `${appUrl}/claim?error=temporarily_unavailable`,
      );
    }
  });

  /**
   * The store this browser installed from Shopify and may add to an account (the claim cookie),
   * for the page that offers it. `claimable` is false once an account has it: then the person
   * only needs to sign in to that account.
   */
  app.get("/shopify/claim", async (c) => {
    const claim = await readClaim(c, deps);
    if (!claim) throw claimExpired();
    const store = await systemDb.store.findUnique({ where: { id: claim.storeId } });
    // Gone, or connected to an account another way since: this claim no longer points anywhere.
    if (!store || store.shopDomain !== claim.shop || store.workspaceId !== claim.workspaceId) throw claimExpired();
    const claimable = await unclaimed(store.workspaceId);
    return c.json({ shop: store.shopDomain, name: store.name, status: store.status, claimable });
  });

  /**
   * Add the store this browser installed from Shopify to the signed-in account: its workspace gets
   * that person as owner. Only while nobody has it yet, and only once per claim cookie.
   */
  app.post("/shopify/claim", async (c) => {
    const user = await requireUser(c, deps);
    if (!user.emailVerified) throw new HttpError(403, "Verify your email before adding a store", "email_unverified");
    const nonce = getCookie(c, CLAIM_COOKIE);
    const raw = nonce ? await deps.coord.take(claimKey(nonce)) : null;
    if (!nonce || !raw) throw claimExpired();
    const claim = JSON.parse(raw) as Claim;
    const left = remainingS(claim);
    if (left <= 0) throw claimExpired();
    let result: { workspace: { id: string; name: string }; storeId: string };
    try {
      result = await systemDb.$transaction(async (tx) => {
        // One claim at a time per workspace: two browsers holding a claim for the same store
        // (opened from the admin twice) must not both become owner.
        await lockWorkspace(tx, claim.workspaceId);
        const store = await tx.store.findUnique({ where: { id: claim.storeId } });
        if (!store || store.workspaceId !== claim.workspaceId || store.shopDomain !== claim.shop) throw claimExpired();
        if (!(await unclaimed(claim.workspaceId, tx))) {
          throw new HttpError(409, "This store already belongs to a bizinsights account. Sign in to that account, or ask its owner to invite you.", "already_claimed");
        }
        await tx.membership.create({ data: { workspaceId: claim.workspaceId, userId: user.id, role: "owner" } });
        const workspace = await tx.workspace.update({ where: { id: claim.workspaceId }, data: { awaitingClaim: false }, select: { id: true, name: true } });
        return { workspace, storeId: store.id };
      });
    } catch (err) {
      // A blip (not a refusal) must not spend the claim: the person retries with the same cookie.
      if (!(err instanceof HttpError)) await deps.coord.put(claimKey(nonce), raw, left).catch(() => {});
      throw err;
    }
    deleteCookie(c, CLAIM_COOKIE, { path: "/" });
    await audit({
      workspaceId: result.workspace.id,
      actorUserId: user.id,
      action: "workspace.claimed",
      targetType: "store",
      targetId: result.storeId,
      metadata: { shop: claim.shop },
      ip: clientIp(c),
    });
    return c.json({ workspace: { ...result.workspace, role: "owner" }, storeId: result.storeId });
  });
}

/** A workspace whose plan has no room for another store (packages/core/src/billing.ts). */
const storeLimit = (plan: Plan) =>
  new HttpError(
    403,
    `The ${plan.name} plan includes ${plan.maxStores === 1 ? "1 store" : `${plan.maxStores} stores`}. Choose a bigger plan in Settings → Billing to connect another.`,
    "store_limit",
  );

const claimExpired = () =>
  new HttpError(404, "This link has expired. Open bizinsights from your Shopify admin (Apps) to continue.", "claim_expired");

/** Seconds left on a claim (its record keeps the end, so reading it never extends it). */
const remainingS = (claim: Claim) => Math.floor((claim.exp - Date.now()) / 1000);

/** The claim this browser holds, left in place (the page may be reloaded before it is used). */
async function readClaim(c: Ctx, deps: Deps): Promise<Claim | null> {
  const nonce = getCookie(c, CLAIM_COOKIE);
  if (!nonce) return null;
  // The coordinator has no plain read: take and put back (only this browser holds the nonce).
  const raw = await deps.coord.take(claimKey(nonce));
  if (!raw) return null;
  const claim = JSON.parse(raw) as Claim;
  const left = remainingS(claim);
  if (left <= 0) return null;
  await deps.coord.put(claimKey(nonce), raw, left);
  return claim;
}

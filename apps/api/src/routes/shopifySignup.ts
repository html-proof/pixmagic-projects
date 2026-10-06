import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import type { User } from "@app/db";
import {
  DEFAULT_APP,
  env,
  exchangeCodeForOnlineToken,
  exchangeCodeForToken,
  keyring,
  logger,
  managedInstallUrl,
  servesAnyShop,
  shopifyApp,
  type OnlineTokenResponse,
  type ShopifyApp,
  type ShopifyAssociatedUser,
  type TokenResponse,
} from "@app/core";
import { decrypt, encrypt, expandScopes, normalizeShopDomain, randomToken, safeEqual } from "@app/shared";
import { body, clientIp, HttpError, requireUser, type Ctx, type Deps } from "../context.js";
import type { App } from "../app.js";
import { limit } from "../rateLimit.js";
import { connectStore } from "../connectStore.js";
import { authorizeRedirect, installApp, logHandoff, REQUIRED_SCOPES, shopifyConfig, type SignupState } from "./shopify.js";

/**
 * "Continue with Shopify" sign-up / sign-in, for visitors without an account or session:
 *
 *   POST /auth/shopify/start {email, shop?}  → per-user authorize (or Shopify's managed install,
 *                                              which comes back through /shopify/launch)
 *   /shopify/callback (signup_user)          → who approved (Shopify staff account + verified email)
 *   /shopify/callback (signup_offline)       → the store-level token for background sync
 *   POST /auth/shopify/finish                → Firebase custom token when Shopify vouches for the email,
 *                                              else the web app proves the email with an OTP
 *   POST /auth/shopify/claim (signed in)     → connect the store to the user's workspace
 *
 * Everything in between lives in one short-lived record (`signup:<nonce>`) that only this
 * browser can reach (httpOnly cookie), holds tokens only encrypted, and is consumed by claim.
 */

export const SIGNUP_COOKIE = "shopify_signup";
export const SIGNUP_TTL_S = 1800;
/** randomToken(24) is 32 base64url characters. */
const NONCE_RE = /^[A-Za-z0-9_-]{32}$/;
/** Shopify-signed links older than this are not trusted to continue a signup. */
const MAX_LINK_AGE_S = 600;
/**
 * finish may re-issue its sign-in token for this long (a retry after a network blip); after
 * that the record mints no more sessions without the email being proven again by code, so a
 * browser left behind can't be reused.
 */
const TOKEN_REISSUE_MS = 2 * 60 * 1000;

interface SignupTokens {
  accessTokenEnc: string;
  refreshTokenEnc: string | null;
  accessTokenExpiresAt: string | null;
  refreshTokenExpiresAt: string | null;
  scopes: string[];
}

interface SignupData {
  /** What the visitor typed on the first panel (unproven until they verify it). */
  email: string;
  shop?: string;
  /** Which of our Shopify apps this signup goes through (default app when absent). */
  app?: string;
  /** The Shopify staff account that approved the per-user grant. */
  shopifyUser?: ShopifyAssociatedUser;
  tokens?: SignupTokens;
  /** Email this browser has proven via Shopify (set by finish). */
  provenEmail?: string;
  /** When finish first handed out a sign-in token for `provenEmail` (ms since epoch). */
  tokenIssuedAt?: number;
}

interface SignupRecord extends SignupData {
  expiresAt: number;
}

type CompleteSignup = SignupRecord & Required<Pick<SignupRecord, "shop" | "shopifyUser" | "tokens">>;

const isComplete = (r: SignupRecord | null): r is CompleteSignup => !!r?.shop && !!r.shopifyUser && !!r.tokens;

const signupKey = (nonce: string) => `signup:${nonce}`;
const signupExpired = () => new HttpError(400, "Your sign-up session has expired. Please start again.", "signup_expired");

const cookieOpts = () => ({
  path: "/",
  httpOnly: true,
  sameSite: "Lax" as const,
  secure: env().NODE_ENV === "production",
});

function setSignupCookie(c: Ctx, nonce: string) {
  setCookie(c, SIGNUP_COOKIE, nonce, { ...cookieOpts(), maxAge: SIGNUP_TTL_S });
}

/** The signup nonce this browser holds, if well-formed. */
function signupNonce(c: Ctx): string | null {
  const v = getCookie(c, SIGNUP_COOKIE);
  return v && NONCE_RE.test(v) ? v : null;
}

/** True when a Shopify-signed `timestamp` is recent. */
export function freshTimestamp(ts: string | undefined): boolean {
  const n = Number(ts);
  return Number.isFinite(n) && Math.abs(Date.now() / 1000 - n) <= MAX_LINK_AGE_S;
}

/**
 * Signup calls carry no session cookie, so the app-wide CSRF check doesn't cover them.
 * They must come from our web app too.
 */
function requireAppOrigin(c: Ctx) {
  const origin = c.req.header("origin") ?? c.req.header("referer");
  let ok = false;
  try {
    ok = !!origin && new URL(origin).origin === new URL(env().APP_URL).origin;
  } catch {
    ok = false;
  }
  if (!ok) throw new HttpError(403, "Cross-site request blocked", "csrf");
}

// ---------------- Signup record (coord) ----------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Save the record with a fresh TTL, or keep an existing expiry (`expiresAt`, ms). */
async function saveSignup(deps: Pick<Deps, "coord">, nonce: string, data: SignupData, expiresAt?: number): Promise<SignupRecord | null> {
  const until = expiresAt ?? Date.now() + SIGNUP_TTL_S * 1000;
  const ttl = Math.floor((until - Date.now()) / 1000);
  if (ttl <= 0) return null;
  const rec: SignupRecord = { ...data, expiresAt: until };
  await deps.coord.put(signupKey(nonce), JSON.stringify(rec), ttl);
  return rec;
}

function parseRecord(raw: string | null): SignupRecord | null {
  if (!raw) return null;
  try {
    const rec = JSON.parse(raw) as SignupRecord;
    return typeof rec.email === "string" && rec.expiresAt > Date.now() ? rec : null;
  } catch {
    return null;
  }
}

/**
 * keep: put it back unchanged (same expiry) · consume: leave it deleted · data: save it (TTL
 * refreshed) · { update }: save it with the record's current expiry.
 */
type Change = "keep" | "consume" | SignupData | { update: SignupData };

/**
 * Serialized read-modify-write of one signup record. Coord has no plain read: a read takes the
 * value and puts it back, and the lock stops concurrent requests (a double-submitted finish,
 * say) from seeing the gap. `fn` must be synchronous so the lock is held only briefly.
 */
async function signupTx<T>(
  deps: Pick<Deps, "coord">,
  nonce: string,
  fn: (rec: SignupRecord | null) => { change: Change; result: T },
): Promise<T> {
  const key = signupKey(nonce);
  const lock = `lock:${key}`;
  for (let i = 0; !(await deps.coord.acquire(lock, 5000)); i++) {
    if (i >= 30) throw new HttpError(503, "Still working on your previous request. Please try again.", "busy");
    await sleep(100);
  }
  try {
    const raw = await deps.coord.take(key);
    const rec = parseRecord(raw);
    let out: { change: Change; result: T } = { change: "keep", result: undefined as T };
    try {
      out = fn(rec);
      return out.result;
    } finally {
      // Also runs when `fn` throws, so a failed request never loses the record.
      const change = out.change;
      if (change === "keep") {
        const ttl = rec ? Math.floor((rec.expiresAt - Date.now()) / 1000) : 0;
        if (raw && ttl > 0) await deps.coord.put(key, raw, ttl);
      } else if (change === "consume") {
        // Left deleted.
      } else if ("update" in change) {
        if (rec) await saveSignup(deps, nonce, change.update, rec.expiresAt);
      } else {
        await saveSignup(deps, nonce, change);
      }
    }
  } finally {
    await deps.coord.release(lock);
  }
}

const readSignup = (deps: Pick<Deps, "coord">, nonce: string) =>
  signupTx(deps, nonce, (rec) => ({ change: "keep", result: rec }));

/** Apply `update` to a live record; null from `update` leaves it untouched. Returns the saved data. */
const writeSignup = (deps: Pick<Deps, "coord">, nonce: string, update: (rec: SignupRecord) => SignupData | null) =>
  signupTx(deps, nonce, (rec) => {
    const next = rec ? update(rec) : null;
    return next ? { change: next, result: next } : { change: "keep", result: null };
  });

// Tokens are encrypted with the store-token keyring; the AAD ties them to this signup.
const tokenAad = (nonce: string, kind: "access" | "refresh") => `signup:${nonce}:${kind}`;

function sealTokens(nonce: string, t: TokenResponse): SignupTokens {
  const k = keyring();
  return {
    accessTokenEnc: encrypt(t.accessToken, k, tokenAad(nonce, "access")),
    refreshTokenEnc: t.refreshToken ? encrypt(t.refreshToken, k, tokenAad(nonce, "refresh")) : null,
    accessTokenExpiresAt: t.accessTokenExpiresAt?.toISOString() ?? null,
    refreshTokenExpiresAt: t.refreshTokenExpiresAt?.toISOString() ?? null,
    scopes: t.scopes,
  };
}

function openTokens(nonce: string, s: SignupTokens): TokenResponse {
  const k = keyring();
  return {
    accessToken: decrypt(s.accessTokenEnc, k, tokenAad(nonce, "access")),
    refreshToken: s.refreshTokenEnc ? decrypt(s.refreshTokenEnc, k, tokenAad(nonce, "refresh")) : null,
    accessTokenExpiresAt: s.accessTokenExpiresAt ? new Date(s.accessTokenExpiresAt) : null,
    refreshTokenExpiresAt: s.refreshTokenExpiresAt ? new Date(s.refreshTokenExpiresAt) : null,
    scopes: s.scopes,
  };
}

/** Per-user authorize for `shop` (through app `app`), continuing this browser's signup. */
const signupAuthorize = (c: Ctx, deps: Deps, nonce: string, shop: string, app: string) =>
  authorizeRedirect(c, deps, { mode: "signup_user", signup: nonce, shop, app }, { perUser: true });

/** A signed-in user may take over a signup only with an email this browser has proven. */
function mayClaim(user: User, rec: CompleteSignup): boolean {
  if (!user.emailVerified) return false;
  const email = user.email.toLowerCase();
  const su = rec.shopifyUser;
  return email === rec.email || email === rec.provenEmail || (su.emailVerified && email === su.email);
}

// ---------------- Hooks used by /shopify/launch and /shopify/callback ----------------

/**
 * /shopify/launch without a verified session: if this browser started a signup (managed install
 * path), remember the store Shopify just installed on and continue with the per-user authorize.
 * Returns the redirect, or null when there's no signup to continue.
 */
export async function signupLaunch(c: Ctx, deps: Deps, shop: string, timestamp: string | undefined, app: string): Promise<string | null> {
  const nonce = signupNonce(c);
  // Launch links are signed but never expire; only a fresh one may steer a signup.
  if (!nonce || !freshTimestamp(timestamp)) return null;
  // A (new) store starts the Shopify part over: nothing from an earlier pass carries across.
  const saved = await writeSignup(deps, nonce, (rec) => ({ email: rec.email, shop, app }));
  if (!saved) return null;
  setSignupCookie(c, nonce);
  return signupAuthorize(c, deps, nonce, shop, app);
}

/**
 * /shopify/callback for the signup modes, after the shared HMAC/timestamp/state checks.
 * Both legs require the signup cookie the state was issued to.
 */
export async function signupCallback(
  c: Ctx,
  deps: Deps,
  state: SignupState,
  shop: string,
  code: string,
  fail: (code: string) => Response,
  app: ShopifyApp,
): Promise<Response> {
  const nonce = signupNonce(c);
  if (!nonce) return fail("signup_expired");
  if (!safeEqual(nonce, state.signup)) return fail("state_mismatch");
  return state.mode === "signup_user" ? userGrant(c, deps, nonce, shop, code, fail, app) : offlineGrant(c, deps, nonce, shop, code, fail, app);
}

/** Leg 1: the online (per-user) grant tells us which Shopify staff account approved. */
async function userGrant(c: Ctx, deps: Deps, nonce: string, shop: string, code: string, fail: (code: string) => Response, app: ShopifyApp) {
  if (!(await readSignup(deps, nonce))) return fail("signup_expired");
  let online: OnlineTokenResponse;
  try {
    online = await exchangeCodeForOnlineToken(shopifyConfig(app), shop, code, deps.fetchImpl);
  } catch (err) {
    logger.error({ err, shop }, "shopify per-user code exchange failed");
    return fail("exchange_failed");
  }
  // A new Shopify identity starts the rest over: no tokens or proofs from an earlier pass survive.
  const saved = await writeSignup(deps, nonce, (rec) => ({ email: rec.email, shop, app: app.key, shopifyUser: online.associatedUser }));
  if (!saved) return fail("signup_expired");
  setSignupCookie(c, nonce);
  // Leg 2: the store-level token. The app is installed by now, so Shopify returns without a prompt.
  return c.redirect(await authorizeRedirect(c, deps, { mode: "signup_offline", signup: nonce, shop, app: app.key }));
}

/** Leg 2: the permanent offline token background sync runs on, kept encrypted until claim. */
async function offlineGrant(c: Ctx, deps: Deps, nonce: string, shop: string, code: string, fail: (code: string) => Response, app: ShopifyApp) {
  const rec = await readSignup(deps, nonce);
  if (!rec?.shopifyUser) return fail("signup_expired");
  if (rec.shop !== shop) return fail("shop_mismatch");
  if ((rec.app ?? DEFAULT_APP) !== app.key) return fail("app_mismatch");
  let token: TokenResponse;
  try {
    token = await exchangeCodeForToken(shopifyConfig(app), shop, code, deps.fetchImpl);
  } catch (err) {
    logger.error({ err, shop }, "shopify code exchange failed");
    return fail("exchange_failed");
  }
  const granted = expandScopes(token.scopes);
  if (!REQUIRED_SCOPES.every((s) => granted.has(s))) return fail("missing_required_scopes");

  const tokens = sealTokens(nonce, token);
  const saved = await writeSignup(deps, nonce, (r) => (r.shop === shop && r.shopifyUser && (r.app ?? DEFAULT_APP) === app.key ? { ...r, tokens } : null));
  if (!saved) return fail("signup_expired");
  setSignupCookie(c, nonce);
  return c.redirect(`${env().APP_URL}/start?step=finish`);
}

/** Forget this browser's signup: delete the record and the cookie (cancel, logout). */
export async function clearSignup(c: Ctx, deps: Pick<Deps, "coord">) {
  const nonce = signupNonce(c);
  if (nonce) await deps.coord.take(signupKey(nonce));
  if (getCookie(c, SIGNUP_COOKIE) !== undefined) deleteCookie(c, SIGNUP_COOKIE, cookieOpts());
}

// ---------------- Routes ----------------

export function shopifySignupRoutes(app: App, deps: Deps) {
  /** Panel 1 → "Continue with Shopify": remember the email in this browser and send them to Shopify. */
  app.post("/auth/shopify/start", async (c) => {
    requireAppOrigin(c);
    await limit(deps.coord, `rl:shopify-start:ip:${clientIp(c)}`, 20, 3600);
    const input = z
      .object({
        email: z.string().trim().toLowerCase().email().max(254),
        shop: z.string().trim().max(255).nullish(),
      })
      .parse(await body(c));
    let shop: string | null = null;
    if (input.shop) {
      shop = normalizeShopDomain(input.shop);
      if (!shop) throw new HttpError(400, "Enter your store's myshopify.com address", "invalid_shop");
    }

    // A store with its own app (custom distribution for that client) installs through it.
    // Resolved before anything is written, so a store we can't serve leaves the browser's
    // current signup alone. Shopify's store picker can only offer an app every store may
    // install, so without an address the main app has to be the unrestricted one.
    const app = shop ? installApp(shop) : shopifyApp(DEFAULT_APP);
    if (!shop && !servesAnyShop(app)) {
      throw new HttpError(400, "Enter your store's myshopify.com address to continue", "shop_required");
    }

    // One signup per browser: starting again abandons the previous one.
    const previous = signupNonce(c);
    if (previous) await deps.coord.take(signupKey(previous));
    const nonce = randomToken(24);
    await saveSignup(deps, nonce, { email: input.email, app: app.key });
    setSignupCookie(c, nonce);
    // Without a store address, Shopify's managed install lets them sign in and pick one;
    // it then opens /shopify/launch, which continues from the cookie.
    let url: string;
    if (shop) {
      url = await signupAuthorize(c, deps, nonce, shop, app.key); // logs the handoff itself
    } else {
      // `shop` is null by construction here: Shopify's picker, not us, chooses the store. Logged
      // anyway so a merchant Shopify turns away still leaves a handoff with no matching return —
      // this is the product's main entry point, and it was the one flow the diagnostic missed.
      logHandoff("signup", null, app, shopifyConfig(app).scopes);
      url = managedInstallUrl(app.clientId);
    }
    return c.json({ url });
  });

  /**
   * Back from Shopify: sign in directly when Shopify vouches for the email (verified, and either
   * the one typed on panel 1 or explicitly chosen), otherwise ask the web app to prove the typed
   * email with a one-time code. Never says whether an account exists.
   */
  app.post("/auth/shopify/finish", async (c) => {
    requireAppOrigin(c);
    await limit(deps.coord, `rl:shopify-finish:ip:${clientIp(c)}`, 30, 900);
    const { useShopifyEmail } = z.object({ useShopifyEmail: z.boolean().optional() }).parse(await body(c));
    const nonce = signupNonce(c);
    if (!nonce) throw signupExpired();

    const outcome = await signupTx<{ rec: CompleteSignup; trusted: boolean; lapsed?: boolean } | null>(deps, nonce, (rec) => {
      if (!isComplete(rec)) return { change: "keep", result: null };
      const su = rec.shopifyUser;
      const trusted = su.emailVerified && (su.email === rec.email || useShopifyEmail === true);
      if (!trusted) return { change: "keep", result: { rec, trusted } };
      // A sign-in token is handed out once (plus a short retry window), never on and on. After
      // that the email has to be proven again by code — not "start again": a session that failed
      // to mint (our database down for a few minutes) would otherwise cost both Shopify approvals.
      if (rec.tokenIssuedAt && Date.now() - rec.tokenIssuedAt > TOKEN_REISSUE_MS) {
        return { change: "keep", result: { rec, trusted: false, lapsed: true } };
      }
      // Remember the proof for claim (which may come from a session minted elsewhere). The
      // record keeps its original expiry: finishing doesn't extend its life.
      const { expiresAt: _expiresAt, ...data } = rec;
      const update: SignupData = { ...data, provenEmail: su.email, tokenIssuedAt: rec.tokenIssuedAt ?? Date.now() };
      return { change: { update }, result: { rec, trusted } };
    });
    if (!outcome) throw signupExpired();
    const { rec, trusted, lapsed } = outcome;
    const su = rec.shopifyUser;
    if (lapsed) {
      // The code goes to the email the first finish signed in (claim accepts it once proven). No
      // "Continue as" offer: that is the finish that just lapsed. `reason` lets the page say so,
      // rather than claim Shopify couldn't confirm the email.
      return c.json({ status: "verify_email", email: rec.provenEmail ?? rec.email, shopifyEmail: null, reason: "reissue_expired" });
    }
    if (!trusted) {
      return c.json({ status: "verify_email", email: rec.email, shopifyEmail: su.emailVerified ? su.email : null });
    }
    const uid = await deps.auth.upsertVerifiedEmailUser(su.email);
    const customToken = await deps.auth.createCustomToken(uid);
    // Client: signInWithCustomToken → POST /auth/session → POST /auth/shopify/claim.
    return c.json({ status: "signed_in", customToken, email: su.email });
  });

  /** Signed in with a proven email: connect the store (single use) and say where to go next. */
  app.post("/auth/shopify/claim", async (c) => {
    const user = await requireUser(c, deps);
    const nonce = signupNonce(c);
    if (!nonce) throw signupExpired();

    const outcome = await signupTx<"expired" | "mismatch" | CompleteSignup>(deps, nonce, (rec) => {
      if (!isComplete(rec)) return { change: "keep", result: "expired" };
      if (!mayClaim(user, rec)) return { change: "keep", result: "mismatch" };
      return { change: "consume", result: rec };
    });
    if (outcome === "expired") throw signupExpired();
    if (outcome === "mismatch") {
      throw new HttpError(403, "Sign in with the email address you started with to connect this store.", "email_mismatch");
    }

    let result;
    try {
      result = await connectStore(deps, {
        user,
        shop: outcome.shop,
        token: openTokens(nonce, outcome.tokens),
        appKey: outcome.app ?? DEFAULT_APP,
        shopifyUser: outcome.shopifyUser,
        ip: clientIp(c),
      });
    } catch (err) {
      if (err instanceof HttpError) {
        // An answer (store taken, ...) ends this signup.
        deleteCookie(c, SIGNUP_COOKIE, cookieOpts());
      } else {
        // A crash (database blip) must not cost the merchant both Shopify approvals: put the
        // record back so "Try again" can finish.
        const { expiresAt, ...data } = outcome;
        await saveSignup(deps, nonce, data, expiresAt).catch(() => {});
      }
      throw err;
    }
    deleteCookie(c, SIGNUP_COOKIE, cookieOpts());
    return c.json(result);
  });

  /** "Start again" on /start: drop this browser's signup (and anything it was holding). */
  app.post("/auth/shopify/cancel", async (c) => {
    requireAppOrigin(c);
    await clearSignup(c, deps);
    return c.json({ ok: true });
  });
}

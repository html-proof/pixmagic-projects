import { createHmac, randomBytes } from "node:crypto";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { env, keyring } from "@app/core";
import { decrypt, encrypt, safeEqual } from "@app/shared";
import type { SignInMethod } from "./cognito.js";

/**
 * Our session: an httpOnly cookie we sign ourselves, issued once Cognito's tokens have been
 * verified, plus the Cognito refresh token in a second httpOnly cookie, encrypted.
 *
 * - The browser's JavaScript never sees a Cognito token (no XSS-readable credential).
 * - Checking a request costs one HMAC, not an RSA verification or a call to AWS.
 * - Every REVALIDATE_MS the refresh token is spent with Cognito: a user disabled or deleted there,
 *   or signed out everywhere, loses the session at that point (and refresh-token rotation, when
 *   on, replaces the token each time).
 * - Signing out retires the session id (coord) until it would have expired; "sign out
 *   everywhere" also moves users.sessions_valid_after, which every session is checked against.
 */
export const SESSION_COOKIE = "__session";
export const REFRESH_COOKIE = "__session_rt";
/**
 * A session opened from a shared invitation link lives in a cookie of its own, never in
 * __session: opening a link in a browser that is signed in to an account leaves that account's
 * session exactly as it was, and the two are never merged. Which one a request uses is the web
 * app's choice per tab (SESSION_CONTEXT_HEADER); either cookie only ever grants what it grants.
 */
export const SHARE_COOKIE = "__share";
/**
 * "shared": this request is from a tab showing a shared dashboard, so it uses the __share session
 * (and nothing of an account signed in alongside). GET requests that can't carry a header (a
 * download link) say the same with `?ctx=shared`.
 */
export const SESSION_CONTEXT_HEADER = "x-bi-context";
/** A session lasts this long from sign-in, however active (sign in again after). */
export const SESSION_TTL_MS = 5 * 24 * 3600 * 1000;
/**
 * How often a session is re-checked with Cognito: also the longest an account deleted or disabled
 * in Cognito itself (the console, the CLI) can stay signed in. One refresh per active session per
 * minute; Cognito bills by monthly active user, not by refresh.
 */
export const REVALIDATE_MS = 60 * 1000;

export interface SessionClaims {
  v: 1;
  /** Session id: what signing out retires. */
  sid: string;
  /** users.id */
  uid: string;
  /** Cognito sub of the identity signed in with. */
  sub: string;
  /** Its Cognito user name (refreshes and admin calls address it by that). */
  un: string;
  /** "link": opened from a Team & Access invitation link (no Cognito sign-in; see `ws`). */
  m: SignInMethod | "link";
  /** Issued at / expires (ms). */
  iat: number;
  exp: number;
  /** When the person last proved who they are with Cognito (seconds, the ID token's auth_time). */
  at: number;
  /** Last checked with Cognito (ms). */
  ck: number;
  /**
   * true: this sign-in proved the account's own address (Cognito vouched for it, and it is the
   * account's). A Google account linked under another address proves that address only, so its
   * sessions never count as the person again for a change that could lock them out
   * (account.ts, reauthenticate).
   */
  own?: true;
  /**
   * false: "Keep me signed in" was unticked, so the cookies end when the browser closes (and at
   * exp, whichever comes first). Absent: they last until exp, as every session did before.
   */
  keep?: false;
  /**
   * Set on a session opened from an invitation link: the one workspace it opens. Nothing else of
   * the account is reachable with it (context.ts: requireUser refuses it unless a route allows a
   * shared session, requireWorkspace answers 404 for any other workspace).
   */
  ws?: string;
}

const signingKey = () => createHmac("sha256", env().SESSION_SECRET).update("session-cookie-v1").digest();
const sign = (payload: string) => createHmac("sha256", signingKey()).update(payload).digest("base64url");

export function signSession(claims: SessionClaims): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

/** The claims of a genuine, unexpired session cookie; null for anything else. */
export function readSession(cookie: string | undefined, now = Date.now()): SessionClaims | null {
  if (!cookie) return null;
  const dot = cookie.indexOf(".");
  if (dot < 1) return null;
  const payload = cookie.slice(0, dot);
  if (!safeEqual(cookie.slice(dot + 1), sign(payload))) return null;
  let claims: SessionClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as SessionClaims;
  } catch {
    return null;
  }
  if (claims?.v !== 1 || typeof claims.uid !== "string" || typeof claims.sid !== "string" || !(claims.exp > now)) return null;
  return claims;
}

export function newSession(
  input: { userId: string; sub: string; username: string; method: SignInMethod; authTime: number; keep?: boolean; ownAddress?: boolean },
  now = Date.now(),
): SessionClaims {
  return {
    v: 1,
    sid: randomBytes(18).toString("base64url"),
    uid: input.userId,
    sub: input.sub,
    un: input.username,
    m: input.method,
    iat: now,
    exp: now + SESSION_TTL_MS,
    at: input.authTime,
    ck: now,
    ...(input.keep === false && { keep: false as const }),
    ...(input.ownAddress && { own: true as const }),
  };
}

/** Whether a verified sign-in (its ID token's claims) proves `accountEmail`, the account's own address. */
export const provesAddress = (claims: { email: string | null; emailVerified: boolean }, accountEmail: string) =>
  claims.emailVerified && !!claims.email && claims.email.toLowerCase() === accountEmail.toLowerCase();

/**
 * A session for someone who opened an invitation link (POST /invitations/open): this workspace
 * only, read-only, no Cognito identity behind it (so nothing to re-check there; the membership is
 * checked on every request instead). It ends with the link (`until`: the invitation's end date or
 * the access's, whichever is first) if that is sooner than SESSION_TTL_MS. Opening the link again
 * starts a new one.
 */
export function newLinkSession(input: { userId: string; workspaceId: string; until?: Date | null }, now = Date.now()): SessionClaims {
  const exp = Math.min(now + SESSION_TTL_MS, input.until ? input.until.getTime() : Infinity);
  return {
    v: 1,
    sid: randomBytes(18).toString("base64url"),
    uid: input.userId,
    sub: "",
    un: "",
    m: "link",
    iat: now,
    exp,
    at: Math.floor(now / 1000),
    ck: now,
    ws: input.workspaceId,
  };
}

const secure = () => env().NODE_ENV === "production";
/** The API's path prefix (/api): the refresh token is only ever sent there, never with pages or assets. */
export const apiPath = () => {
  try {
    return new URL(env().API_URL).pathname.replace(/\/+$/, "") || "/";
  } catch {
    return "/";
  }
};
const RT_AAD = "session-refresh-token-v1";

/**
 * Set (or re-set) the session cookie, and the refresh-token cookie when a token is given. A
 * session that isn't kept gets browser-session cookies (no Max-Age); exp still ends it.
 */
export function setSessionCookies(c: Context, claims: SessionClaims, refreshToken?: string) {
  const maxAge = claims.keep === false ? undefined : Math.max(0, Math.floor((claims.exp - Date.now()) / 1000));
  setCookie(c, SESSION_COOKIE, signSession(claims), { path: "/", httpOnly: true, sameSite: "Lax", secure: secure(), maxAge });
  if (refreshToken) {
    setCookie(c, REFRESH_COOKIE, encrypt(refreshToken, keyring(), `${RT_AAD}:${claims.sub}`), {
      path: apiPath(),
      httpOnly: true,
      sameSite: "Lax",
      secure: secure(),
      maxAge,
    });
  }
}

/** The shared-link session's cookie (SHARE_COOKIE): httpOnly, first-party, ending with the session. */
export function setShareCookie(c: Context, claims: SessionClaims) {
  const maxAge = Math.max(0, Math.floor((claims.exp - Date.now()) / 1000));
  setCookie(c, SHARE_COOKIE, signSession(claims), { path: "/", httpOnly: true, sameSite: "Lax", secure: secure(), maxAge });
}

export function clearShareCookie(c: Context) {
  deleteCookie(c, SHARE_COOKIE, { path: "/", httpOnly: true, sameSite: "Lax", secure: secure() });
}

export function clearSessionCookies(c: Context) {
  deleteCookie(c, SESSION_COOKIE, { path: "/", httpOnly: true, sameSite: "Lax", secure: secure() });
  deleteCookie(c, REFRESH_COOKIE, { path: apiPath(), httpOnly: true, sameSite: "Lax", secure: secure() });
}

/**
 * The Cognito refresh token for this session. undefined: no cookie (e.g. a request outside /api);
 * null: a cookie that doesn't decrypt for this session (tampered, or for another identity).
 */
export function readRefreshToken(c: Context, claims: SessionClaims): string | null | undefined {
  const raw = getCookie(c, REFRESH_COOKIE);
  if (!raw) return undefined;
  try {
    return decrypt(raw, keyring(), `${RT_AAD}:${claims.sub}`);
  } catch {
    return null;
  }
}

/** Coordinator key that retires one signed-out session until it would have expired. */
export const retiredSessionKey = (sid: string) => `session:retired:${sid}`;

/**
 * Changes that give someone a way into the account (a new sign-in method, another email address,
 * deleting it) need the person again: a sign-in this recent, or their password.
 */
export const RECENT_SIGN_IN_S = 15 * 60;
export const signedInRecently = (claims: SessionClaims, now = Date.now()) => now / 1000 - claims.at <= RECENT_SIGN_IN_S;

/**
 * Coordinator key: this session re-entered its password to link a Google account
 * (POST /auth/account/methods/google/prepare). The start of the link spends it; it lasts
 * LINK_PROOF_TTL_S, and only this session (its id is in an httpOnly cookie) can spend it.
 */
export const linkProofKey = (sid: string) => `link:proof:${sid}`;
export const LINK_PROOF_TTL_S = 300;

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
/** A session lasts this long from sign-in, however active (sign in again after). */
export const SESSION_TTL_MS = 5 * 24 * 3600 * 1000;
/** How often a session is re-checked with Cognito. */
export const REVALIDATE_MS = 10 * 60 * 1000;

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
  m: SignInMethod;
  /** Issued at / expires (ms). */
  iat: number;
  exp: number;
  /** When the person last proved who they are with Cognito (seconds, the ID token's auth_time). */
  at: number;
  /** Last checked with Cognito (ms). */
  ck: number;
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

export function newSession(input: { userId: string; sub: string; username: string; method: SignInMethod; authTime: number }, now = Date.now()): SessionClaims {
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

/** Set (or re-set) the session cookie, and the refresh-token cookie when a token is given. */
export function setSessionCookies(c: Context, claims: SessionClaims, refreshToken?: string) {
  const maxAge = Math.max(0, Math.floor((claims.exp - Date.now()) / 1000));
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

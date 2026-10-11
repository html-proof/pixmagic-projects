import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { systemDb, type User } from "@app/db";
import { can, sha256Hex, type Permission, type Role } from "@app/shared";
import { env, logger, type BlobStore, type Coord, type FetchLike, type Mailer, type Queues } from "@app/core";
import { FirebaseUnavailableError, type AuthProvider } from "./authProvider.js";

export interface Deps {
  auth: AuthProvider;
  coord: Coord;
  queues: Queues;
  /** Webhook payloads too large for a queue message. */
  payloads: BlobStore;
  mailer: Mailer;
  fetchImpl: FetchLike;
  /** Coarse per-IP limiter (Workers Rate Limiting binding). Returns false when over the limit. */
  globalLimit?: (key: string) => Promise<boolean>;
  /** Whether the database answers right now. Defaults to `dbReachable()`; tests inject an outage. */
  dbHealthy?: () => Promise<boolean>;
}

export type AppEnv = { Variables: { user?: User } };
export type Ctx = Context<AppEnv>;

export const SESSION_COOKIE = "__session";

/**
 * Coordinator key that retires one session cookie after it is signed out (POST /auth/logout).
 * Firebase can only revoke every session of an account at once, so a single browser's sign-out
 * is recorded here instead, by the cookie's hash, until the cookie would have expired anyway.
 */
export const retiredSessionKey = (cookie: string) => `session:retired:${sha256Hex(cookie)}`;

export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code = "error",
  ) {
    super(message);
  }
}

/**
 * The request must come from our web app. The app-wide CSRF check only covers requests that
 * already carry a session cookie, so sign-in and signup calls need this themselves: `body()`
 * parses any content type, so a cross-site `text/plain` form could otherwise POST an attacker's
 * ID token to /auth/session and sign the visitor's browser in to the attacker's account (login
 * CSRF), and whatever store they connect next would land in the attacker's workspace.
 */
export function requireAppOrigin(c: Ctx) {
  const origin = c.req.header("origin") ?? c.req.header("referer");
  let ok = false;
  try {
    ok = !!origin && new URL(origin).origin === new URL(env().APP_URL).origin;
  } catch {
    ok = false;
  }
  if (!ok) throw new HttpError(403, "Cross-site request blocked", "csrf");
}

/** Parsed JSON body, or `{}` when absent/invalid (zod then reports what's missing). */
export async function body(c: Ctx): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}

/** Resolve the signed-in user from the Firebase session cookie. */
export async function loadUser(c: Ctx, deps: Deps): Promise<User | null> {
  const cached = c.get("user");
  if (cached) return cached;
  const cookie = getCookie(c, SESSION_COOKIE);
  if (!cookie) return null;
  let claims: Awaited<ReturnType<AuthProvider["verifySessionCookie"]>>;
  try {
    claims = await deps.auth.verifySessionCookie(cookie);
  } catch (err) {
    // An unverifiable session cookie means "signed out" — unless the reason is that Firebase is
    // unreachable, which would otherwise sign every logged-in user out for the length of an outage.
    if (err instanceof FirebaseUnavailableError) {
      throw new HttpError(503, "We can't verify your session right now. Please try again in a moment.", "auth_unavailable");
    }
    return null;
  }
  // Signed out in this browser: Firebase would still accept the cookie, so check our own record.
  // Not being able to look is an outage, never "signed out" (see above).
  const retired = await deps.coord.peek(retiredSessionKey(cookie)).catch((err: unknown) => {
    logger.error({ err, path: c.req.path }, "signed-out session check failed");
    throw new HttpError(503, "We can't verify your session right now. Please try again in a moment.", "auth_unavailable");
  });
  if (retired) return null;
  // The session is genuine from here on, so failing to load its user is our outage (the database
  // is reachable only through a tunnel that drops), never "signed out": a 401 would send a
  // signed-in merchant to sign in, or into sign-up, for the length of the blip. A missing row
  // isn't an error (null above), so every failure here is one — no need to classify it.
  try {
    let user = await systemDb.user.findUnique({ where: { firebaseUid: claims.uid } });
    if (!user) return null;
    if (claims.emailVerified && !user.emailVerified) {
      user = await systemDb.user.update({ where: { id: user.id }, data: { emailVerified: true } });
    }
    c.set("user", user);
    return user;
  } catch (err) {
    logger.error({ err, path: c.req.path }, "session user lookup failed");
    throw new HttpError(503, "We can't reach your account right now. Please try again in a moment.", "db_unavailable");
  }
}

export async function requireUser(c: Ctx, deps: Deps): Promise<User> {
  const user = await loadUser(c, deps);
  if (!user) throw new HttpError(401, "Sign in required", "unauthenticated");
  return user;
}

export interface WorkspaceAccess {
  workspaceId: string;
  role: Role;
  user: User | null;
}

/**
 * Authorize access to a workspace either by session membership or by API key
 * (API keys are read-only: they act as "viewer"). Non-members get 404, not 403,
 * so workspace ids can't be probed.
 */
export async function requireWorkspace(c: Ctx, deps: Deps, workspaceId: string, perm: Permission): Promise<WorkspaceAccess> {
  const authz = c.req.header("authorization");
  if (authz?.startsWith("Bearer sk_")) {
    const key = await systemDb.apiKey.findUnique({ where: { keyHash: sha256Hex(authz.slice(7)) } });
    if (!key || key.revokedAt || key.workspaceId !== workspaceId) throw new HttpError(404, "Not found", "not_found");
    if (!can("viewer", perm)) throw new HttpError(403, "API keys are read-only", "forbidden");
    await systemDb.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
    return { workspaceId, role: "viewer", user: null };
  }
  const user = await requireUser(c, deps);
  const m = await systemDb.membership.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: user.id } },
  });
  if (!m) throw new HttpError(404, "Not found", "not_found");
  if (!can(m.role, perm)) throw new HttpError(403, "You don't have permission to do that", "forbidden");
  return { workspaceId, role: m.role, user };
}

/** Client IP as seen by Cloudflare's edge. */
export function clientIp(c: Ctx): string {
  return c.req.header("cf-connecting-ip") ?? c.req.header("x-real-ip") ?? "unknown";
}

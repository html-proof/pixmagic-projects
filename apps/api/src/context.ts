import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { systemDb, type User } from "@app/db";
import { can, sha256Hex, type Permission, type Role } from "@app/shared";
import { addLogContext, env, logger, type BlobStore, type Coord, type FetchLike, type Mailer, type Queues, type SmtpConnect } from "@app/core";
import { CognitoError, CognitoUnavailableError, type CognitoAuth } from "./cognito.js";
import type { LegacyPasswordCheck } from "./legacyFirebase.js";
import { clearSessionCookies, readRefreshToken, readSession, retiredSessionKey, REVALIDATE_MS, SESSION_COOKIE, setSessionCookies, type SessionClaims } from "./session.js";

export { retiredSessionKey, SESSION_COOKIE };

export interface Deps {
  /** Amazon Cognito: every sign-in, sign-up and password operation. */
  auth: CognitoAuth;
  /** While accounts move over from Firebase: checks a password Cognito doesn't know yet (legacyFirebase.ts). */
  legacy?: LegacyPasswordCheck | null;
  coord: Coord;
  queues: Queues;
  /** Webhook payloads too large for a queue message. */
  payloads: BlobStore;
  mailer: Mailer;
  fetchImpl: FetchLike;
  /** Outbound TCP for SMTP email accounts (apps/aws/src/nodeSmtp.ts). Absent: SMTP accounts can't connect. */
  smtpConnect?: SmtpConnect;
  /** Coarse per-IP limiter (apps/aws/src/app.ts, on the coordinator). Returns false when over the limit. */
  globalLimit?: (key: string) => Promise<boolean>;
  /** Whether the database answers right now. Defaults to `dbReachable()`; tests inject an outage. */
  dbHealthy?: () => Promise<boolean>;
}

export type AppEnv = { Variables: { user?: User; session?: SessionClaims } };
export type Ctx = Context<AppEnv>;

export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code = "error",
    /** Sent as Retry-After (seconds) with a 429 or 503. */
    public retryAfterSec?: number,
  ) {
    super(message);
    this.name = "HttpError";
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

const UNAVAILABLE = "We can't verify your session right now. Please try again in a moment.";

/** Cognito's answers to a refresh that mean the session must end (disabled, deleted, signed out everywhere). */
const SESSION_REVOKED = new Set(["NotAuthorizedException", "UserNotFoundException", "InvalidToken"]);

/**
 * Re-check a session with Cognito by spending its refresh token (at most every REVALIDATE_MS, and
 * by one request at a time). Cognito unreachable is not a verdict: the session carries on and is
 * checked again on a later request.
 */
async function revalidate(c: Ctx, deps: Deps, s: SessionClaims): Promise<"ok" | "verified" | "revoked" | "skipped"> {
  const rt = readRefreshToken(c, s);
  if (rt === undefined) return "skipped";
  if (rt === null) return "revoked";
  if (!(await deps.coord.acquire(`session:check:${s.sid}`, 30_000).catch(() => false))) return "skipped";
  try {
    const tokens = await deps.auth.refresh(rt, s.un);
    const id = await deps.auth.verifyIdToken(tokens.idToken);
    if (id.sub !== s.sub) return "revoked";
    const next = { ...s, ck: Date.now() };
    setSessionCookies(c, next, tokens.refreshToken);
    c.set("session", next);
    return id.emailVerified ? "verified" : "ok";
  } catch (err) {
    if (err instanceof CognitoError && SESSION_REVOKED.has(err.code)) {
      logger.info({ cognitoError: err.code }, "session ended by Cognito");
      return "revoked";
    }
    logger.warn({ err }, "could not re-check a session with Cognito; carrying on");
    return "skipped";
  } finally {
    await deps.coord.release(`session:check:${s.sid}`).catch(() => {});
  }
}

/** Resolve the signed-in user from our session cookie (session.ts). */
export async function loadUser(c: Ctx, deps: Deps): Promise<User | null> {
  const cached = c.get("user");
  if (cached) return cached;
  const s = readSession(getCookie(c, SESSION_COOKIE));
  if (!s) return null;
  // Signed out in this browser: check our own record. Not being able to look is an outage, never
  // "signed out": that would send every logged-in user round a sign-in loop for its length.
  const retired = await deps.coord.peek(retiredSessionKey(s.sid)).catch((err: unknown) => {
    logger.error({ err, path: c.req.path }, "signed-out session check failed");
    throw new HttpError(503, UNAVAILABLE, "auth_unavailable");
  });
  if (retired) return null;
  // The session is genuine from here on, so failing to load its user is our outage (the database
  // is reachable only through a tunnel that drops), never "signed out".
  let user: User | null;
  try {
    user = await systemDb.user.findUnique({ where: { id: s.uid } });
  } catch (err) {
    logger.error({ err, path: c.req.path }, "session user lookup failed");
    throw new HttpError(503, "We can't reach your account right now. Please try again in a moment.", "db_unavailable");
  }
  if (!user) return null;
  // "Sign out everywhere" since this session started.
  if (user.sessionsValidAfter && s.iat < user.sessionsValidAfter.getTime()) return null;
  c.set("session", s);
  if (Date.now() - s.ck > REVALIDATE_MS) {
    const checked = await revalidate(c, deps, s);
    if (checked === "revoked") {
      clearSessionCookies(c);
      return null;
    }
    if (checked === "verified" && !user.emailVerified) {
      user = await systemDb.user.update({ where: { id: user.id }, data: { emailVerified: true } }).catch(() => user!);
    }
  }
  c.set("user", user);
  addLogContext({ userId: user.id });
  return user;
}

/** The signed-in session's claims (after requireUser). */
export function sessionOf(c: Ctx): SessionClaims {
  const s = c.get("session");
  if (!s) throw new HttpError(401, "Sign in required", "unauthenticated");
  return s;
}

/**
 * A Cognito access token for the signed-in person, for changes to their own Cognito user
 * (password, email, sign-out everywhere). Spends the session's refresh token.
 */
export async function accessTokenFor(c: Ctx, deps: Deps): Promise<string> {
  const s = sessionOf(c);
  const rt = readRefreshToken(c, s);
  if (!rt) throw new HttpError(401, "Please sign in again to change this.", "reauth_required");
  try {
    const tokens = await deps.auth.refresh(rt, s.un);
    if (tokens.refreshToken) setSessionCookies(c, s, tokens.refreshToken);
    return tokens.accessToken;
  } catch (err) {
    if (err instanceof CognitoUnavailableError) throw new HttpError(503, UNAVAILABLE, "auth_unavailable");
    if (err instanceof CognitoError && SESSION_REVOKED.has(err.code)) throw new HttpError(401, "Please sign in again to change this.", "reauth_required");
    throw err;
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
    addLogContext({ workspaceId, apiKeyId: key.id });
    return { workspaceId, role: "viewer", user: null };
  }
  const user = await requireUser(c, deps);
  const m = await systemDb.membership.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: user.id } },
  });
  if (!m) throw new HttpError(404, "Not found", "not_found");
  if (!can(m.role, perm)) throw new HttpError(403, "You don't have permission to do that", "forbidden");
  addLogContext({ workspaceId });
  return { workspaceId, role: m.role, user };
}

/**
 * The client's address, as the host in front of the API passes it on. On AWS that is the address
 * CloudFront saw (apps/aws/src/index.ts drops whatever the client sent under this name and sets
 * it), so a client can't forge it; the local server passes on what it is given (tests use that to
 * be many visitors). x-real-ip can be sent by anyone, so it only counts outside production (local
 * tools and tests), where it can't be used to dodge a per-IP limit.
 */
export const CLIENT_IP_HEADER = "x-insights-client-ip";

export function clientIp(c: Ctx): string {
  const edge = c.req.header(CLIENT_IP_HEADER);
  if (edge) return edge;
  return (env().NODE_ENV !== "production" && c.req.header("x-real-ip")) || "unknown";
}

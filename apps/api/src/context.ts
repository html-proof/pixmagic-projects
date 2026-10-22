import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { systemDb, type User } from "@app/db";
import { allows, hasFullAccess, LEGACY_GRANTS, sha256Hex, type AccessNeed, type MemberAccess, type Role } from "@app/shared";
import type { StaffAccess, StaffRole } from "@app/shared/staff";
import { addLogContext, env, logger, memberState, sessionAccess, type BlobStore, type Coord, type FetchLike, type Mailer, type Queues, type SmtpConnect } from "@app/core";
import { CognitoError, CognitoUnavailableError, type CognitoAuth } from "./cognito.js";
import { endSessions, touchSession } from "./devices.js";
import { clearSessionCookies, readRefreshToken, readSession, retiredSessionKey, REVALIDATE_MS, SESSION_CONTEXT_HEADER, SESSION_COOKIE, setSessionCookies, SHARE_COOKIE, type SessionClaims } from "./session.js";

export { retiredSessionKey, SESSION_COOKIE, SHARE_COOKIE };

export interface Deps {
  /** Amazon Cognito: every sign-in, sign-up and password operation. */
  auth: CognitoAuth;
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

/** The sign-in a session came from, as the account has it (auth_identities): its address at its last sign-in. */
export interface SessionIdentity {
  email: string | null;
}

export type AppEnv = { Variables: { user?: User; session?: SessionClaims; sessionCookie?: "own" | "share"; identity?: SessionIdentity } };
export type Ctx = Context<AppEnv>;

export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code = "error",
    /** Sent as Retry-After (seconds) with a 429 or 503. */
    public retryAfterSec?: number,
    /** More for the page than words (sent as `detail`): e.g. the countdowns a refused resend still has to show. */
    public detail?: unknown,
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
 * checked again on a later request. "verified": Cognito vouches for `accountEmail`, the account's
 * own address (a Google account linked under another address vouches for that one only).
 *
 * A session due for its check whose refresh-token cookie didn't come along ends. That cookie is set
 * with the session's and goes with every request to the API's path (API_URL), where the web app
 * and Shopify's returns call it, so a request without it is from someone who kept the session
 * cookie alone: a session nothing done in Cognito (a deleted user, a sign-out everywhere) could end.
 */
async function revalidate(c: Ctx, deps: Deps, s: SessionClaims, accountEmail: string): Promise<"ok" | "verified" | "revoked" | "skipped"> {
  if (s.m === "link") return "skipped";
  const rt = readRefreshToken(c, s);
  if (!rt) return "revoked";
  if (!(await deps.coord.acquire(`session:check:${s.sid}`, 30_000).catch(() => false))) return "skipped";
  try {
    const tokens = await deps.auth.refresh(rt, s.un || s.sub);
    const id = await deps.auth.verifyIdToken(tokens.idToken);
    if (id.sub !== s.sub) return "revoked";
    const next = { ...s, ck: Date.now() };
    setSessionCookies(c, next, tokens.refreshToken);
    c.set("session", next);
    return id.emailVerified && id.email?.toLowerCase() === accountEmail.toLowerCase() ? "verified" : "ok";
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

/**
 * Resolve the signed-in user from our session cookie (session.ts). A session opened from an
 * invitation link counts only where the caller says it may (`shared`): elsewhere it is no
 * sign-in at all, so nothing account-wide (connecting a store, an OAuth callback) acts on it.
 */
export async function loadUser(c: Ctx, deps: Deps, opts: { shared?: boolean } = {}): Promise<User | null> {
  const user = await loadSessionUser(c, deps);
  if (user && sharedWorkspace(c) && !opts.shared) return null;
  return user;
}

/** The one workspace this request's session may open, when it was opened from an invitation link. */
export function sharedWorkspace(c: Ctx): string | null {
  return c.get("session")?.ws ?? null;
}

/** Whether this request's session was opened from a shared link (read-only, one workspace). */
export const isLinkSession = (c: Ctx) => c.get("session")?.m === "link";

/** The tab asked for its shared-dashboard session (header, or `?ctx=shared` on a plain GET such as a download). */
const wantsShared = (c: Ctx) => c.req.header(SESSION_CONTEXT_HEADER) === "shared" || (c.req.method === "GET" && c.req.query("ctx") === "shared");

/**
 * Which of this browser's sessions a request uses. A tab showing a shared dashboard asks for the
 * shared-link one (__share) and gets only that, never an account signed in alongside. Any other
 * request uses the account's session (__session); with none, the shared-link one, so a new tab
 * opened by someone who only has the link still works. The two are never combined: each grants
 * exactly what it grants. (A link session from before __share existed sits in __session and is
 * read as one wherever it is found.)
 */
export function pickSession(c: Ctx, now = Date.now()): { claims: SessionClaims; cookie: "own" | "share" } | null {
  const own = readSession(getCookie(c, SESSION_COOKIE), now);
  const shareRaw = readSession(getCookie(c, SHARE_COOKIE), now);
  const share = shareRaw?.m === "link" && shareRaw.ws ? shareRaw : null;
  if (wantsShared(c)) {
    if (share) return { claims: share, cookie: "share" };
    return own?.m === "link" ? { claims: own, cookie: "own" } : null;
  }
  if (own) return { claims: own, cookie: "own" };
  return share ? { claims: share, cookie: "share" } : null;
}

async function loadSessionUser(c: Ctx, deps: Deps): Promise<User | null> {
  const cached = c.get("user");
  if (cached) return cached;
  const picked = pickSession(c);
  if (!picked) return null;
  const s = picked.claims;
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
  let identity: SessionIdentity | undefined;
  try {
    const row = await systemDb.user.findUnique({
      where: { id: s.uid },
      include: { identities: { where: { provider: "cognito", subject: s.sub }, select: { email: true }, take: 1 } },
    });
    if (row) {
      const { identities, ...rest } = row;
      user = rest;
      identity = identities[0];
    } else {
      user = null;
    }
  } catch (err) {
    logger.error({ err, path: c.req.path }, "session user lookup failed");
    throw new HttpError(503, "We can't reach your account right now. Please try again in a moment.", "db_unavailable");
  }
  if (!user) return null;
  // "Sign out everywhere" since this session started.
  if (user.sessionsValidAfter && s.iat < user.sessionsValidAfter.getTime()) return null;
  // The way it signed in is no longer the account's (removed in Settings, or by a take-over): its
  // sessions end with it, on their very next request, whatever cookies they still hold. A session
  // opened from a shared link has no sign-in of its own (its membership is checked instead).
  if (s.m !== "link" && !identity) return null;
  c.set("session", s);
  c.set("sessionCookie", picked.cookie);
  if (identity) c.set("identity", identity);
  if (Date.now() - s.ck > REVALIDATE_MS) {
    const checked = await revalidate(c, deps, s, user.email);
    if (checked === "revoked") {
      clearSessionCookies(c);
      await endSessions({ sid: s.sid });
      return null;
    }
    // Once a minute at most: the device list's "last active", and its row for a session older than the list.
    if (checked !== "skipped") await touchSession(c, s, clientIp(c));
    if (checked === "verified" && !user.emailVerified) {
      user = await systemDb.user.update({ where: { id: user.id }, data: { emailVerified: true } }).catch(() => user!);
    }
  }
  c.set("user", user);
  addLogContext({ userId: user.id });
  return user;
}

/**
 * Whether this session's sign-in proved the account's own address and still names it: Cognito
 * vouched for the address at sign-in (SessionClaims.own), and it is the account's address now.
 * A Google account linked under another address never does (after requireUser).
 */
export function sessionProvesAddress(c: Ctx, user: User): boolean {
  const id = c.get("identity");
  return !!c.get("session")?.own && !!id?.email && id.email.toLowerCase() === user.email.toLowerCase();
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
    const tokens = await deps.auth.refresh(rt, s.un || s.sub);
    if (tokens.refreshToken) setSessionCookies(c, s, tokens.refreshToken);
    return tokens.accessToken;
  } catch (err) {
    if (err instanceof CognitoUnavailableError) throw new HttpError(503, UNAVAILABLE, "auth_unavailable");
    if (err instanceof CognitoError && SESSION_REVOKED.has(err.code)) throw new HttpError(401, "Please sign in again to change this.", "reauth_required");
    throw err;
  }
}

/**
 * The signed-in user. A session opened from an invitation link is refused (403 `shared_link`)
 * unless `shared` is passed: it opens the shared workspace's pages, not the account (profile,
 * password, other workspaces, connecting stores). requireWorkspace and requireStaff pass it, and
 * also check the workspace is the shared one.
 */
export async function requireUser(c: Ctx, deps: Deps, opts: { shared?: boolean } = {}): Promise<User> {
  const user = await loadUser(c, deps, { shared: true });
  if (!user) throw new HttpError(401, "Sign in required", "unauthenticated");
  if (sharedWorkspace(c) && !opts.shared) {
    throw new HttpError(403, "You opened bizinsights from a shared link, which opens only the dashboard shared with you. Sign in to your own account to do this.", SHARED_LINK);
  }
  return user;
}

/** Refused because the session was opened from an invitation link, which can't do this (the web app offers to sign in). */
export const SHARED_LINK = "shared_link";

/**
 * The signed-in member for a request about `workspaceId`: any session, including one opened from
 * an invitation link as long as it is for this workspace (another one answers 404, like any
 * workspace someone doesn't belong to).
 */
export async function requireMemberUser(c: Ctx, deps: Deps, workspaceId: string): Promise<User> {
  const user = await requireUser(c, deps, { shared: true });
  const ws = sharedWorkspace(c);
  if (ws && ws !== workspaceId) throw new HttpError(404, "Not found", "not_found");
  return user;
}

export interface WorkspaceAccess {
  workspaceId: string;
  role: Role;
  user: User | null;
  /**
   * What this member (or API key) may see and do: their role and granted permissions (Team &
   * Access). For a session opened from a shared link, the read-only part of it (an owner's or
   * admin's link session is a viewer with every view and export permission).
   */
  access: MemberAccess;
  /** The member's Staff Management role (null for API keys and members without one). */
  staffRole: StaffRole | null;
  /** The fingerprint of `access` (x-access-fp; GET .../access answers with the same). */
  fingerprint?: string;
  /** Opened from a shared link: read-only, whatever the membership allows. */
  link?: boolean;
  /** Their Staff Management rights in this session (read-only through a shared link). */
  staff?: StaffAccess;
}

/** What workspace API keys may read: what viewers could before Team & Access (read-only, no customers' personal data). */
const API_KEY_ACCESS: MemberAccess = { role: "viewer", permissions: LEGACY_GRANTS.viewer };

/**
 * Sent with every response to a member's workspace request: `<workspace id>:<fingerprint>` of
 * their access. The web app keeps the fingerprint it last saw and reloads the member's permissions
 * the moment one differs, so a change an owner makes shows in the member's sidebar within one
 * request. Enforcement never depends on it: every request is checked against the database.
 */
export const ACCESS_FP_HEADER = "x-access-fp";

/** Refused because the member's access to this workspace was revoked (the web app shows a page saying so). */
export const ACCESS_REVOKED = "access_revoked";
/** Refused because the access an invitation gave has reached its end date and wasn't renewed. */
export const ACCESS_EXPIRED = "access_expired";

/**
 * Authorize access to a workspace either by session membership or by API key (read-only). `need`
 * is a workspace permission (roles.ts) or one or more of Team & Access's (access.ts: any of them
 * will do); owners and admins hold every one of the latter, other members only what was granted to
 * them. Read from the database on every request, so a change or a revocation applies to the very
 * next one. Non-members get 404, not 403, so workspace ids can't be probed.
 */
export async function requireWorkspace(c: Ctx, deps: Deps, workspaceId: string, need: AccessNeed): Promise<WorkspaceAccess> {
  const authz = c.req.header("authorization");
  if (authz?.startsWith("Bearer sk_")) {
    const key = await systemDb.apiKey.findUnique({ where: { keyHash: sha256Hex(authz.slice(7)) } });
    if (!key || key.revokedAt || key.workspaceId !== workspaceId) throw new HttpError(404, "Not found", "not_found");
    if (!allows(API_KEY_ACCESS, need)) throw new HttpError(403, "API keys are read-only", "forbidden");
    await systemDb.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
    addLogContext({ workspaceId, apiKeyId: key.id });
    return { workspaceId, role: "viewer", user: null, access: API_KEY_ACCESS, staffRole: null };
  }
  const user = await requireMemberUser(c, deps, workspaceId);
  const m = await systemDb.membership.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: user.id } },
  });
  if (!m) throw new HttpError(404, "Not found", "not_found");
  const link = isLinkSession(c);
  const eff = sessionAccess(m, { link });
  // Before the verdict, so a refusal also tells the browser its permissions changed.
  c.header(ACCESS_FP_HEADER, `${workspaceId}:${eff.fingerprint}`);
  assertActive(eff.state);
  if (!allows(eff.access, need)) {
    throw new HttpError(403, link ? "The shared dashboard is view-only, and shows only what the owner chose to share." : "You don't have permission to do that", "forbidden");
  }
  addLogContext({ workspaceId });
  return { workspaceId, role: eff.access.role, user, access: eff.access, staffRole: m.staffRole, staff: eff.staff, fingerprint: eff.fingerprint, link };
}

/** A revoked membership, or one whose end date has passed, grants nothing (403 with the reason, which the web app explains). */
export function assertActive(state: "active" | "revoked" | "expired") {
  if (state === "revoked") throw new HttpError(403, "Your access to this workspace has been revoked. Ask an owner or admin if you still need it.", ACCESS_REVOKED);
  if (state === "expired") throw new HttpError(403, "Your access to this shared dashboard has ended. Ask the person who shared it to renew it.", ACCESS_EXPIRED);
}

/**
 * Whether a membership allows `need`, for the checks made outside a request's own workspace check
 * (an OAuth callback re-checking the person who started it). A revoked membership allows nothing.
 */
export function memberAllows(m: { role: Role; permissions: string[]; revokedAt: Date | null; accessExpiresAt?: Date | null } | null, need: AccessNeed): boolean {
  return !!m && memberState(m) === "active" && allows({ role: m.role, permissions: m.permissions }, need);
}

/** Owners and admins only (pages of the workspace itself: billing, members, stores). */
export function requireFullAccess(a: WorkspaceAccess) {
  if (!hasFullAccess(a.access.role)) throw new HttpError(403, "You don't have permission to do that", "forbidden");
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

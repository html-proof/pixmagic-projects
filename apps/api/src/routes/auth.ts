import { createHmac } from "node:crypto";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { systemDb } from "@app/db";
import { appStoreWorkspace, authEmail, employmentsForUser, env, keyring, logger, sessionAccess } from "@app/core";
import { ACCESS_KEYS, accountPasswordProblem, decrypt, DISPLAY_NAME_MAX, EMAIL_CODE_RE, encrypt, hasFullAccess, pkcePair, randomToken, safeEqual, sha256Hex } from "@app/shared";
import { body, clientIp, HttpError, isLinkSession, loadUser, pickSession, requireAppOrigin, requireUser, sessionOf, SESSION_COOKIE, sharedWorkspace, type Ctx, type Deps } from "../context.js";
import { CognitoError, CognitoUnavailableError, unguessablePassword, type CognitoTokens, type CognitoUser, type FederatedProvider, type SignInMethod, type SignInResult } from "../cognito.js";
import type { User } from "@app/db";
import {
  challengeTiming,
  CODE_EXPIRED,
  CODE_INCORRECT,
  CODE_RESENT,
  CODE_UNAVAILABLE,
  codeExpired,
  codeHash,
  coordinatorDown,
  countAttempt,
  discardSignUpCode,
  expiredCode,
  incorrectCode,
  limitCodeSends,
  MAX_ATTEMPTS,
  newCode,
  pendingSignUpCode,
  recordSignUpCode,
  requireLiveSignUpCode,
  requireResendAllowed,
  RESEND_AFTER_S,
  tooManyAttempts,
  type CodeChallenge,
} from "../emailCode.js";
import { cognitoUsernameKey, LinkRequired, notifyMethodAdded, notifyPasswordChanged, recordAuthEvent, resolveUser, withPicture } from "../identity.js";
import { endSessions, recordFailedSignIn, recordSession } from "../devices.js";
import { apiPath, clearSessionCookies, clearShareCookie, linkProofKey, newSession, provesAddress, readRefreshToken, readSession, retiredSessionKey, setSessionCookies, signedInRecently } from "../session.js";
import type { App } from "../app.js";
import { limit, LIMITS } from "../rateLimit.js";

const emailSchema = z
  .string()
  .trim()
  .email("Enter a valid email address.")
  .max(254)
  .transform((e) => e.toLowerCase());
const codeSchema = z.string().trim().regex(EMAIL_CODE_RE, "Enter the 6-digit code from the email.");
const passwordSchema = z.string().min(1, "Enter your password.").max(256);
/** "Keep me signed in" on the sign-in page; left out (older pages, scripts) means yes. */
const keepSchema = z.boolean().optional();

/** "Continue with ..." in our URLs, and Cognito's name for each provider. */
const PROVIDERS: Record<string, FederatedProvider> = { google: "Google" };
const OAUTH_STATE_TTL_S = 600;
const MAX_PENDING_STATES = 5;
const OAUTH_COOKIE = "__oauth";
const OTP_COOKIE = "__otp";
/**
 * Between the password and the authenticator app's code: names the pending sign-in in the
 * coordinator, which holds Cognito's challenge session (the browser never sees it). Lives as long
 * as that session does (the app client's AuthSessionValidity, 3 minutes: infra/aws/cognito.yaml).
 */
const MFA_COOKIE = "__mfa";
const MFA_TTL_S = 180;
/**
 * Between the password and the emailed code (emailCode.ts): names the pending sign-in in the
 * coordinator, which holds Cognito's tokens (encrypted) until the code is entered. A pending
 * sign-in lives this long: room for a few codes, each of which lives a minute.
 */
const LOGIN_COOKIE = "__login";
const LOGIN_PENDING_TTL_S = 600;
/**
 * Between Continue with Google meeting an existing account (identity.ts, LinkRequired) and this
 * browser signing in to that account: names the held Google account in the coordinator. Long
 * enough for a password, its code, or a password reset on the way.
 */
const PENDING_LINK_COOKIE = "__link";
const PENDING_LINK_TTL_S = 900;
const pendingLinkKey = (id: string) => `auth:link:${id}`;
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;
const pendingStates = (cookie: string | undefined) => (cookie ?? "").split(".").filter((n) => TOKEN_RE.test(n));
const totpSchema = z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code from your authenticator app.");

/** A "Continue with Google" in progress: what the callback needs, kept in the coordinator under its state. */
interface PendingSignIn {
  provider: FederatedProvider;
  verifier: string;
  nonce: string;
  returnTo: string | null;
  /** "Keep me signed in" was unticked on the page that started it. */
  keep?: false;
  /** Set when a signed-in person links Google from Settings: their users.id (no new session then). */
  linkUserId?: string;
}

/** A sign-in waiting for the authenticator app's code (askForCode), in the coordinator under mfa:signin:<id>. */
interface PendingCode {
  /** The address signed in with (the per-account rate limit). */
  email: string;
  /** Cognito's name for the user, from its challenge: what the answer must give. */
  username: string;
  session: string;
  keep?: false;
}

/**
 * A password sign-in waiting for the emailed code (askForEmailedCode), in the coordinator under
 * auth:login:<id>. Nothing of it reaches the browser but the id, in an httpOnly cookie.
 */
interface PendingLogin {
  v: 1;
  /** The address signed in with (the code went there; the per-address limits). */
  email: string;
  /** Cognito's tokens from the password step, AES-GCM under TOKEN_ENCRYPTION_KEYS, bound to the id. */
  tokens: string;
  /** The code's HMAC (emailCode.ts codeHash), never the code. */
  codeHash: string;
  /** When the code was emailed: it lives CODE_TTL_S from here. */
  issuedAt: number;
  keep?: false;
}

/**
 * A Google account held until this browser signs in to the existing account with its address
 * (holdForLink), in the coordinator under auth:link:<id>: who the Google account is (no token of
 * it), and the account it is for. The browser holds only the id, in an httpOnly cookie.
 */
interface PendingLink {
  v: 1;
  /** The account with the Google account's address (users.id), and that address. */
  userId: string;
  email: string;
  /** The Google account's Cognito user: what joins the account's ways in. */
  sub: string;
  username: string;
  method: SignInMethod;
  picture: string | null;
}

/**
 * A code we emailed to claim an address nobody proved (see `unproven` below), in the coordinator
 * under claimKey: only its hash, the Cognito user it was for, and the sign-up's name.
 */
interface AddressClaim {
  username: string;
  codeHash: string;
  name: string | null;
}
/** As long as Cognito keeps its own codes for the same step (the emails say so). */
const CLAIM_TTL_S = { signup: 24 * 3600, reset: 3600 } as const;
const claimKey = (email: string) => `auth:claim:${sha256Hex(email)}`;
const claimCodeHash = (email: string, code: string) => createHmac("sha256", env().OTP_PEPPER).update(`address-claim:${email}:${code}`).digest("hex");

/** Where linking Google from Settings goes back to when the page didn't say. */
const LINK_RETURN = "/settings/security";
const BASE = "http://app.invalid";

/**
 * A page of this site to send the browser back to, as the browser will read it, or null. The
 * check runs on the normalised path too: dot segments ("/..//evil.example", "/%2e%2e//evil.example")
 * pass a check of the raw text but resolve to "//evil.example", another site.
 */
function safeReturnTo(raw: unknown): string | null {
  if (!safePath(raw)) return null;
  let u: URL;
  try {
    u = new URL(raw, BASE);
  } catch {
    return null;
  }
  const out = `${u.pathname}${u.search}${u.hash}`;
  return u.origin === BASE && safePath(out) ? out : null;
}

/** `path` (from safeReturnTo) with one query parameter set; LINK_RETURN if it somehow isn't safe. */
function withParam(path: string, key: string, value: string) {
  const u = new URL(safeReturnTo(path) ?? LINK_RETURN, BASE);
  u.searchParams.set(key, value);
  return `${u.pathname}${u.search}${u.hash}`;
}

const UNAVAILABLE = "We can't reach the sign-in service right now. Please try again in a moment.";
const CODE_SENT = "If that address can receive email, a code is on its way. It expires in a few minutes.";

/**
 * Federated providers switched on for this deployment: Google on the app's own client once the
 * app's own sign-in runs and the client is configured (AUTH_MODE, localAuth.ts); otherwise
 * COGNITO_IDENTITY_PROVIDERS, plus a domain.
 */
export function enabledProviders(): Set<FederatedProvider> {
  const e = env();
  if (e.AUTH_MODE !== "cognito" && e.GOOGLE_SIGNIN_CLIENT_ID && e.GOOGLE_SIGNIN_CLIENT_SECRET) return new Set(["Google"]);
  if (e.AUTH_MODE === "local") return new Set();
  if (!e.COGNITO_DOMAIN) return new Set();
  return new Set(
    e.COGNITO_IDENTITY_PROVIDERS.split(",")
      .map((p) => p.trim())
      .filter((p): p is FederatedProvider => p === "Google"),
  );
}

/** Whether a password sign-in also asks for the emailed code (AUTH_LOGIN_EMAIL_CODE; apps/aws/src/settings.ts). */
export const loginCodeOn = () => env().AUTH_LOGIN_EMAIL_CODE === "1";
/** An address the emailed code isn't asked of (AUTH_LOGIN_CODE_EXEMPT): a reviewer's account, whose inbox they can't read. */
const loginCodeExempt = (email: string) => env().AUTH_LOGIN_CODE_EXEMPT.split(",").some((a) => a.trim().toLowerCase() === email);

/** Same-origin paths only (the web app's isSafePath). */
// eslint-disable-next-line no-control-regex -- rejecting control characters is the point
const safePath = (p: unknown): p is string => typeof p === "string" && p.startsWith("/") && !p.startsWith("//") && !/[\\\u0000-\u001f\u007f]/.test(p) && p.length < 1000;

/**
 * Turn a Cognito failure into what the person is told. Cognito's own messages are written for
 * developers ("Password did not conform with policy: ...") and can say whether an account exists,
 * so none of them reaches the browser.
 */
export function cognitoFailure(err: unknown, at: string): HttpError {
  if (err instanceof HttpError) return err;
  if (err instanceof CognitoUnavailableError) {
    logger.error({ err, at }, "sign-in service unavailable");
    return new HttpError(503, UNAVAILABLE, "auth_unavailable");
  }
  if (!(err instanceof CognitoError)) {
    logger.error({ err, at }, "unexpected sign-in failure");
    return new HttpError(500, "Something went wrong. Please try again.", "internal");
  }
  logger.warn({ cognitoError: err.code, at }, "Cognito refused");
  switch (err.code) {
    case "NotAuthorizedException":
    case "UserNotFoundException":
      return new HttpError(401, "That email and password don't match.", "invalid_credentials");
    case "UserNotConfirmedException":
      return new HttpError(403, "Confirm your email address first: enter the code we emailed you.", "unconfirmed");
    case "PasswordResetRequiredException":
      return new HttpError(403, "You need to choose a new password. We've emailed you a code to do it.", "reset_required");
    case "UsernameExistsException":
    case "AliasExistsException":
      return new HttpError(409, "An account with that email already exists. Log in instead, or reset your password if you've forgotten it.", "account_exists");
    case "InvalidPasswordException":
      return new HttpError(400, "Choose a stronger password: at least 8 characters, with no spaces at the start or end.", "weak_password");
    case "CodeMismatchException":
      return new HttpError(400, CODE_INCORRECT, "invalid_code");
    case "ExpiredCodeException":
      return new HttpError(400, CODE_EXPIRED, "expired_code");
    case "LimitExceededException":
    case "TooManyRequestsException":
    case "TooManyFailedAttemptsException":
      return new HttpError(429, "Too many attempts. Please wait a few minutes and try again.", "rate_limited");
    case "CodeDeliveryFailureException":
      return new HttpError(503, "We couldn't send you an email right now. Please try again in a moment.", "email_unavailable");
    case "UserLambdaValidationException":
    case "InvalidParameterException":
      return new HttpError(400, "We couldn't do that with the details given. Please check them and try again.", "invalid_request");
    case "NotConfigured":
      return new HttpError(503, "This sign-in option isn't set up yet.", "not_configured");
    case "InvalidToken":
      return new HttpError(401, "We couldn't verify that sign-in. Please try again.", "invalid_token");
    // Two-step verification: a wrong code while setting it up, or the pool without it switched on.
    case "EnableSoftwareTokenMFAException":
      return new HttpError(400, "That code isn't right. Check the time on your phone, then enter the code your app shows now.", "invalid_code");
    case "SoftwareTokenMFANotFoundException":
    case "MFAMethodNotFoundException":
      return new HttpError(503, "Two-step verification isn't available right now. Please try again later.", "mfa_unavailable");
  }
  return new HttpError(400, "We couldn't complete that. Please try again.", "auth_failed");
}

const isCognito = (err: unknown, ...codes: string[]) => err instanceof CognitoError && codes.includes(err.code);

/**
 * `.catch` for a database call on the sign-in path. The database is reachable only through a
 * tunnel that drops, so a failure there is our outage: say "try again" (503), not a bare 500.
 * HttpErrors (e.g. "that email belongs to another account") pass through.
 */
function dbOutage(message: string) {
  return (err: unknown): never => {
    if (err instanceof HttpError) throw err;
    logger.error({ err }, "database unreachable during sign-in");
    throw new HttpError(503, message, "db_unavailable");
  };
}
const SIGN_IN_UNAVAILABLE = "We can't finish signing you in right now. Please try again in a moment.";

export function publicUser(u: { id: string; email: string; emailVerified: boolean; displayName: string | null; timezone: string; avatarUrl?: string | null }) {
  return { id: u.id, email: u.email, emailVerified: u.emailVerified, displayName: u.displayName, timezone: u.timezone, avatarUrl: u.avatarUrl ?? null };
}

export function authRoutes(app: App, deps: Deps) {
  const oauthCookiePath = () => `${apiPath() === "/" ? "" : apiPath()}/auth/oauth`;
  // Every route that signs in (the password, its codes, the emailed code, Google) and /auth/pending-link.
  const authCookiePath = () => `${apiPath() === "/" ? "" : apiPath()}/auth`;
  const otpCookiePath = () => `${apiPath() === "/" ? "" : apiPath()}/auth/otp`;
  // /auth/login and /auth/login/mfa.
  const mfaCookiePath = () => `${apiPath() === "/" ? "" : apiPath()}/auth/login`;
  const cookieBase = () => ({ httpOnly: true, sameSite: "Lax" as const, secure: env().NODE_ENV === "production" });
  const redirectUri = () => `${env().APP_URL}/auth/callback`;

  /**
   * Cognito's tokens → our session. The ID token is verified here (signature against the pool's
   * keys, issuer, audience = our app client, token_use, expiry, and the nonce for OAuth); only
   * then is the person looked up, linked or created, and the session cookie set. A Google account
   * held for this account in this browser (holdForLink) joins it now: the sign-in proved it.
   * LinkRequired passes through for the Google callback to hold the Google account.
   */
  async function finishSignIn(c: Ctx, tokens: CognitoTokens, opts: { nonce?: string; keep?: boolean } = {}) {
    const claims = await deps.auth.verifyIdToken(tokens.idToken, { nonce: opts.nonce }).catch((err) => {
      throw cognitoFailure(err, "verify ID token");
    });
    const resolved = await resolveUser(claims, { ip: clientIp(c), auth: deps.auth }).catch((err: unknown) => {
      if (err instanceof LinkRequired) throw err;
      return dbOutage(SIGN_IN_UNAVAILABLE)(err);
    });
    const s = newSession({
      userId: resolved.id,
      sub: claims.sub,
      username: claims.username,
      method: claims.method,
      authTime: claims.authTime,
      keep: opts.keep,
      ownAddress: provesAddress(claims, resolved.email),
    });
    setSessionCookies(c, s, tokens.refreshToken);
    // Security trail: who signed in, how and from where (user id, never the email or a token).
    logger.info({ event: "session_created", userId: resolved.id, method: claims.method, ip: clientIp(c) }, "signed in");
    // Settings → Security: this device, and the sign-in in the account's activity.
    await recordSession(c, s, clientIp(c));
    return completePendingLink(c, resolved);
  }

  // ---------------- Continue with Google meets an existing account: sign in to it once ----------------

  /**
   * Continue with Google met an account with the same address and ways in of its own
   * (LinkRequired): no session, nothing linked or created, and the Google sign-in's refresh
   * token is handed back. Who the Google account is waits in the coordinator, under an id only
   * this browser's httpOnly cookie knows, until this browser signs in to that account
   * (completePendingLink) or the wait runs out. The answer tells the page to ask for that sign-in,
   * naming the account's address: Google has just vouched for it to this person.
   */
  async function holdForLink(c: Ctx, held: LinkRequired, tokens: CognitoTokens) {
    if (tokens.refreshToken) await deps.auth.revokeRefreshToken(tokens.refreshToken).catch((err: unknown) => logger.warn({ err }, "could not revoke a held Google sign-in's refresh token"));
    // An earlier hold in this browser gives way to this one.
    const earlier = getCookie(c, PENDING_LINK_COOKIE);
    if (earlier && TOKEN_RE.test(earlier)) await deps.coord.take(pendingLinkKey(earlier)).catch(() => null);
    const { account, claims } = held;
    const id = randomToken(24);
    const pending: PendingLink = { v: 1, userId: account.id, email: account.email, sub: claims.sub, username: claims.username, method: claims.method, picture: claims.picture ?? null };
    await deps.coord.put(pendingLinkKey(id), JSON.stringify(pending), PENDING_LINK_TTL_S).catch((err: unknown) => {
      logger.error({ err }, "could not hold a Google account for linking");
      throw new HttpError(503, UNAVAILABLE, "auth_unavailable");
    });
    setCookie(c, PENDING_LINK_COOKIE, id, { ...cookieBase(), path: authCookiePath(), maxAge: PENDING_LINK_TTL_S });
    await recordAuthEvent("identity_link_pending", account.id, clientIp(c), { cognitoSub: claims.sub, method: claims.method, cognitoUsername: cognitoUsernameKey(claims.username) });
    logger.info({ event: "identity_link_pending", userId: account.id, method: claims.method }, "Google sign-in held until its account signs in");
    return { next: "link" as const, provider: claims.method, email: account.email };
  }

  /** The Google account held in this browser (holdForLink), now taken: its cookie and record go. Null when there is none. */
  async function takePendingLink(c: Ctx): Promise<PendingLink | null> {
    const id = getCookie(c, PENDING_LINK_COOKIE);
    if (!id) return null;
    deleteCookie(c, PENDING_LINK_COOKIE, { ...cookieBase(), path: authCookiePath() });
    if (!TOKEN_RE.test(id)) return null;
    const raw = await deps.coord.take(pendingLinkKey(id)).catch((err: unknown) => {
      logger.error({ err }, "could not read a held Google account");
      return null;
    });
    const held = raw ? (JSON.parse(raw) as PendingLink) : null;
    return held?.v === 1 ? held : null;
  }

  /**
   * This browser just signed in to `user`: a Google account held here for that account
   * (holdForLink) joins its ways in, as linking it from Settings would, and the account's address
   * hears of it. One held for another account links nothing; the hold just ends. Best effort:
   * the sign-in stands whatever happens here, and Continue with Google can hold it again.
   */
  async function completePendingLink(c: Ctx, user: User): Promise<User> {
    const held = await takePendingLink(c);
    if (!held) return user;
    if (held.userId !== user.id) {
      logger.info({ userId: user.id }, "a held Google account was for another account: not linked");
      return user;
    }
    try {
      // Linked meanwhile (Settings, another tab), here or to another account: nothing to add.
      if (await systemDb.authIdentity.findUnique({ where: { provider_subject: { provider: "cognito", subject: held.sub } } })) return user;
      // One Google account per account, as in Settings.
      if (await systemDb.authIdentity.count({ where: { userId: user.id, method: held.method } })) {
        logger.info({ userId: user.id }, "a held Google account not linked: the account has one already");
        return user;
      }
      await systemDb.authIdentity.create({
        data: { userId: user.id, provider: "cognito", subject: held.sub, username: held.username, method: held.method, email: held.email, lastUsedAt: new Date() },
      });
    } catch (err) {
      if ((err as { code?: string })?.code !== "P2002") logger.error({ err, userId: user.id }, "could not link a held Google account");
      return user;
    }
    await recordAuthEvent("identity_linked", user.id, clientIp(c), { cognitoSub: held.sub, method: held.method, via: "sign_in", cognitoUsername: cognitoUsernameKey(held.username) });
    logger.info({ event: "identity_linked", userId: user.id, method: held.method }, "Google linked once its account signed in");
    await notifyMethodAdded(deps.mailer, user, { method: held.method, email: held.email });
    return withPicture(user, held);
  }

  /** The sign-in page: whether a Google account is held in this browser for an existing account, and that account's address. */
  app.get("/auth/pending-link", async (c) => {
    const id = getCookie(c, PENDING_LINK_COOKIE);
    const raw = id && TOKEN_RE.test(id) ? await deps.coord.peek(pendingLinkKey(id)).catch(() => null) : null;
    const held = raw ? (JSON.parse(raw) as PendingLink) : null;
    if (held?.v !== 1) {
      if (id) deleteCookie(c, PENDING_LINK_COOKIE, { ...cookieBase(), path: authCookiePath() });
      return c.json({ pending: false as const });
    }
    return c.json({ pending: true as const, provider: held.method, email: held.email });
  });

  /** "Don't link Google" on the sign-in page: the held Google account is let go, nothing linked. */
  app.delete("/auth/pending-link", async (c) => {
    requireAppOrigin(c);
    await takePendingLink(c);
    return c.json({ ok: true });
  });

  function tokensOrChallenge(r: SignInResult): CognitoTokens {
    if ("tokens" in r) return r.tokens;
    logger.warn({ challenge: r.challenge }, "unsupported sign-in challenge");
    if (r.challenge === "NEW_PASSWORD_REQUIRED") {
      throw new HttpError(403, "You need to choose a new password. Use \"Forgot password?\" to get a code.", "reset_required");
    }
    throw new HttpError(403, "Your account needs a sign-in step this app doesn't support yet. Please contact support.", "challenge_unsupported");
  }

  /**
   * The password was right and the account has two-step verification: keep Cognito's challenge
   * session here, bound to this browser by an httpOnly cookie, and ask for the app's code
   * (POST /auth/login/mfa). `null` when the result needs no code.
   */
  async function askForCode(c: Ctx, email: string, r: SignInResult, keep: boolean | undefined) {
    if (!("challenge" in r) || r.challenge !== "SOFTWARE_TOKEN_MFA") return null;
    const id = randomToken(24);
    const pending: PendingCode = { email, username: r.username ?? email, session: r.session, ...(keep === false && { keep: false as const }) };
    await deps.coord.put(`mfa:signin:${id}`, JSON.stringify(pending), MFA_TTL_S).catch((err: unknown) => {
      logger.error({ err }, "could not store a two-step sign-in");
      throw new HttpError(503, UNAVAILABLE, "auth_unavailable");
    });
    setCookie(c, MFA_COOKIE, id, { ...cookieBase(), path: mfaCookiePath(), maxAge: MFA_TTL_S });
    return c.json({ next: "mfa" as const });
  }

  // ---------------- What the sign-in pages offer ----------------

  app.get("/auth/config", (c) => {
    const providers = enabledProviders();
    return c.json({
      providers: { google: providers.has("Google") },
      emailOtp: env().COGNITO_EMAIL_OTP === "1",
      // A password sign-in also asks for a code emailed by the app (askForEmailedCode).
      loginCode: loginCodeOn(),
    });
  });

  // ---------------- Email and password ----------------

  app.post("/auth/login", async (c) => {
    requireAppOrigin(c);
    const input = z.object({ email: emailSchema, password: passwordSchema, keep: keepSchema }).parse(await body(c));
    const ip = clientIp(c);
    await limit(deps.coord, `rl:login:ip:${ip}`, LIMITS.loginIp);
    await limit(deps.coord, `rl:login:email:${sha256Hex(input.email)}`, LIMITS.loginEmail);
    const result = await deps.auth.passwordSignIn(input.email, input.password).catch(async (err: unknown) => {
      // A wrong password for an account here is in that account's sign-in activity.
      if (isCognito(err, "NotAuthorizedException")) await recordFailedSignIn(c, input.email, ip, "password");
      throw cognitoFailure(err, "login");
    });
    const codeStep = await askForCode(c, input.email, result, input.keep);
    if (codeStep) return codeStep;
    const tokens = tokensOrChallenge(result);
    // No authenticator app: the emailed code is the second step (when the deployment asks for one).
    const emailedStep = await askForEmailedCode(c, input.email, tokens, input.keep);
    if (emailedStep) return emailedStep;
    const user = await finishSignIn(c, tokens, { keep: input.keep });
    return c.json({ user: publicUser(user) });
  });

  /** Two-step verification: the code from the authenticator app, after the password (askForCode). */
  app.post("/auth/login/mfa", async (c) => {
    requireAppOrigin(c);
    const input = z.object({ code: totpSchema }).parse(await body(c));
    await limit(deps.coord, `rl:mfa:ip:${clientIp(c)}`, LIMITS.mfaVerifyIp);
    const id = getCookie(c, MFA_COOKIE);
    const timedOut = () => {
      deleteCookie(c, MFA_COOKIE, { ...cookieBase(), path: mfaCookiePath() });
      return new HttpError(400, "That sign-in has timed out. Enter your email and password again.", "mfa_expired");
    };
    if (!id || !TOKEN_RE.test(id)) throw timedOut();
    const key = `mfa:signin:${id}`;
    const raw = await deps.coord.peek(key).catch(() => {
      throw new HttpError(503, UNAVAILABLE, "auth_unavailable");
    });
    if (!raw) throw timedOut();
    const pending = JSON.parse(raw) as PendingCode;
    // Per account as well as per IP: six digits are guessable without both.
    await limit(deps.coord, `rl:mfa:email:${sha256Hex(pending.email)}`, LIMITS.mfaVerifyAccount);
    const result = await deps.auth.answerTotpChallenge(pending.username, pending.session, input.code).catch(async (err: unknown) => {
      if (isCognito(err, "CodeMismatchException")) {
        await recordFailedSignIn(c, pending.email, clientIp(c), "code");
        throw new HttpError(400, "That code isn't right. Enter the code your authenticator app shows now.", "invalid_code");
      }
      // Cognito's session has ended (too long, or too many wrong codes): start again.
      if (isCognito(err, "NotAuthorizedException", "ExpiredCodeException")) {
        await deps.coord.take(key).catch(() => null);
        throw timedOut();
      }
      throw cognitoFailure(err, "two-step sign-in");
    });
    await deps.coord.take(key).catch(() => null);
    deleteCookie(c, MFA_COOKIE, { ...cookieBase(), path: mfaCookiePath() });
    // "Keep me signed in" as it was ticked with the password.
    const user = await finishSignIn(c, tokensOrChallenge(result), { keep: pending.keep });
    return c.json({ user: publicUser(user) });
  });

  // ---------------- The emailed code after the password (emailCode.ts) ----------------

  const loginKey = (id: string) => `auth:login:${id}`;
  /** The counter of guesses at the code a pending sign-in was emailed at `issuedAt`, and what its hash is bound to. */
  const loginCodeScope = (id: string, issuedAt: number) => `login:${id}:${issuedAt}`;
  const tokensAad = (id: string) => `login-code-tokens-v1:${id}`;
  const clearLoginCookie = (c: Ctx) => deleteCookie(c, LOGIN_COOKIE, { ...cookieBase(), path: mfaCookiePath() });
  const loginTimedOut = (c: Ctx) => {
    clearLoginCookie(c);
    return new HttpError(400, "That sign-in has timed out. Enter your email and password again.", "login_expired");
  };
  /** The account's name for the email's greeting; nothing when the address has no account here yet. */
  const greetingName = (email: string) =>
    systemDb.user
      .findUnique({ where: { email }, select: { displayName: true } })
      .then((u) => u?.displayName ?? null)
      .catch(() => null);

  /**
   * The password was right and the account has no authenticator app: hold Cognito's tokens here
   * (encrypted, under an id only this browser's httpOnly cookie knows), email a 6-digit code, and
   * answer `{ next: "code" }`. The session is set only once the code is entered (POST
   * /auth/login/code), so nothing of the sign-in exists in the browser until then. `null` when the
   * deployment doesn't ask for the code (AUTH_LOGIN_EMAIL_CODE), or not of this address
   * (AUTH_LOGIN_CODE_EXEMPT).
   */
  async function askForEmailedCode(c: Ctx, email: string, tokens: CognitoTokens, keep: boolean | undefined) {
    if (!loginCodeOn()) return null;
    if (loginCodeExempt(email)) {
      logger.info({ event: "login_code_exempt" }, "signed in without the emailed code: the address is on AUTH_LOGIN_CODE_EXEMPT");
      return null;
    }
    const id = randomToken(24);
    const pending = { v: 1 as const, email, tokens: encrypt(JSON.stringify(tokens), keyring(), tokensAad(id)), ...(keep === false && { keep: false as const }) };
    try {
      await limitCodeSends(deps.coord, email, clientIp(c));
      const challenge = await emailLoginCode(id, pending, await greetingName(email));
      setCookie(c, LOGIN_COOKIE, id, { ...cookieBase(), path: mfaCookiePath(), maxAge: LOGIN_PENDING_TTL_S });
      return c.json({ next: "code" as const, email, challenge });
    } catch (err) {
      // Nothing of this sign-in may outlive the refusal: the tokens Cognito issued are handed back.
      if (tokens.refreshToken) await deps.auth.revokeRefreshToken(tokens.refreshToken).catch((e: unknown) => logger.warn({ err: e }, "could not revoke a refused sign-in's refresh token"));
      throw err;
    }
  }

  /**
   * A new code for the pending sign-in `id`, emailed, and the sign-in recorded with its hash and
   * the moment it was issued (from which its minute runs). The email goes first: a sign-in whose
   * code couldn't be sent is never recorded as waiting for one.
   */
  async function emailLoginCode(id: string, pending: Omit<PendingLogin, "codeHash" | "issuedAt">, name: string | null): Promise<CodeChallenge> {
    const now = Date.now();
    const code = newCode();
    const mail = authEmail({ trigger: "CustomEmailSender_Authentication", code, name, email: pending.email, appUrl: env().APP_URL, senders: env() })!;
    await deps.mailer.send(pending.email, mail.subject, mail.text, mail.html, { purpose: mail.purpose }).catch((err: unknown) => {
      logger.error({ err }, "could not email a sign-in code");
      throw new HttpError(503, CODE_UNAVAILABLE, "email_unavailable");
    });
    const record: PendingLogin = { ...pending, codeHash: codeHash(loginCodeScope(id, now), code), issuedAt: now };
    await deps.coord.put(loginKey(id), JSON.stringify(record), LOGIN_PENDING_TTL_S).catch((err: unknown) => {
      logger.error({ err }, "could not store a pending sign-in");
      throw coordinatorDown();
    });
    return challengeTiming(now, now);
  }

  /** The pending sign-in this browser's cookie names, or null (no cookie, or none standing any more). */
  async function pendingLogin(c: Ctx): Promise<{ id: string; pending: PendingLogin } | null> {
    const id = getCookie(c, LOGIN_COOKIE);
    if (!id || !TOKEN_RE.test(id)) return null;
    const raw = await deps.coord.peek(loginKey(id)).catch((err: unknown) => {
      logger.error({ err }, "could not read a pending sign-in");
      throw coordinatorDown();
    });
    if (!raw) return null;
    const pending = JSON.parse(raw) as PendingLogin;
    return pending?.v === 1 && typeof pending.issuedAt === "number" ? { id, pending } : null;
  }

  /** Cognito's tokens held for a pending sign-in; null if they don't decrypt for this id (never a sign-in). */
  function heldTokens(id: string, pending: PendingLogin): CognitoTokens | null {
    try {
      return JSON.parse(decrypt(pending.tokens, keyring(), tokensAad(id))) as CognitoTokens;
    } catch {
      return null;
    }
  }

  /** A pending sign-in ends unsigned: its record goes, and Cognito's tokens are handed back. */
  async function dropPendingLogin(c: Ctx, id: string, pending: PendingLogin) {
    await deps.coord.take(loginKey(id)).catch(() => null);
    clearLoginCookie(c);
    const tokens = heldTokens(id, pending);
    if (tokens?.refreshToken) await deps.auth.revokeRefreshToken(tokens.refreshToken).catch((err: unknown) => logger.warn({ err }, "could not revoke a pending sign-in's refresh token"));
  }

  /** Where the sign-in page stands after a reload: the pending sign-in's address and countdowns, or nothing. */
  app.get("/auth/login/code", async (c) => {
    const found = loginCodeOn() ? await pendingLogin(c) : null;
    if (!found) {
      if (getCookie(c, LOGIN_COOKIE)) clearLoginCookie(c);
      return c.json({ pending: false as const });
    }
    return c.json({ pending: true as const, email: found.pending.email, challenge: challengeTiming(found.pending.issuedAt) });
  });

  /**
   * The emailed code after the password. Its minute and its five guesses are checked before the
   * code is looked at; the right code is spent with one atomic delete, so of two answers racing
   * only one signs in; then the session, "Keep me signed in" as ticked with the password.
   */
  app.post("/auth/login/code", async (c) => {
    requireAppOrigin(c);
    const { code } = z.object({ code: codeSchema }).parse(await body(c));
    await limit(deps.coord, `rl:code:verify:${clientIp(c)}`, LIMITS.codeVerifyIp);
    const found = await pendingLogin(c);
    if (!found) throw loginTimedOut(c);
    const { id, pending } = found;
    if (codeExpired(pending.issuedAt)) throw expiredCode();
    const scope = loginCodeScope(id, pending.issuedAt);
    const attempt = await countAttempt(deps.coord, scope);
    if (!safeEqual(pending.codeHash, codeHash(scope, code))) {
      await recordFailedSignIn(c, pending.email, clientIp(c), "code");
      if (attempt >= MAX_ATTEMPTS) {
        // The fifth wrong guess ends the code and the sign-in with it: the password again, then a new code.
        await dropPendingLogin(c, id, pending);
        throw tooManyAttempts();
      }
      throw incorrectCode();
    }
    const spent = await deps.coord.take(loginKey(id)).catch((err: unknown) => {
      logger.error({ err }, "could not spend a sign-in code");
      throw coordinatorDown();
    });
    if (!spent) throw expiredCode();
    clearLoginCookie(c);
    const tokens = heldTokens(id, pending);
    if (!tokens) {
      logger.error("a pending sign-in's tokens did not decrypt");
      throw loginTimedOut(c);
    }
    const user = await finishSignIn(c, tokens, { keep: pending.keep });
    return c.json({ user: publicUser(user) });
  });

  /** Another code for the pending sign-in, once the last one's minute is up (429 with the countdowns before that). */
  app.post("/auth/login/code/resend", async (c) => {
    requireAppOrigin(c);
    const found = await pendingLogin(c);
    if (!found) throw loginTimedOut(c);
    const { id, pending } = found;
    requireResendAllowed(pending.issuedAt);
    await limitCodeSends(deps.coord, pending.email, clientIp(c));
    const challenge = await emailLoginCode(id, pending, await greetingName(pending.email));
    setCookie(c, LOGIN_COOKIE, id, { ...cookieBase(), path: mfaCookiePath(), maxAge: LOGIN_PENDING_TTL_S });
    return c.json({ ok: true, message: CODE_RESENT, challenge });
  });

  /** "Use a different email" or "Back to sign in" on the code step: the pending sign-in ends, its tokens handed back. */
  app.delete("/auth/login/code", async (c) => {
    requireAppOrigin(c);
    const found = await pendingLogin(c);
    if (found) await dropPendingLogin(c, found.id, found.pending);
    else clearLoginCookie(c);
    return c.json({ ok: true });
  });

  // ---------------- Sign-up: the account, then the code that confirms the address ----------------

  /** A sign-up code was issued for `email` just now: its minute runs from here. The countdowns for the page. */
  async function signUpCodeIssued(email: string): Promise<CodeChallenge> {
    const now = Date.now();
    await recordSignUpCode(deps.coord, email, now);
    return challengeTiming(now, now);
  }

  /**
   * The sign-up code standing for `email`, while it may not be replaced yet (the form sent twice, a
   * page reloaded and filled in again: the code already in the inbox is the one to enter), else a
   * new one through `send`. Either way the page gets the countdowns of the code that counts.
   */
  async function standingOrNewSignUpCode(email: string, send: () => Promise<unknown>): Promise<CodeChallenge> {
    const current = await pendingSignUpCode(deps.coord, email);
    const now = Date.now();
    if (current && now < current.issuedAt + RESEND_AFTER_S * 1000) return challengeTiming(current.issuedAt, now);
    await send();
    return signUpCodeIssued(email);
  }

  app.post("/auth/signup", async (c) => {
    requireAppOrigin(c);
    const input = z
      .object({
        name: z.string().trim().min(1, "Enter your name.").max(DISPLAY_NAME_MAX),
        email: emailSchema,
        password: z.string().max(256),
        confirmPassword: z.string().max(256),
        acceptTerms: z.literal(true, { error: "Accept the terms and privacy policy to create an account." }),
      })
      .parse(await body(c));
    const ip = clientIp(c);
    await limit(deps.coord, `rl:signup:ip:${ip}`, LIMITS.signupIp);
    const weak = accountPasswordProblem(input.password);
    if (weak) throw new HttpError(400, weak, "weak_password");
    if (input.password !== input.confirmPassword) throw new HttpError(400, "The two passwords don't match.", "password_mismatch");
    // Every sign-up emails a code (Cognito's SignUp sends it itself), so the address's and the IP's
    // caps on codes come first.
    await limitCodeSends(deps.coord, input.email, ip);
    let challenge: CodeChallenge;
    try {
      await deps.auth.signUp({ email: input.email, password: input.password, name: input.name });
      // Cognito's own code from here: a claim of the address from before is over.
      await deps.coord.take(claimKey(input.email)).catch(() => null);
      challenge = await signUpCodeIssued(input.email);
    } catch (err) {
      if (!isCognito(err, "UsernameExistsException")) throw cognitoFailure(err, "signup");
      const existing = await deps.auth.adminGetUser(input.email).catch(() => null);
      if (existing?.status === "UNCONFIRMED") {
        // Signed up before but never entered the code: carry on to the code screen rather than
        // calling the account taken.
        challenge = await signUpAgain(c, input, existing);
      } else if (existing && (await unproven(existing))) {
        // Someone opened an account with this address without proving it: the code (ours) decides.
        challenge = await standingOrNewSignUpCode(input.email, () => startClaim(c, input.email, "signup", existing, input.name));
      } else {
        throw cognitoFailure(err, "signup");
      }
    }
    return c.json({ ok: true, next: "confirm", email: input.email, challenge });
  });

  // ---------------- Claiming an address nobody proved ----------------

  /**
   * Whether `existing`, the address's confirmed password user, never proved the address, and nor
   * did its account. Anyone can open such an account for someone else's address (an employee added
   * with it, the copied link), and Cognito sends no code to an address it hasn't verified: the
   * address's owner could neither sign up ("account exists") nor reset a password. So we send the
   * code ourselves (a claim): whoever enters it proves the inbox and gets a password user of their
   * own for the address, which takes the account over (identity.ts, takeOverUnverified). Until
   * then nothing changes, so a claim started by someone else costs the account nothing.
   */
  async function unproven(existing: CognitoUser): Promise<boolean> {
    if (existing.status !== "CONFIRMED" || existing.emailVerified) return false;
    const linked = await systemDb.authIdentity
      .findUnique({ where: { provider_subject: { provider: "cognito", subject: existing.sub } }, include: { user: { select: { emailVerified: true } } } })
      .catch(dbOutage(SIGN_IN_UNAVAILABLE));
    return !linked?.user.emailVerified;
  }

  /** The address's claimable password user (unproven), or null. */
  async function claimable(email: string): Promise<CognitoUser | null> {
    const existing = await deps.auth.adminGetUser(email);
    return existing && (await unproven(existing)) ? existing : null;
  }

  /** Email our own code for a claim of `email` (a new one replaces any earlier), kept as long as Cognito keeps its own. */
  async function startClaim(c: Ctx, email: string, kind: "signup" | "reset", existing: CognitoUser, name: string | null) {
    const code = newCode();
    const claim: AddressClaim = { username: existing.username, codeHash: claimCodeHash(email, code), name };
    await deps.coord.put(claimKey(email), JSON.stringify(claim), CLAIM_TTL_S[kind]).catch((err: unknown) => {
      logger.error({ err }, "could not store an address claim");
      throw new HttpError(503, UNAVAILABLE, "auth_unavailable");
    });
    const mail = authEmail({ trigger: kind === "signup" ? "CustomEmailSender_SignUp" : "CustomEmailSender_ForgotPassword", code, name, email, appUrl: env().APP_URL, senders: env() })!;
    await deps.mailer.send(email, mail.subject, mail.text, mail.html, { purpose: mail.purpose }).catch((err: unknown) => {
      logger.error({ err }, "could not email an address claim's code");
      throw new HttpError(503, "We couldn't send you an email right now. Please try again in a moment.", "email_unavailable");
    });
    const linked = await systemDb.authIdentity.findUnique({ where: { provider_subject: { provider: "cognito", subject: existing.sub } } }).catch(() => null);
    await recordAuthEvent("address_claim_started", linked?.userId ?? null, clientIp(c), { cognitoSub: existing.sub, via: kind });
  }

  /**
   * The code for a pending claim of `email` (sign-up confirmation or password reset), with the
   * password chosen with it. undefined: no claim stands (none, or one for a user that has gone
   * since), so Cognito's own code applies. Wrong: invalid_code, a few times an hour at most. Right:
   * the unproven password user goes, the person gets their own (address verified, this password),
   * and resolveUser takes the account over; the tokens of that new user's first sign-in.
   */
  async function redeemClaim(c: Ctx, email: string, code: string, password: string | undefined): Promise<CognitoTokens | undefined> {
    const key = claimKey(email);
    const raw = await deps.coord.peek(key).catch(() => {
      throw new HttpError(503, UNAVAILABLE, "auth_unavailable");
    });
    if (!raw) return undefined;
    const claim = JSON.parse(raw) as AddressClaim;
    const current = await claimable(email).catch((err: unknown) => {
      throw cognitoFailure(err, "address claim");
    });
    if (current?.username !== claim.username) {
      await deps.coord.take(key).catch(() => null);
      return undefined;
    }
    await limit(deps.coord, `rl:claim:email:${sha256Hex(email)}`, LIMITS.claimVerifyEmail);
    if (!safeEqual(claim.codeHash, claimCodeHash(email, code))) throw new HttpError(400, "That code isn't right. Check the email and try again.", "invalid_code");
    if (!password) throw new HttpError(400, "Enter the password you chose, then the code again.", "password_required");
    const weak = accountPasswordProblem(password);
    if (weak) throw new HttpError(400, weak, "weak_password");
    if (!(await deps.coord.take(key).catch(() => null))) throw new HttpError(400, "That code has expired or was already used. Ask for a new one.", "expired_code");
    const fail = (err: unknown): never => {
      throw cognitoFailure(err, "address claim");
    };
    // The other person's password stops working before anything else happens.
    await deps.auth.adminDeleteUser(current.username).catch(fail);
    const create = () => deps.auth.adminCreateUser({ email, emailVerified: true, name: claim.name, password });
    await create().catch(async (err: unknown) => {
      if (!isCognito(err, "UsernameExistsException")) return fail(err);
      // A sign-up someone started in the moment between: never confirmed, so the code's owner wins.
      const raced = await deps.auth.adminGetUser(email).catch(fail);
      if (raced?.status !== "UNCONFIRMED") throw new HttpError(409, "An account with that email already exists. Log in instead, or reset your password if you've forgotten it.", "account_exists");
      await deps.auth.adminDeleteUser(raced.username).catch(fail);
      return create().catch(fail);
    });
    await recordAuthEvent("address_claimed", null, clientIp(c), { replacedCognitoSub: current.sub });
    const signedIn = await deps.auth.passwordSignIn(email, password).catch(fail);
    return tokensOrChallenge(signedIn);
  }

  /**
   * A sign-up over an earlier one that was never confirmed. With the same password (the button
   * pressed twice, another tab) it is the same sign-up: a fresh code. With another password, this
   * one replaces it, so the password just typed is the one that works once the code is entered.
   * Keeping the first would let whoever started it (anyone can type someone's address) into the
   * account the inbox's owner then confirms. An unconfirmed sign-up never proved the inbox and
   * has nothing of ours behind it (a user row only exists after a sign-in), so nothing is lost.
   */
  async function signUpAgain(c: Ctx, input: { email: string; password: string; name: string }, existing: CognitoUser): Promise<CodeChallenge> {
    // Cognito checks the password before it says the user isn't confirmed.
    const same = await deps.auth.passwordSignIn(input.email, input.password).then(
      () => {
        // Confirmed in the meantime (another tab entered the code): the address is taken now.
        throw new HttpError(409, "An account with that email already exists. Log in instead, or reset your password if you've forgotten it.", "account_exists");
      },
      (err: unknown) => {
        if (isCognito(err, "UserNotConfirmedException")) return true;
        if (isCognito(err, "NotAuthorizedException")) return false;
        throw cognitoFailure(err, "signup again");
      },
    );
    if (same) {
      // The code already sent while its minute lasts; after that, a fresh one.
      return standingOrNewSignUpCode(input.email, () =>
        deps.auth.resendSignUpCode(input.email).catch((err: unknown) => {
          throw cognitoFailure(err, "resend signup code");
        }),
      );
    }
    // Never one that is somebody's sign-in already (a confirmed user can't become unconfirmed; this is a guard).
    if (await systemDb.authIdentity.findUnique({ where: { provider_subject: { provider: "cognito", subject: existing.sub } } }).catch(dbOutage(SIGN_IN_UNAVAILABLE))) {
      throw new HttpError(409, "An account with that email already exists. Log in instead, or reset your password if you've forgotten it.", "account_exists");
    }
    // Replacing the sign-up emails a new code: not before the last one's minute is up.
    const current = await pendingSignUpCode(deps.coord, input.email);
    if (current) requireResendAllowed(current.issuedAt);
    await deps.auth.adminDeleteUser(existing.username).catch((err: unknown) => {
      throw cognitoFailure(err, "replace unconfirmed sign-up");
    });
    await deps.auth.signUp({ email: input.email, password: input.password, name: input.name }).catch((err: unknown) => {
      throw cognitoFailure(err, "signup");
    });
    await recordAuthEvent("unconfirmed_signup_replaced", null, clientIp(c), { cognitoSub: existing.sub });
    return signUpCodeIssued(input.email);
  }

  /**
   * The sign-up code. With `password` (the one chosen in this browser) it also signs in, and the
   * code decides whose password the account keeps: whoever enters it proves the inbox. Anyone can
   * sign up again with the address meanwhile (signUpAgain), so the pending sign-up may carry
   * someone else's password by the time the owner types the newest code; that password is then
   * replaced with this one, and anything signed in with it ends.
   */
  app.post("/auth/signup/confirm", async (c) => {
    requireAppOrigin(c);
    const input = z.object({ email: emailSchema, code: codeSchema, password: passwordSchema.optional(), keep: keepSchema }).parse(await body(c));
    await limit(deps.coord, `rl:code:verify:${clientIp(c)}`, LIMITS.codeVerifyIp);
    // The code's minute and its five guesses (emailCode.ts) come before anything looks at the code:
    // a code past its minute is refused here whatever Cognito would still make of it.
    const { attempt } = await requireLiveSignUpCode(deps.coord, input.email);
    const wrong = async (): Promise<never> => {
      if (attempt >= MAX_ATTEMPTS) {
        // The fifth wrong guess ends the code: a new one has to be asked for.
        await discardSignUpCode(deps.coord, input.email);
        throw tooManyAttempts();
      }
      throw incorrectCode();
    };
    // Our code for an address someone else opened an account with (startClaim): signs in, and
    // the account becomes this person's.
    const claimed = await redeemClaim(c, input.email, input.code, input.password).catch((err: unknown) => {
      if (err instanceof HttpError && err.code === "invalid_code") return wrong();
      throw err;
    });
    if (claimed) {
      await discardSignUpCode(deps.coord, input.email);
      const user = await finishSignIn(c, claimed, { keep: input.keep });
      return c.json({ ok: true, user: publicUser(user) });
    }
    try {
      await deps.auth.confirmSignUp(input.email, input.code);
    } catch (err) {
      // Already confirmed (a second tab, a double press): nothing left to do here. Never a
      // sign-in: this request proved nothing (the page signs in through /auth/login instead).
      if (isCognito(err, "NotAuthorizedException") && /CONFIRMED/i.test((err as Error).message)) {
        await discardSignUpCode(deps.coord, input.email);
        return c.json({ ok: true });
      }
      if (isCognito(err, "CodeMismatchException")) return wrong();
      if (isCognito(err, "ExpiredCodeException")) {
        await discardSignUpCode(deps.coord, input.email);
        throw expiredCode();
      }
      throw cognitoFailure(err, "confirm signup");
    }
    // Spent: the same code again, or another guess, starts from "ask for a new one".
    await discardSignUpCode(deps.coord, input.email);
    if (!input.password) return c.json({ ok: true });
    const signIn = () =>
      deps.auth.passwordSignIn(input.email, input.password!).catch((err: unknown) => {
        if (isCognito(err, "NotAuthorizedException")) return null;
        throw cognitoFailure(err, "sign in after confirming");
      });
    let result = await signIn();
    if (!result) {
      // Not a password Cognito would take (the sign-in page's code step sends what was typed
      // there): the address is confirmed, but whatever password the sign-up had may be someone
      // else's, so none stays. "Forgot password?" sets one; the code proved the inbox.
      if (accountPasswordProblem(input.password)) {
        await claimConfirmedSignUp(c, input.email, unguessablePassword());
        return c.json({ ok: true });
      }
      await claimConfirmedSignUp(c, input.email, input.password);
      result = await signIn();
      if (!result) throw cognitoFailure(new CognitoError("NotAuthorizedException", ""), "sign in after confirming");
    }
    const user = await finishSignIn(c, tokensOrChallenge(result), { keep: input.keep });
    return c.json({ ok: true, user: publicUser(user) });
  });

  /**
   * The code just confirmed a sign-up whose password isn't the one this browser chose: that
   * password is someone else's (a later sign-up with the address, signUpAgain). Set this one,
   * end the Cognito user's tokens, and end the sessions of an account someone signed in to with
   * the old password between the confirmation and now.
   */
  async function claimConfirmedSignUp(c: Ctx, email: string, password: string) {
    const fail = (err: unknown) => {
      throw cognitoFailure(err, "set the confirmed sign-up's password");
    };
    const cu = await deps.auth.adminGetUser(email).catch(fail);
    if (!cu) throw cognitoFailure(new CognitoError("NotAuthorizedException", ""), "set the confirmed sign-up's password");
    await deps.auth.adminSetPassword(cu.username, password).catch(fail);
    await deps.auth.adminGlobalSignOut(cu.username).catch(fail);
    const linked = await systemDb.authIdentity.findUnique({ where: { provider_subject: { provider: "cognito", subject: cu.sub } } }).catch(dbOutage(SIGN_IN_UNAVAILABLE));
    if (linked) await systemDb.user.update({ where: { id: linked.userId }, data: { sessionsValidAfter: new Date() } }).catch(dbOutage(SIGN_IN_UNAVAILABLE));
    await recordAuthEvent("signup_password_replaced", linked?.userId ?? null, clientIp(c), { cognitoSub: cu.sub });
  }

  /**
   * A new sign-up code, once the last one's minute is up (429 with the standing code's countdowns
   * before that), within the address's hourly and daily caps. The answer is the same whether or
   * not the address has a sign-up waiting, so this can't be used to find accounts.
   */
  app.post("/auth/signup/resend", async (c) => {
    requireAppOrigin(c);
    const { email } = z.object({ email: emailSchema }).parse(await body(c));
    const current = await pendingSignUpCode(deps.coord, email);
    if (current) requireResendAllowed(current.issuedAt);
    await limitCodeSends(deps.coord, email, clientIp(c));
    // A claim under way: a new code of ours (Cognito has none to send for that user).
    const claim = await claimInProgress(email);
    if (claim) {
      await startClaim(c, email, "signup", claim.user, claim.name);
      return c.json({ ok: true, message: CODE_RESENT, challenge: await signUpCodeIssued(email) });
    }
    await deps.auth.resendSignUpCode(email).catch((err: unknown) => {
      // Unknown or already confirmed: the same answer, so this can't be used to find accounts.
      if (isCognito(err, "UserNotFoundException", "InvalidParameterException", "NotAuthorizedException")) return;
      throw cognitoFailure(err, "resend signup code");
    });
    return c.json({ ok: true, message: CODE_RESENT, challenge: await signUpCodeIssued(email) });
  });

  /** A claim of `email` that still stands (its user is still the address's unproven one), or null. */
  async function claimInProgress(email: string): Promise<{ user: CognitoUser; name: string | null } | null> {
    const raw = await deps.coord.peek(claimKey(email)).catch(() => null);
    if (!raw) return null;
    const claim = JSON.parse(raw) as AddressClaim;
    const user = await claimable(email).catch((err: unknown) => {
      throw cognitoFailure(err, "address claim");
    });
    return user?.username === claim.username ? { user, name: claim.name } : null;
  }

  app.post("/auth/password/forgot", async (c) => {
    requireAppOrigin(c);
    const { email } = z.object({ email: emailSchema }).parse(await body(c));
    const ip = clientIp(c);
    await limit(deps.coord, `rl:code:ip:${ip}`, LIMITS.codeIp);
    await limit(deps.coord, `rl:code:email:${sha256Hex(email)}`, LIMITS.codeEmail);
    try {
      // An address someone else opened an account with: Cognito won't email it, so we do (startClaim).
      const unprovenUser = await claimable(email);
      if (unprovenUser) await startClaim(c, email, "reset", unprovenUser, null);
      else await deps.auth.forgotPassword(email);
    } catch (err) {
      // No account, or none that can get a code: the same answer as success (no enumeration).
      if (!isCognito(err, "UserNotFoundException", "InvalidParameterException", "NotAuthorizedException")) throw cognitoFailure(err, "forgot password");
    }
    return c.json({ ok: true, message: CODE_SENT });
  });

  app.post("/auth/password/reset", async (c) => {
    requireAppOrigin(c);
    const input = z.object({ email: emailSchema, code: codeSchema, password: z.string().max(256), confirmPassword: z.string().max(256) }).parse(await body(c));
    await limit(deps.coord, `rl:code:verify:${clientIp(c)}`, LIMITS.codeVerifyIp);
    const weak = accountPasswordProblem(input.password);
    if (weak) throw new HttpError(400, weak, "weak_password");
    if (input.password !== input.confirmPassword) throw new HttpError(400, "The two passwords don't match.", "password_mismatch");
    // Guesses at one address's code, from however many addresses they come: the per-IP limit alone
    // leaves a code to whoever spreads them out. Counted whether or not the address has an account.
    await limit(deps.coord, `rl:reset:email:${sha256Hex(input.email)}`, LIMITS.resetVerifyEmail);
    // Our code for an address someone else opened an account with: the account becomes this
    // person's (resolveUser takes it over now, not at their next sign-in), with this password.
    const claimed = await redeemClaim(c, input.email, input.code, input.password);
    if (claimed) {
      const claims = await deps.auth.verifyIdToken(claimed.idToken).catch((err: unknown) => {
        throw cognitoFailure(err, "verify ID token");
      });
      await resolveUser(claims, { ip: clientIp(c), auth: deps.auth }).catch(dbOutage(SIGN_IN_UNAVAILABLE));
      // Signing in is the sign-in page's job, as after any reset.
      if (claimed.refreshToken) await deps.auth.revokeRefreshToken(claimed.refreshToken).catch((err: unknown) => logger.warn({ err }, "could not revoke a claim's refresh token"));
      return c.json({ ok: true, otherMethods: [] });
    }
    await deps.auth.confirmForgotPassword(input.email, input.code, input.password).catch((err: unknown) => {
      // Cognito answers an unknown address like a wrong code once user-existence errors are hidden.
      throw cognitoFailure(isCognito(err, "UserNotFoundException") ? new CognitoError("CodeMismatchException", "") : err, "reset password");
    });
    // A new password ends every session, everywhere: whoever knew the old one is out. Other ways
    // in (a linked Google account) stay, so the answer names them: the page asks the person to
    // check them in Settings → Security, where they can be removed. Only whoever holds the code
    // (the inbox) sees that. A reset whose sessions couldn't be ended says so (503) rather than
    // "done": it is how someone recovers an account another person is signed in to.
    const user = await accountOfPasswordUser(input.email).catch((err: unknown) => {
      logger.error({ err }, "could not find the account after a password reset");
      throw sessionsNotEnded();
    });
    if (user) {
      await systemDb.user.update({ where: { id: user.id }, data: { sessionsValidAfter: new Date() } }).catch((err: unknown) => {
        logger.error({ err }, "could not end sessions after a password reset");
        throw sessionsNotEnded();
      });
      for (const id of user.identities.filter((i) => i.method === "password")) {
        await deps.auth.adminGlobalSignOut(id.username).catch((err: unknown) => logger.warn({ err }, "Cognito sign-out after a password reset failed"));
      }
      await endSessions({ userId: user.id });
      await recordAuthEvent("password_reset", user.id, clientIp(c));
      await notifyPasswordChanged(deps.mailer, user, "reset");
    }
    const otherMethods = [...new Set((user?.identities ?? []).filter((i) => i.method !== "password").map((i) => i.method))];
    return c.json({ ok: true, otherMethods });
  });

  /**
   * The account a password Cognito user signs in to: the one its identity is linked to, found by
   * the Cognito user's sub. Not by users.email, which a Google sign-in can move to another address
   * while the password user keeps this one (identity.ts). An address whose password user no account
   * is linked to yet (an account from before Cognito) falls back to the address.
   */
  async function accountOfPasswordUser(email: string) {
    const cognitoUser = await deps.auth.adminGetUser(email);
    const linked = cognitoUser && (await systemDb.authIdentity.findUnique({ where: { provider_subject: { provider: "cognito", subject: cognitoUser.sub } }, select: { userId: true } }));
    return systemDb.user.findUnique({ where: linked ? { id: linked.userId } : { email }, include: { identities: true } });
  }

  const sessionsNotEnded = () =>
    new HttpError(
      503,
      "Your new password is set, but we couldn't sign out the devices signed in to your account. Sign in with the new password, then choose \"Sign out of all devices\" in Settings > Security.",
      "sessions_not_ended",
    );

  // ---------------- Passwordless: a code Cognito emails (when switched on) ----------------

  const otpEnabled = () => {
    if (env().COGNITO_EMAIL_OTP !== "1") throw new HttpError(404, "Signing in with an emailed code isn't available.", "not_enabled");
  };

  app.post("/auth/otp/start", async (c) => {
    requireAppOrigin(c);
    otpEnabled();
    const { email } = z.object({ email: emailSchema }).parse(await body(c));
    const ip = clientIp(c);
    await limit(deps.coord, `rl:code:ip:${ip}`, LIMITS.codeIp);
    await limit(deps.coord, `rl:code:email:${sha256Hex(email)}`, LIMITS.codeEmail);
    try {
      const { session } = await deps.auth.startEmailOtp(email);
      setCookie(c, OTP_COOKIE, session, { ...cookieBase(), path: otpCookiePath(), maxAge: 180 });
    } catch (err) {
      if (!isCognito(err, "UserNotFoundException", "NotAuthorizedException", "InvalidParameterException")) throw cognitoFailure(err, "email code sign-in");
    }
    return c.json({ ok: true, message: CODE_SENT });
  });

  app.post("/auth/otp/verify", async (c) => {
    requireAppOrigin(c);
    otpEnabled();
    const input = z.object({ email: emailSchema, code: codeSchema, keep: keepSchema }).parse(await body(c));
    await limit(deps.coord, `rl:code:verify:${clientIp(c)}`, LIMITS.codeVerifyIp);
    const session = getCookie(c, OTP_COOKIE);
    if (!session) throw new HttpError(400, "That code has expired. Ask for a new one.", "expired_code");
    const result = await deps.auth.answerEmailOtp(input.email, session, input.code).catch((err: unknown) => {
      throw cognitoFailure(isCognito(err, "NotAuthorizedException") ? new CognitoError("ExpiredCodeException", "") : err, "email code verify");
    });
    deleteCookie(c, OTP_COOKIE, { ...cookieBase(), path: otpCookiePath() });
    const codeStep = await askForCode(c, input.email, result, input.keep);
    if (codeStep) return codeStep;
    const user = await finishSignIn(c, tokensOrChallenge(result), { keep: input.keep });
    return c.json({ user: publicUser(user) });
  });

  // ---------------- Continue with Google (Cognito managed login, code + PKCE) ----------------

  /**
   * A trip to the provider by way of the user pool: what the callback needs is kept in the
   * coordinator under a new state, and only this browser can finish it (no login CSRF): the state
   * must come back with the __oauth cookie set here. The provider's address; null when the state
   * couldn't be kept.
   */
  async function beginTrip(c: Ctx, trip: Pick<PendingSignIn, "provider" | "returnTo" | "keep" | "linkUserId">): Promise<string | null> {
    const state = randomToken(24);
    const nonce = randomToken(24);
    const pkce = pkcePair();
    const pending: PendingSignIn = { ...trip, verifier: pkce.verifier, nonce };
    try {
      await deps.coord.put(`oauth:signin:${state}`, JSON.stringify(pending), OAUTH_STATE_TTL_S);
    } catch (err) {
      logger.error({ err }, "could not store a sign-in's state");
      return null;
    }
    setCookie(c, OAUTH_COOKIE, [state, ...pendingStates(getCookie(c, OAUTH_COOKIE))].slice(0, MAX_PENDING_STATES).join("."), {
      ...cookieBase(),
      path: oauthCookiePath(),
      maxAge: OAUTH_STATE_TTL_S,
    });
    // Linking: Google's account chooser every time, so it links the account the person picks,
    // never just whichever one this browser happens to be signed in to.
    return deps.auth.authorizeUrl({ provider: trip.provider, redirectUri: redirectUri(), state, codeChallenge: pkce.challenge, nonce, selectAccount: !!trip.linkUserId });
  }

  /**
   * Leaves for Google to sign in (or create the account), by way of the user pool. Errors land on
   * the sign-in error page. `?keep=0`: "Keep me signed in" was unticked, so the session's cookies
   * end with the browser.
   *
   * Never to link Google to the account signed in here (`?link=1`, as linking once started): a
   * plain link any site can open would add whichever Google account the browser is signed in to,
   * without the person choosing to. Linking starts from Settings with a POST (below); a `?link=1`
   * goes back to `returnTo` with `?link_error=start_again`.
   */
  app.get("/auth/oauth/:provider/start", async (c) => {
    const appUrl = env().APP_URL;
    const returnTo = safeReturnTo(c.req.query("returnTo"));
    if (c.req.query("link") === "1") return c.redirect(`${appUrl}${withParam(returnTo ?? LINK_RETURN, "link_error", "start_again")}`);
    const fail = (reason: string) => c.redirect(`${appUrl}/auth/error?${new URLSearchParams({ reason, provider: c.req.param("provider") })}`);
    const provider = PROVIDERS[c.req.param("provider")];
    if (!provider || !enabledProviders().has(provider)) return fail("provider_unavailable");
    try {
      await limit(deps.coord, `rl:oauth:${clientIp(c)}`, LIMITS.oauthIp);
    } catch {
      return fail("rate_limited");
    }
    const to = await beginTrip(c, { provider, returnTo, ...(c.req.query("keep") === "0" && { keep: false as const }) });
    return to ? c.redirect(to) : fail("unavailable");
  });

  /**
   * Link Google to the signed-in account (Settings), no new session: `{ redirect }`, the provider's
   * address for the page to go to. The callback then sends the person back to `returnTo` with
   * `?linked=google`, or `?link_error=<code>`; this route's own refusals are errors whose code the
   * page puts there itself. Our own pages only (requireAppOrigin), so no other site can start it.
   * A new way into the account needs the person again: a sign-in in the last 15 minutes, or their
   * password just now (POST /auth/account/methods/google/prepare), like the account's other changes.
   */
  app.post("/auth/oauth/:provider/link", async (c) => {
    requireAppOrigin(c);
    const input = z.object({ returnTo: z.string().max(1000).optional() }).parse(await body(c));
    const provider = PROVIDERS[c.req.param("provider")];
    if (!provider || !enabledProviders().has(provider)) throw new HttpError(404, "Signing in with Google isn't available right now.", "provider_unavailable");
    await limit(deps.coord, `rl:oauth:${clientIp(c)}`, LIMITS.oauthIp);
    const unavailable = () => new HttpError(503, UNAVAILABLE, "unavailable");
    // The account's own session only: never one opened from a shared link (loadUser refuses those here).
    const user = await loadUser(c, deps).catch(() => {
      throw unavailable();
    });
    if (!user) throw new HttpError(401, "Sign in to your account again, then link Google.", "signin_required");
    // Nobody has proved this account's address yet: a way in added now would outlive the
    // address's owner taking the account over (identity.ts, takeOverUnverified).
    if (!user.emailVerified) throw new HttpError(403, "Verify your email address first, then link Google.", "email_unverified");
    const hasGoogle = await systemDb.authIdentity.count({ where: { userId: user.id, method: "google" } }).catch(() => {
      throw unavailable();
    });
    if (hasGoogle) throw new HttpError(409, "Your account already has a Google sign-in. Remove it first to link a different one.", "already_linked");
    const s = sessionOf(c);
    if (!signedInRecently(s)) {
      const proof = await deps.coord.take(linkProofKey(s.sid)).catch(() => {
        throw unavailable();
      });
      if (!proof) throw new HttpError(401, "For your safety, enter your password again, then link Google.", "reauth_required");
    }
    const to = await beginTrip(c, { provider, returnTo: safeReturnTo(input.returnTo), linkUserId: user.id });
    if (!to) throw unavailable();
    return c.json({ redirect: to });
  });

  /**
   * The callback page (/auth/callback) posts what came back. The code is exchanged here with the
   * client secret and the PKCE verifier, so a code seen anywhere along the way is useless.
   */
  app.post("/auth/oauth/callback", async (c) => {
    requireAppOrigin(c);
    const q = z
      .object({ state: z.string().max(200).default(""), code: z.string().max(2000).optional(), error: z.string().max(200).optional(), error_description: z.string().max(1000).optional() })
      .parse(await body(c));
    await limit(deps.coord, `rl:oauth:${clientIp(c)}`, LIMITS.oauthIp);
    const pending = pendingStates(getCookie(c, OAUTH_COOKIE));
    const ours = !!q.state && pending.some((n) => safeEqual(n, q.state));
    const rest = pending.filter((n) => n !== q.state);
    if (rest.length) setCookie(c, OAUTH_COOKIE, rest.join("."), { ...cookieBase(), path: oauthCookiePath(), maxAge: OAUTH_STATE_TTL_S });
    else deleteCookie(c, OAUTH_COOKIE, { ...cookieBase(), path: oauthCookiePath() });
    if (!ours) throw new HttpError(400, "This sign-in didn't start in this browser, or was already used. Please try again.", "state_mismatch");
    const raw = await deps.coord.take(`oauth:signin:${q.state}`).catch(() => {
      throw new HttpError(503, UNAVAILABLE, "auth_unavailable");
    });
    if (!raw) throw new HttpError(400, "This sign-in took too long. Please try again.", "state_expired");
    const pendingSignIn = JSON.parse(raw) as PendingSignIn;
    if (pendingSignIn.linkUserId) return linkFromCallback(c, q, pendingSignIn);
    if (q.error || !q.code) {
      logger.info({ error: q.error, description: q.error_description?.slice(0, 200) }, "federated sign-in did not complete");
      // Cognito passes the provider's "no" on as access_denied (or as an invalid_request naming it).
      const cancelled = q.error === "access_denied" || /cancel|denied|user_cancelled/i.test(q.error_description ?? "");
      throw cancelled
        ? new HttpError(400, "Sign-in was cancelled.", "cancelled")
        : new HttpError(400, "We couldn't sign you in with that account. Please try again, or use your email address.", "provider_error");
    }
    const tokens = await deps.auth.exchangeCode({ code: q.code, redirectUri: redirectUri(), codeVerifier: pendingSignIn.verifier }).catch((err: unknown) => {
      if (isCognito(err, "invalid_grant")) throw new HttpError(400, "This sign-in link has expired. Please try again.", "code_invalid");
      throw cognitoFailure(err, "oauth token exchange");
    });
    // A new Google account becomes a new account right here (no sign-up form); one whose address
    // is an existing account's waits for that account's sign-in instead (holdForLink).
    const user = await finishSignIn(c, tokens, { nonce: pendingSignIn.nonce, keep: pendingSignIn.keep }).catch((err: unknown) => {
      if (err instanceof LinkRequired) return err;
      throw err;
    });
    if (user instanceof LinkRequired) return c.json(await holdForLink(c, user, tokens));
    return c.json({ user: publicUser(user), redirect: pendingSignIn.returnTo });
  });

  /**
   * The end of linking Google from Settings. The person who started it must still be the one
   * signed in here; the Google account must belong to nobody else. Every answer names where the
   * page goes next: `returnTo` with `?linked=google`, or with `?link_error=<code>`.
   */
  async function linkFromCallback(c: Ctx, q: { code?: string; error?: string; error_description?: string }, p: PendingSignIn) {
    const back = p.returnTo ?? LINK_RETURN;
    const refuse = (status: 400 | 403 | 409 | 503, code: string, message: string) => c.json({ error: code, message, redirect: withParam(back, "link_error", code) }, status);
    if (q.error || !q.code) {
      logger.info({ error: q.error, description: q.error_description?.slice(0, 200) }, "linking Google did not complete");
      const cancelled = q.error === "access_denied" || /cancel|denied|user_cancelled/i.test(q.error_description ?? "");
      return cancelled ? refuse(400, "cancelled", "Linking Google was cancelled. Nothing was changed.") : refuse(400, "provider_error", "We couldn't link that Google account. Please try again.");
    }
    const user = await loadUser(c, deps).catch(() => undefined);
    if (user === undefined) return refuse(503, "unavailable", "We can't reach your account right now. Please try again in a moment.");
    if (!user || user.id !== p.linkUserId) return refuse(403, "signin_changed", "You're no longer signed in to the account that asked to link Google. Sign in and try again.");
    if (!user.emailVerified) return refuse(403, "email_unverified", "Verify your email address first, then link Google.");
    const outcome = await deps.auth
      .exchangeCode({ code: q.code, redirectUri: redirectUri(), codeVerifier: p.verifier })
      .then(async (tokens) => {
        const verified = await deps.auth.verifyIdToken(tokens.idToken, { nonce: p.nonce });
        // Only who the Google account is was wanted, not a second session: hand its refresh token back.
        if (tokens.refreshToken) await deps.auth.revokeRefreshToken(tokens.refreshToken).catch((err: unknown) => logger.warn({ err }, "could not revoke a linking sign-in's refresh token"));
        return { claims: verified };
      })
      .catch((err: unknown) => ({ err }));
    if ("err" in outcome) {
      if (isCognito(outcome.err, "invalid_grant")) return refuse(400, "code_invalid", "This link took too long. Please try again.");
      const down = cognitoFailure(outcome.err, "link Google").statusCode === 503;
      return down ? refuse(503, "unavailable", UNAVAILABLE) : refuse(400, "provider_error", "We couldn't link that Google account. Please try again.");
    }
    const { claims } = outcome;
    if (claims.method !== "google") return refuse(400, "provider_error", "We couldn't link that Google account. Please try again.");
    const where = { provider_subject: { provider: "cognito", subject: claims.sub } };
    const taken = (other: { userId: string } | null) => !!other && other.userId !== user.id;
    let added = false;
    try {
      const existing = await systemDb.authIdentity.findUnique({ where });
      if (taken(existing)) return refuse(409, "google_in_use", "That Google account already signs in to another bizinsights account. Remove it there first, or use a different Google account.");
      if (!existing) {
        if (await systemDb.authIdentity.count({ where: { userId: user.id, method: "google" } })) {
          return refuse(409, "already_linked", "Your account already has a Google sign-in. Remove it first to link a different one.");
        }
        try {
          await systemDb.authIdentity.create({
            data: { userId: user.id, provider: "cognito", subject: claims.sub, username: claims.username, method: "google", email: claims.email, lastUsedAt: new Date() },
          });
        } catch (err) {
          if ((err as { code?: string })?.code !== "P2002") throw err;
          // Linked meanwhile: by this account (a second tab) is fine, by another is not.
          if (taken(await systemDb.authIdentity.findUnique({ where }))) return refuse(409, "google_in_use", "That Google account already signs in to another bizinsights account. Remove it there first, or use a different Google account.");
          return c.json({ linked: "google" as const, redirect: withParam(back, "linked", "google") });
        }
        await recordAuthEvent("identity_linked", user.id, clientIp(c), { cognitoSub: claims.sub, method: "google", via: "settings", cognitoUsername: cognitoUsernameKey(claims.username) });
        added = true;
      }
    } catch (err) {
      logger.error({ err }, "database unreachable while linking Google");
      return refuse(503, "unavailable", "We can't reach your account right now. Please try again in a moment.");
    }
    // The account's address hears of it, in case it wasn't them.
    if (added) await notifyMethodAdded(deps.mailer, user, { method: "google", email: claims.email });
    return c.json({ linked: "google" as const, redirect: withParam(back, "linked", "google") });
  }

  // ---------------- Session ----------------

  /** Sign out this browser (and, after Google, the user pool's own session in it). */
  app.post("/auth/logout", async (c) => {
    // Leaving a shared dashboard: only its shared-link session ends. An account signed in on the
    // same browser stays signed in (the two sessions are never mixed).
    const picked = pickSession(c);
    if (picked?.cookie === "share") {
      await deps.coord
        .put(retiredSessionKey(picked.claims.sid), "1", Math.max(60, Math.ceil((picked.claims.exp - Date.now()) / 1000)))
        .catch((err: unknown) => logger.error({ err }, "could not retire the shared-link session"));
      clearShareCookie(c);
      return c.json({ ok: true, redirect: null });
    }
    // Best effort throughout: signing out must always clear the cookies below.
    const s = readSession(getCookie(c, SESSION_COOKIE));
    let redirect: string | null = null;
    if (s) {
      await deps.coord
        .put(retiredSessionKey(s.sid), "1", Math.max(60, Math.ceil((s.exp - Date.now()) / 1000)))
        .catch((err: unknown) => logger.error({ err }, "could not retire the signed-out session"));
      await endSessions({ sid: s.sid });
      const rt = readRefreshToken(c, s);
      // This device's refresh token (and the access tokens from it) end in Cognito too.
      if (rt) await deps.auth.revokeRefreshToken(rt).catch((err: unknown) => logger.warn({ err }, "could not revoke the refresh token"));
      // After Google, the user pool's own session in this browser ends too.
      if (s.m === "google") redirect = deps.auth.logoutUrl(`${env().APP_URL}/login?signedOut=1`);
    }
    clearSessionCookies(c);
    return c.json({ ok: true, redirect });
  });

  /** Sign out of every device: every session of this account, and every Cognito refresh token. */
  const signOutEverywhere = async (c: Ctx) => {
    const user = await requireUser(c, deps);
    await limit(deps.coord, `rl:revoke:${user.id}`, LIMITS.revokeSessions);
    await systemDb.user.update({ where: { id: user.id }, data: { sessionsValidAfter: new Date() } }).catch(dbOutage("We can't sign you out everywhere right now. Please try again in a moment."));
    const identities = await systemDb.authIdentity.findMany({ where: { userId: user.id } }).catch(() => []);
    for (const id of identities) {
      await deps.auth.adminGlobalSignOut(id.username).catch((err: unknown) => logger.warn({ err }, "Cognito global sign-out failed"));
    }
    await endSessions({ userId: user.id });
    await recordAuthEvent("signed_out_everywhere", user.id, clientIp(c));
    const s = sessionOf(c);
    clearSessionCookies(c);
    return c.json({ ok: true, redirect: s.m === "google" ? deps.auth.logoutUrl(`${env().APP_URL}/login?signedOut=1`) : null });
  };
  app.post("/auth/logout-all", signOutEverywhere);
  // The employee portal's name for it.
  app.post("/auth/sessions/revoke", signOutEverywhere);

  async function me(c: Ctx, user: Awaited<ReturnType<typeof requireUser>>) {
    // Opened from an invitation link: that workspace and nothing else of the account, read-only.
    const shared = sharedWorkspace(c);
    const link = isLinkSession(c);
    const memberships = await systemDb.membership.findMany({
      where: { userId: user.id, ...(shared && { workspaceId: shared }) },
      include: { workspace: { select: { id: true, name: true } } },
      orderBy: { createdAt: "asc" },
    });
    // Which of those came in through the App Store app: the app shows them only what its listing describes.
    const stores = await systemDb.store.findMany({
      where: { workspaceId: { in: memberships.map((m) => m.workspaceId) } },
      select: { workspaceId: true, shopDomain: true, shopifyAppKey: true },
    });
    return c.json({
      user: publicUser(user),
      // Each with what this person may see there (Team & Access). A revoked membership, or one whose
      // end date has passed, is listed as such, with nothing granted, so the app can say so rather
      // than offer to set up a workspace of their own.
      workspaces: memberships.map((m) => {
        const eff = sessionAccess(m, { link });
        return {
          id: m.workspace.id,
          name: m.workspace.name,
          role: eff.access.role,
          staffRole: m.staffRole,
          permissions: eff.state !== "active" ? [] : hasFullAccess(eff.access.role) ? [...ACCESS_KEYS] : [...eff.access.permissions],
          status: eff.state,
          fingerprint: eff.fingerprint,
          accessExpiresAt: m.accessExpiresAt?.toISOString() ?? null,
          appStore: appStoreWorkspace(stores.filter((s) => s.workspaceId === m.workspaceId)),
        };
      }),
      // Organizations this account works for as an employee (the employee portal).
      employments: shared ? [] : await employmentsForUser(user.id),
      // Set for a session opened from an invitation link: the app shows that workspace only,
      // view-only, and offers to sign in for anything account-wide. `expiresAt`: when the shared
      // access ends (its end date; this session's own end when it has none).
      shared: shared
        ? {
            workspaceId: shared,
            readOnly: true,
            expiresAt: (memberships.find((m) => m.workspaceId === shared)?.accessExpiresAt ?? new Date(sessionOf(c).exp)).toISOString(),
          }
        : null,
    });
  }

  app.get("/me", async (c) => me(c, await requireUser(c, deps, { shared: true })));

  /**
   * The public homepage's "already signed in?" check: GET /me's answer for a session, and
   * `{ user: null }` with a 200 for everyone else. A 401 there is expected, but every browser logs
   * it as a console error on the page most visitors see. Outages still answer 503 (loadUser).
   */
  app.get("/auth/whoami", async (c) => {
    const user = await loadUser(c, deps, { shared: true });
    return user ? me(c, user) : c.json({ user: null, workspaces: [] });
  });

  /** This session: who, how they signed in, and until when. */
  app.get("/auth/session", async (c) => {
    const user = await loadUser(c, deps, { shared: true });
    if (!user) return c.json({ authenticated: false });
    const s = sessionOf(c);
    return c.json({ authenticated: true, user: publicUser(user), method: s.m, signedInAt: s.at * 1000, expiresAt: s.exp });
  });

  app.patch("/me", async (c) => {
    const user = await requireUser(c, deps);
    const patch = z
      .object({
        displayName: z.string().trim().max(DISPLAY_NAME_MAX).optional(),
        timezone: z.string().refine(validTz, "Unknown time zone").optional(),
      })
      .parse(await body(c));
    const u = await systemDb.user.update({ where: { id: user.id }, data: patch });
    return c.json({ user: publicUser(u) });
  });
}

function validTz(tz: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

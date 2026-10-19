import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { systemDb } from "@app/db";
import { appStoreWorkspace, employmentsForUser, env, logger, sessionAccess } from "@app/core";
import { ACCESS_KEYS, accountPasswordProblem, DISPLAY_NAME_MAX, EMAIL_CODE_RE, hasFullAccess, pkcePair, randomToken, safeEqual, sha256Hex } from "@app/shared";
import { body, clientIp, HttpError, isLinkSession, loadUser, pickSession, requireAppOrigin, requireUser, sessionOf, SESSION_COOKIE, sharedWorkspace, type Ctx, type Deps } from "../context.js";
import { CognitoError, CognitoUnavailableError, type CognitoTokens, type CognitoUser, type FederatedProvider, type SignInResult } from "../cognito.js";
import { cognitoUsernameKey, notifyMethodAdded, recordAuthEvent, resolveUser } from "../identity.js";
import { apiPath, clearSessionCookies, clearShareCookie, linkProofKey, newSession, readRefreshToken, readSession, retiredSessionKey, setSessionCookies, signedInRecently } from "../session.js";
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

/** Federated providers switched on for this deployment (COGNITO_IDENTITY_PROVIDERS, plus a domain). */
export function enabledProviders(): Set<FederatedProvider> {
  const e = env();
  if (!e.COGNITO_DOMAIN) return new Set();
  return new Set(
    e.COGNITO_IDENTITY_PROVIDERS.split(",")
      .map((p) => p.trim())
      .filter((p): p is FederatedProvider => p === "Google"),
  );
}

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
      return new HttpError(400, "That code isn't right. Check the email and try again.", "invalid_code");
    case "ExpiredCodeException":
      return new HttpError(400, "That code has expired or was already used. Ask for a new one.", "expired_code");
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

export function publicUser(u: { id: string; email: string; emailVerified: boolean; displayName: string | null; timezone: string }) {
  return { id: u.id, email: u.email, emailVerified: u.emailVerified, displayName: u.displayName, timezone: u.timezone };
}

export function authRoutes(app: App, deps: Deps) {
  const oauthCookiePath = () => `${apiPath() === "/" ? "" : apiPath()}/auth/oauth`;
  const otpCookiePath = () => `${apiPath() === "/" ? "" : apiPath()}/auth/otp`;
  // /auth/login and /auth/login/mfa.
  const mfaCookiePath = () => `${apiPath() === "/" ? "" : apiPath()}/auth/login`;
  const cookieBase = () => ({ httpOnly: true, sameSite: "Lax" as const, secure: env().NODE_ENV === "production" });
  const redirectUri = () => `${env().APP_URL}/auth/callback`;

  /**
   * Cognito's tokens → our session. The ID token is verified here (signature against the pool's
   * keys, issuer, audience = our app client, token_use, expiry, and the nonce for OAuth); only
   * then is the person looked up, linked or created, and the session cookie set.
   */
  async function finishSignIn(c: Ctx, tokens: CognitoTokens, opts: { nonce?: string; keep?: boolean } = {}) {
    const claims = await deps.auth.verifyIdToken(tokens.idToken, { nonce: opts.nonce }).catch((err) => {
      throw cognitoFailure(err, "verify ID token");
    });
    const user = await resolveUser(claims, { ip: clientIp(c), auth: deps.auth }).catch(dbOutage(SIGN_IN_UNAVAILABLE));
    const s = newSession({ userId: user.id, sub: claims.sub, username: claims.username, method: claims.method, authTime: claims.authTime, keep: opts.keep });
    setSessionCookies(c, s, tokens.refreshToken);
    // Security trail: who signed in, how and from where (user id, never the email or a token).
    logger.info({ event: "session_created", userId: user.id, method: claims.method, ip: clientIp(c) }, "signed in");
    return user;
  }

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

  /**
   * An account from before the move to Cognito (users.firebase_uid: the old deployment's users, if
   * they are merged in) that has no Cognito user yet: create one, without emailing them, so Cognito
   * can send them a reset or sign-in code. Their password stays unknown (random), so this grants
   * nobody access by itself; their old password is never checked anywhere.
   */
  async function provisionMovedAccount(email: string, ip: string) {
    const row = await systemDb.user.findUnique({ where: { email }, include: { identities: { where: { method: "password" } } } }).catch(() => null);
    if (!row?.firebaseUid || row.identities.length) return;
    if (await deps.auth.adminGetUser(email)) return;
    try {
      // The address is the one the code goes to, so marking it verified lets Cognito send it;
      // the code itself is the proof.
      const created = await deps.auth.adminCreateUser({ email, emailVerified: true, name: row.displayName });
      await recordAuthEvent("firebase_account_provisioned", row.id, ip, { firebaseUid: row.firebaseUid, cognitoSub: created.sub });
    } catch (err) {
      if (!isCognito(err, "UsernameExistsException")) throw err;
    }
  }

  // ---------------- What the sign-in pages offer ----------------

  app.get("/auth/config", (c) => {
    const providers = enabledProviders();
    return c.json({
      providers: { google: providers.has("Google") },
      emailOtp: env().COGNITO_EMAIL_OTP === "1",
    });
  });

  // ---------------- Email and password ----------------

  app.post("/auth/login", async (c) => {
    requireAppOrigin(c);
    const input = z.object({ email: emailSchema, password: passwordSchema, keep: keepSchema }).parse(await body(c));
    const ip = clientIp(c);
    await limit(deps.coord, `rl:login:ip:${ip}`, LIMITS.loginIp);
    await limit(deps.coord, `rl:login:email:${sha256Hex(input.email)}`, LIMITS.loginEmail);
    const result = await deps.auth.passwordSignIn(input.email, input.password).catch((err: unknown) => {
      throw cognitoFailure(err, "login");
    });
    const codeStep = await askForCode(c, input.email, result, input.keep);
    if (codeStep) return codeStep;
    const user = await finishSignIn(c, tokensOrChallenge(result), { keep: input.keep });
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
      if (isCognito(err, "CodeMismatchException")) throw new HttpError(400, "That code isn't right. Enter the code your authenticator app shows now.", "invalid_code");
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

  app.post("/auth/signup", async (c) => {
    requireAppOrigin(c);
    const input = z
      .object({
        name: z.string().trim().min(1, "Enter your name.").max(DISPLAY_NAME_MAX),
        email: emailSchema,
        password: z.string().max(256),
        confirmPassword: z.string().max(256),
        acceptTerms: z.literal(true, { errorMap: () => ({ message: "Accept the terms and privacy policy to create an account." }) }),
      })
      .parse(await body(c));
    await limit(deps.coord, `rl:signup:ip:${clientIp(c)}`, LIMITS.signupIp);
    const weak = accountPasswordProblem(input.password);
    if (weak) throw new HttpError(400, weak, "weak_password");
    if (input.password !== input.confirmPassword) throw new HttpError(400, "The two passwords don't match.", "password_mismatch");
    try {
      await deps.auth.signUp({ email: input.email, password: input.password, name: input.name });
    } catch (err) {
      if (!isCognito(err, "UsernameExistsException")) throw cognitoFailure(err, "signup");
      // Signed up before but never entered the code: carry on to the code screen rather than
      // calling the account taken.
      const existing = await deps.auth.adminGetUser(input.email).catch(() => null);
      if (existing?.status !== "UNCONFIRMED") throw cognitoFailure(err, "signup");
      await limit(deps.coord, `rl:code:email:${sha256Hex(input.email)}`, LIMITS.codeEmail);
      await signUpAgain(c, input, existing);
    }
    return c.json({ ok: true, next: "confirm", email: input.email });
  });

  /**
   * A sign-up over an earlier one that was never confirmed. With the same password (the button
   * pressed twice, another tab) it is the same sign-up: a fresh code. With another password, this
   * one replaces it, so the password just typed is the one that works once the code is entered.
   * Keeping the first would let whoever started it (anyone can type someone's address) into the
   * account the inbox's owner then confirms. An unconfirmed sign-up never proved the inbox and
   * has nothing of ours behind it (a user row only exists after a sign-in), so nothing is lost.
   */
  async function signUpAgain(c: Ctx, input: { email: string; password: string; name: string }, existing: CognitoUser) {
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
      await deps.auth.resendSignUpCode(input.email).catch((e: unknown) => logger.warn({ err: e }, "resending a sign-up code failed"));
      return;
    }
    // Never one that is somebody's sign-in already (a confirmed user can't become unconfirmed; this is a guard).
    if (await systemDb.authIdentity.findUnique({ where: { provider_subject: { provider: "cognito", subject: existing.sub } } }).catch(dbOutage(SIGN_IN_UNAVAILABLE))) {
      throw new HttpError(409, "An account with that email already exists. Log in instead, or reset your password if you've forgotten it.", "account_exists");
    }
    await deps.auth.adminDeleteUser(existing.username).catch((err: unknown) => {
      throw cognitoFailure(err, "replace unconfirmed sign-up");
    });
    await deps.auth.signUp({ email: input.email, password: input.password, name: input.name }).catch((err: unknown) => {
      throw cognitoFailure(err, "signup");
    });
    await recordAuthEvent("unconfirmed_signup_replaced", null, clientIp(c), { cognitoSub: existing.sub });
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
    try {
      await deps.auth.confirmSignUp(input.email, input.code);
    } catch (err) {
      // Already confirmed (a second tab, a double press): nothing left to do here. Never a
      // sign-in: this request proved nothing (the page signs in through /auth/login instead).
      if (isCognito(err, "NotAuthorizedException") && /CONFIRMED/i.test((err as Error).message)) return c.json({ ok: true });
      throw cognitoFailure(err, "confirm signup");
    }
    if (!input.password) return c.json({ ok: true });
    const signIn = () =>
      deps.auth.passwordSignIn(input.email, input.password!).catch((err: unknown) => {
        if (isCognito(err, "NotAuthorizedException")) return null;
        throw cognitoFailure(err, "sign in after confirming");
      });
    let result = await signIn();
    if (!result) {
      // Not a password Cognito would take: the address is confirmed; "Forgot password?" sets one.
      if (accountPasswordProblem(input.password)) return c.json({ ok: true });
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

  app.post("/auth/signup/resend", async (c) => {
    requireAppOrigin(c);
    const { email } = z.object({ email: emailSchema }).parse(await body(c));
    await limit(deps.coord, `rl:code:ip:${clientIp(c)}`, LIMITS.codeIp);
    await limit(deps.coord, `rl:code:email:${sha256Hex(email)}`, LIMITS.codeEmail);
    await deps.auth.resendSignUpCode(email).catch((err: unknown) => {
      // Unknown or already confirmed: the same answer, so this can't be used to find accounts.
      if (isCognito(err, "UserNotFoundException", "InvalidParameterException", "NotAuthorizedException")) return;
      throw cognitoFailure(err, "resend signup code");
    });
    return c.json({ ok: true, message: CODE_SENT });
  });

  app.post("/auth/password/forgot", async (c) => {
    requireAppOrigin(c);
    const { email } = z.object({ email: emailSchema }).parse(await body(c));
    const ip = clientIp(c);
    await limit(deps.coord, `rl:code:ip:${ip}`, LIMITS.codeIp);
    await limit(deps.coord, `rl:code:email:${sha256Hex(email)}`, LIMITS.codeEmail);
    try {
      await provisionMovedAccount(email, ip);
      await deps.auth.forgotPassword(email);
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
    await deps.auth.confirmForgotPassword(input.email, input.code, input.password).catch((err: unknown) => {
      // Cognito answers an unknown address like a wrong code once user-existence errors are hidden.
      throw cognitoFailure(isCognito(err, "UserNotFoundException") ? new CognitoError("CodeMismatchException", "") : err, "reset password");
    });
    // A new password ends every session, everywhere: whoever knew the old one is out. Other ways
    // in (a linked Google account) stay, so the answer names them: the page asks the person to
    // check them in Settings → Security, where they can be removed. Only whoever holds the code
    // (the inbox) sees that.
    const user = await systemDb.user.findUnique({ where: { email: input.email }, include: { identities: true } }).catch(() => null);
    if (user) {
      await systemDb.user.update({ where: { id: user.id }, data: { sessionsValidAfter: new Date() } }).catch((err: unknown) => logger.error({ err }, "could not end sessions after a password reset"));
      for (const id of user.identities.filter((i) => i.method === "password")) {
        await deps.auth.adminGlobalSignOut(id.username).catch((err: unknown) => logger.warn({ err }, "Cognito sign-out after a password reset failed"));
      }
      await recordAuthEvent("password_reset", user.id, clientIp(c));
    }
    const otherMethods = [...new Set((user?.identities ?? []).filter((i) => i.method !== "password").map((i) => i.method))];
    return c.json({ ok: true, otherMethods });
  });

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
      await provisionMovedAccount(email, ip);
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
   * Leaves for Google, by way of the user pool. Errors land on the sign-in error page.
   *
   * `?keep=0`: "Keep me signed in" was unticked, so the session's cookies end with the browser.
   * `?link=1`: a signed-in person links Google to their account from Settings (no new session);
   * the callback sends them back to `returnTo` with `?linked=google`, or `?link_error=<code>`,
   * which is also where this route's own refusals go. A new way into the account needs the
   * person again: a sign-in in the last 15 minutes, or their password just now
   * (POST /auth/account/methods/google/prepare), like the account's other changes.
   */
  app.get("/auth/oauth/:provider/start", async (c) => {
    const appUrl = env().APP_URL;
    const returnTo = safeReturnTo(c.req.query("returnTo"));
    const linking = c.req.query("link") === "1";
    const fail = (reason: string) =>
      c.redirect(
        linking ? `${appUrl}${withParam(returnTo ?? LINK_RETURN, "link_error", reason)}` : `${appUrl}/auth/error?${new URLSearchParams({ reason, provider: c.req.param("provider") })}`,
      );
    const provider = PROVIDERS[c.req.param("provider")];
    if (!provider || !enabledProviders().has(provider)) return fail("provider_unavailable");
    try {
      await limit(deps.coord, `rl:oauth:${clientIp(c)}`, LIMITS.oauthIp);
    } catch {
      return fail("rate_limited");
    }
    let linkUserId: string | undefined;
    if (linking) {
      // The account's own session only: never one opened from a shared link (loadUser refuses those here).
      const user = await loadUser(c, deps).catch(() => undefined);
      if (user === undefined) return fail("unavailable");
      if (!user) return fail("signin_required");
      // Nobody has proved this account's address yet: a way in added now would outlive the
      // address's owner taking the account over (identity.ts, takeOverUnverified).
      if (!user.emailVerified) return fail("email_unverified");
      const hasGoogle = await systemDb.authIdentity.count({ where: { userId: user.id, method: "google" } }).catch(() => null);
      if (hasGoogle === null) return fail("unavailable");
      if (hasGoogle) return fail("already_linked");
      const s = sessionOf(c);
      if (!signedInRecently(s)) {
        const proof = await deps.coord.take(linkProofKey(s.sid)).catch(() => undefined);
        if (proof === undefined) return fail("unavailable");
        if (!proof) return fail("reauth_required");
      }
      linkUserId = user.id;
    }
    const state = randomToken(24);
    const nonce = randomToken(24);
    const pkce = pkcePair();
    const pending: PendingSignIn = {
      provider,
      verifier: pkce.verifier,
      nonce,
      returnTo,
      ...(c.req.query("keep") === "0" && { keep: false as const }),
      ...(linkUserId && { linkUserId }),
    };
    try {
      await deps.coord.put(`oauth:signin:${state}`, JSON.stringify(pending), OAUTH_STATE_TTL_S);
    } catch (err) {
      logger.error({ err }, "could not store a sign-in's state");
      return fail("unavailable");
    }
    // Only this browser can finish this sign-in (no login CSRF): the state must come back with this cookie.
    setCookie(c, OAUTH_COOKIE, [state, ...pendingStates(getCookie(c, OAUTH_COOKIE))].slice(0, MAX_PENDING_STATES).join("."), {
      ...cookieBase(),
      path: oauthCookiePath(),
      maxAge: OAUTH_STATE_TTL_S,
    });
    return c.redirect(deps.auth.authorizeUrl({ provider, redirectUri: redirectUri(), state, codeChallenge: pkce.challenge, nonce }));
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
    const user = await finishSignIn(c, tokens, { nonce: pendingSignIn.nonce, keep: pendingSignIn.keep });
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

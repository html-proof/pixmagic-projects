import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { systemDb } from "@app/db";
import { accessFingerprint, employmentsForUser, env, logger } from "@app/core";
import { ACCESS_KEYS, accountPasswordProblem, DISPLAY_NAME_MAX, EMAIL_CODE_RE, hasFullAccess, pkcePair, randomToken, safeEqual, sha256Hex } from "@app/shared";
import { body, clientIp, HttpError, loadUser, requireAppOrigin, requireUser, sessionOf, SESSION_COOKIE, type Ctx, type Deps } from "../context.js";
import { CognitoError, CognitoUnavailableError, type CognitoTokens, type FederatedProvider, type SignInResult } from "../cognito.js";
import { LegacyUnavailableError } from "../legacyFirebase.js";
import { recordAuthEvent, resolveUser } from "../identity.js";
import { apiPath, clearSessionCookies, newSession, readRefreshToken, readSession, retiredSessionKey, setSessionCookies } from "../session.js";
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
const pendingStates = (cookie: string | undefined) => (cookie ?? "").split(".").filter((n) => /^[A-Za-z0-9_-]{16,64}$/.test(n));

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
  if (err instanceof CognitoUnavailableError || err instanceof LegacyUnavailableError) {
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
  const cookieBase = () => ({ httpOnly: true, sameSite: "Lax" as const, secure: env().NODE_ENV === "production" });
  const redirectUri = () => `${env().APP_URL}/auth/callback`;

  /**
   * Cognito's tokens → our session. The ID token is verified here (signature against the pool's
   * keys, issuer, audience = our app client, token_use, expiry, and the nonce for OAuth); only
   * then is the person looked up, linked or created, and the session cookie set.
   */
  async function finishSignIn(c: Ctx, tokens: CognitoTokens, opts: { nonce?: string; firebaseUid?: string; keep?: boolean } = {}) {
    const claims = await deps.auth.verifyIdToken(tokens.idToken, { nonce: opts.nonce }).catch((err) => {
      throw cognitoFailure(err, "verify ID token");
    });
    const user = await resolveUser(claims, { firebaseUid: opts.firebaseUid, ip: clientIp(c) }).catch(dbOutage(SIGN_IN_UNAVAILABLE));
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
   * Someone signed in on Firebase before the move (users.firebase_uid) but has no Cognito user
   * yet: create one, without emailing them, so Cognito can send them a reset or sign-in code.
   * Their password stays unknown (random), so this grants nobody access by itself.
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

  /**
   * First Cognito sign-in of a Firebase password account (see legacyFirebase.ts). Returns null when
   * this isn't one: Cognito already has the person (its "wrong password" stands), migration is
   * off, or Firebase doesn't accept the password either.
   */
  async function moveFromFirebase(email: string, password: string, ip: string): Promise<{ result: SignInResult; firebaseUid: string } | null> {
    if (!deps.legacy) return null;
    if (await deps.auth.adminGetUser(email)) return null;
    const legacy = await deps.legacy.verifyPassword(email, password);
    if (!legacy) return null;
    try {
      const created = await deps.auth.adminCreateUser({ email, emailVerified: legacy.emailVerified, name: legacy.displayName, password });
      logger.info({ cognitoSub: created.sub }, "moved a Firebase password account to Cognito");
    } catch (err) {
      if (isCognito(err, "InvalidPasswordException")) {
        // Firebase accepted 6-character passwords; Cognito's policy doesn't. Move the account and
        // have them choose a new password with a code sent to the same inbox.
        await deps.auth.adminCreateUser({ email, emailVerified: true, name: legacy.displayName });
        await deps.auth.forgotPassword(email);
        await recordAuthEvent("firebase_account_needs_new_password", null, ip, { firebaseUid: legacy.uid });
        throw new HttpError(403, "We've upgraded our sign-in system and your password needs to be longer. We've emailed you a code to choose a new one.", "reset_required");
      }
      // A concurrent first sign-in created it a moment ago: sign in normally.
      if (!isCognito(err, "UsernameExistsException")) throw err;
    }
    return { result: await deps.auth.passwordSignIn(email, password), firebaseUid: legacy.uid };
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
    let firebaseUid: string | undefined;
    let result: SignInResult;
    try {
      result = await deps.auth.passwordSignIn(input.email, input.password);
    } catch (err) {
      if (!isCognito(err, "NotAuthorizedException", "UserNotFoundException")) throw cognitoFailure(err, "login");
      const moved = await moveFromFirebase(input.email, input.password, ip).catch((e: unknown) => {
        throw cognitoFailure(e, "login (moving from Firebase)");
      });
      if (!moved) throw cognitoFailure(err, "login");
      ({ result, firebaseUid } = moved);
    }
    const user = await finishSignIn(c, tokensOrChallenge(result), { firebaseUid, keep: input.keep });
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
      // Signed up before but never entered the code (or pressed the button twice): send a fresh
      // code and carry on to the code screen rather than calling the account taken.
      const existing = await deps.auth.adminGetUser(input.email).catch(() => null);
      if (existing?.status !== "UNCONFIRMED") throw cognitoFailure(err, "signup");
      await deps.auth.resendSignUpCode(input.email).catch((e: unknown) => logger.warn({ err: e }, "resending a sign-up code failed"));
    }
    return c.json({ ok: true, next: "confirm", email: input.email });
  });

  app.post("/auth/signup/confirm", async (c) => {
    requireAppOrigin(c);
    const input = z.object({ email: emailSchema, code: codeSchema }).parse(await body(c));
    await limit(deps.coord, `rl:code:verify:${clientIp(c)}`, LIMITS.codeVerifyIp);
    try {
      await deps.auth.confirmSignUp(input.email, input.code);
    } catch (err) {
      // Already confirmed (a second tab, a double press): nothing left to do.
      if (isCognito(err, "NotAuthorizedException") && /CONFIRMED/i.test((err as Error).message)) return c.json({ ok: true });
      throw cognitoFailure(err, "confirm signup");
    }
    return c.json({ ok: true });
  });

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
    // A new password ends every other session, everywhere: whoever knew the old one is out.
    const user = await systemDb.user.findUnique({ where: { email: input.email }, include: { identities: true } }).catch(() => null);
    if (user) {
      await systemDb.user.update({ where: { id: user.id }, data: { sessionsValidAfter: new Date() } }).catch((err: unknown) => logger.error({ err }, "could not end sessions after a password reset"));
      for (const id of user.identities.filter((i) => i.method === "password")) {
        await deps.auth.adminGlobalSignOut(id.username).catch((err: unknown) => logger.warn({ err }, "Cognito sign-out after a password reset failed"));
      }
      await recordAuthEvent("password_reset", user.id, clientIp(c));
    }
    return c.json({ ok: true });
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
    const user = await finishSignIn(c, tokensOrChallenge(result), { keep: input.keep });
    return c.json({ user: publicUser(user) });
  });

  // ---------------- Continue with Google (Cognito managed login, code + PKCE) ----------------

  /** Leaves for Google, by way of the user pool. Errors land on the sign-in error page. */
  app.get("/auth/oauth/:provider/start", async (c) => {
    const appUrl = env().APP_URL;
    const fail = (reason: string) => c.redirect(`${appUrl}/auth/error?${new URLSearchParams({ reason, provider: c.req.param("provider") })}`);
    const provider = PROVIDERS[c.req.param("provider")];
    if (!provider || !enabledProviders().has(provider)) return fail("provider_unavailable");
    try {
      await limit(deps.coord, `rl:oauth:${clientIp(c)}`, LIMITS.oauthIp);
    } catch {
      return fail("rate_limited");
    }
    const returnTo = c.req.query("returnTo");
    const state = randomToken(24);
    const nonce = randomToken(24);
    const pkce = pkcePair();
    try {
      await deps.coord.put(
        `oauth:signin:${state}`,
        JSON.stringify({ provider, verifier: pkce.verifier, nonce, returnTo: safePath(returnTo) ? returnTo : null }),
        OAUTH_STATE_TTL_S,
      );
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
    const pendingSignIn = JSON.parse(raw) as { provider: FederatedProvider; verifier: string; nonce: string; returnTo: string | null };
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
    const user = await finishSignIn(c, tokens, { nonce: pendingSignIn.nonce });
    return c.json({ user: publicUser(user), redirect: pendingSignIn.returnTo });
  });

  // ---------------- Session ----------------

  /** Sign out this browser (and, after Google, the user pool's own session in it). */
  app.post("/auth/logout", async (c) => {
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
      if (s.m !== "password") redirect = deps.auth.logoutUrl(`${env().APP_URL}/login?signedOut=1`);
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
    return c.json({ ok: true, redirect: s.m !== "password" ? deps.auth.logoutUrl(`${env().APP_URL}/login?signedOut=1`) : null });
  };
  app.post("/auth/logout-all", signOutEverywhere);
  // The employee portal's name for it.
  app.post("/auth/sessions/revoke", signOutEverywhere);

  async function me(c: Ctx, user: Awaited<ReturnType<typeof requireUser>>) {
    const memberships = await systemDb.membership.findMany({
      where: { userId: user.id },
      include: { workspace: { select: { id: true, name: true } } },
      orderBy: { createdAt: "asc" },
    });
    return c.json({
      user: publicUser(user),
      // Each with what this person may see there (Team & Access). A revoked membership is listed as
      // such, with nothing granted, so the app can say access was revoked rather than offer to set up
      // a workspace of their own.
      workspaces: memberships.map((m) => ({
        id: m.workspace.id,
        name: m.workspace.name,
        role: m.role,
        staffRole: m.staffRole,
        permissions: m.revokedAt ? [] : hasFullAccess(m.role) ? [...ACCESS_KEYS] : m.permissions,
        status: m.revokedAt ? "revoked" : "active",
        fingerprint: accessFingerprint(m),
      })),
      // Organizations this account works for as an employee (the employee portal).
      employments: await employmentsForUser(user.id),
    });
  }

  app.get("/me", async (c) => me(c, await requireUser(c, deps)));

  /**
   * The public homepage's "already signed in?" check: GET /me's answer for a session, and
   * `{ user: null }` with a 200 for everyone else. A 401 there is expected, but every browser logs
   * it as a console error on the page most visitors see. Outages still answer 503 (loadUser).
   */
  app.get("/auth/whoami", async (c) => {
    const user = await loadUser(c, deps);
    return user ? me(c, user) : c.json({ user: null, workspaces: [] });
  });

  /** This session: who, how they signed in, and until when. */
  app.get("/auth/session", async (c) => {
    const user = await loadUser(c, deps);
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

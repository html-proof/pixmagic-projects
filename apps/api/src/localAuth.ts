import { createHash, createHmac, randomBytes, randomInt, randomUUID } from "node:crypto";
import { createRemoteJWKSet, customFetch, decodeJwt, jwtVerify, SignJWT, type JWTPayload } from "jose";
import { authEmail, env, keyring, logger, type AuthEmailTrigger, type Coord, type FetchLike, type Mailer } from "@app/core";
import { decrypt, encrypt, safeEqual } from "@app/shared";
import { AccountExistsError, type AccountMethod, type AuthAccountRow, type AuthStore } from "./authStore.js";
import { CognitoError, CognitoUnavailableError, pictureUrl, type CognitoAuth, type CognitoTokens, type CognitoUser, type IdentityClaims, type SignInResult } from "./cognito.js";
import { burnPasswordCheck, hashPassword, needsRehash, verifyPassword } from "./passwords.js";
import { newTotpSecret, totpStep } from "./totp.js";

/**
 * The app's own sign-in, in place of Amazon Cognito's user pool (docs/ikorex-migration: the AWS
 * account closes). It is a CognitoAuth: the same operations, the same answers and the same error
 * names (NotAuthorizedException, CodeMismatchException, ...) that routes/auth.ts, account.ts,
 * staffPortal.ts and context.ts already handle, so none of them changes. AUTH_MODE picks it
 * (apps/aws/src/app.ts): "local" on its own, "migrating" behind migratingAuth.ts, which moves
 * Cognito's users over one sign-in at a time.
 *
 * - Accounts in auth_accounts (authStore.ts), under the sub Cognito gave them when they came from
 *   there, so auth_identities and every session keep matching. Passwords as argon2id
 *   (passwords.ts); authenticator secrets encrypted with TOKEN_ENCRYPTION_KEYS.
 * - Tokens: ID and access tokens are JWTs signed with a key derived from SESSION_SECRET (HS256, one
 *   hour), never sent to a browser (the session cookie is ours already, session.ts). Refresh
 *   tokens are random, kept only as a SHA-256, ended by sign-out.
 * - Codes (sign-up, reset, address change, emailed sign-in) are 6 digits, kept as an HMAC under
 *   OTP_PEPPER in the coordinator, five wrong guesses each, and emailed with the templates Cognito's
 *   email function used (@app/core authEmail).
 * - Google: the app's own OAuth client (GOOGLE_SIGNIN_CLIENT_ID / _SECRET), authorization code with
 *   PKCE and a nonce, Google's ID token checked against Google's keys. Its redirect is the same
 *   /auth/callback page Cognito returned to.
 *
 * Anything that isn't a verdict on what the person typed (the database or Google unreachable)
 * throws CognitoUnavailableError, which the routes show as "try again", never as a refusal.
 */

export const LOCAL_ISSUER = "bizinsights:auth";
const AUDIENCE = "bizinsights";
const TOKEN_TTL_S = 3600;
const REFRESH_TTL_MS = 30 * 24 * 3600 * 1000;
const REFRESH_PREFIX = "lrt1.";
/** An authenticator-code step at sign-in: three minutes and three wrong codes, as Cognito's. */
const MFA_TTL_S = 180;
const MFA_MAX_WRONG = 3;
/** Wrong guesses one emailed code takes before it is thrown away. */
const CODE_MAX_WRONG = 5;
const CODE_TTL_S = { signup: 24 * 3600, reset: 3600, verify: 24 * 3600, otp: 180 } as const;
type CodePurpose = keyof typeof CODE_TTL_S;

export interface GoogleSignIn {
  clientId: string;
  clientSecret: string;
}

export interface LocalAuthDeps {
  store: AuthStore;
  coord: Coord;
  mailer: Mailer;
  fetchImpl?: FetchLike;
  /** Google sign-in on the app's own OAuth client; null: no Google. */
  google?: GoogleSignIn | null;
  /**
   * true ("local"): someone Cognito knew who has no account here yet (auth_identities only) is
   * found anyway, as an account with no password, so "Forgot password?" and Google bring them in.
   * false ("migrating"): migratingAuth.ts asks Cognito about them instead.
   */
  findCognitoUsers?: boolean;
}

/** What migratingAuth.ts needs beyond CognitoAuth. */
export interface LocalAuth extends CognitoAuth {
  /** Tokens for an account, as a sign-in would give. */
  issue(sub: string, opts?: { nonce?: string }): Promise<CognitoTokens>;
  isLocalToken(token: string): boolean;
  isLocalRefreshToken(token: string): boolean;
  store: AuthStore;
}

const err = (code: string, message = code) => new CognitoError(code, message);
const lower = (s: string) => s.trim().toLowerCase();
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Cognito's password policy for this pool (infra/aws/cognito.yaml): 8 to 256 characters, no edge spaces. */
function policy(password: string) {
  if (password.length < 8) throw err("InvalidPasswordException", "Password did not conform with policy: Password not long enough");
  if (password.length > 256 || password.trim() !== password) throw err("InvalidPasswordException", "Password did not conform with policy");
}

export function googleSignInConfig(): GoogleSignIn | null {
  const e = env();
  return e.GOOGLE_SIGNIN_CLIENT_ID && e.GOOGLE_SIGNIN_CLIENT_SECRET ? { clientId: e.GOOGLE_SIGNIN_CLIENT_ID, clientSecret: e.GOOGLE_SIGNIN_CLIENT_SECRET } : null;
}

export function localAuth(deps: LocalAuthDeps): LocalAuth {
  const { store, coord, mailer } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const google = deps.google ?? null;
  const findCognito = deps.findCognitoUsers ?? true;
  const signingKey = () => createHmac("sha256", env().SESSION_SECRET).update("local-auth-token-v1").digest();
  const codeHash = (purpose: string, sub: string, code: string) => createHmac("sha256", env().OTP_PEPPER || env().SESSION_SECRET).update(`local-auth:${purpose}:${sub}:${code}`).digest("hex");
  const totpAad = (sub: string) => `totp-secret-v1:${sub}`;
  const googleJwks = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"), { [customFetch]: fetchImpl });

  /** Every store and coordinator call: an outage is "try again", not a verdict. */
  async function guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof CognitoError || e instanceof CognitoUnavailableError) throw e;
      throw new CognitoUnavailableError(`sign-in store unavailable: ${(e as Error).message}`, e);
    }
  }

  /** A shell for someone Cognito knew (auth_identities) who has no account here: no password yet. */
  async function fromCognitoIdentity(i: { sub: string; username: string; email: string | null; method: AccountMethod }, googleSub?: string): Promise<AuthAccountRow | null> {
    const existing = await store.bySub(i.sub);
    if (existing) return existing;
    try {
      return await store.create({
        sub: i.sub,
        username: i.username,
        loginEmail: i.method === "password" && i.email ? i.email : null,
        email: i.email ?? "",
        // The address is the one a sign-in at Cognito vouched for.
        emailVerified: !!i.email,
        pendingEmail: null,
        name: null,
        picture: null,
        method: i.method,
        passwordHash: null,
        googleSub: i.method === "google" ? (googleSub ?? i.username.replace(/^google_/, "")) : null,
        confirmed: true,
        enabled: true,
        totpSecret: null,
        totpPending: null,
        totpEnabled: false,
        movedFrom: "cognito",
        movedAt: new Date(),
      });
    } catch (e) {
      if (e instanceof AccountExistsError) return (await store.bySub(i.sub)) ?? null;
      throw e;
    }
  }

  async function byEmail(email: string): Promise<AuthAccountRow | null> {
    const a = await store.byLoginEmail(lower(email));
    if (a || !findCognito) return a;
    const i = await store.cognitoPasswordIdentityByEmail(lower(email));
    return i ? fromCognitoIdentity(i) : null;
  }
  async function byUsername(username: string): Promise<AuthAccountRow | null> {
    const a = (await store.byUsername(username)) ?? (username.includes("@") ? await store.byLoginEmail(lower(username)) : null);
    if (a || !findCognito) return a;
    const i = (await store.cognitoIdentityByUsername(username)) ?? (username.includes("@") ? await store.cognitoPasswordIdentityByEmail(lower(username)) : null);
    return i ? fromCognitoIdentity(i) : null;
  }

  // ---- Tokens ----
  async function sign(a: AuthAccountRow, use: "id" | "access", authTime: number, nonce?: string): Promise<string> {
    const claims: JWTPayload & Record<string, unknown> = {
      token_use: use,
      "cognito:username": a.username,
      auth_time: authTime,
      "bi:method": a.method,
      // To the millisecond (iat is in seconds): what "sign out everywhere" is compared with.
      "bi:iat": Date.now(),
    };
    if (use === "id") {
      Object.assign(claims, { email: a.email || undefined, email_verified: a.emailVerified, name: a.name ?? undefined, picture: a.picture ?? undefined });
      if (nonce !== undefined) claims.nonce = nonce;
    }
    return new SignJWT(claims)
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(LOCAL_ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(a.sub)
      .setIssuedAt()
      .setJti(randomUUID())
      .setExpirationTime(`${TOKEN_TTL_S}s`)
      .sign(signingKey());
  }
  async function tokensFor(a: AuthAccountRow, opts: { nonce?: string; authTime?: number; withRefresh?: boolean } = {}): Promise<CognitoTokens> {
    const authTime = opts.authTime ?? Math.floor(Date.now() / 1000);
    const [idToken, accessToken] = await Promise.all([sign(a, "id", authTime, opts.nonce), sign(a, "access", authTime)]);
    let refreshToken: string | undefined;
    if (opts.withRefresh !== false) {
      refreshToken = REFRESH_PREFIX + randomBytes(32).toString("base64url");
      await store.addRefreshToken(sha256(refreshToken), a.sub, new Date(Date.now() + REFRESH_TTL_MS));
    }
    return { idToken, accessToken, refreshToken, expiresIn: TOKEN_TTL_S };
  }
  async function verified(token: string, use: "id" | "access") {
    try {
      const { payload } = await jwtVerify(token, signingKey(), { issuer: LOCAL_ISSUER, audience: AUDIENCE, algorithms: ["HS256"] });
      if (payload.token_use !== use || !payload.sub) throw new Error(`not an ${use} token`);
      return payload as JWTPayload & Record<string, unknown> & { sub: string };
    } catch (e) {
      throw err(use === "access" ? "NotAuthorizedException" : "InvalidToken", use === "access" ? "Access Token has been revoked" : `ID token rejected: ${(e as Error).message}`);
    }
  }
  /** The account an access token is for, still enabled and not signed out everywhere since. */
  async function byAccessToken(accessToken: string): Promise<AuthAccountRow> {
    const p = await verified(accessToken, "access");
    const a = await store.bySub(p.sub);
    const issued = typeof p["bi:iat"] === "number" ? p["bi:iat"] : (p.iat ?? 0) * 1000;
    if (!a || !a.enabled || issued <= a.tokensValidAfter.getTime()) throw err("NotAuthorizedException", "Access Token has been revoked");
    return a;
  }

  /** A sign-in that got past the password: tokens, or the authenticator step when it is on. */
  async function signedIn(a: AuthAccountRow): Promise<SignInResult> {
    if (!a.totpEnabled || !a.totpSecret) return { tokens: await tokensFor(a) };
    const session = randomBytes(32).toString("base64url");
    await coord.put(`la:mfa:${session}`, JSON.stringify({ sub: a.sub, wrong: 0, exp: Date.now() + MFA_TTL_S * 1000 }), MFA_TTL_S);
    return { challenge: "SOFTWARE_TOKEN_MFA", session, username: a.username };
  }

  // ---- Codes ----
  async function sendCode(a: AuthAccountRow, purpose: CodePurpose, trigger: AuthEmailTrigger, to = a.email): Promise<void> {
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    await coord.put(`la:code:${purpose}:${a.sub}`, JSON.stringify({ h: codeHash(purpose, a.sub, code), wrong: 0, exp: Date.now() + CODE_TTL_S[purpose] * 1000 }), CODE_TTL_S[purpose]);
    const message = authEmail({ trigger, code, name: a.name, email: to, appUrl: env().APP_URL, senders: env() });
    if (!message) throw new CognitoUnavailableError(`no email template for ${trigger}`);
    try {
      await mailer.send(to, message.subject, message.text, message.html, { purpose: message.purpose });
    } catch (e) {
      // The code stands; the person can ask for another. Cognito's email function failing looked the same.
      logger.error({ err: e, trigger }, "local auth: could not email a code");
      throw new CognitoUnavailableError("could not email the code", e);
    }
  }
  /** Spends a right code (once); a wrong one counts, and the fifth ends it. */
  async function checkCode(a: AuthAccountRow, purpose: CodePurpose, code: string): Promise<void> {
    const key = `la:code:${purpose}:${a.sub}`;
    const raw = await coord.peek(key);
    if (!raw) throw err("ExpiredCodeException", "Invalid code provided, please request a code again.");
    const c = JSON.parse(raw) as { h: string; wrong: number; exp: number };
    if (c.exp <= Date.now()) {
      await coord.take(key);
      throw err("ExpiredCodeException", "Invalid code provided, please request a code again.");
    }
    if (!/^\d{6}$/.test(code) || !safeEqual(codeHash(purpose, a.sub, code), c.h)) {
      const wrong = c.wrong + 1;
      if (wrong >= CODE_MAX_WRONG) await coord.take(key);
      else await coord.put(key, JSON.stringify({ ...c, wrong }), Math.max(1, Math.ceil((c.exp - Date.now()) / 1000)));
      throw err("CodeMismatchException", "Invalid verification code provided, please try again.");
    }
    // One atomic take: two right answers at once can't both pass.
    if (!(await coord.take(key))) throw err("ExpiredCodeException", "Invalid code provided, please request a code again.");
  }

  async function setPassword(a: AuthAccountRow, password: string, extra: Partial<AuthAccountRow> = {}): Promise<void> {
    policy(password);
    await store.update(a.sub, { passwordHash: await hashPassword(password), confirmed: true, ...extra });
  }
  async function signOutEverywhere(sub: string): Promise<void> {
    await store.update(sub, { tokensValidAfter: new Date() });
    await store.revokeRefreshTokens(sub);
  }
  const asUser = (a: AuthAccountRow): CognitoUser => ({
    username: a.username,
    sub: a.sub,
    email: a.email || null,
    emailVerified: a.emailVerified,
    enabled: a.enabled,
    status: a.method === "google" ? "EXTERNAL_PROVIDER" : a.confirmed ? "CONFIRMED" : "UNCONFIRMED",
    mfaEnabled: a.totpEnabled && !!a.totpSecret,
  });

  // ---- Google ----
  async function googleTokens(code: string, redirectUri: string, codeVerifier: string): Promise<JWTPayload & Record<string, unknown>> {
    if (!google) throw err("NotConfigured", "Google sign-in is not configured");
    let res: Response;
    try {
      res = await fetchImpl("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: codeVerifier, client_id: google.clientId, client_secret: google.clientSecret }),
      });
    } catch (e) {
      throw new CognitoUnavailableError(`Google unreachable: ${(e as Error).message}`, e);
    }
    const json = (await res.json().catch(() => ({}))) as { id_token?: string; error?: string };
    if (!res.ok || !json.id_token) {
      if (res.status === 400 || json.error === "invalid_grant") throw err("invalid_grant", `Google refused the code (${json.error ?? res.status})`);
      throw new CognitoUnavailableError(`Google token endpoint failed (${res.status})`);
    }
    try {
      const { payload } = await jwtVerify(json.id_token, googleJwks, { issuer: ["https://accounts.google.com", "accounts.google.com"], audience: google.clientId, algorithms: ["RS256"] });
      return payload as JWTPayload & Record<string, unknown>;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "ERR_JWKS_TIMEOUT" || e instanceof TypeError) throw new CognitoUnavailableError("Could not fetch Google's signing keys", e);
      throw err("InvalidToken", `Google ID token rejected: ${(e as Error).message}`);
    }
  }
  async function googleAccount(p: JWTPayload & Record<string, unknown>): Promise<AuthAccountRow> {
    const googleSub = String(p.sub ?? "");
    if (!googleSub) throw err("InvalidToken", "Google ID token has no subject");
    const email = typeof p.email === "string" ? lower(p.email) : "";
    const profile = {
      email,
      emailVerified: p.email_verified === true || p.email_verified === "true",
      name: typeof p.name === "string" && p.name ? p.name : [p.given_name, p.family_name].filter((v) => typeof v === "string" && v).join(" ") || null,
      picture: pictureUrl(p.picture),
    };
    const username = `google_${googleSub}`;
    const known = (await store.byGoogleSub(googleSub)) ?? (await store.byUsername(username));
    if (known) return (await store.update(known.sub, profile)) ?? known;
    // Someone who used Google through Cognito: Cognito named them google_<Google's sub>, and kept a sub of its own.
    const i = await store.cognitoIdentityByUsername(username);
    try {
      return await store.create({
        sub: i?.sub ?? randomUUID(),
        username,
        loginEmail: null,
        ...profile,
        pendingEmail: null,
        method: "google",
        passwordHash: null,
        googleSub,
        confirmed: true,
        enabled: true,
        totpSecret: null,
        totpPending: null,
        totpEnabled: false,
        movedFrom: i ? "cognito" : null,
        movedAt: i ? new Date() : null,
      });
    } catch (e) {
      if (e instanceof AccountExistsError) {
        const again = (await store.byGoogleSub(googleSub)) ?? (i ? await store.bySub(i.sub) : null);
        if (again) return again;
      }
      throw e;
    }
  }

  const auth: LocalAuth = {
    store,
    isLocalToken(token) {
      try {
        return decodeJwt(token).iss === LOCAL_ISSUER;
      } catch {
        return false;
      }
    },
    isLocalRefreshToken: (token) => token.startsWith(REFRESH_PREFIX),
    issue: (sub, opts = {}) =>
      guard(async () => {
        const a = await store.bySub(sub);
        if (!a || !a.enabled) throw err("NotAuthorizedException", "User is disabled.");
        return tokensFor(a, opts);
      }),

    // ---- Sign-up and sign-in ----
    signUp: ({ email, password, name }) =>
      guard(async () => {
        const address = lower(email);
        if (await byEmail(address)) throw err("UsernameExistsException", "An account with the given email already exists.");
        policy(password);
        const sub = randomUUID();
        let a: AuthAccountRow;
        try {
          a = await store.create({
            sub,
            username: sub,
            loginEmail: address,
            email: address,
            emailVerified: false,
            pendingEmail: null,
            name: name || null,
            picture: null,
            method: "password",
            passwordHash: await hashPassword(password),
            googleSub: null,
            confirmed: false,
            enabled: true,
            totpSecret: null,
            totpPending: null,
            totpEnabled: false,
            movedFrom: null,
            movedAt: null,
          });
        } catch (e) {
          if (e instanceof AccountExistsError) throw err("UsernameExistsException", "An account with the given email already exists.");
          throw e;
        }
        await sendCode(a, "signup", "CustomEmailSender_SignUp");
        return { sub, confirmed: false };
      }),
    confirmSignUp: (email, code) =>
      guard(async () => {
        const a = await store.byLoginEmail(lower(email));
        if (!a) throw err("UserNotFoundException", "Username/client id combination not found.");
        if (a.confirmed) throw err("NotAuthorizedException", "User cannot be confirmed. Current status is CONFIRMED");
        await checkCode(a, "signup", code);
        await store.update(a.sub, { confirmed: true, emailVerified: true });
      }),
    resendSignUpCode: (email) =>
      guard(async () => {
        const a = await store.byLoginEmail(lower(email));
        if (!a) throw err("UserNotFoundException", "Username/client id combination not found.");
        if (a.confirmed) throw err("InvalidParameterException", "User is already confirmed.");
        await sendCode(a, "signup", "CustomEmailSender_ResendCode");
      }),
    passwordSignIn: (email, password) =>
      guard(async () => {
        const a = await store.byLoginEmail(lower(email));
        if (!a?.passwordHash) {
          await burnPasswordCheck(password);
          throw err("NotAuthorizedException", "Incorrect username or password.");
        }
        const ok = await verifyPassword(password, a.passwordHash);
        if (!ok || !a.enabled) throw err("NotAuthorizedException", ok ? "User is disabled." : "Incorrect username or password.");
        if (!a.confirmed) throw err("UserNotConfirmedException", "User is not confirmed.");
        if (needsRehash(a.passwordHash)) await setPassword(a, password).catch((e: unknown) => logger.warn({ err: e }, "local auth: could not rehash a password"));
        return signedIn(a);
      }),
    startEmailOtp: (email) =>
      guard(async () => {
        const a = await store.byLoginEmail(lower(email));
        if (!a || !a.emailVerified || !a.enabled) throw err("NotAuthorizedException", "Incorrect username or password.");
        const session = randomBytes(24).toString("base64url");
        await coord.put(`la:otp:${session}`, a.sub, CODE_TTL_S.otp);
        await sendCode(a, "otp", "CustomEmailSender_Authentication");
        return { session };
      }),
    answerEmailOtp: (email, session, code) =>
      guard(async () => {
        const a = await store.byLoginEmail(lower(email));
        const sub = await coord.peek(`la:otp:${session}`);
        if (!a || !sub || sub !== a.sub) throw err("NotAuthorizedException", "Invalid session for the user.");
        await checkCode(a, "otp", code);
        await coord.take(`la:otp:${session}`);
        return { tokens: await tokensFor(a) };
      }),
    refresh: (refreshToken, username) =>
      guard(async () => {
        const invalid = () => err("NotAuthorizedException", "Invalid Refresh Token");
        if (!refreshToken.startsWith(REFRESH_PREFIX)) throw invalid();
        const t = await store.refreshToken(sha256(refreshToken));
        if (!t || t.revokedAt || t.expiresAt.getTime() <= Date.now()) throw invalid();
        const a = await store.bySub(t.sub);
        if (!a || a.username !== username || !a.enabled || t.createdAt.getTime() < a.tokensValidAfter.getTime()) throw invalid();
        // No rotation (as the Cognito app client): the same refresh token goes on working.
        return tokensFor(a, { authTime: Math.floor(t.createdAt.getTime() / 1000), withRefresh: false });
      }),
    async verifyIdToken(idToken, opts = {}) {
      const p = await verified(idToken, "id");
      if (opts.nonce !== undefined && p.nonce !== opts.nonce) throw err("InvalidToken", "ID token nonce does not match the sign-in");
      const claims: IdentityClaims = {
        sub: p.sub,
        username: String(p["cognito:username"] ?? p.sub),
        email: typeof p.email === "string" ? p.email.toLowerCase() : null,
        emailVerified: p.email_verified === true,
        name: typeof p.name === "string" && p.name ? p.name : null,
        picture: pictureUrl(p.picture),
        method: p["bi:method"] === "google" ? "google" : "password",
        authTime: Number(p.auth_time ?? p.iat ?? 0),
      };
      return claims;
    },

    // ---- Passwords ----
    forgotPassword: (email) =>
      guard(async () => {
        const a = await byEmail(email);
        if (!a || a.method !== "password") throw err("UserNotFoundException", "Username/client id combination not found.");
        if (!a.emailVerified) throw err("InvalidParameterException", "Cannot reset password for the user as there is no registered/verified email");
        await sendCode(a, "reset", "CustomEmailSender_ForgotPassword");
      }),
    confirmForgotPassword: (email, code, password) =>
      guard(async () => {
        const a = await byEmail(email);
        if (!a || a.method !== "password") throw err("UserNotFoundException", "Username/client id combination not found.");
        await checkCode(a, "reset", code);
        // The code came to the address: it is proven, and an unfinished sign-up is finished.
        await setPassword(a, password, { emailVerified: true });
      }),
    changePassword: (accessToken, previous, proposed) =>
      guard(async () => {
        const a = await byAccessToken(accessToken);
        if (!(await verifyPassword(previous, a.passwordHash))) throw err("NotAuthorizedException", "Incorrect username or password.");
        await setPassword(a, proposed);
      }),

    // ---- The signed-in person's own account ----
    updateEmail: (accessToken, email) =>
      guard(async () => {
        const a = await byAccessToken(accessToken);
        const address = lower(email);
        const other = await byEmail(address);
        if (other && other.sub !== a.sub) throw err("AliasExistsException", "An account with the given email already exists.");
        await store.update(a.sub, { pendingEmail: address });
        await sendCode({ ...a, pendingEmail: address }, "verify", "CustomEmailSender_UpdateUserAttribute", address);
      }),
    sendEmailVerificationCode: (accessToken) =>
      guard(async () => {
        const a = await byAccessToken(accessToken);
        await sendCode(a, "verify", "CustomEmailSender_VerifyUserAttribute");
      }),
    verifyEmail: (accessToken, code) =>
      guard(async () => {
        const a = await byAccessToken(accessToken);
        await checkCode(a, "verify", code);
        const patch: Partial<AuthAccountRow> = { emailVerified: true };
        if (a.pendingEmail) Object.assign(patch, { email: a.pendingEmail, pendingEmail: null, ...(a.method === "password" && { loginEmail: a.pendingEmail }) });
        try {
          await store.update(a.sub, patch);
        } catch (e) {
          if (e instanceof AccountExistsError) throw err("AliasExistsException", "An account with the given email already exists.");
          throw e;
        }
      }),
    globalSignOut: (accessToken) => guard(async () => signOutEverywhere((await byAccessToken(accessToken)).sub)),
    revokeRefreshToken: (refreshToken) =>
      guard(async () => {
        if (refreshToken.startsWith(REFRESH_PREFIX)) await store.revokeRefreshToken(sha256(refreshToken));
      }),

    // ---- Two-step verification ----
    associateTotp: (accessToken) =>
      guard(async () => {
        const a = await byAccessToken(accessToken);
        const secret = newTotpSecret();
        await store.update(a.sub, { totpPending: encrypt(secret, keyring(), totpAad(a.sub)) });
        return { secret };
      }),
    verifyTotp: (accessToken, code) =>
      guard(async () => {
        const a = await byAccessToken(accessToken);
        const pending = a.totpPending ? decrypt(a.totpPending, keyring(), totpAad(a.sub)) : null;
        if (!pending || totpStep(pending, code) === null) throw err("EnableSoftwareTokenMFAException", "Code mismatch");
        // A new app replaces the old one; whether sign-in asks for it stays as it was.
        await store.update(a.sub, { totpSecret: a.totpPending, totpPending: null });
        return true;
      }),
    setTotpEnabled: (accessToken, enabled) =>
      guard(async () => {
        const a = await byAccessToken(accessToken);
        if (enabled && !a.totpSecret) throw err("InvalidParameterException", "User has not verified software token mfa");
        await store.update(a.sub, { totpEnabled: enabled });
      }),
    answerTotpChallenge: (username, session, code) =>
      guard(async () => {
        const key = `la:mfa:${session}`;
        const raw = await coord.peek(key);
        const s = raw ? (JSON.parse(raw) as { sub: string; wrong: number; exp: number }) : null;
        const a = await store.byUsername(username);
        if (!s || !a || s.sub !== a.sub || s.exp <= Date.now() || !a.enabled) throw err("NotAuthorizedException", "Invalid session for the user, session is expired.");
        const secret = a.totpSecret && a.totpEnabled ? decrypt(a.totpSecret, keyring(), totpAad(a.sub)) : null;
        const step = secret ? totpStep(secret, code) : null;
        // A code is good once: the same one again (someone looking over a shoulder) is refused.
        if (step === null || !(await coord.acquire(`la:totp-used:${a.sub}:${step}`, 120_000))) {
          const wrong = s.wrong + 1;
          if (wrong >= MFA_MAX_WRONG) await coord.take(key);
          else await coord.put(key, JSON.stringify({ ...s, wrong }), Math.max(1, Math.ceil((s.exp - Date.now()) / 1000)));
          throw err("CodeMismatchException", "Invalid code received for user");
        }
        if (!(await coord.take(key))) throw err("NotAuthorizedException", "Invalid session for the user, session is expired.");
        return { tokens: await tokensFor(a) };
      }),

    // ---- Google, on the app's own OAuth client ----
    authorizeUrl({ provider, redirectUri, state, codeChallenge, nonce, selectAccount }) {
      if (provider !== "Google" || !google) throw err("NotConfigured", "Google sign-in is not configured");
      const q = new URLSearchParams({
        response_type: "code",
        client_id: google.clientId,
        redirect_uri: redirectUri,
        scope: "openid email profile",
        state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        nonce,
        ...(selectAccount && { prompt: "select_account" }),
      });
      return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
    },
    exchangeCode: ({ code, redirectUri, codeVerifier }) =>
      guard(async () => {
        const p = await googleTokens(code, redirectUri, codeVerifier);
        const a = await googleAccount(p);
        if (!a.enabled) throw err("NotAuthorizedException", "User is disabled.");
        return tokensFor(a, { nonce: typeof p.nonce === "string" ? p.nonce : undefined });
      }),
    // No browser session of ours at Google to end.
    logoutUrl: () => null,

    // ---- Administrator ----
    adminGetUser: (username) =>
      guard(async () => {
        const a = await byUsername(username);
        return a ? asUser(a) : null;
      }),
    adminCreateUser: ({ email, emailVerified, name, password }) =>
      guard(async () => {
        const address = lower(email);
        if (await byEmail(address)) throw err("UsernameExistsException", "An account with the given email already exists.");
        if (password !== undefined) policy(password);
        const sub = randomUUID();
        try {
          const a = await store.create({
            sub,
            username: sub,
            loginEmail: address,
            email: address,
            emailVerified,
            pendingEmail: null,
            name: name ?? null,
            picture: null,
            method: "password",
            passwordHash: password !== undefined ? await hashPassword(password) : null,
            googleSub: null,
            confirmed: true,
            enabled: true,
            totpSecret: null,
            totpPending: null,
            totpEnabled: false,
            movedFrom: null,
            movedAt: null,
          });
          return asUser(a);
        } catch (e) {
          if (e instanceof AccountExistsError) throw err("UsernameExistsException", "An account with the given email already exists.");
          throw e;
        }
      }),
    adminSetPassword: (username, password) =>
      guard(async () => {
        const a = await byUsername(username);
        if (!a) throw err("UserNotFoundException", "User does not exist.");
        await setPassword(a, password);
      }),
    adminDeleteUser: (username) =>
      guard(async () => {
        const a = (await store.byUsername(username)) ?? (username.includes("@") ? await store.byLoginEmail(lower(username)) : null);
        if (a) await store.remove(a.sub);
      }),
    adminGlobalSignOut: (username) =>
      guard(async () => {
        const a = (await store.byUsername(username)) ?? (username.includes("@") ? await store.byLoginEmail(lower(username)) : null);
        if (a) await signOutEverywhere(a.sub);
      }),
  };
  return auth;
}

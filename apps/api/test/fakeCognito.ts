import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { CognitoError, CognitoUnavailableError, type CognitoAuth, type CognitoTokens, type CognitoUser, type FederatedProvider, type IdentityClaims, type SignInMethod } from "../src/authContract.js";

/**
 * An in-memory Cognito user pool that behaves like the real one where the app depends on it:
 * email-as-username native users, UNCONFIRMED until the sign-up code, codes per purpose,
 * refresh tokens bound to their user (and ended by sign-out), federated users with their own
 * subs, PKCE checked on the code exchange, two-step verification with an authenticator app
 * (real TOTP codes, a SOFTWARE_TOKEN_MFA challenge at sign-in), and Cognito's exception names.
 * ID tokens are `fake.<base64url JSON>`: the real verification (signature, issuer, audience) is
 * covered against real keys in cognito.test.ts.
 */
export interface FakeUser {
  sub: string;
  username: string;
  email: string;
  emailVerified: boolean;
  pendingEmail?: string;
  name: string | null;
  /** A Google user's picture (the pool maps Google's `picture`). */
  picture?: string | null;
  password: string | null;
  status: "CONFIRMED" | "UNCONFIRMED";
  enabled: boolean;
  method: SignInMethod;
  /** Two-step verification: the registered app's secret, and whether sign-in asks for its code. */
  totp?: { secret: string; enabled: boolean };
  /** A secret from AssociateSoftwareToken that no code has verified yet. */
  totpPending?: string;
}

export type FakeCognito = ReturnType<typeof fakeCognito>;

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 6238 with Cognito's parameters (HMAC-SHA1, 6 digits, 30 seconds), from a base32 secret. */
export function totpCode(secret: string, at = Date.now()): string {
  let bits = "";
  for (const ch of secret.replace(/=+$/, "").toUpperCase()) bits += B32.indexOf(ch).toString(2).padStart(5, "0");
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const h = createHmac("sha1", key).update(counter).digest();
  const o = h[h.length - 1]! & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

/** Cognito accepts the codes 30 seconds either side of now (clock skew). */
const totpMatches = (secret: string, code: string) => [-30_000, 0, 30_000].some((d) => totpCode(secret, Date.now() + d) === code);

export function fakeCognito() {
  const users = new Map<string, FakeUser>();
  /** Codes "sent", newest last: what an inbox would have received. */
  const sent: Array<{ kind: "signup" | "reset" | "verify" | "otp"; email: string; code: string }> = [];
  const codes = new Map<string, string>();
  const refreshTokens = new Map<string, string>();
  const accessTokens = new Map<string, string>();
  /** Federated codes handed back by the fake "Google": code -> user, PKCE challenge, nonce. */
  const oauthCodes = new Map<string, { username: string; challenge: string; nonce: string; redirectUri: string }>();
  /** SOFTWARE_TOKEN_MFA sessions: valid for three minutes (the app client's AuthSessionValidity), three wrong codes, one right one. */
  const mfaSessions = new Map<string, { username: string; expiresAt: number; wrong: number }>();
  const calls: string[] = [];
  let seq = 0;
  const state = { unavailable: false, refreshUnavailable: false };

  const err = (code: string, message = code) => new CognitoError(code, message);
  const native = (email: string) => [...users.values()].find((u) => u.method === "password" && u.email === email.toLowerCase());
  const byToken = (at: string) => {
    const u = users.get(accessTokens.get(at) ?? "");
    if (!u || !u.enabled) throw err("NotAuthorizedException", "Access Token has been revoked");
    return u;
  };
  const newCode = (kind: (typeof sent)[number]["kind"], email: string, key: string) => {
    const code = String(100000 + ((++seq * 7919) % 900000));
    codes.set(key, code);
    sent.push({ kind, email, code });
    return code;
  };
  const idToken = (u: FakeUser, nonce?: string) =>
    `fake.${Buffer.from(
      JSON.stringify({ sub: u.sub, username: u.username, email: u.email, emailVerified: u.emailVerified, name: u.name, picture: u.picture ?? null, method: u.method, authTime: Math.floor(Date.now() / 1000), nonce }),
    ).toString("base64url")}`;
  const issue = (u: FakeUser, nonce?: string): CognitoTokens => {
    const n = ++seq;
    const rt = `rt-${n}-${u.username}`;
    const at = `at-${n}-${u.username}`;
    refreshTokens.set(rt, u.username);
    accessTokens.set(at, u.username);
    return { idToken: idToken(u, nonce), accessToken: at, refreshToken: rt, expiresIn: 3600 };
  };
  const endTokens = (username: string) => {
    for (const [t, un] of refreshTokens) if (un === username) refreshTokens.delete(t);
    for (const [t, un] of accessTokens) if (un === username) accessTokens.delete(t);
  };
  const policy = (password: string) => {
    if (password.length < 8 || password.trim() !== password) throw err("InvalidPasswordException", "Password did not conform with policy: Password not long enough");
  };
  const asUser = (u: FakeUser): CognitoUser => ({ username: u.username, sub: u.sub, email: u.email, emailVerified: u.emailVerified, enabled: u.enabled, status: u.status, mfaEnabled: !!u.totp?.enabled });
  /** A password sign-in that got past the password: tokens, or the code step when two-step verification is on. */
  const signedIn = (u: FakeUser) => {
    if (!u.totp?.enabled) return { tokens: issue(u) };
    const session = `mfa-session-${++seq}-${randomBytes(12).toString("hex")}`;
    mfaSessions.set(session, { username: u.username, expiresAt: Date.now() + 180_000, wrong: 0 });
    // Cognito names the user by its real name (ChallengeParameters.USER_ID_FOR_SRP), not the email.
    return { challenge: "SOFTWARE_TOKEN_MFA", session, username: u.username };
  };
  const up = <T>(fn: () => T): Promise<Awaited<T>> => {
    if (state.unavailable) return Promise.reject(new CognitoUnavailableError("Cognito is down (test)"));
    return Promise.resolve().then(fn) as Promise<Awaited<T>>;
  };
  const track = <A extends unknown[], R>(name: string, fn: (...a: A) => R) => (...a: A) => {
    calls.push(name);
    return fn(...a);
  };

  const auth: CognitoAuth = {
    signUp: track("signUp", ({ email, password, name }) =>
      up(() => {
        if (native(email)) throw err("UsernameExistsException", "An account with the given email already exists.");
        policy(password);
        const sub = randomUUID();
        users.set(sub, { sub, username: sub, email: email.toLowerCase(), emailVerified: false, name, password, status: "UNCONFIRMED", enabled: true, method: "password" });
        newCode("signup", email, `signup:${email}`);
        return { sub, confirmed: false };
      }),
    ),
    confirmSignUp: track("confirmSignUp", (email, code) =>
      up(() => {
        const u = native(email);
        if (!u) throw err("UserNotFoundException");
        if (u.status === "CONFIRMED") throw err("NotAuthorizedException", "User cannot be confirmed. Current status is CONFIRMED");
        if (codes.get(`signup:${email}`) !== code) throw err("CodeMismatchException");
        codes.delete(`signup:${email}`);
        u.status = "CONFIRMED";
        u.emailVerified = true;
      }),
    ),
    resendSignUpCode: track("resendSignUpCode", (email) =>
      up(() => {
        const u = native(email);
        if (!u) throw err("UserNotFoundException");
        if (u.status === "CONFIRMED") throw err("InvalidParameterException", "User is already confirmed.");
        newCode("signup", email, `signup:${email}`);
      }),
    ),
    passwordSignIn: track("passwordSignIn", (email, password) =>
      up(() => {
        const u = native(email);
        if (!u || !u.enabled || u.password === null || u.password !== password) throw err("NotAuthorizedException", "Incorrect username or password.");
        if (u.status === "UNCONFIRMED") throw err("UserNotConfirmedException");
        return signedIn(u);
      }),
    ),
    startEmailOtp: track("startEmailOtp", (email) =>
      up(() => {
        const u = native(email);
        if (!u || !u.emailVerified) throw err("NotAuthorizedException");
        newCode("otp", email, `otp:${email}`);
        return { session: `otp-session-${u.sub}` };
      }),
    ),
    answerEmailOtp: track("answerEmailOtp", (email, session, code) =>
      up(() => {
        const u = native(email);
        if (!u || session !== `otp-session-${u.sub}`) throw err("NotAuthorizedException", "Invalid session");
        if (codes.get(`otp:${email}`) !== code) throw err("CodeMismatchException");
        codes.delete(`otp:${email}`);
        return { tokens: issue(u) };
      }),
    ),
    refresh: track("refresh", (refreshToken, username) =>
      up(() => {
        if (state.refreshUnavailable) throw new CognitoUnavailableError("Cognito refresh is down (test)");
        const owner = refreshTokens.get(refreshToken);
        const u = users.get(owner ?? "");
        // The hash is keyed by the Cognito user name (a native user's is its sub; a Google user's is
        // google_<id>): anything else fails the SECRET_HASH check, which Cognito reports the same way.
        if (!owner || !u || u.username !== username || !u.enabled) throw err("NotAuthorizedException", "Invalid Refresh Token");
        const t = issue(u);
        refreshTokens.delete(t.refreshToken!);
        return { ...t, refreshToken: undefined };
      }),
    ),
    verifyIdToken: track("verifyIdToken", (token, opts = {}) =>
      up((): IdentityClaims => {
        if (!token.startsWith("fake.")) throw err("InvalidToken", "not a fake token");
        const c = JSON.parse(Buffer.from(token.slice(5), "base64url").toString()) as IdentityClaims & { nonce?: string };
        if (opts.nonce !== undefined && c.nonce !== opts.nonce) throw err("InvalidToken", "nonce");
        return { sub: c.sub, username: c.username, email: c.email, emailVerified: c.emailVerified, name: c.name, picture: c.picture ?? null, method: c.method, authTime: c.authTime };
      }),
    ),
    forgotPassword: track("forgotPassword", (email) =>
      up(() => {
        const u = native(email);
        if (!u) throw err("UserNotFoundException");
        if (!u.emailVerified) throw err("InvalidParameterException", "Cannot reset password for the user as there is no registered/verified email");
        newCode("reset", email, `reset:${email}`);
      }),
    ),
    confirmForgotPassword: track("confirmForgotPassword", (email, code, password) =>
      up(() => {
        const u = native(email);
        if (!u) throw err("UserNotFoundException");
        if (codes.get(`reset:${email}`) !== code) throw err("CodeMismatchException");
        policy(password);
        codes.delete(`reset:${email}`);
        u.password = password;
        u.status = "CONFIRMED";
      }),
    ),
    changePassword: track("changePassword", (accessToken, previous, proposed) =>
      up(() => {
        const u = byToken(accessToken);
        if (u.password !== previous) throw err("NotAuthorizedException", "Incorrect username or password.");
        policy(proposed);
        u.password = proposed;
      }),
    ),
    updateEmail: track("updateEmail", (accessToken, email) =>
      up(() => {
        const u = byToken(accessToken);
        if (native(email)) throw err("AliasExistsException");
        u.pendingEmail = email.toLowerCase();
        newCode("verify", email, `verify:${u.sub}`);
      }),
    ),
    sendEmailVerificationCode: track("sendEmailVerificationCode", (accessToken) =>
      up(() => {
        const u = byToken(accessToken);
        newCode("verify", u.email, `verify:${u.sub}`);
      }),
    ),
    verifyEmail: track("verifyEmail", (accessToken, code) =>
      up(() => {
        const u = byToken(accessToken);
        if (codes.get(`verify:${u.sub}`) !== code) throw err("CodeMismatchException");
        codes.delete(`verify:${u.sub}`);
        if (u.pendingEmail) {
          u.email = u.pendingEmail;
          u.pendingEmail = undefined;
        }
        u.emailVerified = true;
      }),
    ),
    globalSignOut: track("globalSignOut", (accessToken) =>
      up(() => {
        endTokens(byToken(accessToken).username);
      }),
    ),
    revokeRefreshToken: track("revokeRefreshToken", (refreshToken) =>
      up(() => {
        refreshTokens.delete(refreshToken);
      }),
    ),
    associateTotp: track("associateTotp", (accessToken) =>
      up(() => {
        const u = byToken(accessToken);
        const secret = [...randomBytes(32)].map((b) => B32[b % 32]).join("");
        u.totpPending = secret;
        return { secret };
      }),
    ),
    verifyTotp: track("verifyTotp", (accessToken, code) =>
      up(() => {
        const u = byToken(accessToken);
        // Cognito names a wrong code at this step EnableSoftwareTokenMFAException ("Code mismatch").
        if (!u.totpPending || !totpMatches(u.totpPending, code)) throw err("EnableSoftwareTokenMFAException", "Code mismatch");
        // Registering a new app replaces the old one; whether sign-in asks for it stays as it was.
        u.totp = { secret: u.totpPending, enabled: u.totp?.enabled ?? false };
        u.totpPending = undefined;
        return true;
      }),
    ),
    setTotpEnabled: track("setTotpEnabled", (accessToken, enabled) =>
      up(() => {
        const u = byToken(accessToken);
        if (enabled && !u.totp) throw err("InvalidParameterException", "User has not verified software token mfa");
        if (u.totp) u.totp.enabled = enabled;
      }),
    ),
    answerTotpChallenge: track("answerTotpChallenge", (username, session, code) =>
      up(() => {
        const s = mfaSessions.get(session);
        // A challenge's USERNAME can't be an alias (the email): only the name the challenge gave.
        const u = users.get(username);
        if (!s || !u || s.username !== u.username || s.expiresAt < Date.now()) throw err("NotAuthorizedException", "Invalid session for the user, session is expired.");
        if (!u.totp || !totpMatches(u.totp.secret, code)) {
          if (++s.wrong >= 3) mfaSessions.delete(session);
          throw err("CodeMismatchException", "Invalid code received for user");
        }
        mfaSessions.delete(session);
        return { tokens: issue(u) };
      }),
    ),
    authorizeUrl: ({ provider, redirectUri, state: st, codeChallenge, nonce, selectAccount }) =>
      `https://auth.example.test/oauth2/authorize?${new URLSearchParams({ identity_provider: provider, redirect_uri: redirectUri, state: st, code_challenge: codeChallenge, code_challenge_method: "S256", nonce, ...(selectAccount && { prompt: "select_account" }) })}`,
    exchangeCode: track("exchangeCode", ({ code, redirectUri, codeVerifier }) =>
      up(() => {
        const p = oauthCodes.get(code);
        oauthCodes.delete(code);
        const challenge = createHash("sha256").update(codeVerifier).digest("base64url");
        if (!p || p.challenge !== challenge || p.redirectUri !== redirectUri) throw err("invalid_grant");
        return issue(users.get(p.username)!, p.nonce);
      }),
    ),
    logoutUrl: (logoutUri) => `https://auth.example.test/logout?logout_uri=${encodeURIComponent(logoutUri)}`,
    adminGetUser: track("adminGetUser", (username) =>
      up(() => {
        const u = users.get(username) ?? native(username);
        return u ? asUser(u) : null;
      }),
    ),
    adminCreateUser: track("adminCreateUser", ({ email, emailVerified, name, password }) =>
      up(() => {
        if (native(email)) throw err("UsernameExistsException");
        if (password !== undefined) policy(password);
        const sub = randomUUID();
        const u: FakeUser = { sub, username: sub, email: email.toLowerCase(), emailVerified, name: name ?? null, password: password ?? null, status: "CONFIRMED", enabled: true, method: "password" };
        users.set(sub, u);
        return asUser(u);
      }),
    ),
    adminSetPassword: track("adminSetPassword", (username, password) =>
      up(() => {
        const u = users.get(username);
        if (!u) throw err("UserNotFoundException");
        policy(password);
        u.password = password;
        // Permanent: the user is CONFIRMED from now on.
        u.status = "CONFIRMED";
      }),
    ),
    adminDeleteUser: track("adminDeleteUser", (username) =>
      up(() => {
        endTokens(username);
        users.delete(username);
      }),
    ),
    adminGlobalSignOut: track("adminGlobalSignOut", (username) =>
      up(() => {
        endTokens(username);
      }),
    ),
  };

  return {
    ...auth,
    /** Back to an empty pool (between tests, like the database). */
    reset() {
      users.clear();
      sent.length = 0;
      codes.clear();
      refreshTokens.clear();
      accessTokens.clear();
      oauthCodes.clear();
      mfaSessions.clear();
      calls.length = 0;
      state.unavailable = false;
      state.refreshUnavailable = false;
    },
    users,
    sent,
    calls,
    state,
    /** The newest code of a kind sent to an address. */
    code(kind: (typeof sent)[number]["kind"], email: string) {
      const c = [...sent].reverse().find((s) => s.kind === kind && s.email === email);
      if (!c) throw new Error(`no ${kind} code sent to ${email}`);
      return c.code;
    },
    /** A confirmed password user (what a finished sign-up, or a migrated account, is); the existing one for that sub or email. */
    addUser(input: { email: string; password?: string; sub?: string; emailVerified?: boolean; name?: string | null; enabled?: boolean }) {
      const existing = (input.sub ? users.get(input.sub) : undefined) ?? native(input.email);
      if (existing) return existing;
      const sub = input.sub ?? randomUUID();
      const u: FakeUser = {
        sub,
        username: sub,
        email: input.email.toLowerCase(),
        emailVerified: input.emailVerified ?? true,
        name: input.name ?? null,
        password: input.password ?? `pw-${sub}-secret`,
        status: "CONFIRMED",
        enabled: input.enabled ?? true,
        method: "password",
      };
      users.set(sub, u);
      return u;
    },
    /** Two-step verification already set up for a user (as if done in Settings): the secret, for totpCode(). */
    enableTotp(username: string) {
      const u = users.get(username);
      if (!u) throw new Error(`no user ${username}`);
      const secret = [...randomBytes(32)].map((b) => B32[b % 32]).join("");
      u.totp = { secret, enabled: true };
      return secret;
    },
    /**
     * The person finishes at Google (the URL our start route redirected to): their federated
     * Cognito user exists from now on, and the code Cognito would send back is returned.
     */
    federatedSignIn(authorizeUrl: string, person: { id: string; email: string | null; emailVerified?: boolean; name?: string; picture?: string }) {
      const q = new URL(authorizeUrl).searchParams;
      const provider = q.get("identity_provider") as FederatedProvider;
      if (provider !== "Google") throw new Error(`unexpected identity provider ${provider}`);
      const username = `google_${person.id}`;
      if (!users.has(username)) {
        users.set(username, {
          sub: randomUUID(),
          username,
          email: person.email ?? "",
          emailVerified: person.emailVerified ?? true,
          name: person.name ?? null,
          picture: person.picture ?? null,
          password: null,
          status: "CONFIRMED",
          enabled: true,
          method: "google",
        });
      }
      const code = `code-${++seq}`;
      oauthCodes.set(code, { username, challenge: q.get("code_challenge")!, nonce: q.get("nonce")!, redirectUri: q.get("redirect_uri")! });
      return { code, state: q.get("state")!, username };
    },
  };
}

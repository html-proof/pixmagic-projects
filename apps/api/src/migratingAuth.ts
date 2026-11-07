import { decodeJwt } from "jose";
import { keyring, logger, type Coord, type Mailer } from "@app/core";
import { decrypt, encrypt, sha256Hex } from "@app/shared";
import type { AuthAccountRow } from "./authStore.js";
import { CognitoError, type CognitoAuth, type CognitoTokens, type CognitoUser, type IdentityClaims, type SignInResult } from "./cognito.js";
import type { LocalAuth } from "./localAuth.js";
import { hashPassword } from "./passwords.js";

/**
 * AUTH_MODE "migrating": the app's own sign-in (localAuth.ts) in front, Amazon Cognito behind it,
 * so Cognito's users move over one sign-in at a time and nobody has to do anything (as the move
 * from Firebase to Cognito did, docs/cognito-setup.md). Cognito never hands over a password; the
 * one typed at a sign-in it accepts is hashed here and kept, under the same sub, so auth_identities
 * and every session keep matching.
 *
 * - Password sign-in: an account here with a password decides alone. Otherwise Cognito checks it
 *   once; if it agrees, the account is made here with that password, Cognito's refresh token is
 *   handed back, and the session runs on our tokens from then on. Someone with an authenticator app
 *   at Cognito answers its code there first; Cognito never gives out that secret, so they come over
 *   with two-step verification off and are emailed to set it up again (the emailed sign-in code,
 *   AUTH_LOGIN_EMAIL_CODE, still stands after the password meanwhile).
 * - Sign-up, emailed codes, Google: here only (Google straight from Google, on the app's own
 *   client, once GOOGLE_SIGNIN_CLIENT_ID/SECRET are set; through Cognito until then).
 * - "Forgot password?": here, which moves the person too; Cognito is asked who they are when the
 *   app has never seen them sign in.
 * - Anything done with a session that still runs on Cognito's tokens (from before the switch) goes
 *   to Cognito, until that session's next sign-in brings it over.
 * - Deleting a user or signing them out everywhere: both.
 */
export interface MigratingAuthDeps {
  local: LocalAuth;
  cognito: CognitoAuth;
  coord: Coord;
  mailer: Mailer;
  /** Google straight from Google (the app's own client) rather than through Cognito. */
  localGoogle: boolean;
}

const lower = (s: string) => s.trim().toLowerCase();
const COGNITO_SESSION = "cog.";
const notFound = (e: unknown) => e instanceof CognitoError && e.code === "UserNotFoundException";

export function migratingAuth(deps: MigratingAuthDeps): CognitoAuth {
  const { local, cognito, coord, mailer } = deps;
  const store = local.store;
  const pwKey = (session: string) => `mig:pw:${sha256Hex(session).slice(0, 48)}`;

  /** The account here for a Cognito user, made from what Cognito says (or brought up to date). */
  async function moveIn(claims: Pick<IdentityClaims, "sub" | "username" | "email" | "emailVerified" | "name">, passwordHash: string | null): Promise<AuthAccountRow> {
    const existing = await store.bySub(claims.sub);
    const email = lower(claims.email ?? existing?.email ?? "");
    if (existing) {
      return (await store.update(existing.sub, { ...(passwordHash && { passwordHash }), confirmed: true, ...(email && { email, loginEmail: email, emailVerified: claims.emailVerified || existing.emailVerified }) })) ?? existing;
    }
    return store.create({
      sub: claims.sub,
      username: claims.username,
      loginEmail: email || null,
      email,
      emailVerified: claims.emailVerified,
      pendingEmail: null,
      name: claims.name ?? null,
      picture: null,
      method: "password",
      passwordHash,
      googleSub: null,
      confirmed: true,
      enabled: true,
      totpSecret: null,
      totpPending: null,
      totpEnabled: false,
      movedFrom: "cognito",
      movedAt: new Date(),
    });
  }

  /** Cognito accepted the password: the account comes over with it, and the session runs on our tokens. */
  async function moveWithPassword(tokens: CognitoTokens, password: string, hadTotp: boolean): Promise<CognitoTokens> {
    const claims = await cognito.verifyIdToken(tokens.idToken);
    const account = await moveIn(claims, await hashPassword(password));
    if (tokens.refreshToken) await cognito.revokeRefreshToken(tokens.refreshToken).catch((e: unknown) => logger.warn({ err: e }, "migrating auth: could not hand back Cognito's refresh token"));
    logger.info({ moved: true, totp: hadTotp }, "sign-in moved from Cognito");
    if (hadTotp && account.email) {
      await mailer
        .send(
          account.email,
          "Set up two-step verification again",
          "bizinsights has moved its sign-in to its own servers. Your password works as before, but your authenticator app has to be set up again: Settings, Security, Two-step verification.",
          undefined,
          { purpose: "notice" },
        )
        .catch((e: unknown) => logger.warn({ err: e }, "migrating auth: could not email the two-step notice"));
    }
    return local.issue(account.sub, {});
  }

  /** A Cognito user the app has never seen sign in, by address: an account here with no password yet. */
  async function shellFromCognito(email: string): Promise<boolean> {
    const u = await cognito.adminGetUser(lower(email));
    if (!u || u.status === "EXTERNAL_PROVIDER" || u.username.startsWith("google_")) return false;
    await moveIn({ sub: u.sub, username: u.username, email: u.email ?? email, emailVerified: u.emailVerified, name: null }, null);
    return true;
  }

  const cognitoToken = (t: string) => !local.isLocalToken(t);
  /** Who a Cognito access token is for (Cognito has just accepted it, so its claims can be read as they are). */
  const cognitoUsername = (accessToken: string) => {
    try {
      const p = decodeJwt(accessToken);
      return { sub: String(p.sub ?? ""), username: String(p.username ?? p["cognito:username"] ?? p.sub ?? "") };
    } catch {
      return { sub: "", username: "" };
    }
  };
  const both = async (fn: (a: CognitoAuth) => Promise<void>) => {
    const results = await Promise.allSettled([fn(local), fn(cognito)]);
    const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected" && !notFound(r.reason));
    if (failed) throw failed.reason;
  };

  return {
    signUp: (input) => local.signUp(input),
    confirmSignUp: (email, code) => local.confirmSignUp(email, code).catch((e: unknown) => (notFound(e) ? cognito.confirmSignUp(email, code) : Promise.reject(e))),
    resendSignUpCode: (email) => local.resendSignUpCode(email).catch((e: unknown) => (notFound(e) ? cognito.resendSignUpCode(email) : Promise.reject(e))),

    async passwordSignIn(email, password): Promise<SignInResult> {
      const here = await store.byLoginEmail(lower(email));
      if (here?.passwordHash) return local.passwordSignIn(email, password);
      const r = await cognito.passwordSignIn(email, password);
      if ("tokens" in r) return { tokens: await moveWithPassword(r.tokens, password, false) };
      if (r.challenge === "SOFTWARE_TOKEN_MFA") {
        // Held for the code's answer (three minutes, as Cognito's session), never in the clear.
        await coord.put(pwKey(r.session), encrypt(password, keyring(), "migrating-password-v1"), 180);
        return { ...r, session: COGNITO_SESSION + r.session };
      }
      return r;
    },
    async answerTotpChallenge(username, session, code) {
      if (!session.startsWith(COGNITO_SESSION)) return local.answerTotpChallenge(username, session, code);
      const real = session.slice(COGNITO_SESSION.length);
      const r = await cognito.answerTotpChallenge(username, real, code);
      if (!("tokens" in r)) return r;
      const held = await coord.take(pwKey(real));
      if (!held) return r;
      return { tokens: await moveWithPassword(r.tokens, decrypt(held, keyring(), "migrating-password-v1"), true) };
    },
    startEmailOtp: (email) => local.startEmailOtp(email),
    answerEmailOtp: (email, session, code) => local.answerEmailOtp(email, session, code),
    refresh: (refreshToken, username) => (local.isLocalRefreshToken(refreshToken) ? local.refresh(refreshToken, username) : cognito.refresh(refreshToken, username)),
    verifyIdToken: (idToken, opts) => (local.isLocalToken(idToken) ? local.verifyIdToken(idToken, opts) : cognito.verifyIdToken(idToken, opts)),

    async forgotPassword(email) {
      try {
        await local.forgotPassword(email);
      } catch (e) {
        if (!notFound(e) || !(await shellFromCognito(email))) throw e;
        await local.forgotPassword(email);
      }
    },
    async confirmForgotPassword(email, code, password) {
      try {
        await local.confirmForgotPassword(email, code, password);
      } catch (e) {
        // A reset Cognito sent before the switch.
        if (notFound(e)) return cognito.confirmForgotPassword(email, code, password);
        throw e;
      }
    },
    async changePassword(accessToken, previous, proposed) {
      if (!cognitoToken(accessToken)) return local.changePassword(accessToken, previous, proposed);
      await cognito.changePassword(accessToken, previous, proposed);
      // Cognito agreed to the old one and took the new one: the new one comes here too.
      const { sub } = cognitoUsername(accessToken);
      if (sub && (await store.bySub(sub))) await store.update(sub, { passwordHash: await hashPassword(proposed) });
    },

    updateEmail: (t, email) => (cognitoToken(t) ? cognito.updateEmail(t, email) : local.updateEmail(t, email)),
    sendEmailVerificationCode: (t) => (cognitoToken(t) ? cognito.sendEmailVerificationCode(t) : local.sendEmailVerificationCode(t)),
    verifyEmail: (t, code) => (cognitoToken(t) ? cognito.verifyEmail(t, code) : local.verifyEmail(t, code)),
    globalSignOut: async (t) => {
      if (!cognitoToken(t)) return local.globalSignOut(t);
      await cognito.globalSignOut(t);
      const { username } = cognitoUsername(t);
      if (username) await local.adminGlobalSignOut(username).catch(() => undefined);
    },
    revokeRefreshToken: (rt) => (local.isLocalRefreshToken(rt) ? local.revokeRefreshToken(rt) : cognito.revokeRefreshToken(rt)),

    associateTotp: (t) => (cognitoToken(t) ? cognito.associateTotp(t) : local.associateTotp(t)),
    verifyTotp: (t, code) => (cognitoToken(t) ? cognito.verifyTotp(t, code) : local.verifyTotp(t, code)),
    setTotpEnabled: (t, enabled) => (cognitoToken(t) ? cognito.setTotpEnabled(t, enabled) : local.setTotpEnabled(t, enabled)),

    authorizeUrl: (input) => (deps.localGoogle ? local.authorizeUrl(input) : cognito.authorizeUrl(input)),
    exchangeCode: (input) => (deps.localGoogle ? local.exchangeCode(input) : cognito.exchangeCode(input)),
    logoutUrl: (uri) => (deps.localGoogle ? null : cognito.logoutUrl(uri)),

    async adminGetUser(username): Promise<CognitoUser | null> {
      // Here only when the account really is here (findCognitoUsers off): otherwise Cognito says,
      // with its two-step setting as it really is.
      return (await local.adminGetUser(username)) ?? cognito.adminGetUser(username);
    },
    async adminCreateUser(input) {
      if (await cognito.adminGetUser(lower(input.email)).catch(() => null)) throw new CognitoError("UsernameExistsException", "An account with the given email already exists.");
      return local.adminCreateUser(input);
    },
    async adminSetPassword(username, password) {
      if (!(await local.adminGetUser(username))) {
        const u = await cognito.adminGetUser(username);
        if (!u) throw new CognitoError("UserNotFoundException", "User does not exist.");
        await moveIn({ sub: u.sub, username: u.username, email: u.email, emailVerified: u.emailVerified, name: null }, null);
      }
      return local.adminSetPassword(username, password);
    },
    adminDeleteUser: (username) => both((a) => a.adminDeleteUser(username)),
    adminGlobalSignOut: (username) => both((a) => a.adminGlobalSignOut(username)),
  };
}

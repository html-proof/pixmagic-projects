import { createHmac, randomBytes } from "node:crypto";
import { AwsClient } from "aws4fetch";
import { createRemoteJWKSet, customFetch, jwtVerify, type JWTPayload } from "jose";
import { env, type FetchLike } from "@app/core";

/**
 * Amazon Cognito user pools, spoken to directly over HTTPS from the API.
 *
 * The browser never talks to Cognito and never holds a Cognito token: every call is made here
 * (backend-for-frontend), the tokens Cognito issues are checked here, and the browser gets our
 * own httpOnly session cookie (session.ts). The AWS SDK is not used: it costs more CPU to load
 * than a Free-plan request may spend, and Cognito's user-pool API is a plain JSON POST.
 * Calls that act as the user pool's administrator (AdminCreateUser and friends) are signed with
 * SigV4 by an IAM user that may do only those few things (infra/aws/cognito.yaml).
 */

/** Cognito answered and refused: wrong password, bad or expired code, unknown user, ... */
export class CognitoError extends Error {
  constructor(
    /** Cognito's exception name without its namespace, e.g. "NotAuthorizedException". */
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "CognitoError";
  }
}

/**
 * Cognito could not be reached or failed on its side. Nothing is wrong with what the person
 * typed, so this must never reach them as a rejected sign-in (or sign them out): say "try again".
 */
export class CognitoUnavailableError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "CognitoUnavailableError";
  }
}

export type SignInMethod = "password" | "google";
/** Cognito's names for the identity providers ("Continue with ..."). */
export type FederatedProvider = "Google";

export interface CognitoTokens {
  idToken: string;
  accessToken: string;
  /** Absent on a refresh unless refresh-token rotation is on. */
  refreshToken?: string;
  expiresIn: number;
}

/**
 * `username` on a challenge: the Cognito user name it names (ChallengeParameters.USER_ID_FOR_SRP,
 * the user's real name, never the email signed in with), which the answer must give as USERNAME
 * and hash into SECRET_HASH.
 */
export type SignInResult = { tokens: CognitoTokens } | { challenge: string; session: string; username?: string };

/** What a verified Cognito ID token says about the person. */
export interface IdentityClaims {
  sub: string;
  /** The Cognito user name: the sub for password users, "google_<id>" for Google ones. */
  username: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  method: SignInMethod;
  /** When the person last proved who they are (seconds). */
  authTime: number;
}

export interface CognitoUser {
  username: string;
  sub: string;
  email: string | null;
  emailVerified: boolean;
  enabled: boolean;
  /** CONFIRMED, UNCONFIRMED, FORCE_CHANGE_PASSWORD, RESET_REQUIRED, EXTERNAL_PROVIDER, ... */
  status: string;
  /** Two-step verification with an authenticator app (TOTP) is on: every sign-in asks for a code. */
  mfaEnabled: boolean;
}

export interface CognitoConfig {
  region: string;
  userPoolId: string;
  clientId: string;
  /** The app client is confidential: its secret signs every user-pool call (SECRET_HASH). */
  clientSecret: string;
  /** The user-pool API. */
  endpoint: string;
  issuer: string;
  jwksUrl: string;
  /** The user pool's OAuth domain (https://...), for Google. Empty: no social sign-in. */
  domain: string;
  /** Credentials for the admin calls: an IAM user's keys, or (on AWS) the function role's temporary ones. */
  admin: { accessKeyId: string; secretAccessKey: string; sessionToken?: string } | null;
  /** Refresh-token rotation is on for the app client (GetTokensFromRefreshToken). */
  refreshRotation: boolean;
}

/** The Cognito settings, or null while they are not configured (sign-in then answers 503). */
export function cognitoConfig(): CognitoConfig | null {
  const e = env();
  if (!e.COGNITO_USER_POOL_ID || !e.COGNITO_CLIENT_ID) return null;
  const region = e.COGNITO_REGION || e.COGNITO_USER_POOL_ID.split("_")[0]!;
  const local = e.COGNITO_ENDPOINT.replace(/\/+$/, "");
  const endpoint = local ? `${local}/` : `https://cognito-idp.${region}.amazonaws.com/`;
  // A local emulator (cognito-local) issues tokens under its own address.
  const issuer = local ? `${local}/${e.COGNITO_USER_POOL_ID}` : `https://cognito-idp.${region}.amazonaws.com/${e.COGNITO_USER_POOL_ID}`;
  return {
    region,
    userPoolId: e.COGNITO_USER_POOL_ID,
    clientId: e.COGNITO_CLIENT_ID,
    clientSecret: e.COGNITO_CLIENT_SECRET,
    endpoint,
    issuer,
    jwksUrl: `${issuer}/.well-known/jwks.json`,
    domain: e.COGNITO_DOMAIN.replace(/\/+$/, ""),
    admin:
      e.COGNITO_ADMIN_ACCESS_KEY_ID && e.COGNITO_ADMIN_SECRET_ACCESS_KEY
        ? { accessKeyId: e.COGNITO_ADMIN_ACCESS_KEY_ID, secretAccessKey: e.COGNITO_ADMIN_SECRET_ACCESS_KEY, sessionToken: e.COGNITO_ADMIN_SESSION_TOKEN || undefined }
        : null,
    refreshRotation: e.COGNITO_REFRESH_ROTATION === "1",
  };
}

/** Everything the API needs from Cognito, narrow enough for tests to fake. */
export interface CognitoAuth {
  // ---- Sign-up and sign-in ----
  signUp(input: { email: string; password: string; name: string }): Promise<{ sub: string; confirmed: boolean }>;
  confirmSignUp(email: string, code: string): Promise<void>;
  resendSignUpCode(email: string): Promise<void>;
  passwordSignIn(email: string, password: string): Promise<SignInResult>;
  /** Passwordless sign-in with a code Cognito emails (needs the Essentials plan and SES). */
  startEmailOtp(email: string): Promise<{ session: string }>;
  answerEmailOtp(email: string, session: string, code: string): Promise<SignInResult>;
  /** New ID and access tokens (and a new refresh token when rotation is on). `username` is the Cognito user name. */
  refresh(refreshToken: string, username: string): Promise<CognitoTokens>;
  verifyIdToken(idToken: string, opts?: { nonce?: string }): Promise<IdentityClaims>;

  // ---- Passwords ----
  forgotPassword(email: string): Promise<void>;
  confirmForgotPassword(email: string, code: string, password: string): Promise<void>;
  changePassword(accessToken: string, previous: string, proposed: string): Promise<void>;

  // ---- The signed-in person's own account (access token) ----
  /** Starts an email change: Cognito sends a code to the new address and keeps the old one until it is confirmed. */
  updateEmail(accessToken: string, email: string): Promise<void>;
  sendEmailVerificationCode(accessToken: string): Promise<void>;
  verifyEmail(accessToken: string, code: string): Promise<void>;
  /** Ends every refresh token of this Cognito user, on every device. */
  globalSignOut(accessToken: string): Promise<void>;
  revokeRefreshToken(refreshToken: string): Promise<void>;

  // ---- Two-step verification: a code from an authenticator app (TOTP) ----
  /** Starts setting it up for the signed-in person: the secret (base32) their app needs. */
  associateTotp(accessToken: string): Promise<{ secret: string }>;
  /** A code from the app for that secret. true: Cognito has registered the app (it isn't asked for at sign-in until enabled). */
  verifyTotp(accessToken: string, code: string): Promise<boolean>;
  /** Whether sign-in asks for a code (and prefers it to any other second step). */
  setTotpEnabled(accessToken: string, enabled: boolean): Promise<void>;
  /**
   * The code that answers passwordSignIn's SOFTWARE_TOKEN_MFA challenge (its `session`). `username`:
   * the challenge's `username` (Cognito's own name for the user; the email only if it gave none).
   */
  answerTotpChallenge(username: string, session: string, code: string): Promise<SignInResult>;

  // ---- Managed login (OAuth 2.0 authorization code + PKCE): Google ----
  authorizeUrl(input: { provider: FederatedProvider; redirectUri: string; state: string; codeChallenge: string; nonce: string }): string;
  exchangeCode(input: { code: string; redirectUri: string; codeVerifier: string }): Promise<CognitoTokens>;
  /** Ends the user pool's own browser session (after Google), then returns to `logoutUri`. */
  logoutUrl(logoutUri: string): string | null;

  // ---- Administrator (IAM-signed) ----
  adminGetUser(username: string): Promise<CognitoUser | null>;
  /** A confirmed password user, created without any email to them. A random password when none is given. */
  adminCreateUser(input: { email: string; emailVerified: boolean; name?: string | null; password?: string }): Promise<CognitoUser>;
  adminSetPassword(username: string, password: string): Promise<void>;
  adminDeleteUser(username: string): Promise<void>;
  adminGlobalSignOut(username: string): Promise<void>;
}

const AMZ_JSON = "application/x-amz-json-1.1";

/** A password no one knows, that any password policy accepts. */
export const unguessablePassword = () => `${randomBytes(24).toString("base64url")}aA1!`;

const b64 = (s: string) => Buffer.from(s).toString("base64");

function attr(attrs: Array<{ Name: string; Value: string }> | undefined, name: string): string | null {
  return attrs?.find((a) => a.Name === name)?.Value ?? null;
}

/** Cognito writes some booleans as strings, notably email_verified for federated users. */
const truthy = (v: unknown) => v === true || v === "true";

function methodOf(claims: JWTPayload & { identities?: unknown }): SignInMethod {
  const ids = Array.isArray(claims.identities) ? (claims.identities as Array<{ providerName?: string; providerType?: string }>) : [];
  const p = ids[0]?.providerType ?? ids[0]?.providerName;
  if (p === "Google") return "google";
  return "password";
}

export function cognitoAuth(cfg: CognitoConfig, fetchImpl: FetchLike = fetch): CognitoAuth {
  let signer: AwsClient | undefined;
  // The pool's signing keys, kept by jose (honouring Cache-Control) for the life of the isolate,
  // and fetched through the same time-limited fetch as every other call.
  const jwks = createRemoteJWKSet(new URL(cfg.jwksUrl), { [customFetch]: fetchImpl });
  const secretHash = (username: string) => createHmac("sha256", cfg.clientSecret).update(username + cfg.clientId).digest("base64");
  // A public app client (no secret) is allowed for local emulators; production's is confidential.
  const withSecret = (username: string) => (cfg.clientSecret ? { SECRET_HASH: secretHash(username) } : {});
  const secretHashParam = (username: string) => (cfg.clientSecret ? { SecretHash: secretHash(username) } : {});

  async function call<T>(op: string, payload: Record<string, unknown>, admin = false): Promise<T> {
    const init = {
      method: "POST",
      headers: { "content-type": AMZ_JSON, "x-amz-target": `AWSCognitoIdentityProviderService.${op}` },
      body: JSON.stringify(payload),
    };
    let res: Response;
    try {
      if (admin) {
        if (!cfg.admin) throw new Error(`Cognito admin credentials (COGNITO_ADMIN_ACCESS_KEY_ID / COGNITO_ADMIN_SECRET_ACCESS_KEY) are not set; ${op} needs them`);
        signer ??= new AwsClient({ ...cfg.admin, service: "cognito-idp", region: cfg.region });
        const signed = await signer.sign(cfg.endpoint, init);
        res = await fetchImpl(signed.url, { method: "POST", headers: signed.headers, body: init.body });
      } else {
        res = await fetchImpl(cfg.endpoint, init);
      }
    } catch (err) {
      if ((err as Error).message?.includes("admin credentials")) throw err;
      throw new CognitoUnavailableError(`Cognito ${op} unreachable: ${(err as Error).message}`, err);
    }
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      /* not JSON: classified by status below */
    }
    if (res.ok) return json as T;
    // "__type" is "NotAuthorizedException" or "com.amazonaws...#NotAuthorizedException".
    const type = String(json.__type ?? res.headers.get("x-amzn-errortype") ?? "")
      .split("#")
      .pop()!
      .split(":")[0]!;
    const message = String(json.message ?? json.Message ?? `HTTP ${res.status}`);
    if (res.status >= 500 || type === "InternalErrorException") throw new CognitoUnavailableError(`Cognito ${op} failed (${res.status} ${type}): ${message}`);
    throw new CognitoError(type || `Http${res.status}`, message);
  }

  type AuthResult = {
    AuthenticationResult?: { IdToken: string; AccessToken: string; RefreshToken?: string; ExpiresIn: number };
    ChallengeName?: string;
    /** USER_ID_FOR_SRP (and sometimes USERNAME): the user's real Cognito name, for the answer. */
    ChallengeParameters?: Record<string, string>;
    Session?: string;
  };
  const tokensOf = (r: NonNullable<AuthResult["AuthenticationResult"]>): CognitoTokens => ({
    idToken: r.IdToken,
    accessToken: r.AccessToken,
    refreshToken: r.RefreshToken,
    expiresIn: r.ExpiresIn,
  });
  const signInResult = (r: AuthResult): SignInResult => {
    if (r.AuthenticationResult) return { tokens: tokensOf(r.AuthenticationResult) };
    if (r.ChallengeName) {
      const username = r.ChallengeParameters?.USER_ID_FOR_SRP || r.ChallengeParameters?.USERNAME;
      return { challenge: r.ChallengeName, session: r.Session ?? "", ...(username && { username }) };
    }
    throw new CognitoUnavailableError("Cognito answered a sign-in with neither tokens nor a challenge");
  };

  type AdminUser = {
    Username: string;
    UserAttributes?: Array<{ Name: string; Value: string }>;
    Attributes?: Array<{ Name: string; Value: string }>;
    Enabled?: boolean;
    UserStatus?: string;
    /** The second steps switched on for the user (AdminGetUser only): SMS_MFA, EMAIL_OTP, SOFTWARE_TOKEN_MFA. */
    UserMFASettingList?: string[];
  };
  const userOf = (u: AdminUser): CognitoUser => {
    const attrs = u.UserAttributes ?? u.Attributes;
    return {
      username: u.Username,
      sub: attr(attrs, "sub") ?? u.Username,
      email: attr(attrs, "email"),
      emailVerified: truthy(attr(attrs, "email_verified")),
      enabled: u.Enabled !== false,
      status: u.UserStatus ?? "UNKNOWN",
      mfaEnabled: u.UserMFASettingList?.includes("SOFTWARE_TOKEN_MFA") ?? false,
    };
  };

  async function oauthToken(params: Record<string, string>): Promise<CognitoTokens> {
    if (!cfg.domain) throw new CognitoError("NotConfigured", "COGNITO_DOMAIN is not set");
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
    if (cfg.clientSecret) headers.authorization = `Basic ${b64(`${cfg.clientId}:${cfg.clientSecret}`)}`;
    let res: Response;
    try {
      res = await fetchImpl(`${cfg.domain}/oauth2/token`, { method: "POST", headers, body: new URLSearchParams({ client_id: cfg.clientId, ...params }) });
    } catch (err) {
      throw new CognitoUnavailableError(`Cognito token endpoint unreachable: ${(err as Error).message}`, err);
    }
    const json = (await res.json().catch(() => ({}))) as { id_token?: string; access_token?: string; refresh_token?: string; expires_in?: number; error?: string };
    if (res.status >= 500) throw new CognitoUnavailableError(`Cognito token endpoint failed (${res.status})`);
    if (!res.ok || !json.id_token || !json.access_token) throw new CognitoError(json.error ?? `Http${res.status}`, `Token exchange refused: ${json.error ?? res.status}`);
    return { idToken: json.id_token, accessToken: json.access_token, refreshToken: json.refresh_token, expiresIn: json.expires_in ?? 3600 };
  }

  return {
    async signUp({ email, password, name }) {
      const r = await call<{ UserSub: string; UserConfirmed: boolean }>("SignUp", {
        ClientId: cfg.clientId,
        ...secretHashParam(email),
        Username: email,
        Password: password,
        UserAttributes: [
          { Name: "email", Value: email },
          { Name: "name", Value: name },
        ],
      });
      return { sub: r.UserSub, confirmed: r.UserConfirmed };
    },
    async confirmSignUp(email, code) {
      await call("ConfirmSignUp", { ClientId: cfg.clientId, ...secretHashParam(email), Username: email, ConfirmationCode: code });
    },
    async resendSignUpCode(email) {
      await call("ResendConfirmationCode", { ClientId: cfg.clientId, ...secretHashParam(email), Username: email });
    },
    async passwordSignIn(email, password) {
      const r = await call<AuthResult>("InitiateAuth", {
        ClientId: cfg.clientId,
        AuthFlow: "USER_PASSWORD_AUTH",
        AuthParameters: { USERNAME: email, PASSWORD: password, ...withSecret(email) },
      }).catch((err: unknown) => {
        // Cognito answers a wrong password with NotAuthorizedException; the local emulator says
        // InvalidPasswordException, which Cognito keeps for passwords a policy refuses (never here).
        if (err instanceof CognitoError && err.code === "InvalidPasswordException") throw new CognitoError("NotAuthorizedException", "Incorrect username or password.");
        throw err;
      });
      return signInResult(r);
    },
    async startEmailOtp(email) {
      const r = await call<AuthResult>("InitiateAuth", {
        ClientId: cfg.clientId,
        AuthFlow: "USER_AUTH",
        AuthParameters: { USERNAME: email, PREFERRED_CHALLENGE: "EMAIL_OTP", ...withSecret(email) },
      });
      if (r.ChallengeName !== "EMAIL_OTP" || !r.Session) throw new CognitoError("UnexpectedChallenge", `Expected EMAIL_OTP, got ${r.ChallengeName ?? "tokens"}`);
      return { session: r.Session };
    },
    async answerEmailOtp(email, session, code) {
      const r = await call<AuthResult>("RespondToAuthChallenge", {
        ClientId: cfg.clientId,
        ChallengeName: "EMAIL_OTP",
        Session: session,
        ChallengeResponses: { USERNAME: email, EMAIL_OTP_CODE: code, ...withSecret(email) },
      });
      return signInResult(r);
    },
    async refresh(refreshToken, username) {
      if (cfg.refreshRotation) {
        const r = await call<AuthResult>("GetTokensFromRefreshToken", {
          ClientId: cfg.clientId,
          RefreshToken: refreshToken,
          ...(cfg.clientSecret ? { ClientSecret: cfg.clientSecret } : {}),
        });
        if (!r.AuthenticationResult) throw new CognitoUnavailableError("Cognito answered a refresh without tokens");
        return tokensOf(r.AuthenticationResult);
      }
      const r = await call<AuthResult>("InitiateAuth", {
        ClientId: cfg.clientId,
        AuthFlow: "REFRESH_TOKEN_AUTH",
        // SECRET_HASH for a refresh is keyed by the Cognito user name, not the email signed in with.
        AuthParameters: { REFRESH_TOKEN: refreshToken, ...withSecret(username) },
      });
      if (!r.AuthenticationResult) throw new CognitoUnavailableError("Cognito answered a refresh without tokens");
      return tokensOf(r.AuthenticationResult);
    },
    async verifyIdToken(idToken, opts = {}) {
      let payload: JWTPayload & Record<string, unknown>;
      try {
        ({ payload } = await jwtVerify(idToken, jwks, { issuer: cfg.issuer, audience: cfg.clientId, algorithms: ["RS256"] }));
      } catch (err) {
        const code = (err as { code?: string }).code;
        // Cognito's signing keys unreachable is an outage, not a bad token.
        if (code === "ERR_JWKS_TIMEOUT" || code === "ERR_JOSE_GENERIC" || err instanceof TypeError) {
          throw new CognitoUnavailableError(`Could not fetch Cognito's signing keys: ${(err as Error).message}`, err);
        }
        throw new CognitoError("InvalidToken", `ID token rejected: ${(err as Error).message}`);
      }
      if (payload.token_use !== "id") throw new CognitoError("InvalidToken", "Not an ID token");
      if (!payload.sub) throw new CognitoError("InvalidToken", "ID token has no subject");
      if (opts.nonce !== undefined && payload.nonce !== opts.nonce) throw new CognitoError("InvalidToken", "ID token nonce does not match the sign-in");
      const given = [payload.given_name, payload.family_name].filter((v) => typeof v === "string" && v).join(" ");
      return {
        sub: payload.sub,
        username: String(payload["cognito:username"] ?? payload.sub),
        email: typeof payload.email === "string" ? payload.email.toLowerCase() : null,
        emailVerified: truthy(payload.email_verified),
        name: typeof payload.name === "string" && payload.name ? payload.name : given || null,
        method: methodOf(payload),
        authTime: Number(payload.auth_time ?? payload.iat ?? 0),
      };
    },

    async forgotPassword(email) {
      await call("ForgotPassword", { ClientId: cfg.clientId, ...secretHashParam(email), Username: email });
    },
    async confirmForgotPassword(email, code, password) {
      await call("ConfirmForgotPassword", { ClientId: cfg.clientId, ...secretHashParam(email), Username: email, ConfirmationCode: code, Password: password });
    },
    async changePassword(accessToken, previous, proposed) {
      await call("ChangePassword", { AccessToken: accessToken, PreviousPassword: previous, ProposedPassword: proposed });
    },

    async updateEmail(accessToken, email) {
      await call("UpdateUserAttributes", { AccessToken: accessToken, UserAttributes: [{ Name: "email", Value: email }] });
    },
    async sendEmailVerificationCode(accessToken) {
      await call("GetUserAttributeVerificationCode", { AccessToken: accessToken, AttributeName: "email" });
    },
    async verifyEmail(accessToken, code) {
      await call("VerifyUserAttribute", { AccessToken: accessToken, AttributeName: "email", Code: code });
    },
    async globalSignOut(accessToken) {
      await call("GlobalSignOut", { AccessToken: accessToken });
    },
    async revokeRefreshToken(refreshToken) {
      await call("RevokeToken", { Token: refreshToken, ClientId: cfg.clientId, ...(cfg.clientSecret ? { ClientSecret: cfg.clientSecret } : {}) });
    },

    async associateTotp(accessToken) {
      const r = await call<{ SecretCode?: string }>("AssociateSoftwareToken", { AccessToken: accessToken });
      if (!r.SecretCode) throw new CognitoUnavailableError("Cognito answered AssociateSoftwareToken without a secret");
      return { secret: r.SecretCode };
    },
    async verifyTotp(accessToken, code) {
      const r = await call<{ Status?: string }>("VerifySoftwareToken", { AccessToken: accessToken, UserCode: code, FriendlyDeviceName: "bizinsights" });
      return r.Status === "SUCCESS";
    },
    async setTotpEnabled(accessToken, enabled) {
      await call("SetUserMFAPreference", { AccessToken: accessToken, SoftwareTokenMfaSettings: { Enabled: enabled, PreferredMfa: enabled } });
    },
    async answerTotpChallenge(username, session, code) {
      // The name the challenge gave (USER_ID_FOR_SRP): Cognito's API reference says a challenge's
      // USERNAME can't be an alias, and the pool signs people in by email, whose users are named
      // by a UUID. SECRET_HASH is keyed by the same name.
      const r = await call<AuthResult>("RespondToAuthChallenge", {
        ClientId: cfg.clientId,
        ChallengeName: "SOFTWARE_TOKEN_MFA",
        Session: session,
        ChallengeResponses: { USERNAME: username, SOFTWARE_TOKEN_MFA_CODE: code, ...withSecret(username) },
      });
      return signInResult(r);
    },

    authorizeUrl({ provider, redirectUri, state, codeChallenge, nonce }) {
      if (!cfg.domain) throw new CognitoError("NotConfigured", "COGNITO_DOMAIN is not set");
      const q = new URLSearchParams({
        response_type: "code",
        client_id: cfg.clientId,
        redirect_uri: redirectUri,
        // Straight to Google: no Cognito page in between.
        identity_provider: provider,
        scope: "openid email profile",
        state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        nonce,
      });
      return `${cfg.domain}/oauth2/authorize?${q}`;
    },
    exchangeCode({ code, redirectUri, codeVerifier }) {
      return oauthToken({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: codeVerifier });
    },
    logoutUrl(logoutUri) {
      if (!cfg.domain) return null;
      return `${cfg.domain}/logout?${new URLSearchParams({ client_id: cfg.clientId, logout_uri: logoutUri })}`;
    },

    async adminGetUser(username) {
      try {
        return userOf(await call<AdminUser>("AdminGetUser", { UserPoolId: cfg.userPoolId, Username: username }, true));
      } catch (err) {
        if (err instanceof CognitoError && err.code === "UserNotFoundException") return null;
        throw err;
      }
    },
    async adminCreateUser({ email, emailVerified, name, password }) {
      const attrs = [
        { Name: "email", Value: email },
        { Name: "email_verified", Value: emailVerified ? "true" : "false" },
        ...(name ? [{ Name: "name", Value: name }] : []),
      ];
      const r = await call<{ User: AdminUser }>(
        "AdminCreateUser",
        // SUPPRESS: Cognito's invitation email (a temporary password) is never what we want here.
        { UserPoolId: cfg.userPoolId, Username: email, UserAttributes: attrs, MessageAction: "SUPPRESS" },
        true,
      );
      const user = userOf(r.User);
      // Created users must change a temporary password; a permanent one makes them CONFIRMED.
      try {
        await call("AdminSetUserPassword", { UserPoolId: cfg.userPoolId, Username: user.username, Password: password ?? unguessablePassword(), Permanent: true }, true);
      } catch (err) {
        // Don't leave a user nobody can sign in as behind (the caller decides what happens next).
        await call("AdminDeleteUser", { UserPoolId: cfg.userPoolId, Username: user.username }, true).catch(() => {});
        throw err;
      }
      return { ...user, status: "CONFIRMED", mfaEnabled: false };
    },
    async adminSetPassword(username, password) {
      await call("AdminSetUserPassword", { UserPoolId: cfg.userPoolId, Username: username, Password: password, Permanent: true }, true);
    },
    async adminDeleteUser(username) {
      try {
        await call("AdminDeleteUser", { UserPoolId: cfg.userPoolId, Username: username }, true);
      } catch (err) {
        if (err instanceof CognitoError && err.code === "UserNotFoundException") return;
        throw err;
      }
    },
    async adminGlobalSignOut(username) {
      try {
        await call("AdminUserGlobalSignOut", { UserPoolId: cfg.userPoolId, Username: username }, true);
      } catch (err) {
        if (err instanceof CognitoError && err.code === "UserNotFoundException") return;
        throw err;
      }
    },
  };
}

/**
 * Stand-in while COGNITO_USER_POOL_ID / COGNITO_CLIENT_ID are unset: every call fails as
 * "unavailable" (503 "try again"), and nobody is signed in or out by a missing setting.
 */
export function unconfiguredCognito(): CognitoAuth {
  const fail = async (): Promise<never> => {
    throw new CognitoUnavailableError("Cognito is not configured (COGNITO_USER_POOL_ID / COGNITO_CLIENT_ID)");
  };
  return {
    signUp: fail,
    confirmSignUp: fail,
    resendSignUpCode: fail,
    passwordSignIn: fail,
    startEmailOtp: fail,
    answerEmailOtp: fail,
    refresh: fail,
    verifyIdToken: fail,
    forgotPassword: fail,
    confirmForgotPassword: fail,
    changePassword: fail,
    updateEmail: fail,
    sendEmailVerificationCode: fail,
    verifyEmail: fail,
    globalSignOut: fail,
    revokeRefreshToken: fail,
    associateTotp: fail,
    verifyTotp: fail,
    setTotpEnabled: fail,
    answerTotpChallenge: fail,
    authorizeUrl: () => {
      throw new CognitoError("NotConfigured", "Cognito is not configured");
    },
    exchangeCode: fail,
    logoutUrl: () => null,
    adminGetUser: fail,
    adminCreateUser: fail,
    adminSetPassword: fail,
    adminDeleteUser: fail,
    adminGlobalSignOut: fail,
  };
}

import { randomBytes } from "node:crypto";

/**
 * What the API asks of whoever checks sign-ins, and the errors it answers with. The one provider is
 * the app's own sign-in (localAuth.ts); tests fake this interface (test/fakeCognito.ts).
 *
 * The names are Amazon Cognito's, kept from when its user pool was the provider (until 2026-11-13):
 * CognitoAuth, CognitoError and its exception names ("NotAuthorizedException", ...), the tokens'
 * and users' shapes. The routes were written against them and the app's own sign-in answers in the
 * same terms, so moving off Cognito changed no route. Nothing here calls Cognito, or AWS.
 *
 * The browser never holds one of these tokens: every call is made by the API (backend-for-frontend)
 * and the browser gets our own httpOnly session cookie (session.ts).
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
  /** The profile picture's address (Google's): https only. */
  picture?: string | null;
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

/** Everything the API needs from the sign-in provider, narrow enough for tests to fake. */
export interface CognitoAuth {
  // ---- Sign-up and sign-in ----
  signUp(input: { email: string; password: string; name: string }): Promise<{ sub: string; confirmed: boolean }>;
  confirmSignUp(email: string, code: string): Promise<void>;
  resendSignUpCode(email: string): Promise<void>;
  passwordSignIn(email: string, password: string): Promise<SignInResult>;
  /** Passwordless sign-in with a code Cognito emails (needs the Essentials plan and SES). */
  startEmailOtp(email: string): Promise<{ session: string }>;
  answerEmailOtp(email: string, session: string, code: string): Promise<SignInResult>;
  /**
   * New ID and access tokens (and a new refresh token when rotation is on). `username`: the
   * Cognito user name (the ID token's cognito:username), which keys a refresh's SECRET_HASH. For a
   * password user in this pool it equals the sub; for a Google user it is "google_<id>", and a hash
   * keyed by the sub is refused (NotAuthorizedException), which ended every Google session at its
   * first re-check (2026-10-19).
   */
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
  /**
   * `selectAccount`: the provider shows its account chooser even to a browser signed in to one
   * account (prompt=select_account, which managed login passes on to Google), so nothing is linked
   * without the person choosing it.
   */
  authorizeUrl(input: { provider: FederatedProvider; redirectUri: string; state: string; codeChallenge: string; nonce: string; selectAccount?: boolean }): string;
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

/** A password no one knows, that any password policy accepts. */
export const unguessablePassword = () => `${randomBytes(24).toString("base64url")}aA1!`;

/** A picture address fit to show as an image: https, and no longer than Cognito keeps an attribute. */
export function pictureUrl(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 2048) return null;
  try {
    return new URL(v).protocol === "https:" ? v : null;
  } catch {
    return null;
  }
}

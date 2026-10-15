import { decodeJwt } from "jose";
import type { FetchLike } from "@app/core";

/**
 * Moving password accounts from Firebase Authentication to Cognito, one sign-in at a time.
 *
 * Firebase stores passwords with its own modified scrypt (a signer key, salt separator and rounds),
 * which Cognito's password-hash import does not accept (it takes standard scrypt, bcrypt, Argon2id
 * and PBKDF2 only). So nobody's password is exported: when someone who has no Cognito user yet
 * signs in, the password they typed is checked against Firebase once, and if Firebase accepts it a
 * Cognito user is created with that same password (routes/auth.ts). After that Firebase is never
 * asked again for that person. Accounts that never sign in during the migration window reset their
 * password through Cognito instead ("Forgot password?" creates their Cognito user first).
 *
 * This is the only Firebase call left, and only while LEGACY_FIREBASE_API_KEY is set. It is not a
 * fallback sign-in: a session always comes from Cognito tokens.
 */
export interface LegacyPasswordCheck {
  /** The Firebase account for `email` when `password` is its password; null when it isn't (or there is none). */
  verifyPassword(email: string, password: string): Promise<{ uid: string; emailVerified: boolean; displayName: string | null } | null>;
}

/** Firebase could not be asked (network, 5xx, its own rate limit): not a verdict on the password. */
export class LegacyUnavailableError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "LegacyUnavailableError";
  }
}

/** Firebase's answers that mean "not this password / not this account". */
const REJECTED = /^(INVALID_PASSWORD|EMAIL_NOT_FOUND|INVALID_LOGIN_CREDENTIALS|INVALID_EMAIL|USER_DISABLED|MISSING_PASSWORD)\b/;

/** Firebase's public sign-in REST endpoint with the project's public web API key. */
export function firebasePasswordCheck(apiKey: string, fetchImpl: FetchLike = fetch): LegacyPasswordCheck {
  return {
    async verifyPassword(email, password) {
      let res: Response;
      try {
        res = await fetchImpl(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, password, returnSecureToken: true }),
        });
      } catch (err) {
        throw new LegacyUnavailableError(`Firebase unreachable: ${(err as Error).message}`, err);
      }
      const json = (await res.json().catch(() => ({}))) as { localId?: string; idToken?: string; displayName?: string; error?: { message?: string } };
      if (res.ok && json.localId && json.idToken) {
        // Straight from Google over TLS, so its claims can be read without checking the signature
        // again; only email_verified is taken from it.
        const claims = decodeJwt(json.idToken);
        return { uid: json.localId, emailVerified: claims.email_verified === true, displayName: json.displayName || null };
      }
      const msg = json.error?.message ?? `HTTP ${res.status}`;
      if (res.status === 400 && REJECTED.test(msg)) return null;
      // TOO_MANY_ATTEMPTS_TRY_LATER, 5xx and anything unknown: we couldn't find out.
      throw new LegacyUnavailableError(`Firebase password check failed (${res.status}): ${msg}`);
    },
  };
}

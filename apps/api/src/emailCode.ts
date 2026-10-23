import { createHmac, randomInt } from "node:crypto";
import { env, logger, type Coord } from "@app/core";
import { EMAIL_CODE_TTL_S, sha256Hex } from "@app/shared";
import { HttpError } from "./context.js";
import { limit, LIMITS, type Limit } from "./rateLimit.js";

/**
 * The 6-digit codes emailed at sign-up (to confirm the address) and at sign-in (after the
 * password), and the rules every one of them follows, enforced here on the server's clock:
 *
 * - A code lives CODE_TTL_S seconds from the moment it is issued. The page shows a countdown, but
 *   the countdown is only a picture of this: a code offered later is refused before anything looks
 *   at it, whatever the browser's clock says and however the page was reloaded.
 * - Another code may be asked for RESEND_AFTER_S seconds after the last one: as long as a code
 *   lives, so at most one code stands at any time, and a new one always replaces an expired one.
 * - A code takes MAX_ATTEMPTS wrong guesses, then it is thrown away and a new one must be asked for.
 *   The guesses are counted in the coordinator (DynamoDB on AWS), so they add up across instances.
 * - One address gets at most AUTH_CODE_LIMIT_HOURLY codes an hour and AUTH_CODE_LIMIT_DAILY a day
 *   (sign-up and sign-in together), and one IP address at most LIMITS.codeIp.
 *
 * The sign-up code itself is Cognito's (SignUp / ConfirmSignUp mark the address verified there), and
 * Cognito would keep it for 24 hours. It never reaches Cognito except through the API (the app client
 * is confidential: its secret signs every call), so the minute measured here is the only one that
 * counts. The sign-in code is the app's own: only its HMAC is stored (`codeHash`), and it is spent
 * with one atomic delete, so two answers can't both succeed.
 */

/** A code's life, in seconds, from the moment it is issued (the email says so too: @app/shared/auth). */
export const CODE_TTL_S = EMAIL_CODE_TTL_S;
/** Seconds after a code was issued before another one may be asked for. */
export const RESEND_AFTER_S = 60;
/** Wrong guesses one code takes; the one that reaches this ends the code. */
export const MAX_ATTEMPTS = 5;
/** How long the record of a code outlives the code, so "expired" can be told from "none was sent". */
const RECORD_GRACE_S = 15 * 60;

/** What the page needs for its countdowns: the server's clock, so the browser's never matters. */
export interface CodeChallenge {
  /** When the code was issued (ms since the epoch, server time). */
  issuedAt: number;
  /** When it stops being accepted. */
  expiresAt: number;
  /** When another one may be asked for. */
  resendAt: number;
  /** The server's clock as it answered, so the page can place the two moments on its own clock. */
  now: number;
}

export function challengeTiming(issuedAt: number, now = Date.now()): CodeChallenge {
  return { issuedAt, expiresAt: issuedAt + CODE_TTL_S * 1000, resendAt: issuedAt + RESEND_AFTER_S * 1000, now };
}

export const codeExpired = (issuedAt: number, now = Date.now()) => now >= issuedAt + CODE_TTL_S * 1000;

/** A fresh code: six digits from the kernel's random source (never Math.random). */
export const newCode = () => String(randomInt(0, 1_000_000)).padStart(6, "0");

/** What is kept of a code the app issued: an HMAC under the pepper, bound to what it is for. */
export const codeHash = (scope: string, code: string) => createHmac("sha256", env().OTP_PEPPER).update(`email-code:${scope}:${code}`).digest("hex");

// What the person is told, word for word what the pages show.
export const CODE_INCORRECT = "The verification code is incorrect. Please try again.";
export const CODE_EXPIRED = "This code has expired. Request a new code.";
export const CODE_TOO_MANY = "Too many attempts. Please try again later.";
export const CODE_RESENT = "A new verification code has been sent.";
export const CODE_UNAVAILABLE = "We couldn't send you an email right now. Please try again in a moment.";

export const incorrectCode = () => new HttpError(400, CODE_INCORRECT, "invalid_code");
export const expiredCode = () => new HttpError(400, CODE_EXPIRED, "expired_code");
export const tooManyAttempts = () => new HttpError(429, CODE_TOO_MANY, "too_many_attempts", RESEND_AFTER_S);
export const coordinatorDown = () => new HttpError(503, "We can't reach the sign-in service right now. Please try again in a moment.", "auth_unavailable");

/**
 * Refuses (429, Retry-After) while the code issued at `issuedAt` is still too young to be replaced.
 * The refusal carries the standing code's countdowns (`detail.challenge`), so a page that lost them
 * (reloaded) shows the right ones.
 */
export function requireResendAllowed(issuedAt: number, now = Date.now()) {
  const wait = Math.ceil((issuedAt + RESEND_AFTER_S * 1000 - now) / 1000);
  if (wait > 0) {
    throw new HttpError(429, `You can request a new code in ${wait} ${wait === 1 ? "second" : "seconds"}.`, "resend_cooldown", wait, { challenge: challengeTiming(issuedAt, now) });
  }
}

const positive = (raw: string, fallback: number) => (/^\d+$/.test(raw) && Number(raw) > 0 ? Number(raw) : fallback);

/** Codes one address may be emailed an hour and a day (AUTH_CODE_LIMIT_HOURLY / _DAILY; 6 and 20 by default). */
export function codeSendLimits(): { hourly: Limit; daily: Limit } {
  const e = env();
  return { hourly: { max: positive(e.AUTH_CODE_LIMIT_HOURLY, 6), windowSec: 3600 }, daily: { max: positive(e.AUTH_CODE_LIMIT_DAILY, 20), windowSec: 86_400 } };
}

/** Before a code is emailed: the address's hourly and daily caps, and the IP's. */
export async function limitCodeSends(coord: Coord, email: string, ip: string) {
  const caps = codeSendLimits();
  const hash = sha256Hex(email);
  await limit(coord, `rl:code:ip:${ip}`, LIMITS.codeIp, CODE_TOO_MANY);
  await limit(coord, `rl:code:h:${hash}`, caps.hourly, "Too many codes were sent to this address. Please try again in an hour.", "too_many_codes");
  await limit(coord, `rl:code:d:${hash}`, caps.daily, "Too many codes were sent to this address today. Please try again tomorrow.", "too_many_codes");
}

/**
 * One more guess at the code `scope` names (counted atomically, across instances). The number of
 * this guess, 1 for the first. Callers throw tooManyAttempts and drop the code once a wrong guess
 * is the MAX_ATTEMPTS-th; a guess past that (two answers racing) is refused here.
 */
export async function countAttempt(coord: Coord, scope: string): Promise<number> {
  const n = await coord.hit(`otp:tries:${scope}`, CODE_TTL_S + RECORD_GRACE_S).catch((err: unknown) => {
    logger.error({ err }, "could not count a code guess");
    throw coordinatorDown();
  });
  if (n > MAX_ATTEMPTS) throw tooManyAttempts();
  return n;
}

// ---------------- The sign-up code's record ----------------

/** What is kept of a sign-up code (Cognito holds the code itself): when it was issued. */
export interface SignUpCode {
  v: 1;
  issuedAt: number;
}

const signUpKey = (email: string) => `auth:code:signup:${sha256Hex(email)}`;
/** The counter of guesses at the sign-up code issued at `issuedAt`. */
export const signUpAttemptScope = (email: string, issuedAt: number) => `signup:${sha256Hex(email)}:${issuedAt}`;

/** The sign-up code standing for `email` (expired or not), or null when none was issued lately. */
export async function pendingSignUpCode(coord: Coord, email: string): Promise<SignUpCode | null> {
  const raw = await coord.peek(signUpKey(email)).catch((err: unknown) => {
    logger.error({ err }, "could not read a sign-up code's record");
    throw coordinatorDown();
  });
  if (!raw) return null;
  try {
    const rec = JSON.parse(raw) as SignUpCode;
    return rec?.v === 1 && typeof rec.issuedAt === "number" ? rec : null;
  } catch {
    return null;
  }
}

/** A sign-up code was just issued for `email`: from now its minute runs. */
export async function recordSignUpCode(coord: Coord, email: string, issuedAt: number) {
  const rec: SignUpCode = { v: 1, issuedAt };
  await coord.put(signUpKey(email), JSON.stringify(rec), CODE_TTL_S + RECORD_GRACE_S).catch((err: unknown) => {
    logger.error({ err }, "could not record a sign-up code");
    throw coordinatorDown();
  });
}

/** The sign-up code for `email` is spent (confirmed, or guessed at too often). */
export async function discardSignUpCode(coord: Coord, email: string) {
  await coord.take(signUpKey(email)).catch((err: unknown) => logger.warn({ err }, "could not discard a sign-up code's record"));
}

/**
 * The sign-up code for `email` as a guess arrives: its record, or expiredCode when none stands or
 * it is past its minute. The guess is counted here too (tooManyAttempts past the limit).
 */
export async function requireLiveSignUpCode(coord: Coord, email: string, now = Date.now()): Promise<{ code: SignUpCode; attempt: number }> {
  const code = await pendingSignUpCode(coord, email);
  if (!code || codeExpired(code.issuedAt, now)) throw expiredCode();
  const attempt = await countAttempt(coord, signUpAttemptScope(email, code.issuedAt));
  return { code, attempt };
}

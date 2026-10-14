import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { systemDb } from "@app/db";
import { employmentsForUser, env, logger } from "@app/core";
import { generateOtp, hashOtp, OTP_MAX_ATTEMPTS, OTP_TTL_MS, verifyOtp } from "@app/shared";
import { body, clientIp, HttpError, loadUser, requireAppOrigin, requireUser, retiredSessionKey, SESSION_COOKIE, type Ctx, type Deps } from "../context.js";
import { FirebaseUnavailableError } from "../authProvider.js";
import type { App } from "../app.js";
import { limit, LIMITS } from "../rateLimit.js";

const SESSION_TTL_MS = 5 * 24 * 3600 * 1000;
const RECENT_SIGN_IN_S = 5 * 60;

export function authRoutes(app: App, deps: Deps) {
  const cookieOpts = {
    path: "/",
    httpOnly: true,
    sameSite: "Lax" as const,
    secure: env().NODE_ENV === "production",
  };

  /** Exchange a fresh Firebase ID token for an httpOnly session cookie. */
  app.post("/auth/session", async (c) => {
    requireAppOrigin(c);
    const { idToken } = z.object({ idToken: z.string().min(10) }).parse(await body(c));
    await limit(deps.coord, `rl:session:${clientIp(c)}`, LIMITS.session);
    const claims = await deps.auth.verifyIdToken(idToken).catch((err) => {
      throw signInFailure(err, idToken, "POST /auth/session");
    });
    if (!claims.email) throw new HttpError(400, "An email address is required", "email_required");
    // Only mint sessions from recent sign-ins (Firebase best practice).
    if (Date.now() / 1000 - claims.authTime > RECENT_SIGN_IN_S) {
      logger.warn({ authTime: claims.authTime, now: Math.floor(Date.now() / 1000) }, "stale sign-in");
      // "Sign in again" can't get further than this route while our database is unreachable, and
      // for a "Continue with Shopify" signup it means proving the email by code, which an outage
      // can't issue either (each failed request still spends the address's small code budget).
      // So until the database answers, say "try again" rather than send them there.
      await systemDb.$queryRaw`SELECT 1`.catch(dbOutage(SIGN_IN_UNAVAILABLE));
      throw new HttpError(401, "Please sign in again", "stale_sign_in");
    }
    const email = claims.email.toLowerCase();
    // The token is genuine from here on, so a failure to store its user is our outage.
    const user = await sessionUser({ uid: claims.uid, email, emailVerified: claims.emailVerified, name: claims.name }).catch(
      dbOutage(SIGN_IN_UNAVAILABLE),
    );
    const cookie = await deps.auth.createSessionCookie(idToken, SESSION_TTL_MS).catch((err) => {
      throw signInFailure(err, idToken, "POST /auth/session createSessionCookie");
    });
    setCookie(c, SESSION_COOKIE, cookie, { ...cookieOpts, maxAge: SESSION_TTL_MS / 1000 });
    return c.json({ user: publicUser(user) });
  });

  /**
   * After the user clicks the Firebase verification link, the session cookie's
   * claims are stale. The client sends a fresh ID token for the SAME uid and we
   * update the stored verification flag (no new session is minted).
   */
  app.post("/auth/sync-profile", async (c) => {
    const user = await requireUser(c, deps);
    const { idToken } = z.object({ idToken: z.string().min(10) }).parse(await body(c));
    const claims = await deps.auth.verifyIdToken(idToken).catch((err) => {
      throw signInFailure(err, idToken, "POST /auth/sync-profile");
    });
    if (claims.uid !== user.firebaseUid) throw new HttpError(403, "Token does not match session", "forbidden");
    const u = await systemDb.user.update({ where: { id: user.id }, data: { emailVerified: claims.emailVerified || user.emailVerified } });
    return c.json({ user: publicUser(u) });
  });

  app.post("/auth/logout", async (c) => {
    // Sign out this browser, not the account. Revoking the account's Firebase tokens (as this
    // did) ended every session it had, so signing out on one device or browser logged the person
    // out everywhere else on their next refresh. Instead the cookie itself is retired until it
    // would have expired, so a copy of it can't be replayed. Only a genuine cookie is recorded,
    // and Firebase alone vouches for that, so signing out works while our database is down.
    // Best effort throughout: signing out must always clear the cookie below.
    const cookie = getCookie(c, SESSION_COOKIE);
    if (cookie && (await deps.auth.verifySessionCookie(cookie).then(() => true, () => false))) {
      await deps.coord
        .put(retiredSessionKey(cookie), "1", SESSION_TTL_MS / 1000)
        .catch((err: unknown) => logger.error({ err }, "could not retire the signed-out session cookie"));
    }
    deleteCookie(c, SESSION_COOKIE, cookieOpts);
    return c.json({ ok: true });
  });

  async function me(c: Ctx, user: Awaited<ReturnType<typeof requireUser>>) {
    const memberships = await systemDb.membership.findMany({
      where: { userId: user.id },
      include: { workspace: { select: { id: true, name: true } } },
      orderBy: { createdAt: "asc" },
    });
    return c.json({
      user: publicUser(user),
      workspaces: memberships.map((m) => ({ id: m.workspace.id, name: m.workspace.name, role: m.role, staffRole: m.staffRole })),
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

  app.patch("/me", async (c) => {
    const user = await requireUser(c, deps);
    const patch = z
      .object({
        displayName: z.string().trim().max(80).optional(),
        timezone: z.string().refine(validTz, "Unknown time zone").optional(),
      })
      .parse(await body(c));
    const u = await systemDb.user.update({ where: { id: user.id }, data: patch });
    return c.json({ user: publicUser(u) });
  });

  // ---------------- Email OTP (custom; Firebase has no native 6-digit email OTP) -------------

  app.post("/auth/otp/request", async (c) => {
    requireAppOrigin(c);
    const { email: raw } = z.object({ email: z.string().email().max(254) }).parse(await body(c));
    const email = raw.toLowerCase();
    const ip = clientIp(c);
    await limit(deps.coord, `rl:otp:ip:${ip}`, LIMITS.otpRequestIp);
    await limit(deps.coord, `rl:otp:email:${email}`, LIMITS.otpRequestEmail);

    const code = generateOtp();
    await systemDb.$transaction([
      // Only the newest code is valid.
      systemDb.emailOtp.updateMany({ where: { email, consumedAt: null }, data: { consumedAt: new Date() } }),
      systemDb.emailOtp.create({
        data: { email, codeHash: hashOtp(code, email, env().OTP_PEPPER), expiresAt: new Date(Date.now() + OTP_TTL_MS), ip },
      }),
    ]).catch(dbOutage("We can't send you a code right now. Please try again in a moment."));
    try {
      await deps.mailer.send(
        email,
        `Your sign-in code: ${code}`,
        `Your sign-in code is ${code}. It expires in 10 minutes. If you didn't request it, ignore this email.`,
      );
      // Same response whether or not an account exists (no enumeration).
      return c.json({ ok: true, method: "code" });
    } catch (err) {
      // No working email sender (e.g. no sending domain set up yet): fall back to a one-click
      // sign-in link that Firebase emails from its own address.
      logger.warn({ err: (err as Error).message }, "sign-in code email failed; sending a Firebase sign-in link instead");
    }
    // Back to /login, which finishes the sign-in.
    try {
      await deps.auth.sendEmailSignInLink(email, `${env().APP_URL}/login?emailLink=1`);
    } catch (err) {
      logger.error({ err }, "firebase sign-in link email failed");
      throw new HttpError(503, "We couldn't send you an email right now. Please sign in another way.", "email_unavailable");
    }
    return c.json({ ok: true, method: "link" });
  });

  /** The page opened from a sign-in link sends its code here; same outcome as /auth/otp/verify. */
  app.post("/auth/email-link/verify", async (c) => {
    requireAppOrigin(c);
    const input = z.object({ email: z.string().email().max(254), oobCode: z.string().min(10).max(2000) }).parse(await body(c));
    await limit(deps.coord, `rl:emaillink:verify:${clientIp(c)}`, LIMITS.emailLinkVerifyIp);
    const uid = await deps.auth.redeemEmailSignInLink(input.email.toLowerCase(), input.oobCode).catch((err) => {
      if (err instanceof FirebaseUnavailableError) {
        logger.error({ msg: err.message }, "email sign-in link could not be checked");
        throw new HttpError(503, "We can't check that link right now. Please try again in a moment.", "auth_unavailable");
      }
      logger.warn({ msg: (err as Error).message }, "email sign-in link rejected");
      throw new HttpError(400, "That sign-in link is invalid, already used or expired. Request a new one.", "invalid_link");
    });
    const customToken = await deps.auth.createCustomToken(uid);
    // Client calls signInWithCustomToken(customToken) then POST /auth/session.
    return c.json({ customToken });
  });

  app.post("/auth/otp/verify", async (c) => {
    requireAppOrigin(c);
    const input = z.object({ email: z.string().email(), code: z.string().regex(/^\d{6}$/) }).parse(await body(c));
    const email = input.email.toLowerCase();
    await limit(deps.coord, `rl:otp:verify:${clientIp(c)}`, LIMITS.otpVerifyIp);
    const outage = dbOutage("We can't check your code right now. Please try again in a moment.");
    // The per-IP limit does nothing against guesses spread over many addresses: cap the guesses
    // at this address's codes too (see LIMITS.otpGuessesPerEmail).
    const guesses = await systemDb.emailOtp
      .aggregate({
        where: { email, createdAt: { gt: new Date(Date.now() - LIMITS.otpGuessesPerEmail.windowSec * 1000) } },
        _sum: { attempts: true },
      })
      .catch(outage);
    if ((guesses._sum.attempts ?? 0) >= LIMITS.otpGuessesPerEmail.max) {
      throw new HttpError(429, "Too many attempts for this email address. Please sign in another way or try again tomorrow.", "rate_limited");
    }

    const otp = await systemDb.emailOtp
      .findFirst({ where: { email, consumedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: "desc" } })
      .catch(outage);
    const invalid = new HttpError(400, "That code is invalid or has expired", "invalid_code");
    if (!otp) throw invalid;
    // Atomically count the attempt; refuse once the budget is exhausted.
    const bumped = await systemDb.emailOtp
      .updateMany({ where: { id: otp.id, attempts: { lt: OTP_MAX_ATTEMPTS }, consumedAt: null }, data: { attempts: { increment: 1 } } })
      .catch(outage);
    if (bumped.count === 0) throw invalid;
    if (!verifyOtp(input.code, email, env().OTP_PEPPER, otp.codeHash)) throw invalid;
    // Single use: only one concurrent verifier can consume it.
    const consumed = await systemDb.emailOtp
      .updateMany({ where: { id: otp.id, consumedAt: null }, data: { consumedAt: new Date() } })
      .catch(outage);
    if (consumed.count === 0) throw invalid;

    const uid = await deps.auth.upsertVerifiedEmailUser(email);
    const customToken = await deps.auth.createCustomToken(uid);
    // Client calls signInWithCustomToken(customToken) then POST /auth/session.
    return c.json({ customToken });
  });
}

/**
 * Three different problems used to leave here as one 401 "Invalid sign-in token": a token we
 * should reject, an account that is gone/disabled/revoked, and Firebase being unreachable. Tell
 * them apart — retrying a 503 is the right move, while re-running sign-in against an outage only
 * loops, and "invalid token" sends the user hunting for a fault that isn't theirs.
 */
const isUniqueViolation = (err: unknown) => (err as { code?: string })?.code === "P2002";

const SIGN_IN_UNAVAILABLE = "We can't finish signing you in right now. Please try again in a moment.";

/**
 * `.catch` for a database call on the sign-in path. The database is reachable only through a
 * tunnel that drops, so a failure there is our outage: say "try again" (503) as loadUser does,
 * not a bare 500 "Something went wrong" that leaves the merchant nowhere to go. HttpErrors pass.
 */
function dbOutage(message: string) {
  return (err: unknown): never => {
    if (err instanceof HttpError) throw err;
    logger.error({ err }, "database unreachable during sign-in");
    throw new HttpError(503, message, "db_unavailable");
  };
}

/**
 * The user row for a verified Firebase sign-in.
 *
 * Rows are keyed by Firebase uid, but `email` is unique too, and the two can disagree: an account
 * deleted and re-created in Firebase (or an Auth emulator restart) comes back with a new uid for
 * the same address. A plain upsert-by-uid then tried to *create* a second row for that email,
 * hit the unique constraint, and every sign-in for that person was a 500 from then on.
 *
 * The existing row is re-linked to the new uid only when Firebase vouches for the address
 * (`emailVerified`) - otherwise anyone could register an unverified Firebase account under
 * someone else's email and inherit their workspaces. An unverified newcomer is told the address
 * is taken; proving it by email code (which verifies it) then signs them in to the old row.
 */
async function sessionUser(claims: { uid: string; email: string; emailVerified: boolean; name?: string | null }) {
  const { uid, email, emailVerified } = claims;
  const taken = () => new HttpError(409, "That email address belongs to another account. Sign in with an email code to prove it's yours.", "email_in_use");
  const known = await systemDb.user.findUnique({ where: { firebaseUid: uid } });
  if (known) {
    return systemDb.user.update({ where: { id: known.id }, data: { email, emailVerified } }).catch((err: unknown) => {
      if (isUniqueViolation(err)) throw taken();
      throw err;
    });
  }
  const sameEmail = await systemDb.user.findUnique({ where: { email } });
  if (sameEmail) {
    if (!emailVerified) throw taken();
    logger.warn({ userId: sameEmail.id }, "re-linking user to a new Firebase account for the same verified email");
    return systemDb.user.update({ where: { id: sameEmail.id }, data: { firebaseUid: uid, emailVerified: true } });
  }
  try {
    return await systemDb.user.create({ data: { firebaseUid: uid, email, emailVerified, displayName: claims.name } });
  } catch (err) {
    // Two first sign-ins racing: the other request created the row.
    if (!isUniqueViolation(err)) throw err;
    const raced = await systemDb.user.findUnique({ where: { firebaseUid: uid } });
    if (!raced) throw taken();
    return raced;
  }
}

function signInFailure(err: unknown, idToken: string, at: string): HttpError {
  const [h, p] = idToken.split(".").map((s) => { try { return JSON.parse(Buffer.from(s, "base64url").toString()); } catch { return null; } });
  const code = (err as { code?: string }).code;
  logger.warn(
    { at, code, msg: (err as Error).message, alg: h?.alg, kid: h?.kid, iss: p?.iss, aud: p?.aud },
    "verifyIdToken failed",
  );
  if (err instanceof FirebaseUnavailableError) {
    return new HttpError(503, "We can't verify your sign-in right now. Please try again in a moment.", "auth_unavailable");
  }
  switch (code) {
    case "auth/user-disabled":
      return new HttpError(403, "This account has been disabled", "account_disabled");
    case "auth/user-not-found":
      return new HttpError(401, "This account no longer exists", "account_not_found");
    // Both mean the token predates something that invalidated it (a password reset, an email
    // proof, a logout): the credential was real, it just has to be re-minted.
    case "auth/id-token-revoked":
    case "auth/id-token-expired":
      return new HttpError(401, "Please sign in again", "stale_sign_in");
  }
  return new HttpError(401, "Invalid sign-in token", "invalid_token");
}

function validTz(tz: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function publicUser(u: { id: string; email: string; emailVerified: boolean; displayName: string | null; timezone: string }) {
  return { id: u.id, email: u.email, emailVerified: u.emailVerified, displayName: u.displayName, timezone: u.timezone };
}

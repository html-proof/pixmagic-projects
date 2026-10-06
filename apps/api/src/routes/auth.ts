import { deleteCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { systemDb } from "@app/db";
import { env, logger } from "@app/core";
import { generateOtp, hashOtp, OTP_MAX_ATTEMPTS, OTP_TTL_MS, verifyOtp } from "@app/shared";
import { body, clientIp, HttpError, requireUser, SESSION_COOKIE, type Deps } from "../context.js";
import { FirebaseUnavailableError } from "../authProvider.js";
import type { App } from "../app.js";
import { limit } from "../rateLimit.js";
import { clearSignup } from "./shopifySignup.js";

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
    const { idToken } = z.object({ idToken: z.string().min(10) }).parse(await body(c));
    await limit(deps.coord, `rl:session:${clientIp(c)}`, 30, 300);
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
      await systemDb.$queryRaw`SELECT 1`.catch((err: unknown) => {
        logger.error({ err }, "database unreachable during sign-in");
        throw new HttpError(503, "We can't finish signing you in right now. Please try again in a moment.", "db_unavailable");
      });
      throw new HttpError(401, "Please sign in again", "stale_sign_in");
    }
    const email = claims.email.toLowerCase();
    const user = await systemDb.user.upsert({
      where: { firebaseUid: claims.uid },
      create: { firebaseUid: claims.uid, email, emailVerified: claims.emailVerified, displayName: claims.name },
      update: { email, emailVerified: claims.emailVerified },
    });
    const cookie = await deps.auth.createSessionCookie(idToken, SESSION_TTL_MS);
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
    // Best effort, outages included: signing out must always clear the session cookie below.
    const user = await requireUser(c, deps).catch(() => null);
    if (user) await deps.auth.revokeRefreshTokens(user.firebaseUid).catch(() => {});
    deleteCookie(c, SESSION_COOKIE, cookieOpts);
    // A half-finished "Continue with Shopify" must not outlive the session in this browser.
    await clearSignup(c, deps).catch(() => {});
    return c.json({ ok: true });
  });

  app.get("/me", async (c) => {
    const user = await requireUser(c, deps);
    const memberships = await systemDb.membership.findMany({
      where: { userId: user.id },
      include: { workspace: { select: { id: true, name: true } } },
      orderBy: { createdAt: "asc" },
    });
    return c.json({
      user: publicUser(user),
      workspaces: memberships.map((m) => ({ id: m.workspace.id, name: m.workspace.name, role: m.role })),
    });
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
    const { email: raw, continuePath } = z
      .object({ email: z.string().email().max(254), continuePath: z.enum(["/login", "/start"]).optional() })
      .parse(await body(c));
    const email = raw.toLowerCase();
    const ip = clientIp(c);
    await limit(deps.coord, `rl:otp:ip:${ip}`, 10, 3600);
    await limit(deps.coord, `rl:otp:email:${email}`, 3, 900);

    const code = generateOtp();
    await systemDb.$transaction([
      // Only the newest code is valid.
      systemDb.emailOtp.updateMany({ where: { email, consumedAt: null }, data: { consumedAt: new Date() } }),
      systemDb.emailOtp.create({
        data: { email, codeHash: hashOtp(code, email, env().OTP_PEPPER), expiresAt: new Date(Date.now() + OTP_TTL_MS), ip },
      }),
    ]);
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
    // Back to the page that asked: /login finishes a sign-in, /start finishes connecting a store.
    const back = continuePath === "/start" ? "/start?step=link" : "/login?emailLink=1";
    try {
      await deps.auth.sendEmailSignInLink(email, `${env().APP_URL}${back}`);
    } catch (err) {
      logger.error({ err }, "firebase sign-in link email failed");
      throw new HttpError(503, "We couldn't send you an email right now. Please sign in another way.", "email_unavailable");
    }
    return c.json({ ok: true, method: "link" });
  });

  /** The page opened from a sign-in link sends its code here; same outcome as /auth/otp/verify. */
  app.post("/auth/email-link/verify", async (c) => {
    const input = z.object({ email: z.string().email().max(254), oobCode: z.string().min(10).max(2000) }).parse(await body(c));
    await limit(deps.coord, `rl:emaillink:verify:${clientIp(c)}`, 20, 900);
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
    const input = z.object({ email: z.string().email(), code: z.string().regex(/^\d{6}$/) }).parse(await body(c));
    const email = input.email.toLowerCase();
    await limit(deps.coord, `rl:otp:verify:${clientIp(c)}`, 20, 900);

    const otp = await systemDb.emailOtp.findFirst({
      where: { email, consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
    });
    const invalid = new HttpError(400, "That code is invalid or has expired", "invalid_code");
    if (!otp) throw invalid;
    // Atomically count the attempt; refuse once the budget is exhausted.
    const bumped = await systemDb.emailOtp.updateMany({
      where: { id: otp.id, attempts: { lt: OTP_MAX_ATTEMPTS }, consumedAt: null },
      data: { attempts: { increment: 1 } },
    });
    if (bumped.count === 0) throw invalid;
    if (!verifyOtp(input.code, email, env().OTP_PEPPER, otp.codeHash)) throw invalid;
    // Single use: only one concurrent verifier can consume it.
    const consumed = await systemDb.emailOtp.updateMany({
      where: { id: otp.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
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

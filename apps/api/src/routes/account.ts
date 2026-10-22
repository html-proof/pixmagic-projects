import { z } from "zod";
import { systemDb, type User } from "@app/db";
import { detachUserAdGrants, logger, revokeReleasedAdGrants } from "@app/core";
import { accountPasswordProblem, EMAIL_CODE_RE, SIGN_IN_FAILED_EVENT } from "@app/shared";
import { accessTokenFor, body, clientIp, HttpError, requireUser, sessionOf, sessionProvesAddress, type Ctx, type Deps } from "../context.js";
import { CognitoError, type CognitoUser, type SignInMethod } from "../cognito.js";
import { cognitoUsernameKey, notifyMethodAdded, notifyMethodRemoved, recordAuthEvent } from "../identity.js";
import { endSessions, recordSession } from "../devices.js";
import {
  clearSessionCookies,
  LINK_PROOF_TTL_S,
  linkProofKey,
  newSession,
  provesAddress,
  readRefreshToken,
  RECENT_SIGN_IN_S,
  setSessionCookies,
  signedInRecently as recentSignIn,
} from "../session.js";
import type { App } from "../app.js";
import { limit, LIMITS } from "../rateLimit.js";
import { cognitoFailure, enabledProviders, publicUser } from "./auth.js";

const codeSchema = z.string().trim().regex(EMAIL_CODE_RE, "Enter the 6-digit code from the email.");
const totpSchema = z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code from your authenticator app.");
const isUniqueViolation = (err: unknown) => (err as { code?: string })?.code === "P2002";
const isCognito = (err: unknown, ...codes: string[]) => err instanceof CognitoError && codes.includes(err.code);
/** How far back GET /auth/account counts failed sign-ins (the Security page's "suspicious activity"). */
const FAILED_SIGN_INS_WINDOW_MS = 7 * 86_400_000;

/**
 * Cognito refusing this session's own access token means the session can't make this change: it
 * was ended elsewhere, or it came from Google, whose tokens may not change the account in Cognito.
 * Signing in again (with the password, for a Google session) is the way on, never "wrong password".
 */
function accountFailure(err: unknown, at: string): HttpError {
  if (isCognito(err, "NotAuthorizedException")) return new HttpError(401, "Please sign in again to change this.", "reauth_required");
  return cognitoFailure(err, at);
}

/** The authenticator app's `otpauth://` address (a QR code of it, or a tap on a phone, adds the account). */
function otpauthUri(email: string, secret: string) {
  const issuer = "bizinsights";
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email)}?${new URLSearchParams({ secret, issuer, algorithm: "SHA1", digits: "6", period: "30" })}`;
}

/** Account security: password, email, verification, sign-in methods, two-step verification, sign-out everywhere (auth.ts), deletion. */
export function accountRoutes(app: App, deps: Deps) {
  /** The password is the account's: Cognito says yes to it (a two-step challenge still means it was right). */
  async function checkPassword(email: string, password: string) {
    const r = await deps.auth.passwordSignIn(email, password).catch((err: unknown) => {
      if (isCognito(err, "NotAuthorizedException")) throw new HttpError(400, "Your current password isn't right.", "wrong_password");
      throw cognitoFailure(err, "reauthenticate");
    });
    // Those tokens were only for this check.
    if ("tokens" in r && r.tokens.refreshToken) await deps.auth.revokeRefreshToken(r.tokens.refreshToken).catch((err: unknown) => logger.warn({ err }, "could not revoke a check's refresh token"));
  }

  const signedInRecently = (c: Ctx) => recentSignIn(sessionOf(c));
  const reauthRequired = () => new HttpError(401, `Sign out and sign in again with Google, then try again within ${RECENT_SIGN_IN_S / 60} minutes.`, "reauth_required");
  /** A Google account linked under another address can't stand in for the account's own. */
  const ownAddressRequired = (user: User) =>
    new HttpError(401, `To do this, sign in with your email and password, or with Google using ${user.email}, your account's address.`, "reauth_required");
  const hasPassword = async (userId: string) => (await systemDb.authIdentity.count({ where: { userId, method: "password" } })) > 0;

  /**
   * How this session proves it's the person again, for a change that could lock them out:
   * - "password": the account's password (a password session; or a Google account linked under
   *   another address, which proves that address only);
   * - "recent_sign_in": a sign-in in the last few minutes with Google using the account's own address;
   * - "own_address_sign_in": nothing it has: a Google account under another address, and no password.
   */
  async function confirmWith(c: Ctx, user: User): Promise<"password" | "recent_sign_in" | "own_address_sign_in"> {
    if (sessionOf(c).m === "password") return "password";
    if (sessionProvesAddress(c, user)) return "recent_sign_in";
    return (await hasPassword(user.id)) ? "password" : "own_address_sign_in";
  }

  /**
   * The person proves it's them again (confirmWith). Otherwise whoever linked their own Google
   * account (one stolen minute at a signed-in computer is enough) could later remove the owner's
   * password from their own sessions and add one of theirs for the owner's address.
   */
  async function reauthenticate(c: Ctx, user: User, password: string | undefined) {
    const how = await confirmWith(c, user);
    if (how === "own_address_sign_in") throw ownAddressRequired(user);
    if (how === "password") {
      if (!password) throw new HttpError(400, "Enter your current password.", "password_required");
      return checkPassword(user.email, password);
    }
    if (!signedInRecently(c)) throw reauthRequired();
  }

  /**
   * Two-step verification here protects the password: it is set up with the password's own
   * Cognito user, which only a password session holds. Google sign-ins have Google's 2-Step
   * Verification.
   */
  function passwordSession(c: Ctx) {
    const s = sessionOf(c);
    if (s.m !== "password") {
      throw new HttpError(
        400,
        "Two-step verification here protects your password. You signed in with Google: turn on 2-Step Verification in your Google account, or sign in with your password to set it up here.",
        "mfa_password_only",
      );
    }
    return s;
  }

  app.get("/auth/account", async (c) => {
    const user = await requireUser(c, deps);
    const s = sessionOf(c);
    const identities = await systemDb.authIdentity.findMany({ where: { userId: user.id }, orderBy: { createdAt: "asc" } });
    const password = identities.find((i) => i.method === "password");
    // From Cognito, which holds it. null: it couldn't be asked just now (the page says so).
    const mfaEnabled = password
      ? await deps.auth.adminGetUser(password.username).then(
          (u) => u?.mfaEnabled ?? false,
          (err: unknown) => {
            logger.warn({ err }, "could not read two-step verification from Cognito");
            return null;
          },
        )
      : false;
    const [passwordEvent, failedSignIns] = await Promise.all([
      password ? systemDb.authEvent.findFirst({ where: { userId: user.id, type: { in: ["password_changed", "password_reset"] } }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }) : null,
      systemDb.authEvent.count({ where: { userId: user.id, type: SIGN_IN_FAILED_EVENT, createdAt: { gte: new Date(Date.now() - FAILED_SIGN_INS_WINDOW_MS) } } }),
    ]);
    return c.json({
      user: publicUser(user),
      signedInWith: s.m,
      signedInAt: s.at * 1000,
      sessionExpiresAt: s.exp,
      methods: identities.map((i) => ({ id: i.id, method: i.method, email: i.email, linkedAt: i.createdAt, lastUsedAt: i.lastUsedAt })),
      hasPassword: !!password,
      // "Link Google account": the deployment offers Google, and this account has no Google sign-in yet.
      canLinkGoogle: enabledProviders().has("Google") && !identities.some((i) => i.method === "google"),
      // A password is changed with the email-and-password Cognito user, which this session must be.
      canChangePassword: s.m === "password",
      // Added from a Google sign-in that proved the account's own address (which the password is for).
      canAddPassword: !password && sessionProvesAddress(c, user),
      // A Google account's address comes from Google on every sign-in. An address nobody has proved
      // stays until it is (identity.ts: whatever others gave it is its owner's).
      canChangeEmail: s.m === "password" && user.emailVerified,
      // What removing a method or deleting the account asks for (reauthenticate).
      confirmWith: await confirmWith(c, user),
      mfaEnabled,
      // When the password was last set (changed, reset, or added): null without one.
      passwordChangedAt: password ? (passwordEvent?.createdAt ?? password.createdAt) : null,
      // Sign-ins to this account stopped at the password or the code, in the last week.
      failedSignIns,
    });
  });

  app.post("/auth/account/password", async (c) => {
    const user = await requireUser(c, deps);
    const s = sessionOf(c);
    const input = z.object({ currentPassword: z.string().min(1, "Enter your current password.").max(256), password: z.string().max(256), confirmPassword: z.string().max(256) }).parse(await body(c));
    await limit(deps.coord, `rl:account:${user.id}`, LIMITS.accountChange);
    if (s.m !== "password") {
      const hasPassword = await systemDb.authIdentity.count({ where: { userId: user.id, method: "password" } });
      throw hasPassword
        ? new HttpError(400, "You signed in with Google. To change your password, sign in with your email and password, or use \"Forgot password?\" on the sign-in page.", "no_password")
        : new HttpError(400, "You signed in with Google and have no password here yet. Add one below.", "no_password");
    }
    const weak = accountPasswordProblem(input.password);
    if (weak) throw new HttpError(400, weak, "weak_password");
    if (input.password !== input.confirmPassword) throw new HttpError(400, "The two new passwords don't match.", "password_mismatch");
    if (input.password === input.currentPassword) throw new HttpError(400, "Choose a password different from your current one.", "same_password");
    const accessToken = await accessTokenFor(c, deps);
    await deps.auth.changePassword(accessToken, input.currentPassword, input.password).catch((err: unknown) => {
      if (isCognito(err, "NotAuthorizedException")) throw new HttpError(400, "Your current password isn't right.", "wrong_password");
      throw cognitoFailure(err, "change password");
    });
    // Everywhere else is signed out (whoever knew the old password is out); this browser gets a
    // fresh session from the new password, unless the account asks for an app code at sign-in:
    // then this browser signs in again too.
    await deps.auth.globalSignOut(accessToken).catch((err: unknown) => logger.warn({ err }, "Cognito sign-out after a password change failed"));
    await systemDb.user.update({ where: { id: user.id }, data: { sessionsValidAfter: new Date() } });
    await endSessions({ userId: user.id });
    const fresh = await deps.auth.passwordSignIn(user.email, input.password).catch((err: unknown) => {
      throw cognitoFailure(err, "sign in after password change");
    });
    let signedIn = false;
    if ("tokens" in fresh) {
      const claims = await deps.auth.verifyIdToken(fresh.tokens.idToken);
      const next = newSession({ userId: user.id, sub: claims.sub, username: claims.username, method: "password", authTime: claims.authTime, keep: s.keep, ownAddress: provesAddress(claims, user.email) });
      setSessionCookies(c, next, fresh.tokens.refreshToken);
      // The same device, under its new session: no new sign-in in the activity.
      await recordSession(c, next, clientIp(c), { activity: false });
      signedIn = true;
    } else {
      clearSessionCookies(c);
    }
    await recordAuthEvent("password_changed", user.id, clientIp(c));
    return c.json({ ok: true, signedIn });
  });

  /**
   * A password for an account that signs in with Google only: a password Cognito user for the
   * account's address, linked to it. A recent Google sign-in with that address proves it's them
   * (Google verified it). One with a Google account linked under another address proves nothing
   * about this one, so it can't set the address's password. (Before, the advice was "Forgot
   * password?", which can't work: there is no password user to reset.)
   */
  app.post("/auth/account/password/add", async (c) => {
    const user = await requireUser(c, deps);
    const input = z.object({ password: z.string().max(256), confirmPassword: z.string().max(256) }).parse(await body(c));
    await limit(deps.coord, `rl:account:${user.id}`, LIMITS.accountChange);
    if (await hasPassword(user.id)) {
      throw new HttpError(409, "You already have a password. To change it, sign in with it, or use \"Forgot password?\" on the sign-in page.", "password_exists");
    }
    if (!user.emailVerified) throw new HttpError(403, "Verify your email address first, then add a password.", "email_unverified");
    if (!sessionProvesAddress(c, user)) throw ownAddressRequired(user);
    if (!signedInRecently(c)) throw reauthRequired();
    const weak = accountPasswordProblem(input.password);
    if (weak) throw new HttpError(400, weak, "weak_password");
    if (input.password !== input.confirmPassword) throw new HttpError(400, "The two passwords don't match.", "password_mismatch");
    const create = () => deps.auth.adminCreateUser({ email: user.email, emailVerified: true, name: user.displayName, password: input.password });
    let created: CognitoUser;
    try {
      created = await create();
    } catch (err) {
      if (!isCognito(err, "UsernameExistsException")) throw cognitoFailure(err, "add password");
      // A password user with this address that isn't this account's. Someone's unfinished
      // sign-up never proved the inbox, which this account has: it goes. A confirmed one did, so
      // it is this person's: signing in with it links it (resolveUser).
      const existing = await deps.auth.adminGetUser(user.email).catch((e: unknown) => {
        throw cognitoFailure(e, "add password");
      });
      const linked = existing && (await systemDb.authIdentity.findUnique({ where: { provider_subject: { provider: "cognito", subject: existing.sub } } }));
      if (existing?.status !== "UNCONFIRMED" || linked) {
        throw new HttpError(409, "There's already a password for this email address. Sign out and sign in with it (or use \"Forgot password?\"), and it joins this account.", "password_exists");
      }
      await deps.auth.adminDeleteUser(existing.username).catch((e: unknown) => {
        throw cognitoFailure(e, "add password");
      });
      created = await create().catch((e: unknown) => {
        throw cognitoFailure(e, "add password");
      });
    }
    try {
      await systemDb.authIdentity.create({ data: { userId: user.id, provider: "cognito", subject: created.sub, username: created.username, method: "password", email: user.email } });
    } catch (err) {
      // No Cognito user that no account points at.
      await deps.auth.adminDeleteUser(created.username).catch((e: unknown) => logger.error({ err: e }, "could not remove a password user after failing to link it"));
      throw err;
    }
    await recordAuthEvent("identity_linked", user.id, clientIp(c), { cognitoSub: created.sub, method: "password", via: "settings", cognitoUsername: cognitoUsernameKey(created.username) });
    // The account's address hears of it, in case it wasn't them.
    await notifyMethodAdded(deps.mailer, user, { method: "password", email: user.email });
    return c.json({ ok: true });
  });

  /**
   * Linking a Google account adds a way into the account, so it needs the person again: a sign-in
   * in the last 15 minutes, or this. The password, checked here, lets this session start one link
   * (GET /auth/oauth/google/start?link=1) in the next few minutes. Password sessions only: a
   * Google session's account has its Google sign-in already.
   */
  app.post("/auth/account/methods/google/prepare", async (c) => {
    const user = await requireUser(c, deps);
    const s = sessionOf(c);
    const input = z.object({ password: z.string().min(1, "Enter your current password.").max(256) }).parse(await body(c));
    await limit(deps.coord, `rl:account:${user.id}`, LIMITS.accountChange);
    if (s.m !== "password") throw new HttpError(400, "Sign in with your email and password to link a Google account.", "password_session_required");
    if (!user.emailVerified) throw new HttpError(403, "Verify your email address first, then link Google.", "email_unverified");
    await checkPassword(user.email, input.password);
    await deps.coord.put(linkProofKey(s.sid), "1", LINK_PROOF_TTL_S).catch((err: unknown) => {
      logger.error({ err }, "could not store a link's proof");
      throw new HttpError(503, "We can't reach the sign-in service right now. Please try again in a moment.", "auth_unavailable");
    });
    return c.json({ ok: true, expiresInSeconds: LINK_PROOF_TTL_S });
  });

  /**
   * Remove one way of signing in (its Cognito user goes too). Never the last one, nor the one this
   * session signed in with; and it needs the person again, like any change that could lock them out
   * (a Google account linked under another address can't remove the owner's own ways in by itself).
   * The removal is kept in auth_events (identity_removed, with its Cognito user name), which stops a
   * removed Google account from linking itself back by its address (identity.ts, removedFromAccount),
   * and the account's address hears of it.
   */
  app.delete("/auth/account/methods/:id", async (c) => {
    const user = await requireUser(c, deps);
    const s = sessionOf(c);
    const input = z.object({ password: z.string().max(256).optional() }).parse(await body(c));
    await limit(deps.coord, `rl:account:${user.id}`, LIMITS.accountChange);
    const identities = await systemDb.authIdentity.findMany({ where: { userId: user.id } });
    const target = identities.find((i) => i.id === c.req.param("id"));
    if (!target) throw new HttpError(404, "That sign-in method isn't on your account.", "not_found");
    if (identities.length < 2) throw new HttpError(409, "This is the only way you sign in. Add another before removing it.", "last_method");
    if (target.subject === s.sub) throw new HttpError(409, "You're signed in with this method right now. Sign in another way, then remove it.", "method_in_use");
    await reauthenticate(c, user, input.password);
    // Cognito first: from here the method signs nobody in. Its sessions here end on their next
    // request, refresh-token cookie or not (context.ts: a session's sign-in must be the account's).
    await deps.auth.adminDeleteUser(target.username).catch((err: unknown) => {
      throw cognitoFailure(err, "remove sign-in method");
    });
    // Together: the event is what keeps the method out (not a best-effort trail here).
    await systemDb.$transaction([
      systemDb.authIdentity.deleteMany({ where: { id: target.id, userId: user.id } }),
      systemDb.authEvent.create({
        data: { type: "identity_removed", userId: user.id, ip: clientIp(c), metadata: { cognitoSub: target.subject, method: target.method, cognitoUsername: cognitoUsernameKey(target.username) } },
      }),
    ]);
    // Its sessions end on their next request (above): off the device list now.
    await endSessions({ userId: user.id, method: target.method });
    await notifyMethodRemoved(deps.mailer, user, {
      method: target.method as SignInMethod,
      email: target.email,
      passwordLeft: identities.some((i) => i.id !== target.id && i.method === "password"),
    });
    return c.json({ ok: true });
  });

  // ---------------- Two-step verification (an authenticator app, TOTP) ----------------

  /**
   * Step 1: Cognito's secret for the person's authenticator app, shown once (as text and as an
   * otpauth:// address). Nothing changes at sign-in until a code from the app confirms it (step 2).
   * Needs a recent sign-in or the current password.
   */
  app.post("/auth/account/mfa/setup", async (c) => {
    const user = await requireUser(c, deps);
    const input = z.object({ password: z.string().max(256).optional() }).parse(await body(c));
    await limit(deps.coord, `rl:account:${user.id}`, LIMITS.accountChange);
    const s = passwordSession(c);
    if (input.password) await checkPassword(user.email, input.password);
    else if (!signedInRecently(c)) throw new HttpError(400, "Enter your current password.", "password_required");
    const current = await deps.auth.adminGetUser(s.un).catch((err: unknown) => {
      throw cognitoFailure(err, "read two-step verification");
    });
    if (current?.mfaEnabled) throw new HttpError(409, "Two-step verification is already on. Turn it off first to move it to another app.", "mfa_already_on");
    const accessToken = await accessTokenFor(c, deps);
    const { secret } = await deps.auth.associateTotp(accessToken).catch((err: unknown) => {
      throw accountFailure(err, "start two-step verification");
    });
    c.header("cache-control", "no-store");
    return c.json({ secret, otpauthUri: otpauthUri(user.email, secret) });
  });

  /** Step 2: a code from the app proves it is set up; from now on every sign-in asks for one. */
  app.post("/auth/account/mfa/verify", async (c) => {
    const user = await requireUser(c, deps);
    const { code } = z.object({ code: totpSchema }).parse(await body(c));
    await limit(deps.coord, `rl:mfa:ip:${clientIp(c)}`, LIMITS.mfaVerifyIp);
    await limit(deps.coord, `rl:mfa:account:${user.id}`, LIMITS.mfaVerifyAccount);
    passwordSession(c);
    const accessToken = await accessTokenFor(c, deps);
    const ok = await deps.auth.verifyTotp(accessToken, code).catch((err: unknown) => {
      if (isCognito(err, "CodeMismatchException", "EnableSoftwareTokenMFAException")) return false;
      throw accountFailure(err, "verify two-step code");
    });
    if (!ok) throw new HttpError(400, "That code isn't right. Check the time on your phone, then enter the code your app shows now.", "invalid_code");
    await deps.auth.setTotpEnabled(accessToken, true).catch((err: unknown) => {
      throw accountFailure(err, "turn on two-step verification");
    });
    await recordAuthEvent("mfa_enabled", user.id, clientIp(c), { method: "totp" });
    return c.json({ ok: true, mfaEnabled: true });
  });

  /**
   * Turn it off: the password and a current code from the app, checked the way a sign-in checks
   * them (Cognito has no other way to check a code once the app is set up).
   */
  app.post("/auth/account/mfa/disable", async (c) => {
    const user = await requireUser(c, deps);
    const input = z.object({ password: z.string().min(1, "Enter your current password.").max(256), code: totpSchema }).parse(await body(c));
    await limit(deps.coord, `rl:account:${user.id}`, LIMITS.accountChange);
    await limit(deps.coord, `rl:mfa:account:${user.id}`, LIMITS.mfaVerifyAccount);
    passwordSession(c);
    const first = await deps.auth.passwordSignIn(user.email, input.password).catch((err: unknown) => {
      if (isCognito(err, "NotAuthorizedException")) throw new HttpError(400, "Your current password isn't right.", "wrong_password");
      throw cognitoFailure(err, "turn off two-step verification");
    });
    let accessToken: string;
    let refreshToken: string | undefined;
    if ("tokens" in first) {
      // No code asked for: it is off already.
      ({ accessToken, refreshToken } = first.tokens);
    } else {
      if (first.challenge !== "SOFTWARE_TOKEN_MFA") throw new HttpError(403, "Your account needs a sign-in step this app doesn't support yet. Please contact support.", "challenge_unsupported");
      const done = await deps.auth.answerTotpChallenge(first.username ?? user.email, first.session, input.code).catch((err: unknown) => {
        if (isCognito(err, "CodeMismatchException")) throw new HttpError(400, "That code isn't right. Enter the code your authenticator app shows now.", "invalid_code");
        throw cognitoFailure(err, "turn off two-step verification");
      });
      if (!("tokens" in done)) throw new HttpError(403, "Your account needs a sign-in step this app doesn't support yet. Please contact support.", "challenge_unsupported");
      ({ accessToken, refreshToken } = done.tokens);
      await deps.auth.setTotpEnabled(accessToken, false).catch((err: unknown) => {
        throw accountFailure(err, "turn off two-step verification");
      });
      await recordAuthEvent("mfa_disabled", user.id, clientIp(c), { method: "totp" });
    }
    // Those tokens were only for this check.
    if (refreshToken) await deps.auth.revokeRefreshToken(refreshToken).catch((err: unknown) => logger.warn({ err }, "could not revoke a check's refresh token"));
    return c.json({ ok: true, mfaEnabled: false });
  });

  /**
   * An account whose address nobody has proved (an employee who joined from a copied link) keeps
   * it until it is proved: what workspace owners gave that address (an invitation, an employee
   * record) belongs to its owner, who takes the account over by proving it (identity.ts). Moved to
   * another address, it would go with whoever opened the account instead.
   */
  const unverifiedAddress = () =>
    new HttpError(403, "Verify your current email address first, then change it. If it isn't your address, ask whoever invited you to invite the right one.", "email_unverified");

  /** The address Cognito has for this session's Cognito user now (after a code it accepted), and whether it is verified. */
  async function cognitoAddress(c: Ctx, at: string) {
    const s = sessionOf(c);
    const rt = readRefreshToken(c, s);
    if (!rt) throw new HttpError(401, "Please sign in again.", "reauth_required");
    return deps.auth
      .refresh(rt, s.un || s.sub)
      .then((t) => deps.auth.verifyIdToken(t.idToken))
      .catch((err: unknown) => {
        throw accountFailure(err, at);
      });
  }

  /** Step 1 of an email change: Cognito emails a code to the new address (the old one stays until it's confirmed). */
  app.post("/auth/account/email", async (c) => {
    const user = await requireUser(c, deps);
    const s = sessionOf(c);
    const input = z.object({ email: z.string().trim().email("Enter a valid email address.").max(254).transform((e) => e.toLowerCase()), password: z.string().max(256).optional() }).parse(await body(c));
    await limit(deps.coord, `rl:account:${user.id}`, LIMITS.accountChange);
    if (s.m !== "password") throw new HttpError(400, "Your email address comes from Google. Change it there.", "email_managed_elsewhere");
    if (!user.emailVerified) throw unverifiedAddress();
    if (input.email === user.email) throw new HttpError(400, "That's already your email address.", "same_email");
    await reauthenticate(c, user, input.password);
    if (await systemDb.user.findUnique({ where: { email: input.email } })) {
      throw new HttpError(409, "That email address belongs to another account.", "email_in_use");
    }
    const accessToken = await accessTokenFor(c, deps);
    await deps.auth.updateEmail(accessToken, input.email).catch((err: unknown) => {
      throw accountFailure(err, "update email");
    });
    return c.json({ ok: true, pendingEmail: input.email });
  });

  /** Step 2: the code from the new address. Then the account's email is the new one. */
  app.post("/auth/account/email/confirm", async (c) => {
    const user = await requireUser(c, deps);
    const s = sessionOf(c);
    const { code } = z.object({ code: codeSchema }).parse(await body(c));
    await limit(deps.coord, `rl:code:verify:${clientIp(c)}`, LIMITS.codeVerifyIp);
    if (!user.emailVerified) throw unverifiedAddress();
    const accessToken = await accessTokenFor(c, deps);
    await deps.auth.verifyEmail(accessToken, code).catch((err: unknown) => {
      throw accountFailure(err, "confirm email change");
    });
    // What Cognito now says the address is.
    const claims = await cognitoAddress(c, "read changed email");
    if (!claims.email || !claims.emailVerified) throw new HttpError(400, "That code isn't right. Check the email and try again.", "invalid_code");
    const updated = await systemDb.user.update({ where: { id: user.id }, data: { email: claims.email, emailVerified: true } }).catch((err: unknown) => {
      if (isUniqueViolation(err)) throw new HttpError(409, "That email address belongs to another account.", "email_in_use");
      throw err;
    });
    await systemDb.authIdentity.updateMany({ where: { userId: user.id, subject: s.sub }, data: { email: claims.email } });
    await recordAuthEvent("email_changed", user.id, clientIp(c), { from: user.email, to: claims.email });
    return c.json({ user: publicUser(updated) });
  });

  /** An account whose address isn't verified yet (an employee who joined from a copied link, say): a code to it. */
  app.post("/auth/account/verify-email/send", async (c) => {
    const user = await requireUser(c, deps);
    await limit(deps.coord, `rl:account:verify:${user.id}`, LIMITS.codeEmail);
    if (user.emailVerified) return c.json({ ok: true, alreadyVerified: true });
    const accessToken = await accessTokenFor(c, deps);
    await deps.auth.sendEmailVerificationCode(accessToken).catch((err: unknown) => {
      throw accountFailure(err, "send verification code");
    });
    return c.json({ ok: true });
  });

  /**
   * The code from the account's own address. Cognito takes any code it sent this user (one for an
   * email change to another address too), so the account counts as verified only when Cognito now
   * vouches for the account's own address: never because someone proved an inbox of theirs.
   */
  app.post("/auth/account/verify-email", async (c) => {
    const user = await requireUser(c, deps);
    const { code } = z.object({ code: codeSchema }).parse(await body(c));
    await limit(deps.coord, `rl:code:verify:${clientIp(c)}`, LIMITS.codeVerifyIp);
    if (user.emailVerified) return c.json({ user: publicUser(user) });
    const accessToken = await accessTokenFor(c, deps);
    await deps.auth.verifyEmail(accessToken, code).catch((err: unknown) => {
      throw accountFailure(err, "verify email");
    });
    const claims = await cognitoAddress(c, "read verified email");
    if (!provesAddress(claims, user.email)) {
      logger.warn({ userId: user.id }, "a verification code proved another address than the account's; not verified");
      throw new HttpError(400, `That code wasn't for ${user.email}. Ask for a new code, then enter the one we send there.`, "invalid_code");
    }
    const updated = await systemDb.user.update({ where: { id: user.id }, data: { emailVerified: true } });
    await recordAuthEvent("email_verified", user.id, clientIp(c));
    return c.json({ user: publicUser(updated) });
  });

  /**
   * Delete the account: its sign-in identities in Cognito, then the user (memberships go with it;
   * employee records an organization keeps lose their link to it). Refused while the person is the
   * only owner of a workspace, whose stores and data would otherwise be left with nobody.
   */
  app.post("/auth/account/delete", async (c) => {
    const user = await requireUser(c, deps);
    const input = z.object({ confirm: z.literal("DELETE", { errorMap: () => ({ message: "Type DELETE to confirm." }) }), password: z.string().max(256).optional() }).parse(await body(c));
    await limit(deps.coord, `rl:account:${user.id}`, LIMITS.accountChange);
    await reauthenticate(c, user, input.password);
    const owned = await systemDb.membership.findMany({ where: { userId: user.id, role: "owner" }, include: { workspace: { select: { id: true, name: true } } } });
    const soleOwner: string[] = [];
    for (const m of owned) {
      const others = await systemDb.membership.count({ where: { workspaceId: m.workspaceId, role: "owner", userId: { not: user.id } } });
      if (!others) soleOwner.push(m.workspace.name);
    }
    if (soleOwner.length) {
      return c.json(
        {
          error: "sole_owner",
          message: `You're the only owner of ${soleOwner.join(", ")}. Delete ${soleOwner.length > 1 ? "those workspaces" : "that workspace"} or make someone else an owner first.`,
          workspaces: soleOwner,
        },
        409,
      );
    }
    const identities = await systemDb.authIdentity.findMany({ where: { userId: user.id } });
    // Sign-in first, so nobody can sign in to a half-deleted account.
    for (const id of identities) {
      await deps.auth.adminDeleteUser(id.username).catch((err: unknown) => {
        throw cognitoFailure(err, "delete Cognito user");
      });
    }
    let released: Awaited<ReturnType<typeof detachUserAdGrants>> | null = null;
    try {
      // Ad connections their login powers stop using it (they wait for someone else to reconnect them,
      // keeping their days): a database step that never stops the account from being deleted.
      released = await detachUserAdGrants(user.id).catch((err: unknown) => {
        logger.error({ err, userId: user.id }, "account deletion: the person's ad connections weren't released; their tokens remain until a disconnect");
        return null;
      });
      await systemDb.user.delete({ where: { id: user.id } });
    } catch (err) {
      logger.error({ err, userId: user.id }, "account deletion: Cognito users deleted but the user row was not; finish by hand (docs/RUNBOOK.md)");
      await recordAuthEvent("account_deletion_incomplete", user.id, clientIp(c));
      throw new HttpError(503, "We removed your sign-in but couldn't finish deleting your data. We'll complete it; contact support if you need confirmation.", "deletion_incomplete");
    }
    // Then their grants go back to Google or Meta unless something else relies on them: best effort,
    // within AD_RELEASE_REVOKE_BUDGET_MS, so a platform that doesn't answer can't hold up the answer.
    if (released?.grants.length) {
      const outcomes = await revokeReleasedAdGrants(released.grants, deps.fetchImpl);
      logger.info({ userId: user.id, released: released.released, outcomes }, "account deletion: ad connections released");
    }
    await recordAuthEvent("account_deleted", null, clientIp(c), { userId: user.id, identities: identities.length });
    clearSessionCookies(c);
    return c.json({ ok: true });
  });
}

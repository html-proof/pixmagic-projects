import { z } from "zod";
import { systemDb } from "@app/db";
import { logger } from "@app/core";
import { accountPasswordProblem, EMAIL_CODE_RE } from "@app/shared";
import { accessTokenFor, body, clientIp, HttpError, requireUser, sessionOf, type Ctx, type Deps } from "../context.js";
import { CognitoError } from "../cognito.js";
import { recordAuthEvent } from "../identity.js";
import { clearSessionCookies, newSession, readRefreshToken, setSessionCookies } from "../session.js";
import type { App } from "../app.js";
import { limit, LIMITS } from "../rateLimit.js";
import { cognitoFailure, publicUser } from "./auth.js";

/** Changes that hand over the account (email, deletion) need a sign-in this recent, or the password. */
const RECENT_SIGN_IN_S = 15 * 60;
const codeSchema = z.string().trim().regex(EMAIL_CODE_RE, "Enter the 6-digit code from the email.");
const isUniqueViolation = (err: unknown) => (err as { code?: string })?.code === "P2002";

/** Account security: password, email, verification, sign-out everywhere (auth.ts), deletion. */
export function accountRoutes(app: App, deps: Deps) {
  /**
   * The person proves it's them again: their password when they signed in with one, else a
   * Google/Apple sign-in in the last few minutes.
   */
  async function reauthenticate(c: Ctx, email: string, password: string | undefined) {
    const s = sessionOf(c);
    if (s.m === "password") {
      if (!password) throw new HttpError(400, "Enter your current password.", "password_required");
      await deps.auth.passwordSignIn(email, password).catch((err: unknown) => {
        if (err instanceof CognitoError && err.code === "NotAuthorizedException") throw new HttpError(400, "Your current password isn't right.", "wrong_password");
        throw cognitoFailure(err, "reauthenticate");
      });
      return;
    }
    if (Date.now() / 1000 - s.at > RECENT_SIGN_IN_S) {
      throw new HttpError(401, `Sign out and sign in again with ${s.m === "google" ? "Google" : "Apple"}, then try again within ${RECENT_SIGN_IN_S / 60} minutes.`, "reauth_required");
    }
  }

  app.get("/auth/account", async (c) => {
    const user = await requireUser(c, deps);
    const s = sessionOf(c);
    const identities = await systemDb.authIdentity.findMany({ where: { userId: user.id }, orderBy: { createdAt: "asc" } });
    return c.json({
      user: publicUser(user),
      signedInWith: s.m,
      signedInAt: s.at * 1000,
      sessionExpiresAt: s.exp,
      methods: identities.map((i) => ({ method: i.method, email: i.email, linkedAt: i.createdAt, lastUsedAt: i.lastUsedAt })),
      // A password belongs to the email-and-password Cognito user, which this session must be.
      canChangePassword: s.m === "password",
      // Google's and Apple's addresses come from them on every sign-in.
      canChangeEmail: s.m === "password",
    });
  });

  app.post("/auth/account/password", async (c) => {
    const user = await requireUser(c, deps);
    const s = sessionOf(c);
    const input = z.object({ currentPassword: z.string().min(1, "Enter your current password.").max(256), password: z.string().max(256), confirmPassword: z.string().max(256) }).parse(await body(c));
    await limit(deps.coord, `rl:account:${user.id}`, LIMITS.accountChange);
    if (s.m !== "password") throw new HttpError(400, "You signed in with Google or Apple, which has no password here. Use \"Forgot password?\" on the sign-in page to add one.", "no_password");
    const weak = accountPasswordProblem(input.password);
    if (weak) throw new HttpError(400, weak, "weak_password");
    if (input.password !== input.confirmPassword) throw new HttpError(400, "The two new passwords don't match.", "password_mismatch");
    if (input.password === input.currentPassword) throw new HttpError(400, "Choose a password different from your current one.", "same_password");
    const accessToken = await accessTokenFor(c, deps);
    await deps.auth.changePassword(accessToken, input.currentPassword, input.password).catch((err: unknown) => {
      if (err instanceof CognitoError && err.code === "NotAuthorizedException") throw new HttpError(400, "Your current password isn't right.", "wrong_password");
      throw cognitoFailure(err, "change password");
    });
    // Everywhere else is signed out (whoever knew the old password is out); this browser gets a
    // fresh session from the new password.
    await deps.auth.globalSignOut(accessToken).catch((err: unknown) => logger.warn({ err }, "Cognito sign-out after a password change failed"));
    await systemDb.user.update({ where: { id: user.id }, data: { sessionsValidAfter: new Date() } });
    const fresh = await deps.auth.passwordSignIn(user.email, input.password).catch((err: unknown) => {
      throw cognitoFailure(err, "sign in after password change");
    });
    if ("tokens" in fresh) {
      const claims = await deps.auth.verifyIdToken(fresh.tokens.idToken);
      setSessionCookies(c, newSession({ userId: user.id, sub: claims.sub, username: claims.username, method: "password", authTime: claims.authTime }), fresh.tokens.refreshToken);
    } else {
      clearSessionCookies(c);
    }
    await recordAuthEvent("password_changed", user.id, clientIp(c));
    return c.json({ ok: true });
  });

  /** Step 1 of an email change: Cognito emails a code to the new address (the old one stays until it's confirmed). */
  app.post("/auth/account/email", async (c) => {
    const user = await requireUser(c, deps);
    const s = sessionOf(c);
    const input = z.object({ email: z.string().trim().email("Enter a valid email address.").max(254).transform((e) => e.toLowerCase()), password: z.string().max(256).optional() }).parse(await body(c));
    await limit(deps.coord, `rl:account:${user.id}`, LIMITS.accountChange);
    if (s.m !== "password") throw new HttpError(400, "Your email address comes from Google or Apple. Change it there.", "email_managed_elsewhere");
    if (input.email === user.email) throw new HttpError(400, "That's already your email address.", "same_email");
    await reauthenticate(c, user.email, input.password);
    if (await systemDb.user.findUnique({ where: { email: input.email } })) {
      throw new HttpError(409, "That email address belongs to another account.", "email_in_use");
    }
    const accessToken = await accessTokenFor(c, deps);
    await deps.auth.updateEmail(accessToken, input.email).catch((err: unknown) => {
      throw cognitoFailure(err, "update email");
    });
    return c.json({ ok: true, pendingEmail: input.email });
  });

  /** Step 2: the code from the new address. Then the account's email is the new one. */
  app.post("/auth/account/email/confirm", async (c) => {
    const user = await requireUser(c, deps);
    const s = sessionOf(c);
    const { code } = z.object({ code: codeSchema }).parse(await body(c));
    await limit(deps.coord, `rl:code:verify:${clientIp(c)}`, LIMITS.codeVerifyIp);
    const accessToken = await accessTokenFor(c, deps);
    await deps.auth.verifyEmail(accessToken, code).catch((err: unknown) => {
      throw cognitoFailure(err, "confirm email change");
    });
    // What Cognito now says the address is.
    const rt = readRefreshToken(c, s);
    if (!rt) throw new HttpError(401, "Please sign in again.", "reauth_required");
    const claims = await deps.auth
      .refresh(rt, s.un)
      .then((t) => deps.auth.verifyIdToken(t.idToken))
      .catch((err: unknown) => {
        throw cognitoFailure(err, "read changed email");
      });
    if (!claims.email || !claims.emailVerified) throw new HttpError(400, "That code isn't right. Check the email and try again.", "invalid_code");
    const updated = await systemDb.user.update({ where: { id: user.id }, data: { email: claims.email, emailVerified: true } }).catch((err: unknown) => {
      if (isUniqueViolation(err)) throw new HttpError(409, "That email address belongs to another account.", "email_in_use");
      throw err;
    });
    await systemDb.authIdentity.updateMany({ where: { userId: user.id, subject: s.sub }, data: { email: claims.email } });
    await recordAuthEvent("email_changed", user.id, clientIp(c), { from: user.email, to: claims.email });
    return c.json({ user: publicUser(updated) });
  });

  /** An account whose address isn't verified yet (moved from Firebase unverified): a code to it. */
  app.post("/auth/account/verify-email/send", async (c) => {
    const user = await requireUser(c, deps);
    await limit(deps.coord, `rl:account:verify:${user.id}`, LIMITS.codeEmail);
    if (user.emailVerified) return c.json({ ok: true, alreadyVerified: true });
    const accessToken = await accessTokenFor(c, deps);
    await deps.auth.sendEmailVerificationCode(accessToken).catch((err: unknown) => {
      throw cognitoFailure(err, "send verification code");
    });
    return c.json({ ok: true });
  });

  app.post("/auth/account/verify-email", async (c) => {
    const user = await requireUser(c, deps);
    const { code } = z.object({ code: codeSchema }).parse(await body(c));
    await limit(deps.coord, `rl:code:verify:${clientIp(c)}`, LIMITS.codeVerifyIp);
    if (user.emailVerified) return c.json({ user: publicUser(user) });
    const accessToken = await accessTokenFor(c, deps);
    await deps.auth.verifyEmail(accessToken, code).catch((err: unknown) => {
      throw cognitoFailure(err, "verify email");
    });
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
    await reauthenticate(c, user.email, input.password);
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
    try {
      await systemDb.user.delete({ where: { id: user.id } });
    } catch (err) {
      logger.error({ err, userId: user.id }, "account deletion: Cognito users deleted but the user row was not; finish by hand (docs/RUNBOOK.md)");
      await recordAuthEvent("account_deletion_incomplete", user.id, clientIp(c));
      throw new HttpError(503, "We removed your sign-in but couldn't finish deleting your data. We'll complete it; contact support if you need confirmation.", "deletion_incomplete");
    }
    await recordAuthEvent("account_deleted", null, clientIp(c), { userId: user.id, identities: identities.length });
    clearSessionCookies(c);
    return c.json({ ok: true });
  });
}

import { systemDb, type AuthIdentity, type User } from "@app/db";
import { logger } from "@app/core";
import type { CognitoAuth, IdentityClaims } from "./cognito.js";
import { HttpError } from "./context.js";

/** Account-level security events (auth_events). Best effort: never fails what it records. */
export async function recordAuthEvent(type: string, userId: string | null, ip: string | null, metadata?: Record<string, unknown>) {
  await systemDb.authEvent
    .create({ data: { type, userId, ip, metadata: metadata as object | undefined } })
    .catch((err: unknown) => logger.error({ err, type }, "could not record an auth event"));
}

const isUniqueViolation = (err: unknown) => (err as { code?: string })?.code === "P2002";

export const emailTaken = () =>
  new HttpError(
    409,
    "That email address belongs to another account. Sign in the way you did before, or use \"Forgot password?\" to prove the address is yours.",
    "email_in_use",
  );

const providerEmailUnverified = () =>
  new HttpError(
    400,
    "Google hasn't confirmed that this email address is yours, so we can't create an account with it. Confirm it in your Google account, or create an account with your email and a password.",
    "email_unverified_provider",
  );

/**
 * An account whose address was never verified meets a sign-in that verifies it: the verified one
 * takes the account over. Whoever set up the account's other sign-in methods never proved the
 * inbox (anyone can create an employee with someone's address and open the copied link
 * themselves), so those methods are removed in Cognito and here, and every session of the account
 * ends, before the new identity is linked. The same rule Firebase applies to unverified providers.
 * An account with no sign-in yet (a Team & Access invitation's placeholder) has nothing to remove.
 */
async function takeOverUnverified(user: User & { identities: AuthIdentity[] }, claims: IdentityClaims, opts: ResolveOptions): Promise<User> {
  const prior = user.identities.filter((i) => i.subject !== claims.sub);
  // Cognito first, so the old password stops working even if what follows fails (a retry finishes it).
  for (const id of prior) {
    await opts.auth.adminDeleteUser(id.username).catch((err: unknown) => {
      logger.error({ err, userId: user.id }, "could not remove an unverified account's Cognito user");
      throw new HttpError(503, "We can't finish signing you in right now. Please try again in a moment.", "auth_unavailable");
    });
  }
  const updated = await systemDb.$transaction(async (tx) => {
    // Only these rows: a concurrent take-over may already have linked the new identity.
    if (prior.length) await tx.authIdentity.deleteMany({ where: { id: { in: prior.map((i) => i.id) } } });
    return tx.user.update({ where: { id: user.id }, data: { emailVerified: true, ...(prior.length > 0 && { sessionsValidAfter: new Date() }) } });
  });
  if (prior.length) {
    await recordAuthEvent("unverified_identity_removed", user.id, opts.ip ?? null, {
      removed: prior.map((i) => ({ cognitoSub: i.subject, method: i.method })),
      by: { cognitoSub: claims.sub, method: claims.method },
    });
  }
  return updated;
}

export interface ResolveOptions {
  ip?: string | null;
  /** Removes the Cognito users of an unverified account a verified sign-in takes over. */
  auth: Pick<CognitoAuth, "adminDeleteUser">;
}

/**
 * The user (users.id, which never changes) for a verified Cognito sign-in, creating or linking as
 * needed. In order:
 *
 * 1. The Cognito user is already linked (auth_identities): that user.
 * 2. A user with the same email exists: linked only when Cognito vouches for the address
 *    (email_verified: a confirmed sign-up code, Google). Otherwise anyone could register
 *    someone else's address and walk into their workspaces; they are told it's taken instead.
 *    When that user's own address was never verified, the verified sign-in takes it over
 *    (takeOverUnverified).
 * 3. Nobody: a new user. Not from a Google account whose address Google hasn't verified: such an
 *    account could never verify it here (Google's tokens can't ask Cognito for a code).
 *
 * Idempotent: the (provider, subject) pair is unique, so a retried or concurrent first sign-in
 * finds the identity the other one created.
 */
export async function resolveUser(claims: IdentityClaims, opts: ResolveOptions): Promise<User> {
  const email = claims.email?.toLowerCase() ?? null;
  if (!email) throw new HttpError(400, "An email address is required to sign in. Share your email with us when you sign in with Google.", "email_required");
  const where = { provider_subject: { provider: "cognito", subject: claims.sub } };

  const linked = await systemDb.authIdentity.findUnique({ where, include: { user: true } });
  if (linked) {
    let user = linked.user;
    const data: { email?: string; emailVerified?: boolean } = {};
    // Cognito is the authority on the address once it has verified it (an email change, say): when
    // this identity's address was the account's. One linked under another address (Google, from
    // Settings) never renames the account.
    if (claims.emailVerified && email !== user.email && linked.email !== email && linked.email === user.email) data.email = email;
    if (claims.emailVerified && !user.emailVerified) data.emailVerified = true;
    if (Object.keys(data).length) {
      user = await systemDb.user.update({ where: { id: user.id }, data }).catch((err: unknown) => {
        // The new address already belongs to another user: keep this one's and say nothing.
        if (isUniqueViolation(err)) {
          logger.warn({ userId: linked.userId }, "a Cognito email change collides with another user's email; kept the old one");
          return linked.user;
        }
        throw err;
      });
    }
    await systemDb.authIdentity.update({ where: { id: linked.id }, data: { lastUsedAt: new Date(), email } });
    return user;
  }

  const link = async (user: User, reason: string) => {
    try {
      await systemDb.authIdentity.create({
        data: {
          userId: user.id,
          provider: "cognito",
          subject: claims.sub,
          username: claims.username,
          method: claims.method,
          email,
          lastUsedAt: new Date(),
        },
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // A concurrent first sign-in linked it already.
      const raced = await systemDb.authIdentity.findUnique({ where, include: { user: true } });
      if (raced) return raced.user;
      throw err;
    }
    await recordAuthEvent(reason, user.id, opts.ip ?? null, { cognitoSub: claims.sub, method: claims.method });
    return user;
  };

  const sameEmail = await systemDb.user.findUnique({ where: { email }, include: { identities: true } });
  if (sameEmail) {
    if (!claims.emailVerified) throw emailTaken();
    const user: User = sameEmail.emailVerified ? sameEmail : await takeOverUnverified(sameEmail, claims, opts);
    return link(user, "identity_linked");
  }

  if (!claims.emailVerified && claims.method !== "password") throw providerEmailUnverified();

  try {
    const created = await systemDb.user.create({
      data: {
        email,
        emailVerified: claims.emailVerified,
        displayName: claims.name?.slice(0, 80) ?? null,
        identities: {
          create: {
            provider: "cognito",
            subject: claims.sub,
            username: claims.username,
            method: claims.method,
            email,
            lastUsedAt: new Date(),
          },
        },
      },
    });
    await recordAuthEvent("account_created", created.id, opts.ip ?? null, { cognitoSub: claims.sub, method: claims.method });
    return created;
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // Two first sign-ins racing: the other request created the user (and its identity).
    const raced = await systemDb.authIdentity.findUnique({ where, include: { user: true } });
    if (raced) return raced.user;
    throw emailTaken();
  }
}

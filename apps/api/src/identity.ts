import { systemDb, type User } from "@app/db";
import { logger } from "@app/core";
import type { IdentityClaims } from "./cognito.js";
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

/**
 * The user (users.id, which never changes) for a verified Cognito sign-in, creating or linking as
 * needed. In order:
 *
 * 1. The Cognito user is already linked (auth_identities): that user.
 * 2. It was just created from a Firebase account (`firebaseUid`): the user that Firebase account
 *    belonged to, whatever its email says.
 * 3. A user with the same email exists: linked only when Cognito vouches for the address
 *    (email_verified: a confirmed sign-up code, Google, Apple). Otherwise anyone could register
 *    someone else's address and walk into their workspaces; they are told it's taken instead.
 * 4. Nobody: a new user.
 *
 * Idempotent: the (provider, subject) pair is unique, so a retried or concurrent first sign-in
 * finds the identity the other one created.
 */
export async function resolveUser(claims: IdentityClaims, opts: { firebaseUid?: string; ip?: string | null } = {}): Promise<User> {
  const email = claims.email?.toLowerCase() ?? null;
  if (!email) throw new HttpError(400, "An email address is required to sign in. Share your email with us when you sign in with Google or Apple.", "email_required");
  const where = { provider_subject: { provider: "cognito", subject: claims.sub } };

  const linked = await systemDb.authIdentity.findUnique({ where, include: { user: true } });
  if (linked) {
    let user = linked.user;
    const data: { email?: string; emailVerified?: boolean } = {};
    // Cognito is the authority on the address once it has verified it (an email change, say).
    if (claims.emailVerified && email !== user.email && linked.email !== email) data.email = email;
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
          migratedFromFirebaseUid: opts.firebaseUid ?? null,
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
    await recordAuthEvent(reason, user.id, opts.ip ?? null, { cognitoSub: claims.sub, method: claims.method, ...(opts.firebaseUid ? { firebaseUid: opts.firebaseUid } : {}) });
    return user;
  };

  if (opts.firebaseUid) {
    const legacy = await systemDb.user.findUnique({ where: { firebaseUid: opts.firebaseUid } });
    if (legacy) {
      const user = claims.emailVerified && !legacy.emailVerified ? await systemDb.user.update({ where: { id: legacy.id }, data: { emailVerified: true } }) : legacy;
      return link(user, "firebase_account_migrated");
    }
  }

  const sameEmail = await systemDb.user.findUnique({ where: { email } });
  if (sameEmail) {
    if (!claims.emailVerified) throw emailTaken();
    const user = sameEmail.emailVerified ? sameEmail : await systemDb.user.update({ where: { id: sameEmail.id }, data: { emailVerified: true } });
    return link(user, "identity_linked");
  }

  try {
    const created = await systemDb.user.create({
      data: {
        email,
        emailVerified: claims.emailVerified,
        displayName: claims.name?.slice(0, 80) ?? null,
        firebaseUid: opts.firebaseUid ?? null,
        identities: {
          create: {
            provider: "cognito",
            subject: claims.sub,
            username: claims.username,
            method: claims.method,
            email,
            migratedFromFirebaseUid: opts.firebaseUid ?? null,
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

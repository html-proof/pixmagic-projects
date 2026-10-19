import { systemDb, type AuthIdentity, type Tx, type User } from "@app/db";
import { env, logger, type Mailer } from "@app/core";
import type { CognitoAuth, IdentityClaims, SignInMethod } from "./cognito.js";
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

const removedMethod = () =>
  new HttpError(
    409,
    "This Google account was removed from your bizinsights account's ways to sign in. Sign in another way, then link it again in Settings → Security if you want to use it.",
    "google_removed",
  );

/**
 * The name auth_events use for a Cognito user ("google_<id>" for a Google one): it stays the same
 * when Cognito creates the federated user again (a new sub) after it was removed.
 */
export const cognitoUsernameKey = (username: string) => username.toLowerCase();

/**
 * The account removed this Google account from its ways to sign in (Settings → Security) and
 * hasn't linked it again since: identity_removed and identity_linked events name it by its Cognito
 * user name. Without this, its next "Continue with Google" would link it straight back by its
 * verified address, and removing it would protect nothing.
 */
async function removedFromAccount(userId: string, username: string): Promise<boolean> {
  const last = await systemDb.authEvent.findFirst({
    where: { userId, type: { in: ["identity_removed", "identity_linked"] }, metadata: { path: ["cognitoUsername"], equals: cognitoUsernameKey(username) } },
    orderBy: { createdAt: "desc" },
    select: { type: true },
  });
  return last?.type === "identity_removed";
}

type NoticeUser = Pick<User, "id" | "email" | "timezone">;

/** When something happened, in the account's time zone (UTC if it isn't one Intl knows). */
function noticeTime(user: NoticeUser, at: Date) {
  const format = (timeZone: string) =>
    new Intl.DateTimeFormat("en", { year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZone, timeZoneName: "short" }).format(at);
  try {
    return format(user.timezone);
  } catch {
    return format("UTC");
  }
}

/** A security notice to the account's address. Plain text; best effort: a failure is logged and changes nothing. */
async function sendNotice(mailer: Mailer, user: NoticeUser, subject: string, lines: string[]) {
  const text = ["Hello,", "", ...lines, "", "bizinsights Team"].join("\n");
  await mailer.send(user.email, subject, text).catch((err: unknown) => logger.warn({ err, userId: user.id, subject }, "could not email a sign-in method's notice"));
}

/**
 * Tells the account's address that a new way to sign in was added from Settings (Google linked, a
 * password added). Whoever got into the account another way (a leaked password, a computer left
 * signed in) could otherwise add their own way back in unnoticed.
 */
export async function notifyMethodAdded(mailer: Mailer, user: NoticeUser, added: { method: SignInMethod; email: string | null }, at = new Date()) {
  const app = env().APP_URL;
  const google = added.method === "google";
  const what = google ? `Sign-in with the Google account ${added.email ?? "you chose"}` : "A password";
  await sendNotice(mailer, user, google ? "Google sign-in was added to your bizinsights account" : "A password was added to your bizinsights account", [
    `${what} was added to your bizinsights account (${user.email}) on ${noticeTime(user, at)}. ${google ? "That Google account can now sign in to your account." : "Your email address and that password can now sign in to your account."}`,
    "",
    "If this was you, there's nothing more to do.",
    "",
    "If it wasn't you, someone else may be signed in to your account:",
    `1. Reset your password (${app}/forgot-password). That signs everyone out.`,
    `2. Sign in and remove any way to sign in you don't recognise in Settings > Security (${app}/settings/security).`,
  ]);
}

/**
 * Tells the account's address that a way to sign in was removed (Settings → Security). Removing
 * the owner's own way in is how someone who got in would keep the account, so it is never silent.
 * `passwordLeft`: the account still has a password, whose reset signs everyone out.
 */
export async function notifyMethodRemoved(mailer: Mailer, user: NoticeUser, removed: { method: SignInMethod; email: string | null; passwordLeft: boolean }, at = new Date()) {
  const app = env().APP_URL;
  const google = removed.method === "google";
  const what = google ? `Sign-in with the Google account ${removed.email ?? "that was linked"}` : "Your password";
  await sendNotice(mailer, user, google ? "Google sign-in was removed from your bizinsights account" : "Your password was removed from your bizinsights account", [
    `${what} was removed from your bizinsights account (${user.email}) on ${noticeTime(user, at)}. It can't sign in to your account any more.`,
    "",
    "If this was you, there's nothing more to do.",
    "",
    "If it wasn't you, someone else may be signed in to your account:",
    removed.passwordLeft
      ? `1. Reset your password (${app}/forgot-password). That signs everyone out.`
      : `1. Sign in and choose "Sign out of all devices" in Settings > Security (${app}/settings/security).`,
    `2. Check the ways to sign in there, remove any you don't recognise, and contact us (${app}/support) if you can't get back in.`,
  ]);
}

/**
 * An account whose address was never verified meets a sign-in that verifies it: the verified one
 * takes the account over. Whoever set up the account's other sign-in methods never proved the
 * inbox (anyone can create an employee with someone's address and open the copied link
 * themselves), so those methods are removed in Cognito and here, and every session of the account
 * ends, before the new identity is linked. The same rule Firebase applies to unverified providers.
 *
 * What that person set up with the account is theirs, not the address's owner's, and goes too
 * (relinquishSetUp): otherwise the owner would inherit a workspace its maker can still read (an
 * API key, an admin they invited, its alert settings) and connect their store to it. What
 * workspace owners gave the address (an invitation's membership, an employee record) stays: it was
 * meant for the address's owner. An account with no sign-in yet (a Team & Access invitation's
 * placeholder) has nothing to remove, and nobody set anything up with it.
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
  const { updated, relinquished } = await systemDb.$transaction(async (tx) => {
    // Only these rows: a concurrent take-over may already have linked the new identity.
    if (prior.length) await tx.authIdentity.deleteMany({ where: { id: { in: prior.map((i) => i.id) } } });
    const relinquished = prior.length ? await relinquishSetUp(tx, user.id) : null;
    const updated = await tx.user.update({
      where: { id: user.id },
      data: {
        emailVerified: true,
        // The name the other person gave the account goes with them.
        ...(prior.length > 0 && { sessionsValidAfter: new Date(), displayName: claims.name?.slice(0, 80) ?? null }),
      },
    });
    return { updated, relinquished };
  });
  if (prior.length) {
    await recordAuthEvent("unverified_identity_removed", user.id, opts.ip ?? null, {
      removed: prior.map((i) => ({ cognitoSub: i.subject, method: i.method })),
      by: { cognitoSub: claims.sub, method: claims.method },
      ...relinquished,
    });
  }
  return updated;
}

/**
 * Undo what an account set up for itself while nobody had proved its address: the API keys it
 * made and the access and invitations it gave others are revoked, and it leaves the workspaces it
 * made or claimed (memberships nobody invited it to). Revoked, not deleted, so a workspace's other
 * owners can see and restore what changed. Memberships and employee records that others gave the
 * address stay.
 */
async function relinquishSetUp(tx: Tx, userId: string) {
  const now = new Date();
  const left = await tx.membership.findMany({ where: { userId, invitedById: null }, select: { workspaceId: true } });
  const keys = await tx.apiKey.updateMany({ where: { createdById: userId, revokedAt: null }, data: { revokedAt: now } });
  const invitations = await tx.invitation.updateMany({ where: { invitedById: userId, acceptedAt: null, revokedAt: null }, data: { revokedAt: now } });
  const members = await tx.membership.updateMany({ where: { invitedById: userId, revokedAt: null }, data: { revokedAt: now, accessChangedAt: now } });
  if (left.length) await tx.membership.deleteMany({ where: { userId, invitedById: null } });
  return { revokedApiKeys: keys.count, revokedInvitations: invitations.count, revokedMembers: members.count, leftWorkspaces: left.map((m) => m.workspaceId) };
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
 *    (takeOverUnverified). A Google account the user removed in Settings is refused
 *    (removedFromAccount) until they link it again there.
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
    // Settings) never renames the account. Nor is an account whose address nobody proved ever moved
    // to another: whatever others gave that address (an invitation, an employee record) would go
    // with whoever opened it, away from the address's owner (account.ts refuses those changes too).
    if (claims.emailVerified && user.emailVerified && email !== user.email && linked.email !== email && linked.email === user.email) data.email = email;
    // Verified only by a sign-in that proves the account's own address. A Google account linked
    // under another address proves that one, not this: counting it would let whoever opened an
    // unverified account (someone else's address) make it look proven, and keep it from the
    // address's owner (takeOverUnverified).
    if (claims.emailVerified && !user.emailVerified && (data.email ?? user.email) === email) data.emailVerified = true;
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
    await recordAuthEvent(reason, user.id, opts.ip ?? null, { cognitoSub: claims.sub, method: claims.method, cognitoUsername: cognitoUsernameKey(claims.username) });
    return user;
  };

  const sameEmail = await systemDb.user.findUnique({ where: { email }, include: { identities: true } });
  if (sameEmail) {
    if (!claims.emailVerified) throw emailTaken();
    // Removed in Settings: never linked back by its address alone. (A password comes back only
    // through a sign-up code to the address, which proves it again.)
    if (claims.method !== "password" && (await removedFromAccount(sameEmail.id, claims.username))) throw removedMethod();
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

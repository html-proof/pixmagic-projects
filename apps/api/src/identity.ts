import { systemDb, type AuthIdentity, type Tx, type User } from "@app/db";
import { env, logger, type Mailer } from "@app/core";
import { revokeZapierGrants } from "@app/core/zapier";
import { maskEmail } from "@app/shared/email";
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

const otherGoogleLinked = () =>
  new HttpError(
    409,
    "Your bizinsights account with this email address already signs in with a different Google account. Continue with that Google account, or sign in with your password.",
    "google_other_linked",
  );

/**
 * Continue with Google with a Google account new to bizinsights, whose address is an existing
 * account's that has ways in of its own. Google's word for the address doesn't prove the account
 * is this person's (a work address given to someone new, a Google account made with the address
 * years ago), and joining them by it would skip the account's own checks (its two-step
 * verification). auth.ts holds the Google account until this browser signs in to that account
 * (holdForLink); nothing is linked or created before then.
 */
export class LinkRequired extends Error {
  constructor(
    readonly account: Pick<User, "id" | "email">,
    readonly claims: IdentityClaims,
  ) {
    super("sign in to the existing account to link this Google account");
  }
}

/**
 * Whether a sign-in with `account`'s address must prove the account before joining it: the
 * account has a way in already, and none is this same Google account. (Cognito makes a Google
 * user again, with a new sub but the same user name, once its user was deleted.)
 */
const needsProof = (account: { identities: AuthIdentity[] }, claims: IdentityClaims) =>
  account.identities.length > 0 && !account.identities.some((i) => cognitoUsernameKey(i.username) === cognitoUsernameKey(claims.username));

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
  await mailer.send(user.email, subject, text).catch((err: unknown) => logger.warn({ err, userId: user.id, subject }, "could not email a security notice"));
}

/**
 * Tells the account's OLD address that the account moved to another one (Settings → Security).
 * Whoever has the password and a session could otherwise take the account to their own inbox
 * unnoticed, after which "Forgot password?" goes to them too. `user` is the account as it was.
 */
export async function notifyEmailChanged(mailer: Mailer, user: NoticeUser, newEmail: string, at = new Date()) {
  const app = env().APP_URL;
  await sendNotice(mailer, user, "The email address of your bizinsights account was changed", [
    `The email address of your bizinsights account was changed from ${user.email} to ${maskEmail(newEmail)} on ${noticeTime(user, at)}. Signing in, password resets and our emails now use the new address, and every other device was signed out.`,
    "",
    "If this was you, there's nothing more to do.",
    "",
    "If it wasn't you, someone else knows your password and was signed in to your account. A password reset now goes to the new address, so:",
    `1. Contact us right away (${app}/support), from this address, and we'll help you get the account back.`,
    "2. Change the password of this email account too, in case that is how they got in.",
  ]);
}

/**
 * Tells the account's address that its password was changed (Settings → Security) or reset (a
 * code to the address). Either one signs every other device out, so it should never be news.
 */
export async function notifyPasswordChanged(mailer: Mailer, user: NoticeUser, how: "changed" | "reset", at = new Date()) {
  const app = env().APP_URL;
  const reset = how === "reset";
  await sendNotice(mailer, user, reset ? "Your bizinsights password was reset" : "Your bizinsights password was changed", [
    reset
      ? `The password of your bizinsights account (${user.email}) was reset with a code sent to this address on ${noticeTime(user, at)}. Every device signed in to the account was signed out.`
      : `The password of your bizinsights account (${user.email}) was changed on ${noticeTime(user, at)}. Every other device was signed out.`,
    "",
    "If this was you, there's nothing more to do.",
    "",
    reset
      ? "If it wasn't you, someone else can read this inbox:"
      : "If it wasn't you, someone else knew your password and was signed in to your account:",
    reset ? "1. Change the password of this email account first." : `1. Reset your password (${app}/forgot-password). That signs everyone out.`,
    reset
      ? `2. Then reset your bizinsights password again (${app}/forgot-password), and check the ways to sign in in Settings > Security (${app}/settings/security).`
      : `2. Sign in and check the ways to sign in in Settings > Security (${app}/settings/security), removing any you don't recognise.`,
  ]);
}

/**
 * Tells the account's address that two-step verification was turned on or off. Turning it off
 * leaves the password alone between someone and the account; turning it on with someone else's
 * authenticator app would lock the owner out.
 */
export async function notifyTwoStepChanged(mailer: Mailer, user: NoticeUser, enabled: boolean, at = new Date()) {
  const app = env().APP_URL;
  await sendNotice(mailer, user, enabled ? "Two-step verification was turned on for your bizinsights account" : "Two-step verification was turned off for your bizinsights account", [
    enabled
      ? `Two-step verification was turned on for your bizinsights account (${user.email}) on ${noticeTime(user, at)}. Signing in now asks for a code from the authenticator app it was set up with.`
      : `Two-step verification was turned off for your bizinsights account (${user.email}) on ${noticeTime(user, at)}. Signing in now asks for the password only.`,
    "",
    "If this was you, there's nothing more to do.",
    "",
    "If it wasn't you, someone else knows your password and was signed in to your account:",
    `1. Reset your password (${app}/forgot-password). That signs everyone out.`,
    enabled
      ? `2. If the next sign-in asks for a code you can't get, contact us (${app}/support).`
      : `2. Sign in and turn two-step verification back on in Settings > Security (${app}/settings/security).`,
  ]);
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
 * ends, before the new identity is linked.
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
  // Zapier connections it allowed, like its API keys (docs/zapier.md).
  const zapier = await revokeZapierGrants({ userId }, "account_taken_over", tx, now);
  return { revokedApiKeys: keys.count, revokedInvitations: invitations.count, revokedMembers: members.count, revokedZapierConnections: zapier, leftWorkspaces: left.map((m) => m.workspaceId) };
}

type PictureClaims = Pick<IdentityClaims, "method" | "email" | "picture">;

/**
 * The picture a Google sign-in brings the account (users.avatar_url), or null for no change: a
 * Google account under the account's own address keeps it current; any other only fills it while
 * the account has none.
 */
function pictureFor(user: Pick<User, "avatarUrl">, claims: PictureClaims, ownAddress: boolean): string | null {
  if (claims.method !== "google" || !claims.picture || claims.picture === user.avatarUrl) return null;
  return ownAddress || !user.avatarUrl ? claims.picture : null;
}

/** `user` with the picture a Google account just linked to it brings (pictureFor). Best effort: never fails the sign-in. */
export async function withPicture(user: User, claims: PictureClaims): Promise<User> {
  const picture = pictureFor(user, claims, claims.email?.toLowerCase() === user.email);
  if (!picture) return user;
  return systemDb.user.update({ where: { id: user.id }, data: { avatarUrl: picture } }).catch((err: unknown) => {
    logger.warn({ err, userId: user.id }, "could not keep the account's picture");
    return user;
  });
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
 *    (removedFromAccount) until they link it again there. A Google account new to an account
 *    with ways in of its own is never linked by its address alone: LinkRequired, and the person
 *    signs in to the account once first (auth.ts). One Google account per account, as in
 *    Settings: an account that has another is refused (google_other_linked).
 * 3. Nobody: a new user, made from the verified identity (name, address, picture). Not from a
 *    Google account whose address Google hasn't verified: such an account could never verify it
 *    here (Google's tokens can't ask Cognito for a code).
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
    const data: { email?: string; emailVerified?: boolean; avatarUrl?: string } = {};
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
    const picture = pictureFor(user, claims, (data.email ?? user.email) === email);
    if (picture) data.avatarUrl = picture;
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
    return withPicture(user, claims);
  };

  const sameEmail = await systemDb.user.findUnique({ where: { email }, include: { identities: true } });
  if (sameEmail) {
    if (!claims.emailVerified) throw emailTaken();
    // Removed in Settings: never linked back by its address alone. (A password comes back only
    // through a sign-up code to the address, which proves it again.)
    if (claims.method !== "password" && (await removedFromAccount(sameEmail.id, claims.username))) throw removedMethod();
    if (!sameEmail.emailVerified) return link(await takeOverUnverified(sameEmail, claims, opts), "identity_linked");
    if (claims.method !== "password" && needsProof(sameEmail, claims)) {
      if (sameEmail.identities.some((i) => i.method === claims.method)) throw otherGoogleLinked();
      throw new LinkRequired(sameEmail, claims);
    }
    return link(sameEmail, "identity_linked");
  }

  if (!claims.emailVerified && claims.method !== "password") throw providerEmailUnverified();

  try {
    const created = await systemDb.user.create({
      data: {
        email,
        emailVerified: claims.emailVerified,
        displayName: claims.name?.slice(0, 80) ?? null,
        avatarUrl: claims.picture ?? null,
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

import { systemDb, withTenant, type Invitation, type Tx, type User } from "@app/db";
import { ACCESS_MODULE_INFO, decrypt, encrypt, hasFullAccess, modulesOf, randomToken, ROLE_INFO, sha256Hex, type Role } from "@app/shared";
import type { StaffRole } from "@app/shared/staff";
import { logger } from "../logger.js";
import { attemptDelivery, deliveryRetryDelaySec, startDelivery } from "../mail/deliveries.js";
import type { DeliveryStatus } from "../mail/types.js";
import type { Mailer } from "../notify.js";
import type { Queues } from "../queues.js";
import { keyring } from "../tokens.js";
import { accessFingerprint, checkAssignment, lockTeam, maskEmail, memberState, normalizeEmail, TeamError, type AssignableRole, type TeamActor } from "./common.js";
import { teamInvitationEmail, teamInvitationUrl } from "./email.js";

/**
 * Invitations to a workspace (Team & Access). The link carries a random 256-bit token; only its
 * SHA-256 is looked up, and the token itself is kept only encrypted with the app's keyring (so an
 * owner or admin can copy the same link again), so a copy of the database can't be turned into
 * working links.
 *
 * The link is the way in (POST /invitations/open: no account, password or sign-up) and keeps opening
 * the shared dashboard, on any device, until the invitation's end date: 60 days unless the inviter
 * chose less, extended only when an owner or admin renews it. The access it gives ends then too
 * (memberships.access_expires_at). Revoking or removing the member ends both at once. A resend sends
 * the same link again; "Replace link" issues a new one and the old one stops working.
 */

export const INVITE_DAYS_DEFAULT = 60;
export const INVITE_DAYS_MAX = 60;
export const INVITE_MESSAGE_MAX = 500;
const DAY_MS = 86_400_000;

export type InvitationStatus = "pending" | "accepted" | "revoked" | "expired";

export function invitationStatus(i: Pick<Invitation, "acceptedAt" | "revokedAt" | "expiresAt">, now = new Date()): InvitationStatus {
  if (i.acceptedAt) return "accepted";
  if (i.revokedAt) return "revoked";
  return i.expiresAt <= now ? "expired" : "pending";
}

export interface InviteInput {
  email: string;
  role: AssignableRole;
  permissions: readonly string[];
  staffRole?: StaffRole | null;
  message?: string | null;
  /** How long the link and the access it gives last: 1 to 60 days; 60 when not given. */
  expiresInDays?: number;
}

/** What sending an invitation needs: the mail provider, and the email queue for retries (absent in some tests). */
export interface InviteMail {
  mailer: Mailer;
  queues?: Pick<Queues, "email">;
}

/**
 * The inviter's note: plain text, at most 500 characters, and no links. Every invitation is an email
 * from our domain, and a link in a note written by anyone with a workspace would make it a ready
 * phishing mail; the email carries its own button to the invitation.
 */
export function cleanInviteMessage(message: string | null | undefined): string | null {
  // Control characters (other than line breaks and tabs) have no place in a note.
  const text = (message ?? "").replace(/[^\P{Cc}\n\t]/gu, "").trim();
  if (!text) return null;
  if (text.length > INVITE_MESSAGE_MAX) throw new TeamError(400, "message_too_long", `Keep the message under ${INVITE_MESSAGE_MAX} characters.`);
  if (/https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|co|app|xyz|info|biz|link|ly)\b\/?/i.test(text)) {
    throw new TeamError(400, "message_has_link", "Leave links out of the message: the email already has the button to accept.");
  }
  return text;
}

function daysFrom(now: Date, days: number | undefined): Date {
  const d = days ?? INVITE_DAYS_DEFAULT;
  if (!Number.isInteger(d) || d < 1 || d > INVITE_DAYS_MAX) throw new TeamError(400, "invalid_expiry", `Access can last from 1 to ${INVITE_DAYS_MAX} days.`);
  return new Date(now.getTime() + d * DAY_MS);
}

/** The token, encrypted for this invitation only (AAD), so the same link can be copied again. */
const sealToken = (invitationId: string, token: string) => encrypt(token, keyring(), `invitation-link:${invitationId}`);

function unsealToken(inv: Pick<Invitation, "id" | "tokenSealed">): string | null {
  if (!inv.tokenSealed) return null;
  try {
    return decrypt(inv.tokenSealed, keyring(), `invitation-link:${inv.id}`);
  } catch (err) {
    logger.error({ err, invitationId: inv.id }, "an invitation's link could not be decrypted");
    return null;
  }
}

/** Someone already in the workspace (or revoked from it) is never invited again: their access is changed, renewed or restored instead. */
async function assertNotMember(tx: Tx, workspaceId: string, email: string) {
  const member = await tx.membership.findFirst({ where: { workspaceId, user: { email: { equals: email, mode: "insensitive" } } }, select: { revokedAt: true, accessExpiresAt: true } });
  if (!member) return;
  const state = memberState(member);
  if (state === "revoked") throw new TeamError(409, "member_revoked", `${email} was in this workspace and their access is revoked. Restore their access from the team list instead.`);
  if (state === "expired") throw new TeamError(409, "member_expired", `${email}'s access has ended. Renew their access from the team list instead.`);
  throw new TeamError(409, "already_member", `${email} is already in this workspace. Change their access from the team list instead.`);
}

/**
 * Why an invitation email didn't go out, in a word the invite panel can explain: `not_allowed` when
 * the mail service won't send to this recipient from our account as configured (Amazon SES's
 * sandbox, which sends only to addresses verified in SES; a sending domain not verified with the
 * provider), `failed` for anything else (a bad address, an outage that outlasted the retries).
 */
export type EmailProblem = "not_allowed" | "failed";

export interface DeliveryReport {
  emailed: boolean;
  /** The delivery's status right after sending: "sent" (accepted by the provider), "queued" (retrying), "failed" or "not_allowed". */
  status: DeliveryStatus;
  problem?: EmailProblem;
  url: string;
}

/**
 * Email an invitation's link and record it (email_deliveries). A transient failure is tried again
 * now, then from the email queue with backoff; the invitation is never lost to a mail failure, and
 * the inviter gets the link to pass on whenever it didn't go out.
 */
async function deliver(invitation: Invitation, token: string, mail: InviteMail): Promise<DeliveryReport> {
  const url = teamInvitationUrl(token);
  let status: DeliveryStatus;
  try {
    const message = await invitationMessage(invitation, url);
    const delivery = await startDelivery({ workspaceId: invitation.workspaceId, invitationId: invitation.id, kind: "team_invitation" });
    const outcome = await attemptDelivery(mail.mailer, delivery, message);
    status = outcome.status === "queued" ? await queueRetry(delivery.id, outcome.attempts, mail) : outcome.status;
  } catch (err) {
    // The database, not the mail: say it didn't go out, and hand the link over.
    logger.error({ err, invitationId: invitation.id }, "invitation email could not be prepared");
    status = "failed";
  }
  await recordOutcome(invitation.id, status);
  return { emailed: status === "sent", status, url, ...(status === "not_allowed" ? { problem: "not_allowed" as const } : status === "failed" ? { problem: "failed" as const } : {}) };
}

/** Another attempt from the email queue later; a delivery that can't be queued is given up as failed. */
async function queueRetry(deliveryId: string, attempts: number, mail: InviteMail): Promise<DeliveryStatus> {
  try {
    if (!mail.queues) throw new Error("no email queue in this environment");
    await mail.queues.email.send({ kind: "team_invitation", deliveryId }, { delaySeconds: deliveryRetryDelaySec(attempts) });
    return "queued";
  } catch (err) {
    logger.error({ err, deliveryId }, "could not queue an invitation email for another attempt");
    await systemDb.emailDelivery.update({ where: { id: deliveryId }, data: { status: "failed" } }).catch(() => {});
    return "failed";
  }
}

/** The invitation's own record of its last email (the team list's "Sent" and "Not delivered" before delivery records). */
async function recordOutcome(invitationId: string, status: DeliveryStatus) {
  if (status === "queued") return;
  const now = new Date();
  await systemDb.invitation
    .update({ where: { id: invitationId }, data: status === "sent" ? { sentAt: now, sendCount: { increment: 1 } } : { sendFailedAt: now } })
    .catch((err: unknown) => logger.warn({ err, invitationId }, "could not record the invitation email's outcome"));
}

/** The invitation email, in the inviter's time zone, with replies going to them. */
async function invitationMessage(invitation: Invitation, url: string) {
  const [workspace, inviter] = await Promise.all([
    systemDb.workspace.findUnique({ where: { id: invitation.workspaceId }, select: { name: true } }),
    invitation.invitedById ? systemDb.user.findUnique({ where: { id: invitation.invitedById }, select: { displayName: true, email: true, timezone: true } }) : null,
  ]);
  const mail = teamInvitationEmail({
    workspace: workspace?.name ?? "a bizinsights workspace",
    inviter: inviter ? { name: inviter.displayName, email: inviter.email } : null,
    role: invitation.role,
    permissions: invitation.permissions,
    message: invitation.message,
    url,
    expiresAt: invitation.expiresAt,
    timezone: inviter?.timezone ?? "UTC",
  });
  // Replies reach the person who invited them (EMAIL_FROM is a no-reply address).
  return { to: invitation.email, subject: mail.subject, text: mail.text, html: mail.html, opts: inviter ? { replyTo: inviter.email } : undefined };
}

/**
 * Another attempt at an invitation email that hit a transient failure (the email queue's
 * "team_invitation" job). Sends nothing for an invitation that has since ended or been replaced
 * (its link would be a dead one), and gives up after MAX_DELIVERY_ATTEMPTS.
 */
export async function retryInvitationEmail(deliveryId: string, mail: InviteMail): Promise<DeliveryStatus | "skipped"> {
  const d = await systemDb.emailDelivery.findUnique({ where: { id: deliveryId }, include: { invitation: true } });
  if (!d || d.status !== "queued") return "skipped";
  const inv = d.invitation;
  const token = inv ? unsealToken(inv) : null;
  const usable = inv && token && sha256Hex(token) === inv.tokenHash && !inv.revokedAt && inv.expiresAt > new Date();
  if (!usable) {
    await systemDb.emailDelivery.update({ where: { id: d.id }, data: { status: "failed", errorCode: "invitation_ended", errorMessage: "The invitation ended or its link was replaced before the email could be sent." } });
    return "failed";
  }
  const outcome = await attemptDelivery(mail.mailer, d, await invitationMessage(inv, teamInvitationUrl(token)), 1);
  const status = outcome.status === "queued" ? await queueRetry(d.id, outcome.attempts, mail) : outcome.status;
  await recordOutcome(inv.id, status);
  return status;
}

/**
 * Invite someone. Checked first: who may grant what (`checkAssignment`), the address isn't in the
 * team already, the note. A pending invitation to the same address is replaced (its link stops
 * working), all under the team lock, so two owners inviting the same person at once leave one
 * invitation. The email goes out after the invitation is saved.
 */
export async function createTeamInvitation(actor: TeamActor, input: InviteInput, mail: InviteMail) {
  const email = normalizeEmail(input.email);
  const access = checkAssignment(actor, input);
  const message = cleanInviteMessage(input.message);
  const now = new Date();
  const expiresAt = daysFrom(now, input.expiresInDays);
  const token = randomToken(32);
  const { invitation, replaced } = await withTenant(actor.workspaceId, async (tx) => {
    await lockTeam(tx, actor.workspaceId);
    await assertNotMember(tx, actor.workspaceId, email);
    const old = await tx.invitation.updateMany({
      where: { workspaceId: actor.workspaceId, email, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
      data: { revokedAt: now },
    });
    const created = await tx.invitation.create({
      data: { workspaceId: actor.workspaceId, email, ...access, message, tokenHash: sha256Hex(token), expiresAt, invitedById: actor.userId },
    });
    const invitation = await tx.invitation.update({ where: { id: created.id }, data: { tokenSealed: sealToken(created.id, token) } });
    await tx.auditLog.create({
      data: {
        workspaceId: actor.workspaceId,
        actorUserId: actor.userId,
        action: "member.invited",
        targetType: "invitation",
        targetId: invitation.id,
        metadata: { email, role: access.role, permissions: access.permissions, staffRole: access.staffRole, expiresAt: expiresAt.toISOString(), replaced: old.count, message: message !== null },
        ip: actor.ip,
      },
    });
    return { invitation, replaced: old.count };
  });
  const sent = await deliver(invitation, token, mail);
  return {
    invitationId: invitation.id,
    emailed: sent.emailed,
    delivery: sent.status,
    // The link only when the email didn't go out (it can be copied from the team list any time).
    url: sent.emailed || sent.status === "queued" ? undefined : sent.url,
    emailProblem: sent.problem,
    replaced,
    expiresAt,
  };
}

/** An invitation of this workspace, or 404. */
async function findInvitation(tx: Tx, actor: TeamActor, id: string) {
  const inv = await tx.invitation.findFirst({ where: { id, workspaceId: actor.workspaceId } });
  if (!inv) throw new TeamError(404, "not_found", "That invitation wasn't found. It may have been removed already.");
  return inv;
}

async function pendingInvitation(tx: Tx, actor: TeamActor, id: string) {
  const inv = await findInvitation(tx, actor, id);
  const status = invitationStatus(inv);
  if (status === "accepted") throw new TeamError(409, "already_accepted", `${inv.email} has already accepted this invitation. Change their access from the team list.`);
  if (status === "revoked") throw new TeamError(409, "invitation_revoked", "This invitation was cancelled. Send a new one instead.");
  return { inv, status };
}

/**
 * An invitation whose link an owner or admin may still send or copy: one not yet accepted (pending
 * or expired), or accepted by someone whose access is still active (the link keeps opening the
 * dashboard for them). Cancelled ones and members revoked or removed are refused.
 */
async function linkInvitation(tx: Tx, actor: TeamActor, id: string) {
  const inv = await findInvitation(tx, actor, id);
  const status = invitationStatus(inv);
  if (status === "revoked") throw new TeamError(409, "invitation_revoked", "This invitation was cancelled. Send a new one instead.");
  if (status === "accepted") {
    const m = inv.acceptedById ? await tx.membership.findUnique({ where: { workspaceId_userId: { workspaceId: inv.workspaceId, userId: inv.acceptedById } } }) : null;
    if (!m) throw new TeamError(409, "member_removed", `${inv.email} is no longer in this workspace. Invite them again instead.`);
    const state = memberState(m);
    if (state === "revoked") throw new TeamError(409, "member_revoked", `${inv.email}'s access is revoked. Restore it first.`);
    if (state === "expired" || inv.expiresAt <= new Date()) throw new TeamError(409, "link_expired", `${inv.email}'s access has ended. Renew it first.`);
  }
  return { inv, status };
}

/**
 * Send an invitation's email again. Its link stays the same (one already opened keeps working);
 * an invitation from before links were kept, or one an owner asks to replace, gets a new link
 * and the old one stops working. An expired invitation not yet accepted is renewed for as long as
 * it was first given (at most 60 days).
 */
export async function resendTeamInvitation(actor: TeamActor, id: string, mail: InviteMail) {
  if (!hasFullAccess(actor.role)) throw new TeamError(403, "forbidden", "Only owners and admins can manage the team.");
  const fresh = randomToken(32);
  const { invitation, token } = await withTenant(actor.workspaceId, async (tx) => {
    await lockTeam(tx, actor.workspaceId);
    const { inv, status } = await linkInvitation(tx, actor, id);
    if (status !== "accepted") await assertNotMember(tx, actor.workspaceId, inv.email);
    const kept = unsealToken(inv);
    const token = kept && sha256Hex(kept) === inv.tokenHash ? kept : fresh;
    const lifetime = Math.min(INVITE_DAYS_MAX * DAY_MS, Math.max(DAY_MS, inv.expiresAt.getTime() - inv.createdAt.getTime()));
    const updated = await tx.invitation.update({
      where: { id: inv.id },
      data: {
        ...(token === fresh ? { tokenHash: sha256Hex(fresh), tokenSealed: sealToken(inv.id, fresh) } : {}),
        ...(status === "expired" ? { expiresAt: new Date(Date.now() + lifetime) } : {}),
      },
    });
    await tx.auditLog.create({
      data: { workspaceId: actor.workspaceId, actorUserId: actor.userId, action: "member.invitation_resent", targetType: "invitation", targetId: inv.id, metadata: { email: inv.email, newLink: token === fresh, renewed: status === "expired" }, ip: actor.ip },
    });
    return { invitation: updated, token };
  });
  const sent = await deliver(invitation, token, mail);
  return { emailed: sent.emailed, delivery: sent.status, url: sent.emailed || sent.status === "queued" ? undefined : sent.url, emailProblem: sent.problem, expiresAt: invitation.expiresAt };
}

/** The invitation's link, to copy and pass on (owners and admins). Recorded in the audit log. */
export async function invitationLink(actor: TeamActor, id: string): Promise<{ url: string; expiresAt: Date }> {
  if (!hasFullAccess(actor.role)) throw new TeamError(403, "forbidden", "Only owners and admins can manage the team.");
  return withTenant(actor.workspaceId, async (tx) => {
    const { inv, status } = await linkInvitation(tx, actor, id);
    if (status === "expired") throw new TeamError(409, "link_expired", "This invitation has expired. Renew it first, then copy its link.");
    const token = unsealToken(inv);
    if (!token || sha256Hex(token) !== inv.tokenHash) {
      throw new TeamError(409, "link_not_kept", "This invitation was sent before links could be copied again. Use \"Replace link\" to get a new one (the old link stops working).");
    }
    await tx.auditLog.create({
      data: { workspaceId: actor.workspaceId, actorUserId: actor.userId, action: "member.invitation_link_copied", targetType: "invitation", targetId: inv.id, metadata: { email: inv.email }, ip: actor.ip },
    });
    return { url: teamInvitationUrl(token), expiresAt: inv.expiresAt };
  });
}

/**
 * Give an invitation a new link: the old one stops opening the dashboard at once (for when a link
 * went somewhere it shouldn't). Sessions already opened from the old link carry on while the access
 * lasts: revoke the member to end those.
 */
export async function replaceInvitationLink(actor: TeamActor, id: string): Promise<{ url: string; expiresAt: Date }> {
  if (!hasFullAccess(actor.role)) throw new TeamError(403, "forbidden", "Only owners and admins can manage the team.");
  const token = randomToken(32);
  return withTenant(actor.workspaceId, async (tx) => {
    await lockTeam(tx, actor.workspaceId);
    const { inv, status } = await linkInvitation(tx, actor, id);
    if (status === "expired") throw new TeamError(409, "link_expired", "This invitation has expired. Renew it first.");
    const updated = await tx.invitation.update({ where: { id: inv.id }, data: { tokenHash: sha256Hex(token), tokenSealed: sealToken(inv.id, token) } });
    await tx.auditLog.create({
      data: { workspaceId: actor.workspaceId, actorUserId: actor.userId, action: "member.invitation_link_replaced", targetType: "invitation", targetId: inv.id, metadata: { email: inv.email }, ip: actor.ip },
    });
    return { url: teamInvitationUrl(token), expiresAt: updated.expiresAt };
  });
}

/** Cancel an invitation not yet accepted: its link stops working at once. Cancelling one already cancelled is a no-op. */
export async function revokeTeamInvitation(actor: TeamActor, id: string) {
  if (!hasFullAccess(actor.role)) throw new TeamError(403, "forbidden", "Only owners and admins can manage the team.");
  await withTenant(actor.workspaceId, async (tx) => {
    await lockTeam(tx, actor.workspaceId);
    const inv = await findInvitation(tx, actor, id);
    if (inv.acceptedAt) throw new TeamError(409, "already_accepted", `${inv.email} has already joined. Revoke their access from the team list instead.`);
    if (inv.revokedAt) return;
    await tx.invitation.update({ where: { id: inv.id }, data: { revokedAt: new Date() } });
    await tx.auditLog.create({
      data: { workspaceId: actor.workspaceId, actorUserId: actor.userId, action: "member.invitation_revoked", targetType: "invitation", targetId: inv.id, metadata: { email: inv.email }, ip: actor.ip },
    });
  });
}

/** Change what an invitation not yet accepted will give. The link stays the same. */
export async function updateTeamInvitation(actor: TeamActor, id: string, input: { role: AssignableRole; permissions: readonly string[]; staffRole?: StaffRole | null }) {
  const next = checkAssignment(actor, input);
  await withTenant(actor.workspaceId, async (tx) => {
    await lockTeam(tx, actor.workspaceId);
    const { inv, status } = await pendingInvitation(tx, actor, id);
    if (status === "expired") throw new TeamError(409, "invitation_expired", "This invitation has expired. Renew it, then change it.");
    await tx.invitation.update({ where: { id: inv.id }, data: next });
    await tx.auditLog.create({
      data: {
        workspaceId: actor.workspaceId,
        actorUserId: actor.userId,
        action: "member.invitation_updated",
        targetType: "invitation",
        targetId: inv.id,
        metadata: { email: inv.email, previous: { role: inv.role, permissions: inv.permissions, staffRole: inv.staffRole }, updated: next },
        ip: actor.ip,
      },
    });
  });
}

/**
 * Renew shared access for `days` (1 to 60, 60 by default) from now: an invitation not yet accepted
 * (pending or expired) keeps its link, which now works until the new date; a member who joined from
 * an invitation gets their access, and their link, until then. Only owners and admins renew, and
 * only access that has an end date (members with none keep none).
 */
export async function renewTeamAccess(actor: TeamActor, target: { invitationId?: string; memberId?: string }, days = INVITE_DAYS_DEFAULT): Promise<{ expiresAt: Date }> {
  if (!hasFullAccess(actor.role)) throw new TeamError(403, "forbidden", "Only owners and admins can manage the team.");
  const until = daysFrom(new Date(), days);
  return withTenant(actor.workspaceId, async (tx) => {
    await lockTeam(tx, actor.workspaceId);
    if (target.invitationId) {
      const inv = await findInvitation(tx, actor, target.invitationId);
      if (inv.revokedAt) throw new TeamError(409, "invitation_revoked", "This invitation was cancelled. Send a new one instead.");
      if (inv.acceptedAt) throw new TeamError(409, "already_accepted", `${inv.email} has joined: renew their access from their row instead.`);
      await tx.invitation.update({ where: { id: inv.id }, data: { expiresAt: until } });
      await tx.auditLog.create({
        data: { workspaceId: actor.workspaceId, actorUserId: actor.userId, action: "member.invitation_renewed", targetType: "invitation", targetId: inv.id, metadata: { email: inv.email, previous: inv.expiresAt.toISOString(), expiresAt: until.toISOString() }, ip: actor.ip },
      });
      return { expiresAt: until };
    }
    const m = await tx.membership.findFirst({ where: { id: target.memberId ?? "", workspaceId: actor.workspaceId }, include: { user: { select: { email: true } } } });
    if (!m) throw new TeamError(404, "not_found", "That member wasn't found. They may have been removed already.");
    if (m.revokedAt) throw new TeamError(409, "member_revoked", `${m.user.email}'s access is revoked. Restore it first.`);
    // Their link keeps opening the dashboard until the same date. A member whose access has no end
    // date (from before invitations ended) keeps none: only their link is renewed.
    const links = await tx.invitation.updateMany({ where: { workspaceId: actor.workspaceId, acceptedById: m.userId, revokedAt: null }, data: { expiresAt: until } });
    if (!m.accessExpiresAt && !links.count) throw new TeamError(409, "no_end_date", `${m.user.email}'s access has no end date and no link: there is nothing to renew.`);
    if (m.accessExpiresAt) await tx.membership.update({ where: { id: m.id }, data: { accessExpiresAt: until, accessChangedAt: new Date() } });
    await tx.auditLog.create({
      data: { workspaceId: actor.workspaceId, actorUserId: actor.userId, action: "member.access_renewed", targetType: "member", targetId: m.id, metadata: { targetUserId: m.userId, previous: m.accessExpiresAt?.toISOString() ?? null, expiresAt: until.toISOString(), linkOnly: !m.accessExpiresAt }, ip: actor.ip },
    });
    return { expiresAt: until };
  });
}

// ---------------------------------------------------------------------------
// The invitee's side
// ---------------------------------------------------------------------------

export interface InvitationPreview {
  status: InvitationStatus | "invalid";
  workspace?: string;
  inviter?: string | null;
  role?: Role;
  roleLabel?: string;
  /** The areas they'll see, by name. */
  modules?: string[];
  permissionCount?: number;
  message?: string | null;
  expiresAt?: string;
  /** The invited address, partly hidden: anyone holding the link sees this page. */
  email?: string;
  /** Accepted already, and the link still opens the dashboard. */
  reopens?: boolean;
}

/**
 * What the invitation page shows before the dashboard opens: whose dashboard, from whom, what they'll
 * see, until when. A link that isn't one says only that. Ended invitations still say whose they
 * were, so the person knows whom to ask for a new one.
 */
export async function previewTeamInvitation(token: string): Promise<InvitationPreview> {
  const inv = await systemDb.invitation.findUnique({
    where: { tokenHash: sha256Hex(token) },
    include: { workspace: { select: { name: true } }, invitedBy: { select: { displayName: true, email: true } } },
  });
  if (!inv) return { status: "invalid" };
  const status = invitationStatus(inv);
  const inviter = inv.invitedBy ? (inv.invitedBy.displayName ?? inv.invitedBy.email) : null;
  // Used already, and still opening the dashboard: what the member has now, which an owner may have changed since.
  const member = status === "accepted" ? await reopenableMember(inv) : null;
  if (status !== "pending" && !member) return { status, workspace: inv.workspace.name, inviter };
  const access = member ?? inv;
  const until = member?.accessExpiresAt && member.accessExpiresAt < inv.expiresAt ? member.accessExpiresAt : inv.expiresAt;
  return {
    status,
    reopens: !!member,
    workspace: inv.workspace.name,
    inviter,
    role: access.role,
    roleLabel: ROLE_INFO[access.role].label,
    modules: hasFullAccess(access.role) ? ["Everything in the workspace"] : modulesOf(access).map((m) => ACCESS_MODULE_INFO[m].label),
    permissionCount: access.permissions.length,
    message: inv.message,
    expiresAt: until.toISOString(),
    email: maskEmail(inv.email),
  };
}

/**
 * For an accepted invitation: the membership its link still opens (the invitation's end date not
 * passed, the member's access neither revoked, ended nor removed), else null.
 */
async function reopenableMember(inv: Pick<Invitation, "acceptedAt" | "acceptedById" | "workspaceId" | "expiresAt" | "revokedAt">, now = new Date()) {
  if (!inv.acceptedAt || !inv.acceptedById || inv.revokedAt || inv.expiresAt <= now) return null;
  const m = await systemDb.membership.findUnique({
    where: { workspaceId_userId: { workspaceId: inv.workspaceId, userId: inv.acceptedById } },
    select: { userId: true, role: true, permissions: true, revokedAt: true, accessExpiresAt: true },
  });
  return m && memberState(m, now) === "active" ? m : null;
}

const ENDED: Record<Exclude<InvitationStatus, "pending">, string> = {
  accepted: "This invitation link no longer opens the dashboard. Ask the person who shared it with you for a new invitation.",
  revoked: "This invitation was cancelled. Ask the person who invited you for a new one.",
  expired: "This invitation has expired. Ask the person who invited you to renew it.",
};

/**
 * The invitation a link carries, for POST /invitations/open: who it's for, its status, and for one
 * accepted already, the member it still opens the dashboard for (`reopenUserId`, null once it no
 * longer does). Null for a link that isn't one.
 */
export async function invitationForLink(token: string) {
  const inv = await systemDb.invitation.findUnique({
    where: { tokenHash: sha256Hex(token) },
    select: { id: true, email: true, workspaceId: true, acceptedAt: true, acceptedById: true, revokedAt: true, expiresAt: true },
  });
  if (!inv) return null;
  const status = invitationStatus(inv);
  const member = status === "accepted" ? await reopenableMember(inv) : null;
  return { ...inv, status, reopenUserId: member?.userId ?? null, accessExpiresAt: member?.accessExpiresAt ?? null };
}

/** The link opened the dashboard: counted on the invitation and kept in the audit log (with the address it came from). */
export async function recordLinkOpened(inv: { id: string; workspaceId: string; email: string }, userId: string, ip?: string) {
  await systemDb.invitation.update({ where: { id: inv.id }, data: { lastOpenedAt: new Date(), openCount: { increment: 1 } } }).catch((err: unknown) => logger.warn({ err, invitationId: inv.id }, "could not count an invitation link's opening"));
  await systemDb.auditLog
    .create({ data: { workspaceId: inv.workspaceId, actorUserId: userId, action: "member.link_opened", targetType: "invitation", targetId: inv.id, metadata: { email: inv.email }, ip } })
    .catch((err: unknown) => logger.warn({ err, invitationId: inv.id }, "could not record an invitation link's opening"));
}

/**
 * Accept an invitation as `user`. The invitation is claimed with one conditional update (not
 * accepted, not cancelled, not expired), so of two tabs accepting at once exactly one wins. Joining
 * makes the membership with the invitation's access, ending when the invitation does; someone whose
 * access was revoked or had ended gets the invitation's access back; someone already in the team
 * keeps what they have.
 *
 * `viaLink`: accepted by opening the link itself (POST /invitations/open). The link was sent to the
 * invited address, so it stands in for a verified email.
 */
export async function acceptTeamInvitation(user: User, token: string, ip?: string, opts: { viaLink?: boolean } = {}): Promise<{ workspaceId: string; joined: boolean }> {
  const inv = await systemDb.invitation.findUnique({ where: { tokenHash: sha256Hex(token) } });
  if (!inv) throw new TeamError(400, "invalid_invite", "This invitation link isn't valid. Check you opened the whole link, or ask for a new invitation.", { status: "invalid" });
  const status = invitationStatus(inv);
  if (status !== "pending") throw new TeamError(400, "invalid_invite", ENDED[status], { status });
  if (normalizeEmail(user.email) !== inv.email) {
    throw new TeamError(403, "invite_email_mismatch", `This invitation is for ${maskEmail(inv.email)}. Sign in with that email address to accept it.`);
  }
  if (!user.emailVerified && !opts.viaLink) throw new TeamError(403, "invite_email_mismatch", "Verify your email address first, then accept the invitation.");
  const now = new Date();
  const joined = await withTenant(inv.workspaceId, async (tx) => {
    await lockTeam(tx, inv.workspaceId);
    const claimed = await tx.invitation.updateMany({
      where: { id: inv.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
      data: { acceptedAt: now, acceptedById: user.id },
    });
    if (claimed.count !== 1) throw new TeamError(400, "invalid_invite", "This invitation has just been used or cancelled. Ask for a new one if you still need access.", { status: "ended" });
    const access = { role: inv.role, permissions: inv.permissions, staffRole: inv.staffRole };
    const existing = await tx.membership.findUnique({ where: { workspaceId_userId: { workspaceId: inv.workspaceId, userId: user.id } } });
    let outcome: "joined" | "restored" | "kept";
    if (!existing) {
      await tx.membership.create({ data: { workspaceId: inv.workspaceId, userId: user.id, ...access, invitedById: inv.invitedById, accessChangedAt: now, accessExpiresAt: inv.expiresAt } });
      outcome = "joined";
    } else if (memberState(existing, now) !== "active") {
      await tx.membership.update({ where: { id: existing.id }, data: { ...access, revokedAt: null, invitedById: inv.invitedById, accessChangedAt: now, accessExpiresAt: inv.expiresAt } });
      outcome = "restored";
    } else {
      outcome = "kept";
    }
    await tx.auditLog.create({
      data: {
        workspaceId: inv.workspaceId,
        actorUserId: user.id,
        action: "member.joined",
        targetType: "invitation",
        targetId: inv.id,
        metadata: { email: inv.email, outcome, role: access.role, permissions: access.permissions, expiresAt: inv.expiresAt.toISOString(), fingerprint: accessFingerprint({ ...access, revokedAt: null }) },
        ip,
      },
    });
    return outcome !== "kept";
  });
  return { workspaceId: inv.workspaceId, joined };
}

import { systemDb, withTenant, type Invitation, type Tx, type User } from "@app/db";
import { ACCESS_MODULE_INFO, hasFullAccess, modulesOf, randomToken, ROLE_INFO, sha256Hex, type Role } from "@app/shared";
import type { StaffRole } from "@app/shared/staff";
import { logger } from "../logger.js";
import type { Mailer } from "../notify.js";
import { accessFingerprint, checkAssignment, lockTeam, maskEmail, normalizeEmail, TeamError, type AssignableRole, type TeamActor } from "./common.js";
import { teamInvitationEmail, teamInvitationUrl } from "./email.js";

/**
 * Invitations to a workspace (Team & Access). The link carries a random 256-bit token; only its
 * SHA-256 is stored, so a copy of the database can't be turned into working links. A link works
 * once and expires (7 days unless the inviter chose otherwise); a resend issues a new link and the
 * old one stops working; inviting the same address again replaces the invitation not yet accepted.
 * Accepting needs a signed-in account whose verified email is the invited address.
 */

export const INVITE_DAYS_DEFAULT = 7;
export const INVITE_DAYS_MAX = 30;
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
  /** 1 to 30; 7 when not given. */
  expiresInDays?: number;
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

function expiryFrom(now: Date, days: number | undefined): Date {
  const d = days ?? INVITE_DAYS_DEFAULT;
  if (!Number.isInteger(d) || d < 1 || d > INVITE_DAYS_MAX) throw new TeamError(400, "invalid_expiry", `An invitation can last from 1 to ${INVITE_DAYS_MAX} days.`);
  return new Date(now.getTime() + d * DAY_MS);
}

/** Someone already in the workspace (or revoked from it) is never invited again: their access is changed, or restored, instead. */
async function assertNotMember(tx: Tx, workspaceId: string, email: string) {
  const member = await tx.membership.findFirst({ where: { workspaceId, user: { email: { equals: email, mode: "insensitive" } } }, select: { revokedAt: true } });
  if (!member) return;
  if (member.revokedAt) throw new TeamError(409, "member_revoked", `${email} was in this workspace and their access is revoked. Restore their access from the team list instead.`);
  throw new TeamError(409, "already_member", `${email} is already in this workspace. Change their access from the team list instead.`);
}

/** The email for an invitation, with a fresh link. Records whether it went out; never throws for a mail failure. */
async function deliver(invitation: Invitation, token: string, mailer: Mailer): Promise<{ emailed: boolean; url: string }> {
  const url = teamInvitationUrl(token);
  let emailed = false;
  try {
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
    await mailer.send(invitation.email, mail.subject, mail.text, mail.html);
    emailed = true;
  } catch (err) {
    // The invitation is saved and its link works, so a mail failure (EMAIL_FROM not verified in SES,
    // SES in its sandbox, a refused address) must not lose it: the inviter gets the link to pass on.
    logger.error({ err, workspaceId: invitation.workspaceId, invitationId: invitation.id }, "invitation email failed; returning the link to the inviter");
  }
  const now = new Date();
  await systemDb.invitation
    .update({ where: { id: invitation.id }, data: emailed ? { sentAt: now, sendCount: { increment: 1 } } : { sendFailedAt: now } })
    .catch((err: unknown) => logger.warn({ err, invitationId: invitation.id }, "could not record the invitation email's outcome"));
  return { emailed, url };
}

/**
 * Invite someone. Checked first: who may grant what (`checkAssignment`), the address isn't in the
 * team already, the note. A pending invitation to the same address is replaced (its link stops
 * working), all under the team lock, so two owners inviting the same person at once leave one
 * invitation. The email goes out after the invitation is saved.
 */
export async function createTeamInvitation(actor: TeamActor, input: InviteInput, mailer: Mailer) {
  const email = normalizeEmail(input.email);
  const access = checkAssignment(actor, input);
  const message = cleanInviteMessage(input.message);
  const now = new Date();
  const expiresAt = expiryFrom(now, input.expiresInDays);
  const token = randomToken(32);
  const { invitation, replaced } = await withTenant(actor.workspaceId, async (tx) => {
    await lockTeam(tx, actor.workspaceId);
    await assertNotMember(tx, actor.workspaceId, email);
    const old = await tx.invitation.updateMany({
      where: { workspaceId: actor.workspaceId, email, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
      data: { revokedAt: now },
    });
    const invitation = await tx.invitation.create({
      data: { workspaceId: actor.workspaceId, email, ...access, message, tokenHash: sha256Hex(token), expiresAt, invitedById: actor.userId },
    });
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
  const sent = await deliver(invitation, token, mailer);
  return { invitationId: invitation.id, emailed: sent.emailed, url: sent.emailed ? undefined : sent.url, replaced, expiresAt };
}

async function pendingInvitation(tx: Tx, actor: TeamActor, id: string) {
  const inv = await tx.invitation.findFirst({ where: { id, workspaceId: actor.workspaceId } });
  if (!inv) throw new TeamError(404, "not_found", "That invitation wasn't found. It may have been removed already.");
  const status = invitationStatus(inv);
  if (status === "accepted") throw new TeamError(409, "already_accepted", `${inv.email} has already accepted this invitation. Change their access from the team list.`);
  if (status === "revoked") throw new TeamError(409, "invitation_revoked", "This invitation was cancelled. Send a new one instead.");
  return { inv, status };
}

/**
 * Send an invitation again, pending or expired: a new link (the one sent before stops working),
 * valid as long as the original was meant to be, counted from now.
 */
export async function resendTeamInvitation(actor: TeamActor, id: string, mailer: Mailer) {
  if (!hasFullAccess(actor.role)) throw new TeamError(403, "forbidden", "Only owners and admins can manage the team.");
  const token = randomToken(32);
  const invitation = await withTenant(actor.workspaceId, async (tx) => {
    await lockTeam(tx, actor.workspaceId);
    const { inv } = await pendingInvitation(tx, actor, id);
    await assertNotMember(tx, actor.workspaceId, inv.email);
    const lifetime = Math.min(INVITE_DAYS_MAX * DAY_MS, Math.max(DAY_MS, inv.expiresAt.getTime() - inv.createdAt.getTime()));
    const updated = await tx.invitation.update({ where: { id: inv.id }, data: { tokenHash: sha256Hex(token), expiresAt: new Date(Date.now() + lifetime) } });
    await tx.auditLog.create({
      data: { workspaceId: actor.workspaceId, actorUserId: actor.userId, action: "member.invitation_resent", targetType: "invitation", targetId: inv.id, metadata: { email: inv.email }, ip: actor.ip },
    });
    return updated;
  });
  const sent = await deliver(invitation, token, mailer);
  return { emailed: sent.emailed, url: sent.emailed ? undefined : sent.url, expiresAt: invitation.expiresAt };
}

/** Cancel an invitation not yet accepted: its link stops working at once. Cancelling one already cancelled is a no-op. */
export async function revokeTeamInvitation(actor: TeamActor, id: string) {
  if (!hasFullAccess(actor.role)) throw new TeamError(403, "forbidden", "Only owners and admins can manage the team.");
  await withTenant(actor.workspaceId, async (tx) => {
    await lockTeam(tx, actor.workspaceId);
    const inv = await tx.invitation.findFirst({ where: { id, workspaceId: actor.workspaceId } });
    if (!inv) throw new TeamError(404, "not_found", "That invitation wasn't found. It may have been removed already.");
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
    if (status === "expired") throw new TeamError(409, "invitation_expired", "This invitation has expired. Resend it, then change it.");
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
}

/**
 * What the invitation page shows before anyone signs in: whose dashboard, from whom, what they'll
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
  if (status !== "pending") return { status, workspace: inv.workspace.name, inviter };
  return {
    status,
    workspace: inv.workspace.name,
    inviter,
    role: inv.role,
    roleLabel: ROLE_INFO[inv.role].label,
    modules: hasFullAccess(inv.role) ? ["Everything in the workspace"] : modulesOf(inv).map((m) => ACCESS_MODULE_INFO[m].label),
    permissionCount: inv.permissions.length,
    message: inv.message,
    expiresAt: inv.expiresAt.toISOString(),
    email: maskEmail(inv.email),
  };
}

const ENDED: Record<Exclude<InvitationStatus, "pending">, string> = {
  accepted: "This invitation has already been used. If it was you, open the dashboard; otherwise ask for a new invitation.",
  revoked: "This invitation was cancelled. Ask the person who invited you for a new one.",
  expired: "This invitation has expired. Ask the person who invited you to send it again.",
};

/**
 * Accept an invitation as the signed-in `user`. The invitation is claimed with one conditional
 * update (not accepted, not cancelled, not expired), so of two tabs accepting at once exactly one
 * wins and the link can't be used again. Joining makes the membership with the invitation's access;
 * someone whose access was revoked gets the invitation's access back; someone already in the team
 * keeps what they have.
 */
export async function acceptTeamInvitation(user: User, token: string, ip?: string): Promise<{ workspaceId: string; joined: boolean }> {
  const inv = await systemDb.invitation.findUnique({ where: { tokenHash: sha256Hex(token) } });
  if (!inv) throw new TeamError(400, "invalid_invite", "This invitation link isn't valid. Check you opened the whole link, or ask for a new invitation.", { status: "invalid" });
  const status = invitationStatus(inv);
  if (status !== "pending") throw new TeamError(400, "invalid_invite", ENDED[status], { status });
  if (normalizeEmail(user.email) !== inv.email) {
    throw new TeamError(403, "invite_email_mismatch", `This invitation is for ${maskEmail(inv.email)}. Sign in with that email address to accept it.`);
  }
  if (!user.emailVerified) throw new TeamError(403, "invite_email_mismatch", "Verify your email address first, then accept the invitation.");
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
      await tx.membership.create({ data: { workspaceId: inv.workspaceId, userId: user.id, ...access, invitedById: inv.invitedById, accessChangedAt: now } });
      outcome = "joined";
    } else if (existing.revokedAt) {
      await tx.membership.update({ where: { id: existing.id }, data: { ...access, revokedAt: null, invitedById: inv.invitedById, accessChangedAt: now } });
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
        metadata: { email: inv.email, outcome, role: access.role, permissions: access.permissions, fingerprint: accessFingerprint({ ...access, revokedAt: null }) },
        ip,
      },
    });
    return outcome !== "kept";
  });
  return { workspaceId: inv.workspaceId, joined };
}

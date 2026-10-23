import { systemDb, withTenant, type Employee, type EmployeeInvitation } from "@app/db";
import { randomToken, sha256Hex } from "@app/shared";
import { staffCan } from "@app/shared/staff";
import { env } from "../env.js";
import { sessionAccess } from "../team/common.js";
import { logger } from "../logger.js";
import { audit, type Mailer } from "../notify.js";
import { isUniqueViolation, notFound, scopedEmployee, serverNow, StaffError, type StaffActor } from "./common.js";
import { ensureStaffSettings } from "./settings.js";

/**
 * Employee invitations. The link carries a random 256-bit token; only its SHA-256 is stored, so a
 * database copy can't be turned into working links. A link works once, expires (48 hours by
 * default, Staff → Settings), and is replaced (old one revoked) whenever a new one is sent.
 *
 * An emailed link proves the employee controls the inbox when it is opened. A link an admin copied
 * proves nothing about the inbox, so an account created from it must still verify its email
 * before the portal opens.
 */
export const invitationUrl = (token: string) => `${env().APP_URL}/join?token=${encodeURIComponent(token)}`;

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function invitationEmail(input: { organization: string; employeeName: string; position: string; url: string; expiresAt: Date; hours: number; timezone: string; support: string }) {
  const expires = new Intl.DateTimeFormat("en", { dateStyle: "full", timeStyle: "short", timeZone: input.timezone }).format(input.expiresAt);
  const subject = `${input.organization} invited you to bizinsights`;
  const text = [
    `Hi ${input.employeeName},`,
    "",
    `${input.organization} has added you as ${input.position}. In bizinsights you'll clock in and out, take breaks, and see your hours and pay.`,
    "",
    "Set up your account here:",
    input.url,
    "",
    `This link works once and expires on ${expires} (${input.hours} hours after it was sent). Don't forward it: anyone with the link could set up your account.`,
    "",
    `Questions? Contact ${input.support}.`,
    "",
    "If you weren't expecting this, you can ignore this email.",
  ].join("\n");
  const e = escapeHtml;
  const html = `<!doctype html><html><body style="margin:0;background:#f7f7f5;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1b1b18">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #e4e4e0;border-radius:12px;padding:28px">
<tr><td>
<p style="margin:0 0 4px;font-size:13px;font-weight:600;color:#2f6f4f">${e(input.organization)}</p>
<h1 style="margin:0 0 16px;font-size:20px">You're invited to bizinsights</h1>
<p style="margin:0 0 12px;font-size:15px;line-height:1.5">Hi ${e(input.employeeName)},</p>
<p style="margin:0 0 20px;font-size:15px;line-height:1.5">${e(input.organization)} has added you as <strong>${e(input.position)}</strong>. In bizinsights you'll clock in and out, take breaks, and see your hours and pay.</p>
<p style="margin:0 0 24px"><a href="${e(input.url)}" style="display:inline-block;background:#2f6f4f;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 20px;border-radius:8px">Set up my account</a></p>
<p style="margin:0 0 12px;font-size:13px;line-height:1.5;color:#6b6b63">This link works once and expires on ${e(expires)} (${input.hours} hours after it was sent). Don't forward it: anyone with the link could set up your account.</p>
<p style="margin:0 0 12px;font-size:13px;line-height:1.5;color:#6b6b63">Button not working? Paste this into your browser:<br><span style="word-break:break-all">${e(input.url)}</span></p>
<p style="margin:0;font-size:13px;line-height:1.5;color:#6b6b63">Questions? Contact ${e(input.support)}.</p>
</td></tr></table>
<p style="font-size:12px;color:#6b6b63">If you weren't expecting this, you can ignore this email.</p>
</td></tr></table></body></html>`;
  return { subject, text, html };
}

export type InviteDelivery = "email" | "link";

/**
 * Send (email) or hand out (link) a new invitation, replacing any earlier one. Returns the link
 * only when the inviter is meant to have it: they asked to copy it, or the email failed.
 */
export async function createInvitation(actor: StaffActor, employeeId: string, delivery: InviteDelivery, mailer: Mailer) {
  const ws = actor.workspaceId;
  const settings = await ensureStaffSettings(ws);
  const token = randomToken(32);
  const now = serverNow();
  const expiresAt = new Date(now.getTime() + settings.invitationExpiryHours * 3_600_000);
  const { employee, invitation } = await withTenant(ws, async (tx) => {
    const employee = await scopedEmployee(tx, actor, employeeId);
    if (employee.status === "inactive") throw new StaffError(409, "inactive", "Reactivate this employee before inviting them.");
    if (employee.userId) throw new StaffError(409, "already_registered", "This employee already has an account. They can sign in at any time.");
    await tx.$queryRaw`SELECT id FROM employees WHERE id = ${employeeId} AND workspace_id = ${ws} FOR UPDATE`;
    await tx.employeeInvitation.updateMany({ where: { employeeId, acceptedAt: null, revokedAt: null }, data: { revokedAt: now, revokedByUserId: actor.userId } });
    try {
      const invitation = await tx.employeeInvitation.create({
        data: {
          workspaceId: ws,
          employeeId,
          email: employee.email,
          tokenHash: sha256Hex(token),
          expiresAt,
          emailed: delivery === "email",
          linkRevealed: delivery === "link",
          createdByUserId: actor.userId,
        },
      });
      return { employee, invitation };
    } catch (err) {
      if (isUniqueViolation(err)) throw new StaffError(409, "invite_in_progress", "Another invitation was just sent. Refresh to see it.");
      throw err;
    }
  });
  const url = invitationUrl(token);
  let emailed = false;
  if (delivery === "email") {
    const [workspace, inviter] = await Promise.all([
      systemDb.workspace.findUnique({ where: { id: ws }, select: { name: true } }),
      systemDb.user.findUnique({ where: { id: actor.userId }, select: { email: true } }),
    ]);
    const msg = invitationEmail({
      organization: workspace?.name ?? "Your employer",
      employeeName: employee.fullName,
      position: employee.jobTitle,
      url,
      expiresAt,
      hours: settings.invitationExpiryHours,
      timezone: employee.timezone,
      support: settings.supportEmail ?? inviter?.email ?? "your manager",
    });
    try {
      await mailer.send(employee.email, msg.subject, msg.text, msg.html);
      emailed = true;
    } catch (err) {
      // The invitation stands; hand the link to the inviter instead (it is now "revealed", so the
      // account made from it has to verify its email).
      logger.error({ err, workspaceId: ws }, "employee invitation email failed; returning the link to the inviter");
      await systemDb.employeeInvitation.update({ where: { id: invitation.id }, data: { emailed: false, linkRevealed: true, emailError: String((err as Error).message ?? err).slice(0, 300) } });
    }
  }
  await audit({
    workspaceId: ws,
    actorUserId: actor.userId,
    action: delivery === "email" ? "staff.invitation_sent" : "staff.invitation_link_created",
    targetType: "employee",
    targetId: employeeId,
    metadata: { emailed, expiresAt: expiresAt.toISOString() },
    ip: actor.ip,
  });
  const revealUrl = delivery === "link" || !emailed;
  return { invitationId: invitation.id, emailed, expiresAt, ...(revealUrl ? { url } : {}) };
}

export async function revokeInvitation(actor: StaffActor, employeeId: string) {
  const ws = actor.workspaceId;
  const n = await withTenant(ws, async (tx) => {
    await scopedEmployee(tx, actor, employeeId);
    const r = await tx.employeeInvitation.updateMany({ where: { employeeId, workspaceId: ws, acceptedAt: null, revokedAt: null }, data: { revokedAt: serverNow(), revokedByUserId: actor.userId } });
    return r.count;
  });
  if (!n) throw new StaffError(409, "no_invitation", "There's no open invitation to revoke.");
  await audit({ workspaceId: ws, actorUserId: actor.userId, action: "staff.invitation_revoked", targetType: "employee", targetId: employeeId, ip: actor.ip });
  return { ok: true };
}

export async function listInvitations(actor: StaffActor, status: "open" | "all") {
  const ws = actor.workspaceId;
  const scope = actor.access.scope === "assigned" ? { employee: { managerUserId: actor.userId } } : {};
  const now = new Date();
  return withTenant(ws, async (tx) => {
    const rows = await tx.employeeInvitation.findMany({
      where: { workspaceId: ws, ...scope, ...(status === "open" ? { acceptedAt: null, revokedAt: null } : {}) },
      include: { employee: { select: { id: true, fullName: true, jobTitle: true, email: true, status: true } } },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    return rows.map((i) => ({
      id: i.id,
      employee: { id: i.employee.id, fullName: i.employee.fullName, jobTitle: i.employee.jobTitle, email: i.employee.email },
      sentAt: i.createdAt,
      expiresAt: i.expiresAt,
      emailed: i.emailed,
      emailFailed: !!i.emailError,
      status: i.acceptedAt ? "accepted" : i.revokedAt ? "revoked" : i.expiresAt < now ? "expired" : "pending",
      acceptedAt: i.acceptedAt,
      revokedAt: i.revokedAt,
    }));
  });
}

export type InvitationProblem = "invalid" | "expired" | "used" | "revoked" | "inactive";

export const INVITATION_PROBLEM_MESSAGE: Record<InvitationProblem, string> = {
  invalid: "This invitation link isn't valid. Check you opened the whole link, or ask your manager for a new one.",
  expired: "This invitation has expired. Ask your manager to send you a new one.",
  used: "This invitation has already been used. Sign in with the email address it was sent to.",
  revoked: "This invitation was replaced or withdrawn. Use the newest invitation, or ask your manager for one.",
  inactive: "This employee record is no longer active. Contact your manager.",
};

type InvitationWithEmployee = EmployeeInvitation & { employee: Employee & { workspace: { name: string } } };

async function findByToken(token: string): Promise<InvitationWithEmployee | null> {
  if (!token || token.length < 20 || token.length > 200) return null;
  return systemDb.employeeInvitation.findUnique({ where: { tokenHash: sha256Hex(token) }, include: { employee: { include: { workspace: { select: { name: true } } } } } });
}

function problemOf(inv: InvitationWithEmployee | null, now: Date): InvitationProblem | null {
  if (!inv) return "invalid";
  if (inv.acceptedAt) return "used";
  if (inv.revokedAt) return "revoked";
  // Sent to an address the employee record no longer has (it was corrected since): whoever reads
  // the old inbox must not be able to claim this person's record.
  if (inv.email.toLowerCase() !== inv.employee.email.toLowerCase()) return "revoked";
  if (inv.expiresAt <= now) return "expired";
  if (inv.employee.status === "inactive") return "inactive";
  return null;
}

/** What the join page shows for a token: who it's for, or why it can't be used. Nothing about pay. */
export async function lookupInvitation(token: string) {
  const inv = await findByToken(token);
  const problem = problemOf(inv, serverNow());
  if (problem || !inv) return { ok: false as const, problem: problem ?? "invalid", message: INVITATION_PROBLEM_MESSAGE[problem ?? "invalid"] };
  return {
    ok: true as const,
    invitationId: inv.id,
    workspaceId: inv.workspaceId,
    employeeId: inv.employeeId,
    employeeName: inv.employee.fullName,
    position: inv.employee.jobTitle,
    organization: inv.employee.workspace.name,
    email: inv.email,
    expiresAt: inv.expiresAt,
    /** Whether opening it proves the inbox (emailed, never copied). */
    provesEmail: inv.emailed && !inv.linkRevealed,
  };
}

/**
 * Use up an invitation, atomically: of two requests with the same token, exactly one gets it.
 * Returns null when the token is not (or no longer) usable.
 */
export async function claimInvitation(token: string) {
  const now = serverNow();
  const inv = await findByToken(token);
  if (problemOf(inv, now) || !inv) return null;
  const r = await systemDb.employeeInvitation.updateMany({
    where: { id: inv.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
    data: { acceptedAt: now },
  });
  return r.count === 1 ? inv : null;
}

/** Undo a claim when creating the account failed for a reason that wasn't the employee's (an outage). */
export async function releaseInvitation(invitationId: string) {
  await systemDb.employeeInvitation.update({ where: { id: invitationId }, data: { acceptedAt: null } });
}

/** Whether `userId` may see pay in the workspace now: an active member whose staff access has `pay:view`. */
async function seesPay(workspaceId: string, userId: string) {
  const m = await systemDb.membership.findUnique({ where: { workspaceId_userId: { workspaceId, userId } } });
  if (!m) return false;
  const eff = sessionAccess(m);
  return eff.state === "active" && staffCan(eff.staff, "pay:view");
}

/**
 * Link the employee record to the account that accepted the invitation. One account per employee
 * record, and one employee record per account in an organization.
 */
export async function linkEmployeeAccount(invitationId: string, userId: string) {
  const inv = await systemDb.employeeInvitation.findUnique({ where: { id: invitationId }, include: { employee: true } });
  if (!inv) throw notFound("That invitation");
  const e = inv.employee;
  if (e.userId && e.userId !== userId) throw new StaffError(409, "already_registered", "This employee record already has an account.");
  // Separation of duties for pay: someone who may not see pay (an HR manager, say) never claims an
  // employee record through an invitation they sent themselves, or the portal would show them that
  // record's pay. Someone else sends theirs (anyone who may see pay can claim their own).
  if (inv.createdByUserId === userId && !(await seesPay(e.workspaceId, userId))) {
    throw new StaffError(
      403,
      "own_invitation",
      "You sent this invitation yourself, and your access doesn't include pay. Ask an owner, admin or payroll manager to send it to you: whoever accepts it sees this employee's pay.",
    );
  }
  const other = await systemDb.employee.findFirst({ where: { workspaceId: e.workspaceId, userId, id: { not: e.id } } });
  if (other) throw new StaffError(409, "account_in_use", "That account is already linked to another employee in this organization.");
  const now = serverNow();
  await systemDb.$transaction([
    systemDb.employee.update({ where: { id: e.id }, data: { userId, accountLinkedAt: now } }),
    systemDb.employeeInvitation.update({ where: { id: inv.id }, data: { acceptedUserId: userId } }),
  ]);
  await audit({ workspaceId: e.workspaceId, actorUserId: userId, action: "staff.account_activated", targetType: "employee", targetId: e.id });
  return { workspaceId: e.workspaceId, employeeId: e.id };
}

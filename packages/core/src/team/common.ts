import type { Tx } from "@app/db";
import { checkGrants, describeGrantProblem, hasFullAccess, linkSessionAccess, sha256Hex, type MemberAccess, type Role } from "@app/shared";
import { readOnlyStaffAccess, staffAccess, type StaffAccess, type StaffRole } from "@app/shared/staff";
import { AppError } from "../errors.js";

/**
 * A Team & Access rule the caller broke (inviting someone already in the team, granting what they
 * can't, changing their own access), answered with its status and a message written for them.
 */
export class TeamError extends AppError {
  constructor(status: 400 | 403 | 404 | 409 | 410 | 429, code: string, message: string, detail?: unknown) {
    super(message, status, code, detail);
    this.name = "TeamError";
  }
}

export const teamNotFound = (what = "That member") => new TeamError(404, "not_found", `${what} wasn't found. They may have been removed already.`);

/** Who is changing the team: an owner or admin of the workspace (the API checks that first). */
export interface TeamActor {
  workspaceId: string;
  userId: string;
  role: Role;
  ip?: string;
}

/** The access a membership or invitation carries, as stored. (A type, not an interface: it goes into audit metadata as JSON.) */
export type StoredAccess = {
  role: Role;
  permissions: string[];
  staffRole: StaffRole | null;
};

/** The roles an invitation or access change may set (ownership is handed over, never granted by invitation). */
export const ASSIGNABLE_ROLES = ["admin", "manager", "analyst", "viewer", "custom"] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

/** Whether a membership grants anything right now: revoked by an owner or admin, or past the end of the access an invitation gave. */
export type MemberState = "active" | "revoked" | "expired";

export function memberState(m: { revokedAt: Date | null; accessExpiresAt?: Date | null }, now = new Date()): MemberState {
  if (m.revokedAt) return "revoked";
  return m.accessExpiresAt && m.accessExpiresAt <= now ? "expired" : "active";
}

/**
 * A short fingerprint of what a membership allows. Sent with every workspace response
 * (`x-access-fp`), so a browser notices within one request that its permissions changed, and used
 * by an editor to refuse a save made on a stale copy of someone's access. `link`: as a session
 * opened from a shared link sees it (read-only), which differs from the member's own.
 */
export function accessFingerprint(
  m: { role: Role; permissions: readonly string[]; staffRole: StaffRole | null; revokedAt: Date | null; accessExpiresAt?: Date | null },
  opts: { link?: boolean; now?: Date } = {},
): string {
  return sha256Hex(`${m.role}|${memberState(m, opts.now)}|${m.staffRole ?? ""}|${[...m.permissions].sort().join(",")}${opts.link ? "|link" : ""}`).slice(0, 16);
}

/**
 * What a membership lets this session do: the member's own access, or for a session opened from a
 * shared link, the read-only part of it (shared `linkSessionAccess`, `readOnlyStaffAccess`). The
 * one place the API turns a membership into permissions, so every route, /me and the access check
 * agree, and so does the fingerprint the browser compares.
 */
export function sessionAccess(
  m: { role: Role; permissions: readonly string[]; staffRole: StaffRole | null; revokedAt: Date | null; accessExpiresAt?: Date | null },
  opts: { link?: boolean; now?: Date } = {},
): { access: MemberAccess; staff: StaffAccess; staffRole: StaffRole | null; state: MemberState; fingerprint: string } {
  const own: MemberAccess = { role: m.role, permissions: m.permissions };
  const access = opts.link ? linkSessionAccess(own) : own;
  const staff = staffAccess(m.role, m.staffRole, opts.link ? access.permissions : m.permissions);
  return {
    access,
    staff: opts.link ? readOnlyStaffAccess(staff) : staff,
    staffRole: m.staffRole,
    state: memberState(m, opts.now),
    fingerprint: accessFingerprint(m, opts),
  };
}

/**
 * Check what an owner or admin wants to give someone, and return it normalized. The rules:
 *
 * - ownership is never granted here (owners hand it over on the member's page);
 * - an admin is the most an admin can make someone; only an owner changes another owner;
 * - restricted roles get exactly the permissions ticked, each with the ones it sits inside, and
 *   viewers and analysts nothing that changes anything (shared `checkGrants`);
 * - what is granted must be within the granter's own permissions (owners and admins hold all of
 *   them, so this only ever bites if management is delegated further one day);
 * - a supervisor's staff role (assigned employees only) doesn't mix with staff permissions (every
 *   employee), which would quietly widen it.
 */
export function checkAssignment(actor: TeamActor, input: { role: Role; permissions: readonly string[]; staffRole?: StaffRole | null }): StoredAccess {
  if (!hasFullAccess(actor.role)) throw new TeamError(403, "forbidden", "Only owners and admins can manage the team.");
  if (input.role === "owner") throw new TeamError(400, "owner_by_invite", "Ownership can't be given by invitation or permission. Invite them as an admin, then make them an owner from their member page.");
  const checked = checkGrants(input.role, input.permissions);
  if (!checked.ok) throw new TeamError(400, checked.problem.code, describeGrantProblem(checked.problem), checked.problem);
  const staffRole = hasFullAccess(input.role) ? null : (input.staffRole ?? null);
  if (staffRole === "supervisor" && checked.keys.some((k) => k.startsWith("staff."))) {
    throw new TeamError(400, "supervisor_with_staff_permissions", "A supervisor sees only the employees assigned to them. Untick the Staff permissions, or choose no staff role.");
  }
  return { role: input.role, permissions: checked.keys, staffRole };
}

/** Changes to one workspace's team happen one at a time (see `lockTeam`). */
export async function lockTeam(tx: Tx, workspaceId: string) {
  // The same key the members routes used for owners, so every change to who is in a workspace and
  // what they may do queues behind the others: two owners demoting each other at once can't leave
  // it with none, and two editors can't interleave half of each other's change.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`owners:${workspaceId}`}))`;
}

/** Normalized email for comparisons: invitations are matched to accounts by it. */
export const normalizeEmail = (email: string) => email.trim().toLowerCase();

/** "jo@example.com" → "j•@example.com", for pages anyone holding a link can open. */
export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  if (!domain) return email;
  const shown = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
  return `${shown}${"•".repeat(Math.max(1, Math.min(6, local.length - shown.length)))}@${domain}`;
}

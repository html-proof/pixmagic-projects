import { systemDb, withTenant, type Tx } from "@app/db";
import { ACCESS_KEYS, can, hasFullAccess, modulesOf, type AccessModule, type Role } from "@app/shared";
import type { StaffRole } from "@app/shared/staff";
import { accessFingerprint, checkAssignment, lockTeam, TeamError, teamNotFound, type AssignableRole, type TeamActor } from "./common.js";
import { invitationStatus } from "./invitations.js";

// ---------------------------------------------------------------------------
// The team page's data
// ---------------------------------------------------------------------------

export type TeamRowStatus = "active" | "revoked" | "pending" | "expired" | "cancelled";

export interface TeamRow {
  kind: "member" | "invitation";
  id: string;
  email: string;
  name: string | null;
  role: Role;
  permissions: string[];
  modules: AccessModule[];
  staffRole: StaffRole | null;
  status: TeamRowStatus;
  /** Joined (members) or invited (invitations). */
  since: string;
  invitedBy: string | null;
  /** Members: their user id (to mark "you"), when they last signed in, when their access last changed, and its fingerprint (for safe edits). */
  userId?: string;
  lastSignInAt?: string | null;
  accessChangedAt?: string | null;
  fingerprint?: string;
  /** Invitations: until when, the note, and how its email went. */
  expiresAt?: string;
  message?: string | null;
  sentAt?: string | null;
  sendFailedAt?: string | null;
  sendCount?: number;
}

export interface TeamSummary {
  totalMembers: number;
  activeMembers: number;
  pendingInvitations: number;
  /** Expired or cancelled invitations still on record (the retention sweep removes them after 90 days). */
  endedInvitations: number;
  /** Each count as it stood at the end of each of the last TREND_DAYS days (oldest first, today last). */
  trend: Record<"totalMembers" | "activeMembers" | "pendingInvitations" | "endedInvitations", number[]>;
}

export const TREND_DAYS = 30;

/** Every member and every invitation not accepted, as rows, with the page's four counts. */
export async function loadTeam(workspaceId: string, now = new Date()): Promise<{ rows: TeamRow[]; summary: TeamSummary }> {
  const [members, allInvitations] = await withTenant(workspaceId, (tx) =>
    Promise.all([
      tx.membership.findMany({
        where: { workspaceId },
        include: { user: { select: { email: true, displayName: true } }, invitedBy: { select: { email: true } } },
        orderBy: { createdAt: "asc" },
      }),
      // Accepted ones too: they were pending for a while, which the trend lines show.
      tx.invitation.findMany({ where: { workspaceId }, include: { invitedBy: { select: { email: true } } }, orderBy: { createdAt: "desc" } }),
    ]),
  );
  // Sign-in records are outside the tenant's reach (RLS): read only the latest time, for these members.
  const signIns = members.length
    ? await systemDb.authIdentity.groupBy({ by: ["userId"], where: { userId: { in: members.map((m) => m.userId) } }, _max: { lastUsedAt: true } })
    : [];
  const lastSignIn = new Map(signIns.map((g) => [g.userId, g._max.lastUsedAt]));
  const invitations = allInvitations.filter((i) => !i.acceptedAt);
  const rows: TeamRow[] = [];
  for (const m of members) {
    rows.push({
      kind: "member",
      id: m.id,
      userId: m.userId,
      email: m.user.email,
      name: m.user.displayName,
      role: m.role,
      permissions: hasFullAccess(m.role) ? [...ACCESS_KEYS] : m.permissions,
      modules: modulesOf(m),
      staffRole: m.staffRole,
      status: m.revokedAt ? "revoked" : "active",
      since: m.createdAt.toISOString(),
      invitedBy: m.invitedBy?.email ?? null,
      lastSignInAt: lastSignIn.get(m.userId)?.toISOString() ?? null,
      accessChangedAt: m.accessChangedAt?.toISOString() ?? null,
      fingerprint: accessFingerprint(m),
    });
  }
  for (const i of invitations) {
    const st = invitationStatus(i, now);
    rows.push({
      kind: "invitation",
      id: i.id,
      email: i.email,
      name: null,
      role: i.role,
      permissions: hasFullAccess(i.role) ? [...ACCESS_KEYS] : i.permissions,
      modules: modulesOf(i),
      staffRole: i.staffRole,
      status: st === "revoked" ? "cancelled" : st === "expired" ? "expired" : "pending",
      since: i.createdAt.toISOString(),
      invitedBy: i.invitedBy?.email ?? null,
      expiresAt: i.expiresAt.toISOString(),
      message: i.message,
      sentAt: i.sentAt?.toISOString() ?? null,
      sendFailedAt: i.sendFailedAt?.toISOString() ?? null,
      sendCount: i.sendCount,
    });
  }
  const summary: TeamSummary = {
    totalMembers: members.length,
    activeMembers: members.filter((m) => !m.revokedAt).length,
    pendingInvitations: rows.filter((r) => r.kind === "invitation" && r.status === "pending").length,
    endedInvitations: rows.filter((r) => r.kind === "invitation" && r.status !== "pending").length,
    trend: teamTrend(members, allInvitations, now),
  };
  return { rows, summary };
}

type TrendMember = { createdAt: Date; revokedAt: Date | null };
type TrendInvitation = { createdAt: Date; acceptedAt: Date | null; revokedAt: Date | null; expiresAt: Date };

/**
 * The four counts at the end of each of the last TREND_DAYS days, rebuilt from the dates on record.
 * Removed members and invitations the retention sweep deleted are gone, so earlier days can read low.
 */
export function teamTrend(members: TrendMember[], invitations: TrendInvitation[], now = new Date()): TeamSummary["trend"] {
  const by = (d: Date | null, t: Date) => !!d && d <= t;
  const trend: TeamSummary["trend"] = { totalMembers: [], activeMembers: [], pendingInvitations: [], endedInvitations: [] };
  for (let back = TREND_DAYS - 1; back >= 0; back--) {
    const t = new Date(now.getTime() - back * 86_400_000);
    const joined = members.filter((m) => m.createdAt <= t);
    const open = invitations.filter((i) => i.createdAt <= t && !by(i.acceptedAt, t));
    const ended = open.filter((i) => by(i.revokedAt, t) || i.expiresAt <= t).length;
    trend.totalMembers.push(joined.length);
    trend.activeMembers.push(joined.filter((m) => !by(m.revokedAt, t)).length);
    trend.pendingInvitations.push(open.length - ended);
    trend.endedInvitations.push(ended);
  }
  return trend;
}

export const TEAM_SORTS = ["name", "role", "status", "since"] as const;
export type TeamSort = (typeof TEAM_SORTS)[number];

export interface TeamQuery {
  q?: string;
  /** "members" (active and revoked), "invitations" (every one not accepted), or one row status. */
  status?: TeamRowStatus | "members" | "invitations";
  role?: Role;
  sort?: TeamSort;
  dir?: "asc" | "desc";
  page?: number;
  pageSize?: number;
}

const ROLE_ORDER: Record<Role, number> = { owner: 0, admin: 1, manager: 2, analyst: 3, viewer: 4, custom: 5 };
const STATUS_ORDER: Record<TeamRowStatus, number> = { active: 0, pending: 1, expired: 2, revoked: 3, cancelled: 4 };

/** Search, filter, sort and page the team's rows (a team is small: this runs over all of them). */
export function queryTeam(rows: TeamRow[], query: TeamQuery) {
  const q = query.q?.trim().toLowerCase();
  let out = rows.filter((r) => {
    if (q && !r.email.toLowerCase().includes(q) && !(r.name ?? "").toLowerCase().includes(q)) return false;
    if (query.role && r.role !== query.role) return false;
    if (query.status === "members") return r.kind === "member";
    if (query.status === "invitations") return r.kind === "invitation";
    if (query.status && r.status !== query.status) return false;
    return true;
  });
  const sort = query.sort ?? "status";
  const dir = query.dir === "desc" ? -1 : 1;
  const key = (r: TeamRow): string | number =>
    sort === "name" ? (r.name ?? r.email).toLowerCase() : sort === "role" ? ROLE_ORDER[r.role] : sort === "status" ? STATUS_ORDER[r.status] : r.since;
  out = [...out].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka < kb) return -dir;
    if (ka > kb) return dir;
    return a.email.localeCompare(b.email);
  });
  const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 20));
  const total = out.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(pages, Math.max(1, query.page ?? 1));
  return { rows: out.slice((page - 1) * pageSize, page * pageSize), total, page, pages, pageSize };
}

/** One member, for the access editor. */
export async function loadMember(workspaceId: string, memberId: string) {
  const m = await withTenant(workspaceId, (tx) =>
    tx.membership.findFirst({ where: { id: memberId, workspaceId }, include: { user: { select: { email: true, displayName: true } }, invitedBy: { select: { email: true } } } }),
  );
  if (!m) throw teamNotFound();
  return {
    id: m.id,
    userId: m.userId,
    email: m.user.email,
    name: m.user.displayName,
    role: m.role,
    permissions: hasFullAccess(m.role) ? [...ACCESS_KEYS] : m.permissions,
    modules: modulesOf(m),
    staffRole: m.staffRole,
    status: m.revokedAt ? ("revoked" as const) : ("active" as const),
    revokedAt: m.revokedAt?.toISOString() ?? null,
    since: m.createdAt.toISOString(),
    accessChangedAt: m.accessChangedAt?.toISOString() ?? null,
    invitedBy: m.invitedBy?.email ?? null,
    fingerprint: accessFingerprint(m),
  };
}

// ---------------------------------------------------------------------------
// Changing someone's access
// ---------------------------------------------------------------------------

async function targetMember(tx: Tx, actor: TeamActor, memberId: string) {
  const m = await tx.membership.findFirst({ where: { id: memberId, workspaceId: actor.workspaceId } });
  if (!m) throw teamNotFound();
  return m;
}

async function assertAnotherOwner(tx: Tx, workspaceId: string, excludingMemberId: string) {
  const others = await tx.membership.count({ where: { workspaceId, role: "owner", revokedAt: null, id: { not: excludingMemberId } } });
  if (others === 0) throw new TeamError(400, "last_owner", "A workspace needs at least one owner. Make someone else an owner first.");
}

/** Keys someone made keep working after they lose the right to manage keys, unless retired with it. */
async function revokeKeysOf(tx: Tx, workspaceId: string, userId: string): Promise<number> {
  const r = await tx.apiKey.updateMany({ where: { workspaceId, createdById: userId, revokedAt: null }, data: { revokedAt: new Date() } });
  return r.count;
}

const OWN_ACCESS = "You can't change your own access. Ask another owner or admin.";

/**
 * Set a member's role and permissions (and staff role) in one change, so the two never disagree.
 * `basedOn` is the fingerprint of the access the editor started from: when someone else changed it
 * in the meantime the save is refused rather than silently undoing their change.
 *
 * The rules beyond `checkAssignment`: nobody changes their own access; only an owner changes an
 * owner or makes someone one; the last owner stays an owner. The change applies to the next request
 * the member makes: every request reads their access afresh.
 */
export async function updateMemberAccess(
  actor: TeamActor,
  memberId: string,
  input: { role: AssignableRole | "owner"; permissions: readonly string[]; staffRole?: StaffRole | null; basedOn?: string; allowSelf?: boolean },
) {
  const makingOwner = input.role === "owner";
  if (makingOwner && actor.role !== "owner") throw new TeamError(403, "forbidden", "Only owners can make someone an owner.");
  const next = makingOwner ? { role: "owner" as const, permissions: [], staffRole: null } : checkAssignment(actor, { ...input, role: input.role });
  return withTenant(actor.workspaceId, async (tx) => {
    await lockTeam(tx, actor.workspaceId);
    const m = await targetMember(tx, actor, memberId);
    if (m.userId === actor.userId && !input.allowSelf) throw new TeamError(403, "own_access", OWN_ACCESS);
    if (m.role === "owner" && actor.role !== "owner") throw new TeamError(403, "forbidden", "Only owners can change an owner's access.");
    if (input.basedOn && input.basedOn !== accessFingerprint(m)) {
      throw new TeamError(409, "access_changed", "Someone else changed this member's access while you were editing. Review their current access and save again.");
    }
    if (m.role === "owner" && next.role !== "owner") await assertAnotherOwner(tx, actor.workspaceId, m.id);
    // A staff role left as it was unless the change names one (the old member endpoint changes either alone).
    const staffRole = input.staffRole === undefined && !hasFullAccess(next.role) ? m.staffRole : next.staffRole;
    if (staffRole === "supervisor" && next.permissions.some((k) => k.startsWith("staff."))) {
      throw new TeamError(400, "supervisor_with_staff_permissions", "A supervisor sees only the employees assigned to them. Untick the Staff permissions, or choose no staff role.");
    }
    const previous = { role: m.role, permissions: m.permissions, staffRole: m.staffRole };
    const updated = { role: next.role, permissions: next.permissions, staffRole };
    const updatedRow = await tx.membership.update({ where: { id: m.id }, data: { ...updated, accessChangedAt: new Date() } });
    // Keys they made keep working after they can no longer manage keys: retire them with the role.
    const keysRevoked = !can(next.role, "apikeys:manage") ? await revokeKeysOf(tx, actor.workspaceId, m.userId) : 0;
    const before = new Set(previous.permissions);
    const after = new Set(updated.permissions);
    await tx.auditLog.create({
      data: {
        workspaceId: actor.workspaceId,
        actorUserId: actor.userId,
        action: "member.access_changed",
        targetType: "member",
        targetId: m.id,
        metadata: {
          targetUserId: m.userId,
          previous,
          updated,
          added: updated.permissions.filter((k) => !before.has(k)),
          removed: previous.permissions.filter((k) => !after.has(k)),
          keysRevoked,
        },
        ip: actor.ip,
      },
    });
    return { fingerprint: accessFingerprint(updatedRow), keysRevoked };
  });
}

/**
 * Revoke a member's access: from their next request they can see nothing in this workspace, and
 * the API keys they made stop working. The membership stays, so access can be restored. Owners
 * can't be revoked (another owner changes their role first); nobody revokes themselves.
 */
export async function revokeMember(actor: TeamActor, memberId: string) {
  if (!hasFullAccess(actor.role)) throw new TeamError(403, "forbidden", "Only owners and admins can manage the team.");
  return withTenant(actor.workspaceId, async (tx) => {
    await lockTeam(tx, actor.workspaceId);
    const m = await targetMember(tx, actor, memberId);
    if (m.userId === actor.userId) throw new TeamError(403, "own_access", OWN_ACCESS);
    if (m.role === "owner") throw new TeamError(403, "owner_revoke", "An owner's access can't be revoked. Another owner can change their role first.");
    if (m.revokedAt) return { keysRevoked: 0 };
    await tx.membership.update({ where: { id: m.id }, data: { revokedAt: new Date(), accessChangedAt: new Date() } });
    const keysRevoked = await revokeKeysOf(tx, actor.workspaceId, m.userId);
    await tx.auditLog.create({
      data: { workspaceId: actor.workspaceId, actorUserId: actor.userId, action: "member.access_revoked", targetType: "member", targetId: m.id, metadata: { targetUserId: m.userId, role: m.role, permissions: m.permissions, keysRevoked }, ip: actor.ip },
    });
    return { keysRevoked };
  });
}

/** Give a revoked member back the access they had. */
export async function restoreMember(actor: TeamActor, memberId: string) {
  if (!hasFullAccess(actor.role)) throw new TeamError(403, "forbidden", "Only owners and admins can manage the team.");
  await withTenant(actor.workspaceId, async (tx) => {
    await lockTeam(tx, actor.workspaceId);
    const m = await targetMember(tx, actor, memberId);
    if (!m.revokedAt) return;
    await tx.membership.update({ where: { id: m.id }, data: { revokedAt: null, accessChangedAt: new Date() } });
    await tx.auditLog.create({
      data: { workspaceId: actor.workspaceId, actorUserId: actor.userId, action: "member.access_restored", targetType: "member", targetId: m.id, metadata: { targetUserId: m.userId, role: m.role, permissions: m.permissions }, ip: actor.ip },
    });
  });
}

/**
 * Remove someone from the workspace altogether (inviting them again starts afresh). Only an owner
 * removes an owner, and never the last one. The API keys they made are retired.
 */
export async function removeMember(actor: TeamActor, memberId: string, opts: { allowSelf?: boolean } = {}) {
  if (!hasFullAccess(actor.role)) throw new TeamError(403, "forbidden", "Only owners and admins can manage the team.");
  return withTenant(actor.workspaceId, async (tx) => {
    await lockTeam(tx, actor.workspaceId);
    const m = await targetMember(tx, actor, memberId);
    if (m.userId === actor.userId && !opts.allowSelf) throw new TeamError(403, "own_access", "You can't remove yourself here. Ask another owner or admin.");
    if (m.role === "owner") {
      if (actor.role !== "owner") throw new TeamError(403, "forbidden", "Only owners can remove an owner.");
      await assertAnotherOwner(tx, actor.workspaceId, m.id);
    }
    await tx.membership.delete({ where: { id: m.id } });
    // An API key outlives its creator's membership otherwise (keys never expire).
    const keysRevoked = await revokeKeysOf(tx, actor.workspaceId, m.userId);
    await tx.auditLog.create({
      data: { workspaceId: actor.workspaceId, actorUserId: actor.userId, action: "member.removed", targetType: "member", targetId: m.id, metadata: { targetUserId: m.userId, role: m.role, permissions: m.permissions, keysRevoked }, ip: actor.ip },
    });
    return { keysRevoked };
  });
}

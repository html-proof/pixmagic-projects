import { systemDb, withTenant } from "@app/db";
import { TeamError } from "./common.js";

/**
 * One person's access history in a workspace (the team page's "Access history"): the audit log's
 * Team & Access entries for their invitations and their membership, newest first. Link openings
 * (`member.link_opened`) say from which address the dashboard was opened.
 */
export interface HistoryEntry {
  id: string;
  action: string;
  at: string;
  /** Who did it (an owner or admin, or the person themselves opening their link). */
  actor: string | null;
  ip: string | null;
  /** The parts of the entry worth showing: what changed. */
  detail: Record<string, unknown>;
}

const SHOWN = ["role", "added", "removed", "expiresAt", "previous", "newLink", "renewed", "outcome", "keysRevoked", "replaced"] as const;

export async function teamHistory(workspaceId: string, target: { invitationId?: string; memberId?: string }, limit = 100): Promise<HistoryEntry[]> {
  return withTenant(workspaceId, async (tx) => {
    const ids = new Set<string>();
    let email: string | null = null;
    if (target.memberId) {
      const m = await tx.membership.findFirst({ where: { id: target.memberId, workspaceId }, select: { id: true, userId: true, user: { select: { email: true } } } });
      if (!m) throw new TeamError(404, "not_found", "That member wasn't found. They may have been removed already.");
      ids.add(m.id);
      email = m.user.email;
      const invs = await tx.invitation.findMany({ where: { workspaceId, OR: [{ acceptedById: m.userId }, { email: m.user.email.toLowerCase() }] }, select: { id: true } });
      for (const i of invs) ids.add(i.id);
    }
    if (target.invitationId) {
      const inv = await tx.invitation.findFirst({ where: { id: target.invitationId, workspaceId }, select: { id: true, email: true } });
      if (!inv) throw new TeamError(404, "not_found", "That invitation wasn't found. It may have been removed already.");
      ids.add(inv.id);
      email ??= inv.email;
    }
    const rows = await tx.auditLog.findMany({
      where: { workspaceId, targetId: { in: [...ids] }, action: { startsWith: "member." } },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    const actors = new Map<string, string>();
    const actorIds = [...new Set(rows.map((r) => r.actorUserId).filter((x): x is string => !!x))];
    if (actorIds.length) for (const u of await systemDb.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, email: true } })) actors.set(u.id, u.email);
    return rows.map((r) => {
      const meta = (r.metadata ?? {}) as Record<string, unknown>;
      const detail: Record<string, unknown> = {};
      for (const k of SHOWN) if (meta[k] !== undefined) detail[k] = meta[k];
      return { id: r.id, action: r.action, at: r.createdAt.toISOString(), actor: r.actorUserId ? (actors.get(r.actorUserId) ?? null) : null, ip: r.ip ?? null, detail: { ...detail, ...(email ? { email } : {}) } };
    });
  });
}

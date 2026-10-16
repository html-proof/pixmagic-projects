import { systemDb } from "@app/db";

/** Ended invitations (accepted, cancelled, expired) are kept this long: they hold the invited address. */
export const ENDED_INVITATION_KEEP_DAYS = 90;
/** Who changed whose access, and how: kept two years, then removed (member.* audit entries only). */
export const ACCESS_AUDIT_KEEP_DAYS = 730;
const DAY_MS = 86_400_000;

/**
 * Team & Access retention, a bounded batch per tick (apps/worker runScheduled): invitations that
 * ended more than 90 days ago, and member access audit entries older than two years. Everything
 * else in the audit log is left alone.
 */
export async function pruneTeamRecords(now = new Date(), batch = 5_000): Promise<{ invitations: number; auditEntries: number }> {
  const invitationCutoff = new Date(now.getTime() - ENDED_INVITATION_KEEP_DAYS * DAY_MS);
  const auditCutoff = new Date(now.getTime() - ACCESS_AUDIT_KEEP_DAYS * DAY_MS);
  const invitations = await systemDb.$executeRaw`
    DELETE FROM invitations WHERE id IN (
      SELECT id FROM invitations
       WHERE accepted_at < ${invitationCutoff}
          OR revoked_at < ${invitationCutoff}
          OR (accepted_at IS NULL AND revoked_at IS NULL AND expires_at < ${invitationCutoff})
       LIMIT ${batch})`;
  const auditEntries = await systemDb.$executeRaw`
    DELETE FROM audit_logs WHERE id IN (
      SELECT id FROM audit_logs WHERE action LIKE 'member.%' AND created_at < ${auditCutoff} LIMIT ${batch})`;
  return { invitations, auditEntries };
}

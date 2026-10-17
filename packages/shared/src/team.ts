import type { AccessModule } from "./access";
import type { Role } from "./roles";
import type { StaffRole } from "./staff";

// What the Team & Access API answers (apps/api/src/routes/team.ts, built by core/team), as the team
// page reads it. One definition for both sides, so a field the API adds or drops shows up in the UI's
// type check.

/**
 * What became of one email, as far as we know. "sent" means the provider accepted it, never that it
 * arrived: only "delivered" (the recipient's server took it, reported by the provider's webhook)
 * says that.
 */
export const DELIVERY_STATUSES = ["queued", "sent", "delivered", "delayed", "bounced", "complained", "failed", "not_allowed"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

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
  /** Members who joined from an invitation: when their access ends (null: no end date). */
  accessExpiresAt?: string | null;
  /**
   * The invitation link behind the row (an invitation's own, or the one a member joined from): its
   * id for the link actions, until when it opens the dashboard, how often and when it last did, and
   * whether the same link can be copied again (false for links from before they were kept).
   */
  link?: { invitationId: string; expiresAt: string; openCount: number; lastOpenedAt: string | null; copyable: boolean } | null;
  /** The latest invitation email as the mail provider reported it (core/mail). */
  delivery?: { status: DeliveryStatus; provider: string; at: string; error: string | null; attempts: number } | null;
}

/** The invitation counts the team page leads with. */
export interface InvitationSummary {
  /** Every invitation on record (the retention sweep removes ended ones after 90 days). */
  total: number;
  /** Accepted, and the member's access still active. */
  active: number;
  /** Sent, not opened yet, not expired. */
  pending: number;
  /** Not opened in time, or the access it gave has ended. */
  expired: number;
  /** Cancelled before opening, or the member's access revoked. */
  revoked: number;
}

export interface TeamSummary {
  totalMembers: number;
  activeMembers: number;
  pendingInvitations: number;
  /** Expired or cancelled invitations still on record (the retention sweep removes them after 90 days). */
  endedInvitations: number;
  /** Each count as it stood at the end of each of the last 30 days (core's TREND_DAYS; oldest first, today last). */
  trend: Record<"totalMembers" | "activeMembers" | "pendingInvitations" | "endedInvitations", number[]>;
  invitations: InvitationSummary;
}

/** One entry of a person's access history (the team page's "Access history"). */
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

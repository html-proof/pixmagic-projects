import type { AccessKind, AccessModule } from "@app/shared/access";
import type { Role } from "@app/shared/roles";
import type { StaffRole } from "@app/shared/staff";

// Responses of the Team & Access API (apps/api/src/routes/team.ts), as the team page reads them.

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
  since: string;
  invitedBy: string | null;
  userId?: string;
  /** Members: when they last signed in (null: never, or before sign-ins were recorded). */
  lastSignInAt?: string | null;
  accessChangedAt?: string | null;
  fingerprint?: string;
  expiresAt?: string;
  message?: string | null;
  sentAt?: string | null;
  sendFailedAt?: string | null;
  sendCount?: number;
  /** Members who joined from an invitation: when their access ends (null: no end date). */
  accessExpiresAt?: string | null;
  /** The invitation link behind the row: until when it opens the dashboard, how often it has, and whether it can be copied again. */
  link?: { invitationId: string; expiresAt: string; openCount: number; lastOpenedAt: string | null; copyable: boolean } | null;
  /** The latest invitation email, as the mail provider reported it. */
  delivery?: { status: DeliveryStatus; provider: string; at: string; error: string | null; attempts: number } | null;
}

/** What became of an invitation email (apps/api core/mail): "sent" is only "the provider accepted it". */
export type DeliveryStatus = "queued" | "sent" | "delivered" | "delayed" | "bounced" | "complained" | "failed" | "not_allowed";

export const DELIVERY_LABEL: Record<DeliveryStatus, string> = {
  queued: "Email queued",
  sent: "Email sent",
  delivered: "Email delivered",
  delayed: "Email delayed",
  bounced: "Email bounced",
  complained: "Marked as spam",
  failed: "Email failed",
  not_allowed: "Email not sent",
};

/** What each delivery status means, for the tooltip. */
export const DELIVERY_HELP: Record<DeliveryStatus, string> = {
  queued: "The email service was busy. bizinsights tries again automatically.",
  sent: "Accepted by the email service. Not yet confirmed by their inbox.",
  delivered: "Their mail server accepted the email.",
  delayed: "Their mail server is slow to accept it. The email service keeps trying.",
  bounced: "Their mail server refused it: the address may be wrong. Copy the link and send it another way.",
  complained: "They marked the email as spam. It won't be emailed to them again.",
  failed: "The email couldn't be sent. Resend it, or copy the link and send it another way.",
  not_allowed: "Our email service can't send to this address yet. Copy the link and send it another way.",
};

export interface InvitationSummary {
  total: number;
  active: number;
  pending: number;
  expired: number;
  revoked: number;
}

export interface HistoryEntry {
  id: string;
  action: string;
  at: string;
  actor: string | null;
  ip: string | null;
  detail: Record<string, unknown>;
}

export interface TeamSummary {
  totalMembers: number;
  activeMembers: number;
  pendingInvitations: number;
  endedInvitations: number;
  /** Each count at the end of each of the last 30 days, oldest first. */
  trend?: Record<"totalMembers" | "activeMembers" | "pendingInvitations" | "endedInvitations", number[]>;
  invitations?: InvitationSummary;
}

export interface TeamPage {
  summary: TeamSummary;
  rows: TeamRow[];
  total: number;
  page: number;
  pages: number;
  pageSize: number;
}

export interface CatalogPermission {
  key: string;
  module: AccessModule;
  label: string;
  reveals: string;
  kind: AccessKind;
  sensitive?: boolean;
  requires?: string[];
  /** False when no connected store has granted bizinsights the data this shows (it can still be given). */
  available: boolean;
}

export interface Catalog {
  modules: Array<{ id: AccessModule; label: string; description: string; permissions: CatalogPermission[] }>;
  roles: Array<{ id: Role; label: string; description: string; template: string[]; restricted: boolean; canManage: boolean }>;
  staffRoles: Array<{ id: StaffRole; label: string; description: string }>;
  limits: { messageMax: number; expiryDaysMax: number; expiryDaysDefault: number };
  hasStore: boolean;
}

export interface MemberDetail {
  id: string;
  userId: string;
  email: string;
  name: string | null;
  role: Role;
  permissions: string[];
  modules: AccessModule[];
  staffRole: StaffRole | null;
  status: "active" | "revoked" | "expired";
  revokedAt: string | null;
  accessExpiresAt?: string | null;
  since: string;
  accessChangedAt: string | null;
  invitedBy: string | null;
  fingerprint: string;
}

export const STATUS_LABEL: Record<TeamRowStatus, string> = {
  active: "Active",
  revoked: "Revoked",
  pending: "Pending",
  expired: "Expired",
  cancelled: "Cancelled",
};

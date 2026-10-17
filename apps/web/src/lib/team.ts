import type { AccessKind, AccessModule } from "@app/shared/access";
import type { Role } from "@app/shared/roles";
import type { StaffRole } from "@app/shared/staff";
import type { DeliveryStatus, TeamRow, TeamRowStatus, TeamSummary } from "@app/shared/team";

// Responses of the Team & Access API (apps/api/src/routes/team.ts), as the team page reads them. The
// rows, counts, history and email delivery statuses are @app/shared/team, shared with the API.
export type { DeliveryStatus, HistoryEntry, InvitationSummary, TeamRow, TeamRowStatus, TeamSummary } from "@app/shared/team";

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

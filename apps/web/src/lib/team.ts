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
  accessChangedAt?: string | null;
  fingerprint?: string;
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
  endedInvitations: number;
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
  status: "active" | "revoked";
  revokedAt: string | null;
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

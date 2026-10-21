// Who may do what in Staff Management. Enforced by the API on every request; the UI asks the same
// questions only to decide what to show.
//
// Owners and admins of a workspace manage staff fully. Other members can be given one staff role
// (HR manager, payroll manager, supervisor) on top of their workspace role. Employees are not
// workspace members: they reach their own records through the employee portal only.
//
// Imported by the UI through `@app/shared/staff`: relative imports stay extensionless.

import type { Role } from "../roles";

export const STAFF_ROLES = ["hr_manager", "payroll_manager", "supervisor"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export const STAFF_ROLE_LABEL: Record<StaffRole, string> = {
  hr_manager: "HR manager",
  payroll_manager: "Payroll manager",
  supervisor: "Supervisor",
};

export const STAFF_ROLE_HELP: Record<StaffRole, string> = {
  hr_manager: "Employee profiles, invitations, schedules, attendance and timesheet approvals. No pay rates or payroll.",
  payroll_manager: "Pay rates, timesheet review, payroll runs and approvals, and payment records.",
  supervisor: "Live attendance, timesheets and corrections for the employees assigned to them.",
};

export type StaffPermission =
  /** Open the Staff section and see the employee list (names, positions, departments, status). */
  | "staff:view"
  /** Add and edit employees, send and revoke invitations, deactivate, departments, schedules. */
  | "staff:manage"
  /** See pay rates, earnings, payroll and payments. */
  | "pay:view"
  /** Change pay rates and overtime/break policies. */
  | "pay:manage"
  /** Live attendance and timesheets. */
  | "attendance:view"
  /** Correct timesheets, approve or reject hours, close forgotten shifts. */
  | "attendance:manage"
  /** Create pay periods, calculate, add adjustments, submit for approval. */
  | "payroll:manage"
  /** Approve, reject, cancel or reverse payroll. */
  | "payroll:approve"
  /** Record, fail and reverse payments. */
  | "payments:manage"
  /** Download reports, exports and payslips (still limited by pay:view for pay figures). */
  | "staff:export"
  /** Organization-wide staff and payroll settings. */
  | "staff:settings";

const ALL: StaffPermission[] = [
  "staff:view",
  "staff:manage",
  "pay:view",
  "pay:manage",
  "attendance:view",
  "attendance:manage",
  "payroll:manage",
  "payroll:approve",
  "payments:manage",
  "staff:export",
  "staff:settings",
];

const BY_STAFF_ROLE: Record<StaffRole, StaffPermission[]> = {
  hr_manager: ["staff:view", "staff:manage", "attendance:view", "attendance:manage", "staff:export"],
  payroll_manager: ["staff:view", "pay:view", "pay:manage", "attendance:view", "attendance:manage", "payroll:manage", "payroll:approve", "payments:manage", "staff:export"],
  supervisor: ["staff:view", "attendance:view", "attendance:manage"],
};

export interface StaffAccess {
  permissions: StaffPermission[];
  /** "all" employees, or only those whose assigned manager is this member. */
  scope: "all" | "assigned";
  staffRole: StaffRole | null;
}

/**
 * Staff Management rights that Team & Access permissions (../access.ts) carry, for every employee:
 * looking at the team, timesheets and payroll, and HR-style management. Running and approving
 * payroll and recording payments stay with owners, admins and payroll managers.
 */
const BY_GRANT: Record<string, StaffPermission[]> = {
  "staff.team": ["staff:view"],
  "staff.timesheets": ["staff:view", "attendance:view"],
  "staff.payroll": ["staff:view", "pay:view"],
  "staff.manage": ["staff:view", "staff:manage", "attendance:view", "attendance:manage"],
};

/**
 * What a workspace member may do in Staff Management: everything for owners and admins; otherwise
 * what their staff role gives (a supervisor only for the employees assigned to them) together with
 * what their Team & Access permissions give. Downloads need "Export approved reports" on top of
 * something to download.
 */
export function staffAccess(role: Role, staffRole: StaffRole | null | undefined, grants: readonly string[] = []): StaffAccess {
  if (role === "owner" || role === "admin") return { permissions: [...ALL], scope: "all", staffRole: staffRole ?? null };
  const fromGrants = new Set(grants.flatMap((g) => BY_GRANT[g] ?? []));
  if (fromGrants.size && grants.includes("reports.export")) fromGrants.add("staff:export");
  const fromRole = staffRole ? BY_STAFF_ROLE[staffRole] : [];
  const permissions = ALL.filter((p) => fromGrants.has(p) || fromRole.includes(p));
  // A supervisor's role covers only the employees assigned to them. Team & Access refuses to mix it
  // with staff permissions (core's team service); should both ever meet, the narrower scope wins.
  const scope = staffRole === "supervisor" ? "assigned" : "all";
  return { permissions, scope, staffRole: staffRole ?? null };
}

/** The Staff Management rights that only look or download (what a session opened from a shared link keeps). */
export const STAFF_READ_ONLY: readonly StaffPermission[] = ["staff:view", "pay:view", "attendance:view", "staff:export"];

/** `access` without anything that changes records: for a session opened from a shared link. */
export function readOnlyStaffAccess(access: StaffAccess): StaffAccess {
  return { ...access, permissions: access.permissions.filter((p) => STAFF_READ_ONLY.includes(p)) };
}

export function staffCan(access: Pick<StaffAccess, "permissions">, perm: StaffPermission): boolean {
  return access.permissions.includes(perm);
}

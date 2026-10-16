/**
 * Owners and admins run the workspace. Everyone else (managers, analysts, viewers, custom) sees and
 * does only what an owner or admin granted them: their access lives in access.ts (`allows`), and
 * their role is just the template it was picked from.
 */
export const ROLES = ["owner", "admin", "manager", "analyst", "viewer", "custom"] as const;
export type Role = (typeof ROLES)[number];

export type Permission =
  | "dashboard:read"
  /** See shoppers' names, emails and phone numbers (fetched live from Shopify, never stored). */
  | "customers:contact"
  | "stores:manage"
  | "members:manage"
  | "apikeys:manage"
  | "billing:manage"
  | "audit:read"
  | "workspace:delete"
  /** Email integrations: the overview, connected accounts (never their credentials), domains, templates and rules. */
  | "email:read"
  /** Email activity: who was sent what, and what each automation did with each event. */
  | "email:activity"
  /** Write email templates and automation rules; dry runs and test sends to oneself. */
  | "email:automate"
  /** Connect, reconnect and disconnect sending accounts; domains, sender addresses, suppressions, event API keys. */
  | "email:manage";

const MATRIX: Record<Role, Permission[]> = {
  owner: [
    "dashboard:read",
    "customers:contact",
    "stores:manage",
    "members:manage",
    "apikeys:manage",
    "billing:manage",
    "audit:read",
    "workspace:delete",
    "email:read",
    "email:activity",
    "email:automate",
    "email:manage",
  ],
  admin: ["dashboard:read", "customers:contact", "stores:manage", "members:manage", "apikeys:manage", "audit:read", "email:read", "email:activity", "email:automate", "email:manage"],
  // Their access is the permissions granted to them (access.ts), never a fixed list: nothing here,
  // so a check that forgets to ask `allows` fails closed for them.
  manager: [],
  analyst: [],
  viewer: [],
  custom: [],
};

/** What an owner or admin may do. For anyone else ask `allows` (access.ts), which reads their permissions. */
export function can(role: Role, perm: Permission): boolean {
  return MATRIX[role].includes(perm);
}

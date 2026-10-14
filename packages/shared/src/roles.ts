export const ROLES = ["owner", "admin", "analyst", "viewer"] as const;
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
  // Analysts already see customers' contact details, so they may see who was emailed; they can't change anything.
  analyst: ["dashboard:read", "customers:contact", "email:read", "email:activity"],
  viewer: ["dashboard:read", "email:read"],
};

export function can(role: Role, perm: Permission): boolean {
  return MATRIX[role].includes(perm);
}

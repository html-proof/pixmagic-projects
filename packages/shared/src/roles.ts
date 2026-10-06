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
  | "workspace:delete";

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
  ],
  admin: ["dashboard:read", "customers:contact", "stores:manage", "members:manage", "apikeys:manage", "audit:read"],
  analyst: ["dashboard:read", "customers:contact"],
  viewer: ["dashboard:read"],
};

export function can(role: Role, perm: Permission): boolean {
  return MATRIX[role].includes(perm);
}

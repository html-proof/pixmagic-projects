// Team & Access: what a workspace member may see, and the few things they may change.
//
// Owners and admins have everything. Every other member (viewer, analyst, manager or custom) has
// exactly the permissions an owner or admin granted them from the catalog below. Their role is the
// template those were picked from, never a source of access of its own. The API checks these on
// every request (apps/api/src/context.ts) and leaves out of what it returns anything that isn't
// granted (`redactOverview`, `redactContacts`); the UI asks the same questions to decide what to
// show. A permission never gets round a Shopify scope the store hasn't granted: the dashboard's
// modules still need their scopes (capabilities.ts), and a permission only narrows that further.
//
// Imported by the UI through `@app/shared/access`: no I/O, relative imports stay extensionless.

import { adsFromShopifyWithoutAttribution, adsFromShopifyWithoutVisits, type AdsFromShopify } from "./adsFromShopify";
import { can as roleCan, type Permission, type Role } from "./roles";
import { MONTH_LINES } from "./sales";
import { shopifyMarketingWithoutCampaigns, type ShopifyMarketing } from "./shopifyMarketing";

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

export const ACCESS_MODULES = ["analytics", "customers", "products", "inventory", "orders", "marketing", "discounts", "finance", "integrations", "staff", "reports"] as const;
export type AccessModule = (typeof ACCESS_MODULES)[number];

export const ACCESS_KEYS = [
  "analytics.sales",
  "analytics.conversion",
  "analytics.abandonment",
  "analytics.behavior",
  "analytics.traffic",
  "customers.list",
  "customers.profiles",
  "customers.contact",
  "customers.orders",
  "customers.analytics",
  "products.view",
  "products.performance",
  "products.inventory",
  "products.prices",
  "inventory.view",
  "inventory.products",
  "inventory.costs",
  "inventory.history",
  "inventory.export",
  "inventory.adjust",
  "inventory.alerts",
  "inventory.settings",
  "orders.list",
  "orders.payments",
  "orders.fulfillment",
  "orders.cancellations",
  "marketing.ads",
  "marketing.campaigns",
  "marketing.attribution",
  "discounts.codes",
  "discounts.performance",
  "finance.breakdown",
  "finance.refunds",
  "finance.reports",
  "finance.costs",
  "integrations.status",
  "integrations.manage",
  "staff.team",
  "staff.timesheets",
  "staff.payroll",
  "staff.manage",
  "reports.view",
  "reports.export",
] as const;
export type AccessKey = (typeof ACCESS_KEYS)[number];

/** What a permission lets someone do: look, change something, or take data out of the app. */
export type AccessKind = "view" | "manage" | "export";

export interface AccessPermissionDef {
  key: AccessKey;
  module: AccessModule;
  label: string;
  /** Exactly what it shows (or lets them do) in the app, in the merchant's words. */
  reveals: string;
  kind: AccessKind;
  /**
   * Customers' personal data, money a store would keep private, payroll, managing integrations or
   * staff, and exports: never part of a role's template, so an owner or admin always ticks these
   * one by one.
   */
  sensitive?: boolean;
  /** Permissions that must be granted with this one (what it shows sits inside theirs). */
  requires?: AccessKey[];
}

export const ACCESS_MODULE_INFO: Record<AccessModule, { label: string; description: string }> = {
  analytics: { label: "Analytics", description: "Sales, conversion, busiest times and where orders come from." },
  customers: { label: "Customer details", description: "Who buys from the store. Personal details need their own permission." },
  products: { label: "Product details", description: "The catalog, best sellers and stock." },
  inventory: { label: "Inventory", description: "Stock at every location, product information, stock history and stock changes made in Shopify." },
  orders: { label: "Orders", description: "The store's orders and how they're getting on." },
  marketing: { label: "Marketing", description: "Advertising results, campaigns and attribution." },
  discounts: { label: "Discounts", description: "Discount codes and what they bring in." },
  finance: { label: "Finance", description: "The money detail behind the sales figures." },
  integrations: { label: "Integrations", description: "The accounts connected to bizinsights." },
  staff: { label: "Staff", description: "Staff Management: team, timesheets and payroll." },
  reports: { label: "Reports", description: "The business health report and downloads." },
};

export const ACCESS_PERMISSIONS: readonly AccessPermissionDef[] = [
  // ---- Analytics
  { key: "analytics.sales", module: "analytics", kind: "view", label: "View sales and revenue", reveals: "Net sales, orders, average order value, items sold and the daily trend." },
  { key: "analytics.conversion", module: "analytics", kind: "view", label: "View conversion rates", reveals: "Storefront visits, the steps from product view to order, conversion rate, and landing and exit pages." },
  { key: "analytics.abandonment", module: "analytics", kind: "view", label: "View checkout abandonment", reveals: "Checkouts left unfinished, with their value and items. No names or contact details." },
  { key: "analytics.behavior", module: "analytics", kind: "view", label: "View customer behavior", reveals: "When customers buy: orders by day of the week and hour of the day." },
  { key: "analytics.traffic", module: "analytics", kind: "view", label: "View traffic sources", reveals: "Orders and sales by sales channel and by where visitors came from." },
  // ---- Customers
  { key: "customers.list", module: "customers", kind: "view", label: "View customer list", reveals: "Recent customers and newsletter subscribers, by customer number and sign-up date only." },
  { key: "customers.profiles", module: "customers", kind: "view", sensitive: true, requires: ["customers.list"], label: "View customer profiles", reveals: "Customers' names and a link to each one in Shopify admin." },
  { key: "customers.contact", module: "customers", kind: "view", sensitive: true, requires: ["customers.list"], label: "View contact information", reveals: "Email addresses, phone numbers and abandoned-checkout recovery links." },
  { key: "customers.orders", module: "customers", kind: "view", requires: ["customers.list"], label: "View order history", reveals: "How many orders each customer has placed and how much they have spent." },
  { key: "customers.analytics", module: "customers", kind: "view", label: "View returning vs new customers", reveals: "How many customers ordered, and the share who had bought before." },
  // ---- Products
  { key: "products.view", module: "products", kind: "view", label: "View products", reveals: "The catalog: products by status, variants and best-selling vendors." },
  { key: "products.performance", module: "products", kind: "view", label: "View product performance", reveals: "Best sellers by revenue and units sold." },
  { key: "products.inventory", module: "products", kind: "view", label: "View inventory and stock", reveals: "Stock on hand, items running low or sold out, and how long stock will last." },
  { key: "products.prices", module: "products", kind: "view", sensitive: true, requires: ["products.inventory"], label: "View stock value and prices", reveals: "What the stock is worth at cost and at retail price." },
  // ---- Inventory
  { key: "inventory.view", module: "inventory", kind: "view", label: "View inventory", reveals: "Stock levels at every location, items running low or sold out, locations and the stock reports, in units." },
  { key: "inventory.products", module: "inventory", kind: "view", requires: ["inventory.view"], label: "View product information", reveals: "Product details: descriptions, images, variants, SKUs, barcodes, options, selling prices and shipping details." },
  {
    key: "inventory.costs",
    module: "inventory",
    kind: "view",
    sensitive: true,
    requires: ["inventory.view"],
    label: "View costs and stock value",
    reveals: "Cost per item, what the stock is worth at cost and at selling price, potential margin and inventory turnover; with the sales breakdown, Shopify's gross profit, cost of goods sold and margin.",
  },
  { key: "inventory.history", module: "inventory", kind: "view", requires: ["inventory.view"], label: "View stock history", reveals: "Every stock change bizinsights has seen, and the changes made in bizinsights with who made them." },
  { key: "inventory.export", module: "inventory", kind: "export", sensitive: true, requires: ["inventory.view"], label: "Export inventory", reveals: "Download the stock list as a CSV file, with costs only for someone who may also see them." },
  { key: "inventory.adjust", module: "inventory", kind: "manage", sensitive: true, requires: ["inventory.view"], label: "Adjust stock", reveals: "Change stock in Shopify: stock received, corrections, stock counts and damaged stock." },
  { key: "inventory.alerts", module: "inventory", kind: "manage", sensitive: true, requires: ["inventory.view"], label: "Manage stock alerts", reveals: "Low-stock thresholds, and how the team is told about low and sold-out stock (email, WhatsApp, the bell)." },
  { key: "inventory.settings", module: "inventory", kind: "manage", sensitive: true, requires: ["inventory.view"], label: "Manage inventory settings", reveals: "How often stock is checked against Shopify, and the lead time and cover used for restock suggestions." },
  // ---- Orders
  { key: "orders.list", module: "orders", kind: "view", label: "View order list", reveals: "The orders placed in the dates picked: order number, date, total, items and sales channel." },
  { key: "orders.payments", module: "orders", kind: "view", requires: ["orders.list"], label: "View payment status", reveals: "Whether each order is paid, pending, refunded or failed." },
  { key: "orders.fulfillment", module: "orders", kind: "view", label: "View fulfillment status", reveals: "Orders waiting to ship, how quickly orders ship, and each order's fulfillment status." },
  { key: "orders.cancellations", module: "orders", kind: "view", requires: ["orders.list"], label: "View cancellations", reveals: "Which orders were cancelled." },
  // ---- Marketing
  { key: "marketing.ads", module: "marketing", kind: "view", label: "View advertising analytics", reveals: "Meta and Google Ads spend, clicks, conversions and return on ad spend, and AdSense earnings." },
  { key: "marketing.campaigns", module: "marketing", kind: "view", label: "View campaigns and their performance", reveals: "Results per ad campaign, and WhatsApp campaigns, automations, templates and settings, and their results. Customers' numbers and messages need \"View contact information\" too." },
  { key: "marketing.attribution", module: "marketing", kind: "view", requires: ["analytics.traffic"], label: "View conversion attribution", reveals: "Orders and sales that came from paid traffic and from each UTM campaign." },
  // ---- Discounts
  { key: "discounts.codes", module: "discounts", kind: "view", label: "View discount codes and usage", reveals: "Which discount codes were used, and on how many orders." },
  { key: "discounts.performance", module: "discounts", kind: "view", requires: ["discounts.codes"], label: "View discount performance", reveals: "How much each code took off, and the sales it came with." },
  // ---- Finance
  { key: "finance.breakdown", module: "finance", kind: "view", sensitive: true, requires: ["analytics.sales"], label: "View gross sales, discounts, tax, shipping and total sales", reveals: "How total sales add up: gross sales, discounts and returns to net sales, plus shipping, duties, fees and tax, the store's Custom sales calculation, the check against Shopify's sales report, and the store's own costs (Settings → Costs). Without it, the headline shows net sales. Shopify's gross profit and cost of goods sold need \"View costs and stock value\" too." },
  { key: "finance.refunds", module: "finance", kind: "view", sensitive: true, requires: ["analytics.sales"], label: "View refunds", reveals: "Returns (money refunded, cancelled or edited out), the return rate and how many orders had one." },
  { key: "finance.reports", module: "finance", kind: "view", sensitive: true, requires: ["analytics.sales"], label: "View financial reports", reveals: "This year's sales month by month, compared with last year." },
  {
    key: "finance.costs",
    module: "finance",
    kind: "manage",
    sensitive: true,
    requires: ["finance.breakdown"],
    label: "Manage costs",
    reveals: "Add, change, pause and remove the store's own costs on Profit & Loss and in Settings → Costs: one-off and recurring costs, their payments, the store's own cost categories, and from which day the list is complete. Every change is in the audit log.",
  },
  // ---- Integrations
  { key: "integrations.status", module: "integrations", kind: "view", label: "View integration connection status", reveals: "Which store, ad and WhatsApp accounts are connected and whether they work. Never passwords, tokens or keys." },
  {
    key: "integrations.manage",
    module: "integrations",
    kind: "manage",
    sensitive: true,
    requires: ["integrations.status"],
    label: "Manage integrations",
    reveals:
      "Connect, refresh and disconnect ad accounts and the WhatsApp number, and connect the store to Zapier (its Zaps then get what this person may see). The Shopify store itself stays with owners and admins.",
  },
  // ---- Staff
  { key: "staff.team", module: "staff", kind: "view", label: "View team information", reveals: "Employees' names, positions, departments and status." },
  { key: "staff.timesheets", module: "staff", kind: "view", requires: ["staff.team"], label: "View timesheets", reveals: "Who is working now, and every employee's timesheets." },
  { key: "staff.payroll", module: "staff", kind: "view", sensitive: true, requires: ["staff.team"], label: "View payroll information", reveals: "Pay rates, earnings, payroll runs and payment records." },
  { key: "staff.manage", module: "staff", kind: "manage", sensitive: true, requires: ["staff.team", "staff.timesheets"], label: "Manage staff", reveals: "Add and edit employees, send invitations, plan schedules, and correct and approve timesheets." },
  // ---- Reports
  { key: "reports.view", module: "reports", kind: "view", label: "View reports", reveals: "The business health report and printable summary, covering only the areas granted above." },
  { key: "reports.export", module: "reports", kind: "export", sensitive: true, label: "Export approved reports", reveals: "Download CSV files of the dashboard sections this person can see, and Staff reports they can open." },
];

const BY_KEY = new Map(ACCESS_PERMISSIONS.map((p) => [p.key, p]));

/**
 * The store data (capabilities.ts) each permission shows (any of several). A permission whose data
 * no connected store has granted bizinsights can still be given (the store may grant it later), and
 * the team page says it shows nothing yet: a permission never gets round a Shopify scope.
 */
export const ACCESS_CAPABILITY: Partial<Record<AccessKey, string | readonly string[]>> = {
  "analytics.sales": "sales_overview",
  // The pixel's funnel, or Shopify's own sessions and visitors on the same page (read_reports).
  "analytics.conversion": ["funnel", "shopify_sessions"],
  // Shopify's abandoned checkouts, counted (read_orders); the list with who left them is the customers'.
  "analytics.abandonment": "abandoned_checkouts",
  "analytics.behavior": "order_timing",
  "analytics.traffic": "channels",
  "customers.list": "contacts",
  "customers.profiles": "contacts",
  "customers.contact": "contacts",
  "customers.orders": "contacts",
  "customers.analytics": "customers",
  "products.view": "catalog",
  "products.performance": "top_products",
  "products.inventory": "inventory",
  "products.prices": "inventory",
  "inventory.view": "stock_levels",
  "inventory.products": "catalog",
  "inventory.costs": "stock_levels",
  "inventory.history": "stock_levels",
  "inventory.export": "stock_levels",
  "inventory.adjust": "stock_adjustments",
  "inventory.alerts": "stock_levels",
  "inventory.settings": "stock_levels",
  "orders.list": "recent_orders",
  "orders.payments": "recent_orders",
  "orders.fulfillment": "fulfillment",
  "orders.cancellations": "recent_orders",
  "marketing.attribution": "channels",
  "discounts.codes": "discount_codes",
  "discounts.performance": "discount_codes",
  "finance.breakdown": "sales_overview",
  "finance.refunds": "refunds",
  "finance.reports": "sales_overview",
  "finance.costs": "sales_overview",
};

/** Whether a permission shows anything, given the store data (capability ids) a connected store has granted. */
export function accessAvailable(key: AccessKey, granted: ReadonlySet<string>): boolean {
  const data = ACCESS_CAPABILITY[key];
  if (data === undefined) return true;
  return (typeof data === "string" ? [data] : data).some((c) => granted.has(c));
}

export const isAccessKey = (s: string): s is AccessKey => BY_KEY.has(s as AccessKey);
export const accessPermission = (key: AccessKey): AccessPermissionDef => BY_KEY.get(key)!;
export const permissionsOf = (module: AccessModule) => ACCESS_PERMISSIONS.filter((p) => p.module === module);

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

/** The roles whose access is the list of permissions granted to them (everyone but owners and admins). */
export const RESTRICTED_ROLES = ["viewer", "analyst", "manager", "custom"] as const satisfies readonly Role[];
export type RestrictedRole = (typeof RESTRICTED_ROLES)[number];

export const hasFullAccess = (role: Role) => role === "owner" || role === "admin";
export const isRestrictedRole = (role: string): role is RestrictedRole => (RESTRICTED_ROLES as readonly string[]).includes(role);

export const ROLE_INFO: Record<Role, { label: string; description: string }> = {
  owner: { label: "Owner", description: "Everything, including billing, ownership and deleting the workspace." },
  admin: { label: "Admin", description: "Everything except billing and ownership, including managing the team." },
  manager: { label: "Manager", description: "The information you choose, plus management tasks you approve one by one." },
  analyst: { label: "Analyst", description: "Read-only access to the analytics and reports you choose." },
  viewer: { label: "Viewer", description: "Read-only access to the information you choose." },
  custom: { label: "Custom", description: "Exactly the permissions you tick, nothing preselected." },
};

/**
 * What each role ticks to start with. Nothing sensitive is ever here (customers' personal data,
 * finance, payroll, managing anything, exports): those are always picked one by one.
 */
export const ROLE_TEMPLATES: Record<RestrictedRole, readonly AccessKey[]> = {
  viewer: ["analytics.sales", "products.view", "products.performance", "products.inventory", "inventory.view", "inventory.products", "orders.list", "discounts.codes", "reports.view"],
  analyst: [
    "analytics.sales",
    "analytics.conversion",
    "analytics.abandonment",
    "analytics.behavior",
    "analytics.traffic",
    "customers.analytics",
    "products.view",
    "products.performance",
    "products.inventory",
    "inventory.view",
    "inventory.products",
    "inventory.history",
    "orders.list",
    "orders.payments",
    "orders.fulfillment",
    "orders.cancellations",
    "marketing.ads",
    "marketing.campaigns",
    "marketing.attribution",
    "discounts.codes",
    "discounts.performance",
    "reports.view",
  ],
  manager: [
    "analytics.sales",
    "analytics.conversion",
    "analytics.abandonment",
    "analytics.behavior",
    "analytics.traffic",
    "customers.list",
    "customers.orders",
    "customers.analytics",
    "products.view",
    "products.performance",
    "products.inventory",
    "inventory.view",
    "inventory.products",
    "inventory.history",
    "orders.list",
    "orders.payments",
    "orders.fulfillment",
    "orders.cancellations",
    "marketing.ads",
    "marketing.campaigns",
    "marketing.attribution",
    "discounts.codes",
    "discounts.performance",
    "integrations.status",
    "staff.team",
    "staff.timesheets",
    "reports.view",
  ],
  custom: [],
};

/** Viewers and analysts only ever look: management permissions need the Manager or Custom role. */
export const roleAllowsKind = (role: RestrictedRole, kind: AccessKind) => kind !== "manage" || role === "manager" || role === "custom";

/**
 * What analysts and viewers could see before Team & Access, as permissions: everything on the
 * dashboard, and for analysts customers' contact details too. Migration 20261016180000 gave these
 * to existing analysts and viewers, and the old invitation endpoint still uses them, so nobody lost
 * or gained access by the change. Workspace API keys (read-only) see what viewers saw.
 */
export const LEGACY_GRANTS: Record<"viewer" | "analyst", readonly AccessKey[]> = {
  viewer: [
    "analytics.sales",
    "analytics.conversion",
    "analytics.behavior",
    "analytics.traffic",
    "customers.analytics",
    "products.view",
    "products.performance",
    "products.inventory",
    "products.prices",
    "orders.list",
    "orders.payments",
    "orders.fulfillment",
    "orders.cancellations",
    "marketing.ads",
    "marketing.campaigns",
    "marketing.attribution",
    "discounts.codes",
    "discounts.performance",
    "finance.breakdown",
    "finance.refunds",
    "finance.reports",
    "integrations.status",
    "reports.view",
  ],
  analyst: [
    "analytics.sales",
    "analytics.conversion",
    "analytics.abandonment",
    "analytics.behavior",
    "analytics.traffic",
    "customers.list",
    "customers.profiles",
    "customers.contact",
    "customers.orders",
    "customers.analytics",
    "products.view",
    "products.performance",
    "products.inventory",
    "products.prices",
    "orders.list",
    "orders.payments",
    "orders.fulfillment",
    "orders.cancellations",
    "marketing.ads",
    "marketing.campaigns",
    "marketing.attribution",
    "discounts.codes",
    "discounts.performance",
    "finance.breakdown",
    "finance.refunds",
    "finance.reports",
    "integrations.status",
    "reports.view",
  ],
};

export type GrantProblem =
  | { code: "unknown_permission"; key: string }
  | { code: "missing_requirement"; key: AccessKey; requires: AccessKey }
  | { code: "role_cannot_manage"; key: AccessKey; role: RestrictedRole }
  | { code: "not_restricted"; role: Role };

/**
 * Check a set of permissions for a role. Returns them sorted and without duplicates, or the first
 * problem: an unknown key, a permission without the one it sits inside, or a management permission
 * on a viewer or analyst. Nothing is ever added to make a set valid: that would grant more than the
 * owner or admin ticked.
 */
export function checkGrants(role: Role, keys: readonly string[]): { ok: true; keys: AccessKey[] } | { ok: false; problem: GrantProblem } {
  if (!isRestrictedRole(role)) return keys.length ? { ok: false, problem: { code: "not_restricted", role } } : { ok: true, keys: [] };
  const set = new Set<AccessKey>();
  for (const k of keys) {
    if (!isAccessKey(k)) return { ok: false, problem: { code: "unknown_permission", key: k } };
    set.add(k);
  }
  for (const k of set) {
    const def = accessPermission(k);
    for (const r of def.requires ?? []) if (!set.has(r)) return { ok: false, problem: { code: "missing_requirement", key: k, requires: r } };
    if (!roleAllowsKind(role, def.kind)) return { ok: false, problem: { code: "role_cannot_manage", key: k, role } };
  }
  return { ok: true, keys: ACCESS_KEYS.filter((k) => set.has(k)) };
}

/**
 * Ticking a permission in the editor: it comes with the ones it sits inside (ticking "View contact
 * information" ticks "View customer list"), so what is shown is always a set `checkGrants` accepts.
 */
export function addPermission(keys: Iterable<string>, key: AccessKey): Set<AccessKey> {
  const out = new Set<AccessKey>([...keys].filter(isAccessKey));
  const add = (k: AccessKey) => {
    if (out.has(k)) return;
    out.add(k);
    for (const r of accessPermission(k).requires ?? []) add(r);
  };
  add(key);
  return out;
}

/** Unticking one: whatever sits inside it goes too (unticking "View customer list" unticks contact details). */
export function removePermission(keys: Iterable<string>, key: AccessKey): Set<AccessKey> {
  const out = new Set<AccessKey>([...keys].filter(isAccessKey));
  const drop = (k: AccessKey) => {
    if (!out.delete(k)) return;
    for (const p of ACCESS_PERMISSIONS) if (p.requires?.includes(k)) drop(p.key);
  };
  drop(key);
  return out;
}

export function describeGrantProblem(p: GrantProblem): string {
  switch (p.code) {
    case "unknown_permission":
      return `"${p.key}" isn't a permission bizinsights knows.`;
    case "missing_requirement":
      return `"${accessPermission(p.key).label}" needs "${accessPermission(p.requires).label}" as well.`;
    case "role_cannot_manage":
      return `${ROLE_INFO[p.role].label}s only view information: "${accessPermission(p.key).label}" needs the Manager or Custom role.`;
    case "not_restricted":
      return `${ROLE_INFO[p.role].label}s already have full access: there are no permissions to choose.`;
  }
}

// ---------------------------------------------------------------------------
// One member's access
// ---------------------------------------------------------------------------

/** A member's access as the API reports it (GET /me, GET /workspaces/:ws/access). */
export interface MemberAccess {
  role: Role;
  /** Granted permissions (restricted roles only; owners and admins have every one). */
  permissions: readonly string[];
}

/** Every permission this member holds: all of them for owners and admins. */
export function grantedKeys(access: MemberAccess): Set<AccessKey> {
  if (hasFullAccess(access.role)) return new Set(ACCESS_KEYS);
  return new Set(access.permissions.filter(isAccessKey));
}

/**
 * The workspace-wide permissions (roles.ts) for a restricted member, read from their grants. Only
 * looking is ever implied: stores, members, API keys, billing and the audit log stay with
 * owners and admins. Routes that need finer rules ask for permissions directly.
 */
const COARSE: Record<Permission, (g: ReadonlySet<AccessKey>) => boolean> = {
  // Their own notification settings, the store picker, the bell: what every member needs.
  "dashboard:read": () => true,
  "customers:contact": (g) => g.has("customers.contact"),
  "stores:manage": () => false,
  "members:manage": () => false,
  "apikeys:manage": () => false,
  "billing:manage": () => false,
  "audit:read": () => false,
  "workspace:delete": () => false,
};

/** What an API route or a page asks for: a workspace permission, one of the catalog's, or any of several of the catalog's. */
export type AccessNeed = Permission | AccessKey | readonly AccessKey[];

/** Whether this member may do what `need` names. */
export function allows(access: MemberAccess, need: AccessNeed): boolean {
  if (hasFullAccess(access.role)) {
    // Owners and admins hold every permission of the catalog; workspace permissions differ between them (billing).
    if (typeof need === "string" && !isAccessKey(need)) return roleCan(access.role, need);
    return true;
  }
  const g = grantedKeys(access);
  if (typeof need !== "string") return need.some((k) => g.has(k));
  if (isAccessKey(need)) return g.has(need);
  return COARSE[need](g);
}

/**
 * What a session opened from a shared link may use: the member's access with nothing that changes
 * anything (no "manage" permission). An owner or admin opening their link gets every view and export
 * permission, as a viewer: the link is a bearer credential, so managing the team, stores, billing or
 * integrations always needs a sign-in of their own.
 */
export function linkSessionAccess(access: MemberAccess): MemberAccess {
  const keys = hasFullAccess(access.role) ? ACCESS_KEYS : access.permissions.filter(isAccessKey);
  return { role: hasFullAccess(access.role) ? "viewer" : access.role, permissions: keys.filter((k) => accessPermission(k).kind !== "manage") };
}

/** The modules a member has any permission in, in catalog order. */
export function modulesOf(access: MemberAccess): AccessModule[] {
  const g = grantedKeys(access);
  return ACCESS_MODULES.filter((m) => permissionsOf(m).some((p) => g.has(p.key)));
}

// ---------------------------------------------------------------------------
// The dashboard's data (GET .../overview), cut down to a member's permissions
// ---------------------------------------------------------------------------

/** Each dashboard module (packages/core/src/reports) and the permissions that let someone see it (any of). */
export const OVERVIEW_MODULE_ACCESS = {
  sales_overview: ["analytics.sales"],
  refunds: ["finance.refunds"],
  customers: ["customers.analytics"],
  top_products: ["products.performance"],
  funnel: ["analytics.conversion"],
  channels: ["analytics.traffic"],
  traffic: ["analytics.traffic"],
  // Meta's and Google's sales from the store's own orders (adsFromShopify.ts): orders by where their
  // visit came from, on the Advertising pages; their tagged-ad figures need attribution (redactFields).
  ads_from_shopify: ["analytics.traffic"],
  order_timing: ["analytics.behavior"],
  fulfillment: ["orders.fulfillment"],
  discount_codes: ["discounts.codes"],
  recent_orders: ["orders.list"],
  // Orders at a glance (OrderOutcomes in ./orders.ts): its payment, shipping and checkout parts each
  // need their own permission (redactFields), so it is shown with any of them.
  order_outcomes: ["orders.list", "orders.fulfillment", "analytics.abandonment"],
  inventory: ["products.inventory"],
  // The Inventory module's own Shopify access (capabilities.ts): its pages, not the dashboard's.
  stock_levels: ["inventory.view"],
  stock_adjustments: ["inventory.adjust"],
  catalog: ["products.view"],
  ads: ["marketing.ads"],
  adsense: ["marketing.ads"],
  ad_connections: ["marketing.ads"],
  ad_configured: ["marketing.ads"],
  // Where Meta's and Google's figures come from (adPlatformSources): the platform's own, or the store's orders.
  ad_sources: ["marketing.ads"],
  // The ad spend, impressions and clicks the store's marketing apps report to Shopify (shopifyMarketing.ts):
  // ad figures like the ads module's, their campaigns with the campaigns permission (redactFields).
  shopify_marketing: ["marketing.ads"],
  // Shopify's own figures (packages/core/src/reports/shopify.ts): its sessions with the funnel, its
  // gross profit and the check of the sales figures against its sales report with the breakdown
  // (gross profit with the costs permission too, OVERVIEW_MODULE_ALSO_NEEDS).
  shopify_sessions: ["analytics.conversion"],
  profit: ["finance.breakdown"],
  // The product costs worked out from each product's cost per item when Shopify's report gives none
  // (productCosts in packages/core/src/reports/products.ts): costs too, as the gross profit is.
  product_costs: ["finance.breakdown"],
  shopify_check: ["finance.breakdown"],
  // The owner's own costs (Settings → Costs): money figures that go with the sales breakdown; Shopify's
  // cost of goods sold beside them needs "View costs and stock value" too (OVERVIEW_MODULE_ALSO_NEEDS).
  expenses: ["finance.breakdown"],
  // Not modules of the overview: the live customer lists (GET .../contacts) and Shopify's abandoned
  // checkouts counted (GET .../abandoned-checkouts, the Shopping Funnel's card), named here so the
  // dashboard's capability list can say whether this member gets them at all.
  contacts: ["customers.list", "analytics.abandonment"],
  abandoned_checkouts: ["analytics.abandonment"],
} as const satisfies Record<string, readonly AccessKey[]>;

/**
 * Modules that need these as well (every one), on top of one of OVERVIEW_MODULE_ACCESS's. Shopify's
 * gross profit is its cost of goods sold against net sales: costs, which are shown to no one without
 * "View costs and stock value", as on the Inventory pages.
 */
const OVERVIEW_MODULE_ALSO_NEEDS: Partial<Record<keyof typeof OVERVIEW_MODULE_ACCESS, readonly AccessKey[]>> = {
  profit: ["inventory.costs"],
  product_costs: ["inventory.costs"],
};

export function seesModule(access: MemberAccess, module: string): boolean {
  const need = (OVERVIEW_MODULE_ACCESS as Record<string, readonly AccessKey[]>)[module];
  // A module this list doesn't know is never shown to a restricted member: new data starts closed.
  if (!need) return hasFullAccess(access.role);
  const also = (OVERVIEW_MODULE_ALSO_NEEDS as Record<string, readonly AccessKey[]>)[module] ?? [];
  return allows(access, need) && also.every((k) => allows(access, k));
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** `o` without `keys` (a shallow copy; `o` itself is not changed). */
function omit(o: unknown, keys: readonly string[]): unknown {
  if (!isObj(o)) return o;
  const out: Obj = { ...o };
  for (const k of keys) delete out[k];
  return out;
}

/**
 * `year` (this year month by month) without `keys` in any month: its own months and those of the
 * years before it it is compared with (`past`). Anything else comes back as it is.
 */
function omitFromMonths(year: unknown, keys: readonly string[]): unknown {
  const cut = (y: unknown) => (isObj(y) && Array.isArray(y.months) ? { ...y, months: y.months.map((m: unknown) => omit(m, keys)) } : y);
  const out = cut(year);
  return isObj(out) && Array.isArray(out.past) ? { ...out, past: out.past.map(cut) } : out;
}

/**
 * The fields of an order row (the overview's recent orders, the order list's orders) that need a
 * permission past "View order list", and that permission. Filtering the order list on one of them
 * needs it too, or the filter would tell what the field hides (GET .../orders).
 */
export const ORDER_FIELD_ACCESS = {
  financialStatus: "orders.payments",
  fulfillmentStatus: "orders.fulfillment",
  cancelled: "orders.cancellations",
} as const satisfies Record<string, AccessKey>;
type OrderField = keyof typeof ORDER_FIELD_ACCESS;

/** The order row fields a member with these permissions isn't shown. */
const hiddenOrderFields = (g: ReadonlySet<AccessKey>): OrderField[] => (Object.keys(ORDER_FIELD_ACCESS) as OrderField[]).filter((f) => !g.has(ORDER_FIELD_ACCESS[f]));

/** An order row with the fields of ORDER_FIELD_ACCESS possibly left out. */
export type RedactedOrderRow<T> = Omit<T, OrderField> & Partial<Pick<T, Extract<keyof T, OrderField>>>;

/**
 * Order rows as this member may see them: without each field of ORDER_FIELD_ACCESS whose permission
 * they weren't granted. The overview's recent orders go through the same rule (`redactOverview`).
 * Owners and admins get every field.
 */
export function redactOrderRows<T extends object>(rows: readonly T[], access: MemberAccess): Array<RedactedOrderRow<T>> {
  const drop = hiddenOrderFields(grantedKeys(access));
  return drop.length ? rows.map((r) => omit(r, drop) as RedactedOrderRow<T>) : [...rows];
}

/**
 * The fields inside a module that need a permission of their own, and the parts of the module they
 * live in. Applied after the modules themselves are cut down.
 */
function redactFields(modules: Obj, g: ReadonlySet<AccessKey>): Obj {
  const out: Obj = { ...modules };
  const sales = out.sales_overview;
  if (isObj(sales)) {
    let s: Obj = { ...sales };
    if (!g.has("finance.breakdown")) {
      // Total sales is net sales plus tax, shipping, duties and fees, so it goes with them, every
      // day too, and so does the store's own calculation from those lines (Custom sales).
      const lines = ["tax", "shipping", "duties", "additionalFees", "totalSales"];
      s = {
        ...s,
        // What refunds took off total sales holds their tax and shipping too.
        current: omit(s.current, ["grossSales", "discounts", "totalRefunded", ...lines]),
        previous: omit(s.previous, ["grossSales", ...lines]),
        deltas: omit(s.deltas, ["grossSales", "totalSales"]),
      };
      if (Array.isArray(s.series)) s.series = s.series.map((d: unknown) => omit(d, ["grossSales", "discounts", ...lines]));
      if (Array.isArray(s.previousSeries)) s.previousSeries = s.previousSeries.map((d: unknown) => omit(d, ["totalSales"]));
      // This year month by month ("View financial reports") keeps its net sales, without the lines.
      if (s.year !== undefined) s.year = omitFromMonths(s.year, MONTH_LINES);
      delete s.calculation;
    }
    if (!g.has("finance.reports")) delete s.year;
    // Returns are refunds (and cancellations and edits), for the range, each day and each month.
    if (!g.has("finance.refunds")) {
      s = { ...s, current: omit(s.current, ["returns", "totalRefunded"]) };
      if (Array.isArray(s.series)) s.series = s.series.map((d: unknown) => omit(d, ["refunds"]));
      if (s.year !== undefined) s.year = omitFromMonths(s.year, ["refunds"]);
    }
    // Which orders were a customer's first: the customers module's figure (new and returning customers), day by day too.
    if (!g.has("customers.analytics") && Array.isArray(s.series)) s.series = s.series.map((d: unknown) => omit(d, ["newCustomerOrders"]));
    out.sales_overview = s;
  }
  const inv = out.inventory;
  if (isObj(inv) && !g.has("products.prices")) out.inventory = { ...inv, current: omit(inv.current, ["stockValueAtCost", "variantsWithCost", "retailValue"]) };
  const recent = out.recent_orders;
  if (isObj(recent) && Array.isArray(recent.items)) {
    // The order list's rule (redactOrderRows).
    const drop = hiddenOrderFields(g);
    // How many orders were cancelled in the dates is cancellation detail too.
    if (drop.length) out.recent_orders = { ...((g.has("orders.cancellations") ? recent : omit(recent, ["cancelledInRange"])) as Obj), items: recent.items.map((i: unknown) => omit(i, drop)) };
  }
  // How the dates' orders went: paid or not is payment status, cancelled ones cancellations, and the
  // count of orders goes with seeing orders or their shipping at all.
  const outcomes = out.order_outcomes;
  if (isObj(outcomes)) {
    const drop = [
      ...(g.has("orders.payments") && g.has("orders.cancellations") ? [] : ["outcome"]),
      ...(g.has("orders.fulfillment") ? [] : ["shipping"]),
      ...(g.has("analytics.abandonment") ? [] : ["checkouts"]),
      ...(g.has("orders.list") || g.has("analytics.sales") || g.has("orders.fulfillment") ? [] : ["orders"]),
    ];
    if (drop.length) out.order_outcomes = omit(outcomes, drop);
  }
  // The Shopping Funnel's visits by where they came from: the traffic sources permission's, like orders by source.
  const funnel = out.funnel;
  if (isObj(funnel) && !g.has("analytics.traffic")) {
    out.funnel = {
      ...funnel,
      ...(isObj(funnel.segments) ? { segments: omit(funnel.segments, ["source"]) } : {}),
      ...(isObj(funnel.filter) ? { filter: omit(funnel.filter, ["source"]) } : {}),
    };
  }
  const traffic = out.traffic;
  if (isObj(traffic) && !g.has("marketing.attribution")) {
    out.traffic = {
      ...(omit(traffic, ["paid", "campaigns", "split"]) as Obj),
      items: Array.isArray(traffic.items) ? traffic.items.map((i: unknown) => omit(i, ["paidOrders", "paidSales"])) : traffic.items,
    };
  }
  const ads = out.ads;
  if (isObj(ads) && !g.has("marketing.campaigns")) out.ads = omit(ads, ["campaigns"]);
  // The campaigns the marketing apps report to Shopify, as the ad accounts' campaigns.
  const marketing = out.shopify_marketing;
  if (isObj(marketing) && !g.has("marketing.campaigns")) out.shopify_marketing = shopifyMarketingWithoutCampaigns(marketing as unknown as ShopifyMarketing) as unknown as Obj;
  // Orders Shopify's visit record credits to each platform's ads: attribution, like the traffic module's paid figures.
  if (isObj(out.ads) && !g.has("marketing.attribution")) out.ads = omit(out.ads, ["sourced"]);
  // The same from the store's orders alone, for a platform not connected: its tagged-ad figures and campaigns.
  if (isObj(out.ads_from_shopify) && !g.has("marketing.attribution")) out.ads_from_shopify = adsFromShopifyWithoutAttribution(out.ads_from_shopify as unknown as AdsFromShopify);
  // Its storefront visits from each platform's sites: the Shopping Funnel's visits, "View conversion rates".
  if (isObj(out.ads_from_shopify) && !g.has("analytics.conversion")) out.ads_from_shopify = adsFromShopifyWithoutVisits(out.ads_from_shopify as unknown as AdsFromShopify);
  const codes = out.discount_codes;
  if (isObj(codes) && Array.isArray(codes.items) && !g.has("discounts.performance")) {
    out.discount_codes = { ...codes, items: codes.items.map((i: unknown) => omit(i, ["discount", "sales"])) };
  }
  return out;
}

/**
 * The dashboard's answer as this member may see it: only the modules they were granted, and inside
 * those only the fields they were granted; the store's capability list cut to the same modules.
 * Owners and admins get it unchanged. The API computes only the modules a member may see in the
 * first place (core's storeOverview takes `seesModule`); this is the last word on what leaves.
 */
export function redactOverview<T extends { modules: Obj; capabilities: Array<{ id: string }>; data?: unknown }>(report: T, access: MemberAccess): T {
  if (hasFullAccess(access.role)) return report;
  const g = grantedKeys(access);
  const modules: Obj = {};
  for (const [k, v] of Object.entries(report.modules)) if (seesModule(access, k)) modules[k] = v;
  const out: T = { ...report, modules: redactFields(modules, g), capabilities: report.capabilities.filter((c) => seesModule(access, c.id)) };
  // How much of the store was imported: order counts and dates with sales or orders, product
  // counts with products, so the store's size doesn't leak to someone who sees neither.
  if (isObj(report.data)) {
    const seesOrders = g.has("analytics.sales") || g.has("orders.list");
    const seesProducts = g.has("products.view") || g.has("products.performance") || g.has("products.inventory");
    out.data = omit(report.data, [...(seesOrders ? [] : ["orders", "oldestOrderDay", "newestOrderDay", "historyFrom", "history"]), ...(seesProducts ? [] : ["products", "variants"])]);
  }
  return out;
}

/** Who a customer list row is, before redaction (see apps/api/src/routes/contacts.ts). */
interface ContactRow {
  customerId: string | null;
  name: string | null;
  email: string | null;
  phone: string | null;
  subscribed: boolean;
  smsSubscribed: boolean;
  adminUrl: string | null;
}

/**
 * A customer list row as this member may see it: personal details only with their own permission.
 * Without "View customer profiles" no name or Shopify link; without "View contact
 * information" no email, phone or checkout recovery link; without "View order history" no order
 * count or amount spent.
 */
export function redactContact<R extends ContactRow & { orders?: number | null; spent?: number | null; recoveryUrl?: string | null }>(row: R, access: MemberAccess): R {
  if (hasFullAccess(access.role)) return row;
  const g = grantedKeys(access);
  const out: R = { ...row };
  if (!g.has("customers.profiles")) Object.assign(out, { name: null, adminUrl: null });
  if (!g.has("customers.contact")) {
    Object.assign(out, { email: null, phone: null });
    if ("recoveryUrl" in out) Object.assign(out, { recoveryUrl: null });
  }
  if (!g.has("customers.orders") && "orders" in out) Object.assign(out, { orders: null, spent: null });
  return out;
}

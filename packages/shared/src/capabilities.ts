/**
 * Capability registry. A dashboard module is shown only when the store's
 * *actually granted* scopes (persisted from the OAuth token exchange, refreshed
 * on app/scopes_update) satisfy the module's requirements. No module ever falls
 * back to placeholder data.
 */
export type ModuleId =
  | "sales_overview"
  | "refunds"
  | "top_products"
  | "customers"
  | "funnel"
  | "contacts"
  | "channels"
  | "order_timing"
  | "fulfillment"
  | "discount_codes"
  | "recent_orders"
  | "inventory"
  | "catalog";

export interface CapabilityDef {
  id: ModuleId;
  title: string;
  description: string;
  /** All of these scopes must be granted. */
  requiredScopes: string[];
  /** Extra non-scope prerequisites (e.g. web pixel installed). */
  requires?: Array<"pixel_installed">;
}

export const CAPABILITIES: readonly CapabilityDef[] = [
  {
    id: "sales_overview",
    title: "Sales overview",
    description: "Gross and net sales, orders and average order value.",
    requiredScopes: ["read_orders"],
  },
  {
    id: "refunds",
    title: "Refunds",
    description: "How much money went back to customers, and how often.",
    requiredScopes: ["read_orders"],
  },
  {
    id: "top_products",
    title: "Top products",
    description: "Which products bring in the most revenue.",
    requiredScopes: ["read_orders", "read_products"],
  },
  {
    id: "customers",
    title: "New vs returning",
    description: "Share of orders that come from repeat customers.",
    requiredScopes: ["read_orders", "read_customers"],
  },
  {
    id: "channels",
    title: "Sales by channel",
    description: "Where orders come from: online store, point of sale, draft orders, other apps.",
    requiredScopes: ["read_orders"],
  },
  {
    id: "order_timing",
    title: "When customers buy",
    description: "Orders by day of the week and hour of the day, in the store's time zone.",
    requiredScopes: ["read_orders"],
  },
  {
    id: "fulfillment",
    title: "Fulfillment",
    description: "Orders waiting to ship and how quickly orders get fulfilled.",
    requiredScopes: ["read_orders"],
  },
  {
    id: "discount_codes",
    title: "Discount codes",
    description: "Which discount codes are used most and what they cost.",
    requiredScopes: ["read_orders"],
  },
  {
    id: "recent_orders",
    title: "Recent orders",
    description: "The latest orders with their payment and fulfillment status.",
    requiredScopes: ["read_orders"],
  },
  {
    id: "inventory",
    title: "Inventory",
    description: "Stock on hand, stock value and items about to run out.",
    requiredScopes: ["read_products"],
  },
  {
    id: "catalog",
    title: "Catalog",
    description: "Products by status and the vendors that sell best.",
    requiredScopes: ["read_products"],
  },
  {
    id: "contacts",
    title: "Customers to follow up",
    description: "Shoppers who left their email at checkout without buying, and newsletter sign-ups, so you can get back in touch.",
    requiredScopes: ["read_orders", "read_customers"],
  },
  {
    id: "funnel",
    title: "Shopping funnel",
    description: "How visitors move from viewing products to completing checkout.",
    requiredScopes: ["write_pixels", "read_customer_events"],
    requires: ["pixel_installed"],
  },
];

/**
 * Plain-language names for the scopes we ask for. `read_customer_events` is Shopify's
 * vocabulary, not a merchant's, so anything merchant-facing leads with the label and keeps the
 * raw scope as secondary detail (a tooltip, support copy) rather than as the heading.
 */
export const SCOPE_LABELS: Record<string, { title: string; description: string }> = {
  read_orders: {
    title: "Your orders",
    description: "Totals, discounts, refunds and fulfillment for the last 60 days of orders.",
  },
  read_all_orders: {
    title: "Orders older than 60 days",
    description: "The same order details, going back further than Shopify's 60-day default.",
  },
  read_products: {
    title: "Your products",
    description: "Product details, vendors and stock levels.",
  },
  read_customers: {
    title: "Your customers",
    description: "Repeat vs first-time buyers, and the contact details shoppers gave your store, so you can follow up.",
  },
  read_customer_events: {
    title: "Storefront visits",
    description: "What visitors look at before they buy.",
  },
  write_pixels: {
    title: "Visit tracking",
    description: "Lets Insights install the tracker that records those storefront visits.",
  },
};

export function scopeLabel(scope: string): string {
  return SCOPE_LABELS[scope]?.title ?? scope;
}

/**
 * The same labels named inside a sentence: "your orders", "visit tracking and storefront
 * visits". Lower case, because every caller puts this mid-sentence.
 */
export function scopeList(scopes: string[]): string {
  const names = scopes.map((s) => scopeLabel(s).toLowerCase());
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Shopify: write_X implies read_X. */
export function expandScopes(granted: string[] | string): Set<string> {
  const list = Array.isArray(granted) ? granted : granted.split(",");
  const set = new Set<string>();
  for (const raw of list) {
    const s = raw.trim();
    if (!s) continue;
    set.add(s);
    if (s.startsWith("write_")) set.add(`read_${s.slice(6)}`);
  }
  return set;
}

export interface CapabilityState {
  id: ModuleId;
  title: string;
  description: string;
  enabled: boolean;
  missingScopes: string[];
  /**
   * A missing scope is missing for one of three reasons, and they need three different answers
   * from the merchant — so lumping them together puts people on a dead end. These two subsets of
   * `missingScopes` split them (both empty unless the caller passes the deployed scope lists,
   * because only the API reads those):
   *
   * `reconnectableScopes` — declared in the app's *required* `scopes`, but this store hasn't
   * granted them: its install predates the scope, or the grant is stale. Reconnecting the store
   * re-runs managed installation and asks for the current set, so that genuinely fixes it.
   *
   * `requestableScopes` — declared in `optional_scopes`, so the merchant can be asked for them
   * now, one feature at a time (`POST .../scopes/request`). When this covers every missing
   * scope the module is one consent away and "Enable" is offerable.
   *
   * A scope in neither list can't be obtained by anything the merchant does: it isn't declared
   * at all, which for us means Shopify hasn't approved the app for it yet.
   */
  requestableScopes: string[];
  reconnectableScopes: string[];
  missingRequirements: string[];
}

export function resolveCapabilities(
  grantedScopes: string[] | string,
  ctx: {
    pixelInstalled?: boolean;
    /** The app's declared `optional_scopes` (@app/core `declaredOptionalScopes`). */
    optionalScopes?: string[];
    /** The app's declared required `scopes` (@app/core `declaredScopes`). */
    declaredScopes?: string[];
  } = {},
): CapabilityState[] {
  const granted = expandScopes(grantedScopes);
  const optional = expandScopes(ctx.optionalScopes ?? []);
  const declared = expandScopes(ctx.declaredScopes ?? []);
  return CAPABILITIES.map((c) => {
    const missingScopes = c.requiredScopes.filter((s) => !granted.has(s));
    const missingRequirements = (c.requires ?? []).filter(
      (r) => r === "pixel_installed" && !ctx.pixelInstalled,
    );
    return {
      id: c.id,
      title: c.title,
      description: c.description,
      enabled: missingScopes.length === 0 && missingRequirements.length === 0,
      missingScopes,
      requestableScopes: missingScopes.filter((s) => optional.has(s)),
      reconnectableScopes: missingScopes.filter((s) => declared.has(s)),
      missingRequirements,
    };
  });
}

/** The scopes a module needs, for turning a module id back into a scope request. */
export function scopesForModule(id: ModuleId): string[] {
  return CAPABILITIES.find((c) => c.id === id)?.requiredScopes ?? [];
}

export function hasCapability(
  grantedScopes: string[] | string,
  id: ModuleId,
  ctx: { pixelInstalled?: boolean } = {},
): boolean {
  return resolveCapabilities(grantedScopes, ctx).find((c) => c.id === id)?.enabled ?? false;
}

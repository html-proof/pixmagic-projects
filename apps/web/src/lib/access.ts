import { allows, hasFullAccess, modulesOf, type AccessKey, type AccessNeed, type MemberAccess } from "@app/shared/access";
import { staffAccess, type StaffRole } from "@app/shared/staff";
import type { Topic } from "@/components/dashboard/topics";
import type { AppModule } from "@/lib/features";

// ---------------------------------------------------------------------------
// What the signed-in member may open, in the web app's terms (pages and dashboard topics). The API
// decides: it checks every request and leaves out what isn't granted. These rules only decide what
// to show and where to send someone, from the same permissions (@app/shared/access), and from what
// the workspace offers at all (`Offers`: an App Store workspace leaves some parts out,
// lib/features.ts).
// ---------------------------------------------------------------------------

/** Whether the workspace offers a part of the app (useApp().offers). */
export type Offers = (part: AppModule) => boolean;
const ALL: Offers = () => true;

/** The dashboard panels that belong to a part of the app a workspace may leave out. */
const TOPIC_MODULE: Partial<Record<Topic, AppModule>> = { ads: "ads", adsense: "ads" };

/** The pages of each part of the app a workspace may leave out, by path prefix. */
const MODULE_PAGES: Array<[prefix: string, part: AppModule]> = [
  ["/ads", "ads"],
  ["/advertising", "ads"],
  ["/inventory", "inventory"],
  ["/whatsapp", "whatsapp"],
  ["/messaging", "sms"],
  ["/staff", "staff"],
  ["/settings/ads", "ads"],
  ["/settings/email", "email"],
];

const under = (p: string, prefix: string) => p === prefix || p.startsWith(`${prefix}/`);

/** The dashboard's detail panels and the permissions that show each (any of). */
export const TOPIC_NEED: Record<Topic, readonly AccessKey[]> = {
  overview: ["reports.view"],
  sales: ["analytics.sales"],
  ads: ["marketing.ads"],
  adsense: ["marketing.ads"],
  products: ["products.view", "products.performance"],
  shoppers: ["analytics.conversion"],
  timing: ["analytics.behavior"],
  channels: ["analytics.traffic"],
  shipping: ["orders.fulfillment"],
  stock: ["products.inventory"],
  discounts: ["discounts.codes"],
  customers: ["customers.list", "customers.analytics", "analytics.abandonment"],
  orders: ["orders.list"],
};

export const seesTopic = (access: MemberAccess, t: Topic, offers: Offers = ALL) => {
  const part = TOPIC_MODULE[t];
  return (!part || offers(part)) && allows(access, TOPIC_NEED[t]);
};

/** Which dashboard section a topic downloads as CSV (core's EXPORT_SECTIONS), if any. Advertising's are on its Reports page. */
export const TOPIC_EXPORT: Partial<Record<Topic, string>> = {
  sales: "sales",
  products: "products",
  stock: "stock",
  orders: "orders",
  discounts: "discounts",
  channels: "channels",
  timing: "timing",
};

/**
 * The dashboard topics that have pages of their own: the Advertising area's, and the Shopping Funnel
 * (shoppers). The dashboard sends ?view=ads, ?view=adsense and ?view=shoppers there (with its
 * dates), so old links keep working.
 */
export const TOPIC_PAGE: Partial<Record<Topic, string>> = { ads: "/advertising", adsense: "/advertising/adsense", shoppers: "/funnel" };

/** A member with permissions in at least one dashboard area (everything but Integrations, Staff and Reports alone). */
export function hasDashboardAccess(access: MemberAccess): boolean {
  if (hasFullAccess(access.role)) return true;
  return modulesOf(access).some((m) => m !== "integrations" && m !== "staff" && m !== "reports" && m !== "inventory");
}

/**
 * Whether the dashboard's home page (the overview of every area) is in this member's menu: for
 * owners and admins, and members with two areas or more. Someone shown one area lands on it.
 */
export function showsDashboardHome(access: MemberAccess): boolean {
  if (hasFullAccess(access.role)) return true;
  return modulesOf(access).filter((m) => m !== "integrations" && m !== "staff" && m !== "reports" && m !== "inventory").length >= 2;
}

/** Topics in the order the sidebar lists them. */
const TOPIC_ORDER: Topic[] = ["sales", "products", "customers", "ads", "discounts", "shoppers", "orders", "stock", "shipping", "channels", "timing", "overview"];

/** Where a member starts: the dashboard, or the one area they have; their account page with nothing at all. */
export function landingPath(access: MemberAccess, staffRole: StaffRole | null, offers: Offers = ALL): string {
  if (showsDashboardHome(access)) return "/dashboard";
  const topic = TOPIC_ORDER.find((t) => seesTopic(access, t, offers));
  if (topic) return TOPIC_PAGE[topic] ?? `/dashboard?view=${topic}`;
  if (offers("inventory") && allows(access, "inventory.view")) return "/inventory";
  if (offers("staff") && staffAccess(access.role, staffRole, access.permissions).permissions.length) return "/staff";
  if (offers("whatsapp") && allows(access, "marketing.campaigns")) return "/whatsapp";
  if (offers("sms") && allows(access, "marketing.campaigns")) return "/messaging";
  if (allows(access, "integrations.status")) return "/settings/integrations";
  // Nothing granted yet: the dashboard says so ("No access assigned").
  return "/dashboard";
}

/**
 * What each page of the app needs, by path prefix (the longest that matches wins). Pages not
 * listed are open to every member: their own profile, security and notifications.
 */
const PAGE_NEED: Array<[prefix: string, need: AccessNeed | "full" | "staff" | "dashboard"]> = [
  ["/dashboard", "dashboard"],
  ["/ads", "marketing.ads"],
  ["/advertising", "marketing.ads"],
  ["/advertising/campaigns", "marketing.campaigns"],
  ["/funnel", "analytics.conversion"],
  ["/inventory", "inventory.view"],
  ["/inventory/movements", "inventory.history"],
  ["/team", "members:manage"],
  ["/staff", "staff"],
  ["/whatsapp", "marketing.campaigns"],
  ["/whatsapp/connect", "integrations.manage"],
  ["/messaging", "marketing.campaigns"],
  ["/settings/workspace", "members:manage"],
  ["/settings/members", "members:manage"],
  ["/settings/integrations", "integrations.status"],
  ["/settings/stores", "integrations.status"],
  ["/settings/ads", "integrations.status"],
  ["/settings/email", "email:read"],
  ["/settings/api-keys", "apikeys:manage"],
  ["/settings/billing", "full"],
  ["/settings/privacy", "audit:read"],
  ["/settings/audit", "audit:read"],
];

/** The account's own pages, which a dashboard opened from a shared link can't open (it isn't signed in to the account). */
const ACCOUNT_PAGES = ["/settings/profile", "/settings/security"];

/**
 * `shared`: opened from an invitation link (Me.shared), so the account's own pages are closed.
 * `offers`: the parts of the app the workspace offers; the pages of the others are closed to everyone.
 */
export function canOpenPage(path: string, access: MemberAccess, staffRole: StaffRole | null, shared = false, offers: Offers = ALL): boolean {
  const p = path.replace(/\/$/, "") || "/";
  if (shared && ACCOUNT_PAGES.some((a) => under(p, a))) return false;
  if (MODULE_PAGES.some(([prefix, part]) => under(p, prefix) && !offers(part))) return false;
  let best: (typeof PAGE_NEED)[number] | null = null;
  for (const rule of PAGE_NEED) {
    if ((p === rule[0] || p.startsWith(`${rule[0]}/`)) && (!best || rule[0].length > best[0].length)) best = rule;
  }
  if (!best) return true;
  const need = best[1];
  if (need === "full") return hasFullAccess(access.role);
  if (need === "staff") return staffAccess(access.role, staffRole, access.permissions).permissions.length > 0;
  // The dashboard itself always opens: with nothing granted it says so instead of sending them round in circles.
  if (need === "dashboard") return true;
  return allows(access, need);
}

// ---------------------------------------------------------------------------
// Noticing that one's access changed
// ---------------------------------------------------------------------------

/**
 * Every workspace response carries `x-access-fp: <workspace>:<fingerprint>` (apps/api/src/context.ts).
 * `api()` passes it on as this event, and so does any refusal that may mean access changed; the app
 * (components/AppContext.tsx) reloads the member's permissions when the fingerprint differs.
 */
export const ACCESS_EVENT = "insights:access";
export interface AccessSignal {
  workspaceId?: string;
  fingerprint?: string;
  /** A request was refused: forbidden, or access revoked. */
  refused?: "forbidden" | "access_revoked" | "access_expired";
}

export function signalAccess(detail: AccessSignal) {
  window.dispatchEvent(new CustomEvent<AccessSignal>(ACCESS_EVENT, { detail }));
}

export function onAccessSignal(fn: (s: AccessSignal) => void): () => void {
  const listener = (e: Event) => fn((e as CustomEvent<AccessSignal>).detail);
  window.addEventListener(ACCESS_EVENT, listener);
  return () => window.removeEventListener(ACCESS_EVENT, listener);
}

/** Dispatched once the app holds a member's new permissions: live views ask again straight away. */
export const ACCESS_CHANGED_EVENT = "insights:access-changed";

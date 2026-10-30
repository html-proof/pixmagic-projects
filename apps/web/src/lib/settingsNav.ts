import { Bell, Building2, CreditCard, FileLock2, KeyRound, Mail, Megaphone, Plug, ScrollText, ShieldCheck, Store, UserRound, UsersRound, type LucideIcon } from "lucide-react";
import { API_KEYS_ENABLED, BILLING_PAGE } from "@/lib/features";

/**
 * The settings pages, in the order the settings menu lists them (also searchable from the top bar).
 * `href` when the page lives elsewhere (People & access is /team). `inMenu: false` for a page reached
 * from another one rather than the menu: Shopify stores and Ad accounts open from Connections (whose
 * menu entry stays lit on them), and Email belongs to Marketing. Each menu shows only the pages the
 * member may open (lib/access.ts, canOpenPage).
 */
export const SETTINGS_PAGES: ReadonlyArray<{ slug: string; label: string; icon: LucideIcon; keywords?: string; href?: string; inMenu?: false }> = [
  { slug: "integrations", label: "Connections", icon: Plug, keywords: "integrations connect your business shopify whatsapp google meta adsense zapier" },
  { slug: "stores", label: "Shopify stores", icon: Store, keywords: "connect disconnect sync permissions", inMenu: false },
  { slug: "ads", label: "Ad accounts", icon: Megaphone, keywords: "advertising meta google ads adsense", inMenu: false },
  { slug: "email", label: "Email", icon: Mail, keywords: "gmail outlook smtp mailbox", inMenu: false },
  { slug: "workspace", label: "Business details", icon: Building2, keywords: "workspace rename business name" },
  { slug: "members", label: "People & access", icon: UsersRound, keywords: "team members roles invite users permissions share", href: "/team" },
  { slug: "notifications", label: "Notifications", icon: Bell, keywords: "alerts emails" },
  { slug: "profile", label: "Profile", icon: UserRound, keywords: "name time zone account" },
  { slug: "security", label: "Sign-in & security", icon: ShieldCheck, keywords: "password sign out devices" },
  ...(API_KEYS_ENABLED ? [{ slug: "api-keys", label: "API keys", icon: KeyRound }] : []),
  ...(BILLING_PAGE ? [{ slug: "billing", label: "Billing", icon: CreditCard, keywords: "plan subscription" }] : []),
  { slug: "privacy", label: "Privacy requests", icon: FileLock2, keywords: "gdpr customer data redact export" },
  { slug: "audit", label: "Audit log", icon: ScrollText, keywords: "history activity" },
];

/** The settings pages that open from Connections: its menu entry stays lit on them. */
export const UNDER_CONNECTIONS = ["/settings/stores", "/settings/ads"];

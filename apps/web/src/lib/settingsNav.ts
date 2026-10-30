import { Bell, Building2, CreditCard, FileLock2, KeyRound, Mail, Megaphone, Plug, ReceiptText, ScrollText, ShieldCheck, Store, UserRound, UsersRound, type LucideIcon } from "lucide-react";
import { API_KEYS_ENABLED, BILLING_PAGE } from "@/lib/features";

/**
 * The settings pages, in the order the settings menu lists them (also searchable from the top bar).
 * `href` when the page lives elsewhere (People & access is /team). `inMenu: false` for a page reached
 * from another one rather than the menu: Shopify stores and Ad accounts open from Connections (whose
 * menu entry stays lit on them), and Email belongs to Marketing. Each menu shows only the pages the
 * member may open (lib/access.ts, canOpenPage).
 */
export const SETTINGS_PAGES: ReadonlyArray<{ slug: string; label: string; icon: LucideIcon; keywords?: string; href?: string }> = [
  { slug: "profile", label: "Profile", icon: UserRound, keywords: "name time zone account" },
  { slug: "security", label: "Security", icon: ShieldCheck, keywords: "password sign out devices" },
  { slug: "workspace", label: "Workspace", icon: Building2, keywords: "rename" },
  { slug: "integrations", label: "Integrations", icon: Plug, keywords: "connect your business shopify whatsapp google meta adsense" },
  { slug: "stores", label: "Shopify", icon: Store, keywords: "stores connect disconnect" },
  { slug: "ads", label: "Advertising", icon: Megaphone, keywords: "meta google ads adsense" },
  { slug: "costs", label: "Costs", icon: ReceiptText, keywords: "expenses net profit shopify plan apps staff rent fees shipping" },
  { slug: "email", label: "Email integrations", icon: Mail, keywords: "gmail outlook smtp" },
  { slug: "members", label: "Team & Access", icon: UsersRound, keywords: "team members roles invite users permissions share", href: "/team" },
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

import { Bell, Building2, CreditCard, FileLock2, KeyRound, Mail, Megaphone, Plug, ScrollText, ShieldCheck, Store, UserRound, UsersRound, type LucideIcon } from "lucide-react";
import { API_KEYS_ENABLED, BILLING_ENABLED } from "@/lib/features";

/** The settings pages, in the order the settings menu lists them (also searchable from the top bar). */
export const SETTINGS_PAGES: ReadonlyArray<{ slug: string; label: string; icon: LucideIcon; keywords?: string }> = [
  { slug: "profile", label: "Profile", icon: UserRound, keywords: "name time zone account" },
  { slug: "security", label: "Security", icon: ShieldCheck, keywords: "password sign out devices" },
  { slug: "workspace", label: "Workspace", icon: Building2, keywords: "rename" },
  { slug: "integrations", label: "Connect your business", icon: Plug, keywords: "integrations connect" },
  { slug: "stores", label: "Shopify", icon: Store, keywords: "stores connect disconnect" },
  { slug: "ads", label: "Advertising", icon: Megaphone, keywords: "meta google ads adsense" },
  { slug: "email", label: "Email integrations", icon: Mail, keywords: "gmail outlook smtp" },
  { slug: "members", label: "Members & roles", icon: UsersRound, keywords: "team invite users" },
  { slug: "notifications", label: "Notifications", icon: Bell, keywords: "alerts emails" },
  ...(API_KEYS_ENABLED ? [{ slug: "api-keys", label: "API keys", icon: KeyRound }] : []),
  ...(BILLING_ENABLED ? [{ slug: "billing", label: "Billing", icon: CreditCard, keywords: "plan subscription" }] : []),
  { slug: "privacy", label: "Privacy requests", icon: FileLock2, keywords: "gdpr customer data export erase redact" },
  { slug: "audit", label: "Audit log", icon: ScrollText, keywords: "history activity" },
];

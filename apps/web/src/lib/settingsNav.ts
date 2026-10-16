import { API_KEYS_ENABLED, BILLING_ENABLED } from "@/lib/features";

/** The settings pages, in the order the settings menu lists them (also searchable from the top bar). */
export const SETTINGS_PAGES: ReadonlyArray<{ slug: string; label: string; keywords?: string }> = [
  { slug: "profile", label: "Profile", keywords: "name time zone account" },
  { slug: "security", label: "Security", keywords: "password sign out devices" },
  { slug: "workspace", label: "Workspace", keywords: "rename" },
  { slug: "integrations", label: "Connect your business", keywords: "integrations connect" },
  { slug: "stores", label: "Shopify", keywords: "stores connect disconnect" },
  { slug: "ads", label: "Advertising", keywords: "meta google ads adsense" },
  { slug: "email", label: "Email integrations", keywords: "gmail outlook smtp" },
  { slug: "members", label: "Members & roles", keywords: "team invite users" },
  { slug: "notifications", label: "Notifications", keywords: "alerts emails" },
  ...(API_KEYS_ENABLED ? [{ slug: "api-keys", label: "API keys" }] : []),
  ...(BILLING_ENABLED ? [{ slug: "billing", label: "Billing", keywords: "plan subscription" }] : []),
  { slug: "audit", label: "Audit log", keywords: "history activity" },
];

"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Bell, Building2, CreditCard, FileLock2, KeyRound, Mail, Megaphone, Plug, ScrollText, ShieldCheck, Store, UserRound, UsersRound, type LucideIcon } from "lucide-react";
import { API_KEYS_ENABLED, BILLING_ENABLED } from "@/lib/features";

const ITEMS: ReadonlyArray<readonly [slug: string, label: string, icon: LucideIcon]> = [
  ["profile", "Profile", UserRound],
  ["security", "Security", ShieldCheck],
  ["workspace", "Workspace", Building2],
  ["integrations", "Connect your business", Plug],
  ["stores", "Shopify", Store],
  ["ads", "Advertising", Megaphone],
  ["email", "Email integrations", Mail],
  ["members", "Members & roles", UsersRound],
  ["notifications", "Notifications", Bell],
  ...(API_KEYS_ENABLED ? [["api-keys", "API keys", KeyRound] as const] : []),
  ...(BILLING_ENABLED ? [["billing", "Billing", CreditCard] as const] : []),
  ["privacy", "Privacy requests", FileLock2],
  ["audit", "Audit log", ScrollText],
];

export default function SettingsLayout({ children }: { children: ReactNode }) {
  const path = usePathname();
  return (
    <div className="grid gap-6 md:grid-cols-[12rem_1fr]">
      <nav aria-label="Settings" className="flex gap-1 overflow-x-auto md:flex-col">
        {ITEMS.map(([slug, label, Glyph]) => {
          const here = path.replace(/\/$/, "");
          // Email integrations has pages of its own under it.
          const active = here === `/settings/${slug}` || (slug === "email" && here.startsWith("/settings/email/"));
          return (
            <Link
              key={slug}
              href={`/settings/${slug}`}
              aria-current={active ? "page" : undefined}
              className={`inline-flex items-center gap-2 whitespace-nowrap rounded-lg px-3 py-2 text-sm ${active ? "bg-surface font-semibold" : "text-muted"}`}
            >
              <Glyph size={16} strokeWidth={1.8} aria-hidden="true" />
              {label}
            </Link>
          );
        })}
      </nav>
      <div className="min-w-0 space-y-4">{children}</div>
    </div>
  );
}

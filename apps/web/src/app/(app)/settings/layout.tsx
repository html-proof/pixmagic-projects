"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

const ITEMS = [
  ["profile", "Profile"],
  ["workspace", "Workspace"],
  ["stores", "Stores"],
  ["members", "Members & roles"],
  ["notifications", "Notifications"],
  ["api-keys", "API keys"],
  ["billing", "Billing"],
  ["audit", "Audit log"],
] as const;

export default function SettingsLayout({ children }: { children: ReactNode }) {
  const path = usePathname();
  return (
    <div className="grid gap-6 md:grid-cols-[12rem_1fr]">
      <nav aria-label="Settings" className="flex gap-1 overflow-x-auto md:flex-col">
        {ITEMS.map(([slug, label]) => (
          <Link key={slug} href={`/settings/${slug}`} className={`whitespace-nowrap rounded-lg px-3 py-2 text-sm ${path === `/settings/${slug}` ? "bg-surface font-semibold" : "text-muted"}`}>
            {label}
          </Link>
        ))}
      </nav>
      <div className="min-w-0 space-y-4">{children}</div>
    </div>
  );
}

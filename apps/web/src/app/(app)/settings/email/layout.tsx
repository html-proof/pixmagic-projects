"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Alert } from "@/components/ui";
import { ToastProvider } from "@/components/AppUi";
import { useEmail } from "@/lib/email";

const TABS = [
  ["", "Overview"],
  ["accounts", "Accounts"],
  ["domains", "Domains"],
  ["templates", "Templates"],
  ["automations", "Automations"],
  ["activity", "Activity"],
  ["settings", "Settings"],
] as const;

/** Settings → Email integrations: its own tab bar inside the settings page. */
export default function EmailLayout({ children }: { children: ReactNode }) {
  const path = usePathname().replace(/\/$/, "");
  const { read } = useEmail();
  if (!read) return <Alert kind="info">Your role doesn&apos;t include email integrations. Ask an owner or admin.</Alert>;
  return (
    <ToastProvider>
      <div className="space-y-4">
        <nav aria-label="Email integrations" className="flex gap-1 overflow-x-auto overflow-y-hidden border-b border-border">
          {TABS.map(([slug, label]) => {
            const href = slug ? `/settings/email/${slug}` : "/settings/email";
            const active = slug ? path === href || path.startsWith(`${href}/`) : path === href;
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm transition ${active ? "border-accent font-semibold text-text" : "border-transparent text-muted hover:text-text"}`}
              >
                {label}
              </Link>
            );
          })}
        </nav>
        {children}
      </div>
    </ToastProvider>
  );
}

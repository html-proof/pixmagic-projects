"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useApp } from "@/components/AppContext";
import { SecuritySummary } from "@/components/settings/SecuritySummary";
import { canOpenPage } from "@/lib/access";
import { SETTINGS_PAGES, UNDER_CONNECTIONS } from "@/lib/settingsNav";

export default function SettingsLayout({ children }: { children: ReactNode }) {
  const path = usePathname();
  const { me, access, workspace, offers } = useApp();
  const here = path.replace(/\/$/, "");
  // Email lives in Marketing (components/AreaNav.tsx) and has its own menu there; its address stays.
  if (here === "/settings/email" || here.startsWith("/settings/email/")) return <>{children}</>;
  // Only the pages this member may open (Team & Access) of what the workspace offers: someone from
  // outside the business sees their own account.
  const pages = SETTINGS_PAGES.filter((p) => p.inMenu !== false)
    .map((p) => ({ ...p, to: p.href ?? `/settings/${p.slug}` }))
    .filter((p) => canOpenPage(p.to, access, workspace.staffRole ?? null, !!me.shared, offers));
  return (
    <div className="grid gap-6 md:grid-cols-[13.5rem_1fr]">
      <div className="min-w-0 md:sticky md:top-20 md:space-y-6 md:self-start">
        <nav aria-label="Settings" className="flex gap-1 overflow-x-auto md:flex-col">
          {pages.map(({ slug, label, icon: Glyph, to }) => {
            // Shopify stores and Ad accounts open from Connections.
            const active = here === to || (slug === "integrations" && UNDER_CONNECTIONS.some((u) => here === u || here.startsWith(`${u}/`)));
            return (
              <Link
                key={slug}
                href={to}
                aria-current={active ? "page" : undefined}
                className={`inline-flex items-center gap-3 whitespace-nowrap rounded-lg border px-3 py-2.5 text-sm transition-colors ${active ? "border-accent/45 bg-accent/10 font-semibold text-text" : "border-transparent text-muted hover:bg-surface hover:text-text"}`}
              >
                <Glyph size={18} strokeWidth={1.8} aria-hidden="true" className={active ? "text-accent" : undefined} />
                {label}
              </Link>
            );
          })}
        </nav>
        {/* Not on a phone, where the menu is one row that scrolls sideways. */}
        {pages.some((p) => p.slug === "security") && (
          <div className="hidden md:block">
            <SecuritySummary />
          </div>
        )}
      </div>
      <div className="min-w-0 space-y-4">{children}</div>
    </div>
  );
}

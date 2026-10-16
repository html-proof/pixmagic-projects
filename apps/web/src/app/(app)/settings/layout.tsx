"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useApp } from "@/components/AppContext";
import { canOpenPage } from "@/lib/access";
import { SETTINGS_PAGES } from "@/lib/settingsNav";

export default function SettingsLayout({ children }: { children: ReactNode }) {
  const path = usePathname();
  const { access, workspace } = useApp();
  // Only the pages this member may open (Team & Access): someone from outside the business sees their own account.
  const pages = SETTINGS_PAGES.map((p) => ({ ...p, to: p.href ?? `/settings/${p.slug}` })).filter((p) => canOpenPage(p.to, access, workspace.staffRole ?? null));
  return (
    <div className="grid gap-6 md:grid-cols-[12rem_1fr]">
      <nav aria-label="Settings" className="flex gap-1 overflow-x-auto md:flex-col">
        {pages.map(({ slug, label, icon: Glyph, to }) => {
          const here = path.replace(/\/$/, "");
          // Email integrations has pages of its own under it.
          const active = here === to || (slug === "email" && here.startsWith("/settings/email/"));
          return (
            <Link
              key={slug}
              href={to}
              aria-current={active ? "page" : undefined}
              className={`inline-flex items-center gap-2 whitespace-nowrap rounded-lg px-3 py-2 text-sm transition-colors ${active ? "bg-accent/10 font-semibold text-text" : "text-muted hover:text-text"}`}
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

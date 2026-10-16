"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { SETTINGS_PAGES } from "@/lib/settingsNav";

export default function SettingsLayout({ children }: { children: ReactNode }) {
  const path = usePathname();
  return (
    <div className="grid gap-6 md:grid-cols-[12rem_1fr]">
      <nav aria-label="Settings" className="flex gap-1 overflow-x-auto md:flex-col">
        {SETTINGS_PAGES.map(({ slug, label, icon: Glyph }) => {
          const here = path.replace(/\/$/, "");
          // Email integrations has pages of its own under it.
          const active = here === `/settings/${slug}` || (slug === "email" && here.startsWith("/settings/email/"));
          return (
            <Link
              key={slug}
              href={`/settings/${slug}`}
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

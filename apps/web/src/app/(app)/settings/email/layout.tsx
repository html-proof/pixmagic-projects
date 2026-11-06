"use client";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { PageTabs } from "@/components/PageKit";
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

/** Settings → Email integrations: its own row of tabs inside the settings page, as the Stitch design draws a page's tabs (PageKit). */
export default function EmailLayout({ children }: { children: ReactNode }) {
  const path = usePathname().replace(/\/$/, "");
  const { read } = useEmail();
  if (!read) return <Alert kind="info">Your role doesn&apos;t include email integrations. Ask an owner or admin.</Alert>;
  const tabs = TABS.map(([slug, label]) => ({ id: slug || "overview", label, href: slug ? `/settings/email/${slug}` : "/settings/email" }));
  const active = tabs.find((t) => (t.id === "overview" ? path === t.href : path === t.href || path.startsWith(`${t.href}/`)))?.id ?? "";
  return (
    <ToastProvider>
      <div className="space-y-4">
        <PageTabs label="Email integrations" tabs={tabs} active={active} testId="email-tabs" />
        {children}
      </div>
    </ToastProvider>
  );
}

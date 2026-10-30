"use client";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Mail } from "lucide-react";
import { Alert } from "@/components/ui";
import { SectionLayout, ToastProvider } from "@/components/AppUi";
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

/** Marketing → Email (its address stays under /settings): its menu, like the other channels'. */
export default function EmailLayout({ children }: { children: ReactNode }) {
  const path = usePathname().replace(/\/$/, "");
  const { read } = useEmail();
  if (!read) return <Alert kind="info">Your role doesn&apos;t include email. Ask an owner or admin.</Alert>;
  const items = TABS.map(([slug, label]) => {
    const href = slug ? `/settings/email/${slug}` : "/settings/email";
    return { href, label, active: slug ? path === href || path.startsWith(`${href}/`) : path === href };
  });
  return (
    <ToastProvider>
      <SectionLayout title="Email" icon={<Mail aria-hidden className="h-[18px] w-[18px] text-accent" strokeWidth={1.8} />} items={items}>
        {children}
      </SectionLayout>
    </ToastProvider>
  );
}

"use client";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Workflow } from "lucide-react";
import { StoresPending, useApp } from "@/components/AppContext";
import { SectionLayout, ToastProvider } from "@/components/AppUi";

/** The Automations hub (docs/automations.md): its pages, and the store SMS belongs to. */
export default function AutomationsLayout({ children }: { children: ReactNode }) {
  const path = usePathname().replace(/\/$/, "");
  const { storesStatus, allowed } = useApp();
  const items = [
    ["/automations", "Automations"],
    ["/automations/new", "Create automation"],
    ["/automations/history", "Message history"],
    ...(allowed("audit:read") ? [["/automations/audit", "Audit log"]] : []),
  ].map(([href, label]) => ({ href: href!, label: label!, active: path === href }));
  return (
    <ToastProvider>
      <SectionLayout title="Automations" icon={<Workflow aria-hidden className="h-[18px] w-[18px] text-accent" strokeWidth={1.8} />} items={items}>
        {storesStatus !== "ready" ? <StoresPending /> : children}
      </SectionLayout>
    </ToastProvider>
  );
}

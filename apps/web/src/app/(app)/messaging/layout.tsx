"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { MessageSquareText } from "lucide-react";
import { canManage, StoresPending, useApp } from "@/components/AppContext";
import { SectionLayout, ToastProvider } from "@/components/AppUi";

const ITEMS = [
  ["", "Overview"],
  ["send", "Send SMS"],
  ["templates", "Message Templates"],
  ["automations", "Automated Workflows"],
  ["campaigns", "Campaigns"],
  ["segments", "Customer Segments"],
  ["history", "Message History"],
  ["analytics", "Delivery Analytics"],
  ["billing", "SMS Billing"],
  ["sender", "Sender Configuration"],
  ["consent", "Consent & Suppression"],
] as const;

export default function MessagingLayout({ children }: { children: ReactNode }) {
  const path = usePathname().replace(/\/$/, "");
  const { storesStatus, store, workspace } = useApp();
  const items = ITEMS.map(([slug, label]) => {
    const href = slug ? `/messaging/${slug}` : "/messaging";
    return { href, label, active: path === href };
  });
  return (
    <ToastProvider>
      <SectionLayout title="Customer Messaging" icon={<MessageSquareText aria-hidden className="h-[18px] w-[18px] text-accent" strokeWidth={1.8} />} items={items}>
        {storesStatus !== "ready" ? (
          <StoresPending />
        ) : !store ? (
          <div className="card">
            <h1 className="text-lg font-semibold">Customer Messaging</h1>
            <p className="mt-1 text-sm text-muted">Connect a Shopify store first: text messages are about a store&apos;s orders and customers, and only reach customers Shopify says may receive them.</p>
            {canManage(workspace.role) && (
              <Link href="/onboarding" className="btn-primary mt-3 inline-flex">
                Connect a store
              </Link>
            )}
          </div>
        ) : (
          children
        )}
      </SectionLayout>
    </ToastProvider>
  );
}

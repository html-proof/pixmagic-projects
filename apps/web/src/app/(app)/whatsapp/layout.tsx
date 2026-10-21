"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { canManage, StoresPending, useApp } from "@/components/AppContext";
import { WhatsappIcon } from "@/components/whatsapp/WhatsappUi";
import { SectionLayout, ToastProvider } from "@/components/AppUi";

const ITEMS = [
  ["", "Overview"],
  ["connect", "Connect WhatsApp"],
  ["templates", "Message templates"],
  ["orders", "Order notifications"],
  ["delivery", "Delivery updates"],
  ["carts", "Abandoned carts"],
  ["reviews", "Customer reviews"],
  ["campaigns", "Marketing campaigns"],
  ["automations", "Automation rules"],
  ["messages", "Message history"],
  ["analytics", "Analytics"],
  ["settings", "Settings"],
] as const;

export default function WhatsappLayout({ children }: { children: ReactNode }) {
  const path = usePathname().replace(/\/$/, "");
  const { storesStatus, store, workspace } = useApp();
  const items = ITEMS.map(([slug, label]) => {
    const href = slug ? `/whatsapp/${slug}` : "/whatsapp";
    return { href, label, active: path === href };
  });
  return (
    <ToastProvider>
      <SectionLayout title="WhatsApp" icon={<WhatsappIcon size={18} />} items={items}>
        {storesStatus !== "ready" ? (
          <StoresPending />
        ) : !store ? (
          <div className="card">
            <h1 className="text-lg font-semibold">WhatsApp</h1>
            <p className="mt-1 text-sm text-muted">Connect a Shopify store first: WhatsApp messages are about a store&apos;s orders and customers.</p>
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

"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { canManage, StoresPending, useApp } from "@/components/AppContext";
import { WhatsappIcon } from "@/components/whatsapp/WhatsappUi";
import { ToastProvider } from "@/components/AppUi";

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
  return (
    <ToastProvider>
      <div className="grid gap-6 md:grid-cols-[13rem_1fr]">
        <nav aria-label="WhatsApp" className="flex gap-1 overflow-x-auto pb-1 md:flex-col md:pb-0">
          <p className="mb-2 hidden items-center gap-2 px-3 text-sm font-semibold md:flex">
            <WhatsappIcon size={18} /> WhatsApp
          </p>
          {ITEMS.map(([slug, label]) => {
            const href = slug ? `/whatsapp/${slug}` : "/whatsapp";
            const active = path === href;
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                className={`whitespace-nowrap rounded-lg px-3 py-2 text-sm transition ${active ? "bg-surface font-semibold shadow-sm" : "text-muted hover:text-text"}`}
              >
                {label}
              </Link>
            );
          })}
        </nav>
        <div className="min-w-0 space-y-4">
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
        </div>
      </div>
    </ToastProvider>
  );
}

"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { MessageSquareText } from "lucide-react";
import { canManage, StoresPending, useApp } from "@/components/AppContext";
import { SectionLayout, ToastProvider, type SectionItem } from "@/components/AppUi";

/** What every member uses: see how texting is going, send a message, build automations, read the history. */
const MAIN = [
  ["", "Overview"],
  ["send", "Send SMS"],
  ["automations", "Automations"],
  ["history", "Message History"],
  ["settings", "Settings"],
] as const;

/**
 * The one-time configuration and the specialist tools, for owners and admins: set up once, then
 * never needed to build an automation. Members who can't change anything see only what they may read.
 */
const ADVANCED = [
  ["setup", "Setup guide"],
  ["sender", "Sender name"],
  ["consent", "Customer permissions"],
  ["billing", "Messaging costs"],
  ["templates", "Message templates"],
  ["campaigns", "Campaigns"],
  ["segments", "Customer segments"],
  ["analytics", "Delivery analytics"],
] as const;
const READ_ONLY = new Set<string>(["campaigns", "analytics"]);

export default function MessagingLayout({ children }: { children: ReactNode }) {
  const path = usePathname().replace(/\/$/, "");
  const { storesStatus, store, workspace } = useApp();
  const manage = canManage(workspace.role);
  const entry = ([slug, label]: readonly [string, string]) => {
    const href = slug ? `/messaging/${slug}` : "/messaging";
    return { href, label, active: path === href || (!!slug && path.startsWith(`${href}/`)) };
  };
  const advanced = ADVANCED.filter(([slug]) => manage || READ_ONLY.has(slug));
  const items: SectionItem[] = [...MAIN.map(entry), { heading: manage ? "Advanced" : "More" }, ...advanced.map(entry)];
  return (
    <ToastProvider>
      <SectionLayout title="Text messages" icon={<MessageSquareText aria-hidden className="h-[18px] w-[18px] text-accent" strokeWidth={1.8} />} items={items}>
        {storesStatus !== "ready" ? (
          <StoresPending />
        ) : !store ? (
          <div className="card">
            <h1 className="text-lg font-semibold">Text messages</h1>
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

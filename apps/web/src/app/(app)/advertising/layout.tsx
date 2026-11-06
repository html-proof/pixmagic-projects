"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Megaphone } from "lucide-react";
import { canManage, StoresPending, useApp } from "@/components/AppContext";
import { SectionLayout, ToastProvider } from "@/components/AppUi";

const ITEMS = [
  ["", "Overview"],
  ["meta", "Meta Ads"],
  ["google", "Google Ads"],
  ["attribution", "Shopify attribution"],
  ["profitability", "Profitability"],
  ["adsense", "AdSense"],
  ["campaigns", "Campaign comparison"],
  ["reports", "Reports"],
] as const;

/**
 * The Advertising area: every ad platform's figures for the store picked in the top bar, for the
 * dashboard's dates (the same address-bar state). Its pages: components/advertising/.
 */
export default function AdvertisingLayout({ children }: { children: ReactNode }) {
  const path = usePathname().replace(/\/$/, "");
  const { storesStatus, store, workspace, allowed } = useApp();
  // Campaign figures need "View campaigns" (Team & Access): the API leaves them out without it.
  const items = ITEMS.filter(([slug]) => slug !== "campaigns" || allowed("marketing.campaigns")).map(([slug, label]) => {
    const href = slug ? `/advertising/${slug}` : "/advertising";
    return { href, label, active: slug ? path === href || path.startsWith(`${href}/`) : path === href };
  });
  return (
    <ToastProvider>
      <SectionLayout title="Advertising" icon={<Megaphone aria-hidden className="h-[18px] w-[18px] text-accent" />} items={items}>
        {storesStatus !== "ready" ? (
          <StoresPending />
        ) : !store ? (
          <div className="card">
            <h1 className="card-title">Advertising</h1>
            <p className="mt-1 text-sm text-muted">Connect a Shopify store first: ad accounts are connected to a store, and set against its sales.</p>
            {canManage(workspace.role) && (
              <Link href={`/onboarding?ws=${encodeURIComponent(workspace.id)}`} className="btn-primary mt-3 inline-flex">
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

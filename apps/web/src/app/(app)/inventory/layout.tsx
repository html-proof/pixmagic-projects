"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Boxes } from "lucide-react";
import { canManage, StoresPending, useApp } from "@/components/AppContext";
import { SectionLayout, ToastProvider } from "@/components/AppUi";
import { LoadError } from "@/components/LoadError";
import { InventoryProvider, NoPermission, useInventory } from "@/components/inventory/InventoryUi";
import { ProductPanel } from "@/components/inventory/ProductPanel";
import { isRefused } from "@/lib/api";
import { useOpenProduct } from "@/lib/inventory";

const ITEMS = [
  ["", "Inventory overview"],
  ["stock", "All stock"],
  ["low-stock", "Low stock"],
  ["out-of-stock", "Out of stock"],
  ["movements", "Inventory movements"],
  ["locations", "Locations"],
  ["reports", "Inventory reports"],
  ["settings", "Stock settings"],
] as const;

/**
 * The Inventory section (docs/inventory.md): its menu, the store it is about (the one picked in the
 * top bar), and the product panel any of its pages can open (?product=…).
 */
export default function InventoryLayout({ children }: { children: ReactNode }) {
  const path = usePathname().replace(/\/$/, "");
  const { storesStatus, store, workspace, allowed } = useApp();
  const items = ITEMS.filter(([slug]) => slug !== "movements" || allowed("inventory.history")).map(([slug, label]) => {
    const href = slug ? `/inventory/${slug}` : "/inventory";
    return { href, label, active: path === href };
  });
  return (
    <ToastProvider>
      <SectionLayout title="Inventory" icon={<Boxes aria-hidden className="h-[18px] w-[18px] text-accent" />} items={items}>
        {storesStatus !== "ready" ? (
          <StoresPending />
        ) : !store ? (
          <div className="card">
            <h1 className="card-title">Inventory</h1>
            <p className="mt-1 text-sm text-muted">Connect a Shopify store first: inventory is the stock of a store&apos;s products.</p>
            {canManage(workspace.role) && (
              <Link href="/onboarding" className="btn-primary mt-3 inline-flex">
                Connect a store
              </Link>
            )}
          </div>
        ) : (
          <InventoryProvider key={store.id} storeId={store.id}>
            <Body>{children}</Body>
          </InventoryProvider>
        )}
      </SectionLayout>
    </ToastProvider>
  );
}

function Body({ children }: { children: ReactNode }) {
  const { status, error, loading, refresh } = useInventory();
  const product = useOpenProduct();
  if (error && !status) return isRefused(error) ? <NoPermission what="this store's inventory" /> : <LoadError what="the inventory" error={error} onRetry={refresh} busy={loading} />;
  return (
    <>
      {children}
      {product && status && <ProductPanel key={product} productId={product} />}
    </>
  );
}

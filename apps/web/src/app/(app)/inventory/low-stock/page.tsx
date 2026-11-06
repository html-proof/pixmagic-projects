"use client";
import Link from "next/link";
import { PageHeader } from "@/components/AppUi";
import { StockStatus, SyncNote, useInventory } from "@/components/inventory/InventoryUi";
import { SettingsLink } from "@/components/inventory/StockKit";
import { StockTable } from "@/components/inventory/StockTable";

/** Low stock, in the Stitch design's "Needs attention" layout (screen 21) with the Low stock chip on. */
export default function LowStockPage() {
  const { status } = useInventory();
  return (
    <>
      <PageHeader
        title="Low stock"
        sub={
          <>
            Items with between 1 unit and their low-stock threshold available, with how long they&apos;ll last at their recent sales and what to reorder.{" "}
            {status?.can.alerts && (
              <Link href="/inventory/settings" className="underline">
                Thresholds and alerts
              </Link>
            )}
          </>
        }
        actions={
          status && (
            <>
              <StockStatus />
              <SettingsLink />
            </>
          )
        }
      />
      <SyncNote />
      <StockTable title="Low stock" fixed={{ status: "low" }} planning view="low" />
      <p className="text-xs text-muted">Reorder suggestions use the lead time and the days of sales to cover set in Stock settings.</p>
    </>
  );
}

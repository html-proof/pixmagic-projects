"use client";
import Link from "next/link";
import { PageHeader } from "@/components/AppUi";
import { SyncStrip, useInventory } from "@/components/inventory/InventoryUi";
import { StockTable } from "@/components/inventory/StockTable";

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
      />
      <SyncStrip />
      <StockTable title="Low stock" fixed={{ status: "low" }} planning />
      <p className="text-xs text-muted">Reorder suggestions use the lead time and the days of sales to cover set in Stock settings.</p>
    </>
  );
}

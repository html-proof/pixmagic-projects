"use client";
import { PageHeader } from "@/components/AppUi";
import { StockStatus, SyncNote, useInventory } from "@/components/inventory/InventoryUi";
import { SettingsLink } from "@/components/inventory/StockKit";
import { StockTable } from "@/components/inventory/StockTable";

/** Out of stock, in the Stitch design's "Needs attention" layout (screen 21) with the Out of stock chip on. */
export default function OutOfStockPage() {
  const { status } = useInventory();
  return (
    <>
      <PageHeader
        title="Out of stock"
        sub="Tracked items with no units available at any location (or the location picked). Items Shopify keeps selling when out show below zero."
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
      <StockTable title="Out of stock" fixed={{ status: "out" }} planning view="out" />
    </>
  );
}

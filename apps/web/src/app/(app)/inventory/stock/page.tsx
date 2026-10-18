"use client";
import { PageHeader } from "@/components/AppUi";
import { ConnectCard, SOURCE_NOTE, SyncStrip, useInventory } from "@/components/inventory/InventoryUi";
import { StockTable } from "@/components/inventory/StockTable";

export default function AllStockPage() {
  const { status } = useInventory();
  return (
    <>
      <PageHeader title="All stock" sub={status ? SOURCE_NOTE[status.status.source] : undefined} />
      <SyncStrip />
      <ConnectCard capability="stock_levels" />
      <StockTable title="All stock" />
    </>
  );
}

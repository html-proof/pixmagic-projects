"use client";
import { PageHeader } from "@/components/AppUi";
import { SyncStrip } from "@/components/inventory/InventoryUi";
import { StockTable } from "@/components/inventory/StockTable";

export default function OutOfStockPage() {
  return (
    <>
      <PageHeader title="Out of stock" sub="Tracked items with no units available at any location (or the location picked). Items Shopify keeps selling when out show below zero." />
      <SyncStrip />
      <StockTable title="Out of stock" fixed={{ status: "out" }} planning />
    </>
  );
}

"use client";
import { Banknote } from "lucide-react";
import { PageHeader } from "@/components/AppUi";
import { FigureTile } from "@/components/PageKit";
import { fmtRelative } from "@/components/dashboard/format";
import { ConnectCard, SOURCE_NOTE, StockStatus, SyncNote, useInventory } from "@/components/inventory/InventoryUi";
import { SettingsLink } from "@/components/inventory/StockKit";
import { StockTable } from "@/components/inventory/StockTable";
import { fmtMoney, useApi } from "@/lib/api";
import type { OverviewAnswer } from "@/lib/inventory";

/**
 * All stock as the Stitch design's "All products" (screen 22): the stock value at cost beside the
 * status chips, then every product with its stock in each state, value and status.
 */
export default function AllStockPage() {
  const { status } = useInventory();
  return (
    <>
      <PageHeader
        title="All stock"
        sub={status ? SOURCE_NOTE[status.status.source] : undefined}
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
      <ConnectCard capability="stock_levels" />
      <StockTable title="All stock" aside={status?.can.costs ? <StockValue /> : undefined} />
    </>
  );
}

/**
 * The stock value at cost, the overview's own figure (only for a member who may see costs): left
 * out while it loads or when the answer has none, never shown as a zero for want of data.
 */
function StockValue() {
  const { base, status } = useInventory();
  const { data } = useApi<OverviewAnswer>(`${base}/overview?preset=30d`);
  const kpi = data?.kpis.costValue ?? null;
  if (!kpi) return null;
  const asOf = data?.status.stockUpdatedAt ?? data?.status.catalogSyncedAt ?? null;
  // The figure's own caveats (items without a cost, counted on available units); not the note about
  // comparing with an earlier day, which this tile doesn't do.
  const note = kpi.complete === false || data?.source !== "levels" ? kpi.note : undefined;
  return (
    <FigureTile
      testId="stock-value"
      title="Stock value"
      icon={<Banknote className="h-4 w-4" />}
      value={kpi.value === null ? "—" : fmtMoney(kpi.value, status?.store.currency ?? "USD")}
      sub={
        <>
          <span className="block">{note ? `At cost. ${note}` : kpi.complete ? "At cost; every item in stock has a cost per item." : "At cost."}</span>
          {asOf && <span className="mt-1 block text-[11px]">As of {fmtRelative(asOf)}</span>}
        </>
      }
    />
  );
}

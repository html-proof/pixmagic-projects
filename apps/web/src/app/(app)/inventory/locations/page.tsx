"use client";
import { PageHeader } from "@/components/AppUi";
import { LoadError } from "@/components/LoadError";
import { Card, ShareRow } from "@/components/PageKit";
import { EmptyState } from "@/components/ui";
import { fmtRelative } from "@/components/dashboard/format";
import { ConnectCard, Qty, StockStatus, SyncNote, useInventory } from "@/components/inventory/InventoryUi";
import { KIT_ROW, KitHead, KitTable, KitTd, KitTh } from "@/components/inventory/StockKit";
import { fmtMoney, fmtNum, useApi } from "@/lib/api";
import type { LocationView } from "@/lib/inventory";

const TAG = "ml-1.5 inline-flex rounded bg-home-tag px-1.5 py-0.5 text-[11px] font-medium text-muted";

/**
 * Every Shopify location with its stock, side by side; each item at each location counted once.
 * No Stitch screen draws this page: it has the Stock pages' look (cards, the soft-headed table).
 */
export default function LocationsPage() {
  const { base, status } = useInventory();
  const currency = status?.store.currency ?? "USD";
  const { data, error, loading, reload } = useApi<{ locations: LocationView[] }>(`${base}/locations`);
  const withStock = data?.locations.filter((l) => l.stock) ?? [];
  const most = Math.max(1, ...withStock.map((l) => l.stock!.available));
  const total = withStock.reduce((n, l) => n + l.stock!.available, 0);
  return (
    <>
      <PageHeader title="Locations" sub="Your Shopify locations and the stock at each. An item stocked at two locations counts once at each, and once per unit in the totals." actions={status && <StockStatus />} />
      <SyncNote />
      <ConnectCard capability="stock_levels" />
      {error && !data ? (
        <LoadError what="the locations" error={error} onRetry={reload} busy={loading} />
      ) : !data ? (
        <div className="skeleton h-40 rounded-lg" />
      ) : data.locations.length === 0 ? (
        <EmptyState title="No locations yet" body="Locations appear once bizinsights can read them from Shopify (stock-level access) and the first check has run." />
      ) : (
        <>
          {withStock.length > 1 && (
            <Card id="by-location" title="Available stock by location" aside={`${fmtNum(total)} available in all`}>
              <ul className="space-y-3">
                {withStock.map((l) => (
                  <ShareRow key={l.id} label={l.name} sub={total ? `${Math.round((l.stock!.available / total) * 100)}% of all available` : undefined} value={fmtNum(l.stock!.available)} fraction={l.stock!.available / most} />
                ))}
              </ul>
            </Card>
          )}
          <section aria-labelledby="locations-h" className="home-card animate-rise min-w-0 overflow-hidden">
            <h2 id="locations-h" className="home-h2 px-5 pt-5 pb-4 sm:px-6">
              Locations
            </h2>
            <KitTable label="Locations" minWidth="60rem">
              <KitHead>
                <tr>
                  <KitTh>Location</KitTh>
                  <KitTh right>Items stocked</KitTh>
                  <KitTh right>Available</KitTh>
                  <KitTh right>On hand</KitTh>
                  <KitTh right>Committed</KitTh>
                  <KitTh right>Incoming</KitTh>
                  <KitTh right>Low</KitTh>
                  <KitTh right>Out</KitTh>
                  {status?.can.costs && <KitTh right>Stock value at cost</KitTh>}
                  <KitTh>Read from Shopify</KitTh>
                </tr>
              </KitHead>
              <tbody>
                {data.locations.map((l) => (
                  <tr key={l.id} className={KIT_ROW} data-testid={`location-${l.id}`}>
                    <KitTd>
                      <span className="font-medium">{l.name}</span>
                      {!l.active && <span className={TAG}>Inactive</span>}
                      {l.fulfillmentService && <span className={TAG}>App-managed</span>}
                      <span className="block text-xs text-muted">
                        {l.address ?? "No address"} · ID {l.id}
                        {l.fulfillsOnlineOrders ? " · Fulfils online orders" : ""}
                      </span>
                    </KitTd>
                    <KitTd right>{l.stock ? fmtNum(l.stock.itemsStocked) : "—"}</KitTd>
                    <KitTd right>
                      <Qty value={l.stock?.available} strong />
                    </KitTd>
                    <KitTd right>
                      <Qty value={l.stock?.onHand} />
                    </KitTd>
                    <KitTd right>
                      <Qty value={l.stock?.committed} />
                    </KitTd>
                    <KitTd right>
                      <Qty value={l.stock?.incoming} />
                    </KitTd>
                    <KitTd right>{l.stock ? <span className={l.stock.lowStock ? "font-medium text-warn" : ""}>{fmtNum(l.stock.lowStock)}</span> : "—"}</KitTd>
                    <KitTd right>{l.stock ? <span className={l.stock.outOfStock ? "font-medium text-danger" : ""}>{fmtNum(l.stock.outOfStock)}</span> : "—"}</KitTd>
                    {status?.can.costs && (
                      <KitTd right>
                        {l.stock?.costValue === null || l.stock?.costValue === undefined ? "—" : fmtMoney(l.stock.costValue, currency)}
                        {l.stock && l.stock.costComplete === false && <span className="block text-[11px] text-muted">Some items have no cost</span>}
                      </KitTd>
                    )}
                    <KitTd className="text-xs text-muted">{fmtRelative(l.syncedAt) ?? "—"}</KitTd>
                  </tr>
                ))}
              </tbody>
            </KitTable>
            {withStock.some((l) => l.stock!.untrackedItems > 0) && <p className="border-t border-home-line px-5 py-3 text-xs text-muted sm:px-6">Items whose stock Shopify doesn&apos;t track aren&apos;t counted in these figures.</p>}
          </section>
        </>
      )}
    </>
  );
}

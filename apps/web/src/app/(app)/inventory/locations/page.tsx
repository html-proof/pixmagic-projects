"use client";
import { PageHeader } from "@/components/AppUi";
import { LoadError } from "@/components/LoadError";
import { EmptyState } from "@/components/ui";
import { Badge } from "@/components/dashboard/Primitives";
import { BarRow } from "@/components/dashboard/Charts";
import { fmtRelative } from "@/components/dashboard/format";
import { ConnectCard, Qty, SyncStrip, useInventory } from "@/components/inventory/InventoryUi";
import { Table, Td, Th } from "@/components/staff/ui";
import { fmtMoney, fmtNum, useApi } from "@/lib/api";
import type { LocationView } from "@/lib/inventory";

/** Every Shopify location with its stock, side by side; each item at each location counted once. */
export default function LocationsPage() {
  const { base, status } = useInventory();
  const currency = status?.store.currency ?? "USD";
  const { data, error, loading, reload } = useApi<{ locations: LocationView[] }>(`${base}/locations`);
  const withStock = data?.locations.filter((l) => l.stock) ?? [];
  const most = Math.max(1, ...withStock.map((l) => l.stock!.available));
  const total = withStock.reduce((n, l) => n + l.stock!.available, 0);
  return (
    <>
      <PageHeader title="Locations" sub="Your Shopify locations and the stock at each. An item stocked at two locations counts once at each, and once per unit in the totals." />
      <SyncStrip />
      <ConnectCard capability="stock_levels" />
      {error && !data ? (
        <LoadError what="the locations" error={error} onRetry={reload} busy={loading} />
      ) : !data ? (
        <div className="skeleton h-40 rounded-xl" />
      ) : data.locations.length === 0 ? (
        <EmptyState title="No locations yet" body="Locations appear once bizinsights can read them from Shopify (stock-level access) and the first check has run." />
      ) : (
        <>
          {withStock.length > 1 && (
            <section className="card space-y-2" aria-label="Available stock by location">
              <h2 className="font-semibold">Available stock by location</h2>
              {withStock.map((l) => (
                <BarRow key={l.id} label={l.name} sub={total ? `${Math.round((l.stock!.available / total) * 100)}% of all available` : undefined} value={fmtNum(l.stock!.available)} fraction={l.stock!.available / most} />
              ))}
            </section>
          )}
          <div className="card">
            <Table label="Locations">
              <thead>
                <tr>
                  <Th>Location</Th>
                  <Th right>Items stocked</Th>
                  <Th right>Available</Th>
                  <Th right>On hand</Th>
                  <Th right>Committed</Th>
                  <Th right>Incoming</Th>
                  <Th right>Low</Th>
                  <Th right>Out</Th>
                  {status?.can.costs && <Th right>Stock value at cost</Th>}
                  <Th>Read from Shopify</Th>
                </tr>
              </thead>
              <tbody>
                {data.locations.map((l) => (
                  <tr key={l.id} data-testid={`location-${l.id}`}>
                    <Td>
                      <span className="font-medium">{l.name}</span>{" "}
                      {!l.active && <Badge tone="neutral">Inactive</Badge>}
                      {l.fulfillmentService && <Badge tone="neutral">App-managed</Badge>}
                      <span className="block text-xs text-muted">
                        {l.address ?? "No address"} · ID {l.id}
                        {l.fulfillsOnlineOrders ? " · Fulfils online orders" : ""}
                      </span>
                    </Td>
                    <Td right>{l.stock ? fmtNum(l.stock.itemsStocked) : "—"}</Td>
                    <Td right>
                      <Qty value={l.stock?.available} strong />
                    </Td>
                    <Td right>
                      <Qty value={l.stock?.onHand} />
                    </Td>
                    <Td right>
                      <Qty value={l.stock?.committed} />
                    </Td>
                    <Td right>
                      <Qty value={l.stock?.incoming} />
                    </Td>
                    <Td right>{l.stock ? <span className={l.stock.lowStock ? "text-warn" : ""}>{fmtNum(l.stock.lowStock)}</span> : "—"}</Td>
                    <Td right>{l.stock ? <span className={l.stock.outOfStock ? "text-danger" : ""}>{fmtNum(l.stock.outOfStock)}</span> : "—"}</Td>
                    {status?.can.costs && (
                      <Td right>
                        {l.stock?.costValue === null || l.stock?.costValue === undefined ? "—" : fmtMoney(l.stock.costValue, currency)}
                        {l.stock && l.stock.costComplete === false && <span className="block text-[11px] text-muted">Some items have no cost</span>}
                      </Td>
                    )}
                    <Td className="text-xs text-muted">{fmtRelative(l.syncedAt) ?? "—"}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            {withStock.some((l) => l.stock!.untrackedItems > 0) && <p className="mt-2 text-xs text-muted">Items whose stock Shopify doesn&apos;t track aren&apos;t counted in these figures.</p>}
          </div>
        </>
      )}
    </>
  );
}

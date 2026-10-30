"use client";
import { useState, type ReactNode } from "react";
import { PageHeader } from "@/components/AppUi";
import { LoadError } from "@/components/LoadError";
import { BarRow, ColumnChart } from "@/components/dashboard/Charts";
import { LineChart } from "@/components/dashboard/LineChart";
import { fmtDay, fmtMoneyCompact } from "@/components/dashboard/format";
import { ConnectCard, Defined, useInventory, variantLabel } from "@/components/inventory/InventoryUi";
import { RangePicker, rangeQuery, type RangeChoice } from "@/components/inventory/RangePicker";
import { Table, Td, Th } from "@/components/staff/ui";
import { fmtMoney, fmtNum, useApi } from "@/lib/api";
import { openProduct } from "@/lib/inventory";

interface PerfRow {
  variantId: string;
  productId: string;
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  units: number;
  /** Only with permission to see costs and stock value. */
  revenue?: number;
  perDay: number;
  sellThrough: number | null;
  onHand: number | null;
}

interface ReportsAnswer {
  range: { from: string; to: string };
  source: "levels" | "variants";
  trend: Array<{ day: string; recorded: boolean; available: number | null; onHand: number | null; lowStock: number | null; outOfStock: number | null; costValue?: number | null; retailValue?: number | null }>;
  recordedDays: number;
  movement: Array<{ day: string; added: number; removed: number; bizinsights: number }>;
  products: { top: PerfRow[]; slow: PerfRow[]; unitsSold: number; perDay: number; sellThrough: number | null; ordersCoverRange: boolean };
  turnover: { value: number | null; note: string | null; costOfUnitsSold: number | null; averageStockValue: number | null } | null;
  stockouts: { total: number; items: Array<{ variantId: string | null; productTitle: string | null; variantTitle: string | null; count: number }> };
  locations: Array<{ id: string; name: string; active: boolean; available: number | null; onHand: number | null }>;
  unitsByFulfillmentLocation: null;
}

/**
 * Charts over a period. Trends come only from the day's-end stock records bizinsights has kept
 * (never worked back from today's stock); sales from the imported orders.
 */
export default function InventoryReportsPage() {
  const { base, status } = useInventory();
  const [range, setRange] = useState<RangeChoice>({ id: "30d" });
  const tz = status?.store.timezone ?? "UTC";
  const currency = status?.store.currency ?? "USD";
  const q = rangeQuery(range, tz);
  const { data, error, loading, reload } = useApi<ReportsAnswer>(q ? `${base}/reports?${q}` : null);
  const recorded = data?.trend.filter((d) => d.recorded) ?? [];

  return (
    <>
      <PageHeader title="Stock reports" sub="Stock over time, what sells and what doesn't, and where stock is." actions={status && <RangePicker value={range} onChange={setRange} timeZone={tz} />} />
      <ConnectCard capability="stock_levels" />
      {error && !data ? (
        <LoadError what="the reports" error={error} onRetry={reload} busy={loading} />
      ) : !data ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="skeleton h-56 rounded-xl" />
          ))}
        </div>
      ) : (
        <div className={`grid gap-4 lg:grid-cols-2 ${loading ? "opacity-70" : ""}`}>
          <Card title="Available stock over time" note={trendNote(data)}>
            {recorded.length >= 2 ? (
              <LineChart
                days={recorded.map((d) => d.day)}
                series={[
                  { key: "available", label: "Available", color: "var(--viz-cat-1)", values: recorded.map((d) => d.available ?? 0) },
                  { key: "onHand", label: "On hand", color: "var(--viz-cat-2)", values: recorded.map((d) => d.onHand ?? 0) },
                ]}
                format={(v) => `${fmtNum(v)} units`}
                fmtAxis={(v) => fmtNum(v)}
                integer
                label="Available and on-hand units at each recorded day's end"
              />
            ) : (
              <Empty>{recorded.length === 1 ? `One day recorded so far (${fmtDay(recorded[0]!.day)}): ${fmtNum(recorded[0]!.available)} available.` : "No day recorded in this period yet."}</Empty>
            )}
          </Card>
          {status?.can.costs && (
            <Card title="Stock value over time" note="On-hand units at cost (items with a cost) and at selling price, at each recorded day's end. Retail value isn't sales or profit.">
              {recorded.length >= 2 ? (
                <LineChart
                  days={recorded.map((d) => d.day)}
                  series={[
                    { key: "cost", label: "At cost", color: "var(--viz-cat-1)", values: recorded.map((d) => d.costValue ?? 0) },
                    { key: "retail", label: "At selling price", color: "var(--viz-cat-3)", values: recorded.map((d) => d.retailValue ?? 0) },
                  ]}
                  format={(v) => fmtMoney(v, currency)}
                  fmtAxis={(v) => fmtMoneyCompact(v, currency)}
                  label="Stock value at cost and at selling price at each recorded day's end"
                />
              ) : (
                <Empty>Needs two recorded days.</Empty>
              )}
            </Card>
          )}
          <Card title="Low and out of stock over time" note="Variants low and out of stock at each recorded day's end.">
            {recorded.length >= 2 ? (
              <LineChart
                days={recorded.map((d) => d.day)}
                series={[
                  { key: "low", label: "Low stock", color: "var(--viz-cat-2)", values: recorded.map((d) => d.lowStock ?? 0) },
                  { key: "out", label: "Out of stock", color: "var(--viz-cat-3)", values: recorded.map((d) => d.outOfStock ?? 0) },
                ]}
                format={(v) => fmtNum(v)}
                fmtAxis={(v) => fmtNum(v)}
                integer
                label="Low-stock and out-of-stock variants at each recorded day's end"
              />
            ) : (
              <Empty>Needs two recorded days.</Empty>
            )}
          </Card>
          <Card title="Stock movement" note="Available units added and taken off each day, as bizinsights saw the changes (sales, restocks, changes made here).">
            {data.movement.some((m) => m.added || m.removed) ? (
              <LineChart
                days={data.movement.map((m) => m.day)}
                series={[
                  { key: "added", label: "Added", color: "var(--viz-cat-1)", values: data.movement.map((m) => m.added) },
                  { key: "removed", label: "Taken off", color: "var(--viz-cat-3)", values: data.movement.map((m) => m.removed) },
                ]}
                format={(v) => `${fmtNum(v)} units`}
                fmtAxis={(v) => fmtNum(v)}
                integer
                bars
                label="Available units added and taken off per day"
              />
            ) : (
              <Empty>No stock changes seen in this period.</Empty>
            )}
          </Card>

          <Card title="Top sellers" note={`Items sold in the period less items returned, as Shopify's sales by product count them; revenue is net sales before tax. Most sold first.${data.products.ordersCoverRange ? "" : " The imported orders don't cover the whole period."}`}>
            <PerfTable rows={data.products.top} currency={currency} empty="Nothing sold in this period." money={!!status?.can.costs} />
          </Card>
          <Card title="Slow movers" note="Items with stock available that sold the fewest units in the period.">
            <PerfTable rows={data.products.slow} currency={currency} empty="No items with stock." money={!!status?.can.costs} />
          </Card>

          <Card title="Sales velocity and sell-through" note="">
            <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
              <Stat label="Units sold" value={fmtNum(data.products.unitsSold)} />
              <Stat label="Units per day" value={fmtNum(data.products.perDay)} />
              <Stat label={<Defined label="Sell-through" definition="Units sold ÷ (units sold + units on hand now)." />} value={data.products.sellThrough === null ? "—" : `${fmtNum(data.products.sellThrough)}%`} />
              {data.turnover && (
                <Stat
                  label={<Defined label="Inventory turnover" definition="Cost of the units sold ÷ the average stock value at cost over the period, from the daily stock records." />}
                  value={data.turnover.value === null ? "—" : `${fmtNum(data.turnover.value)}×`}
                  sub={data.turnover.note ?? undefined}
                />
              )}
              <Stat label="Times items sold out" value={fmtNum(data.stockouts.total)} sub="Available falling to 0, as seen" />
            </div>
            {data.stockouts.items.length > 0 && (
              <ul className="mt-3 space-y-1 text-sm">
                {data.stockouts.items.slice(0, 5).map((s) => (
                  <li key={s.variantId ?? s.productTitle} className="flex justify-between gap-2">
                    <span className="truncate">{variantLabel(s.productTitle ?? "Deleted product", s.variantTitle ?? "")}</span>
                    <span className="tabular-nums text-muted">{fmtNum(s.count)}×</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Stock by location" note="Available units at each location now. Which location fulfilled each sale isn't in the orders bizinsights imports, so units sold by location aren't shown.">
            {data.locations.filter((l) => l.available !== null).length ? (
              <div className="space-y-2">
                {(() => {
                  const most = Math.max(1, ...data.locations.map((l) => l.available ?? 0));
                  return data.locations.map((l) => <BarRow key={l.id} label={l.name} value={fmtNum(l.available)} fraction={(l.available ?? 0) / most} sub={l.active ? undefined : "Inactive"} />);
                })()}
              </div>
            ) : (
              <Empty>Needs stock-level access in Shopify.</Empty>
            )}
          </Card>
          {data.movement.length > 0 && data.movement.some((m) => m.bizinsights) && (
            <Card title="Changes made in bizinsights" note="Net available units changed from bizinsights each day.">
              <ColumnChart values={data.movement.map((m) => Math.abs(m.bizinsights))} labels={data.movement.map((m) => `${fmtDay(m.day)}: ${m.bizinsights > 0 ? "+" : ""}${fmtNum(m.bizinsights)}`)} highlight={null} format={(n) => fmtNum(n)} label="Net units changed in bizinsights per day" />
            </Card>
          )}
        </div>
      )}
    </>
  );
}

function trendNote(d: ReportsAnswer): string {
  const days = d.trend.length;
  return `Each day's end, from bizinsights' own stock records: ${fmtNum(d.recordedDays)} of ${fmtNum(days)} days recorded. Days before bizinsights followed the stock aren't filled in.`;
}

function Card({ title, note, children }: { title: string; note: string; children: ReactNode }) {
  return (
    <section className="card min-w-0" aria-label={title}>
      <h2 className="font-semibold">{title}</h2>
      {note && <p className="mb-3 mt-0.5 text-xs text-muted">{note}</p>}
      {children}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted">{children}</p>;
}

function Stat({ label, value, sub }: { label: ReactNode; value: ReactNode; sub?: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-bg p-2.5">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-0.5 font-semibold tabular-nums">{value}</p>
      {sub && <p className="mt-0.5 text-[11px] text-muted">{sub}</p>}
    </div>
  );
}

function PerfTable({ rows, currency, empty, money }: { rows: PerfRow[]; currency: string; empty: string; money: boolean }) {
  if (!rows.length) return <Empty>{empty}</Empty>;
  return (
    <Table label="Products">
      <thead>
        <tr>
          <Th>Item</Th>
          <Th right>Units</Th>
          <Th right>Per day</Th>
          {money && <Th right>Revenue</Th>}
          <Th right>On hand</Th>
          <Th right>Sell-through</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.variantId}>
            <Td>
              <button type="button" className="text-left hover:underline" onClick={() => openProduct(r.productId)}>
                {variantLabel(r.productTitle, r.variantTitle)}
              </button>
              {r.sku && <span className="block text-xs text-muted">SKU {r.sku}</span>}
            </Td>
            <Td right>{fmtNum(r.units)}</Td>
            <Td right>{fmtNum(r.perDay)}</Td>
            {money && <Td right>{fmtMoney(r.revenue ?? null, currency)}</Td>}
            <Td right>{r.onHand === null ? "—" : fmtNum(r.onHand)}</Td>
            <Td right>{r.sellThrough === null ? "—" : `${fmtNum(r.sellThrough)}%`}</Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

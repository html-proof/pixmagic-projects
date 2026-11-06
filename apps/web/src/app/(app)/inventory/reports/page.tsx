"use client";
import { useState, type ReactNode } from "react";
import { PageHeader } from "@/components/AppUi";
import { LoadError } from "@/components/LoadError";
import { Card, FigureTile, ShareRow } from "@/components/PageKit";
import { ColumnChart } from "@/components/dashboard/Charts";
import { LineChart } from "@/components/dashboard/LineChart";
import { fmtDay, fmtMoneyCompact } from "@/components/dashboard/format";
import { ConnectCard, useInventory, variantLabel } from "@/components/inventory/InventoryUi";
import { RangePicker, rangeQuery, type RangeChoice } from "@/components/inventory/RangePicker";
import { DefinedMark, KIT_ROW, KitHead, KitTable, KitTd, KitTh, SoftNote } from "@/components/inventory/StockKit";
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

const SELL_THROUGH = "Units sold ÷ (units sold + units on hand now).";
const TURNOVER = "Cost of the units sold ÷ the average stock value at cost over the period, from the daily stock records.";

/**
 * Charts over a period, in the look of the Stitch design's Stock pages (its screen 23 draws the
 * stock value over time): the period's sales figures as tiles, then each chart and list on a card.
 * Trends come only from the day's-end stock records bizinsights has kept (never worked back from
 * today's stock); sales from the imported orders.
 */
export default function InventoryReportsPage() {
  const { base, status } = useInventory();
  const [range, setRange] = useState<RangeChoice>({ id: "30d" });
  const tz = status?.store.timezone ?? "UTC";
  const currency = status?.store.currency ?? "USD";
  const q = rangeQuery(range, tz);
  const { data, error, loading, reload } = useApi<ReportsAnswer>(q ? `${base}/reports?${q}` : null);
  const recorded = data?.trend.filter((d) => d.recorded) ?? [];
  const lastValue = [...recorded].reverse().find((d) => d.costValue !== null && d.costValue !== undefined);

  return (
    <>
      <PageHeader title="Inventory reports" sub="Stock over time, what sells and what doesn't, and where stock is." actions={status && <RangePicker value={range} onChange={setRange} timeZone={tz} />} />
      <ConnectCard capability="stock_levels" />
      {error && !data ? (
        <LoadError what="the reports" error={error} onRetry={reload} busy={loading} />
      ) : !data ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="skeleton h-56 rounded-lg" />
          ))}
        </div>
      ) : (
        <div className={`space-y-4 ${loading ? "opacity-70" : ""}`}>
          <section aria-label="Sales velocity and sell-through" className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-5">
            <FigureTile testId="report-units" title="Units sold" value={fmtNum(data.products.unitsSold)} sub={data.products.ordersCoverRange ? "In the period, less returns" : "The imported orders don't cover the whole period"} />
            <FigureTile testId="report-per-day" title="Units per day" value={fmtNum(data.products.perDay)} />
            <FigureTile
              testId="report-sell-through"
              title="Sell-through"
              icon={<DefinedMark definition={SELL_THROUGH} />}
              value={data.products.sellThrough === null ? "—" : `${fmtNum(data.products.sellThrough)}%`}
              sub={<span className="sr-only">{SELL_THROUGH}</span>}
            />
            {data.turnover && (
              <FigureTile
                testId="report-turnover"
                title="Inventory turnover"
                icon={<DefinedMark definition={TURNOVER} />}
                value={data.turnover.value === null ? "—" : `${fmtNum(data.turnover.value)}×`}
                sub={
                  <>
                    <span className="sr-only">{TURNOVER} </span>
                    {data.turnover.note}
                  </>
                }
              />
            )}
            <FigureTile testId="report-stockouts" title="Times items sold out" value={fmtNum(data.stockouts.total)} sub="Available falling to 0, as seen" />
          </section>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card id="trend-available" title="Available stock over time">
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
                <SoftNote>{recorded.length === 1 ? `One day recorded so far (${fmtDay(recorded[0]!.day)}): ${fmtNum(recorded[0]!.available)} available.` : "No day recorded in this period yet."}</SoftNote>
              )}
              <Note>{trendNote(data)}</Note>
            </Card>
            {status?.can.costs && (
              <Card
                id="trend-value"
                title="Stock value over time"
                aside={
                  lastValue && (
                    <span>
                      <span className="text-lg font-semibold text-text tabular-nums">{fmtMoney(lastValue.costValue ?? null, currency)}</span> at cost, {fmtDay(lastValue.day)}
                    </span>
                  )
                }
              >
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
                  <SoftNote>Needs two recorded days.</SoftNote>
                )}
                <Note>On-hand units at cost (items with a cost) and at selling price, at each recorded day&apos;s end. Retail value isn&apos;t sales or profit.</Note>
              </Card>
            )}
            <Card id="trend-low-out" title="Low and out of stock over time">
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
                <SoftNote>Needs two recorded days.</SoftNote>
              )}
              <Note>Variants low and out of stock at each recorded day&apos;s end.</Note>
            </Card>
            <Card id="movement" title="Stock movement">
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
                <SoftNote>No stock changes seen in this period.</SoftNote>
              )}
              <Note>Available units added and taken off each day, as bizinsights saw the changes (sales, restocks, changes made here).</Note>
            </Card>

            <Card id="top-sellers" title="Top sellers">
              <PerfTable rows={data.products.top} currency={currency} empty="Nothing sold in this period." money={!!status?.can.costs} />
              <Note>
                Items sold in the period less items returned, as Shopify&apos;s sales by product count them; revenue is net sales before tax. Most sold first.
                {data.products.ordersCoverRange ? "" : " The imported orders don't cover the whole period."}
              </Note>
            </Card>
            <Card id="slow-movers" title="Slow movers">
              <PerfTable rows={data.products.slow} currency={currency} empty="No items with stock." money={!!status?.can.costs} />
              <Note>Items with stock available that sold the fewest units in the period.</Note>
            </Card>

            {data.stockouts.items.length > 0 && (
              <Card id="stockouts" title="Items that sold out" aside={`${fmtNum(data.stockouts.total)}× in all`}>
                <ul className="space-y-1.5">
                  {data.stockouts.items.slice(0, 5).map((s) => (
                    <li key={s.variantId ?? s.productTitle} className="flex items-center justify-between gap-3 rounded bg-home-soft px-3 py-2 text-sm">
                      <span className="min-w-0 truncate">{variantLabel(s.productTitle ?? "Deleted product", s.variantTitle ?? "")}</span>
                      <span className="shrink-0 font-semibold tabular-nums">{fmtNum(s.count)}×</span>
                    </li>
                  ))}
                </ul>
                <Note>Available falling to 0, as seen.</Note>
              </Card>
            )}
            <Card id="by-location" title="Stock by location">
              {data.locations.filter((l) => l.available !== null).length ? (
                <ul className="space-y-3">
                  {(() => {
                    const most = Math.max(1, ...data.locations.map((l) => l.available ?? 0));
                    return data.locations.map((l) => <ShareRow key={l.id} label={l.name} value={fmtNum(l.available)} fraction={(l.available ?? 0) / most} sub={l.active ? undefined : "Inactive"} />);
                  })()}
                </ul>
              ) : (
                <SoftNote>Needs stock-level access in Shopify.</SoftNote>
              )}
              <Note>Available units at each location now. Which location fulfilled each sale isn&apos;t in the orders bizinsights imports, so units sold by location aren&apos;t shown.</Note>
            </Card>
            {data.movement.length > 0 && data.movement.some((m) => m.bizinsights) && (
              <Card id="made-here" title="Changes made in bizinsights">
                <ColumnChart values={data.movement.map((m) => Math.abs(m.bizinsights))} labels={data.movement.map((m) => `${fmtDay(m.day)}: ${m.bizinsights > 0 ? "+" : ""}${fmtNum(m.bizinsights)}`)} highlight={null} format={(n) => fmtNum(n)} label="Net units changed in bizinsights per day" />
                <Note>Net available units changed from bizinsights each day.</Note>
              </Card>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function trendNote(d: ReportsAnswer): string {
  const days = d.trend.length;
  return `Each day's end, from bizinsights' own stock records: ${fmtNum(d.recordedDays)} of ${fmtNum(days)} days recorded. Days before bizinsights followed the stock aren't filled in.`;
}

/** What a card shows and where it comes from, at its foot. */
const Note = ({ children }: { children: ReactNode }) => <p className="mt-auto pt-4 text-xs text-muted">{children}</p>;

function PerfTable({ rows, currency, empty, money }: { rows: PerfRow[]; currency: string; empty: string; money: boolean }) {
  if (!rows.length) return <SoftNote>{empty}</SoftNote>;
  return (
    <KitTable label="Products" minWidth="32rem">
      <KitHead>
        <tr>
          <KitTh>Item</KitTh>
          <KitTh right>Units</KitTh>
          <KitTh right>Per day</KitTh>
          {money && <KitTh right>Revenue</KitTh>}
          <KitTh right>On hand</KitTh>
          <KitTh right>Sell-through</KitTh>
        </tr>
      </KitHead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.variantId} className={KIT_ROW}>
            <KitTd>
              <button type="button" className="text-left font-medium hover:underline" onClick={() => openProduct(r.productId)}>
                {variantLabel(r.productTitle, r.variantTitle)}
              </button>
              {r.sku && <span className="block text-xs text-muted">SKU {r.sku}</span>}
            </KitTd>
            <KitTd right>{fmtNum(r.units)}</KitTd>
            <KitTd right>{fmtNum(r.perDay)}</KitTd>
            {money && <KitTd right>{fmtMoney(r.revenue ?? null, currency)}</KitTd>}
            <KitTd right>{r.onHand === null ? "—" : fmtNum(r.onHand)}</KitTd>
            <KitTd right>{r.sellThrough === null ? "—" : `${fmtNum(r.sellThrough)}%`}</KitTd>
          </tr>
        ))}
      </tbody>
    </KitTable>
  );
}

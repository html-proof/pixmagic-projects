"use client";
import Link from "next/link";
import { useState } from "react";
import { PageHeader } from "@/components/AppUi";
import { LoadError } from "@/components/LoadError";
import { Delta, NeutralDelta } from "@/components/dashboard/Primitives";
import { fmtDay, fmtRelative } from "@/components/dashboard/format";
import { ConnectCard, Defined, ProductThumb, Qty, SOURCE_NOTE, StockBadge, SyncStrip, useInventory, variantLabel } from "@/components/inventory/InventoryUi";
import { RangePicker, rangeQuery, RANGES, type RangeChoice } from "@/components/inventory/RangePicker";
import { fmtMoney, fmtNum, useLiveApi } from "@/lib/api";
import { openProduct, type Kpi, type OverviewAnswer, type StockRow } from "@/lib/inventory";
import { INVENTORY_KPIS, KPI_INFO, type InventoryKpi } from "@app/shared/inventory";

/** Figures where going up is good or bad; the rest are neutral. */
const GOOD_UP = new Set<InventoryKpi>(["unitsToday", "unitsMonth", "turnover"]);
const GOOD_DOWN = new Set<InventoryKpi>(["lowStock", "outOfStock"]);
const MONEY = new Set<InventoryKpi>(["costValue", "retailValue"]);

export default function InventoryOverviewPage() {
  const { base, status } = useInventory();
  const [range, setRange] = useState<RangeChoice>({ id: "30d" });
  const tz = status?.store.timezone ?? "UTC";
  const currency = status?.store.currency ?? "USD";
  const q = rangeQuery(range, tz);
  const { data, error, loading } = useLiveApi<OverviewAnswer>(q ? `${base}/overview?${q}` : null, 60_000);
  const label = RANGES.find(([id]) => id === range.id)?.[1] ?? "";

  return (
    <>
      <PageHeader
        title="Inventory overview"
        sub={status ? `${status.store.name} · ${SOURCE_NOTE[status.status.source]}` : undefined}
        actions={status && <RangePicker value={range} onChange={setRange} timeZone={tz} />}
      />
      <SyncStrip />
      <ConnectCard capability="stock_levels" />
      {error && !data ? (
        <LoadError what="the inventory overview" error={error} onRetry={() => setRange({ ...range })} busy={loading} />
      ) : !data ? (
        <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-3 xl:grid-cols-4" aria-busy="true" aria-label="Loading">
          {INVENTORY_KPIS.map((k) => (
            <div key={k} className="skeleton h-32 rounded-xl" />
          ))}
        </div>
      ) : (
        <>
          <section aria-label="Inventory figures" className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-3 xl:grid-cols-4">
            {INVENTORY_KPIS.map((k) => (
              <KpiTile key={k} id={k} kpi={data.kpis[k] ?? null} currency={currency} data={data} rangeLabel={label} />
            ))}
          </section>
          {data.untracked.variants > 0 && (
            <p className="text-xs text-muted" data-testid="untracked-note">
              Not counted above: {fmtNum(data.untracked.variants)} {data.untracked.variants === 1 ? "variant whose" : "variants whose"} stock Shopify doesn&apos;t track
              {data.untracked.onHand !== null ? ` (${fmtNum(data.untracked.onHand)} units recorded on hand)` : ""}.
            </p>
          )}
          <div className="grid gap-4 lg:grid-cols-2">
            <Attention title="Out of stock" rows={data.outOfStock.rows} total={data.outOfStock.total} href="/inventory/out-of-stock" empty="Nothing is out of stock." />
            <Attention title="Low stock" rows={data.lowStock.rows} total={data.lowStock.total} href="/inventory/low-stock" empty="Nothing is running low." />
          </div>
        </>
      )}
    </>
  );
}

function fmtKpi(id: InventoryKpi, v: number | null, currency: string) {
  if (v === null) return "—";
  if (MONEY.has(id)) return fmtMoney(v, currency);
  if (id === "turnover") return `${fmtNum(v)}×`;
  if (id === "daysOfStock") return `${fmtNum(v)} ${v === 1 ? "day" : "days"}`;
  return fmtNum(v);
}

function KpiTile({ id, kpi, currency, data, rangeLabel }: { id: InventoryKpi; kpi: Kpi | null; currency: string; data: OverviewAnswer; rangeLabel: string }) {
  const info = KPI_INFO[id];
  // Costs and stock value: not for this member (the API left them out).
  if (kpi === null) {
    return (
      <div className="flex min-w-0 flex-col gap-1 rounded-lg border border-dashed border-border bg-surface p-3 sm:p-4" data-testid={`kpi-${id}`}>
        <p className="text-xs font-medium text-muted">{info.label}</p>
        <p className="text-sm text-muted">Hidden: needs permission to see costs and stock value.</p>
      </div>
    );
  }
  const compared = id === "unitsToday" ? "vs yesterday so far" : id === "unitsMonth" ? "vs last month so far" : id === "turnover" ? "vs the period before" : `vs ${fmtDay(data.comparedWith)}`;
  const asOf = kpi.basis === "stock" ? (data.status.stockUpdatedAt ?? data.status.catalogSyncedAt) : data.status.catalogSyncedAt;
  return (
    <div className="lift flex min-w-0 flex-col gap-1 rounded-lg border border-transparent bg-surface p-3 shadow-[var(--shadow)] sm:p-4" data-testid={`kpi-${id}`}>
      <p className="text-xs font-medium text-muted">
        <Defined label={info.label} definition={info.definition} />
      </p>
      <p className="truncate text-xl font-semibold tabular-nums sm:text-2xl">{fmtKpi(id, kpi.value, currency)}</p>
      {/* A change only where there is something to compare with; otherwise the note says why not. */}
      <div className="min-h-5">
        {kpi.value === null || kpi.previous === null ? null : GOOD_UP.has(id) || GOOD_DOWN.has(id) ? (
          <Delta value={kpi.change} invert={GOOD_DOWN.has(id)} label={compared} />
        ) : (
          <NeutralDelta value={kpi.change} />
        )}
      </div>
      {kpi.previous !== null && <p className="text-xs text-muted">Before: {fmtKpi(id, kpi.previous, currency)}</p>}
      {kpi.note && <p className="text-xs text-muted">{kpi.note}</p>}
      {id === "turnover" && <p className="text-xs text-muted">{rangeLabel}</p>}
      <p className="mt-auto pt-1 text-[11px] text-muted">{asOf ? `As of ${fmtRelative(asOf)}` : "Not synced yet"}</p>
    </div>
  );
}

function Attention({ title, rows, total, href, empty }: { title: string; rows: StockRow[]; total: number; href: string; empty: string }) {
  return (
    <section className="card min-w-0" aria-label={title}>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-semibold">
          {title} <span className="text-sm font-normal text-muted">({fmtNum(total)})</span>
        </h2>
        {total > 0 && (
          <Link href={href} className="text-sm text-accent underline">
            See all
          </Link>
        )}
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-muted">{empty}</p>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((r) => (
            <li key={r.variantId}>
              <button type="button" className="flex w-full items-center gap-3 py-2 text-left hover:bg-text/[0.02]" onClick={() => openProduct(r.productId)}>
                <ProductThumb url={r.imageUrl} title={r.productTitle} size={32} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{variantLabel(r.productTitle, r.variantTitle)}</span>
                  <span className="block truncate text-xs text-muted">
                    {r.sku ? `SKU ${r.sku}` : "No SKU"}
                    {r.daysOfStock !== null ? ` · about ${fmtNum(r.daysOfStock)} days left` : ""}
                  </span>
                </span>
                <span className="text-right text-sm">
                  <Qty value={r.available} strong />
                  <span className="block">
                    <StockBadge status={r.status} />
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

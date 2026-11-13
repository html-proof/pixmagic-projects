"use client";
import Link from "next/link";
import { useState } from "react";
import { CircleCheck, Search } from "lucide-react";
import { PageHeader } from "@/components/AppUi";
import { LoadError } from "@/components/LoadError";
import { FigureTile } from "@/components/PageKit";
import { fmtRelative } from "@/components/dashboard/format";
import { ConnectCard, SOURCE_NOTE, StockStatus, SyncNote, useCanAdjust, useInventory } from "@/components/inventory/InventoryUi";
import { RangePicker, rangeQuery, RANGES, type RangeChoice } from "@/components/inventory/RangePicker";
import { AttentionChips, DefinedMark, SettingsLink, SuggestedOrderNote } from "@/components/inventory/StockKit";
import { AttentionRows } from "@/components/inventory/StockTable";
import { fmtMoney, fmtNum, liveDataChanged, useApi, useLiveApi } from "@/lib/api";
import type { InventorySettingsView, Kpi, OverviewAnswer } from "@/lib/inventory";
import { INVENTORY_KPIS, KPI_INFO, type InventoryKpi } from "@app/shared/inventory";

const MONEY = new Set<InventoryKpi>(["costValue", "retailValue"]);

/**
 * The Inventory overview as the owner's approved Stitch design draws "Needs attention" (prototype
 * v2, screen 21): how current the stock is, the chips to what's out and what's low, and the items
 * that need attention with their sales rate, days left and suggested order. The sixteen figures
 * follow under "More detail", with the period they're for.
 */
export default function InventoryOverviewPage() {
  const { base, status } = useInventory();
  const canAdjust = useCanAdjust();
  const [range, setRange] = useState<RangeChoice>({ id: "30d" });
  const tz = status?.store.timezone ?? "UTC";
  const currency = status?.store.currency ?? "USD";
  const q = rangeQuery(range, tz);
  const { data, error, loading } = useLiveApi<OverviewAnswer>(q ? `${base}/overview?${q}` : null, 60_000);
  const settings = useApi<{ settings: InventorySettingsView }>(`${base}/settings`);
  const label = RANGES.find(([id]) => id === range.id)?.[1] ?? "";

  return (
    <>
      <PageHeader
        title="Inventory overview"
        sub={
          <>
            <p>What to restock and how much.</p>
            {status && (
              <p className="mt-0.5 text-xs">
                {status.store.name} · {SOURCE_NOTE[status.status.source]}
              </p>
            )}
          </>
        }
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
      {error && !data ? (
        <LoadError what="the inventory overview" error={error} onRetry={() => setRange({ ...range })} busy={loading} />
      ) : !data ? (
        <div className="space-y-4" aria-busy="true" aria-label="Loading">
          <div className="skeleton h-16 rounded-lg" />
          <div className="skeleton h-72 rounded-lg" />
          <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
            {INVENTORY_KPIS.map((k) => (
              <div key={k} className="skeleton h-32 rounded-lg" />
            ))}
          </div>
        </div>
      ) : (
        <>
          <div className="home-card animate-rise flex flex-wrap items-center justify-between gap-3 p-3 sm:p-4">
            <AttentionChips active="all" out={data.outOfStock.total} low={data.lowStock.total} />
            {/* The search the design puts here is the full stock list's: it searches every product. */}
            <Link href="/inventory/stock" className="home-btn h-9 border border-home-line bg-surface">
              <Search aria-hidden className="h-4 w-4" />
              Search all stock
            </Link>
          </div>
          <NeedsAttention data={data} settings={settings.data?.settings ?? null} canAdjust={canAdjust} />

          <section aria-labelledby="more-detail-h" className="space-y-4 pt-2">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 id="more-detail-h" className="home-h2">
                  More detail
                </h2>
                <p className="mt-0.5 text-xs text-muted">Every figure the stock and the imported orders give. Turnover and the comparisons are for the period picked.</p>
              </div>
              <RangePicker value={range} onChange={setRange} timeZone={tz} />
            </div>
            <div role="group" aria-label="Inventory figures" className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
              {INVENTORY_KPIS.map((k) => (
                <KpiTile key={k} id={k} kpi={data.kpis[k] ?? null} currency={currency} data={data} rangeLabel={label} />
              ))}
            </div>
            {data.untracked.variants > 0 && (
              <p className="text-xs text-muted" data-testid="untracked-note">
                Not counted above: {fmtNum(data.untracked.variants)} {data.untracked.variants === 1 ? "variant whose" : "variants whose"} stock Shopify doesn&apos;t track
                {data.untracked.onHand !== null ? ` (${fmtNum(data.untracked.onHand)} units recorded on hand)` : ""}.
              </p>
            )}
          </section>
        </>
      )}
    </>
  );
}

/**
 * What needs attention: the overview's out-of-stock and low-stock items (the ten with the fewest
 * available of each), with a link to each full list when there are more.
 */
function NeedsAttention({ data, settings, canAdjust }: { data: OverviewAnswer; settings: InventorySettingsView | null; canAdjust: boolean }) {
  const rows = [...data.outOfStock.rows, ...data.lowStock.rows];
  const groups = [
    { key: "out", what: "out of stock", list: data.outOfStock, href: "/inventory/out-of-stock", empty: "Nothing is out of stock." },
    { key: "low", what: "low on stock", list: data.lowStock, href: "/inventory/low-stock", empty: "Nothing is running low." },
  ];
  return (
    <section aria-labelledby="attention-h" className="home-card animate-rise min-w-0 overflow-hidden" data-testid="needs-attention">
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-5 pt-5 pb-4 sm:px-6">
        <h2 id="attention-h" className="home-h2">
          Needs attention
        </h2>
        <p className="text-xs text-muted">Out of stock first, then low; fewest available first · every location together</p>
      </div>
      {rows.length === 0 ? (
        <p className="flex items-center gap-2 px-5 pb-5 text-sm text-muted sm:px-6">
          <CircleCheck aria-hidden className="h-4 w-4 shrink-0 text-good" strokeWidth={2.25} />
          Nothing is out of stock. Nothing is running low.
        </p>
      ) : (
        <>
          <AttentionRows rows={rows} label="Stock that needs attention" onChanged={liveDataChanged} />
          <ul className="space-y-1 border-t border-home-line px-5 py-3 text-xs text-muted sm:px-6">
            {groups.map((g) => (
              <li key={g.key}>
                {g.list.total === 0 ? (
                  g.empty
                ) : (
                  <>
                    {g.list.rows.length < g.list.total ? `Showing ${fmtNum(g.list.rows.length)} of ${fmtNum(g.list.total)} items ${g.what}. ` : `${fmtNum(g.list.total)} ${g.list.total === 1 ? "item" : "items"} ${g.what}. `}
                    <Link href={g.href} className="font-medium text-accent hover:underline">
                      See all<span className="sr-only"> {g.what}</span>
                    </Link>
                  </>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      <SuggestedOrderNote settings={settings} salesDays={data.salesDays} canAdjust={canAdjust} />
    </section>
  );
}

function fmtKpi(id: InventoryKpi, v: number | null, currency: string) {
  if (v === null) return "—";
  if (MONEY.has(id)) return fmtMoney(v, currency);
  if (id === "turnover") return `${fmtNum(v)}×`;
  if (id === "daysOfStock") return `${fmtNum(v)} ${v === 1 ? "day" : "days"}`;
  return fmtNum(v);
}

/** One of the sixteen figures (components/PageKit.tsx FigureTile): its definition behind the "?", the change, before, notes and how current it is. */
function KpiTile({ id, kpi, currency, data, rangeLabel }: { id: InventoryKpi; kpi: Kpi | null; currency: string; data: OverviewAnswer; rangeLabel: string }) {
  const info = KPI_INFO[id];
  const mark = <DefinedMark definition={info.definition} />;
  // Costs and stock value: not for this member (the API left them out).
  if (kpi === null) {
    return (
      <FigureTile
        testId={`kpi-${id}`}
        title={info.label}
        icon={mark}
        value="—"
        sub={
          <>
            <span className="sr-only">{info.definition} </span>
            Hidden: needs permission to see costs and stock value.
          </>
        }
      />
    );
  }
  const asOf = kpi.basis === "stock" ? (data.status.stockUpdatedAt ?? data.status.catalogSyncedAt) : data.status.catalogSyncedAt;
  return (
    <FigureTile
      testId={`kpi-${id}`}
      title={info.label}
      icon={mark}
      value={fmtKpi(id, kpi.value, currency)}
      sub={
        <>
          <span className="sr-only">{info.definition} </span>
          {kpi.note && <span className="block">{kpi.note}</span>}
          {id === "turnover" && <span className="block">{rangeLabel}</span>}
          <span className="mt-1 block text-[11px]">{asOf ? `As of ${fmtRelative(asOf)}` : "Not synced yet"}</span>
        </>
      }
    />
  );
}

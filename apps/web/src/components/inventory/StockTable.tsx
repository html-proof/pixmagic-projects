"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Bookmark, Download, Search, X } from "lucide-react";
import { useToast } from "@/components/AppUi";
import { LoadError } from "@/components/LoadError";
import { EmptyState } from "@/components/ui";
import { fmtDay, fmtRelative } from "@/components/dashboard/format";
import { Pagination, Table, Td, Th } from "@/components/staff/ui";
import { api, apiHref, fmtMoney, fmtNum, useApi } from "@/lib/api";
import { openProduct, readSavedFilters, stockQueryString, writeSavedFilters, type Facets, type SavedFilter, type StockFilters, type StockPage, type StockRow } from "@/lib/inventory";
import { STOCK_STATUS_INFO, STOCK_STATUSES, type StockSort, type StockStatus } from "@app/shared/inventory";
import { Defined, ProductThumb, Qty, StockBadge, useInventory, variantLabel } from "./InventoryUi";

const PAGE_SIZE = 50;

/**
 * The stock list: one row per variant (at one location when one is picked), searchable by name,
 * SKU, barcode or variant, filtered by location, status, vendor, type, collection and price,
 * sortable, in pages; rows can be picked for a threshold or a CSV of their own; the whole filtered
 * list downloads as CSV for someone allowed to export. `fixed` filters belong to the page (Low
 * stock: status=low) and can't be cleared; `planning` adds the restock columns.
 */
export function StockTable({ fixed = {}, planning = false, title }: { fixed?: StockFilters; planning?: boolean; title: string }) {
  const { base, status } = useInventory();
  const toast = useToast();
  const currency = status?.store.currency ?? "USD";
  const can = status?.can;
  const storeId = status?.store.id ?? "";
  const levels = status?.status.source === "levels";
  const [filters, setFilters] = useState<StockFilters>({ sort: planning ? "available" : "product", dir: "asc" });
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saved, setSaved] = useState<SavedFilter[]>([]);
  const [bulkThreshold, setBulkThreshold] = useState("");

  useEffect(() => setSaved(storeId ? readSavedFilters(storeId) : []), [storeId]);
  // Search as they type, once they pause.
  useEffect(() => {
    const t = window.setTimeout(() => {
      setFilters((f) => (f.q === (search.trim() || undefined) ? f : { ...f, q: search.trim() || undefined }));
      setPage(1);
    }, 300);
    return () => window.clearTimeout(t);
  }, [search]);

  const query = { ...filters, ...fixed };
  const qs = stockQueryString({ ...query, page, pageSize: PAGE_SIZE });
  const { data, error, loading, reload } = useApi<StockPage>(`${base}/stock?${qs}`);
  const facets = useApi<Facets>(`${base}/stock/facets`);
  // The previous page stays on screen while the next one loads.
  const [shown, setShown] = useState<StockPage | null>(null);
  useEffect(() => {
    if (data) setShown(data);
  }, [data]);
  useEffect(() => setSelected(new Set()), [qs]);

  const set = (patch: StockFilters) => {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(1);
  };
  const sortBy = (sort: StockSort) => set({ sort, dir: filters.sort === sort && filters.dir === "asc" ? "desc" : "asc" });
  const chips = useMemo(() => {
    const out: Array<{ key: keyof StockFilters; label: string }> = [];
    const f = facets.data;
    if (filters.location) out.push({ key: "location", label: `Location: ${f?.locations.find((l) => l.id === filters.location)?.name ?? filters.location}` });
    if (filters.status && !fixed.status) out.push({ key: "status", label: STOCK_STATUS_INFO[filters.status].label });
    if (filters.vendor) out.push({ key: "vendor", label: `Vendor: ${filters.vendor}` });
    if (filters.type) out.push({ key: "type", label: `Type: ${filters.type}` });
    if (filters.collection) out.push({ key: "collection", label: `Collection: ${f?.collections.find((c) => c.id === filters.collection)?.title ?? filters.collection}` });
    if (filters.priceMin !== undefined) out.push({ key: "priceMin", label: `Price from ${fmtMoney(filters.priceMin, currency)}` });
    if (filters.priceMax !== undefined) out.push({ key: "priceMax", label: `Price up to ${fmtMoney(filters.priceMax, currency)}` });
    if (filters.q) out.push({ key: "q", label: `“${filters.q}”` });
    return out;
  }, [filters, facets.data, fixed.status, currency]);

  const rows = shown?.rows ?? [];
  const allPicked = rows.length > 0 && rows.every((r) => selected.has(r.variantId));
  const exportHref = apiHref(`${base}/stock/export?${stockQueryString(query)}`);

  const saveCurrent = () => {
    const name = window.prompt("Name this filter", chips.map((c) => c.label).join(", ").slice(0, 60) || "My filter");
    if (!name) return;
    const next = [...saved.filter((s) => s.name !== name), { name, filters }];
    setSaved(next);
    writeSavedFilters(storeId, next);
    toast("success", `Saved "${name}" on this device.`);
  };
  const removeSaved = (name: string) => {
    const next = saved.filter((s) => s.name !== name);
    setSaved(next);
    writeSavedFilters(storeId, next);
  };

  const exportSelected = () => {
    const picked = rows.filter((r) => selected.has(r.variantId));
    const header = ["Product", "Variant", "SKU", "Barcode", "Status", "Available", "On hand", "Committed", "Incoming", ...(can?.costs ? ["Cost per item", "Stock value at cost"] : [])];
    const cell = (v: string | number | null | undefined) => (v === null || v === undefined ? "" : typeof v === "number" ? String(v) : `"${(/^[=+\-@]/.test(v) ? `'${v}` : v).replace(/"/g, '""')}"`);
    const lines = [header, ...picked.map((r) => [r.productTitle, r.variantTitle, r.sku, r.barcode, STOCK_STATUS_INFO[r.status].label, r.available, r.onHand, r.committed, r.incoming, ...(can?.costs ? [r.unitCost ?? null, r.stockValue ?? null] : [])])].map((l) => l.map(cell).join(","));
    const blob = new Blob([`\uFEFF${lines.join("\r\n")}\r\n`], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `stock-selected-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const applyThreshold = async () => {
    const value = bulkThreshold.trim() === "" ? null : Number(bulkThreshold);
    if (value !== null && (!Number.isInteger(value) || value < 0)) {
      toast("error", "Enter a whole number of units, or leave it empty to go back to the store's threshold.");
      return;
    }
    let done = 0;
    for (const id of selected) {
      try {
        await api(`${base}/thresholds`, { method: "PUT", body: { target: "variant", id, threshold: value } });
        done++;
      } catch {
        /* counted below */
      }
    }
    toast(done === selected.size ? "success" : "error", `Threshold ${value === null ? "reset" : `set to ${value}`} for ${done} of ${selected.size} items.`);
    setSelected(new Set());
    setBulkThreshold("");
    void reload();
  };

  return (
    <div className="space-y-3">
      <div className="card space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative min-w-[14rem] flex-1">
            <span className="sr-only">Search {title.toLowerCase()}</span>
            <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
            <input className="input pl-9" placeholder="Search name, SKU, barcode or variant" value={search} onChange={(e) => setSearch(e.target.value)} data-testid="stock-search" />
          </label>
          {levels && (
            <select className="input w-auto" aria-label="Location" value={filters.location ?? ""} onChange={(e) => set({ location: e.target.value || undefined })}>
              <option value="">All locations</option>
              {facets.data?.locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                  {l.active ? "" : " (inactive)"}
                </option>
              ))}
            </select>
          )}
          {!fixed.status && (
            <select className="input w-auto" aria-label="Status" value={filters.status ?? ""} onChange={(e) => set({ status: (e.target.value || undefined) as StockStatus | undefined })}>
              <option value="">Any status</option>
              {STOCK_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STOCK_STATUS_INFO[s].label}
                  {facets.data?.statuses[s] !== undefined ? ` (${fmtNum(facets.data.statuses[s])})` : ""}
                </option>
              ))}
            </select>
          )}
          <details className="relative">
            <summary className="btn-secondary cursor-pointer list-none px-3 py-2 text-sm">More filters</summary>
            <div className="absolute right-0 z-20 mt-2 w-72 space-y-3 rounded-xl border border-border bg-surface p-4 shadow-lg">
              <label className="block text-xs text-muted">
                Vendor
                <select className="input mt-1" value={filters.vendor ?? ""} onChange={(e) => set({ vendor: e.target.value || undefined })}>
                  <option value="">Any</option>
                  {facets.data?.vendors.map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </label>
              <label className="block text-xs text-muted">
                Product type
                <select className="input mt-1" value={filters.type ?? ""} onChange={(e) => set({ type: e.target.value || undefined })}>
                  <option value="">Any</option>
                  {facets.data?.types.map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </label>
              <label className="block text-xs text-muted">
                Collection
                <select className="input mt-1" value={filters.collection ?? ""} onChange={(e) => set({ collection: e.target.value || undefined })}>
                  <option value="">Any</option>
                  {facets.data?.collections.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.title}
                    </option>
                  ))}
                </select>
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="block text-xs text-muted">
                  Price from
                  <input className="input mt-1" inputMode="decimal" defaultValue={filters.priceMin ?? ""} onBlur={(e) => set({ priceMin: e.target.value.trim() === "" ? undefined : Math.max(0, Number(e.target.value)) || 0 })} />
                </label>
                <label className="block text-xs text-muted">
                  Price up to
                  <input className="input mt-1" inputMode="decimal" defaultValue={filters.priceMax ?? ""} onBlur={(e) => set({ priceMax: e.target.value.trim() === "" ? undefined : Math.max(0, Number(e.target.value)) || 0 })} />
                </label>
              </div>
            </div>
          </details>
          {can?.export && (
            <a className="btn-secondary px-3 py-2 text-sm" href={exportHref} download data-testid="stock-export">
              <Download aria-hidden className="h-4 w-4" /> CSV
            </a>
          )}
        </div>
        {(chips.length > 0 || saved.length > 0) && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {chips.map((c) => (
              <button
                key={c.key}
                type="button"
                className="inline-flex items-center gap-1 rounded-full border border-border bg-bg px-2.5 py-1 hover:border-accent/50"
                onClick={() => {
                  if (c.key === "q") setSearch("");
                  set({ [c.key]: undefined });
                }}
                aria-label={`Remove filter ${c.label}`}
              >
                {c.label}
                <X aria-hidden className="h-3 w-3" />
              </button>
            ))}
            {chips.length > 0 && (
              <button type="button" className="inline-flex items-center gap-1 text-accent underline" onClick={saveCurrent}>
                <Bookmark aria-hidden className="h-3 w-3" /> Save filter
              </button>
            )}
            {saved.map((s) => (
              <span key={s.name} className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2.5 py-1 text-accent">
                <button type="button" onClick={() => (setSearch(s.filters.q ?? ""), setFilters(s.filters), setPage(1))}>
                  {s.name}
                </button>
                <button type="button" aria-label={`Delete saved filter ${s.name}`} onClick={() => removeSaved(s.name)}>
                  <X aria-hidden className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      {error && !shown ? (
        <LoadError what="the stock list" error={error} onRetry={reload} busy={loading} />
      ) : !shown ? (
        <div className="card space-y-3" aria-busy="true" aria-label="Loading">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="skeleton h-9" />
          ))}
        </div>
      ) : shown.total === 0 ? (
        <EmptyState
          title={chips.length ? "Nothing matches these filters" : fixed.status === "low" ? "Nothing is running low" : fixed.status === "out" ? "Nothing is out of stock" : "No products yet"}
          body={chips.length ? "Try fewer filters or another search." : fixed.status ? "Items appear here as soon as their stock reaches the low-stock threshold." : "Products appear once the store's catalog is imported from Shopify."}
        />
      ) : (
        <div className={`card ${loading ? "opacity-70" : ""}`} aria-busy={loading}>
          {error && <LoadError what="the latest page" error={error} onRetry={reload} busy={loading} />}
          {selected.size > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-accent/30 bg-accent/5 px-3 py-2 text-sm" data-testid="bulk-bar">
              <span className="font-medium">{fmtNum(selected.size)} selected</span>
              <button type="button" className="btn-secondary px-2.5 py-1 text-xs" onClick={exportSelected}>
                Export selected
              </button>
              {can?.alerts && (
                <span className="flex items-center gap-1">
                  <input className="input h-8 w-28 px-2 py-1 text-xs" inputMode="numeric" placeholder="Threshold" aria-label="Low-stock threshold for the selected items" value={bulkThreshold} onChange={(e) => setBulkThreshold(e.target.value)} />
                  <button type="button" className="btn-secondary px-2.5 py-1 text-xs" onClick={applyThreshold}>
                    Set threshold
                  </button>
                </span>
              )}
              <button type="button" className="ml-auto text-xs text-muted underline" onClick={() => setSelected(new Set())}>
                Clear
              </button>
            </div>
          )}
          <Table label={title}>
            <thead>
              <tr>
                <Th className="w-8">
                  <input type="checkbox" aria-label="Select every row on this page" checked={allPicked} onChange={() => setSelected(allPicked ? new Set() : new Set(rows.map((r) => r.variantId)))} />
                </Th>
                <SortTh label="Product" sort="product" current={filters} onSort={sortBy} />
                <SortTh label="SKU" sort="sku" current={filters} onSort={sortBy} />
                <SortTh label="Available" sort="available" current={filters} onSort={sortBy} right />
                {levels && <SortTh label="On hand" sort="on_hand" current={filters} onSort={sortBy} right />}
                {levels && <SortTh label="Committed" sort="committed" current={filters} onSort={sortBy} right />}
                {levels && <SortTh label="Incoming" sort="incoming" current={filters} onSort={sortBy} right />}
                {can?.costs && <Th right>Cost</Th>}
                {can?.costs && <SortTh label="Stock value" sort="value" current={filters} onSort={sortBy} right />}
                {planning && (
                  <Th right>
                    <Defined label="Sold / day" definition="Units sold per day over the last 30 days. Needs 14 days of imported orders." />
                  </Th>
                )}
                {planning && <Th right>Days left</Th>}
                {planning && (
                  <Th right>
                    <Defined label="Reorder" definition="Units to order now to cover the lead time and the days of sales set in Stock settings, less what's available and incoming." />
                  </Th>
                )}
                <Th>Status</Th>
                <SortTh label="Last updated" sort="updated" current={filters} onSort={sortBy} />
                <Th>
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Row key={`${r.variantId}`} r={r} levels={levels} planning={planning} costs={!!can?.costs} history={!!can?.history} currency={currency} locationName={shown.location ? (facets.data?.locations.find((l) => l.id === shown.location)?.name ?? "") : null} picked={selected.has(r.variantId)} onPick={() => setSelected((s) => toggle(s, r.variantId))} />
              ))}
            </tbody>
          </Table>
          <Pagination page={shown.page} pageSize={shown.pageSize} total={shown.total} onPage={(p) => setPage(p)} />
          {planning && shown.salesDays < 14 && <p className="mt-2 text-xs text-muted">Sales rates need at least 14 days of imported orders; bizinsights has {fmtNum(shown.salesDays)}.</p>}
        </div>
      )}
    </div>
  );
}

function toggle(s: Set<string>, id: string): Set<string> {
  const n = new Set(s);
  if (n.has(id)) n.delete(id);
  else n.add(id);
  return n;
}

function SortTh({ label, sort, current, onSort, right = false }: { label: string; sort: StockSort; current: StockFilters; onSort: (s: StockSort) => void; right?: boolean }) {
  const on = current.sort === sort;
  return (
    <Th right={right}>
      <button type="button" className={`inline-flex items-center gap-1 hover:text-text ${on ? "text-text" : ""}`} onClick={() => onSort(sort)} aria-sort={on ? (current.dir === "desc" ? "descending" : "ascending") : undefined}>
        {label}
        <span aria-hidden className="text-[10px]">{on ? (current.dir === "desc" ? "▼" : "▲") : ""}</span>
      </button>
    </Th>
  );
}

function Row({ r, levels, planning, costs, history, currency, locationName, picked, onPick }: { r: StockRow; levels: boolean; planning: boolean; costs: boolean; history: boolean; currency: string; locationName: string | null; picked: boolean; onPick: () => void }) {
  return (
    <tr className={picked ? "bg-accent/5" : undefined} data-testid={`stock-row-${r.variantId}`}>
      <Td>
        <input type="checkbox" aria-label={`Select ${variantLabel(r.productTitle, r.variantTitle)}`} checked={picked} onChange={onPick} />
      </Td>
      <Td>
        <button type="button" className="flex min-w-[12rem] items-center gap-2.5 text-left" onClick={() => openProduct(r.productId)}>
          <ProductThumb url={r.imageUrl} title={r.productTitle} />
          <span className="min-w-0">
            <span className="block truncate font-medium hover:underline">{r.productTitle}</span>
            <span className="block truncate text-xs text-muted">{r.variantTitle === "Default Title" ? (r.vendor ?? "") : r.options.length ? r.options.map((o) => o.value).join(" / ") : r.variantTitle}</span>
          </span>
        </button>
      </Td>
      <Td className="whitespace-nowrap text-xs">
        {r.sku ?? <span className="text-muted">No SKU</span>}
        {/* Where the numbers are from: the location picked, or how many locations stock it. */}
        <span className="block text-muted">{locationName ?? (r.locations === null ? "All locations" : r.locations === 1 ? "1 location" : `${fmtNum(r.locations)} locations`)}</span>
      </Td>
      <Td right>{r.tracked ? <Qty value={r.available} strong /> : <span className="text-muted">—</span>}</Td>
      {levels && <Td right>{r.tracked ? <Qty value={r.onHand} /> : <span className="text-muted">—</span>}</Td>}
      {levels && <Td right>{r.tracked ? <Qty value={r.committed} /> : <span className="text-muted">—</span>}</Td>}
      {levels && <Td right>{r.tracked ? <Qty value={r.incoming} /> : <span className="text-muted">—</span>}</Td>}
      {costs && <Td right>{r.unitCost === null || r.unitCost === undefined ? <span className="text-xs text-muted">No cost</span> : fmtMoney(r.unitCost, currency)}</Td>}
      {costs && <Td right>{r.stockValue === null || r.stockValue === undefined || !r.tracked ? <span className="text-muted">—</span> : fmtMoney(r.stockValue, currency)}</Td>}
      {planning && <Td right>{r.dailyRate === null ? "—" : fmtNum(r.dailyRate)}</Td>}
      {planning && <Td right>{r.daysOfStock === null ? "—" : <span title={r.depletionDate ? `Around ${fmtDay(r.depletionDate)}` : undefined}>{fmtNum(r.daysOfStock)}</span>}</Td>}
      {planning && <Td right>{r.restock === null ? "—" : <Qty value={r.restock} strong={r.restock > 0} />}</Td>}
      <Td>
        <StockBadge status={r.status} />
        {r.tracked && r.status !== "untracked" && <span className="mt-0.5 block text-[11px] text-muted">≤ {fmtNum(r.threshold)} is low</span>}
      </Td>
      <Td className="whitespace-nowrap text-xs text-muted">{fmtRelative(r.updatedAt) ?? "—"}</Td>
      <Td className="whitespace-nowrap text-xs">
        <button type="button" className="text-accent underline" onClick={() => openProduct(r.productId)}>
          View
        </button>
        {history && (
          <>
            {" · "}
            <Link className="text-accent underline" href={`/inventory/movements?variant=${r.variantId}`}>
              History
            </Link>
          </>
        )}
      </Td>
    </tr>
  );
}

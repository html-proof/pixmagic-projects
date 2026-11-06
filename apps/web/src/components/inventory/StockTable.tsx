"use client";
import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Bookmark, ChevronDown, Search, X } from "lucide-react";
import { useToast } from "@/components/AppUi";
import { LoadError } from "@/components/LoadError";
import { EmptyState } from "@/components/ui";
import { fmtRelative } from "@/components/dashboard/format";
import { Pagination } from "@/components/staff/ui";
import { api, apiHref, fmtMoney, fmtNum, useApi } from "@/lib/api";
import { openProduct, readSavedFilters, stockQueryString, writeSavedFilters, type Facets, type InventorySettingsView, type SavedFilter, type StockFilters, type StockPage, type StockRow } from "@/lib/inventory";
import { STOCK_STATUS_INFO, STOCK_STATUSES, type StockSort, type StockStatus } from "@app/shared/inventory";
import { Defined, ProductThumb, Qty, StockBadge, useCanAdjust, useInventory, variantLabel } from "./InventoryUi";
import { AddStockButton, AttentionChips, chipClass, DaysLeftTag, DownloadLink, KIT_ROW, KitHead, KitTable, KitTd, KitTh, LeftLine, SuggestedOrderNote, type AttentionView } from "./StockKit";

const PAGE_SIZE = 50;

/**
 * The stock list: one row per variant (at one location when one is picked), searchable by name,
 * SKU, barcode or variant, filtered by location, status, vendor, type, collection and price,
 * sortable, in pages; rows can be picked for a threshold or a CSV of their own; the whole filtered
 * list downloads as CSV for someone allowed to export. `fixed` filters belong to the page (Low
 * stock: status=low) and can't be cleared.
 *
 * Two looks, as the owner's approved Stitch design draws them: `planning` (Low stock, Out of
 * stock) is screen 21's "Needs attention" table: available, sold per day, days left as a tag, the
 * suggested order and "Add stock"; otherwise it is screen 22's list of every product with its
 * stock in each state, value and status. On a phone each row is a card (screen 24). `aside` sits
 * beside the filters (All stock's stock value).
 */
export function StockTable({ fixed = {}, planning = false, title, view, aside }: { fixed?: StockFilters; planning?: boolean; title: string; view?: Exclude<AttentionView, "all">; aside?: ReactNode }) {
  const { base, status } = useInventory();
  const toast = useToast();
  const currency = status?.store.currency ?? "USD";
  const can = status?.can;
  const storeId = status?.store.id ?? "";
  const levels = status?.status.source === "levels";
  const canAdjust = useCanAdjust();
  const [filters, setFilters] = useState<StockFilters>({ sort: planning ? "available" : "product", dir: "asc" });
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saved, setSaved] = useState<SavedFilter[]>([]);
  const [bulkThreshold, setBulkThreshold] = useState("");
  const [more, setMore] = useState(false);

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
  // The lead time and days to keep, for the line saying how the suggested order is worked out.
  const settings = useApi<{ settings: InventorySettingsView }>(planning ? `${base}/settings` : null);
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
  const locationName = shown?.location ? (facets.data?.locations.find((l) => l.id === shown.location)?.name ?? "") : null;
  const statuses = facets.data?.statuses;
  const count = (s: StockStatus) => (statuses ? (statuses[s] ?? 0) : null);

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
  const pick = (id: string) => setSelected((s) => toggle(s, id));
  // After a change Shopify confirmed: the rows, and the counts on the chips.
  const changed = () => {
    void reload();
    void facets.reload();
  };

  // Screen 22's status chips: every product, or those in one status (Not tracked only when there are some).
  const statusChips: Array<{ id: StockStatus | undefined; label: string; n: number | null }> = [
    { id: undefined, label: "All", n: statuses ? Object.values(statuses).reduce((a, b) => a + (b ?? 0), 0) : null },
    ...STOCK_STATUSES.filter((s) => s !== "untracked" || (count(s) ?? 0) > 0).map((s) => ({ id: s, label: STOCK_STATUS_INFO[s].label, n: count(s) })),
  ];

  const filterCard = (
    <div className="home-card animate-rise flex min-w-0 flex-col gap-3 p-3 sm:p-4" data-testid="stock-filters">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {planning && view ? (
          <AttentionChips active={view} out={count("out")} low={count("low")} />
        ) : (
          !fixed.status && (
            <div role="group" aria-label="Status" className="flex flex-wrap items-center gap-2">
              {statusChips.map((c) => {
                const on = filters.status === c.id;
                return (
                  <button key={c.id ?? "all"} type="button" aria-pressed={on} className={chipClass(on)} onClick={() => set({ status: c.id })}>
                    {c.label}
                    {c.n !== null && <span className="tabular-nums opacity-80">{fmtNum(c.n)}</span>}
                  </button>
                );
              })}
            </div>
          )
        )}
        <div className="flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto">
          <label className="relative min-w-0 flex-1 basis-full sm:w-72 sm:flex-none sm:basis-auto">
            <span className="sr-only">Search {title.toLowerCase()}</span>
            <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted" />
            <input className="input h-9 border-transparent bg-home-soft pl-9" placeholder="Search name, SKU, barcode or variant" value={search} onChange={(e) => setSearch(e.target.value)} data-testid="stock-search" />
          </label>
          {levels && (
            <select className="input h-9 w-auto max-w-full min-w-0 py-1" aria-label="Location" value={filters.location ?? ""} onChange={(e) => set({ location: e.target.value || undefined })}>
              <option value="">All locations</option>
              {facets.data?.locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                  {l.active ? "" : " (inactive)"}
                </option>
              ))}
            </select>
          )}
          <button type="button" className="home-btn border border-home-line bg-surface" aria-expanded={more} aria-controls="stock-more-filters" onClick={() => setMore((m) => !m)}>
            More filters
            <ChevronDown aria-hidden className={`h-4 w-4 transition-transform ${more ? "rotate-180" : ""}`} />
          </button>
          {can?.export && <DownloadLink href={exportHref} what={title.toLowerCase()} testId="stock-export" />}
        </div>
      </div>
      {more && (
        <div id="stock-more-filters" className="grid gap-3 rounded bg-home-soft p-3 sm:grid-cols-2 lg:grid-cols-5">
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
          <label className="block text-xs text-muted">
            Price from
            <input className="input mt-1" inputMode="decimal" defaultValue={filters.priceMin ?? ""} onBlur={(e) => set({ priceMin: e.target.value.trim() === "" ? undefined : Math.max(0, Number(e.target.value)) || 0 })} />
          </label>
          <label className="block text-xs text-muted">
            Price up to
            <input className="input mt-1" inputMode="decimal" defaultValue={filters.priceMax ?? ""} onBlur={(e) => set({ priceMax: e.target.value.trim() === "" ? undefined : Math.max(0, Number(e.target.value)) || 0 })} />
          </label>
        </div>
      )}
      {(chips.length > 0 || saved.length > 0) && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {chips.map((c) => (
            <button
              key={c.key}
              type="button"
              className="inline-flex items-center gap-1 rounded-full bg-home-soft px-2.5 py-1 hover:bg-home-soft-hover"
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
            <button type="button" className="inline-flex items-center gap-1 font-medium text-accent hover:underline" onClick={saveCurrent}>
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
  );

  return (
    <div className="space-y-4">
      {aside ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,17rem)_minmax(0,1fr)] lg:items-end">
          {aside}
          {filterCard}
        </div>
      ) : (
        filterCard
      )}

      {error && !shown ? (
        <LoadError what="the stock list" error={error} onRetry={reload} busy={loading} />
      ) : !shown ? (
        <div className="home-card space-y-3 p-5" aria-busy="true" aria-label="Loading">
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
        <section aria-label={title} className={`home-card animate-rise min-w-0 overflow-hidden ${loading ? "opacity-70" : ""}`} aria-busy={loading}>
          {error && (
            <div className="p-4">
              <LoadError what="the latest page" error={error} onRetry={reload} busy={loading} />
            </div>
          )}
          {selected.size > 0 && (
            <div className="flex flex-wrap items-center gap-2 border-b border-home-line bg-accent/5 px-4 py-2.5 text-sm sm:px-5" data-testid="bulk-bar">
              <span className="font-medium">{fmtNum(selected.size)} selected</span>
              <button type="button" className="home-btn h-8 border border-home-line bg-surface" onClick={exportSelected}>
                Export selected
              </button>
              {can?.alerts && (
                <span className="flex items-center gap-1">
                  <input className="input h-8 w-28 px-2 py-1 text-xs" inputMode="numeric" placeholder="Threshold" aria-label="Low-stock threshold for the selected items" value={bulkThreshold} onChange={(e) => setBulkThreshold(e.target.value)} />
                  <button type="button" className="home-btn h-8 border border-home-line bg-surface" onClick={applyThreshold}>
                    Set threshold
                  </button>
                </span>
              )}
              <button type="button" className="ml-auto text-xs text-muted underline" onClick={() => setSelected(new Set())}>
                Clear
              </button>
            </div>
          )}

          {/* A phone: each row as a card, as the design's screen 24 draws them. */}
          <ul className="divide-y divide-home-line sm:hidden" aria-label={title}>
            {rows.map((r) => (
              <PhoneRow key={r.variantId} r={r} locationId={shown.location} planning={planning} levels={levels} costs={!!can?.costs} history={!!can?.history} currency={currency} locationName={locationName} picked={selected.has(r.variantId)} onPick={() => pick(r.variantId)} onChanged={changed} />
            ))}
          </ul>

          <div className="hidden sm:block">
            <KitTable label={title} minWidth={planning ? "46rem" : "60rem"}>
              <Head planning={planning} levels={levels} costs={!!can?.costs} sort={{ current: filters, onSort: sortBy }} pickAll={{ checked: allPicked, onChange: () => setSelected(allPicked ? new Set() : new Set(rows.map((r) => r.variantId))) }} />
              <tbody>
                {rows.map((r) => (
                  <Row key={r.variantId} r={r} locationId={shown.location} levels={levels} planning={planning} costs={!!can?.costs} history={!!can?.history} currency={currency} locationName={locationName} picked={selected.has(r.variantId)} onPick={() => pick(r.variantId)} onChanged={changed} />
                ))}
              </tbody>
            </KitTable>
          </div>
          <div className="px-4 pb-4 sm:px-5">
            <Pagination page={shown.page} pageSize={shown.pageSize} total={shown.total} onPage={(p) => setPage(p)} />
          </div>
          {planning && <SuggestedOrderNote settings={settings.data?.settings ?? null} salesDays={shown.salesDays} canAdjust={canAdjust} />}
        </section>
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

/**
 * The overview's "Needs attention" rows (screen 21): the planning look of the same table, in the
 * order the overview gives them (out of stock, then low, fewest available first), without sorting
 * or picking rows.
 */
export function AttentionRows({ rows, label, onChanged }: { rows: StockRow[]; label: string; onChanged: () => void }) {
  const { status } = useInventory();
  const levels = status?.status.source === "levels";
  const common = { locationId: null, levels, planning: true, costs: false, history: !!status?.can.history, currency: status?.store.currency ?? "USD", locationName: null, onChanged, idPrefix: "attention" };
  return (
    <>
      <ul className="divide-y divide-home-line border-t border-home-line sm:hidden" aria-label={label}>
        {rows.map((r) => (
          <PhoneRow key={r.variantId} r={r} {...common} />
        ))}
      </ul>
      <div className="hidden sm:block">
        <KitTable label={label} minWidth="44rem">
          <Head planning levels={levels} costs={false} />
          <tbody>
            {rows.map((r) => (
              <Row key={r.variantId} r={r} {...common} />
            ))}
          </tbody>
        </KitTable>
      </div>
    </>
  );
}

/** The table's header row; a column sorts when `sort` is given, and a first column picks every row with `pickAll`. */
function Head({ planning, levels, costs, sort, pickAll }: { planning: boolean; levels: boolean; costs: boolean; sort?: { current: StockFilters; onSort: (s: StockSort) => void }; pickAll?: { checked: boolean; onChange: () => void } }) {
  const col = (label: string, by: StockSort, right = false) => (sort ? <SortTh label={label} sort={by} current={sort.current} onSort={sort.onSort} right={right} /> : <KitTh right={right}>{label}</KitTh>);
  return (
    <KitHead>
      <tr>
        {pickAll && (
          <KitTh className="w-10">
            <input type="checkbox" aria-label="Select every row on this page" checked={pickAll.checked} onChange={pickAll.onChange} />
          </KitTh>
        )}
        {col("Product", "product")}
        {!planning && col("SKU", "sku")}
        <KitTh>Location</KitTh>
        {col("Available", "available", true)}
        {levels && !planning && col("On hand", "on_hand", true)}
        {levels && !planning && col("Committed", "committed", true)}
        {levels && col("Incoming", "incoming", true)}
        {!planning && costs && <KitTh right>Cost</KitTh>}
        {!planning && costs && col("Value", "value", true)}
        {planning && (
          <KitTh right>
            <Defined label="Sold per day" definition="Units sold per day over the last 30 days. Needs 14 days of imported orders." />
          </KitTh>
        )}
        {planning && <KitTh>Days left</KitTh>}
        {planning && (
          <KitTh right>
            <Defined label="Suggested order" definition="Units to order now to cover the lead time and the days of sales set in Stock settings, less what's available and incoming." />
          </KitTh>
        )}
        {!planning && <KitTh>Status</KitTh>}
        {!planning && col("Last updated", "updated")}
        <KitTh right>
          <span className="sr-only">Actions</span>
        </KitTh>
      </tr>
    </KitHead>
  );
}

function SortTh({ label, sort, current, onSort, right = false }: { label: string; sort: StockSort; current: StockFilters; onSort: (s: StockSort) => void; right?: boolean }) {
  const on = current.sort === sort;
  return (
    <KitTh right={right} sort={on ? (current.dir === "desc" ? "descending" : "ascending") : undefined}>
      <button type="button" className={`inline-flex items-center gap-1 tracking-wider uppercase hover:text-text ${on ? "text-text" : ""}`} onClick={() => onSort(sort)}>
        {label}
        <span aria-hidden className="text-[10px]">{on ? (current.dir === "desc" ? "▼" : "▲") : ""}</span>
      </button>
    </KitTh>
  );
}

type RowProps = {
  r: StockRow;
  locationId: string | null;
  levels: boolean;
  planning: boolean;
  costs: boolean;
  history: boolean;
  currency: string;
  locationName: string | null;
  /** Without `onPick`, the row has no checkbox (the overview's list). */
  picked?: boolean;
  onPick?: () => void;
  onChanged: () => void;
  /** The rows' test ids: `stock-row-<variant>` in the stock list, `attention-row-…` on the overview. */
  idPrefix?: string;
};

/** Where the numbers are from: the location picked, or how many locations stock it. */
const whereFrom = (r: StockRow, locationName: string | null) => locationName ?? (r.locations === null ? "All locations" : r.locations === 1 ? "1 location" : `${fmtNum(r.locations)} locations`);

/** The line under a product's name: its variant (or vendor), and in the planning look its SKU. */
function variantLine(r: StockRow, withSku: boolean): string {
  const variant = r.variantTitle === "Default Title" ? (r.vendor ?? "") : r.options.length ? r.options.map((o) => o.value).join(" / ") : r.variantTitle;
  if (!withSku) return variant;
  return [variant, r.sku ? `SKU ${r.sku}` : "No SKU"].filter(Boolean).join(" · ");
}

const LINK = "text-[13px] font-medium text-accent hover:underline";

function Row({ r, locationId, levels, planning, costs, history, currency, locationName, picked = false, onPick, onChanged, idPrefix = "stock" }: RowProps) {
  const dash = <span className="text-muted">—</span>;
  return (
    <tr className={`${KIT_ROW} ${picked ? "bg-accent/5" : "hover:bg-home-soft/60"}`} data-testid={`${idPrefix}-row-${r.variantId}`}>
      {onPick && (
        <KitTd>
          <input type="checkbox" aria-label={`Select ${variantLabel(r.productTitle, r.variantTitle)}`} checked={picked} onChange={onPick} />
        </KitTd>
      )}
      <KitTd>
        <button type="button" className="flex min-w-[12rem] items-center gap-3 text-left" onClick={() => openProduct(r.productId)}>
          <ProductThumb url={r.imageUrl} title={r.productTitle} size={40} />
          <span className="min-w-0">
            <span className="block truncate font-medium hover:underline">{r.productTitle}</span>
            <span className="block truncate text-xs text-muted">{variantLine(r, planning)}</span>
          </span>
        </button>
      </KitTd>
      {!planning && <KitTd className="text-xs whitespace-nowrap">{r.sku ?? <span className="text-muted">No SKU</span>}</KitTd>}
      <KitTd className="text-xs whitespace-nowrap text-muted">{whereFrom(r, locationName)}</KitTd>
      <KitTd right>
        {r.tracked ? <Qty value={r.available} strong /> : dash}
        {planning && r.tracked && <span className="block text-[11px] text-muted">≤ {fmtNum(r.threshold)} is low</span>}
      </KitTd>
      {levels && !planning && <KitTd right>{r.tracked ? <Qty value={r.onHand} /> : dash}</KitTd>}
      {levels && !planning && <KitTd right>{r.tracked ? <Qty value={r.committed} /> : dash}</KitTd>}
      {levels && <KitTd right>{r.tracked ? <Qty value={r.incoming} /> : dash}</KitTd>}
      {!planning && costs && <KitTd right>{r.unitCost === null || r.unitCost === undefined ? <span className="text-xs text-muted">No cost</span> : fmtMoney(r.unitCost, currency)}</KitTd>}
      {!planning && costs && <KitTd right>{r.stockValue === null || r.stockValue === undefined || !r.tracked ? dash : fmtMoney(r.stockValue, currency)}</KitTd>}
      {planning && <KitTd right>{r.dailyRate === null ? dash : fmtNum(r.dailyRate)}</KitTd>}
      {planning && (
        <KitTd>
          <DaysLeftTag r={r} />
        </KitTd>
      )}
      {planning && <KitTd right>{r.restock === null ? dash : <Qty value={r.restock} strong={r.restock > 0} />}</KitTd>}
      {!planning && (
        <KitTd>
          <StockBadge status={r.status} />
          {r.tracked && r.status !== "untracked" && <span className="mt-0.5 block text-[11px] text-muted">≤ {fmtNum(r.threshold)} is low</span>}
        </KitTd>
      )}
      {!planning && <KitTd className="text-xs whitespace-nowrap text-muted">{fmtRelative(r.updatedAt) ?? "—"}</KitTd>}
      <KitTd right className="whitespace-nowrap">
        <span className="inline-flex items-center justify-end gap-3">
          {planning && <AddStockButton row={r} locationId={locationId} onDone={onChanged} />}
          <button type="button" className={LINK} onClick={() => openProduct(r.productId)}>
            View
          </button>
          {history && (
            <Link className={LINK} href={`/inventory/movements?variant=${r.variantId}`}>
              History
            </Link>
          )}
        </span>
      </KitTd>
    </tr>
  );
}

function PhoneRow({ r, locationId, levels, planning, costs, history, currency, locationName, picked = false, onPick, onChanged, idPrefix = "stock" }: RowProps) {
  const adds = useCanAdjust() && planning && r.tracked;
  return (
    <li className={`flex gap-3 px-4 py-4 ${picked ? "bg-accent/5" : ""}`} data-testid={`${idPrefix}-card-${r.variantId}`}>
      {onPick && <input type="checkbox" className="mt-1 shrink-0" aria-label={`Select ${variantLabel(r.productTitle, r.variantTitle)}`} checked={picked} onChange={onPick} />}
      <div className="min-w-0 flex-1">
        <button type="button" className="flex w-full min-w-0 items-start gap-3 text-left" onClick={() => openProduct(r.productId)}>
          <ProductThumb url={r.imageUrl} title={r.productTitle} size={56} />
          <span className="min-w-0 flex-1">
            <span className="block font-medium">{r.productTitle}</span>
            <span className="block truncate text-xs text-muted">{variantLine(r, true)}</span>
            <span className="block text-xs text-muted">{whereFrom(r, locationName)}</span>
          </span>
        </button>
        {planning ? (
          <>
            {r.tracked && <LeftLine r={r} />}
            <p className="mt-1 text-xs text-muted">
              {r.dailyRate !== null && <>{fmtNum(r.dailyRate)} sold per day · </>}
              suggested order {r.restock === null ? "—" : <span className="font-medium text-text tabular-nums">{fmtNum(r.restock)}</span>}
              {levels && r.incoming ? ` · ${fmtNum(r.incoming)} incoming` : ""}
            </p>
          </>
        ) : (
          <>
            <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              <span>
                Available <Qty value={r.tracked ? r.available : null} strong />
              </span>
              {levels && r.tracked && (
                <span className="text-muted">
                  On hand <Qty value={r.onHand} /> · Committed <Qty value={r.committed} /> · Incoming <Qty value={r.incoming} />
                </span>
              )}
              <StockBadge status={r.status} />
            </p>
            {costs && (
              <p className="mt-1 text-xs text-muted">
                Cost {r.unitCost === null || r.unitCost === undefined ? "not recorded" : fmtMoney(r.unitCost, currency)}
                {r.tracked && r.stockValue !== null && r.stockValue !== undefined ? ` · value ${fmtMoney(r.stockValue, currency)}` : ""}
              </p>
            )}
            <p className="mt-1 text-[11px] text-muted">
              {r.tracked && r.status !== "untracked" ? `≤ ${fmtNum(r.threshold)} is low · ` : ""}updated {fmtRelative(r.updatedAt) ?? "—"}
            </p>
          </>
        )}
        {(history || adds) && (
          <div className="mt-3 flex items-center justify-end gap-4 border-t border-home-line pt-3">
            {history && (
              <Link className={LINK} href={`/inventory/movements?variant=${r.variantId}`}>
                History
              </Link>
            )}
            {adds && <AddStockButton row={r} locationId={locationId} onDone={onChanged} quiet />}
          </div>
        )}
      </div>
    </li>
  );
}

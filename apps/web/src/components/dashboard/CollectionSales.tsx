"use client";
import { useApp } from "@/components/AppContext";
import { fmtMoney, fmtNum, fmtPct, useLiveApi } from "@/lib/api";
import { collectionSalesParams } from "./collectionDates";
import { fmtRelative } from "./format";
import { Panel } from "./Primitives";
import type { Overview } from "./types";

// ---------------------------------------------------------------------------
// Sales by collection on the products page (GET …/analytics/collections/sales,
// apps/api/src/routes/collections.ts; packages/core/src/reports/collections.ts;
// docs/product-performance.md "Sales by collection"). Its types are its own: the dashboard's
// answer doesn't carry it.
// ---------------------------------------------------------------------------

export interface CollectionFigures {
  netSales: number;
  grossSales: number;
  discounts: number;
  returns: number;
  units: number;
  orders: number;
  productsSold: number;
  share: number | null;
}

export interface CollectionRow extends CollectionFigures {
  collectionId: string;
  title: string;
}

export interface CollectionSalesReport {
  range: { from: string; to: string };
  complete: boolean;
  pendingOrders: number;
  unknownIdentitySales: number;
  historyFrom: string | null;
  lastSyncedAt: string | null;
  /** When the catalog's collections were last read from Shopify; null before the first read. */
  membershipAsOf: string | null;
  /** How many collections sold; `items` holds the best-selling 500 at most. */
  total: number;
  items: CollectionRow[];
  /** Products in no collection. */
  none: CollectionFigures | null;
  /** Products whose collections aren't known: added since the last catalog read, or no longer in it. */
  unknown: CollectionFigures | null;
  /** Every product sale once: what the shares are of. */
  totals: Omit<CollectionFigures, "share"> | null;
}

/** A collection to narrow Top products to. */
export interface CollectionChoice {
  id: string;
  title: string;
}

const LIVE_EVERY_MS = 15_000;

/** A collection's name, or its id when Shopify gave it none. */
export const collectionName = (c: { collectionId: string; title: string }) => c.title || `Collection ${c.collectionId}`;

/**
 * The report for the dashboard's dates (collectionSalesParams).
 * `shown` false (no product sales for this member
 * or store): nothing is asked.
 */
export function useCollectionSales(ov: Overview, shown: boolean) {
  const { workspace } = useApp();
  const params = collectionSalesParams(ov);
  const path = shown ? `/workspaces/${workspace.id}/stores/${ov.store.id}/analytics/collections/sales?${params}` : null;
  const live = useLiveApi<CollectionSalesReport>(path, LIVE_EVERY_MS);
  // Never the figures of other dates under these ones.
  return { report: live.data && live.dataPath === path ? live.data : null, error: live.error, loading: live.loading, failing: live.failing };
}

type Live = ReturnType<typeof useCollectionSales>;

export function CollectionSales({ ov, currency, live, onPick }: { ov: Overview; currency: string; live: Live; onPick?: (c: CollectionChoice) => void }) {
  const { allowed } = useApp();
  const r = live.report;
  const money = (n: number) => fmtMoney(n, currency);
  const read = fmtRelative(r?.membershipAsOf);
  const pinned: Array<{ key: string; label: string; note: string; f: CollectionFigures }> = [];
  if (r?.none) pinned.push({ key: "none", label: "Not in a collection", note: "Products in none of your collections.", f: r.none });
  if (r?.unknown) pinned.push({ key: "unknown", label: "Collections not known", note: "Products added since your catalog was last read, or no longer in it.", f: r.unknown });
  const rows = r?.items ?? [];
  const csv = () => {
    if (!allowed("reports.export") || !r) return;
    const line = (id: string, name: string, f: CollectionFigures) => [id, name, f.netSales, f.grossSales, f.discounts, f.returns, f.units, f.orders, f.productsSold, f.share];
    const values = [
      ["Collection ID", "Collection", "Net sales", "Gross sales", "Discounts", "Returns and adjustments", "Net units", "Orders", "Products sold", "Share of product sales"],
      ...rows.map((c) => line(c.collectionId, collectionName(c), c)),
      ...pinned.map((p) => line("", p.label, p.f)),
    ];
    const text = values.map((row) => row.map((v) => `"${(typeof v === "string" && /^\s*[=+\-@\t\r]/.test(v) ? "'" + v : String(v ?? "")).replaceAll('"', '""')}"`).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob(["﻿", text], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `collection-sales-${ov.range.from}-${ov.range.to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <Panel
      id="d-collection-sales"
      title="Sales by collection"
      help={`Each Shopify collection's product sales in these dates: net sales before tax, after discounts and returns (returns and cancellations on the day they were made), and its products' units and orders. A product in several collections counts in each, so collections add up to more than your product sales and their shares to more than 100%. Sales are grouped by the collections products are in now, not when they sold, as Shopify's own reports group them.`}
      aside={allowed("reports.export") && rows.length + pinned.length > 0 ? <button type="button" className="rounded border px-3 py-1" onClick={csv}>Export CSV</button> : null}
    >
      {live.error && !r && <p role="alert">Collection sales could not be loaded: {live.error.message}</p>}
      {live.failing && r && <p role="status">Refresh is delayed. Showing the last successful response.</p>}
      {r && !r.complete && (
        <p role="status" className="mb-3 text-sm">
          {r.unknownIdentitySales
            ? "Some sales in these dates no longer have a recoverable product, so they can't be put in their collections. Collection sales are withheld rather than shown without them."
            : <>Collection sales are unavailable until all sales for these dates are imported and verified. Imported history starts {r.historyFrom ?? "after synchronization completes"}.</>}
        </p>
      )}
      {!r ? (
        !live.error && <div aria-label="Loading collection sales" className="h-48 animate-pulse rounded bg-border" />
      ) : !r.complete ? null : rows.length + pinned.length === 0 ? (
        <p className="text-sm">No product sales in these dates.</p>
      ) : (
        <div className="max-h-[620px] overflow-auto">
          <table className="w-full whitespace-nowrap text-left text-sm">
            <thead className="sticky top-0 bg-surface">
              <tr>
                {["Collection", "Net sales", "Net units", "Orders", "Products sold", "Share of product sales"].map((h) => (
                  <th key={h} className="p-3" scope="col">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr className="border-t" key={c.collectionId}>
                  <th scope="row" className="p-3 font-normal">
                    {onPick ? (
                      <button type="button" className="text-left underline underline-offset-2" onClick={() => onPick({ id: c.collectionId, title: collectionName(c) })} aria-label={`Show ${collectionName(c)} in Top products`}>
                        {collectionName(c)}
                      </button>
                    ) : (
                      collectionName(c)
                    )}
                  </th>
                  <td className="p-3">{money(c.netSales)}</td>
                  <td className="p-3">{fmtNum(c.units)}</td>
                  <td className="p-3">{fmtNum(c.orders)}</td>
                  <td className="p-3">{fmtNum(c.productsSold)}</td>
                  <td className="p-3">{fmtPct(c.share)}</td>
                </tr>
              ))}
              {pinned.map((p) => (
                <tr className="border-t text-muted" key={p.key}>
                  <th scope="row" className="p-3 font-normal">
                    {p.label}
                    <small className="block">{p.note}</small>
                  </th>
                  <td className="p-3">{money(p.f.netSales)}</td>
                  <td className="p-3">{fmtNum(p.f.units)}</td>
                  <td className="p-3">{fmtNum(p.f.orders)}</td>
                  <td className="p-3">{fmtNum(p.f.productsSold)}</td>
                  <td className="p-3">{fmtPct(p.f.share)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {r?.complete && (
        <div className="mt-4 space-y-1 text-xs text-muted">
          {r.totals && (
            <p>
              All product sales, each once: {money(r.totals.netSales)} · {fmtNum(r.totals.units)} units · {fmtNum(r.totals.orders)} orders. Collections aren&apos;t added up: a product in two counts in both.
            </p>
          )}
          {r.total > rows.length && <p>Showing the {fmtNum(rows.length)} best-selling of {fmtNum(r.total)} collections.</p>}
          <p>{read ? `Collections as Shopify had them when your catalog was last read, ${read}.` : "Your catalog's collections haven't been read from Shopify yet."} {currency}</p>
        </div>
      )}
    </Panel>
  );
}

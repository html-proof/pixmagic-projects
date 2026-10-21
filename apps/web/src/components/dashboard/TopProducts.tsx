"use client";
import { useState } from "react";
import { useApp } from "@/components/AppContext";
import { fmtMoney, useLiveApi } from "@/lib/api";
import { Panel } from "./Primitives";
import type { Overview, ProductPerformance } from "./types";

export function TopProducts({ ov, currency }: { ov: Overview; currency: string }) {
  const { workspace, allowed } = useApp();
  const [sort, setSort] = useState("units");
  const [direction, setDirection] = useState("desc");
  const [search, setSearch] = useState("");
  const [size, setSize] = useState(10);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const params = new URLSearchParams({ dateFrom: ov.range.from, dateTo: ov.range.to, sortBy: sort, direction, search, limit: "100" });
  const path = `/workspaces/${workspace.id}/stores/${ov.store.id}/analytics/products/top-selling?${params}`;
  const { data, dataPath, error, loading, failing } = useLiveApi<ProductPerformance>(path, 15000);
  const report = dataPath === path ? data : sort === "units" && direction === "desc" && !search && !error ? ov.modules.top_products : null;
  const items = report?.items ?? [];
  const currentPage = Math.min(page, Math.max(1, Math.ceil(items.length / size)));
  const detail = items.find(p => p.key === selected);
  const money = (n: number) => fmtMoney(n, currency);
  const synchronizedAt = ov.freshness?.asOf ?? report?.lastSyncedAt;
  const csv = () => {
    if (!allowed("reports.export")) return;
    const values = [["Rank", "Product ID", "Product", "SKU", "Net units", "Gross units", "Returned units", "Gross sales", "Discounts", "Returns and adjustments", "Net revenue", "Orders", "Growth %", "Trend", "Last sold"],
      ...items.map(p => [p.rank, p.productId, p.title, p.sku, p.units, p.grossUnits, p.returnedUnits, p.grossSales, p.discounts, p.returns, p.revenue, p.orders, p.growth, p.trend, p.lastSold])];
    const text = values.map(row => row.map(v => `"${(typeof v === "string" && /^\s*[=+\-@\t\r]/.test(v) ? "'" + v : String(v ?? "")).replaceAll('"', '""')}"`).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob(["\ufeff", text], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a"); a.href = url; a.download = `top-products-${ov.range.from}-${ov.range.to}.csv`; a.click(); URL.revokeObjectURL(url);
  };
  return <Panel id="d-top-products" title="Top 100 products" help="Net units sold by default, with net revenue breaking ties. Returns and cancellations count on the date of their sales reversal. Growth compares the immediately preceding period, with the same elapsed time for a running day.">
    <div className="mb-4 flex flex-wrap gap-3">
      <label>Ranking <select className="rounded border bg-surface p-2" aria-label="Ranking" value={sort} onChange={e => { setSort(e.target.value); setDirection(e.target.value === "lowest" ? "asc" : "desc"); setPage(1); }}>
        <option value="units">Top selling by units</option><option value="revenue">Highest revenue</option><option value="trending">Trending</option><option value="growth">Fastest growing</option><option value="returned">Most returned</option><option value="lowest">Lowest performing</option>
      </select></label>
      <label>Order <select aria-label="Order" value={direction} onChange={e => { setDirection(e.target.value); setPage(1); }}><option value="desc">Highest first</option><option value="asc">Lowest first</option></select></label>
      <label>Search <input className="rounded border bg-surface p-2" aria-label="Search" value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} placeholder="Product, SKU or ID" /></label>
      {allowed("reports.export") && <button className="rounded border px-3" disabled={!items.length} onClick={csv}>Export CSV</button>}
    </div>
    {error && <p role="alert">Product sales could not be loaded: {error.message}</p>}
    {failing && report && <p role="status">Refresh is delayed. Showing the last successful response.</p>}
    {report && !report.complete && <p role="status" className="mb-3 text-sm">Rankings are unavailable until all sales for this period are imported and verified. Imported history starts {report.historyFrom ?? "after synchronization completes"}. A longer range may require approved historical order access.</p>}
    {report && !report.baseline && <p className="mb-3 text-sm text-muted">No complete previous period: growth and trending scores are unavailable.</p>}
    {ov.freshness && (ov.freshness.waiting > 0 || ov.freshness.failed > 0) && <p role="status">Sales updates are pending or failed. Figures may be behind Shopify.</p>}
    {loading && !report ? <div aria-label="Loading product sales" className="h-48 animate-pulse rounded bg-border" /> : !error && items.length === 0 ? report?.complete && <p>No product sales match these dates and filters.</p> : <div className="max-h-[620px] overflow-auto">
      <table className="w-full whitespace-nowrap text-left text-sm">
        <thead className="sticky top-0 bg-surface"><tr>{["Rank", "Product", "SKU", "Net units", "Net revenue", "Orders", "Growth", "Trend", "Last sold", "Action"].map(h => {
          const mode = h === "Net units" ? "units" : h === "Net revenue" ? "revenue" : h === "Growth" ? "growth" : h === "Trend" ? "trending" : null;
          return <th key={h} className="p-3" scope="col" aria-sort={mode === sort ? direction === "desc" ? "descending" : "ascending" : undefined}>{mode ? <button onClick={() => { setSort(mode); setDirection(mode === sort && direction === "desc" ? "asc" : "desc"); setPage(1); }}>{h}</button> : h}</th>;
        })}</tr></thead>
        <tbody>{items.slice((currentPage - 1) * size, currentPage * size).map(p => <tr className="border-t" key={p.key}>
          <td className="p-3">{p.rank}</td><td className="p-3"><div className="flex items-center gap-2">{p.imageUrl && <img src={p.imageUrl} alt="" width={32} height={32} loading="lazy" />}<span>{p.title}<small className="block text-muted">{p.productId ?? "Historical item · product ID unavailable"}</small></span></div></td>
          <td className="p-3">{p.sku ?? (p.variants.length > 1 ? "Multiple variants" : "—")}</td><td className="p-3">{p.units}</td><td className="p-3">{money(p.revenue)}</td><td className="p-3">{p.orders}</td>
          <td className="p-3">{p.growth === null ? p.trend === "New" ? "New" : "No baseline" : `${p.growth > 0 ? "+" : ""}${p.growth.toFixed(1)}%`}</td><td className="p-3">{p.trend}</td><td className="p-3">{p.lastSold ? new Date(p.lastSold).toLocaleString(undefined, { timeZone: ov.store.timezone }) : "—"}</td>
          <td className="p-3"><button className="underline" onClick={() => setSelected(p.key)} aria-label={`View ${p.title}`}>Details</button></td>
        </tr>)}</tbody>
      </table></div>}
    <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
      <label>Rows <select aria-label="Rows" value={size} onChange={e => { setSize(Number(e.target.value)); setPage(1); }}>{[10,25,50,100].map(n => <option key={n}>{n}</option>)}</select></label>
      <button disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>Previous</button><span>Page {currentPage} of {Math.max(1, Math.ceil(items.length / size))} · {items.length} products</span><button disabled={currentPage * size >= items.length} onClick={() => setPage(currentPage + 1)}>Next</button>
      <span className="text-muted">Last synchronized: {synchronizedAt ? new Date(synchronizedAt).toLocaleString() : "Awaiting sync"} · {currency}</span>
    </div>
    {detail && <aside aria-label={`${detail.title} details`} className="fixed inset-y-0 right-0 z-50 w-full max-w-xl overflow-y-auto border-l border-border bg-surface p-6 shadow-xl">
      <button className="float-right underline" onClick={() => setSelected(null)}>Close details</button><h3 className="font-semibold">{detail.title}</h3>
      <p>Gross units: {detail.grossUnits} · Returned units: {detail.returnedUnits} · Net units: {detail.units}</p>
      <p>Gross sales: {money(detail.grossSales)} · Discounts: {money(detail.discounts)} · Returns and adjustments: {money(detail.returns)} · Net revenue: {money(detail.revenue)}</p>
      <p>Trend score: {detail.trendScore?.toFixed(1) ?? "No baseline"}. Minimum five net units; weights: units 30%, unit growth 20%, revenue growth 15%, orders 15%, recent velocity 10%, sales consistency 10%.</p>
      <ul>{detail.variants.map((v,i) => <li key={v.variantId ?? i}>{v.sku ?? "No SKU"} · Variant {v.variantId ?? "unavailable"}: {v.units} units · {money(v.revenue)}</li>)}</ul>
    </aside>}
  </Panel>;
}

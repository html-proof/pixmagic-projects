"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ExternalLink, X } from "lucide-react";
import { useToast } from "@/components/AppUi";
import { LoadError } from "@/components/LoadError";
import { ColumnChart } from "@/components/dashboard/Charts";
import { fmtDay } from "@/components/dashboard/format";
import { Table, Td, Th } from "@/components/staff/ui";
import { api, fmtMoney, fmtNum, useApi } from "@/lib/api";
import { openProduct, type ProductDetail, type VariantView } from "@/lib/inventory";
import { QUANTITY_INFO } from "@app/shared/inventory";
import { AdjustDialog, confirmedMessage, type AdjustTarget } from "./AdjustDialog";
import { ProductThumb, Qty, StockBadge, useCanAdjust, useInventory, variantLabel } from "./InventoryUi";
import { MovementList } from "./MovementList";

/**
 * One product, in a panel over the page: what Shopify holds about it, each variant with its stock
 * at every location (each quantity state), its sales, and the stock history bizinsights has seen.
 * Opened from any Inventory page (?product=…), closed with Escape or the backdrop.
 */
export function ProductPanel({ productId }: { productId: string }) {
  const { base, status } = useInventory();
  const currency = status?.store.currency ?? "USD";
  const can = status?.can;
  const { data, error, loading, reload } = useApi<ProductDetail>(`${base}/products/${productId}`);
  const media = useApi<{ images: Array<{ url: string; alt: string | null }>; options: Array<{ name: string; values: string[] }> }>(can?.products ? `${base}/products/${productId}/media` : null);
  const [adjust, setAdjust] = useState<AdjustTarget | null>(null);
  const [threshold, setThreshold] = useState<{ variant: VariantView; value: string } | null>(null);
  const toast = useToast();
  const panel = useRef<HTMLDivElement>(null);
  const close = () => openProduct(null);
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>("button")?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector('[role="dialog"][aria-modal="true"]:not([data-product-panel])')) closeRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      before?.focus?.();
    };
  }, []);

  const p = data?.product;
  const levelsKnown = status?.status.source === "levels";
  const canAdjust = useCanAdjust();

  const saveThreshold = async () => {
    if (!threshold) return;
    const value = threshold.value.trim() === "" ? null : Number(threshold.value);
    if (value !== null && (!Number.isInteger(value) || value < 0)) {
      toast("error", "Enter a whole number of units, or leave it empty to use the store's threshold.");
      return;
    }
    try {
      await api(`${base}/thresholds`, { method: "PUT", body: { target: "variant", id: threshold.variant.id, threshold: value } });
      toast("success", value === null ? "Back to the store's low-stock threshold." : `Low stock now means ${value} or fewer available.`);
      setThreshold(null);
      void reload();
    } catch (e) {
      toast("error", e instanceof Error ? e.message : "The threshold couldn't be saved.");
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal="true" aria-labelledby="product-title" data-product-panel data-testid="product-panel">
      <div className="animate-fade absolute inset-0 bg-black/45" onClick={close} aria-hidden />
      <div ref={panel} className="animate-sheet relative flex h-full w-full max-w-4xl flex-col bg-bg shadow-2xl sm:border-l sm:border-border">
        <header className="flex items-center gap-3 border-b border-border bg-surface px-4 py-3 sm:px-6">
          {p && <ProductThumb url={p.imageUrl} title={p.title} size={40} />}
          <div className="min-w-0 flex-1">
            <h2 id="product-title" className="truncate text-lg font-semibold">
              {p?.title ?? "Product"}
            </h2>
            {p && (
              <p className="truncate text-xs text-muted">
                {[p.vendor, p.productType, p.status && p.status[0]!.toUpperCase() + p.status.slice(1)].filter(Boolean).join(" · ")}
              </p>
            )}
          </div>
          {p && (
            <a href={p.adminUrl} target="_blank" rel="noreferrer" className="btn-secondary hidden px-3 py-1.5 text-xs sm:inline-flex">
              Open in Shopify <ExternalLink aria-hidden className="h-3.5 w-3.5" />
            </a>
          )}
          <button type="button" className="grid h-9 w-9 place-items-center rounded-lg text-muted hover:bg-text/[0.05] hover:text-text" aria-label="Close" onClick={close}>
            <X aria-hidden className="h-5 w-5" />
          </button>
        </header>
        <div className="flex-1 space-y-5 overflow-y-auto px-4 py-5 sm:px-6">
          {error ? (
            <LoadError what="this product" error={error} onRetry={reload} busy={loading} />
          ) : !data || !p ? (
            <div className="space-y-3" aria-busy="true">
              {[80, 60, 90, 70].map((w) => (
                <div key={w} className="skeleton h-6" style={{ width: `${w}%` }} />
              ))}
            </div>
          ) : (
            <>
              {can?.products && (
                <Section title="Product information">
                  {media.data && media.data.images.length > 1 && (
                    <div className="mb-3 flex gap-2 overflow-x-auto">
                      {media.data.images.map((m) => (
                        <img key={m.url} src={`${m.url}${m.url.includes("?") ? "&" : "?"}width=160`} alt={m.alt ?? ""} width={80} height={80} loading="lazy" className="h-20 w-20 shrink-0 rounded-lg border border-border object-cover" />
                      ))}
                    </div>
                  )}
                  <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                    <Item label="Product ID">{p.id}</Item>
                    <Item label="Category">{p.category ?? "—"}</Item>
                    <Item label="Type">{p.productType ?? "—"}</Item>
                    <Item label="Vendor">{p.vendor ?? "—"}</Item>
                    <Item label="Collections">{p.collections.length ? p.collections.map((c) => c.title).join(", ") : "—"}</Item>
                    <Item label="Tags">{p.tags.length ? p.tags.join(", ") : "—"}</Item>
                    <Item label="Created">{p.createdAt ? new Date(p.createdAt).toLocaleDateString() : "—"}</Item>
                    <Item label="Last updated">{new Date(p.updatedAt).toLocaleString()}</Item>
                    {p.onlineStoreUrl && (
                      <Item label="On the online store">
                        <a className="underline" href={p.onlineStoreUrl} target="_blank" rel="noreferrer">
                          View product page
                        </a>
                      </Item>
                    )}
                    {media.data && media.data.options.length > 0 && <Item label="Options">{media.data.options.map((o) => `${o.name}: ${o.values.join(", ")}`).join(" · ")}</Item>}
                  </dl>
                  {p.description && <p className="mt-3 whitespace-pre-line text-sm leading-relaxed text-text/85">{p.description}</p>}
                </Section>
              )}

              <Section title={`Variants (${data.variants.length})`}>
                <div className="space-y-4">
                  {data.variants.map((v) => (
                    <div key={v.id} className="rounded-xl border border-border bg-surface p-4" data-testid={`variant-${v.id}`}>
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-medium">{v.title === "Default Title" ? p.title : v.title}</p>
                          <p className="text-xs text-muted">
                            {[v.sku && `SKU ${v.sku}`, can?.products && v.barcode && `Barcode ${v.barcode}`, `Variant ${v.id}`].filter(Boolean).join(" · ")}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <StockBadge status={v.status} />
                          {canAdjust && v.tracked && (
                            <button type="button" className="btn-secondary px-3 py-1 text-xs" onClick={() => setAdjust({ variantId: v.id, label: variantLabel(p.title, v.title), sku: v.sku, levels: v.levels })}>
                              Adjust stock
                            </button>
                          )}
                        </div>
                      </div>
                      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
                        <Item label="Price">{fmtMoney(v.price, currency)}</Item>
                        {can?.products && <Item label="Compare-at price">{v.compareAtPrice === null ? "—" : fmtMoney(v.compareAtPrice, currency)}</Item>}
                        {can?.costs && <Item label="Cost per item">{v.unitCost === null || v.unitCost === undefined ? "Not recorded" : fmtMoney(v.unitCost, currency)}</Item>}
                        <Item label="Tracking">{v.tracked ? (v.continueSelling ? "Tracked · keeps selling when out" : "Tracked") : "Not tracked"}</Item>
                        {can?.products && <Item label="Taxable">{v.taxable === null ? "—" : v.taxable ? "Yes" : "No"}</Item>}
                        {can?.products && <Item label="Ships">{v.requiresShipping === null ? "—" : v.requiresShipping ? `Yes${v.weight !== null ? ` · ${fmtNum(v.weight)} ${weightUnit(v.weightUnit)}` : ""}` : "No (digital or service)"}</Item>}
                        {v.options.length > 0 && <Item label="Options">{v.options.map((o) => `${o.name}: ${o.value}`).join(", ")}</Item>}
                        <Item label="Low-stock threshold">
                          {threshold?.variant.id === v.id ? (
                            <span className="flex items-center gap-1">
                              <input className="input h-8 w-20 px-2 py-1" inputMode="numeric" aria-label="Low-stock threshold" value={threshold.value} onChange={(e) => setThreshold({ variant: v, value: e.target.value })} />
                              <button type="button" className="btn-primary h-8 px-2 py-1 text-xs" onClick={saveThreshold}>
                                Save
                              </button>
                            </span>
                          ) : (
                            <span>
                              {fmtNum(v.threshold)}
                              {v.lowStockThreshold === null ? " (store's)" : " (this item's)"}
                              {can?.alerts && (
                                <button type="button" className="ml-1 text-xs text-accent underline" onClick={() => setThreshold({ variant: v, value: v.lowStockThreshold === null ? "" : String(v.lowStockThreshold) })}>
                                  Change
                                </button>
                              )}
                            </span>
                          )}
                        </Item>
                      </dl>
                      <div className="mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                        <Figure label="Sold, 7 days" value={fmtNum(v.sales.units7)} />
                        <Figure label="Sold, 30 days" value={fmtNum(v.sales.units30)} />
                        <Figure label="Days of stock left" value={v.daysOfStock === null ? "—" : fmtNum(v.daysOfStock)} sub={v.depletionDate ? `Runs out around ${fmtDay(v.depletionDate)}` : data.sales.salesDays < 14 ? "Not enough sales history" : undefined} />
                        <Figure label="Suggested reorder" value={v.restock === null ? "—" : fmtNum(v.restock)} sub={v.restock === null ? undefined : "To cover lead time and 30 days"} />
                      </div>
                      {v.tracked && levelsKnown ? (
                        v.levels.length ? (
                          <div className="mt-3">
                            <Table label={`Stock of ${v.title} by location`}>
                              <thead>
                                <tr>
                                  <Th>Location</Th>
                                  <Th right>{QUANTITY_INFO.available.label}</Th>
                                  <Th right>{QUANTITY_INFO.on_hand.label}</Th>
                                  <Th right>{QUANTITY_INFO.committed.label}</Th>
                                  <Th right>{QUANTITY_INFO.incoming.label}</Th>
                                  <Th right>Unavailable</Th>
                                  <Th>Updated in Shopify</Th>
                                </tr>
                              </thead>
                              <tbody>
                                {v.levels.map((l) => (
                                  <tr key={l.locationId}>
                                    <Td>
                                      {l.locationName}
                                      {!l.locationActive && <span className="ml-1 text-xs text-muted">(inactive)</span>}
                                    </Td>
                                    <Td right>
                                      <Qty value={l.available} strong />
                                    </Td>
                                    <Td right>
                                      <Qty value={l.onHand} />
                                    </Td>
                                    <Td right>
                                      <Qty value={l.committed} />
                                    </Td>
                                    <Td right>
                                      <Qty value={l.incoming} />
                                    </Td>
                                    <Td right>
                                      <span title={`Reserved ${l.reserved} · Damaged ${l.damaged} · Safety stock ${l.safetyStock} · Quality control ${l.qualityControl}`}>
                                        <Qty value={l.reserved + l.damaged + l.safetyStock + l.qualityControl} />
                                      </span>
                                    </Td>
                                    <Td className="text-xs text-muted">{new Date(l.updatedAt).toLocaleString()}</Td>
                                  </tr>
                                ))}
                              </tbody>
                            </Table>
                          </div>
                        ) : (
                          <p className="mt-3 text-sm text-muted">Not stocked at any location in Shopify.</p>
                        )
                      ) : null}
                    </div>
                  ))}
                </div>
              </Section>

              <Section title="Sales, last 30 days">
                <div className="grid grid-cols-3 gap-2 text-sm">
                  <Figure label="Units, 7 days" value={fmtNum(data.sales.units7)} />
                  <Figure label="Units, 30 days" value={fmtNum(data.sales.units30)} />
                  <Figure label="Units, 90 days" value={fmtNum(data.sales.units90)} />
                </div>
                <div className="mt-3">
                  <ColumnChart
                    values={data.sales.days.map((d) => d.units)}
                    labels={data.sales.days.map((d) => fmtDay(d.day))}
                    highlight={data.sales.days.length - 1}
                    format={(n) => `${fmtNum(n)} units`}
                    label={`Units of ${p.title} sold per day over the last 30 days`}
                    height="h-28"
                  />
                </div>
                <p className="mt-2 text-xs text-muted">Items sold less items returned, from the Shopify sales records bizinsights has imported ({fmtNum(data.sales.salesDays)} of the last 30 days covered).</p>
              </Section>

              {data.history && (
                <Section title="Stock history">
                  {data.history.rows.length ? (
                    <MovementList rows={data.history.rows} compact heading="h4" />
                  ) : (
                    <p className="text-sm text-muted">No stock changes recorded yet. Changes appear here from when bizinsights started following this store&apos;s stock.</p>
                  )}
                </Section>
              )}
            </>
          )}
        </div>
      </div>
      {adjust && (
        <AdjustDialog
          base={base}
          target={adjust}
          onClose={() => setAdjust(null)}
          onDone={(a) => {
            setAdjust(null);
            toast("success", confirmedMessage(a));
            void reload();
          }}
        />
      )}
    </div>
  );
}

const weightUnit = (u: string | null) => ({ GRAMS: "g", KILOGRAMS: "kg", OUNCES: "oz", POUNDS: "lb" })[u ?? ""] ?? (u ?? "").toLowerCase();

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="truncate">{children}</dd>
    </div>
  );
}

function Figure({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-bg p-2.5">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-0.5 truncate font-semibold tabular-nums">{value}</p>
      {sub && <p className="mt-0.5 truncate text-[11px] text-muted">{sub}</p>}
    </div>
  );
}

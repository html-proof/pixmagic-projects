"use client";
import { useEffect, useState } from "react";
import { Info, X } from "lucide-react";
import { PageHeader } from "@/components/AppUi";
import { LoadError } from "@/components/LoadError";
import { EmptyState } from "@/components/ui";
import { Badge } from "@/components/dashboard/Primitives";
import { NoPermission, StockStatus, useInventory, variantLabel } from "@/components/inventory/InventoryUi";
import { MovementList } from "@/components/inventory/MovementList";
import { KIT_ROW, KitHead, KitTable, KitTd, KitTh, SettingsLink } from "@/components/inventory/StockKit";
import { Pagination, Tabs } from "@/components/staff/ui";
import { fmtNum, useApi } from "@/lib/api";
import type { AdjustmentRow, Facets, MovementPage } from "@/lib/inventory";
import { ADJUSTMENT_INFO, ADJUSTMENT_REASON_LABEL, QUANTITY_INFO, type AdjustmentKind, type QuantityName } from "@app/shared/inventory";

const ADJUSTMENT_STATUS: Record<AdjustmentRow["status"], { label: string; tone: "good" | "warn" | "danger" | "neutral" }> = {
  confirmed: { label: "Confirmed by Shopify", tone: "good" },
  failed: { label: "Refused, nothing changed", tone: "danger" },
  unknown: { label: "Not confirmed", tone: "warn" },
  pending: { label: "Sending…", tone: "neutral" },
};

const ERROR_LABEL: Record<string, string> = {
  stock_changed: "Stock changed in Shopify first",
  not_stocked: "Not stocked at that location",
  untracked: "Stock not tracked",
  invalid_quantity: "Quantity refused",
  shopify_refused: "Refused by Shopify",
  unconfirmed: "No answer from Shopify",
  in_progress: "Still being made",
  store_disconnected: "Store disconnected",
  scope_missing: "No permission in Shopify",
};

const FILTER = "home-card flex max-w-full min-w-0 items-center gap-2 pl-3 text-sm";
const FILTER_INPUT = "input h-9 w-auto max-w-full min-w-0 border-transparent bg-transparent py-1 pl-1 font-medium shadow-none";

/**
 * The stock history as the Stitch design's "History" (screen 23): where each change came from,
 * every stock change bizinsights saw in Shopify and the changes asked for here, grouped by day.
 */
export default function MovementsPage() {
  const { base, status } = useInventory();
  const [tab, setTab] = useState<"all" | "made">("all");
  const [source, setSource] = useState<"" | "observed" | "bizinsights">("");
  const [location, setLocation] = useState("");
  const [variant, setVariant] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  // ?variant= from the stock list's "History".
  useEffect(() => setVariant(new URL(window.location.href).searchParams.get("variant")), []);
  const facets = useApi<Facets>(status?.can.history ? `${base}/stock/facets` : null);
  const qs = new URLSearchParams({ page: String(page), pageSize: "50", ...(source ? { source } : {}), ...(location ? { location } : {}), ...(variant ? { variant } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}) }).toString();
  const moves = useApi<MovementPage>(status?.can.history && tab === "all" ? `${base}/movements?${qs}` : null);
  const made = useApi<{ rows: AdjustmentRow[]; total: number; page: number; pageSize: number }>(status?.can.history && tab === "made" ? `${base}/adjustments?page=${page}&pageSize=50` : null);
  if (status && !status.can.history) return <NoPermission what="the stock history" />;

  return (
    <>
      <PageHeader
        title="Inventory movements"
        sub="Where each change came from: every stock change bizinsights has seen in Shopify, and every change made here with who made it."
        actions={
          status && (
            <>
              <StockStatus />
              <SettingsLink />
            </>
          )
        }
      />
      <Tabs
        tabs={[
          ["all", "All changes"],
          ["made", "Changes made in bizinsights"],
        ]}
        value={tab}
        onChange={(t) => {
          setTab(t);
          setPage(1);
        }}
        label="History"
      />
      {tab === "all" && (
        <div className="flex flex-wrap items-center gap-2" data-testid="movement-filters">
          <label className={FILTER}>
            <span className="text-muted">Source:</span>
            <select className={FILTER_INPUT} aria-label="Source" value={source} onChange={(e) => (setSource(e.target.value as typeof source), setPage(1))}>
              <option value="">All sources</option>
              <option value="observed">Seen changing in Shopify</option>
              <option value="bizinsights">Made in bizinsights</option>
            </select>
          </label>
          <label className={FILTER}>
            <span className="text-muted">Location:</span>
            <select className={FILTER_INPUT} aria-label="Location" value={location} onChange={(e) => (setLocation(e.target.value), setPage(1))}>
              <option value="">All locations</option>
              {facets.data?.locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
          <span className="flex flex-wrap items-center gap-2 sm:ml-auto">
            <label className={FILTER}>
              <span className="text-muted">From</span>
              <input type="date" className={FILTER_INPUT} aria-label="From" value={from} onChange={(e) => (setFrom(e.target.value), setPage(1))} />
            </label>
            <label className={FILTER}>
              <span className="text-muted">To</span>
              <input type="date" className={FILTER_INPUT} aria-label="To" value={to} onChange={(e) => (setTo(e.target.value), setPage(1))} />
            </label>
          </span>
          {variant && (
            <button type="button" className="inline-flex h-9 items-center gap-1 rounded-full bg-home-tag px-3 text-xs font-medium" onClick={() => (setVariant(null), setPage(1))}>
              One item only
              <X aria-hidden className="h-3 w-3" />
              <span className="sr-only">(show every item)</span>
            </button>
          )}
        </div>
      )}
      {tab === "all" ? (
        moves.error && !moves.data ? (
          <LoadError what="the stock history" error={moves.error} onRetry={moves.reload} busy={moves.loading} />
        ) : !moves.data ? (
          <div className="space-y-2" aria-busy="true">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="skeleton h-12 rounded-lg" />
            ))}
          </div>
        ) : moves.data.total === 0 ? (
          <EmptyState title="No stock changes yet" body="Changes appear here as bizinsights sees them in Shopify (webhooks and the scheduled check) and when stock is changed here." />
        ) : (
          <div className={moves.loading ? "opacity-70" : ""} aria-busy={moves.loading}>
            <MovementList rows={moves.data.rows} />
            <Pagination page={moves.data.page} pageSize={moves.data.pageSize} total={moves.data.total} onPage={setPage} />
          </div>
        )
      ) : made.error && !made.data ? (
        <LoadError what="the changes made here" error={made.error} onRetry={made.reload} busy={made.loading} />
      ) : !made.data ? (
        <div className="skeleton h-24 rounded-lg" />
      ) : made.data.total === 0 ? (
        <EmptyState title="No changes made in bizinsights yet" body="Stock changes made from a product's panel are recorded here, with Shopify's answer to each." />
      ) : (
        <section aria-label="Changes made in bizinsights" className="home-card animate-rise min-w-0 overflow-hidden">
          <KitTable label="Changes made in bizinsights" minWidth="56rem">
            <KitHead>
              <tr>
                <KitTh>When</KitTh>
                <KitTh>Item</KitTh>
                <KitTh>Location</KitTh>
                <KitTh>Change</KitTh>
                <KitTh right>Asked</KitTh>
                <KitTh right>Result</KitTh>
                <KitTh>Outcome</KitTh>
                <KitTh>By</KitTh>
              </tr>
            </KitHead>
            <tbody>
              {made.data.rows.map((a) => (
                <tr key={a.id} className={KIT_ROW}>
                  <KitTd className="text-xs whitespace-nowrap">{new Date(a.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</KitTd>
                  <KitTd>
                    <span className="font-medium">{variantLabel(a.productTitle ?? "Deleted product", a.variantTitle ?? "")}</span>
                    {a.sku && <span className="block text-xs text-muted">SKU {a.sku}</span>}
                  </KitTd>
                  <KitTd>{a.locationName ?? a.locationId}</KitTd>
                  <KitTd>
                    {ADJUSTMENT_INFO[a.kind as AdjustmentKind]?.label ?? a.kind}
                    <span className="block text-xs text-muted">
                      {ADJUSTMENT_REASON_LABEL[a.reason] ?? a.reason}
                      {a.referenceId ? ` · Ref ${a.referenceId}` : ""}
                      {a.note ? ` · ${a.note}` : ""}
                    </span>
                  </KitTd>
                  <KitTd right>{a.delta !== null ? `${a.delta > 0 ? "+" : ""}${fmtNum(a.delta)}` : `= ${fmtNum(a.quantity)}`}</KitTd>
                  <KitTd right>{a.resultQuantity === null ? "—" : `${fmtNum(a.resultQuantity)} ${QUANTITY_INFO[a.quantityName as QuantityName]?.label.toLowerCase() ?? ""}`}</KitTd>
                  <KitTd>
                    <Badge tone={ADJUSTMENT_STATUS[a.status].tone}>{ADJUSTMENT_STATUS[a.status].label}</Badge>
                    {a.errorCode && <span className="mt-0.5 block text-xs text-muted">{ERROR_LABEL[a.errorCode] ?? a.errorCode}</span>}
                  </KitTd>
                  <KitTd className="text-xs">{a.by ?? "—"}</KitTd>
                </tr>
              ))}
            </tbody>
          </KitTable>
          <div className="px-4 pb-4 sm:px-5">
            <Pagination page={made.data.page} pageSize={made.data.pageSize} total={made.data.total} onPage={setPage} />
          </div>
        </section>
      )}
      <p className="flex items-start gap-1.5 text-xs text-muted">
        <Info aria-hidden className="mt-px h-3.5 w-3.5 shrink-0" />
        Shopify doesn&apos;t share its own adjustment history, so changes before bizinsights started following the stock aren&apos;t here.
      </p>
    </>
  );
}

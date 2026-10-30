"use client";
import { useEffect, useState } from "react";
import { PageHeader } from "@/components/AppUi";
import { LoadError } from "@/components/LoadError";
import { EmptyState } from "@/components/ui";
import { Badge } from "@/components/dashboard/Primitives";
import { NoPermission, useInventory, variantLabel } from "@/components/inventory/InventoryUi";
import { MovementTable } from "@/components/inventory/MovementTable";
import { Pagination, Table, Tabs, Td, Th } from "@/components/staff/ui";
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

/** The stock history: every change bizinsights saw in Shopify, and the changes asked for here. */
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
        title="Stock movements"
        sub="Every stock change bizinsights has seen in Shopify, and every change made here with who made it. Shopify doesn't share its own adjustment history, so changes before bizinsights started following the stock aren't here."
      />
      <div className="card space-y-3">
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
          <div className="flex flex-wrap items-center gap-2">
            <select className="input w-auto" aria-label="Source" value={source} onChange={(e) => (setSource(e.target.value as typeof source), setPage(1))}>
              <option value="">Every source</option>
              <option value="observed">Seen changing in Shopify</option>
              <option value="bizinsights">Made in bizinsights</option>
            </select>
            <select className="input w-auto" aria-label="Location" value={location} onChange={(e) => (setLocation(e.target.value), setPage(1))}>
              <option value="">All locations</option>
              {facets.data?.locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
            <input type="date" className="input w-auto" aria-label="From" value={from} onChange={(e) => (setFrom(e.target.value), setPage(1))} />
            <input type="date" className="input w-auto" aria-label="To" value={to} onChange={(e) => (setTo(e.target.value), setPage(1))} />
            {variant && (
              <button type="button" className="rounded-full border border-border bg-bg px-2.5 py-1 text-xs" onClick={() => (setVariant(null), setPage(1))}>
                One item only ×
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
                <div key={i} className="skeleton h-8" />
              ))}
            </div>
          ) : moves.data.total === 0 ? (
            <EmptyState title="No stock changes yet" body="Changes appear here as bizinsights sees them in Shopify (webhooks and the scheduled check) and when stock is changed here." />
          ) : (
            <>
              <MovementTable rows={moves.data.rows} />
              <Pagination page={moves.data.page} pageSize={moves.data.pageSize} total={moves.data.total} onPage={setPage} />
            </>
          )
        ) : made.error && !made.data ? (
          <LoadError what="the changes made here" error={made.error} onRetry={made.reload} busy={made.loading} />
        ) : !made.data ? (
          <div className="skeleton h-24" />
        ) : made.data.total === 0 ? (
          <EmptyState title="No changes made in bizinsights yet" body="Stock changes made from a product's panel are recorded here, with Shopify's answer to each." />
        ) : (
          <>
            <Table label="Changes made in bizinsights">
              <thead>
                <tr>
                  <Th>When</Th>
                  <Th>Item</Th>
                  <Th>Location</Th>
                  <Th>Change</Th>
                  <Th right>Asked</Th>
                  <Th right>Result</Th>
                  <Th>Outcome</Th>
                  <Th>By</Th>
                </tr>
              </thead>
              <tbody>
                {made.data.rows.map((a) => (
                  <tr key={a.id}>
                    <Td className="whitespace-nowrap text-xs">{new Date(a.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</Td>
                    <Td>
                      {variantLabel(a.productTitle ?? "Deleted product", a.variantTitle ?? "")}
                      {a.sku && <span className="block text-xs text-muted">SKU {a.sku}</span>}
                    </Td>
                    <Td>{a.locationName ?? a.locationId}</Td>
                    <Td>
                      {ADJUSTMENT_INFO[a.kind as AdjustmentKind]?.label ?? a.kind}
                      <span className="block text-xs text-muted">
                        {ADJUSTMENT_REASON_LABEL[a.reason] ?? a.reason}
                        {a.referenceId ? ` · Ref ${a.referenceId}` : ""}
                        {a.note ? ` · ${a.note}` : ""}
                      </span>
                    </Td>
                    <Td right>{a.delta !== null ? `${a.delta > 0 ? "+" : ""}${fmtNum(a.delta)}` : `= ${fmtNum(a.quantity)}`}</Td>
                    <Td right>{a.resultQuantity === null ? "—" : `${fmtNum(a.resultQuantity)} ${QUANTITY_INFO[a.quantityName as QuantityName]?.label.toLowerCase() ?? ""}`}</Td>
                    <Td>
                      <Badge tone={ADJUSTMENT_STATUS[a.status].tone}>{ADJUSTMENT_STATUS[a.status].label}</Badge>
                      {a.errorCode && <span className="mt-0.5 block text-xs text-muted">{ERROR_LABEL[a.errorCode] ?? a.errorCode}</span>}
                    </Td>
                    <Td className="text-xs">{a.by ?? "—"}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pagination page={made.data.page} pageSize={made.data.pageSize} total={made.data.total} onPage={setPage} />
          </>
        )}
      </div>
    </>
  );
}

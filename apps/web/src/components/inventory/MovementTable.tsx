"use client";
import { Table, Td, Th } from "@/components/staff/ui";
import { Badge } from "@/components/dashboard/Primitives";
import { fmtNum } from "@/lib/api";
import { openProduct, type MovementRow } from "@/lib/inventory";
import { ADJUSTMENT_INFO, ADJUSTMENT_REASON_LABEL, QUANTITY_INFO, type AdjustmentKind, type QuantityName } from "@app/shared/inventory";
import { variantLabel } from "./InventoryUi";

/** How each change was seen: made here and confirmed by Shopify, or seen changed in Shopify. */
const SOURCE: Record<MovementRow["source"], string> = {
  adjustment: "Made in bizinsights",
  webhook: "Seen in Shopify",
  sync: "Found on refresh",
  reconcile: "Found by the check",
};

export function MovementTable({ rows, compact = false }: { rows: MovementRow[]; compact?: boolean }) {
  return (
    <Table label="Stock history">
      <thead>
        <tr>
          <Th>When</Th>
          {!compact && <Th>Item</Th>}
          <Th>Location</Th>
          <Th>Quantity</Th>
          <Th right>Before</Th>
          <Th right>After</Th>
          <Th right>Change</Th>
          <Th>Source</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((m) => (
          <tr key={m.id}>
            <Td className="whitespace-nowrap text-xs">{new Date(m.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</Td>
            {!compact && (
              <Td>
                {m.productId ? (
                  <button type="button" className="text-left hover:underline" onClick={() => openProduct(m.productId)}>
                    {variantLabel(m.productTitle ?? "Deleted product", m.variantTitle ?? "")}
                  </button>
                ) : (
                  variantLabel(m.productTitle ?? "Deleted product", m.variantTitle ?? "")
                )}
                {m.sku && <span className="block text-xs text-muted">SKU {m.sku}</span>}
              </Td>
            )}
            <Td>{m.locationName ?? m.locationId}</Td>
            <Td>{QUANTITY_INFO[m.quantityName as QuantityName]?.label ?? m.quantityName}</Td>
            <Td right>{m.before === null ? "—" : fmtNum(m.before)}</Td>
            <Td right>{fmtNum(m.after)}</Td>
            <Td right>
              <span className={m.delta > 0 ? "text-good" : m.delta < 0 ? "text-danger" : ""}>
                {m.delta > 0 ? "+" : ""}
                {fmtNum(m.delta)}
              </span>
            </Td>
            <Td>
              <Badge tone={m.kind === "confirmed" ? "good" : "neutral"}>{SOURCE[m.source]}</Badge>
              {m.adjustment && (
                <span className="mt-1 block text-xs text-muted">
                  {ADJUSTMENT_INFO[m.adjustment.kind as AdjustmentKind]?.label ?? m.adjustment.kind} · {ADJUSTMENT_REASON_LABEL[m.adjustment.reason] ?? m.adjustment.reason}
                  {m.adjustment.by ? ` · ${m.adjustment.by}` : ""}
                  {m.adjustment.referenceId ? ` · Ref ${m.adjustment.referenceId}` : ""}
                  {m.adjustment.note ? ` · ${m.adjustment.note}` : ""}
                </span>
              )}
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

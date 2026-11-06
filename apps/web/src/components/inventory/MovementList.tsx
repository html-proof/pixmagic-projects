"use client";
import { ArrowRight, Package } from "lucide-react";
import { fmtLongDay } from "@/components/dashboard/format";
import { fmtNum } from "@/lib/api";
import { openProduct, type MovementRow } from "@/lib/inventory";
import { ADJUSTMENT_INFO, ADJUSTMENT_REASON_LABEL, QUANTITY_INFO, type AdjustmentKind, type QuantityName } from "@app/shared/inventory";
import { useInventory, variantLabel } from "./InventoryUi";

/** How each change was seen: made here and confirmed by Shopify, or seen changed in Shopify. */
const SOURCE: Record<MovementRow["source"], string> = {
  adjustment: "Made in bizinsights",
  webhook: "Seen in Shopify",
  sync: "Found on refresh",
  reconcile: "Found by the check",
};

/** The store-local day (YYYY-MM-DD) and time of a moment; the browser's when the zone is unknown. */
function localParts(iso: string, timeZone: string): { day: string; time: string } {
  const d = new Date(iso);
  try {
    return {
      day: new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d),
      time: new Intl.DateTimeFormat(undefined, { timeZone, hour: "numeric", minute: "2-digit" }).format(d),
    };
  } catch {
    return { day: d.toISOString().slice(0, 10), time: d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) };
  }
}

/**
 * The stock history as the design's screen 23 draws it: the changes grouped by the store's day,
 * each with the item and location, before → after, the change, and where it came from (seen in
 * Shopify, found by the check, or made here, with its reason and who made it). `compact` leaves
 * the item out (the product panel, about one product); `heading` keeps the page's headings in order.
 */
export function MovementList({ rows, compact = false, heading = "h2" }: { rows: MovementRow[]; compact?: boolean; heading?: "h2" | "h4" }) {
  const { status } = useInventory();
  const timeZone = status?.store.timezone ?? "UTC";
  const days: Array<{ day: string; items: Array<{ m: MovementRow; time: string }> }> = [];
  for (const m of rows) {
    const { day, time } = localParts(m.at, timeZone);
    const last = days[days.length - 1];
    if (last && last.day === day) last.items.push({ m, time });
    else days.push({ day, items: [{ m, time }] });
  }
  const H = heading;
  // The product panel can open over the movements page: its day headings need ids of their own.
  const idBase = compact ? "panel-moves" : "moves";
  return (
    <div className="space-y-5" data-testid="movement-list">
      {days.map((g) => (
        <section key={g.day} aria-labelledby={`${idBase}-${g.day}`}>
          <H id={`${idBase}-${g.day}`} className="mb-2 px-1 text-[11px] font-semibold tracking-wider text-muted uppercase">
            {fmtLongDay(g.day)}
          </H>
          <ul className="home-card divide-y divide-home-line overflow-hidden">
            {g.items.map(({ m, time }) => (
              <Movement key={m.id} m={m} time={time} compact={compact} />
            ))}
          </ul>
        </section>
      ))}
      <p className="text-xs text-muted">Times in the store&apos;s time zone ({timeZone}).</p>
    </div>
  );
}

function Movement({ m, time, compact }: { m: MovementRow; time: string; compact: boolean }) {
  const item = variantLabel(m.productTitle ?? "Deleted product", m.variantTitle ?? "");
  const a = m.adjustment;
  const said = a ? [ADJUSTMENT_REASON_LABEL[a.reason] ?? a.reason, a.by].filter(Boolean).join(" · ") : SOURCE[m.source];
  const more = [time, a ? `${SOURCE.adjustment}: ${ADJUSTMENT_INFO[a.kind as AdjustmentKind]?.label ?? a.kind}` : null, m.kind === "confirmed" ? "confirmed by Shopify" : null, a?.referenceId ? `Ref ${a.referenceId}` : null, a?.note].filter(Boolean).join(" · ");
  const quantity = QUANTITY_INFO[m.quantityName as QuantityName]?.label ?? m.quantityName;
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-3 transition-colors hover:bg-home-soft/60 sm:flex-nowrap sm:px-5">
      <span aria-hidden className="hidden h-9 w-9 shrink-0 place-items-center rounded bg-home-soft text-muted sm:grid">
        <Package className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1 basis-full sm:basis-auto">
        {!compact &&
          (m.productId ? (
            <button type="button" className="block max-w-full truncate text-left text-sm font-medium hover:underline" onClick={() => openProduct(m.productId)}>
              {item}
            </button>
          ) : (
            <p className="truncate text-sm font-medium">{item}</p>
          ))}
        <p className={`truncate text-xs text-muted ${compact ? "text-sm text-text" : ""}`}>
          {m.locationName ?? m.locationId} · {quantity}
          {!compact && m.sku ? ` · SKU ${m.sku}` : ""}
        </p>
      </div>
      <p className="flex shrink-0 items-center gap-1.5 text-sm whitespace-nowrap text-muted tabular-nums">
        Before: <span className="text-text">{m.before === null ? "—" : fmtNum(m.before)}</span>
        <ArrowRight aria-hidden className="h-3.5 w-3.5" />
        <span className="sr-only">to</span>
        After: <span className="font-medium text-text">{fmtNum(m.after)}</span>
      </p>
      <p className={`w-12 shrink-0 text-right text-sm font-semibold tabular-nums ${m.delta > 0 ? "text-good" : m.delta < 0 ? "text-danger" : "text-muted"}`}>
        {m.delta > 0 ? "+" : m.delta < 0 ? "−" : ""}
        {fmtNum(Math.abs(m.delta))}
      </p>
      <div className="min-w-0 basis-full text-xs sm:w-60 sm:shrink-0 sm:basis-auto sm:text-right">
        <p className="text-sm">{said}</p>
        <p className="text-muted">{more}</p>
      </div>
    </li>
  );
}

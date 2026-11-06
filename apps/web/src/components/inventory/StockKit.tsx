"use client";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { Download, Settings } from "lucide-react";
import { useToast } from "@/components/AppUi";
import { fmtDay } from "@/components/dashboard/format";
import { actionError, api, fmtNum, fmtPct } from "@/lib/api";
import type { AdjustmentRow, InventorySettingsView, ProductDetail, StockRow } from "@/lib/inventory";
import { AdjustDialog, confirmedMessage, type AdjustTarget } from "./AdjustDialog";
import { useCanAdjust, useInventory, variantLabel } from "./InventoryUi";

// ---------------------------------------------------------------------------
// The Stock pages' own pieces, as the owner's approved Stitch design draws them (prototype v2,
// screens 21–24): the table's look (a soft header row, hairlines between rows), the chips that move
// between what needs attention, the days-left tag, "Add stock" and the line saying how the
// suggested order is worked out. The cards, tiles and headings are components/PageKit.tsx's.
// ---------------------------------------------------------------------------

/** A header cell's type, as the Sales pages' tables have it (components/dashboard/SalesViews.tsx). */
const TH = "px-3 py-2.5 text-[11px] font-semibold tracking-wider whitespace-nowrap text-muted uppercase";

/** A table that scrolls sideways inside its card on a narrow screen. */
export function KitTable({ label, minWidth = "44rem", children }: { label: string; minWidth?: string; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" style={{ minWidth }} aria-label={label}>
        {children}
      </table>
    </div>
  );
}

export const KitHead = ({ children }: { children: ReactNode }) => <thead className="bg-home-soft text-left">{children}</thead>;

export function KitTh({ children, right = false, className = "", sort }: { children?: ReactNode; right?: boolean; className?: string; sort?: "ascending" | "descending" }) {
  return (
    <th scope="col" aria-sort={sort} className={`${TH} ${right ? "text-right" : "text-left"} ${className}`}>
      {children}
    </th>
  );
}

export const KitTd = ({ children, right = false, className = "" }: { children?: ReactNode; right?: boolean; className?: string }) => (
  <td className={`px-3 py-3 align-middle ${right ? "text-right tabular-nums" : ""} ${className}`}>{children}</td>
);

/** A row of a kit table: a hairline under every row but the last. */
export const KIT_ROW = "border-b border-home-line last:border-0";

/** A short note on a soft ground, for "nothing here yet" inside a card. */
export const SoftNote = ({ children }: { children: ReactNode }) => <p className="rounded bg-home-soft px-4 py-3 text-sm text-muted">{children}</p>;

/** A small figure on a soft ground (the design's boxes inside a card, as the Shipping card has them). */
export function SoftStat({ label, value, sub }: { label: ReactNode; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="min-w-0 rounded bg-home-soft p-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 truncate text-lg leading-6 font-semibold tabular-nums">{value}</p>
      {sub && <p className="mt-0.5 text-[11px] text-muted">{sub}</p>}
    </div>
  );
}

// ---- The header's actions -----------------------------------------------------------------------

/** The design's gear: Stock settings, one of the section's own pages. */
export function SettingsLink() {
  return (
    <Link href="/inventory/settings" className="home-btn h-10 border border-home-line bg-surface">
      <Settings aria-hidden className="h-4 w-4" />
      <span className="hidden sm:inline">Stock settings</span>
      <span className="sr-only sm:hidden">Stock settings</span>
    </Link>
  );
}

/** Download as a CSV (for a member allowed to export), as the Sales pages' Download is drawn. */
export function DownloadLink({ href, what, testId }: { href: string; what: string; testId: string }) {
  return (
    <a href={href} download className="home-btn h-9 border border-home-line bg-surface" data-testid={testId}>
      <Download aria-hidden className="h-4 w-4" />
      Download
      <span className="sr-only"> {what} as a CSV file</span>
    </a>
  );
}

// ---- What needs attention -----------------------------------------------------------------------

export type AttentionView = "all" | "out" | "low";

const CHIP = "inline-flex h-9 items-center gap-2 rounded px-3 text-[13px] font-medium whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent";
export const chipClass = (on: boolean) => `${CHIP} ${on ? "bg-home-tag text-text" : "bg-home-soft text-muted hover:bg-home-soft-hover hover:text-text"}`;

/**
 * Needs attention · Out of stock · Low stock, as the design's screen 21 puts them over its table:
 * each is the section's page for it, so the chips move between the three. The counts are the
 * store's, every location together; while they load, none is shown rather than a zero.
 */
export function AttentionChips({ active, out, low }: { active: AttentionView; out: number | null; low: number | null }) {
  const all = out === null || low === null ? null : out + low;
  const chips: Array<{ id: AttentionView; href: string; label: string; count: number | null; dot?: string }> = [
    { id: "all", href: "/inventory", label: "Needs attention", count: all },
    { id: "out", href: "/inventory/out-of-stock", label: "Out of stock", count: out, dot: "bg-danger" },
    { id: "low", href: "/inventory/low-stock", label: "Low stock", count: low, dot: "bg-warn" },
  ];
  return (
    <nav aria-label="Stock that needs attention" className="-mx-1 overflow-x-auto px-1" data-testid="attention-chips">
      <ul className="flex min-w-max items-center gap-2">
        {chips.map((c) => (
          <li key={c.id}>
            <Link href={c.href} aria-current={c.id === active ? "page" : undefined} className={chipClass(c.id === active)} data-testid={`attention-${c.id}`}>
              {c.dot && <span aria-hidden className={`h-2 w-2 rounded-full ${c.dot}`} />}
              {c.label}
              {c.count !== null &&
                (c.id === "all" ? (
                  <span className={`rounded-full px-1.5 py-0.5 text-[11px] leading-none font-semibold tabular-nums ${c.count > 0 ? "bg-danger text-white" : "bg-surface text-muted"}`}>{fmtNum(c.count)}</span>
                ) : (
                  <span className="tabular-nums">{fmtNum(c.count)}</span>
                ))}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

const TAG = "inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium whitespace-nowrap";

/** Why a row has no days left: too few days of orders, or nothing sold (`daysOfStock` is null either way). */
const noForecast = (r: Pick<StockRow, "dailyRate">) => (r.dailyRate === null ? "Not enough sales history" : "No sales in 30 days");

/** Days left as the design's tag: "Out now" in red, "5 days" on a soft tag, or why it can't be said. */
export function DaysLeftTag({ r }: { r: StockRow }) {
  if (r.status === "out") {
    return (
      <span className={`${TAG} bg-danger/10 text-danger`}>
        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-danger" />
        Out now
      </span>
    );
  }
  if (r.daysOfStock === null) return <span className="text-xs text-muted">{noForecast(r)}</span>;
  return (
    <span className={`${TAG} bg-home-tag text-text`} title={r.depletionDate ? `Around ${fmtDay(r.depletionDate)}` : undefined}>
      {r.daysOfStock === 0 ? "Under a day" : `${fmtNum(r.daysOfStock)} ${r.daysOfStock === 1 ? "day" : "days"}`}
    </span>
  );
}

/** The phone's "9 left · runs out in 3 days" line (screen 24). */
export function LeftLine({ r }: { r: StockRow }) {
  const a = r.available;
  const tone = r.status === "out" ? "bg-danger/10 text-danger" : r.status === "low" ? "bg-warn/10 text-warn" : "bg-home-tag text-text";
  return (
    <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <span className={`${TAG} ${tone}`}>{a === null ? "—" : a < 0 ? `${fmtNum(-a)} oversold` : `${fmtNum(a)} left`}</span>
      {r.status === "out" ? (
        <span className="font-medium text-danger">out now</span>
      ) : r.daysOfStock !== null ? (
        <span className={r.status === "low" ? "font-medium text-warn" : "text-muted"}>{r.daysOfStock === 0 ? "runs out within a day" : `runs out in ${fmtNum(r.daysOfStock)} ${r.daysOfStock === 1 ? "day" : "days"}`}</span>
      ) : (
        <span className="text-muted">{noForecast(r).toLowerCase()}</span>
      )}
    </p>
  );
}

/**
 * Under the table: how the suggested order is worked out, with the store's own lead time and days
 * to keep (Stock settings), and that bizinsights doesn't order from suppliers.
 */
export function SuggestedOrderNote({ settings, salesDays, canAdjust }: { settings: InventorySettingsView | null; salesDays: number | null; canAdjust: boolean }) {
  return (
    <div className="space-y-1 bg-home-soft px-5 py-3 text-xs text-muted sm:px-6" data-testid="suggested-order-note">
      <p>
        Suggested order = sold per day ×{" "}
        {settings ? (
          <>
            ({plural(settings.leadTimeDays, "day")} lead time + {plural(settings.coverDays, "day")} to keep)
          </>
        ) : (
          "(the lead time + the days to keep)"
        )}{" "}
        − available − incoming, from{" "}
        <Link href="/inventory/settings" className="underline hover:text-text">
          Stock settings
        </Link>
        . bizinsights doesn&apos;t order from suppliers: {canAdjust ? "add stock here when it arrives, and Shopify is updated." : "when stock arrives, add it in Shopify."}
      </p>
      {salesDays !== null && salesDays < 14 && <p>Sales rates need at least 14 days of imported orders; bizinsights has {fmtNum(salesDays)}.</p>}
    </div>
  );
}

const plural = (n: number, one: string) => `${fmtNum(n)} ${n === 1 ? one : `${one}s`}`;

/**
 * "Add stock" on a row: reads the item's stock at each location (the product's answer) and opens
 * the stock change dialog on Increase, at the location picked if there is one. Only for a member who
 * may change stock in a store that granted it (useCanAdjust), on a tracked item.
 */
export function AddStockButton({ row, locationId, onDone, quiet = false }: { row: StockRow; locationId?: string | null; onDone: () => void; quiet?: boolean }) {
  const { base } = useInventory();
  const canAdjust = useCanAdjust();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState<AdjustTarget | null>(null);
  if (!canAdjust || !row.tracked) return null;
  const open = async () => {
    setBusy(true);
    try {
      const d = await api<ProductDetail>(`${base}/products/${row.productId}`);
      const v = d.variants.find((x) => x.id === row.variantId);
      if (!v) toast("error", "This item isn't in the product any more. Refresh the page.");
      else setTarget({ variantId: v.id, label: variantLabel(d.product.title, v.title), sku: v.sku, levels: v.levels, locationId: locationId ?? undefined });
    } catch (e) {
      toast("error", actionError(e, "open this item's stock"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button type="button" className={quiet ? "home-btn h-8 border border-home-line bg-surface disabled:opacity-50" : "btn-primary px-3 py-1.5 text-xs"} onClick={open} disabled={busy} data-testid={`add-stock-${quiet ? "card-" : ""}${row.variantId}`}>
        {busy ? "Opening…" : "Add stock"}
      </button>
      {target && (
        <AdjustDialog
          base={base}
          target={target}
          onClose={() => setTarget(null)}
          onDone={(a: AdjustmentRow) => {
            setTarget(null);
            toast("success", confirmedMessage(a));
            onDone();
          }}
        />
      )}
    </>
  );
}

// ---- Figures ------------------------------------------------------------------------------------

/**
 * A figure's definition behind a "?" (its tooltip), for FigureTile's icon slot; the same words go
 * to screen readers in the tile's text (`sr-only`), since that slot is hidden from them.
 */
export function DefinedMark({ definition }: { definition: string }) {
  return (
    <span title={definition} className="grid h-4 w-4 cursor-help place-items-center rounded-full border border-muted/60 text-[10px] leading-none font-semibold normal-case">
      ?
    </span>
  );
}

/** A change with no good or bad direction, in ChangeTag's type but grey; words for screen readers. */
export function NeutralChange({ value, versus }: { value: number | null; versus: string }) {
  if (value === null) return <span className="text-xs text-muted">Nothing to compare with</span>;
  return (
    <span className="text-xs font-medium text-muted tabular-nums">
      <span className="sr-only">{value > 0 ? "up " : value < 0 ? "down " : "unchanged, "}</span>
      <span aria-hidden>{value > 0 ? "+" : value < 0 ? "−" : ""}</span>
      {fmtPct(Math.abs(value))}
      <span className="sr-only"> {versus}</span>
    </span>
  );
}

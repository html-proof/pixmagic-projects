"use client";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Info } from "lucide-react";
import { FUNNEL_DEVICE_LABEL, SITE_SECTION_LABEL, VISITOR_KIND_LABEL, type FunnelDevice, type VisitorKind } from "@app/shared/funnel";
import type { SiteSection } from "@app/shared/journey";

// ---------------------------------------------------------------------------
// Small pieces the Shopping Funnel page's sections share: an information tip, a section card with
// its plain-English explanation, the names of segments, and rates written as people say them.
// ---------------------------------------------------------------------------

/**
 * An "i" that explains a figure: opens on hover, on focus and on click (touch), closes on Escape or
 * a click elsewhere. The text is also the button's description, so screen readers hear it.
 */
export function InfoTip({ label, children, align = "right" }: { label: string; children: ReactNode; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <span ref={box} className="relative inline-flex" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)} data-print-hide>
      <button
        type="button"
        aria-label={label}
        aria-describedby={id}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className="grid size-6 place-items-center rounded-full text-muted transition hover:bg-bg hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <Info aria-hidden className="h-3.5 w-3.5" />
      </button>
      <span
        id={id}
        role="tooltip"
        className={`absolute top-7 z-30 w-72 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-surface p-3 text-left text-xs font-normal leading-relaxed text-text shadow-lg ${align === "right" ? "right-0" : "left-0"} ${open ? "block" : "hidden"}`}
      >
        {children}
      </span>
    </span>
  );
}

/** A section of the page: its title, what it shows in plain words, and an optional control on the right. */
export function FunnelSection({ id, title, sub, aside, children, className = "" }: { id: string; title: string; sub?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className={`card min-w-0 animate-rise scroll-mt-28 ${className}`} data-testid={`funnel-${id}`}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 max-w-3xl">
          <h2 id={`${id}-h`} className="text-base font-semibold">
            {title}
          </h2>
          {sub && <p className="mt-0.5 text-sm text-muted">{sub}</p>}
        </div>
        {aside && <div className="flex flex-wrap items-center gap-2" data-print-hide>{aside}</div>}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

let regionNames: Intl.DisplayNames | null | undefined;
/** "AU" → "Australia", in the reader's language (the code itself if the browser can't name it). */
export function countryName(code: string): string {
  if (regionNames === undefined) {
    try {
      regionNames = new Intl.DisplayNames(undefined, { type: "region" });
    } catch {
      regionNames = null;
    }
  }
  try {
    return regionNames?.of(code) ?? code;
  } catch {
    return code;
  }
}

export type SegmentDimension = "device" | "country" | "landing" | "visitor";

/** The words for a segment (funnelDetail's segment keys). */
export function segmentLabel(dimension: SegmentDimension, key: string): string {
  if (key === "not_recorded") return "Not recorded";
  if (dimension === "device") return FUNNEL_DEVICE_LABEL[key as FunnelDevice] ?? key;
  if (dimension === "landing") return SITE_SECTION_LABEL[key as SiteSection] ?? key;
  if (dimension === "visitor") return VISITOR_KIND_LABEL[key as VisitorKind] ?? key;
  if (key === "unknown") return "Country unknown";
  if (key === "other") return "Other countries";
  return countryName(key);
}

/** A segment the filter can narrow to (not "Not recorded", "Other countries" or an unknown country). */
export const filterable = (dimension: SegmentDimension, key: string) => key !== "not_recorded" && !(dimension === "country" && (key === "unknown" || key === "other"));

/** A rate's change in percentage points: "+3.1 pts", "−0.4 pts". */
export function fmtPts(change: number): string {
  const pts = Math.round(change * 1000) / 10;
  return `${pts > 0 ? "+" : pts < 0 ? "−" : "±"}${Math.abs(pts).toLocaleString(undefined, { maximumFractionDigits: 1 })} pts`;
}

/** A whole number with its noun: "1 visit", "1,204 visits". */
export function count(n: number, noun: string, plural = `${noun}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? noun : plural}`;
}

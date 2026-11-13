"use client";
import { useEffect, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { ChevronRight } from "lucide-react";
import { FOLD_DETAIL } from "@/lib/features";
import { detailKey, detailOpen, detailSummary, parseDetail, type DetailChoice } from "@/lib/moreDetail";
import { readLocal, writeLocal } from "@/lib/storage";

/**
 * A page's other panels, folded under one row that says what is inside (lib/moreDetail.ts). Closed
 * until someone opens it; the device then keeps it open. A printout has every panel either way.
 * With FOLD_DETAIL off the panels are simply drawn, under `heading` when the page had one.
 */
export function MoreDetail({
  id,
  label = "More detail",
  holds,
  heading,
  children,
}: {
  /** Names the fold in storage and in its test id (`more-detail-<id>`). */
  id: string;
  label?: string;
  /** The panels inside, by name, in the order they are drawn. */
  holds: readonly string[];
  /** Drawn above the panels only while folding is off. */
  heading?: ReactNode;
  children: ReactNode;
}) {
  const [choice, setChoice] = useState<DetailChoice | null>(null);
  const [printing, setPrinting] = useState(false);
  // After mounting, as the Home's layout is read (components/dashboard/SimpleHome.tsx).
  useEffect(() => {
    setChoice(parseDetail(readLocal(detailKey(id))));
  }, [id]);
  useEffect(() => {
    if (!FOLD_DETAIL) return;
    // The page must be laid out with the panels showing before the browser takes its print snapshot.
    const before = () => flushSync(() => setPrinting(true));
    const after = () => setPrinting(false);
    window.addEventListener("beforeprint", before);
    window.addEventListener("afterprint", after);
    return () => {
      window.removeEventListener("beforeprint", before);
      window.removeEventListener("afterprint", after);
    };
  }, []);

  if (!FOLD_DETAIL) {
    return (
      <>
        {heading}
        {children}
      </>
    );
  }
  const open = detailOpen(true, choice, printing);
  const inside = detailSummary(holds);
  return (
    <details
      className="group/more"
      open={open}
      onToggle={(e) => {
        const now = e.currentTarget.open;
        // Opened for a printout: not a choice to remember.
        if (printing || now === open) return;
        const next: DetailChoice = now ? "open" : "closed";
        writeLocal(detailKey(id), next);
        setChoice(next);
      }}
      data-testid={`more-detail-${id}`}
    >
      <summary className="home-card flex cursor-pointer list-none flex-wrap items-center gap-x-2.5 gap-y-1 px-4 py-3 outline-none select-none hover:bg-home-soft focus-visible:ring-2 focus-visible:ring-accent sm:px-5 print:hidden [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden className="h-4 w-4 shrink-0 text-muted transition-transform group-open/more:rotate-90" />
        <span className="text-sm font-semibold">{label}</span>
        {inside && <span className="min-w-0 text-xs text-muted">{inside}</span>}
      </summary>
      <div className="mt-6 space-y-6">{children}</div>
    </details>
  );
}

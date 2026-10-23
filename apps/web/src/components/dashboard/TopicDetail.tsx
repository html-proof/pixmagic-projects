"use client";
import dynamic from "next/dynamic";
import { useEffect, useRef, type ReactNode } from "react";
import { fmtRange } from "./format";
import { Icon, type IconName } from "./Icons";
import { topicInfo, type Topic } from "./topics";
import type { Overview } from "./types";

// ---------------------------------------------------------------------------
// The detail panel: full screen on a phone, a wide side panel on a computer. The frame (title,
// dates, print, close, keyboard focus) is part of the dashboard page and opens at once; what goes
// inside it, every topic's tables and charts (./Details.tsx), is loaded the first time a panel
// opens, so the page itself starts without it.
// ---------------------------------------------------------------------------

/** While a panel's contents load: the sentence card and two panels, as shapes. */
function ContentsLoading() {
  return (
    <div className="space-y-4">
      <p className="sr-only" role="status">Loading the details…</p>
      <div className="skeleton h-28" aria-hidden />
      <div className="skeleton h-72" aria-hidden />
      <div className="skeleton h-48" aria-hidden />
    </div>
  );
}

const TopicContents = dynamic(() => import("./Details").then((m) => m.TopicContents), { loading: () => <ContentsLoading /> });

function DetailSheet({
  title,
  icon,
  period,
  onClose,
  children,
  exportHref,
  canPrint,
}: {
  title: string;
  icon: IconName;
  period: string;
  onClose: () => void;
  children: ReactNode;
  /** This section as CSV, for someone allowed to download it ("Export approved reports"). */
  exportHref: string | null;
  canPrint: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    closeBtn.current?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
      if (e.key !== "Tab" || !panel.current) return;
      // Keep keyboard focus inside the panel while it's open.
      const focusable = panel.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])');
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      before?.focus?.();
    };
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-labelledby="detail-title" data-testid="detail-panel" data-print-root>
      <div className="animate-fade absolute inset-0 bg-black/45" onClick={onClose} aria-hidden data-print-hide />
      <div ref={panel} className="animate-sheet relative flex h-full w-full max-w-4xl flex-col bg-bg shadow-2xl sm:border-l sm:border-border" data-print-panel>
        <header className="flex items-center gap-3 border-b border-border bg-surface px-4 py-3 sm:px-6">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/12 text-accent">
            <Icon name={icon} />
          </span>
          <div className="min-w-0">
            <h2 id="detail-title" className="truncate text-lg font-semibold">{title}</h2>
            <p className="truncate text-xs text-muted">{period}</p>
          </div>
          <span className="ml-auto flex shrink-0 items-center gap-2" data-print-hide>
            {exportHref && (
              <a href={exportHref} download className="hidden h-10 items-center gap-2 rounded-full border border-border bg-surface px-3 text-sm text-muted transition hover:text-text sm:flex" data-testid="export-csv">
                <Icon name="receipt" className="h-4 w-4" />
                Download CSV
              </a>
            )}
            {canPrint && (
              <button onClick={() => window.print()} className="hidden h-10 items-center gap-2 rounded-full border border-border bg-surface px-3 text-sm text-muted transition hover:text-text sm:flex">
                <Icon name="printer" className="h-4 w-4" />
                Print or save as PDF
              </button>
            )}
          </span>
          <button ref={closeBtn} onClick={onClose} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border bg-surface text-muted transition hover:text-text" aria-label="Close details" data-print-hide>
            <Icon name="close" />
          </button>
        </header>
        <div className="flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6 sm:py-6" data-print-scroll>{children}</div>
      </div>
    </div>
  );
}

export function TopicDetail({
  topic,
  ov,
  currency,
  contactsOn,
  onClose,
  onOpen,
  exportHref = null,
  canPrint = true,
}: {
  topic: Topic;
  ov: Overview;
  currency: string;
  contactsOn: boolean;
  exportHref?: string | null;
  canPrint?: boolean;
  onClose: () => void;
  /** Open another topic from inside this one (the overview's rows). */
  onOpen: (t: Topic) => void;
}) {
  const range = fmtRange(ov.range.from, ov.range.to);
  const period: Record<Topic, string> = {
    overview: `${range} · ${ov.store.name ?? ov.store.shopDomain}`,
    sales: range,
    ads: `${range} · each ad account's own days`,
    adsense: `${range} · the AdSense account's own days`,
    products: range,
    shoppers: range,
    timing: range,
    channels: range,
    shipping: `${range} · waiting orders from any date`,
    stock: "Right now · sales speed from the last 30 days",
    discounts: range,
    customers: range,
    orders: "The 10 latest orders placed in these dates",
  };
  return (
    // Keyed by topic so moving from the overview to another topic starts at the top of the panel.
    <DetailSheet key={topic} title={topicInfo(topic).title} icon={topicInfo(topic).icon} period={period[topic]} onClose={onClose} exportHref={exportHref} canPrint={canPrint}>
      <TopicContents topic={topic} ov={ov} currency={currency} contactsOn={contactsOn} onOpen={onOpen} />
    </DetailSheet>
  );
}

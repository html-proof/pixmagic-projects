"use client";
/** Team & Access building blocks: the summary figures and the small action menu. */
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Sparkline } from "@/components/dashboard/Motion";
import { FigureTile } from "@/components/PageKit";

/**
 * One of the page's few numbers, as the Stitch design draws every page's (components/PageKit.tsx
 * FigureTile): its name, the count, and a line under it; a count with a history (pending
 * invitations) has its last 30 days beside it.
 */
export function SummaryCard({ icon: Icon, label, value, note, trend, testId }: { icon: LucideIcon; label: string; value: number | undefined; note: string; trend: number[] | undefined; testId: string }) {
  return (
    <FigureTile
      testId={testId}
      title={label}
      icon={<Icon className="h-4 w-4" strokeWidth={1.8} />}
      value={value ?? "—"}
      change={
        trend && trend.length > 1 ? (
          <span className="ml-auto h-7 w-20 min-w-0" title="Last 30 days">
            <Sparkline values={trend} color="var(--accent)" className="h-full w-full" />
          </span>
        ) : undefined
      }
      sub={note}
    />
  );
}

export type MenuItem<T extends string> = { id: T; label: string; icon: LucideIcon; danger?: boolean };

/** A button that opens a short list of actions (keyboard: Enter/Space to open, Escape to close). */
export function Menu<T extends string>({ label, items, onPick, trigger, className }: { label: string; items: Array<MenuItem<T>>; onPick(id: T): void; trigger: ReactNode; className: string }) {
  // Fixed to the viewport, so a scrolling table never clips it; it follows its button when the page
  // scrolls, and opens upwards near the bottom of the window.
  const [at, setAt] = useState<{ top: number; right: number } | null>(null);
  const open = at !== null;
  const ref = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const place = () => {
    const r = button.current?.getBoundingClientRect();
    if (!r) return setAt(null);
    const height = items.length * 36 + 10;
    setAt({ top: r.bottom + 4 + height > window.innerHeight ? Math.max(8, r.top - 4 - height) : r.bottom + 4, right: window.innerWidth - r.right });
  };
  const placeRef = useRef(place);
  placeRef.current = place;
  useEffect(() => {
    if (!open) return;
    const close = () => setAt(null);
    const follow = () => placeRef.current();
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && close();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", follow, true);
    window.addEventListener("resize", follow);
    ref.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", follow, true);
      window.removeEventListener("resize", follow);
    };
  }, [open]);
  if (!items.length) return null;
  return (
    <div ref={ref} className="relative inline-block text-left">
      <button ref={button} type="button" className={className} aria-haspopup="menu" aria-expanded={open} aria-label={label} onClick={() => (open ? setAt(null) : place())}>
        {trigger}
      </button>
      {open && (
        <div role="menu" style={at} className="animate-rise fixed z-50 w-56 rounded-xl border border-border bg-surface p-1 shadow-[var(--shadow-lift)]">
          {items.map(({ id, label: text, icon: Icon, danger }) => (
            <button
              key={id}
              type="button"
              role="menuitem"
              className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm hover:bg-text/[0.05] focus:bg-text/[0.05] focus:outline-none ${danger ? "text-danger" : ""}`}
              onClick={() => {
                setAt(null);
                onPick(id);
              }}
            >
              <Icon aria-hidden className={`h-4 w-4 shrink-0 ${danger ? "" : "text-muted"}`} />
              {text}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

"use client";
/** Team & Access building blocks: the summary cards and the small action menu. */
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Sparkline } from "@/components/dashboard/Motion";

type CardTone = "green" | "blue" | "violet" | "red" | "slate";

const CARD_TONE: Record<CardTone, { tile: string; line: string }> = {
  green: { tile: "bg-emerald-50 text-emerald-600 dark:bg-emerald-400/10 dark:text-emerald-300", line: "#10b981" },
  blue: { tile: "bg-sky-50 text-sky-600 dark:bg-sky-400/10 dark:text-sky-300", line: "#3b82f6" },
  violet: { tile: "bg-violet-50 text-violet-600 dark:bg-violet-400/10 dark:text-violet-300", line: "#8b5cf6" },
  red: { tile: "bg-rose-50 text-rose-600 dark:bg-rose-400/10 dark:text-rose-300", line: "#f43f5e" },
  slate: { tile: "bg-text/[0.06] text-text/70", line: "#94a3b8" },
};

export function SummaryCard({
  icon: Icon,
  tone,
  label,
  value,
  note,
  trend,
  testId,
}: {
  icon: LucideIcon;
  tone: CardTone;
  label: string;
  value: number | undefined;
  note: string;
  trend: number[] | undefined;
  testId: string;
}) {
  const look = CARD_TONE[tone];
  return (
    <div className="card flex min-w-0 items-start gap-4" data-testid={testId}>
      <span aria-hidden className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl ${look.tile}`}>
        <Icon className="h-6 w-6" strokeWidth={1.8} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{label}</p>
        <div className="mt-1 flex items-end gap-3">
          <p className="text-3xl font-bold tabular-nums tracking-tight">{value ?? "—"}</p>
          {trend && trend.length > 1 && (
            <span className="ml-auto h-10 w-full max-w-28 min-w-0" title="Last 30 days">
              <Sparkline values={trend} color={look.line} className="h-full w-full" />
            </span>
          )}
        </div>
        <p className="mt-1 text-xs text-muted">{note}</p>
      </div>
    </div>
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

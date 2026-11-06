"use client";
import Link from "next/link";
import type { MouseEvent, ReactNode } from "react";
import { TrendingUp } from "lucide-react";
import { fmtPct } from "@/lib/api";

// ---------------------------------------------------------------------------
// The pieces every rebuilt page is made of, as the owner's approved Stitch design draws them
// (prototype v2, 5 Nov 2026): a white card with its heading, a page's few numbers as tiles, the
// opening "In short" line, a row of tabs, and a labelled share bar. The tokens and the classes
// they use (`home-card`, `home-h2`, `home-soft`, `home-line`…) are in globals.css; the page frame
// (title, status, dates, actions) is each area's own, e.g. components/dashboard/SalesFrame.tsx.
// A new page uses these rather than its own borders, radii and type sizes.
// ---------------------------------------------------------------------------

/** A card: white, a small radius, a faint shadow, its heading and (top right) a short note. */
export function Card({
  id,
  title,
  aside,
  className = "",
  testId,
  children,
}: {
  id: string;
  title?: string;
  aside?: ReactNode;
  className?: string;
  /** Defaults to `card-<id>`. */
  testId?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={title ? `${id}-h` : undefined} data-testid={testId ?? `card-${id}`} className={`home-card animate-rise flex min-w-0 flex-col p-5 sm:p-6 ${className}`}>
      {(title || aside) && (
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          {title && <h2 id={`${id}-h`} className="home-h2">{title}</h2>}
          {aside && <div className="text-xs text-muted">{aside}</div>}
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </section>
  );
}

/** A page's opening line: its answer in one sentence, and (on the right) what it covers. */
export function InShortLine({ icon = <TrendingUp className="h-4 w-4" />, period, testId = "in-short", children }: { icon?: ReactNode; period?: ReactNode; testId?: string; children: ReactNode }) {
  return (
    <section aria-label="In short" className="home-card animate-rise flex items-center gap-3 bg-home-soft px-4 py-3 sm:px-5" data-testid={testId}>
      <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-accent text-accent-ink">
        {icon}
      </span>
      <p className="min-w-0 flex-1 text-sm sm:text-base">
        <span className="font-semibold">In short: </span>
        {children}
      </p>
      {period && <span className="hidden shrink-0 text-xs text-muted sm:inline">{period}</span>}
    </section>
  );
}

/** A change beside a figure: "+12%", green up and red down (`invert`: down is good); words for screen readers. */
export function ChangeTag({ value, invert = false, versus, missing = "No earlier data" }: { value: number | null | undefined; invert?: boolean; versus: string; missing?: string }) {
  if (value === null || value === undefined) return <span className="text-xs text-muted">{missing}</span>;
  const good = invert ? value < 0 : value > 0;
  return (
    <span className={`text-xs font-medium tabular-nums ${value === 0 ? "text-muted" : good ? "text-good" : "text-danger"}`}>
      <span className="sr-only">{value > 0 ? "up " : value < 0 ? "down " : "unchanged, "}</span>
      <span aria-hidden>{value > 0 ? "+" : value < 0 ? "−" : ""}</span>
      {fmtPct(Math.abs(value))}
      <span className="sr-only"> {versus}</span>
    </span>
  );
}

/** One of a page's numbers: its name (small capitals), the figure, its change, and a line under it. */
export function FigureTile({ title, value, change, sub, icon, testId }: { title: string; value: ReactNode; change?: ReactNode; sub?: ReactNode; icon?: ReactNode; testId?: string }) {
  return (
    <div className="home-card animate-rise flex min-w-0 flex-col p-4 sm:p-5" data-testid={testId ?? `figure-${title}`}>
      <p className="flex items-center justify-between gap-2 text-[11px] font-semibold tracking-wider text-muted uppercase">
        <span className="truncate">{title}</span>
        {icon && <span aria-hidden className="shrink-0">{icon}</span>}
      </p>
      <p className="mt-2 flex min-w-0 flex-wrap items-baseline gap-x-2">
        <span className="truncate text-2xl leading-8 font-semibold tracking-[-0.02em] tabular-nums sm:text-[28px]">{value}</span>
        {change}
      </p>
      {sub && <p className="mt-1 min-w-0 text-xs text-muted">{sub}</p>}
    </div>
  );
}

/** A label, a value and a bar of its share (`fraction` of the longest, 0–1). */
export function ShareRow({ label, value, fraction, sub }: { label: ReactNode; value: ReactNode; fraction: number; sub?: ReactNode }) {
  return (
    <li className="min-w-0">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="min-w-0 truncate">{label}</span>
        <span className="shrink-0 font-medium tabular-nums">{value}</span>
      </div>
      <div aria-hidden className="mt-1.5 h-2 overflow-hidden rounded-full bg-home-soft">
        <div className="h-full rounded-full bg-accent" style={{ width: `${Math.max(0, Math.min(1, fraction)) * 100}%` }} />
      </div>
      {sub && <p className="mt-1 text-xs text-muted">{sub}</p>}
    </li>
  );
}

export type PageTab = { id: string; label: string; href: string; onClick?: (e: MouseEvent<HTMLAnchorElement>) => void };

/** A row of tabs under a page's title, the current one green and underlined; scrolls sideways on a phone. */
export function PageTabs({ label, tabs, active, testId = "page-tabs" }: { label: string; tabs: PageTab[]; active: string; testId?: string }) {
  if (tabs.length < 2) return null;
  return (
    <nav aria-label={label} className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0" data-print-hide data-testid={testId}>
      <ul className="flex min-w-max gap-6 border-b border-home-line text-sm">
        {tabs.map((t) => {
          const on = t.id === active;
          return (
            <li key={t.id}>
              <Link
                href={t.href}
                onClick={t.onClick}
                aria-current={on ? "page" : undefined}
                className={`-mb-px block border-b-2 pt-1 pb-2.5 font-medium whitespace-nowrap outline-none transition-colors focus-visible:text-accent ${on ? "border-accent text-accent" : "border-transparent text-muted hover:text-text"}`}
                data-testid={`${testId}-${t.id}`}
              >
                {t.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowRight, type LucideIcon } from "lucide-react";

// ---------------------------------------------------------------------------
// The Advertising Performance page's cards (the owner's design): a rounded card with a tinted icon,
// its title and one line saying what it shows, an optional link to the page behind it, and its body.
// ---------------------------------------------------------------------------

/** One tint per card kind, so the page reads apart at a glance. */
export const CARD_TINT = {
  blue: "text-sky-600 dark:text-sky-400",
  violet: "text-violet-600 dark:text-violet-400",
  green: "text-emerald-600 dark:text-emerald-400",
  amber: "text-orange-600 dark:text-orange-400",
  rose: "text-rose-600 dark:text-rose-400",
} as const;

export function AdCard({
  id,
  title,
  sub,
  icon: IconCmp,
  tint = "blue",
  action,
  className = "",
  children,
}: {
  id: string;
  title: ReactNode;
  sub?: ReactNode;
  icon?: LucideIcon;
  tint?: keyof typeof CARD_TINT;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} data-testid={id} className={`card animate-rise flex min-w-0 flex-col rounded-2xl ${className}`}>
      <div className="flex items-start gap-2.5">
        {IconCmp && <IconCmp aria-hidden className={`mt-0.5 h-5 w-5 shrink-0 ${CARD_TINT[tint]}`} strokeWidth={2.2} />}
        <div className="min-w-0 flex-1">
          <h2 id={`${id}-h`} className="flex flex-wrap items-center gap-2 font-semibold leading-tight">
            {title}
          </h2>
          {sub && <p className="mt-1 text-xs text-muted">{sub}</p>}
        </div>
        {action && <div className="shrink-0 pt-0.5 print:hidden">{action}</div>}
      </div>
      <div className="@container mt-4 flex min-w-0 flex-1 flex-col">{children}</div>
    </section>
  );
}

/** "View details →" to the page behind a card. */
export function CardLink({ href, children = "View details", testid }: { href: string; children?: ReactNode; testid?: string }) {
  return (
    <Link href={href} className="inline-flex items-center gap-1 text-xs font-medium text-accent underline-offset-2 hover:underline" data-testid={testid}>
      {children}
      <ArrowRight aria-hidden className="h-3.5 w-3.5" />
    </Link>
  );
}

/** A small figure with its label under it, in a card's grid. */
export function MiniFigure({ label, value, testid }: { label: ReactNode; value: ReactNode; testid?: string }) {
  return (
    <div className="min-w-0" data-testid={testid}>
      <p className="truncate text-base font-semibold tabular-nums tracking-tight">{value}</p>
      <p className="truncate text-xs text-muted">{label}</p>
    </div>
  );
}

/** Nothing to draw: one quiet line in a dashed box, never a chart of zeros standing in for missing figures. */
export function EmptyNote({ children, testid }: { children: ReactNode; testid?: string }) {
  return (
    <p className="flex flex-1 items-center justify-center rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted" data-testid={testid}>
      {children}
    </p>
  );
}

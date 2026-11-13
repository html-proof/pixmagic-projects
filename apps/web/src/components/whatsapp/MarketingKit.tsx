"use client";
import type { ReactNode } from "react";

// ---------------------------------------------------------------------------
// The WhatsApp pages' own pieces, as the
// owner's approved Stitch design draws them (prototype v2, screens 14–20), on top of
// components/PageKit.tsx (Card, FigureTile, InShortLine): its tables with a tinted head row and
// hairlines between rows, a channel's small chip, the line of a page's few facts, the numbered
// parts of a form ("1 When", "2 Who"), a channel's card with one status word and its facts, and
// the design's switch. Only the design's tokens (home-soft, home-line, home-tag, accent): no
// colours, radii or shadows of their own.
// ---------------------------------------------------------------------------

/** A table's head cell: small capitals on the tinted head row, as SalesViews' OrdersTable draws it. */
export const TH = "px-3 py-2.5 text-[11px] font-semibold tracking-wider whitespace-nowrap text-muted uppercase";
/** A table's body cell. */
export const TD = "px-3 py-3 align-top";
/** A table's body row: a hairline under each but the last. */
export const ROW = "border-b border-home-line last:border-0";

/** The head row of a table, tinted. */
export function TableHead({ children }: { children: ReactNode }) {
  return (
    <thead className="bg-home-soft text-left">
      <tr>{children}</tr>
    </thead>
  );
}

/** A head cell (`right` for figures). */
export function Th({ children, right = false, className = "" }: { children?: ReactNode; right?: boolean; className?: string }) {
  return (
    <th scope="col" className={`${TH} ${right ? "text-right" : ""} ${className}`}>
      {children}
    </th>
  );
}

/**
 * A card that holds a table or a list of rows: its heading and note on top, then the rows edge to
 * edge. A wide table scrolls sideways inside the card, never the page (a phone is 390 px wide).
 */
export function TableCard({
  id,
  title,
  aside,
  actions,
  testId,
  className = "",
  children,
}: {
  id: string;
  title?: string;
  aside?: ReactNode;
  actions?: ReactNode;
  testId?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={title ? `${id}-h` : undefined} className={`home-card animate-rise min-w-0 overflow-hidden ${className}`} data-testid={testId}>
      {(title || aside || actions) && (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-5 pt-5 pb-4 sm:px-6">
          <div className="min-w-0">
            {title && (
              <h2 id={`${id}-h`} className="home-h2">
                {title}
              </h2>
            )}
            {aside && <div className="mt-0.5 text-xs text-muted">{aside}</div>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className="min-w-0 overflow-x-auto">{children}</div>
    </section>
  );
}

/** A channel's name (or another short fact: "marketing", "Test mode") as the design's small chip. */
export function Chip({ children, tone = "plain", title }: { children: ReactNode; tone?: "plain" | "accent" | "warn"; title?: string }) {
  const cls = tone === "accent" ? "bg-accent/10 text-accent" : tone === "warn" ? "bg-warn/10 text-warn" : "bg-home-tag text-muted";
  return (
    <span title={title} className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium whitespace-nowrap ${cls}`}>
      {children}
    </span>
  );
}

/**
 * A page's few facts on one line, the first in bold ("3 of 7 on · 779 sent in 30 days · 1 needs
 * you"), as the design's screen 14 opens. Empty items are left out.
 */
export function FactsLine({ items, testId }: { items: Array<ReactNode | null | false | undefined>; testId?: string }) {
  const shown = items.filter((x): x is ReactNode => x !== null && x !== false && x !== undefined && x !== "");
  if (!shown.length) return null;
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted" data-testid={testId}>
      {shown.map((x, i) => (
        <span key={i} className="inline-flex items-center gap-2">
          {i > 0 && <span aria-hidden>·</span>}
          <span className={i === 0 ? "font-semibold text-text" : ""}>{x}</span>
        </span>
      ))}
    </p>
  );
}

/**
 * A numbered part of a form (screens 15 and 19: "1 Channel", "2 Who"), on its own card. The number
 * is drawn in a disc; the heading's words keep it too ("1. When", for screen readers and for the
 * tests that look for it), unless `plain` says the heading has no number in its words.
 */
export function StepCard({
  id,
  n,
  title,
  aside,
  plain = false,
  level = 2,
  className = "",
  testId,
  children,
}: {
  id: string;
  n: ReactNode;
  title: ReactNode;
  aside?: ReactNode;
  plain?: boolean;
  level?: 2 | 3;
  className?: string;
  testId?: string;
  children?: ReactNode;
}) {
  const H = level === 2 ? "h2" : "h3";
  return (
    <section id={id} aria-labelledby={`${id}-h`} className={`home-card animate-rise min-w-0 p-5 sm:p-6 ${className}`} data-testid={testId}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <H id={`${id}-h`} className="home-h2 flex min-w-0 items-center gap-3">
          <StepNumber n={n} />
          <span className="min-w-0">
            {!plain && <span className="sr-only">{n}. </span>}
            {title}
          </span>
        </H>
        {aside && <div className="text-xs text-muted">{aside}</div>}
      </div>
      {children && <div className="mt-4 min-w-0 space-y-4 sm:pl-9">{children}</div>}
    </section>
  );
}

/** The disc a step's number sits in. */
export function StepNumber({ n, done = false }: { n: ReactNode; done?: boolean }) {
  return (
    <span aria-hidden className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold tabular-nums ${done ? "bg-accent text-accent-ink" : "bg-home-soft text-text"}`}>
      {n}
    </span>
  );
}

/**
 * WhatsApp's card, as screen 18 draws it: the name, one status word on the
 * right, the one main button under it, then its facts. `footer` holds the quieter buttons.
 */
export function ChannelPanel({
  id,
  title,
  icon,
  status,
  action,
  footer,
  testId,
  level = 2,
  as = "section",
  className = "",
  children,
}: {
  id: string;
  title: string;
  icon?: ReactNode;
  status?: ReactNode;
  action?: ReactNode;
  footer?: ReactNode;
  testId?: string;
  /** h3 when the cards sit under a heading of their own. */
  level?: 2 | 3;
  /** "li" when the cards are a list's items. */
  as?: "section" | "li";
  className?: string;
  children?: ReactNode;
}) {
  const Box = as;
  const H = level === 2 ? "h2" : "h3";
  return (
    <Box id={id} aria-labelledby={`${id}-h`} className={`home-card animate-rise flex min-w-0 flex-col ${className}`} data-testid={testId}>
      <div className="flex min-w-0 flex-1 flex-col gap-4 p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <H id={`${id}-h`} className="home-h2 flex min-w-0 items-center gap-2">
            {icon && (
              <span aria-hidden className="shrink-0 text-accent">
                {icon}
              </span>
            )}
            <span className="min-w-0 truncate">{title}</span>
          </H>
          {status}
        </div>
        {action && <div className="flex flex-col gap-2 [&>*]:w-full">{action}</div>}
        {children && <div className="min-w-0 space-y-3 text-sm">{children}</div>}
      </div>
      {footer && <div className="flex flex-wrap items-center gap-2 border-t border-home-line bg-home-soft/60 px-5 py-3 sm:px-6">{footer}</div>}
    </Box>
  );
}

/** A channel's facts, each with its icon (screen 18's "Sender name approved", "Opens aren't tracked"). */
export function FactList({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <ul className="space-y-2.5 text-sm" aria-label={label}>
      {children}
    </ul>
  );
}

export function Fact({ icon, muted = false, children }: { icon?: ReactNode; muted?: boolean; children: ReactNode }) {
  return (
    <li className={`flex min-w-0 gap-2.5 ${muted ? "text-muted" : ""}`}>
      {icon && (
        <span aria-hidden className="mt-0.5 shrink-0 text-muted [&>svg]:h-4 [&>svg]:w-4">
          {icon}
        </span>
      )}
      <span className="min-w-0">{children}</span>
    </li>
  );
}

/** A label and its value on a soft row (a step's summary: "Estimated cost · About $9.60"). */
export function SoftBox({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded bg-home-soft px-4 py-3 text-sm ${className}`}>{children}</div>;
}

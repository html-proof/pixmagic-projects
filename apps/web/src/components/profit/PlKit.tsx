"use client";
import type { ReactNode } from "react";
import { HelpTip } from "@/components/PageKit";
import { toneOf, TONE_TEXT } from "./profitUi";

// ---------------------------------------------------------------------------
// The pieces the Profit & Loss page's sections are drawn with (the owner's design, 13 Nov 2026): a
// card headed by a tinted icon, its title and one plain line; a small figure tile; and a sum laid
// out a step a line. Colours are the app's own tokens, so every piece follows light and dark.
// ---------------------------------------------------------------------------

export const MISSING = "Missing data";

/** The tinted square an icon sits in, at the head of a card or a figure. */
export function IconTile({ tone = "var(--accent)", size = "md", children }: { tone?: string; size?: "sm" | "md" | "lg"; children: ReactNode }) {
  const box = size === "lg" ? "size-11 rounded-xl" : size === "sm" ? "size-8 rounded-lg" : "size-9 rounded-lg";
  return (
    <span aria-hidden className={`grid shrink-0 place-items-center ${box}`} style={{ background: `color-mix(in oklab, ${tone} 14%, transparent)`, color: tone }}>
      {children}
    </span>
  );
}

/** A section of the page: a white card with its icon, title, one line of plain words and (right) its actions. */
export function PlCard({
  id,
  icon,
  tone,
  title,
  sub,
  actions,
  className = "",
  flush = false,
  children,
}: {
  id: string;
  icon?: ReactNode;
  tone?: string;
  title: string;
  sub?: ReactNode;
  actions?: ReactNode;
  className?: string;
  /** The body runs edge to edge (a table): the card pads only its heading. */
  flush?: boolean;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} data-testid={id} className={`home-card animate-rise flex min-w-0 flex-col ${flush ? "" : "p-5 sm:p-6"} ${className}`}>
      <div className={`flex flex-wrap items-start justify-between gap-x-4 gap-y-3 ${flush ? "px-5 pt-5 sm:px-6 sm:pt-6" : ""} mb-4`}>
        <div className="flex min-w-0 flex-1 basis-56 items-start gap-3">
          {icon && <IconTile tone={tone}>{icon}</IconTile>}
          <div className="min-w-0">
            <h2 id={`${id}-h`} className="home-h2">
              {title}
            </h2>
            {sub && <p className="mt-0.5 text-sm text-muted">{sub}</p>}
          </div>
        </div>
        {actions && (
          <div className="flex flex-wrap items-center gap-2" data-print-hide>
            {actions}
          </div>
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </section>
  );
}

/** One of a section's figures: its name (with what it means behind the "i"), the figure and a line under it. */
export function MiniTile({
  label,
  value,
  help,
  note,
  signed,
  testid,
}: {
  label: string;
  value: string | null;
  help?: ReactNode;
  note?: ReactNode;
  /** A profit: green above 0, red below. */
  signed?: number | null;
  testid?: string;
}) {
  const tone = signed === undefined ? undefined : toneOf(signed);
  return (
    <div className="home-card animate-rise min-w-0 p-4" data-testid={testid}>
      <p className="flex items-center gap-1 text-xs font-medium text-muted">
        <span className="truncate" title={label}>
          {label}
        </span>
        {help && <HelpTip label={label}>{help}</HelpTip>}
      </p>
      <p className={`mt-1 truncate text-xl font-semibold tracking-[-0.01em] tabular-nums ${tone ? (TONE_TEXT[tone] ?? "") : ""}`} title={value ?? MISSING} data-testid={testid && `${testid}-value`}>
        {value ?? <span className="text-sm font-medium text-warn">{MISSING}</span>}
      </p>
      {note && <p className="mt-1 text-xs text-muted">{note}</p>}
    </div>
  );
}

export interface SumStep {
  sign?: "−" | "+" | "=";
  label: string;
  value: string | null;
  note?: ReactNode;
  strong?: boolean;
  /** A profit: green above 0, red below. */
  signed?: number | null;
}

/** A sum a step a line ("− Fixed costs … = Profit"), each step with where its figure comes from. */
export function Steps({ steps, testid }: { steps: SumStep[]; testid?: string }) {
  return (
    <table className="w-full text-sm" data-testid={testid}>
      <tbody>
        {steps.map((s) => {
          const tone = s.signed === undefined ? undefined : toneOf(s.signed);
          return (
            <tr key={s.label} className={s.strong ? "border-t border-home-line" : ""}>
              <th scope="row" className={`py-1.5 pr-3 text-left align-top ${s.strong ? "font-semibold" : "font-normal"}`}>
                <span aria-hidden className="inline-block w-5 text-muted">
                  {s.sign}
                </span>
                {s.label}
                {s.note && <span className="block pl-5 text-xs font-normal text-muted">{s.note}</span>}
              </th>
              <td className={`py-1.5 text-right align-top whitespace-nowrap tabular-nums ${s.strong ? "font-semibold" : ""} ${tone ? (TONE_TEXT[tone] ?? "") : ""}`}>{s.value ?? <span className="text-xs font-medium text-warn">{MISSING}</span>}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

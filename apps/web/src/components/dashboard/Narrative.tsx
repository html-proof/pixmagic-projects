"use client";
import type { ReactNode } from "react";
import { fmtPct } from "@/lib/api";
import { Icon } from "./Icons";

// ---------------------------------------------------------------------------
// The small pieces the dashboard's sentences are made of, shared by the overview, the detail
// panels and the ads panels. Where pages word the same thing differently, the wording is a
// parameter: each page keeps its own.
// ---------------------------------------------------------------------------

/** A figure in a sentence, in bold. */
export const B = ({ children }: { children: ReactNode }) => <strong className="font-semibold">{children}</strong>;

/**
 * A change on the period before, to end a sentence: ", up 12% on the period before"; `same`
 * when nothing changed (each page has its own words for it); "" with nothing to compare with.
 * `on` names what it is compared with, when a page knows better ("yesterday at the same time").
 */
export const changeWords = (d: number | null, same: string, on = "the period before") =>
  d === null ? "" : d === 0 ? same : `, ${d > 0 ? "up" : "down"} ${fmtPct(Math.abs(d))} on ${on}`;

/**
 * What the dashboard's numbers are compared with, for the end of a sentence: "yesterday at the
 * same time" for today (Shopify's like-for-like), "the period before" otherwise.
 */
export function comparedOn(ov: { range: { from: string; to: string }; previous: { from: string; to: string; until?: string } }): string {
  return ov.range.from === ov.range.to && ov.previous.until ? "yesterday at the same time" : "the period before";
}

/** The same for the ad platforms' figures, which are whole days, never cut at a time of day. */
export const comparedOnWholeDays = (ov: Parameters<typeof comparedOn>[0]) => comparedOn({ range: ov.range, previous: { ...ov.previous, until: undefined } });

/** "up 12%" or "down 3%" ("up 0%" when nothing changed), or null with nothing to compare with. */
export const upDown = (d: number | null) => (d === null ? null : d >= 0 ? `up ${fmtPct(d)}` : `down ${fmtPct(-d)}`);

/** A change as an arrow and a percentage, colored by whether it's good news ("—" with nothing to compare with). */
export function Change({ value, invert = false }: { value: number | null | undefined; invert?: boolean }) {
  if (value === null || value === undefined) return <span className="text-muted">—</span>;
  const good = invert ? value < 0 : value > 0;
  return <span className={value === 0 ? "text-muted" : good ? "text-good" : "text-danger"}>{value > 0 ? "▲" : value < 0 ? "▼" : "■"} {fmtPct(Math.abs(value))}</span>;
}

/** The plain-language answer first, before any table. */
export function InShort({ children }: { children: ReactNode }) {
  return (
    <div className="card flex items-start gap-3 border-accent/30 bg-accent/5">
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/12 text-accent">
        <Icon name="sparkle" className="h-4 w-4" />
      </span>
      <div className="min-w-0 text-sm">
        <p className="text-xs font-medium uppercase tracking-wide text-muted">In short</p>
        <div className="mt-1 space-y-1 leading-relaxed">{children}</div>
      </div>
    </div>
  );
}
